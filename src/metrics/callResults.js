// Explicit mapping of RingCentral call-log `result` values to report categories.
//
// Source: CallResultEnum in the RingCentral OpenAPI spec (rc-platform.yml, API 1.0.58).
// Note: the API has no "Transferred" result. A transfer is visible through
// `action: "Transfer"`, `reason`, and `transferTarget`/`transferee`; an inbound call
// that the HR answered and then transferred is reported with result "Accepted",
// i.e. "answered" here.
//
// Any value not listed below is classified as "unknown" and reported in
// diagnostics. It is never silently treated as missed.

export const CallCategory = Object.freeze({
  ANSWERED: 'answered',
  MISSED: 'missed',
  VOICEMAIL: 'voicemail',
  REJECTED: 'rejected',
  BUSY: 'busy',
  ABANDONED: 'abandoned',
  STOPPED: 'stopped',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  EMERGENCY: 'emergency',
  IN_PROGRESS: 'in_progress',
  NOT_A_CALL: 'not_a_call',
  FAX: 'fax',
  UNKNOWN: 'unknown',
});

const C = CallCategory;

export const CALL_RESULT_CATEGORY = Object.freeze({
  // Connected / answered by this extension
  Accepted: C.ANSWERED,
  'Call connected': C.ANSWERED,

  // Not answered by this extension
  Missed: C.MISSED,
  'No Answer': C.MISSED,
  // reason "Connected": answered by e.g. an external voicemail that did not press 1 to accept
  'Answered Not Accepted': C.MISSED,
  Voicemail: C.VOICEMAIL,
  'Sent to Voicemail': C.VOICEMAIL,
  Rejected: C.REJECTED,
  Declined: C.REJECTED,
  // the user replied with a quick text instead of answering
  Reply: C.REJECTED,
  Busy: C.BUSY,
  'Hang Up': C.ABANDONED,
  Abandoned: C.ABANDONED,
  // "This attempt was stopped because the call was answered by another phone"
  Stopped: C.STOPPED,
  // Not in the published CallResultEnum, but returned by the live API (seen 2026-10-05):
  // the call rang this HR and was picked up by another member/phone -> the HR did not answer.
  'Answered Elsewhere': C.STOPPED,

  // Failed call attempts (still an attempt)
  'Call Failed': C.FAILED,
  'Call Failure': C.FAILED,
  'Internal Error': C.FAILED,
  'IP Phone Offline': C.FAILED,
  'No Calling Credit': C.FAILED,
  'Not Allowed': C.FAILED,
  'Restricted Number': C.FAILED,
  'Wrong Number': C.FAILED,
  'International Disabled': C.FAILED,
  'International Restricted': C.FAILED,
  'Suspended account': C.FAILED,
  'Carrier is not active': C.FAILED,
  'EDGE trunk misconfigured': C.FAILED,

  Blocked: C.BLOCKED,

  911: C.EMERGENCY,
  933: C.EMERGENCY,

  'In Progress': C.IN_PROGRESS,
  'Phone Login': C.NOT_A_CALL,

  // Fax-only results (records with type=Fax are excluded before classification)
  'Fax Not Sent': C.FAX,
  'Fax Partially Sent': C.FAX,
  'Fax Poor Line': C.FAX,
  'Fax Receipt Error': C.FAX,
  'Fax on Demand': C.FAX,
  'Partial Receive': C.FAX,
  'Receive Error': C.FAX,
  'Send Error': C.FAX,
  Received: C.FAX,
  Sent: C.FAX,

  // RingCentral itself does not know the outcome
  Unknown: C.UNKNOWN,
});

/** Categories that make an inbound call "missed" (the HR did not answer it). */
export const INBOUND_MISSED_CATEGORIES = new Set([C.MISSED, C.VOICEMAIL, C.REJECTED, C.BUSY, C.ABANDONED, C.STOPPED, C.FAILED]);

export function classifyCallResult(result) {
  if (result === undefined || result === null || result === '') return C.UNKNOWN;
  return CALL_RESULT_CATEGORY[String(result)] ?? C.UNKNOWN;
}

export function isKnownCallResult(result) {
  return Object.hasOwn(CALL_RESULT_CATEGORY, String(result)) && String(result) !== 'Unknown';
}
