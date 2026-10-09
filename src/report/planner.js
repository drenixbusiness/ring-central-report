// Decides which (date, HR) pairs a run must process.

import { addDays, lastCompletedDate, maxDate, minDate, reportDateForRun } from '../time.js';

export const PERMISSION_ERROR_CODES = new Set(['RC_401', 'RC_403']);
export const MAX_AUTO_PERMISSION_ATTEMPTS = 3;

export function hrWindow(hr, globalStart) {
  return { from: maxDate(globalStart, hr.reportStartDate), to: hr.reportEndDate || null };
}

export function isHrActiveOn(hr, date, globalStart) {
  const { from, to } = hrWindow(hr, globalStart);
  return date >= from && (!to || date <= to);
}

export function retryBackoffMs(attempts) {
  const base = 5 * 60 * 1000;
  return Math.min(6 * 60 * 60 * 1000, base * 2 ** Math.max(0, attempts - 1));
}

/** Whether an existing failed state may be retried automatically now. */
export function isRetryDue(state, nowMs) {
  if (state.status !== 'failed') return true;
  if (PERMISSION_ERROR_CODES.has(state.last_error_code) && state.attempts >= MAX_AUTO_PERMISSION_ATTEMPTS) return false;
  const last = Date.parse(state.last_attempt_at || 0);
  return !Number.isFinite(last) || nowMs - last >= retryBackoffMs(state.attempts);
}

/**
 * Pairs between each HR's start and the last completed day that are not 'ok'
 * in the state DB (never processed, pending after a crash, provisional, failed).
 */
export function outstandingPairs({ hrs, globalStart, lastCompleted, states, nowMs, applyBackoff }) {
  const pairs = [];
  const skippedPermission = [];
  for (const hr of hrs) {
    const { from, to } = hrWindow(hr, globalStart);
    const until = minDate(lastCompleted, to || lastCompleted);
    for (let d = from; d <= until; d = addDays(d, 1)) {
      const st = states.get(`${d}|${hr.extensionId}`);
      if (st && st.status === 'ok') continue;
      if (st && applyBackoff && !isRetryDue(st, nowMs)) {
        if (PERMISSION_ERROR_CODES.has(st.last_error_code)) skippedPermission.push({ date: d, extensionId: hr.extensionId });
        continue;
      }
      pairs.push({ date: d, extensionId: hr.extensionId });
    }
  }
  return { pairs, skippedPermission };
}

export function pairsForDates(hrs, dates, globalStart) {
  const pairs = [];
  for (const hr of hrs) for (const date of dates) if (isHrActiveOn(hr, date, globalStart)) pairs.push({ date, extensionId: hr.extensionId });
  return pairs;
}

function mergePairs(...lists) {
  const map = new Map();
  for (const list of lists) for (const p of list) map.set(`${p.date}|${p.extensionId}`, p);
  return [...map.values()].sort((a, b) => (a.date === b.date ? a.extensionId.localeCompare(b.extensionId) : a.date < b.date ? -1 : 1));
}

/**
 * @param {'daily'|'late-recheck'|'retry'|'startup'} trigger
 * @param {{hrs, config, states:Map, now:Date}} ctx
 */
export function planScheduledRun(trigger, { hrs, config, states, now }) {
  const tz = config.report.timezone;
  const globalStart = config.report.startDate;
  const nowMs = now.getTime();
  const lastCompleted = lastCompletedDate(now, tz);
  const reportDate = reportDateForRun(now, tz);

  if (trigger === 'daily') {
    const dates = [reportDate];
    for (let i = 1; i <= config.report.reconcileDays; i += 1) dates.push(addDays(reportDate, -i));
    const outstanding = outstandingPairs({ hrs, globalStart, lastCompleted, states, nowMs, applyBackoff: false });
    return { pairs: mergePairs(pairsForDates(hrs, dates, globalStart), outstanding.pairs), skippedPermission: [] };
  }
  if (trigger === 'late-recheck') {
    return { pairs: mergePairs(pairsForDates(hrs, [reportDate], globalStart)), skippedPermission: [] };
  }
  // 'retry' and 'startup': only what is missing or failed, honouring backoff.
  const outstanding = outstandingPairs({ hrs, globalStart, lastCompleted, states, nowMs, applyBackoff: true });
  return { pairs: mergePairs(outstanding.pairs), skippedPermission: outstanding.skippedPermission };
}
