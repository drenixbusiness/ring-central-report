// Persistent job state in SQLite.
//
// hr_day: one row per (report_date, extension_id)
//   status = 'pending'     queued for (re)processing, not finished yet (survives crashes)
//            'ok'          last processing succeeded and the row is in the sheet
//            'provisional' written, but calls were still in progress -> re-check later
//            'failed'      last attempt failed; written_* columns keep the last good values
// runs: audit trail of executions.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hr_day (
  report_date        TEXT    NOT NULL,
  extension_id       TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('pending','ok','provisional','failed')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_attempt_at    TEXT,
  last_error_code    TEXT,
  last_error_message TEXT,
  written_at         TEXT,
  inbound            INTEGER,
  outbound           INTEGER,
  missed             INTEGER,
  total_calls        INTEGER,
  sms_sent           INTEGER,
  updated_at         TEXT    NOT NULL,
  PRIMARY KEY (report_date, extension_id)
);
CREATE INDEX IF NOT EXISTS hr_day_status ON hr_day(status);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  summary     TEXT
);
CREATE TABLE IF NOT EXISTS process_lock (
  name        TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  hostname    TEXT NOT NULL,
  purpose     TEXT,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
`;

export class StateStore {
  constructor(dbPath, { now = () => new Date() } = {}) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 10000');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.now = now;
  }

  close() {
    this.db.close();
  }

  ts() {
    return this.now().toISOString();
  }

  /** Marks pairs as queued. Keeps last written values and failure counters. */
  markQueued(pairs) {
    const stmt = this.db.prepare(`
      INSERT INTO hr_day (report_date, extension_id, status, updated_at)
      VALUES (@date, @extensionId, 'pending', @ts)
      ON CONFLICT(report_date, extension_id) DO UPDATE SET
        status = CASE WHEN hr_day.status = 'failed' THEN 'failed' ELSE 'pending' END,
        updated_at = @ts`);
    const ts = this.ts();
    this.db.transaction((items) => {
      for (const p of items) stmt.run({ date: p.date, extensionId: p.extensionId, ts });
    })(pairs);
  }

  markWritten(entries) {
    const stmt = this.db.prepare(`
      INSERT INTO hr_day (report_date, extension_id, status, attempts, last_attempt_at, last_error_code, last_error_message,
                          written_at, inbound, outbound, missed, total_calls, sms_sent, updated_at)
      VALUES (@date, @extensionId, @status, 0, @ts, NULL, NULL, @ts, @inbound, @outbound, @missed, @total, @sms, @ts)
      ON CONFLICT(report_date, extension_id) DO UPDATE SET
        status = @status, attempts = 0, last_attempt_at = @ts, last_error_code = NULL, last_error_message = NULL,
        written_at = @ts, inbound = @inbound, outbound = @outbound, missed = @missed, total_calls = @total,
        sms_sent = @sms, updated_at = @ts`);
    const ts = this.ts();
    this.db.transaction((items) => {
      for (const e of items) {
        stmt.run({
          date: e.date,
          extensionId: e.extensionId,
          status: e.provisional ? 'provisional' : 'ok',
          inbound: e.inbound,
          outbound: e.outbound,
          missed: e.missed,
          total: e.total,
          sms: e.sms,
          ts,
        });
      }
    })(entries);
  }

  markFailed(entries) {
    const stmt = this.db.prepare(`
      INSERT INTO hr_day (report_date, extension_id, status, attempts, last_attempt_at, last_error_code, last_error_message, updated_at)
      VALUES (@date, @extensionId, 'failed', 1, @ts, @code, @message, @ts)
      ON CONFLICT(report_date, extension_id) DO UPDATE SET
        status = 'failed', attempts = hr_day.attempts + 1, last_attempt_at = @ts,
        last_error_code = @code, last_error_message = @message, updated_at = @ts`);
    const ts = this.ts();
    this.db.transaction((items) => {
      for (const e of items) {
        stmt.run({ date: e.date, extensionId: e.extensionId, code: e.code || 'ERROR', message: String(e.message || '').slice(0, 1000), ts });
      }
    })(entries);
  }

  /** Map "date|extensionId" -> row, for dates >= fromDate. */
  loadStates(fromDate) {
    const rows = this.db.prepare('SELECT * FROM hr_day WHERE report_date >= ?').all(fromDate);
    return new Map(rows.map((r) => [`${r.report_date}|${r.extension_id}`, r]));
  }

  getState(date, extensionId) {
    return this.db.prepare('SELECT * FROM hr_day WHERE report_date = ? AND extension_id = ?').get(date, extensionId) || null;
  }

  listNotOk(limit = 200) {
    return this.db.prepare("SELECT * FROM hr_day WHERE status != 'ok' ORDER BY report_date, extension_id LIMIT ?").all(limit);
  }

  startRun(trigger) {
    const info = this.db.prepare('INSERT INTO runs (trigger, started_at) VALUES (?, ?)').run(trigger, this.ts());
    return Number(info.lastInsertRowid);
  }

  finishRun(id, status, summary) {
    this.db.prepare('UPDATE runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?').run(this.ts(), status, JSON.stringify(summary ?? {}), id);
  }

  recentRuns(limit = 10) {
    return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
  }
}
