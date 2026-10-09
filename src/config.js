// Configuration loading and validation (.env + hr.config.json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { isValidIsoDate, isValidTimezone } from './time.js';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ConfigError extends Error {
  constructor(problems) {
    super(`Configuration is invalid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadDotenv() {
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });
}

function resolvePath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

function intFrom(env, name, def, problems, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
    return def;
  }
  return n;
}

function boolFrom(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

const PLACEHOLDER = /^(your[-_]|<|changeme|replace[-_]?me|xxx)/i;

function required(env, name, problems) {
  const v = env[name];
  if (!v || !String(v).trim()) {
    problems.push(`${name} is not set`);
    return '';
  }
  if (PLACEHOLDER.test(String(v).trim())) {
    problems.push(`${name} still contains a placeholder value`);
  }
  return String(v).trim();
}

/**
 * @param {object} opts
 * @param {boolean} [opts.needRingCentral=true]
 * @param {boolean} [opts.needSheets=true]
 */
export function loadConfig(env = process.env, { needRingCentral = true, needSheets = true } = {}) {
  const problems = [];

  const rc = {
    serverUrl: (env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/+$/, ''),
    clientId: needRingCentral ? required(env, 'RC_CLIENT_ID', problems) : env.RC_CLIENT_ID || '',
    clientSecret: needRingCentral ? required(env, 'RC_CLIENT_SECRET', problems) : env.RC_CLIENT_SECRET || '',
    jwt: needRingCentral ? required(env, 'RC_JWT', problems) : env.RC_JWT || '',
    callLogPageSize: intFrom(env, 'RC_CALL_LOG_PAGE_SIZE', 1000, problems, { min: 1, max: 1000 }),
    messagePageSize: intFrom(env, 'RC_MESSAGE_PAGE_SIZE', 250, problems, { min: 1, max: 1000 }),
    maxConcurrency: intFrom(env, 'RC_MAX_CONCURRENCY', 2, problems, { min: 1, max: 10 }),
    maxRetries: intFrom(env, 'RC_MAX_RETRIES', 5, problems, { min: 0, max: 10 }),
    requestTimeoutMs: intFrom(env, 'RC_REQUEST_TIMEOUT_MS', 60000, problems, { min: 1000 }),
    includeDeletedCalls: boolFrom(env, 'RC_INCLUDE_DELETED_CALLS', true),
  };
  if (!/^https:\/\//.test(rc.serverUrl)) problems.push('RC_SERVER_URL must start with https://');

  // Service account: either a JSON key file (GOOGLE_APPLICATION_CREDENTIALS) or
  // inline GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ("\n" escaped).
  const inlineEmail = (env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim();
  const inlineKey = (env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  const google = {
    credentialsPath: inlineEmail || inlineKey ? '' : resolvePath(env.GOOGLE_APPLICATION_CREDENTIALS || ''),
    inlineCredentials: inlineEmail || inlineKey ? { client_email: inlineEmail, private_key: inlineKey ? `${inlineKey}\n` : '' } : null,
    spreadsheetId: needSheets ? required(env, 'GOOGLE_SPREADSHEET_ID', problems) : env.GOOGLE_SPREADSHEET_ID || '',
    sheetName: env.GOOGLE_SHEET_NAME || 'RING CENTRAL',
    requestTimeoutMs: intFrom(env, 'GOOGLE_REQUEST_TIMEOUT_MS', 60000, problems, { min: 1000 }),
  };
  if (needSheets) {
    if (google.inlineCredentials) {
      if (!inlineEmail) problems.push('GOOGLE_SERVICE_ACCOUNT_EMAIL is not set (required with GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY)');
      if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(inlineKey)) {
        problems.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must contain the full PEM key (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----)');
      }
    } else if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
      problems.push('Google credentials are not set: use GOOGLE_APPLICATION_CREDENTIALS (JSON key file) or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');
    } else if (!fs.existsSync(google.credentialsPath)) problems.push(`GOOGLE_APPLICATION_CREDENTIALS file not found: ${google.credentialsPath}`);
  }

  const report = {
    timezone: env.REPORT_TIMEZONE || 'America/Chicago',
    startDate: env.REPORT_START_DATE || '',
    reconcileDays: intFrom(env, 'RECONCILE_DAYS', 3, problems, { min: 0, max: 60 }),
    callLogBufferMinutes: intFrom(env, 'CALL_LOG_BUFFER_MINUTES', 120, problems, { min: 0, max: 1440 }),
    unknownResultPolicy: (env.UNKNOWN_CALL_RESULT_POLICY || 'fail').trim(),
    hrConcurrency: intFrom(env, 'HR_CONCURRENCY', 2, problems, { min: 1, max: 10 }),
    hrConfigPath: resolvePath(env.HR_CONFIG_PATH || 'hr.config.json'),
    sheetsBatchSize: intFrom(env, 'SHEETS_BATCH_SIZE', 200, problems, { min: 1, max: 1000 }),
  };
  if (!isValidTimezone(report.timezone)) problems.push(`REPORT_TIMEZONE "${report.timezone}" is not a valid IANA timezone`);
  if (!report.startDate) problems.push('REPORT_START_DATE is not set (YYYY-MM-DD)');
  else if (!isValidIsoDate(report.startDate)) problems.push(`REPORT_START_DATE "${report.startDate}" is not a valid YYYY-MM-DD date`);
  if (!['fail', 'count-not-missed'].includes(report.unknownResultPolicy)) {
    problems.push('UNKNOWN_CALL_RESULT_POLICY must be "fail" or "count-not-missed"');
  }

  const schedule = {
    mainCron: env.MAIN_CRON || '0 0 * * *',
    lateCron: env.LATE_RECHECK_CRON || '15 0 * * *',
    retryCron: env.RETRY_CRON || '30 * * * *',
    catchUpOnStart: boolFrom(env, 'CATCH_UP_ON_START', true),
    lockWaitMs: intFrom(env, 'LOCK_WAIT_MS', 30 * 60 * 1000, problems, { min: 0 }),
  };

  const state = {
    dbPath: resolvePath(env.STATE_DB_PATH || 'data/state.sqlite'),
  };

  const logLevel = (env.LOG_LEVEL || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) problems.push('LOG_LEVEL must be one of debug, info, warn, error');

  if (problems.length) throw new ConfigError(problems);
  return { rc, google, report, schedule, state, logLevel };
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** Validates the parsed hr.config.json content. Returns { hrs, warnings }. */
export function validateHrConfig(data) {
  const problems = [];
  const warnings = [];
  const list = Array.isArray(data) ? data : data?.hrs;
  if (!Array.isArray(list)) throw new ConfigError(['hr config must be an object with an "hrs" array']);

  const seen = new Set();
  const hrs = [];
  list.forEach((entry, i) => {
    const where = `hrs[${i}]`;
    if (!entry || typeof entry !== 'object') {
      problems.push(`${where} must be an object`);
      return;
    }
    if (entry.enabled === false) return;
    const extensionId = entry.extensionId === undefined ? '' : String(entry.extensionId).trim();
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const phoneNumber = typeof entry.phoneNumber === 'string' ? entry.phoneNumber.trim() : '';
    const { reportStartDate, reportEndDate } = entry;

    if (!/^\d+$/.test(extensionId)) problems.push(`${where}.extensionId must be the numeric RingCentral extension ID (string)`);
    else if (extensionId.length <= 5) {
      warnings.push(`${where}.extensionId "${extensionId}" is very short and looks like a short extension number. Use the extension ID from "npm run list-extensions".`);
    }
    if (seen.has(extensionId)) problems.push(`${where}.extensionId ${extensionId} is listed more than once`);
    seen.add(extensionId);
    if (!name) problems.push(`${where}.name is required`);
    if (!E164.test(phoneNumber)) problems.push(`${where}.phoneNumber must be in E.164 format with "+" (e.g. +13125550100)`);
    if (!isValidIsoDate(reportStartDate)) problems.push(`${where}.reportStartDate must be YYYY-MM-DD`);
    if (reportEndDate !== undefined && reportEndDate !== null && reportEndDate !== '') {
      if (!isValidIsoDate(reportEndDate)) problems.push(`${where}.reportEndDate must be YYYY-MM-DD or null`);
      else if (isValidIsoDate(reportStartDate) && reportEndDate < reportStartDate) {
        problems.push(`${where}.reportEndDate is before reportStartDate`);
      }
    }
    hrs.push({
      extensionId,
      name,
      phoneNumber,
      reportStartDate,
      reportEndDate: reportEndDate || null,
    });
  });

  if (problems.length) throw new ConfigError(problems);
  return { hrs, warnings };
}

export function loadHrConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new ConfigError([`HR config not found: ${filePath} (copy hr.config.example.json to hr.config.json)`]);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ConfigError([`HR config ${filePath} is not valid JSON: ${err.message}`]);
  }
  return validateHrConfig(parsed);
}
