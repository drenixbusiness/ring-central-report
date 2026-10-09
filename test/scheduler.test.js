import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';
import { ReportRunner } from '../src/report/reportRunner.js';
import { SheetWriter } from '../src/sheets/sheetWriter.js';
import { StateStore } from '../src/state/stateStore.js';
import { ProcessLock } from '../src/state/processLock.js';
import { RcClient } from '../src/ringcentral/rcClient.js';
import { RcDataSource } from '../src/ringcentral/rcDataSource.js';
import { FakeSheets } from './helpers/fakeSheets.js';
import { FakeDataSource, HR_A, baseConfig, call, fakePlatform, fakeResponse, logger } from './helpers/fakes.js';

test('scheduled daily run at 00:00 Central writes yesterday and reconcile days once each', async () => {
  const config = baseConfig();
  const state = new StateStore(':memory:');
  const lock = new ProcessLock(state.db, { logger });
  const api = new FakeSheets();
  const ds = new FakeDataSource({ calls: { [HR_A.extensionId]: [call({ start: '2026-10-09T15:00:00.000Z' })] } });
  const now = () => new Date('2026-10-10T05:00:00.000Z');
  const runner = new ReportRunner({ config, hrs: [HR_A], dataSource: ds, sheetWriter: new SheetWriter({ api, spreadsheetId: 's', sheetName: 'RING CENTRAL', logger, sleep: async () => {} }), state, lock, logger, now });
  const scheduler = new Scheduler({ config, hrs: [HR_A], runner, state, lock, logger, now });

  await scheduler.execute('daily');
  await scheduler.execute('late-recheck');
  await scheduler.execute('daily'); // e.g. manual re-trigger: still no duplicates

  const data = api.dump('RING CENTRAL').slice(1);
  // HR start 2026-10-01: daily covers 10-06..10-09 + catch-up of 10-01..10-05
  assert.deepEqual(data.map((r) => r[0]).sort(), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.equal(data.find((r) => r[0] === '2026-10-09')[3], 1);
  assert.equal(state.recentRuns(5).length, 3);
});

test('RcDataSource sends the documented query parameters', async () => {
  const platform = fakePlatform(() => fakeResponse(200, { records: [], navigation: {}, paging: { page: 1, perPage: 250 } }));
  const config = { rc: { callLogPageSize: 1000, messagePageSize: 250, includeDeletedCalls: true } };
  const ds = new RcDataSource({ client: new RcClient({ platform, jwt: 'j', logger }), config });
  await ds.fetchCallLog('62000000001', '2026-10-09T03:00:00.000Z', '2026-10-10T07:00:00.000Z');
  await ds.fetchOutboundSms('62000000001', '2026-10-09T05:00:00.000Z', '2026-10-10T05:00:00.000Z');
  assert.equal(platform.calls[0].path, '/restapi/v1.0/account/~/extension/62000000001/call-log');
  assert.deepEqual(platform.calls[0].query, { dateFrom: '2026-10-09T03:00:00.000Z', dateTo: '2026-10-10T07:00:00.000Z', view: 'Simple', type: 'Voice', showDeleted: true, page: 1, perPage: 1000 });
  assert.equal(platform.calls[1].path, '/restapi/v1.0/account/~/extension/62000000001/message-store');
  assert.deepEqual(platform.calls[1].query.messageType, ['SMS']);
  assert.deepEqual(platform.calls[1].query.direction, ['Outbound']);
  assert.equal(platform.calls[1].query.dateFrom, '2026-10-09T05:00:00.000Z');
});
