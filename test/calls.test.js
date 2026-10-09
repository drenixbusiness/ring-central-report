import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCallMetrics } from '../src/metrics/calls.js';
import { CALL_RESULT_CATEGORY, classifyCallResult } from '../src/metrics/callResults.js';
import { dayBounds } from '../src/time.js';
import { call } from './helpers/fakes.js';

const DAY = dayBounds('2026-10-09', 'America/Chicago'); // 2026-10-09T05:00Z .. 2026-10-10T05:00Z
const T = (hhmm) => `2026-10-09T${hhmm}:00.000Z`;

test('missed calls are part of inbound and not added again to total', () => {
  const m = computeCallMetrics(
    [
      call({ start: T('14:00'), direction: 'Inbound', result: 'Accepted' }),
      call({ start: T('15:00'), direction: 'Inbound', result: 'Missed' }),
      call({ start: T('16:00'), direction: 'Inbound', result: 'Voicemail' }),
      call({ start: T('17:00'), direction: 'Outbound', result: 'Call connected', action: 'VoIP Call' }),
    ],
    DAY,
  );
  assert.deepEqual([m.inbound, m.outbound, m.missed, m.total], [3, 1, 2, 4]);
});

test('voicemail, rejected, busy, hang up count as missed inbound', () => {
  const results = ['Voicemail', 'Sent to Voicemail', 'Rejected', 'Declined', 'Busy', 'Hang Up', 'No Answer'];
  const m = computeCallMetrics(results.map((r, i) => call({ start: T(`1${i}:00`), result: r })), DAY);
  assert.equal(m.inbound, results.length);
  assert.equal(m.missed, results.length);
});

test('outbound attempts count regardless of outcome (busy, no answer, failed)', () => {
  const results = ['Call connected', 'Accepted', 'Busy', 'No Answer', 'Call Failed', 'Wrong Number', 'Missed'];
  const m = computeCallMetrics(results.map((r, i) => call({ start: T(`1${i}:00`), direction: 'Outbound', result: r, action: 'VoIP Call' })), DAY);
  assert.equal(m.outbound, results.length);
  assert.equal(m.missed, 0);
  assert.equal(m.total, results.length);
});

test('multiple records/legs of one session count once (transfer)', () => {
  const recs = [
    call({ id: 'r1', sessionId: 'S1', telephonySessionId: 'T1', start: T('14:00'), direction: 'Inbound', result: 'Accepted' }),
    // the HR transfers the call: technical outbound Transfer leg in the same session
    call({ id: 'r2', sessionId: 'S1', telephonySessionId: 'T1', start: T('14:02'), direction: 'Outbound', result: 'Call connected', action: 'Transfer' }),
    // the call came back to the HR later in the same telephony session
    call({ id: 'r3', sessionId: 'S1b', telephonySessionId: 'T1', start: T('14:05'), direction: 'Inbound', result: 'Accepted' }),
  ];
  const m = computeCallMetrics(recs, DAY);
  assert.deepEqual([m.inbound, m.outbound, m.missed, m.total], [1, 0, 0, 1]);
});

test('records linked only through sessionId and telephonySessionId chain are one call', () => {
  const recs = [
    call({ id: 'a', sessionId: 'S9', telephonySessionId: 'T9', start: T('10:00'), direction: 'Outbound', action: 'RingOut Web', result: 'Call connected' }),
    call({ id: 'b', sessionId: 'S9', telephonySessionId: 'T9x', start: T('10:00'), direction: 'Outbound', action: 'RingOut Web', result: 'Call connected' }),
    call({ id: 'c', sessionId: 'S9y', telephonySessionId: 'T9x', start: T('10:01'), direction: 'Outbound', action: 'RingOut Web', result: 'Call connected' }),
  ];
  const m = computeCallMetrics(recs, DAY);
  assert.equal(m.outbound, 1);
});

test('forwarding leg of an inbound call is not an outbound call', () => {
  const recs = [
    call({ sessionId: 'F1', start: T('12:00'), direction: 'Inbound', result: 'Missed' }),
    call({ sessionId: 'F1', start: T('12:00'), direction: 'Outbound', action: 'FindMe', result: 'No Answer' }),
    // forwarding-only record in its own session (no inbound record visible): ignored
    call({ sessionId: 'F2', start: T('13:00'), direction: 'Outbound', action: 'FollowMe', result: 'Call connected' }),
  ];
  const m = computeCallMetrics(recs, DAY);
  assert.deepEqual([m.inbound, m.outbound, m.missed], [1, 0, 1]);
  assert.equal(m.diagnostics.technicalOnlyGroups, 1);
});

test('inbound answered on any leg is not missed', () => {
  const recs = [
    call({ sessionId: 'Q', start: T('09:00'), direction: 'Inbound', result: 'Missed' }),
    call({ sessionId: 'Q', start: T('09:00'), direction: 'Inbound', result: 'Accepted' }),
  ];
  const m = computeCallMetrics(recs, DAY);
  assert.deepEqual([m.inbound, m.missed], [1, 0]);
});

