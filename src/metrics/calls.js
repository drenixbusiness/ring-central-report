// Per-extension call metrics for one report day.
//
// Definitions (ours, not RingCentral Analytics'):
//  inbound  = distinct real inbound Voice calls recorded in the HR's call log (answered or not)
//  outbound = distinct real Voice call attempts started by the HR (answered, unanswered, busy, failed)
//  missed   = inbound calls the HR did not answer (incl. voicemail); a subset of inbound
//  total    = inbound + outbound (missed is never added again)
//
// Deduplication is done per extension only: records of the same extension that share
// a sessionId ("internal identifier of a call session") or telephonySessionId
// ("telephony identifier of a call session") form ONE call. The call log record `id`
// identifies one record and is only used when no session id is present.
// The call belongs to the day of the earliest startTime among its records.

import { CallCategory as C, INBOUND_MISSED_CATEGORIES, classifyCallResult } from './callResults.js';

/** Actions that are not conversations of this HR (supervision, broadcast, system). */
export const EXCLUDED_ACTIONS = new Set(['Monitoring', 'Barge In Call', 'Paging', 'Phone Login', 'E911 Update', 'Park Location']);

/**
 * Outbound-direction actions that are technical legs (forwarding, transfer, pickup,
 * moving a call between devices). They never count as a call started by the HR.
 */
export const TECHNICAL_OUTBOUND_ACTIONS = new Set([
  'FindMe',
  'FollowMe',
  'Sip Forwarding',
  'Hunting',
  'Transfer',
  'Move',
  'RingMe',
  'Accept Call',
  'Pickup',
  'Call Park',
]);

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/** Groups records of ONE extension into calls. Exported for tests. */
export function groupCallRecords(records) {
  const uf = new UnionFind();
  const keysOf = (r, i) => {
    const keys = [];
    if (r.sessionId) keys.push(`s:${r.sessionId}`);
    if (r.telephonySessionId) keys.push(`t:${r.telephonySessionId}`);
    if (!keys.length) keys.push(r.id ? `r:${r.id}` : `i:${i}`);
    return keys;
  };
  const recordKeys = records.map((r, i) => {
    const keys = keysOf(r, i);
    for (const k of keys.slice(1)) uf.union(keys[0], k);
    uf.find(keys[0]);
    return keys[0];
  });
  const groups = new Map();
  records.forEach((r, i) => {
    const root = uf.find(recordKeys[i]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });
  return [...groups.values()];
}

function emptyDiagnostics() {
  return {
    records: 0,
    duplicateRecordIds: 0,
    nonVoice: 0,
    excludedAction: 0,
    missingStartTime: 0,
    unknownDirection: 0,
    blockedInbound: 0,
    technicalOnlyGroups: 0,
    outsideDayGroups: 0,
    inProgress: 0,
    unknownInbound: 0,
    unknownResults: {},
    answered: 0,
  };
}

/**
 * @param {object[]} records call-log records of ONE extension (may include buffer time around the day)
 * @param {{startMs:number,endMs:number}} day
 * @param {{unknownResultPolicy?: 'fail'|'count-not-missed'}} [opts]
 * @returns {{inbound:number,outbound:number,missed:number,total:number,unresolved:number,provisional:boolean,diagnostics:object}}
 */
export function computeCallMetrics(records, day, { unknownResultPolicy = 'fail' } = {}) {
  const d = emptyDiagnostics();
  const seenIds = new Set();
  const usable = [];

  for (const r of records || []) {
    d.records += 1;
    if (r.id) {
      if (seenIds.has(String(r.id))) {
        d.duplicateRecordIds += 1;
        continue;
      }
      seenIds.add(String(r.id));
    }
    if (r.type !== 'Voice') {
      d.nonVoice += 1;
      continue;
    }
    if (EXCLUDED_ACTIONS.has(r.action)) {
      d.excludedAction += 1;
      continue;
    }
    const startMs = Date.parse(r.startTime);
    if (!Number.isFinite(startMs)) {
      d.missingStartTime += 1;
      continue;
    }
    if (r.direction !== 'Inbound' && r.direction !== 'Outbound') {
      d.unknownDirection += 1;
      continue;
    }
    usable.push({ ...r, _startMs: startMs });
  }

  let inbound = 0;
  let outbound = 0;
  let missed = 0;

  for (const group of groupCallRecords(usable)) {
    const groupStart = Math.min(...group.map((r) => r._startMs));
    if (groupStart < day.startMs || groupStart >= day.endMs) {
      d.outsideDayGroups += 1;
      continue;
    }

    const inboundRecs = group.filter((r) => r.direction === 'Inbound');
    const outboundRecs = group.filter((r) => r.direction === 'Outbound' && !TECHNICAL_OUTBOUND_ACTIONS.has(r.action));

    if (inboundRecs.length) {
      const cats = inboundRecs.map((r) => classifyCallResult(r.result));
      if (cats.every((c) => c === C.BLOCKED)) {
        d.blockedInbound += 1;
        continue;
      }
      inbound += 1;
      if (cats.includes(C.ANSWERED)) {
        d.answered += 1;
      } else if (cats.includes(C.IN_PROGRESS)) {
        // Still ringing/connected when fetched: not missed yet; the day is re-checked later.
        d.inProgress += 1;
      } else if (cats.some((c) => !INBOUND_MISSED_CATEGORIES.has(c) && c !== C.BLOCKED)) {
        d.unknownInbound += 1;
        for (const r of inboundRecs) {
          const c = classifyCallResult(r.result);
          if (!INBOUND_MISSED_CATEGORIES.has(c) && c !== C.BLOCKED && c !== C.ANSWERED) {
            const key = String(r.result ?? '(none)');
            d.unknownResults[key] = (d.unknownResults[key] || 0) + 1;
          }
        }
      } else {
        missed += 1;
      }
      continue;
    }

    if (outboundRecs.length) {
      outbound += 1;
      // Every attempt counts; still surface results we do not recognise.
      for (const r of outboundRecs) {
        const c = classifyCallResult(r.result);
        if (c === C.IN_PROGRESS) d.inProgress += 1;
        if (c === C.UNKNOWN || c === C.FAX || c === C.NOT_A_CALL) {
          const key = String(r.result ?? '(none)');
          d.unknownResults[key] = (d.unknownResults[key] || 0) + 1;
        }
      }
      continue;
    }

    d.technicalOnlyGroups += 1;
  }

  // unknownInbound calls are counted as inbound, never as missed. Under the "fail"
  // policy the caller must not publish this day until the mapping is reviewed.
  const unresolved = unknownResultPolicy === 'fail' ? d.unknownInbound : 0;
  return {
    inbound,
    outbound,
    missed,
    total: inbound + outbound,
    unresolved,
    provisional: d.inProgress > 0,
    diagnostics: d,
  };
}
