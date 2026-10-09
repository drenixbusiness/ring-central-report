// `npm run check`: validates configuration and verifies real access, read-only.
// Nothing is written to Google Sheets or RingCentral.

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig, loadDotenv, loadHrConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createRingCentral, createSheetWriter } from '../app.js';
import { permissionGuidance } from '../ringcentral/errors.js';
import { readServiceAccountEmail } from '../sheets/sheetsClient.js';
import { HEADERS } from '../sheets/sheetWriter.js';
import { dayBounds, lastCompletedDate } from '../time.js';

let failures = 0;
let warnings = 0;
const ok = (msg) => process.stdout.write(`  [OK]   ${msg}\n`);
const warn = (msg) => {
  warnings += 1;
  process.stdout.write(`  [WARN] ${msg}\n`);
};
const bad = (msg) => {
  failures += 1;
  process.stdout.write(`  [FAIL] ${msg}\n`);
};
const section = (t) => process.stdout.write(`\n== ${t}\n`);

loadDotenv();

section('Configuration (.env)');
let config;
try {
  config = loadConfig(process.env);
  ok(`timezone ${config.report.timezone}, report start ${config.report.startDate}, reconcile ${config.report.reconcileDays} day(s)`);
  ok(`RingCentral server ${config.rc.serverUrl}`);
  if (config.rc.serverUrl !== 'https://platform.ringcentral.com') warn('RC_SERVER_URL is not the production URL https://platform.ringcentral.com');
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  for (const p of err.problems) bad(p);
  process.stdout.write('\nFix the configuration and run again.\n');
  process.exit(2);
}
const logger = createLogger({ level: config.logLevel === 'debug' ? 'debug' : 'error' });

section('HR list (hr.config.json)');
let hrs = [];
try {
  const res = loadHrConfig(config.report.hrConfigPath);
  hrs = res.hrs;
  for (const w of res.warnings) warn(w);
  if (!hrs.length) bad('No enabled HR entries');
  else ok(`${hrs.length} enabled HR(s) in ${config.report.hrConfigPath}`);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  for (const p of err.problems) bad(p);
}

section('State database');
try {
  fs.mkdirSync(path.dirname(config.state.dbPath), { recursive: true });
  fs.accessSync(path.dirname(config.state.dbPath), fs.constants.W_OK);
  ok(`directory writable: ${path.dirname(config.state.dbPath)}`);
} catch (err) {
  bad(`state DB directory not writable: ${err.message}`);
}

section('Google Sheets');
const sa = readServiceAccountEmail(config.google);
if (!sa.email) bad(`cannot read the service account e-mail${config.google.credentialsPath ? ` from ${config.google.credentialsPath}` : ''}${sa.error ? `: ${sa.error}` : ''}`);
else {
  if (sa.type !== 'service_account') warn(`credentials type is "${sa.type}", expected "service_account"`);
  ok(`service account: ${sa.email} (share the spreadsheet with this address as Editor)`);
}
try {
  const writer = createSheetWriter(config, logger);
  const info = await writer.inspect();
  ok(`spreadsheet ${config.google.spreadsheetId} is readable`);
  if (!info.exists) warn(`tab "${config.google.sheetName}" does not exist yet; it will be created on the first real run`);
  else if (info.headerStatus === 'ok') ok(`tab "${config.google.sheetName}" headers match`);
  else if (info.headerStatus === 'empty') warn(`tab "${config.google.sheetName}" row 1 is empty; headers will be written on the first real run`);
  else {
    bad(`tab "${config.google.sheetName}" headers do not match. Expected: ${HEADERS.join(' | ')}. Found: ${info.headers.join(' | ')}`);
  }
  // Editor access cannot be proven without writing; reading proves sharing at least as Viewer.
  ok('note: write permission (Editor) is verified on the first real run, check does not write');
} catch (err) {
  const status = err?.response?.status;
  if (status === 403) bad(`no access to spreadsheet (403). Share it with ${sa.email || 'the service account'} as Editor and enable the Google Sheets API in the service account's project.`);
  else if (status === 404) bad('spreadsheet not found (404). Check GOOGLE_SPREADSHEET_ID.');
  else bad(`Google Sheets check failed: ${err.message}`);
}

section('RingCentral');
const { client, dataSource } = createRingCentral(config, logger);
let rcOk = false;
try {
  await client.login();
  ok('JWT login succeeded');
  rcOk = true;
} catch (err) {
  bad(`${err.message}`);
  const g = permissionGuidance(err);
  if (g) process.stdout.write(`         ${g}\n`);
}

if (rcOk) {
  const scopes = await client.grantedScopes();
  if (!scopes.length) warn('could not read granted scopes from the token response');
  else {
    for (const s of ['ReadAccounts', 'ReadCallLog', 'ReadMessages']) {
      if (scopes.includes(s)) ok(`app scope ${s}`);
      else bad(`app scope ${s} is missing (granted: ${scopes.join(', ')}). Add it to the app in the RingCentral Developer Console.`);
    }
  }
  try {
    const me = await dataSource.getCurrentExtension();
    ok(`JWT user: extensionId ${me.id}, ext #${me.extensionNumber ?? '-'}, type ${me.type ?? '-'}`);
  } catch (err) {
    bad(`cannot read the JWT user's extension: ${err.message}`);
  }

  const probeDay = dayBounds(lastCompletedDate(new Date(), config.report.timezone), config.report.timezone);
  for (const hr of hrs) {
    const label = `extensionId ${hr.extensionId}`;
    try {
      const ext = await dataSource.getExtension(hr.extensionId);
      ok(`${label}: exists, ext #${ext.extensionNumber ?? '-'}, status ${ext.status ?? '-'}, type ${ext.type ?? '-'}`);
      if (ext.status && ext.status !== 'Enabled') warn(`${label}: status is ${ext.status}`);
      if (String(ext.extensionNumber) === hr.extensionId) warn(`${label}: equals the short extension number; make sure you used the extension ID`);
    } catch (err) {
      bad(`${label}: ${err.message}`);
      const g = permissionGuidance(err);
      if (g) process.stdout.write(`         ${g}\n`);
      continue;
    }
    for (const [what, fn] of [
      ['call log', () => dataSource.probeCallLog(hr.extensionId, probeDay.startUtc, probeDay.endUtc)],
      ['message store (SMS)', () => dataSource.probeMessageStore(hr.extensionId, probeDay.startUtc, probeDay.endUtc)],
    ]) {
      try {
        await fn();
        ok(`${label}: ${what} readable`);
      } catch (err) {
        bad(`${label}: ${what} NOT readable: ${err.message}`);
        const g = permissionGuidance(err);
        if (g) process.stdout.write(`         ${g}\n`);
      }
    }
  }
}

process.stdout.write(`\nResult: ${failures} failure(s), ${warnings} warning(s).\n`);
process.exit(failures ? 1 : 0);
