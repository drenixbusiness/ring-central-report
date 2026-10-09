// Outbound SMS metric for one extension and one report day.
//
// Counted: unique message IDs with type=SMS, direction=Outbound,
// messageStatus in {Sent, Delivered}, creationTime inside the report day.
//  * "Sent"      = RingCentral handed the message to the carrier successfully.
//  * "Delivered" = the carrier confirmed delivery to the handset.
//   These are different guarantees; both are counted as "successfully sent".
// Not counted: Queued, SendingFailed, DeliveryFailed, Received, unknown statuses,
// inbound SMS, Fax, VoiceMail, Pager (internal) and Text records.
// One message ID = 1, regardless of billing segments or number of recipients.
// Multi-recipient record: counted once only if the record status is Sent/Delivered
// AND at least one recipient carrying its own status is Sent/Delivered.

export const SMS_SUCCESS_STATUSES = new Set(['Sent', 'Delivered']);
export const SMS_FAILED_STATUSES = new Set(['SendingFailed', 'DeliveryFailed']);
export const SMS_PENDING_STATUSES = new Set(['Queued']);

export function classifySmsStatus(status) {
  if (SMS_SUCCESS_STATUSES.has(status)) return 'success';
  if (SMS_FAILED_STATUSES.has(status)) return 'failed';
  if (SMS_PENDING_STATUSES.has(status)) return 'pending';
  if (status === 'Received') return 'received';
  return 'unknown';
}

/**
 * @param {object[]} records message-store records of ONE extension
 * @param {{startMs:number,endMs:number}} day
 */
export function computeSmsMetrics(records, day) {
  const diagnostics = {
    records: 0,
    nonSms: 0,
    notOutbound: 0,
    outsideDay: 0,
    duplicateIds: 0,
    byStatus: {},
    allRecipientsFailed: 0,
    unknownStatuses: {},
  };
  const counted = new Set();
  const seen = new Set();

  for (const m of records || []) {
    diagnostics.records += 1;
    const id = m?.id === undefined || m?.id === null ? null : String(m.id);
    if (id !== null) {
      if (seen.has(id)) {
        diagnostics.duplicateIds += 1;
        continue;
      }
      seen.add(id);
    }
    if (m.type !== 'SMS') {
      diagnostics.nonSms += 1;
      continue;
    }
    if (m.direction !== 'Outbound') {
      diagnostics.notOutbound += 1;
      continue;
    }
    const created = Date.parse(m.creationTime);
    if (!Number.isFinite(created) || created < day.startMs || created >= day.endMs) {
      diagnostics.outsideDay += 1;
      continue;
    }
    const status = m.messageStatus ?? '(none)';
    diagnostics.byStatus[status] = (diagnostics.byStatus[status] || 0) + 1;
    const cls = classifySmsStatus(m.messageStatus);
    if (cls === 'unknown') diagnostics.unknownStatuses[status] = (diagnostics.unknownStatuses[status] || 0) + 1;
    if (cls !== 'success') continue;

    const recipientStatuses = (Array.isArray(m.to) ? m.to : []).map((t) => t?.messageStatus).filter(Boolean);
    if (recipientStatuses.length && !recipientStatuses.some((s) => SMS_SUCCESS_STATUSES.has(s))) {
      diagnostics.allRecipientsFailed += 1;
      continue;
    }
    if (id === null) continue; // cannot be deduplicated reliably; never guess
    counted.add(id);
  }

  return { sent: counted.size, diagnostics };
}
