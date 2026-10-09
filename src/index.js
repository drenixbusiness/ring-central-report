// PM2 entry point: `npm start`.

import { createApp, exitOnConfigError } from './app.js';
import { Scheduler } from './scheduler.js';

let app;
try {
  app = createApp();
} catch (err) {
  exitOnConfigError(err);
}

const { config, hrs, runner, state, lock, logger } = app;
const scheduler = new Scheduler({ config, hrs, runner, state, lock, logger: logger.child('scheduler') });

logger.info('rc-hr-daily-report starting', {
  pid: process.pid,
  timezone: config.report.timezone,
  hrs: hrs.length,
  reconcileDays: config.report.reconcileDays,
  sheet: config.google.sheetName,
});
scheduler.start();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });
  try {
    await scheduler.stop();
  } finally {
    lock.release();
    state.close();
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
