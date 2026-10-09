// Manual report:
//   npm run report -- --date 2026-10-09
//   npm run report -- --from 2026-10-01 --to 2026-10-09
//   npm run report -- --date 2026-10-09 --dry-run
//   npm run report -- --date 2026-10-09 --hr 62345678901 --dry-run
// Dry-run does not write to Google Sheets and does not touch the state DB.

import { parseArgs } from 'node:util';
import { createApp, exitOnConfigError } from '../app.js';
import { pairsForDates } from '../report/planner.js';
import { runExclusive } from '../report/reportRunner.js';
import { LockBusyError } from '../state/processLock.js';
import { assertIsoDate, dateRange, lastCompletedDate } from '../time.js';
import { printTable } from './table.js';

const USAGE = `Usage:
  npm run report -- --date YYYY-MM-DD [--dry-run] [--hr <extensionId>[,<extensionId>]] [--verbose]
  npm run report -- --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run] [--hr ...] [--verbose]`;

function fail(msg) {
  process.stderr.write(`${msg}\n\n${USAGE}\n`);
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      date: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      hr: { type: 'string', multiple: true },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  }));
} catch (err) {
  fail(err.message);
}
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

let dates;
try {
  if (args.date && (args.from || args.to)) fail('Use either --date or --from/--to, not both.');
  if (args.date) dates = [assertIsoDate(args.date, '--date')];
  else if (args.from && args.to) dates = dateRange(assertIsoDate(args.from, '--from'), assertIsoDate(args.to, '--to'));
  else fail('Missing --date or --from/--to.');
} catch (err) {
  fail(err.message);
}

const dryRun = args['dry-run'];
let app;
try {
  app = createApp({ dryRun });
} catch (err) {
  exitOnConfigError(err);
}
const { config, hrs, runner, state, lock, logger } = app;

const lastCompleted = lastCompletedDate(new Date(), config.report.timezone);
const incomplete = dates.filter((d) => d > lastCompleted);
if (incomplete.length) fail(`These dates are not completed days in ${config.report.timezone} yet: ${incomplete.join(', ')}`);

let selectedHrs = hrs;
if (args.hr?.length) {
  const wanted = new Set(args.hr.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean));
  selectedHrs = hrs.filter((h) => wanted.has(h.extensionId));
  const unknown = [...wanted].filter((id) => !hrs.some((h) => h.extensionId === id));
  if (unknown.length) fail(`Not in hr.config.json (or disabled): ${unknown.join(', ')}`);
}

const pairs = pairsForDates(selectedHrs, dates, config.report.startDate);
const skipped = selectedHrs.length * dates.length - pairs.length;
if (skipped) logger.info('Some HR/date combinations are outside the configured report window and were skipped', { skipped });

function printSummary(summary) {
  const rows = summary.ok.map((r) => ({
    date: r.date,
    ext: r.extensionId,
    name: r.hrName,
    phone: r.phoneNumber,
    inbound: r.inbound,
    outbound: r.outbound,
    missed: r.missed,
    total: r.total,
    sms: r.sms,
    note: r.provisional ? 'provisional (call in progress)' : '',
  }));
  process.stdout.write(`\n${dryRun ? 'DRY RUN - nothing was written to Google Sheets or the state DB' : 'Written to Google Sheets'}\n`);
  printTable(rows, [
    { key: 'date', title: 'Date' },
    { key: 'ext', title: 'ExtensionId' },
    { key: 'name', title: 'HR name' },
    { key: 'phone', title: 'Phone' },
    { key: 'inbound', title: 'Inbound', align: 'right' },
    { key: 'outbound', title: 'Outbound', align: 'right' },
    { key: 'missed', title: 'Missed', align: 'right' },
    { key: 'total', title: 'Total', align: 'right' },
    { key: 'sms', title: 'SMS', align: 'right' },
    { key: 'note', title: 'Note' },
  ]);
  if (args.verbose) {
    for (const r of summary.ok) {
      process.stdout.write(`\nDiagnostics ${r.date} ${r.extensionId}: ${JSON.stringify(r.diagnostics)}\n`);
    }
  }
  if (summary.failed.length) {
    process.stdout.write('\nFAILED (not written, existing sheet rows untouched):\n');
    printTable(
      summary.failed.map((f) => ({ date: f.date, ext: f.extensionId, code: f.code, message: f.message })),
      [
        { key: 'date', title: 'Date' },
        { key: 'ext', title: 'ExtensionId' },
        { key: 'code', title: 'Code' },
        { key: 'message', title: 'Message' },
      ],
    );
  }
  if (!dryRun) process.stdout.write(`\nInserted rows: ${summary.inserted}, updated rows: ${summary.updated}\n`);
}

try {
  let summary;
  if (dryRun) {
    summary = await runner.processPairs(pairs, { dryRun: true, trigger: 'manual-dry-run' });
  } else {
    summary = await runExclusive({ lock, state, logger, trigger: 'manual', waitMs: 0 }, () => runner.processPairs(pairs, { trigger: 'manual' }));
  }
  printSummary(summary);
  state?.close();
  process.exit(summary.failed.length ? 1 : 0);
} catch (err) {
  if (err instanceof LockBusyError) {
    process.stderr.write(`${err.message}\nTry again when it finishes (pm2 logs rc-hr-daily-report).\n`);
  } else {
    process.stderr.write(`Report failed: ${err.message}\n`);
  }
  state?.close();
  process.exit(1);
}
