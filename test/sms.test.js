import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSmsMetrics } from '../src/metrics/sms.js';
import { dayBounds } from '../src/time.js';
import { sms } from './helpers/fakes.js';

const DAY = dayBounds('2026-10-09', 'America/Chicago');
const T = (hhmm) => `2026-10-09T${hhmm}:00.000Z`;

test('Sent and Delivered are counted; Queued and failures are not', () => {
  const m = computeSmsMetrics(
    [
      sms({ created: T('10:00'), status: 'Sent' }),
      sms({ created: T('10:01'), status: 'Delivered' }),
      sms({ created: T('10:02'), status: 'Queued' }),
      sms({ created: T('10:03'), status: 'SendingFailed' }),
      sms({ created: T('10:04'), status: 'DeliveryFailed' }),
      sms({ created: T('10:05'), status: 'SomethingNew' }),
    ],
    DAY,
  );
  assert.equal(m.sent, 2);
  assert.deepEqual(m.diagnostics.unknownStatuses, { SomethingNew: 1 });
});

test('inbound SMS, pager, fax and voicemail are excluded', () => {
  const m = computeSmsMetrics(
    [
      sms({ created: T('10:00'), direction: 'Inbound', status: 'Received' }),
      sms({ created: T('10:00'), type: 'Pager', status: 'Sent' }),
      sms({ created: T('10:00'), type: 'Fax', status: 'Sent' }),
      sms({ created: T('10:00'), type: 'VoiceMail', status: 'Received', direction: 'Inbound' }),
    ],
    DAY,
  );
  assert.equal(m.sent, 0);
});

test('each unique message id counts once; same text with new id counts again', () => {
  const a = sms({ id: 1, created: T('10:00'), status: 'Delivered' });
  const m = computeSmsMetrics([a, { ...a }, sms({ id: 2, created: T('10:05'), status: 'Delivered' })], DAY);
  assert.equal(m.sent, 2);
});

test('multi-recipient record counts once, and not at all when every recipient failed', () => {
  const okGroup = sms({ created: T('11:00'), status: 'Sent', to: [{ messageStatus: 'Delivered' }, { messageStatus: 'DeliveryFailed' }, { messageStatus: 'Delivered' }] });
  const allFailed = sms({ created: T('11:01'), status: 'Sent', to: [{ messageStatus: 'DeliveryFailed' }, { messageStatus: 'SendingFailed' }] });
  const m = computeSmsMetrics([okGroup, allFailed], DAY);
  assert.equal(m.sent, 1);
  assert.equal(m.diagnostics.allRecipientsFailed, 1);
});

test('date uses creationTime; [start, end) boundaries', () => {
  const m = computeSmsMetrics(
    [
      sms({ created: '2026-10-09T05:00:00.000Z', status: 'Sent' }),
      sms({ created: '2026-10-10T05:00:00.000Z', status: 'Sent' }),
      sms({ created: '2026-10-09T04:59:59.999Z', status: 'Sent' }),
    ],
    DAY,
  );
  assert.equal(m.sent, 1);
});

test('a message that later turned failed drops out on recomputation', () => {
  const first = computeSmsMetrics([sms({ id: 77, created: T('12:00'), status: 'Sent' })], DAY);
  const later = computeSmsMetrics([sms({ id: 77, created: T('12:00'), status: 'DeliveryFailed' })], DAY);
  assert.equal(first.sent, 1);
  assert.equal(later.sent, 0);
});
