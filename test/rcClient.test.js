import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RcClient } from '../src/ringcentral/rcClient.js';
import { RcApiError } from '../src/ringcentral/errors.js';
import { apiError, fakePlatform, fakeResponse, logger } from './helpers/fakes.js';

function client(platform, extra = {}) {
  const sleeps = [];
  const c = new RcClient({ platform, jwt: 'test-jwt', logger, maxRetries: 3, sleep: async (ms) => sleeps.push(ms), random: () => 0.5, ...extra });
  return { c, sleeps };
}

test('loads every page via navigation.nextPage', async () => {
  const pages = { 1: [1, 2], 2: [3, 4], 3: [5] };
  const platform = fakePlatform((path, q) =>
    fakeResponse(200, { records: pages[q.page].map((id) => ({ id })), navigation: q.page < 3 ? { nextPage: { uri: 'x' } } : {}, paging: { page: q.page, perPage: 2 } }),
  );
  const { c } = client(platform);
  const all = await c.getAllPages('/x', { a: 1 }, { perPage: 2 });
  assert.deepEqual(all.map((r) => r.id), [1, 2, 3, 4, 5]);
  assert.equal(platform.calls.length, 3);
  assert.deepEqual(platform.calls[1].query, { a: 1, page: 2, perPage: 2 });
});

test('full page without navigation is followed by a probe so nothing is truncated', async () => {
  const platform = fakePlatform((path, q) => fakeResponse(200, { records: q.page === 1 ? [{ id: 1 }, { id: 2 }] : q.page === 2 ? [{ id: 3 }] : [], navigation: {}, paging: { page: q.page, perPage: 2 } }));
  const { c } = client(platform);
  const all = await c.getAllPages('/x', {}, { perPage: 2 });
  assert.deepEqual(all.map((r) => r.id), [1, 2, 3]);
});

test('respects paging.totalPages', async () => {
  const platform = fakePlatform((path, q) => fakeResponse(200, { records: [{ id: q.page }], paging: { page: q.page, totalPages: 4, perPage: 1 } }));
  const { c } = client(platform);
  assert.equal((await c.getAllPages('/x', {}, { perPage: 1 })).length, 4);
});

test('429 waits Retry-After seconds and then succeeds', async () => {
  const platform = fakePlatform((path, q, n) => {
    if (n === 1) throw apiError(429, { errorCode: 'CMN-301' }, { 'Retry-After': '7' });
    return fakeResponse(200, { records: [] });
  });
  const { c, sleeps } = client(platform);
  await c.get('/x', {}, { group: 'Heavy' });
  assert.ok(sleeps.includes(7000), `slept ${sleeps}`);
});

test('X-Rate-Limit-Remaining=0 pauses the group for the window before the next request', async () => {
  let now = 0;
  const platform = fakePlatform(() => fakeResponse(200, { records: [] }, { 'X-Rate-Limit-Remaining': '0', 'X-Rate-Limit-Window': '60' }));
  const sleeps = [];
  const c = new RcClient({ platform, jwt: 'j', logger, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  await c.get('/x', {}, { group: 'Heavy' });
  await c.get('/x', {}, { group: 'Heavy' });
  assert.deepEqual(sleeps, [60000]);
});

test('transient 5xx is retried with bounded backoff, then gives up', async () => {
  const platform = fakePlatform(() => {
    throw apiError(503);
  });
  const { c, sleeps } = client(platform);
  await assert.rejects(c.get('/x', {}, { endpoint: 'call-log', extensionId: '1' }), (err) => err instanceof RcApiError && err.status === 503);
  assert.equal(platform.calls.length, 4); // 1 + maxRetries(3)
  assert.equal(sleeps.length, 3);
});

test('network errors are retried', async () => {
  const platform = fakePlatform((p, q, n) => {
    if (n < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return fakeResponse(200, { ok: true });
  });
  const { c } = client(platform);
  assert.deepEqual(await c.get('/x'), { ok: true });
});

test('403 is not retried and carries status, endpoint and extensionId', async () => {
  const platform = fakePlatform(() => {
    throw apiError(403, { errorCode: 'CMN-408', message: 'In order to call this API endpoint, user needs to have [ReadMessages] permission' });
  });
  const { c } = client(platform);
  await assert.rejects(c.get('/x', {}, { endpoint: 'message-store', extensionId: '62000000001' }), (err) => {
    assert.equal(err.status, 403);
    assert.equal(err.errorCode, 'CMN-408');
    assert.equal(err.extensionId, '62000000001');
    assert.equal(err.code, 'RC_403');
    return true;
  });
  assert.equal(platform.calls.length, 1);
});

test('401 triggers exactly one JWT re-login, then fails without looping', async () => {
  const platform = fakePlatform(() => {
    throw apiError(401, { errorCode: 'TokenInvalid' });
  });
  const { c } = client(platform);
  await assert.rejects(c.get('/x'), (err) => err.status === 401);
  assert.equal(platform.logins, 2); // initial + one re-login
  assert.equal(platform.calls.length, 2);
});

test('401 then success after re-login', async () => {
  const platform = fakePlatform((p, q, n) => {
    if (n === 1) throw apiError(401);
    return fakeResponse(200, { fine: 1 });
  });
  const { c } = client(platform);
  assert.deepEqual(await c.get('/x'), { fine: 1 });
});
