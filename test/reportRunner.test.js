import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReportRunner, runExclusive } from '../src/report/reportRunner.js';
import { planScheduledRun } from '../src/report/planner.js';
import { SheetWriter } from '../src/sheets/sheetWriter.js';
import { StateStore } from '../src/state/stateStore.js';
import { ProcessLock } from '../src/state/processLock.js';
import { RcApiError } from '../src/ringcentral/errors.js';
import { FakeSheets, timeoutError } from './helpers/fakeSheets.js';
import { FakeDataSource, HR_A, HR_B, baseConfig, call, logger, sms } from './helpers/fakes.js';

const TAB = 'RING CENTRAL';
const T = (date, hhmm) => `${date}T${hhmm}:00.000Z`; // 14:00Z etc. = daytime in Chicago

function setup({ dataSource, api = new FakeSheets(), hrs = [HR_A, HR_B], configOverrides } = {}) {
  const config = baseConfig(configOverrides);
  const state = new StateStore(':memory:');
  const lock = new ProcessLock(state.db, { logger });
  const sheetWriter = new SheetWriter({ api, spreadsheetId: 's', sheetName: TAB, logger, sleep: async () => {} });
  const runner = new ReportRunner({ config, hrs, dataSource, sheetWriter, state, lock, logger, now: () => new Date('2026-10-12T12:00:00Z') });
  const run = (pairs, trigger = 'test') => runExclusive({ lock, state, logger, trigger }, () => runner.processPairs(pairs, { trigger }));
  return { config, state, lock, api, runner, run };
}

const rowsFor = (api, date) => api.dump(TAB).filter((r) => r[0] === date);

test('normal day: correct aggregates written for each HR', async () => {
  const ds = new FakeDataSource({
    calls: {
      [HR_A.extensionId]: [call({ start: T('2026-10-09', '14:00'), result: 'Accepted' }), call({ start: T('2026-10-09', '15:00'), result: 'Missed' }), call({ start: T('2026-10-09', '16:00'), direction: 'Outbound', action: 'VoIP Call', result: 'No Answer' })],
    },
    messages: { [HR_A.extensionId]: [sms({ created: T('2026-10-09', '17:00'), status: 'Delivered' }), sms({ created: T('2026-10-09', '17:05'), status: 'Queued' })] },
  });
  const { api, run } = setup({ dataSource: ds });
  const s = await run([{ date: '2026-10-09', extensionId: HR_A.extensionId }, { date: '2026-10-09', extensionId: HR_B.extensionId }]);
  assert.equal(s.failed.length, 0);
  const rows = rowsFor(api, '2026-10-09');
  assert.deepEqual(rows.find((r) => r[1] === 'Alice HR'), ['2026-10-09', 'Alice HR', '+13125550101', 2, 1, 1, 3, 1]);
  // complete data, no activity -> zeros
  assert.deepEqual(rows.find((r) => r[1] === 'Bob HR'), ['2026-10-09', 'Bob HR', '+13125550102', 0, 0, 0, 0, 0]);
});

test('API error is not written as zero; other HRs continue; existing good row is untouched', async () => {
  const ds = new FakeDataSource({ calls: { [HR_A.extensionId]: [call({ start: T('2026-10-09', '14:00') })] } });
  const { api, run, state } = setup({ dataSource: ds });
  await run([{ date: '2026-10-09', extensionId: HR_A.extensionId }]);
  assert.equal(rowsFor(api, '2026-10-09')[0][3], 1);

  ds.fail[HR_A.extensionId] = new RcApiError({ status: 403, errorCode: 'CMN-408', message: 'forbidden', endpoint: 'message-store', extensionId: HR_A.extensionId });
  const s = await run([{ date: '2026-10-09', extensionId: HR_A.extensionId }, { date: '2026-10-09', extensionId: HR_B.extensionId }]);
  assert.deepEqual(s.failed.map((f) => [f.extensionId, f.code]), [[HR_A.extensionId, 'RC_403']]);
  const rows = rowsFor(api, '2026-10-09');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r) => r[1] === 'Alice HR').slice(3), [1, 0, 0, 1, 0]); // previous good values kept
  assert.equal(state.getState('2026-10-09', HR_A.extensionId).status, 'failed');
  assert.equal(state.getState('2026-10-09', HR_B.extensionId).status, 'ok');
});

test('late call-log record and SMS status change update the same row on reconcile', async () => {
  const date = '2026-10-09';
  const msg = sms({ id: 555, created: T(date, '20:00'), status: 'Queued' });
  const ds = new FakeDataSource({ calls: { [HR_A.extensionId]: [call({ start: T(date, '14:00') })] }, messages: { [HR_A.extensionId]: [msg] } });
  const { api, run } = setup({ dataSource: ds, hrs: [HR_A] });
  await run([{ date, extensionId: HR_A.extensionId }]);
  assert.deepEqual(rowsFor(api, date)[0].slice(3), [1, 0, 0, 1, 0]);

  ds.calls[HR_A.extensionId].push(call({ start: T(date, '23:30'), direction: 'Outbound', action: 'VoIP Call', result: 'Call connected' }));
  msg.messageStatus = 'Delivered';
  await run([{ date, extensionId: HR_A.extensionId }]);
  const rows = rowsFor(api, date);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].slice(3), [1, 1, 0, 2, 1]);
});

