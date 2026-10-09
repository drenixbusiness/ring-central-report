// Collects RingCentral data for (date, HR) pairs, computes metrics and upserts the sheet.
//
// Guarantees:
//  * A pair is written only if ALL call-log pages and ALL message-store pages for
//    that HR were fetched. Otherwise nothing is written for it (existing sheet rows
//    stay as they are) and it is recorded as failed for retry.
//  * One HR failing never stops the other HRs.
//  * Dry-run never touches the sheet or the state DB.

import { RcApiError, permissionGuidance } from '../ringcentral/errors.js';
import { computeCallMetrics } from '../metrics/calls.js';
import { computeSmsMetrics } from '../metrics/sms.js';
import { clusterDates, dayBounds } from '../time.js';
import { mapLimit } from '../util/async.js';

function errorCode(err) {
  if (err instanceof RcApiError) return err.code;
  return err?.code && typeof err.code === 'string' ? err.code : 'ERROR';
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class ReportRunner {
  /**
   * @param {object} p
   * @param {object} p.config
   * @param {Array} p.hrs validated HR entries
   * @param {{fetchCallLog:Function, fetchOutboundSms:Function}} p.dataSource
   * @param {import('../sheets/sheetWriter.js').SheetWriter} [p.sheetWriter]
   * @param {import('../state/stateStore.js').StateStore} [p.state]
   * @param {import('../state/processLock.js').ProcessLock} [p.lock]
   */
  constructor({ config, hrs, dataSource, sheetWriter, state, lock, logger, now = () => new Date() }) {
    this.config = config;
    this.hrs = hrs;
    this.hrById = new Map(hrs.map((h) => [h.extensionId, h]));
    this.dataSource = dataSource;
    this.sheetWriter = sheetWriter;
    this.state = state;
    this.lock = lock;
    this.logger = logger;
    this.now = now;
  }

  async collectForHr(hr, dates) {
    const tz = this.config.report.timezone;
    const bufferMs = this.config.report.callLogBufferMinutes * 60 * 1000;
    const ok = [];
    const failed = [];

    for (const cluster of clusterDates(dates)) {
      const first = dayBounds(cluster[0], tz);
      const last = dayBounds(cluster[cluster.length - 1], tz);
      let calls;
      let sms;
      try {
        // Buffer before the day lets us see calls whose first leg started on the
        // previous day (they belong there); buffer after catches late legs.
        const callFrom = new Date(first.startMs - bufferMs).toISOString();
        const callTo = new Date(Math.min(last.endMs + bufferMs, this.now().getTime())).toISOString();
        calls = await this.dataSource.fetchCallLog(hr.extensionId, callFrom, callTo);
        sms = await this.dataSource.fetchOutboundSms(hr.extensionId, first.startUtc, last.endUtc);
      } catch (err) {
        const code = errorCode(err);
        const guidance = permissionGuidance(err);
        this.logger.error('Data fetch failed; nothing will be written for these days', {
          extensionId: hr.extensionId,
          dates: `${cluster[0]}..${cluster[cluster.length - 1]}`,
          errorCode: code,
          rcErrorCode: err?.errorCode || undefined,
          error: err.message,
        });
        if (guidance) this.logger.error(`Action required: ${guidance}`, { extensionId: hr.extensionId, errorCode: code });
        for (const date of cluster) failed.push({ date, extensionId: hr.extensionId, code, message: err.message });
        continue;
      }

      this.logger.debug('Fetched RingCentral data', { extensionId: hr.extensionId, dates: `${cluster[0]}..${cluster[cluster.length - 1]}`, callRecords: calls.length, smsRecords: sms.length });

      for (const date of cluster) {
        const bounds = dayBounds(date, tz);
        const cm = computeCallMetrics(calls, bounds, { unknownResultPolicy: this.config.report.unknownResultPolicy });
        const sm = computeSmsMetrics(sms, bounds);
        const unknownResults = cm.diagnostics.unknownResults;

        if (Object.keys(unknownResults).length) {
          this.logger.warn('Unmapped call result values found; review src/metrics/callResults.js', { date, extensionId: hr.extensionId, unknownResults });
        }
        if (Object.keys(sm.diagnostics.unknownStatuses).length) {
          this.logger.warn('Unknown SMS status values found; they were not counted', { date, extensionId: hr.extensionId, unknownStatuses: sm.diagnostics.unknownStatuses });
        }
        if (cm.unresolved > 0) {
          const message = `${cm.unresolved} inbound call(s) have result values without a missed/answered mapping: ${JSON.stringify(unknownResults)}. Not written (UNKNOWN_CALL_RESULT_POLICY=fail).`;
          this.logger.error('Day not written because of unknown call results', { date, extensionId: hr.extensionId, errorCode: 'UNKNOWN_CALL_RESULT', unknownResults });
          failed.push({ date, extensionId: hr.extensionId, code: 'UNKNOWN_CALL_RESULT', message });
          continue;
        }
        ok.push({
          reportDate: date,
          date,
          extensionId: hr.extensionId,
          hrName: hr.name,
          phoneNumber: hr.phoneNumber,
          inbound: cm.inbound,
          outbound: cm.outbound,
          missed: cm.missed,
          total: cm.total,
          sms: sm.sent,
          provisional: cm.provisional,
          diagnostics: { calls: cm.diagnostics, sms: sm.diagnostics },
        });
      }
    }
    return { ok, failed };
  }

  /**
   * @param {Array<{date:string, extensionId:string}>} pairs
   * @param {{dryRun?:boolean, trigger?:string}} opts
   */
  async processPairs(pairs, { dryRun = false, trigger = 'manual' } = {}) {
    const byHr = new Map();
    for (const p of pairs) {
      if (!this.hrById.has(p.extensionId)) continue;
      if (!byHr.has(p.extensionId)) byHr.set(p.extensionId, new Set());
      byHr.get(p.extensionId).add(p.date);
    }
    const work = [...byHr.entries()].map(([extensionId, dates]) => ({ hr: this.hrById.get(extensionId), dates: [...dates].sort() }));
    const total = work.reduce((n, w) => n + w.dates.length, 0);
    this.logger.info('Run started', { trigger, dryRun, hrs: work.length, hrDays: total });
    if (!total) return { trigger, dryRun, ok: [], failed: [], inserted: 0, updated: 0 };

    if (!dryRun) {
      this.lock?.assertHeld();
      this.state.markQueued(work.flatMap((w) => w.dates.map((date) => ({ date, extensionId: w.hr.extensionId }))));
    }

    const collected = await mapLimit(work, this.config.report.hrConcurrency, (w) => this.collectForHr(w.hr, w.dates));
    const ok = collected.flatMap((c) => c.ok).sort((a, b) => (a.date === b.date ? a.extensionId.localeCompare(b.extensionId) : a.date < b.date ? -1 : 1));
    const failed = collected.flatMap((c) => c.failed);

    let inserted = 0;
    let updated = 0;
    const written = [];

    if (dryRun) {
      return { trigger, dryRun, ok, failed, inserted, updated };
    }

    if (failed.length) this.state.markFailed(failed);

    let sheetsBlocked = null;
    for (const batch of chunk(ok, this.config.report.sheetsBatchSize)) {
      if (sheetsBlocked) {
        const fails = batch.map((r) => ({ date: r.date, extensionId: r.extensionId, code: sheetsBlocked.code, message: sheetsBlocked.message }));
        this.state.markFailed(fails);
        failed.push(...fails);
        continue;
      }
      try {
        this.lock?.assertHeld();
        const res = await this.sheetWriter.upsertRows(batch);
        inserted += res.inserted.length;
        updated += res.updated.length;
        this.state.markWritten(batch);
        written.push(...batch);
      } catch (err) {
        const code = errorCode(err) === 'ERROR' ? 'SHEETS_ERROR' : errorCode(err);
        this.logger.error('Writing to Google Sheets failed', { errorCode: code, rows: batch.length, error: err.message });
        const fails = batch.map((r) => ({ date: r.date, extensionId: r.extensionId, code, message: err.message }));
        this.state.markFailed(fails);
        failed.push(...fails);
        // Configuration-type problems will fail every batch the same way.
        if (code === 'SHEETS_HEADER_MISMATCH' || code === 'LOCK_LOST' || err?.response?.status === 403 || err?.response?.status === 404) sheetsBlocked = { code, message: err.message };
      }
    }

    for (const r of written) {
      this.logger.info('HR day written', {
        date: r.date,
        extensionId: r.extensionId,
        inbound: r.inbound,
        outbound: r.outbound,
        missed: r.missed,
        total: r.total,
        sms: r.sms,
        provisional: r.provisional || undefined,
      });
    }
    for (const f of failed) {
      this.logger.warn('HR day not written', { date: f.date, extensionId: f.extensionId, errorCode: f.code });
    }
    this.logger.info('Run finished', { trigger, written: written.length, inserted, updated, failed: failed.length });
    return { trigger, dryRun, ok: written, failed, inserted, updated };
  }
}

/**
 * Acquires the shared process lock, records the run, executes fn, releases the lock.
 */
export async function runExclusive({ lock, state, logger, trigger, waitMs = 0 }, fn) {
  await lock.acquire(trigger, { waitMs });
  const runId = state.startRun(trigger);
  try {
    const summary = await fn();
    const status = summary?.failed?.length ? 'partial' : 'ok';
    state.finishRun(runId, status, { written: summary?.ok?.length ?? 0, failed: summary?.failed?.length ?? 0, inserted: summary?.inserted ?? 0, updated: summary?.updated ?? 0 });
    return summary;
  } catch (err) {
    state.finishRun(runId, 'error', { error: err.message, errorCode: err.code });
    logger.error('Run aborted', { trigger, errorCode: err.code || 'ERROR', error: err.message });
    throw err;
  } finally {
    lock.release();
  }
}
