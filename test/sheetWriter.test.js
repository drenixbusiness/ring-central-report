import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEADERS, SheetWriter } from '../src/sheets/sheetWriter.js';
import { FakeSheets, timeoutError } from './helpers/fakeSheets.js';
import { logger } from './helpers/fakes.js';

const TAB = 'RING CENTRAL';

function writer(api) {
  return new SheetWriter({ api, spreadsheetId: 'sheet-1', sheetName: TAB, logger, sleep: async () => {} });
}

const row = (date, ext, extra = {}) => ({ reportDate: date, extensionId: ext, hrName: 'Alice HR', phoneNumber: '+13125550101', inbound: 3, outbound: 2, missed: 1, total: 5, sms: 4, ...extra });

test('creates the tab with exact headers and leaves other tabs untouched', async () => {
  const api = new FakeSheets();
  await writer(api).upsertRows([row('2026-10-09', '1')]);
  const data = api.dump(TAB);
  assert.deepEqual(data[0], HEADERS);
  assert.deepEqual(data[1], ['2026-10-09', 'Alice HR', '+13125550101', 3, 2, 1, 5, 4]);
  assert.deepEqual(api.dump('Other'), [['keep me']]);
});

test('phone and text values are stored as typed strings, numbers as numbers (no formula parsing)', async () => {
  const api = new FakeSheets();
  await writer(api).upsertRows([row('2026-10-09', '1', { hrName: '=HYPERLINK("x")' })]);
  const r = api.dump(TAB)[1];
  assert.equal(r[1], '=HYPERLINK("x")');
  assert.equal(typeof r[2], 'string');
  assert.ok(r[2].startsWith('+'));
  assert.equal(typeof r[3], 'number');
});

test('re-processing the same date updates in place, no duplicates (even after rename and sort)', async () => {
  const api = new FakeSheets();
  const w = writer(api);
  await w.upsertRows([row('2026-10-09', '1'), row('2026-10-09', '2', { hrName: 'Bob HR' }), row('2026-10-08', '1')]);
  api.sortDataRows(TAB, (a, b) => String(a.cells[1]).localeCompare(String(b.cells[1])) || String(b.cells[0]).localeCompare(String(a.cells[0])));
  const res = await w.upsertRows([row('2026-10-09', '1', { hrName: 'Alice Renamed', phoneNumber: '+13125550199', inbound: 9, total: 11 })]);
  assert.deepEqual(res.updated, ['2026-10-09|1']);
  assert.deepEqual(res.inserted, []);
  const data = api.dump(TAB);
  assert.equal(data.length, 4);
  const updated = data.filter((r) => r[1] === 'Alice Renamed');
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0], ['2026-10-09', 'Alice Renamed', '+13125550199', 9, 2, 1, 11, 4]);
});

test('mismatching headers produce a clear error and nothing is written', async () => {
  const api = new FakeSheets({ tabs: { [TAB]: [['Date', 'Name', 'Phone']] } });
  await assert.rejects(writer(api).upsertRows([row('2026-10-09', '1')]), (err) => {
    assert.equal(err.code, 'SHEETS_HEADER_MISMATCH');
    assert.match(err.message, /B1 expected "HR name" found "Name"/);
    return true;
  });
  assert.deepEqual(api.dump(TAB), [['Date', 'Name', 'Phone']]);
});

test('existing headers that match are kept; unrelated cells to the right survive updates', async () => {
  const api = new FakeSheets({ tabs: { [TAB]: [[...HEADERS, 'Notes']] } });
  const w = writer(api);
  await w.upsertRows([row('2026-10-09', '1')]);
  api.tabs.get(TAB).rows[1].cells[8] = 'manual note';
  await w.upsertRows([row('2026-10-09', '1', { sms: 7 })]);
  assert.deepEqual(api.dump(TAB)[1], ['2026-10-09', 'Alice HR', '+13125550101', 3, 2, 1, 5, 7, 'manual note']);
  assert.equal(api.dump(TAB)[0][8], 'Notes');
});

test('insert timeout AFTER the server applied it: verifies, does not append again', async () => {
  const api = new FakeSheets();
  const w = writer(api);
  await w.upsertRows([row('2026-10-08', '1')]); // creates tab
  api.failNext.batchUpdate = { error: timeoutError(), afterApply: true };
  const res = await w.upsertRows([row('2026-10-09', '1'), row('2026-10-09', '2')]);
  assert.deepEqual(res.inserted.sort(), ['2026-10-09|1', '2026-10-09|2']);
  const data = api.dump(TAB);
  assert.equal(data.length, 4); // header + 3 rows, no duplicates
  assert.equal(data.filter((r) => r[0] === '2026-10-09').length, 2);
});

test('insert timeout BEFORE the server applied it: retried once, rows present exactly once', async () => {
  const api = new FakeSheets();
  const w = writer(api);
  await w.upsertRows([row('2026-10-08', '1')]);
  api.failNext.batchUpdate = { error: timeoutError(), afterApply: false };
  await w.upsertRows([row('2026-10-09', '1')]);
  assert.equal(api.dump(TAB).filter((r) => r[0] === '2026-10-09').length, 1);
});

test('non-transient Sheets error (403) is not retried blindly', async () => {
  const api = new FakeSheets();
  const w = writer(api);
  await w.upsertRows([row('2026-10-08', '1')]);
  const before = api.calls.filter((c) => c === 'batchUpdate').length;
  api.failNext.batchUpdate = { error: Object.assign(new Error('The caller does not have permission'), { response: { status: 403 } }), afterApply: false };
  await assert.rejects(w.upsertRows([row('2026-10-09', '1')]), /permission/);
  assert.equal(api.calls.filter((c) => c === 'batchUpdate').length - before, 1); // single attempt, no retry
  assert.equal(api.dump(TAB).filter((r) => r[0] === '2026-10-09').length, 0);
});

test('grows the grid when the sheet is full', async () => {
  const api = new FakeSheets({ tabs: { [TAB]: [HEADERS.slice()] } });
  api.tabs.get(TAB).rowCount = 1;
  await writer(api).upsertRows([row('2026-10-09', '1'), row('2026-10-09', '2')]);
  assert.equal(api.dump(TAB).length, 3);
});
