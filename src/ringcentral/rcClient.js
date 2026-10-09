// Thin wrapper around the official @ringcentral/sdk Platform:
//  * JWT login (and one re-login on a persistent 401)
//  * bounded concurrency + per throttling-group pacing based on X-Rate-Limit-* headers
//  * 429: honours Retry-After (falls back to X-Rate-Limit-Window, then 60s)
//  * network / transient 5xx: bounded exponential backoff
//  * 400/403/404 and repeated 401: no retry
//  * complete pagination

import { SDK } from '@ringcentral/sdk';
import { RcApiError } from './errors.js';
import { Semaphore, backoffDelay, sleep as realSleep } from '../util/async.js';

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

export function createPlatform(rcConfig) {
  const sdk = new SDK({
    server: rcConfig.serverUrl,
    clientId: rcConfig.clientId,
    clientSecret: rcConfig.clientSecret,
    appName: 'rc-hr-daily-report',
    appVersion: '1.0.0',
  });
  return sdk.platform();
}

async function readErrorBody(response) {
  try {
    const body = await response.clone().json();
    const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
    return {
      errorCode: body?.errorCode || first?.errorCode || body?.error || '',
      message: body?.message || first?.message || body?.error_description || '',
    };
  } catch {
    return { errorCode: '', message: '' };
  }
}

