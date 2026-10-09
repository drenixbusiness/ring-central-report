// Calendar-day arithmetic for the report timezone.
//
// Rules:
//  * A report day is [local 00:00, next local 00:00) in REPORT_TIMEZONE
//    (start-inclusive, end-exclusive), converted to UTC instants for the API.
//  * The server's own timezone is never used, and no fixed UTC offset is assumed:
//    luxon resolves the IANA zone, so DST days are 23 or 25 hours long.
//  * "Now minus 24 hours" is never used to find a day.

import { DateTime, IANAZone } from 'luxon';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimezone(tz) {
  return typeof tz === 'string' && IANAZone.isValidZone(tz);
}

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  return DateTime.fromISO(value, { zone: 'UTC' }).isValid;
}

export function assertIsoDate(value, label = 'date') {
  if (!isValidIsoDate(value)) {
    throw new Error(`Invalid ${label} "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

/**
 * Local calendar-day boundaries converted to UTC.
 * @returns {{date:string,startUtc:string,endUtc:string,startMs:number,endMs:number,hours:number}}
 */
export function dayBounds(date, tz) {
  assertIsoDate(date);
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  if (!start.isValid) throw new Error(`Cannot resolve ${date} in timezone ${tz}: ${start.invalidExplanation}`);
  const end = start.plus({ days: 1 }).startOf('day');
  return {
    date,
    startUtc: start.toUTC().toISO(),
    endUtc: end.toUTC().toISO(),
    startMs: start.toMillis(),
    endMs: end.toMillis(),
    hours: end.diff(start, 'hours').hours,
  };
}

/** Today's calendar date (YYYY-MM-DD) in the given zone. */
export function todayIn(now, tz) {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate();
}

/** The last fully completed calendar day in the given zone. */
export function lastCompletedDate(now, tz) {
  return DateTime.fromJSDate(now, { zone: tz }).startOf('day').minus({ days: 1 }).toISODate();
}

/**
 * Report date for a scheduled run. A small skew allowance protects against a
 * timer firing a few milliseconds before local midnight.
 */
export function reportDateForRun(now, tz, skewMinutes = 5) {
  const shifted = DateTime.fromJSDate(now, { zone: tz }).plus({ minutes: skewMinutes });
  return shifted.startOf('day').minus({ days: 1 }).toISODate();
}

/** Pure calendar arithmetic on YYYY-MM-DD strings (zone independent). */
export function addDays(date, days) {
  assertIsoDate(date);
  return DateTime.fromISO(date, { zone: 'UTC' }).plus({ days }).toISODate();
}

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive list of dates from..to. */
export function dateRange(from, to) {
  assertIsoDate(from, 'from date');
  assertIsoDate(to, 'to date');
  if (from > to) throw new Error(`from date ${from} is after to date ${to}`);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Splits sorted unique dates into runs of consecutive days. */
export function clusterDates(dates) {
  const sorted = [...new Set(dates)].sort();
  const clusters = [];
  let current = [];
  for (const d of sorted) {
    if (current.length && addDays(current[current.length - 1], 1) !== d) {
      clusters.push(current);
      current = [];
    }
    current.push(d);
  }
  if (current.length) clusters.push(current);
  return clusters;
}

export function maxDate(...dates) {
  return dates.filter(Boolean).sort().at(-1) ?? null;
}

export function minDate(...dates) {
  return dates.filter(Boolean).sort()[0] ?? null;
}