test('dry-run neither writes the sheet nor marks state', async () => {
  const ds = new FakeDataSource({ calls: { [HR_A.extensionId]: [call({ start: T('2026-10-09', '14:00') })] } });
  const { api, runner, state } = setup({ dataSource: ds, hrs: [HR_A] });
  const s = await runner.processPairs([{ date: '2026-10-09', extensionId: HR_A.extensionId }], { dryRun: true });
  assert.equal(s.ok[0].inbound, 1);
  assert.equal(api.tabs.has(TAB), false);
  assert.equal(api.calls.length, 0);
  assert.equal(state.getState('2026-10-09', HR_A.extensionId), null);
});

test('one fetch per contiguous range for multiple days', async () => {
  const ds = new FakeDataSource();
  const { run } = setup({ dataSource: ds, hrs: [HR_A] });
  await run(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map((date) => ({ date, extensionId: HR_A.extensionId })));
  assert.equal(ds.requests.filter((r) => r.kind === 'calls').length, 1);
  assert.equal(ds.requests.filter((r) => r.kind === 'sms').length, 1);
});

test('Sheets timeout during insert does not create duplicates and state is ok', async () => {
  const api = new FakeSheets();
  const ds = new FakeDataSource();
  const { run, state } = setup({ dataSource: ds, api, hrs: [HR_A] });
  await run([{ date: '2026-10-08', extensionId: HR_A.extensionId }]);
  api.failNext.batchUpdate = { error: timeoutError(), afterApply: true };
  await run([{ date: '2026-10-09', extensionId: HR_A.extensionId }]);
  assert.equal(rowsFor(api, '2026-10-09').length, 1);
  assert.equal(state.getState('2026-10-09', HR_A.extensionId).status, 'ok');
});

test('unknown inbound result blocks only that HR/day (policy fail)', async () => {
  const ds = new FakeDataSource({ calls: { [HR_A.extensionId]: [call({ start: T('2026-10-09', '14:00'), result: 'Brand New Result' })] } });
  const { api, run } = setup({ dataSource: ds });
  const s = await run([{ date: '2026-10-09', extensionId: HR_A.extensionId }, { date: '2026-10-09', extensionId: HR_B.extensionId }]);
  assert.deepEqual(s.failed.map((f) => f.code), ['UNKNOWN_CALL_RESULT']);
  assert.deepEqual(rowsFor(api, '2026-10-09').map((r) => r[1]), ['Bob HR']);
});

test('restart recovery: crash leaves pairs pending, startup plan picks up missing + pending days', async () => {
  const ds = new FakeDataSource();
  const { state, config, run, api } = setup({ dataSource: ds, hrs: [HR_A] });
  // Days 10-01..10-05 written earlier.
  state.markWritten(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((date) => ({ date, extensionId: HR_A.extensionId, inbound: 0, outbound: 0, missed: 0, total: 0, sms: 0 })));
  // A run queued 10-06 and crashed before writing.
  state.markQueued([{ date: '2026-10-06', extensionId: HR_A.extensionId }]);
  // Process restarts on 2026-10-10 at 03:00 Central; 10-07..10-09 were never processed.
  const plan = planScheduledRun('startup', { hrs: [HR_A], config, states: state.loadStates(config.report.startDate), now: new Date('2026-10-10T08:00:00Z') });
  assert.deepEqual(plan.pairs.map((p) => p.date), ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  await run(plan.pairs);
  for (const d of ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']) assert.equal(state.getState(d, HR_A.extensionId).status, 'ok');
  const again = planScheduledRun('startup', { hrs: [HR_A], config, states: state.loadStates(config.report.startDate), now: new Date('2026-10-10T08:00:00Z') });
  assert.equal(again.pairs.length, 0);
  assert.equal(rowsFor(api, '2026-10-09').length, 1);
});

test('lock held by another live process blocks a second writer', async () => {
  const ds = new FakeDataSource();
  const { state, runner } = setup({ dataSource: ds, hrs: [HR_A] });
  const other = new ProcessLock(state.db, { logger, pid: 999999, isPidAlive: () => true });
  assert.equal(other.tryAcquire('manual').ok, true);
  const mine = new ProcessLock(state.db, { logger, isPidAlive: () => true });
  await assert.rejects(runExclusive({ lock: mine, state, logger, trigger: 'daily' }, () => runner.processPairs([])), /Another report process holds the lock/);
  other.release();
  assert.equal(mine.tryAcquire('daily').ok, true);
  mine.release();
});

test('stale lock of a dead process is taken over', () => {
  const state = new StateStore(':memory:');
  const dead = new ProcessLock(state.db, { logger, pid: 424242 });
  dead.tryAcquire('manual');
  dead.stopHeartbeat();
  const mine = new ProcessLock(state.db, { logger, isPidAlive: (pid) => pid !== 424242 });
  assert.equal(mine.tryAcquire('daily').ok, true);
  mine.release();
});
