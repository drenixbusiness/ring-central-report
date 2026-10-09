// Cross-process lock stored in the shared SQLite state DB.
// Used by the PM2 scheduler and the manual CLI so only one process writes to the
// sheet/state at a time. A lock is considered stale when it expired (no heartbeat)
// or, on the same host, when its owner PID no longer exists.

import os from 'node:os';
import crypto from 'node:crypto';
import { sleep as realSleep } from '../util/async.js';

export class LockBusyError extends Error {
  constructor(holder) {
    super(`Another report process holds the lock (pid ${holder.pid} on ${holder.hostname}, purpose "${holder.purpose}", since ${new Date(holder.acquired_at).toISOString()})`);
    this.name = 'LockBusyError';
    this.code = 'LOCK_BUSY';
    this.holder = holder;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class ProcessLock {
  constructor(db, { name = 'report-writer', ttlMs = 120000, heartbeatMs = 30000, logger, now = () => Date.now(), pid = process.pid, hostname = os.hostname(), isPidAlive = pidAlive, sleep = realSleep } = {}) {
    this.db = db;
    this.name = name;
    this.ttlMs = ttlMs;
    this.heartbeatMs = heartbeatMs;
    this.logger = logger;
    this.now = now;
    this.pid = pid;
    this.hostname = hostname;
    this.isPidAlive = isPidAlive;
    this.sleep = sleep;
    this.ownerId = null;
    this.timer = null;
  }

  isStale(row) {
    if (row.expires_at <= this.now()) return true;
    if (row.hostname === this.hostname && row.pid !== this.pid && !this.isPidAlive(row.pid)) return true;
    return false;
  }

  tryAcquire(purpose) {
    const ownerId = crypto.randomUUID();
    const result = this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM process_lock WHERE name = ?').get(this.name);
        if (row && !this.isStale(row)) return { ok: false, holder: row };
        if (row) this.logger?.warn('Taking over stale process lock', { stalePid: row.pid, staleHost: row.hostname });
        const now = this.now();
        this.db
          .prepare(`INSERT INTO process_lock (name, owner_id, pid, hostname, purpose, acquired_at, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(name) DO UPDATE SET owner_id = excluded.owner_id, pid = excluded.pid, hostname = excluded.hostname,
                      purpose = excluded.purpose, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`)
          .run(this.name, ownerId, this.pid, this.hostname, purpose, now, now + this.ttlMs);
        return { ok: true };
      })
      .immediate();
    if (!result.ok) return result;
    this.ownerId = ownerId;
    this.startHeartbeat();
    return { ok: true };
  }

  async acquire(purpose, { waitMs = 0, pollMs = 15000 } = {}) {
    const deadline = this.now() + waitMs;
    for (;;) {
      const res = this.tryAcquire(purpose);
      if (res.ok) return;
      if (this.now() >= deadline) throw new LockBusyError(res.holder);
      this.logger?.info('Waiting for the process lock', { holderPid: res.holder.pid, purpose: res.holder.purpose });
      await this.sleep(Math.min(pollMs, Math.max(0, deadline - this.now())) || pollMs);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      try {
        this.renew();
      } catch (err) {
        this.logger?.error('Process lock heartbeat failed', { errorCode: err.code || 'LOCK_HEARTBEAT', error: err.message });
      }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  stopHeartbeat() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  renew() {
    if (!this.ownerId) return false;
    const info = this.db.prepare('UPDATE process_lock SET expires_at = ? WHERE name = ? AND owner_id = ?').run(this.now() + this.ttlMs, this.name, this.ownerId);
    if (info.changes === 0) {
      this.logger?.error('Process lock was lost (taken over by another process)');
      this.ownerId = null;
      this.stopHeartbeat();
      return false;
    }
    return true;
  }

  /** Throws if this process no longer owns the lock. Call before each write batch. */
  assertHeld() {
    if (!this.renew()) {
      const err = new Error('Process lock is no longer held; aborting writes');
      err.code = 'LOCK_LOST';
      throw err;
    }
  }

  release() {
    this.stopHeartbeat();
    if (!this.ownerId) return;
    this.db.prepare('DELETE FROM process_lock WHERE name = ? AND owner_id = ?').run(this.name, this.ownerId);
    this.ownerId = null;
  }
}
