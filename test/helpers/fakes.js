import { createSilentLogger } from '../../src/logger.js';

export const logger = createSilentLogger();

/** Minimal fetch-like Response. */
export function fakeResponse(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const res = {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (h.has(name.toLowerCase()) ? h.get(name.toLowerCase()) : null) },
    json: async () => body,
    clone: () => res,
  };
  return res;
}

/** SDK-like error (the SDK throws errors carrying `.response`). */
export function apiError(status, body = {}, headers = {}) {
  const err = new Error(`HTTP ${status}`);
  err.response = fakeResponse(status, body, headers);
  return err;
}

/**
 * Fake SDK platform. `handler(path, query, callNo)` returns a fakeResponse or throws.
 */
export function fakePlatform(handler) {
  const p = {
    logins: 0,
    calls: [],
    login: async () => {
      p.logins += 1;
    },
    get: async (path, query) => {
      p.calls.push({ path, query });
      return handler(path, query, p.calls.length);
    },
    auth: () => ({ data: async () => ({ scope: 'ReadAccounts ReadCallLog ReadMessages' }) }),
  };
  return p;
}

export function baseConfig(overrides = {}) {
  return {
    rc: { callLogPageSize: 1000, messagePageSize: 250, includeDeletedCalls: true },
    google: { sheetName: 'RING CENTRAL' },
    report: {
      timezone: 'America/Chicago',
      startDate: '2026-10-01',
      reconcileDays: 3,
      callLogBufferMinutes: 120,
      unknownResultPolicy: 'fail',
      hrConcurrency: 2,
      sheetsBatchSize: 200,
      ...(overrides.report || {}),
    },
    schedule: { lockWaitMs: 0 },
    state: { dbPath: ':memory:' },
    logLevel: 'error',
  };
}

export const HR_A = { extensionId: '62000000001', name: 'Alice HR', phoneNumber: '+13125550101', reportStartDate: '2026-10-01', reportEndDate: null };
export const HR_B = { extensionId: '62000000002', name: 'Bob HR', phoneNumber: '+13125550102', reportStartDate: '2026-10-01', reportEndDate: null };

let seq = 0;
/** Call log record builder. */
export function call({ id, sessionId, telephonySessionId, start, direction = 'Inbound', result = 'Accepted', action = 'Phone Call', type = 'Voice' } = {}) {
  seq += 1;
  return {
    id: id ?? `rec-${seq}`,
    sessionId: sessionId ?? `sess-${seq}`,
    telephonySessionId: telephonySessionId ?? `tel-${seq}`,
    startTime: start,
    direction,
    result,
    action,
    type,
    duration: 10,
  };
}

/** Message-store record builder. */
export function sms({ id, created, status = 'Delivered', direction = 'Outbound', type = 'SMS', to } = {}) {
  seq += 1;
  return { id: id ?? 900000 + seq, type, direction, messageStatus: status, creationTime: created, to: to ?? [{ phoneNumber: '+13125559999' }] };
}

/**
 * Data source backed by in-memory arrays, filtering by the requested time window
 * like the API does. `fail` maps extensionId -> Error to throw.
 */
export class FakeDataSource {
  constructor({ calls = {}, messages = {}, fail = {} } = {}) {
    this.calls = calls;
    this.messages = messages;
    this.fail = fail;
    this.requests = [];
  }

  async fetchCallLog(extensionId, fromUtc, toUtc) {
    this.requests.push({ kind: 'calls', extensionId, fromUtc, toUtc });
    if (this.fail[extensionId]) throw this.fail[extensionId];
    const from = Date.parse(fromUtc);
    const to = Date.parse(toUtc);
    return (this.calls[extensionId] || []).filter((r) => Date.parse(r.startTime) >= from && Date.parse(r.startTime) <= to);
  }

  async fetchOutboundSms(extensionId, fromUtc, toUtc) {
    this.requests.push({ kind: 'sms', extensionId, fromUtc, toUtc });
    if (this.fail[extensionId]) throw this.fail[extensionId];
    const from = Date.parse(fromUtc);
    const to = Date.parse(toUtc);
    return (this.messages[extensionId] || []).filter((m) => Date.parse(m.creationTime) >= from && Date.parse(m.creationTime) <= to);
  }
}
