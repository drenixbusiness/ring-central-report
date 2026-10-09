import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryDue, planScheduledRun } from '../src/report/planner.js';
import { HR_A, HR_B, baseConfig } from './helpers/fakes.js';

const config = baseConfig();
const NOW_DAILY = new Date('2026-10-10T05:00:00Z'); // 2026-10-10 00:00 Central

function okStates(dates, extIds) {
  const m = new Map();
  for (const d of dates) for (const e of extIds) m.set(`${d}|${e}`, { status: 'ok' });
  return m;
}

const ALL = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];

test('daily run = yesterday + RECONCILE_DAYS earlier days', () => {
  const states = okStates(ALL, [HR_A.extensionId]);
  const plan = planScheduledRun('daily', { hrs: [HR_A], config, states, now: NOW_DAILY });
  assert.deepEqual(plan.pairs.map((p) => p.date), ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
});

test('late recheck at 00:15 = yesterday only', () => {
  const plan = planScheduledRun('late-recheck', { hrs: [HR_A], config, states: new Map(), now: new Date('2026-10-10T05:15:00Z') });
  assert.deepEqual(plan.pairs.map((p) => p.date), ['2026-10-09']);
});

test('HR start/end dates limit the plan', () => {
  const hrLate = { ...HR_B, reportStartDate: '2026-10-08' };
  const hrEnded = { ...HR_A, reportEndDate: '2026-10-07' };
  const plan = planScheduledRun('daily', { hrs: [hrLate, hrEnded], config, states: okStates(ALL, [HR_A.extensionId, HR_B.extensionId]), now: NOW_DAILY });
  assert.deepEqual(plan.pairs.map((p) => `${p.date}|${p.extensionId}`), [`2026-10-06|${HR_A.extensionId}`, `2026-10-07|${HR_A.extensionId}`, `2026-10-08|${HR_B.extensionId}`, `2026-10-09|${HR_B.extensionId}`]);
});

test('retry plan honours backoff and stops automatic retries after repeated 403', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(isRetryDue({ status: 'failed', attempts: 1, last_attempt_at: new Date(now - 60 * 1000).toISOString() }, now), false);
  assert.equal(isRetryDue({ status: 'failed', attempts: 1, last_attempt_at: new Date(now - 10 * 60 * 1000).toISOString() }, now), true);
  assert.equal(isRetryDue({ status: 'failed', attempts: 3, last_error_code: 'RC_403', last_attempt_at: '2026-01-01T00:00:00Z' }, now), false);

  const states = okStates(ALL, [HR_A.extensionId]);
  states.set(`2026-10-05|${HR_A.extensionId}`, { status: 'failed', attempts: 3, last_error_code: 'RC_403', last_attempt_at: '2026-10-01T00:00:00Z' });
  const plan = planScheduledRun('retry', { hrs: [HR_A], config, states, now: new Date(now) });
  assert.equal(plan.pairs.length, 0);
  assert.equal(plan.skippedPermission.length, 1);
});