function headerNumber(headers, name) {
  const raw = headers?.get?.(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export class RcClient {
  /**
   * @param {object} p
   * @param {object} p.platform SDK platform (or a compatible fake in tests)
   * @param {string} p.jwt
   */
  constructor({ platform, jwt, logger, maxConcurrency = 2, maxRetries = 5, requestTimeoutMs = 60000, sleep = realSleep, now = () => Date.now(), random = Math.random }) {
    this.platform = platform;
    this.jwt = jwt;
    this.logger = logger;
    this.maxRetries = maxRetries;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sleep = sleep;
    this.now = now;
    this.random = random;
    this.semaphore = new Semaphore(maxConcurrency);
    this.groups = new Map(); // throttling group -> { blockedUntil }
    this.loginPromise = null;
    this.loggedIn = false;
  }

  async login({ force = false } = {}) {
    if (this.loggedIn && !force) return;
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        try {
          await this.platform.login({ jwt: this.jwt });
          this.loggedIn = true;
          this.logger?.debug('RingCentral login succeeded');
        } catch (err) {
          const status = err?.response?.status ?? null;
          const body = err?.response ? await readErrorBody(err.response) : { errorCode: '', message: '' };
          throw new RcApiError({
            status: status ?? null,
            errorCode: body.errorCode,
            message: `RingCentral JWT login failed${status ? ` (HTTP ${status})` : ''}${body.message ? `: ${body.message}` : ''}`,
            endpoint: 'auth',
          });
        } finally {
          this.loginPromise = null;
        }
      })();
    }
    await this.loginPromise;
  }

  /** Scopes granted to the current token, if the SDK exposes them. */
  async grantedScopes() {
    await this.login();
    try {
      const data = await this.platform.auth().data();
      return String(data?.scope || '').split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  groupState(group) {
    if (!this.groups.has(group)) this.groups.set(group, { blockedUntil: 0 });
    return this.groups.get(group);
  }

  async waitForGroup(group) {
    const state = this.groupState(group);
    const wait = state.blockedUntil - this.now();
    if (wait > 0) {
      this.logger?.debug('Waiting for RingCentral rate-limit window', { group, waitMs: wait });
      await this.sleep(wait);
    }
  }

  updateGroupFromHeaders(group, headers) {
    const remaining = headerNumber(headers, 'x-rate-limit-remaining');
    const windowSec = headerNumber(headers, 'x-rate-limit-window');
    if (remaining !== null && remaining <= 0) {
      const state = this.groupState(group);
      state.blockedUntil = Math.max(state.blockedUntil, this.now() + (windowSec ?? 60) * 1000);
    }
  }

  async withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`request timed out after ${this.requestTimeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        reject(err);
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET returning parsed JSON.
   * @param {string} path
   * @param {object} query
   * @param {{group?:string, endpoint?:string, extensionId?:string}} meta
   */
  async get(path, query = {}, meta = {}) {
    const { group = 'Medium', endpoint = path, extensionId = '' } = meta;
    await this.login();
    let attempt = 0;
    let reloggedIn = false;

    for (;;) {
      attempt += 1;
      await this.waitForGroup(group);
      let response;
      try {
        response = await this.semaphore.run(() => this.withTimeout(this.platform.get(path, query)));
        this.updateGroupFromHeaders(group, response.headers);
        return await response.json();
      } catch (err) {
        const res = err?.response;
        const status = res?.status ?? null;
        if (res) this.updateGroupFromHeaders(group, res.headers);

        if (status === null) {
          if (attempt > this.maxRetries) {
            throw new RcApiError({ status: null, message: `Network error calling ${endpoint}: ${err?.code || err?.message}`, endpoint, extensionId });
          }
          const delay = backoffDelay(attempt, { random: this.random });
          this.logger?.warn('RingCentral network error, retrying', { endpoint, extensionId, attempt, delayMs: delay, errorCode: err?.code || 'NETWORK' });
          await this.sleep(delay);
          continue;
        }

        const body = await readErrorBody(res);

        if (status === 429) {
          if (attempt > this.maxRetries) {
            throw new RcApiError({ status, errorCode: body.errorCode, message: `Rate limit still exceeded for ${endpoint} after ${attempt - 1} retries`, endpoint, extensionId });
          }
          const retryAfter = headerNumber(res.headers, 'retry-after') ?? headerNumber(res.headers, 'x-rate-limit-window') ?? 60;
          const delay = Math.max(1, retryAfter) * 1000;
          const state = this.groupState(group);
          state.blockedUntil = Math.max(state.blockedUntil, this.now() + delay);
          this.logger?.warn('RingCentral rate limit hit (429), waiting', { endpoint, extensionId, group, attempt, delayMs: delay });
          await this.sleep(delay);
          continue;
        }

        if (TRANSIENT_STATUSES.has(status)) {
          if (attempt > this.maxRetries) {
            throw new RcApiError({ status, errorCode: body.errorCode, message: `RingCentral ${endpoint} failed with HTTP ${status} after ${attempt - 1} retries`, endpoint, extensionId });
          }
          const delay = backoffDelay(attempt, { random: this.random });
          this.logger?.warn('RingCentral transient error, retrying', { endpoint, extensionId, status, attempt, delayMs: delay });
          await this.sleep(delay);
          continue;
        }

        if (status === 401 && !reloggedIn) {
          // The SDK already retried once with a refreshed token; fall back to a fresh JWT login once.
          reloggedIn = true;
          this.logger?.warn('RingCentral returned 401, re-authenticating with JWT once', { endpoint, extensionId });
          this.loggedIn = false;
          await this.login({ force: true });
          continue;
        }

        throw new RcApiError({
          status,
          errorCode: body.errorCode,
          message: `RingCentral ${endpoint} returned HTTP ${status}${body.errorCode ? ` ${body.errorCode}` : ''}${body.message ? `: ${body.message}` : ''}`,
          endpoint,
          extensionId,
        });
      }
    }
  }

  /**
   * Loads every page. Follows navigation.nextPage / paging.totalPages; when neither
   * is present but a page came back full, probes the next page so a missing
   * navigation block can never truncate the data set.
   */
  async getAllPages(path, query = {}, { perPage = 100, maxPages = 1000, ...meta } = {}) {
    const all = [];
    for (let page = 1; ; page += 1) {
      if (page > maxPages) {
        throw new RcApiError({ status: null, message: `Pagination limit (${maxPages} pages) exceeded for ${meta.endpoint || path}`, endpoint: meta.endpoint, extensionId: meta.extensionId });
      }
      const body = await this.get(path, { ...query, page, perPage }, meta);
      const records = Array.isArray(body?.records) ? body.records : [];
      all.push(...records);
      const hasNext = Boolean(body?.navigation?.nextPage?.uri || body?.navigation?.nextPage);
      const totalPages = body?.paging?.totalPages;
      if (hasNext) continue;
      if (Number.isInteger(totalPages) && page < totalPages) continue;
      if (totalPages === undefined && records.length >= perPage) continue;
      break;
    }
    return all;
  }
}
