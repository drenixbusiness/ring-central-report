// `npm run status`: shows recent runs and HR days that are not finished (read-only).

import { ConfigError, loadConfig, loadDotenv } from '../config.js';
import { StateStore } from '../state/stateStore.js';
import { printTable } from './table.js';

loadDotenv();
let config;
try {
  config = loadConfig(process.env, { needRingCentral: false, needSheets: false });
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
}

const state = new StateStore(config.state.dbPath);
process.stdout.write('Recent runs:\n');
printTable(state.recentRuns(10), [
  { key: 'id', title: 'Id' },
  { key: 'trigger', title: 'Trigger' },
  { key: 'started_at', title: 'Started (UTC)' },
  { key: 'finished_at', title: 'Finished (UTC)' },
  { key: 'status', title: 'Status' },
  { key: 'summary', title: 'Summary' },
]);
process.stdout.write('\nHR days not in "ok" state:\n');
printTable(state.listNotOk(200), [
  { key: 'report_date', title: 'Date' },
  { key: 'extension_id', title: 'ExtensionId' },
  { key: 'status', title: 'Status' },
  { key: 'attempts', title: 'Attempts', align: 'right' },
  { key: 'last_error_code', title: 'Error' },
  { key: 'last_attempt_at', title: 'Last attempt (UTC)' },
]);
state.close();
