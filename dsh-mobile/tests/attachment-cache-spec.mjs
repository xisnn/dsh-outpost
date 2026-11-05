// Run with: node --import tsx --test tests/attachment-cache-spec.mjs
// Only fake readAttachment responses; imports and executes the actual cache module.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_CACHE_LIMITS,
  cachedImageUri,
  imageFailed,
  loadImageUri,
} from '../src/core/attachment-cache.ts';

const response = (data = 'aW1hZ2U=') => ({ mediaType: 'image/png', data });
const uriOf = (data = 'aW1hZ2U=') => `data:image/png;base64,${data}`;
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// These tests share the module's bounded cache. Each uses a new API identity;
// capacity tests fill the relevant limit before asserting eviction.
test('successful loads coalesce and automatic loads reuse the scoped cache', async () => {
  const pending = deferred();
  let calls = 0;
  const api = {
    readAttachment(sessionId, attachmentId) {
      calls++;
      assert.deepEqual([sessionId, attachmentId], ['session', 'image']);
      return pending.promise;
    },
  };
  const first = loadImageUri(api, 'session', 'image');
  assert.equal(loadImageUri(api, 'session', 'image'), first);
  assert.equal(loadImageUri(api, 'session', 'image', { retry: true }), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(response());
  assert.equal(await first, uriOf());
  assert.equal(cachedImageUri('session', 'image', api), uriOf());
  assert.equal(await loadImageUri(api, 'session', 'image'), uriOf());
  assert.equal(calls, 1);
});

test('failures are suppressed until explicit retry, which coalesces and clears failure', async () => {
  const pending = deferred();
  let calls = 0;
  const api = {
    readAttachment() {
      calls++;
      return calls === 1 ? Promise.reject(new Error('offline')) : pending.promise;
    },
  };
  assert.equal(await loadImageUri(api, 'session', 'retry'), undefined);
  assert.equal(imageFailed('retry', 'session', api), true);
  for (let i = 0; i < 3; i++) {
    assert.equal(await loadImageUri(api, 'session', 'retry'), undefined);
  }
  assert.equal(calls, 1);
  const retry = loadImageUri(api, 'session', 'retry', { retry: true });
  assert.equal(imageFailed('retry', 'session', api), false);
  assert.equal(loadImageUri(api, 'session', 'retry', { retry: true }), retry);
  assert.equal(loadImageUri(api, 'session', 'retry'), retry);
  pending.resolve(response('bmV3'));
  assert.equal(await retry, uriOf('bmV3'));
  assert.equal(calls, 2);
  assert.equal(imageFailed('retry', 'session', api), false);
  assert.equal(cachedImageUri('session', 'retry', api), uriOf('bmV3'));
});

test('retry bypasses successful entries and a failed refresh never exposes the old URI', async () => {
  const refresh = deferred();
  let calls = 0;
  const api = { readAttachment: () => ++calls === 1 ? Promise.resolve(response()) : refresh.promise };
  await loadImageUri(api, 'session', 'refresh');
  const retry = loadImageUri(api, 'session', 'refresh', { retry: true });
  assert.equal(cachedImageUri('session', 'refresh', api), undefined);
  assert.equal(loadImageUri(api, 'session', 'refresh'), retry);
  refresh.reject(new Error('refresh failed'));
  assert.equal(await retry, undefined);
  assert.equal(cachedImageUri('session', 'refresh', api), undefined);
  assert.equal(imageFailed('refresh', 'session', api), true);
  api.readAttachment = () => { calls++; return Promise.resolve(response('ZnJlc2g=')); };
  assert.equal(await loadImageUri(api, 'session', 'refresh', { retry: true }), uriOf('ZnJlc2g='));
  assert.equal(calls, 3);
});

test('synchronous API throws become cached failures and release pending state', async () => {
  let calls = 0;
  const api = {
    readAttachment() {
      calls++;
      if (calls <= 2) throw new Error('synchronous failure');
      return Promise.resolve(response());
    },
  };
  let first;
  assert.doesNotThrow(() => { first = loadImageUri(api, 'session', 'sync'); });
  assert.equal(loadImageUri(api, 'session', 'sync'), first);
  assert.equal(await first, undefined);
  assert.equal(await loadImageUri(api, 'session', 'sync'), undefined);
  assert.equal(calls, 1);
  assert.equal(await loadImageUri(api, 'session', 'sync', { retry: true }), undefined);
  assert.equal(calls, 2);
  assert.equal(await loadImageUri(api, 'session', 'sync', { retry: true }), uriOf());
  assert.equal(calls, 3);
});

test('API object identity isolates pending results even with identical connection properties', async () => {
  const slow = deferred();
  const calls = [];
  function readAttachment(session, id) {
    calls.push([this, session, id]);
    return this === apiA ? slow.promise : Promise.resolve(response('Qg=='));
  }
  const apiA = { baseUrl: 'same-url', readAttachment };
  const apiB = { baseUrl: 'same-url', readAttachment };
  const old = loadImageUri(apiA, 'same-session', 'same-id');
  assert.equal(await loadImageUri(apiB, 'same-session', 'same-id'), uriOf('Qg=='));
  assert.equal(cachedImageUri('same-session', 'same-id', apiA), undefined);
  slow.resolve(response('QQ=='));
  assert.equal(await old, uriOf('QQ=='));
  assert.equal(cachedImageUri('same-session', 'same-id', apiA), uriOf('QQ=='));
  assert.equal(cachedImageUri('same-session', 'same-id', apiB), uriOf('Qg=='));
  assert.equal(calls.length, 2);
  assert.equal(cachedImageUri('same-session', 'same-id'), undefined);
});

test('failures and retries are isolated by API and legacy lookup fails closed', async () => {
  let callsA = 0;
  const apiA = { readAttachment: () => { callsA++; return Promise.reject(new Error('offline')); } };
  const apiB = { readAttachment: async () => response('Qg==') };
  await loadImageUri(apiA, 'session', 'image');
  assert.equal(imageFailed('image', 'session', apiA), true);
  assert.equal(imageFailed('image', 'session', apiB), false);
  assert.equal(imageFailed('image', 'session'), false);
  assert.equal(await loadImageUri(apiB, 'session', 'image'), uriOf('Qg=='));
  await loadImageUri(apiB, 'session', 'image', { retry: true });
  assert.equal(imageFailed('image', 'session', apiA), true);
  assert.equal(await loadImageUri(apiA, 'session', 'image'), undefined);
  assert.equal(callsA, 1);
});

test('session and attachment IDs cannot collide through delimiter characters', async () => {
  const api = { readAttachment: async (session) => response(session) };
  const first = await loadImageUri(api, 'a|b', 'c');
  const second = await loadImageUri(api, 'a', 'b|c');
  assert.notEqual(first, second);
  assert.equal(cachedImageUri('a|b', 'c', api), first);
  assert.equal(cachedImageUri('a', 'b|c', api), second);
});

test('entry limit evicts LRU successes and both synchronous and automatic hits update recency', async () => {
  let calls = 0;
  const api = { readAttachment: async () => { calls++; return response(); } };
  const { maxEntries } = IMAGE_CACHE_LIMITS;
  for (let i = 0; i < maxEntries; i++) await loadImageUri(api, 'count', String(i));
  assert.equal(cachedImageUri('count', '0', api), uriOf());
  await loadImageUri(api, 'count', '1');
  await loadImageUri(api, 'count', String(maxEntries));
  assert.equal(cachedImageUri('count', '2', api), undefined);
  assert.equal(cachedImageUri('count', '0', api), uriOf());
  assert.equal(cachedImageUri('count', '1', api), uriOf());
  assert.equal(calls, maxEntries + 1);
  assert.equal(await loadImageUri(api, 'count', '2'), uriOf());
  assert.equal(calls, maxEntries + 2);
  assert.equal(imageFailed('2', 'count', api), false);
});

test('byte limit evicts successes below the entry limit and retry releases previous byte weight', async () => {
  const large = 'A'.repeat(5 * 1024 * 1024); // Just over 10 MiB per data URI in UTF-16.
  let small = false;
  const api = { readAttachment: async () => response(small ? 'c21hbGw=' : large) };
  for (const id of ['first', 'second', 'third']) await loadImageUri(api, 'bytes', id);
  assert.equal(cachedImageUri('bytes', 'first', api), undefined);
  assert.equal(cachedImageUri('bytes', 'second', api), uriOf(large));
  assert.equal(cachedImageUri('bytes', 'third', api), uriOf(large));
  small = true;
  await loadImageUri(api, 'bytes', 'second', { retry: true });
  small = false;
  await loadImageUri(api, 'bytes', 'fourth');
  assert.equal(cachedImageUri('bytes', 'third', api), uriOf(large));
  assert.equal(cachedImageUri('bytes', 'second', api), uriOf('c21hbGw='));
});

test('byte accounting includes the URI prefix and retains an exactly budget-sized result', async () => {
  const data = 'A'.repeat(IMAGE_CACHE_LIMITS.maxBytes / 2 - uriOf('').length);
  const api = { readAttachment: async (_session, id) => response(id === 'exact' ? data : 'YQ==') };
  const exact = await loadImageUri(api, 'boundary', 'exact');
  assert.equal(exact.length * 2, IMAGE_CACHE_LIMITS.maxBytes);
  assert.equal(cachedImageUri('boundary', 'exact', api), exact);
  await loadImageUri(api, 'boundary', 'extra');
  assert.equal(cachedImageUri('boundary', 'exact', api), undefined);
});

test('oversized successes are returned and coalesced without retention or evicting useful entries', async () => {
  const data = 'A'.repeat(IMAGE_CACHE_LIMITS.maxBytes / 2 - uriOf('').length + 1);
  const pending = deferred();
  let calls = 0;
  const api = {
    readAttachment: (_session, id) => {
      calls++;
      return id === 'small' ? Promise.resolve(response()) : pending.promise;
    },
  };
  await loadImageUri(api, 'oversize', 'small');
  const first = loadImageUri(api, 'oversize', 'large');
  assert.equal(loadImageUri(api, 'oversize', 'large'), first);
  pending.resolve(response(data));
  assert.equal(await first, uriOf(data));
  assert.equal(cachedImageUri('oversize', 'large', api), undefined);
  assert.equal(imageFailed('large', 'oversize', api), false);
  assert.equal(cachedImageUri('oversize', 'small', api), uriOf());
  assert.equal(await loadImageUri(api, 'oversize', 'large'), uriOf(data));
  assert.equal(calls, 3);
});

test('success limits apply globally across API instances', async () => {
  const apis = [];
  for (let i = 0; i <= IMAGE_CACHE_LIMITS.maxEntries; i++) {
    const api = { readAttachment: async () => response() };
    apis.push(api);
    await loadImageUri(api, 'global', 'same');
  }
  assert.equal(cachedImageUri('global', 'same', apis[0]), undefined);
  assert.equal(cachedImageUri('global', 'same', apis.at(-1)), uriOf());
});

test('negative cache is globally bounded and evicted failures can load automatically again', async () => {
  let calls = 0;
  const api = { readAttachment: () => { calls++; return Promise.reject(new Error('missing')); } };
  for (let i = 0; i < IMAGE_CACHE_LIMITS.maxFailures; i++) {
    await loadImageUri(api, 'failures', String(i));
  }
  assert.equal(imageFailed('0', 'failures', api), true);
  const otherApi = { readAttachment: () => Promise.reject(new Error('other API')) };
  await loadImageUri(otherApi, 'failures', 'overflow');
  assert.equal(imageFailed('0', 'failures', api), false);
  assert.equal(imageFailed('1', 'failures', api), true);
  await loadImageUri(api, 'failures', '1');
  assert.equal(calls, IMAGE_CACHE_LIMITS.maxFailures);
  await loadImageUri(api, 'failures', '0');
  assert.equal(calls, IMAGE_CACHE_LIMITS.maxFailures + 1);
  assert.equal(imageFailed('0', 'failures', api), true);
});
