// node-cron schedules, all evaluated in REPORT_TIMEZONE (never the server timezone).
//   daily        "0 0 * * *"  previous day + RECONCILE_DAYS earlier days + anything outstanding
//   late-recheck "15 0 * * *" previous day again (late call-log entries / SMS statuses)
//   retry        "30 * * * *" failed or missing pairs, with backoff
//   startup      once at boot: missing/failed pairs since REPORT_START_DATE
// Runs inside this process are serialized; across processes the SQLite lock applies.

import cron from 'node-cron';
import { LockBusyError } from './state/processLock.js';
import { planScheduledRun } from './report/planner.js';
import { runExclusive } from './report/reportRunner.js';

export class Scheduler {
  constructor({ config, hrs, runner, state, lock, logger, now = () => new Date() }) {
    this.config = config;
    this.hrs = hrs;
    this.runner = runner;
    this.state = state;
    this.lock = lock;
    this.logger = logger;
    this.now = now;
    this.tasks = [];
    this.chain = Promise.resolve();
    this.stopping = false;
  }

  start() {
    const tz = this.config.report.timezone;
    const defs = [
      ['daily', this.config.schedule.mainCron],
      ['late-recheck', this.config.schedule.lateCron],
      ['retry', this.config.schedule.retryCron],
    ];
    for (const [trigger, expr] of defs) {
      if (!cron.validate(expr)) throw new Error(`Invalid cron expression for ${trigger}: "${expr}"`);
      this.tasks.push(cron.schedule(expr, () => this.enqueue(trigger), { timezone: tz, name: `rc-report-${trigger}` }));
      this.logger.info('Scheduled job', { trigger, cron: expr, timezone: tz });
    }
    if (this.config.schedule.catchUpOnStart) this.enqueue('startup');
  }

  /** Serializes runs within this process. */
  enqueue(trigger) {
    if (this.stopping) return this.chain;
    this.chain = this.chain.then(() => this.execute(trigger)).catch(() => {});
    return this.chain;
  }

  async execute(trigger) {
    if (this.stopping) return null;
    try {
      return await runExclusive(
        { lock: this.lock, state: this.state, logger: this.logger, trigger, waitMs: this.config.schedule.lockWaitMs },
        async () => {
          // Plan inside the lock so the state we read is not changing underneath us.
          const states = this.state.loadStates(this.config.report.startDate);
          const { pairs, skippedPermission } = planScheduledRun(trigger, { hrs: this.hrs, config: this.config, states, now: this.now() });
          if (skippedPermission.length) {
            this.logger.warn('Some days are not retried automatically after repeated 401/403 errors. Fix access, then run "npm run report" for them.', {
              count: skippedPermission.length,
              extensionIds: [...new Set(skippedPermission.map((p) => p.extensionId))],
            });
          }
          return this.runner.processPairs(pairs, { trigger });
        },
      );
    } catch (err) {
      if (err instanceof LockBusyError) {
        this.logger.warn('Run skipped: lock is held by another process. Missing days will be caught up by the next retry run.', { trigger, errorCode: err.code });
      } else {
        this.logger.error('Scheduled run failed', { trigger, errorCode: err.code || 'ERROR', error: err.message });
      }
      return null;
    }
  }

  async stop(timeoutMs = 25000) {
    this.stopping = true;
    for (const t of this.tasks) t.stop();
    await Promise.race([this.chain, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }
}
