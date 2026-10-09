import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, validateHrConfig } from '../src/config.js';
import { sanitizeFields } from '../src/logger.js';

test('hr config validation catches typical mistakes', () => {
  assert.throws(
    () => validateHrConfig({ hrs: [{ extensionId: '101', name: '', phoneNumber: '3125550100', reportStartDate: '2026-10-01' }] }),
    (err) => err instanceof ConfigError && err.problems.some((p) => /name/.test(p)) && err.problems.some((p) => /E\.164/.test(p)),
  );
  const { hrs, warnings } = validateHrConfig({ hrs: [{ extensionId: '101', name: 'X', phoneNumber: '+13125550100', reportStartDate: '2026-10-01' }] });
  assert.equal(hrs.length, 1);
  assert.match(warnings[0], /short extension number/);
});

test('duplicate extension ids and disabled entries', () => {
  const e = { extensionId: '62000000001', name: 'X', phoneNumber: '+13125550100', reportStartDate: '2026-10-01' };
  assert.throws(() => validateHrConfig({ hrs: [e, e] }), /more than once/);
  assert.equal(validateHrConfig({ hrs: [e, { ...e, extensionId: '62000000002', enabled: false }] }).hrs.length, 1);
});

test('env validation rejects placeholders and bad timezone', () => {
  assert.throws(
    () => loadConfig({ RC_CLIENT_ID: 'your-ringcentral-client-id', RC_CLIENT_SECRET: 's', RC_JWT: 'j', REPORT_START_DATE: '2026-10-01', REPORT_TIMEZONE: 'Central' }, { needSheets: false }),
    (err) => err.problems.some((p) => /placeholder/.test(p)) && err.problems.some((p) => /IANA/.test(p)),
  );
  const cfg = loadConfig({ RC_CLIENT_ID: 'a', RC_CLIENT_SECRET: 'b', RC_JWT: 'c', REPORT_START_DATE: '2026-10-01' }, { needSheets: false });
  assert.equal(cfg.report.timezone, 'America/Chicago');
  assert.equal(cfg.report.reconcileDays, 3);
  assert.equal(cfg.schedule.mainCron, '0 0 * * *');
});

test('logger redacts sensitive field names', () => {
  const out = sanitizeFields({ jwt: 'abc', accessToken: 'x', subject: 'sms text', extensionId: '1', nested: { client_secret: 'z' } });
  assert.equal(out.jwt, '[REDACTED]');
  assert.equal(out.accessToken, '[REDACTED]');
  assert.equal(out.subject, '[REDACTED]');
  assert.equal(out.extensionId, '1');
  assert.equal(out.nested.client_secret, '[REDACTED]');
});
