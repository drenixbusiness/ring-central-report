// Builds the runtime objects from configuration.

import { ConfigError, loadConfig, loadDotenv, loadHrConfig } from './config.js';
import { createLogger } from './logger.js';
import { RcClient, createPlatform } from './ringcentral/rcClient.js';
import { RcDataSource } from './ringcentral/rcDataSource.js';
import { createSheetsApi } from './sheets/sheetsClient.js';
import { SheetWriter } from './sheets/sheetWriter.js';
import { StateStore } from './state/stateStore.js';
import { ProcessLock } from './state/processLock.js';
import { ReportRunner } from './report/reportRunner.js';

export function bootstrapConfig({ needRingCentral = true, needSheets = true, needHrs = true } = {}) {
  loadDotenv();
  const config = loadConfig(process.env, { needRingCentral, needSheets });
  const logger = createLogger({ level: config.logLevel });
  let hrs = [];
  if (needHrs) {
    const res = loadHrConfig(config.report.hrConfigPath);
    hrs = res.hrs;
    for (const w of res.warnings) logger.warn(w);
  }
  return { config, logger, hrs };
}

export function createRingCentral(config, logger) {
  const client = new RcClient({
    platform: createPlatform(config.rc),
    jwt: config.rc.jwt,
    logger: logger.child('rc'),
    maxConcurrency: config.rc.maxConcurrency,
    maxRetries: config.rc.maxRetries,
    requestTimeoutMs: config.rc.requestTimeoutMs,
  });
  return { client, dataSource: new RcDataSource({ client, config }) };
}

export function createSheetWriter(config, logger) {
  return new SheetWriter({
    api: createSheetsApi(config.google),
    spreadsheetId: config.google.spreadsheetId,
    sheetName: config.google.sheetName,
    logger: logger.child('sheets'),
    requestTimeoutMs: config.google.requestTimeoutMs,
  });
}

export function createApp({ dryRun = false } = {}) {
  const { config, logger, hrs } = bootstrapConfig({ needSheets: !dryRun });
  const { client, dataSource } = createRingCentral(config, logger);
  const state = dryRun ? null : new StateStore(config.state.dbPath);
  const lock = state ? new ProcessLock(state.db, { logger: logger.child('lock') }) : null;
  const sheetWriter = dryRun ? null : createSheetWriter(config, logger);
  const runner = new ReportRunner({ config, hrs, dataSource, sheetWriter, state, lock, logger: logger.child('report') });
  return { config, logger, hrs, client, dataSource, state, lock, sheetWriter, runner };
}

export function exitOnConfigError(err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
