import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, clusterDates, dateRange, dayBounds, lastCompletedDate, reportDateForRun } from '../src/time.js';

const TZ = 'America/Chicago';

test('regular CDT day is 24h, local midnight = 05:00Z', () => {
  const b = dayBounds('2026-10-09', TZ);
  assert.equal(b.startUtc, '2026-10-09T05:00:00.000Z');
  assert.equal(b.endUtc, '2026-10-10T05:00:00.000Z');
  assert.equal(b.hours, 24);
});

test('regular CST day is 24h, local midnight = 06:00Z', () => {
  const b = dayBounds('2026-12-15', TZ);
  assert.equal(b.startUtc, '2026-12-15T06:00:00.000Z');
  assert.equal(b.endUtc, '2026-12-16T06:00:00.000Z');
  assert.equal(b.hours, 24);
});

test('DST start day (2026-03-08) is 23 hours', () => {
  const b = dayBounds('2026-03-08', TZ);
  assert.equal(b.startUtc, '2026-03-08T06:00:00.000Z');
  assert.equal(b.endUtc, '2026-03-09T05:00:00.000Z');
  assert.equal(b.hours, 23);
});

test('DST end day (2026-11-01) is 25 hours', () => {
  const b = dayBounds('2026-11-01', TZ);
  assert.equal(b.startUtc, '2026-11-01T05:00:00.000Z');
  assert.equal(b.endUtc, '2026-11-02T06:00:00.000Z');
  assert.equal(b.hours, 25);
});

test('consecutive days are contiguous (end of one = start of next)', () => {
  for (const d of dateRange('2026-02-25', '2026-03-15').concat(dateRange('2026-10-25', '2026-11-10'))) {
    assert.equal(dayBounds(d, TZ).endMs, dayBounds(addDays(d, 1), TZ).startMs, d);
  }
});

test('run at 2026-10-10 00:00 Central reports 2026-10-09', () => {
  const at = new Date('2026-10-10T05:00:00.000Z'); // 00:00 CDT
  assert.equal(reportDateForRun(at, TZ), '2026-10-09');
  assert.equal(lastCompletedDate(at, TZ), '2026-10-09');
});

test('00:15 run reports the same previous day', () => {
  assert.equal(reportDateForRun(new Date('2026-10-10T05:15:00.000Z'), TZ), '2026-10-09');
});

test('timer firing slightly before midnight still reports the right day', () => {
  assert.equal(reportDateForRun(new Date('2026-10-10T04:59:59.900Z'), TZ), '2026-10-09');
});

test('midnight run right after DST start/end picks the DST day', () => {
  // 2026-03-09 00:00 CDT = 05:00Z ; previous day is the 23h day
  assert.equal(reportDateForRun(new Date('2026-03-09T05:00:00.000Z'), TZ), '2026-03-08');
  // 2026-11-02 00:00 CST = 06:00Z ; previous day is the 25h day
  assert.equal(reportDateForRun(new Date('2026-11-02T06:00:00.000Z'), TZ), '2026-11-01');
});

test('result does not depend on the server timezone (UTC instant in, zone explicit)', () => {
  // 03:00Z on Oct 10 is still Oct 9 22:00 in Chicago -> last completed day is Oct 8
  assert.equal(lastCompletedDate(new Date('2026-10-10T03:00:00.000Z'), TZ), '2026-10-08');
});

test('clusterDates splits on gaps', () => {
  assert.deepEqual(clusterDates(['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-07']), [['2026-10-01', '2026-10-02', '2026-10-03'], ['2026-10-07']]);
});

test('dateRange is inclusive and rejects reversed ranges', () => {
  assert.deepEqual(dateRange('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.throws(() => dateRange('2026-10-09', '2026-10-01'));
  assert.throws(() => dayBounds('2026-13-01', TZ));
});