test('duplicate record ids (overlapping pages) are counted once', () => {
  const r = call({ id: 'dup', start: T('09:00') });
  const m = computeCallMetrics([r, { ...r }], DAY);
  assert.equal(m.inbound, 1);
  assert.equal(m.diagnostics.duplicateRecordIds, 1);
});

test('fax and non-call actions are excluded', () => {
  const m = computeCallMetrics(
    [
      call({ start: T('09:00'), type: 'Fax', action: 'Incoming Fax', result: 'Received' }),
      call({ start: T('09:10'), action: 'Monitoring', result: 'Accepted' }),
      call({ start: T('09:20'), action: 'Paging', direction: 'Outbound', result: 'Call connected' }),
    ],
    DAY,
  );
  assert.equal(m.total, 0);
});

test('internal extension-to-extension calls count when in the HR log', () => {
  const m = computeCallMetrics([call({ start: T('09:00'), direction: 'Outbound', action: 'VoIP Call', result: 'Call connected' }), call({ start: T('10:00'), direction: 'Inbound', result: 'Accepted' })], DAY);
  assert.deepEqual([m.inbound, m.outbound], [1, 1]);
});

test('day assignment uses the earliest startTime of the call; boundaries are [start, end)', () => {
  const recs = [
    call({ start: '2026-10-09T05:00:00.000Z' }), // exactly local 00:00 -> included
    call({ start: '2026-10-10T05:00:00.000Z' }), // next local 00:00 -> excluded
    call({ start: '2026-10-09T04:59:59.000Z' }), // previous day -> excluded
    // started 23:59 previous day, second record after midnight -> belongs to previous day
    call({ sessionId: 'X', start: '2026-10-09T04:59:00.000Z' }),
    call({ sessionId: 'X', start: '2026-10-09T05:00:30.000Z' }),
  ];
  const m = computeCallMetrics(recs, DAY);
  assert.equal(m.inbound, 1);
});

test('blocked inbound calls are not counted', () => {
  const m = computeCallMetrics([call({ start: T('09:00'), result: 'Blocked' })], DAY);
  assert.equal(m.inbound, 0);
  assert.equal(m.diagnostics.blockedInbound, 1);
});

test('unknown inbound result is never silently missed', () => {
  const recs = [call({ start: T('09:00'), result: 'Some New Result' }), call({ start: T('10:00'), result: null })];
  const failPolicy = computeCallMetrics(recs, DAY, { unknownResultPolicy: 'fail' });
  assert.equal(failPolicy.missed, 0);
  assert.equal(failPolicy.unresolved, 2);
  assert.deepEqual(failPolicy.diagnostics.unknownResults, { 'Some New Result': 1, '(none)': 1 });
  const lenient = computeCallMetrics(recs, DAY, { unknownResultPolicy: 'count-not-missed' });
  assert.deepEqual([lenient.inbound, lenient.missed, lenient.unresolved], [2, 0, 0]);
});

test('in-progress inbound call is provisional, not missed', () => {
  const m = computeCallMetrics([call({ start: T('23:00'), result: 'In Progress' })], DAY);
  assert.deepEqual([m.inbound, m.missed, m.provisional], [1, 0, true]);
});

test('per-extension dedup: the same session in two HR logs counts for both HRs', () => {
  const shared = { sessionId: 'SHARED', telephonySessionId: 'TSHARED', start: T('11:00') };
  const hrA = computeCallMetrics([call({ ...shared, id: 'a1', direction: 'Outbound', action: 'VoIP Call', result: 'Call connected' })], DAY);
  const hrB = computeCallMetrics([call({ ...shared, id: 'b1', direction: 'Inbound', result: 'Accepted' })], DAY);
  assert.equal(hrA.outbound, 1);
  assert.equal(hrB.inbound, 1);
});

test('result mapping covers every CallResultEnum value from the API spec', () => {
  const specValues = ['911', '933', 'Abandoned', 'Accepted', 'Answered Not Accepted', 'Blocked', 'Busy', 'Call Failed', 'Call Failure', 'Call connected', 'Carrier is not active', 'Declined', 'EDGE trunk misconfigured', 'Fax Not Sent', 'Fax Partially Sent', 'Fax Poor Line', 'Fax Receipt Error', 'Fax on Demand', 'Hang Up', 'IP Phone Offline', 'In Progress', 'Internal Error', 'International Disabled', 'International Restricted', 'Missed', 'No Answer', 'No Calling Credit', 'Not Allowed', 'Partial Receive', 'Phone Login', 'Receive Error', 'Received', 'Rejected', 'Reply', 'Restricted Number', 'Send Error', 'Sent', 'Sent to Voicemail', 'Stopped', 'Suspended account', 'Unknown', 'Voicemail', 'Wrong Number'];
  for (const v of specValues) assert.ok(Object.hasOwn(CALL_RESULT_CATEGORY, v), `missing mapping for ${v}`);
  assert.equal(classifyCallResult('Transferred'), 'unknown');
});
