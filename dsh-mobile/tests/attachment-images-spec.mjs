// Run: node --test tests/attachment-images-spec.mjs
// Execute the actual hook and cache with controlled React state/effects and fake APIs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function loadSource(path, modules = {}) {
  const source = readFileSync(new URL('../src/' + path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) {
    assert.ok(Object.hasOwn(modules, name), 'Unexpected runtime import: ' + name);
    return modules[name];
  } }, { filename: path });
  return exports;
}

const image = (attachmentId, localUri) => ({ kind: 'image', attachmentId, ...(localUri ? { localUri } : {}) });
const dataUri = data => `data:image/png;base64,${data}`;
const ready = data => ({ phase: 'ready', uri: dataUri(data) });
const loading = { phase: 'loading' };
const failed = { phase: 'failed' };

function fakeApi() {
  const requests = [];
  return {
    requests,
    readAttachment(sessionId, attachmentId) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ sessionId, attachmentId,
        succeed: data => resolve({ mediaType: 'image/png', data }),
        fail: () => reject(new Error('fake attachment failure')),
      });
      return promise;
    },
  };
}

function harness(api, sessionId = 'session', images = [image('one')]) {
  const slots = [], effects = [];
  let cursor = 0, dirty = false, dead = false, result, updates = 0, afterUnmount = 0;
  let props = { api, sessionId, images };
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useState(initial) {
      const i = cursor++;
      const slot = slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      slot.set ??= next => {
        updates++;
        if (dead) { afterUnmount++; return; }
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !equal(slots[i].deps, deps)) {
        effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  react.useCallback = (fn, deps) => react.useMemo(() => fn, deps);
  // Real cache, fresh for each harness. Only React is replaced for the hook.
  const cache = loadSource('core/attachment-cache.ts');
  const { useAttachmentImages } = loadSource('components/useAttachmentImages.ts', {
    react, '../core/attachment-cache': cache,
  });
  const h = {
    get value() { return result; },
    get statuses() { return JSON.parse(JSON.stringify(result.statuses)); },
    get updates() { return updates; },
    get afterUnmount() { return afterUnmount; },
    render(patch = {}) {
      assert.equal(dead, false, 'cannot render after unmount');
      props = { ...props, ...patch };
      let renders = 0;
      do {
        assert.ok(++renders < 20, 'hook must settle without a render loop');
        dirty = false; cursor = 0;
        result = useAttachmentImages(props.api, props.sessionId, props.images);
        while (effects.length) effects.shift()();
      } while (dirty);
      return result;
    },
    async settle() {
      // Drain the real cache promise chain and hook callbacks without timers/networks.
      await new Promise(resolve => setImmediate(resolve));
      if (!dead) h.render();
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
      dead = true;
    },
  };
  h.render();
  return h;
}

test('initial remote image loads and equivalent attachment arrays do not reload', async () => {
  const api = fakeApi(), h = harness(api);
  assert.deepEqual(h.statuses, [loading]);
  await h.settle();
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].sessionId, 'session');
  assert.equal(api.requests[0].attachmentId, 'one');
  api.requests[0].succeed('b25l');
  await h.settle();
  assert.deepEqual(h.statuses, [ready('b25l')]);
  h.render({ images: [image('one')] });
  await h.settle();
  assert.deepEqual(h.statuses, [ready('b25l')]);
  assert.equal(api.requests.length, 1);
  h.unmount();
});

test('local images are immediately ready without an API read', async () => {
  const api = fakeApi(), h = harness(api, 'session', [image('local', 'file:///local.png')]);
  assert.deepEqual(h.statuses, [{ phase: 'ready', uri: 'file:///local.png' }]);
  await h.settle();
  assert.equal(api.requests.length, 0);
  h.unmount();
});

test('failed initial load stays failed until an explicit retry succeeds', async () => {
  const api = fakeApi(), h = harness(api);
  await h.settle();
  api.requests[0].fail();
  await h.settle();
  assert.deepEqual(h.statuses, [failed]);
  h.render({ images: [image('one')] });
  await h.settle();
  assert.equal(api.requests.length, 1);
  h.value.retry(0); h.render();
  assert.deepEqual(h.statuses, [loading]);
  await h.settle();
  assert.equal(api.requests.length, 2);
  api.requests[1].succeed('ZnJlc2g=');
  await h.settle();
  assert.deepEqual(h.statuses, [ready('ZnJlc2g=')]);
  h.unmount();
});

test('decode failure retries fresh bytes and ignores a late decode event for the old URI', async () => {
  const api = fakeApi(), h = harness(api);
  await h.settle();
  api.requests[0].succeed('b2xk');
  await h.settle();
  const oldUri = h.statuses[0].uri;
  h.value.failed(0, oldUri); h.render();
  assert.deepEqual(h.statuses, [failed]);
  h.value.retry(0); h.render();
  assert.deepEqual(h.statuses, [loading]);
  await h.settle();
  assert.equal(api.requests.length, 2, 'retry must bypass the successful byte cache');
  api.requests[1].succeed('bmV3');
  await h.settle();
  assert.deepEqual(h.statuses, [ready('bmV3')]);
  h.value.failed(0, oldUri); h.render();
  assert.deepEqual(h.statuses, [ready('bmV3')]);
  h.unmount();
});

test('decode failure of a local image can recover through a fresh remote read', async () => {
  const api = fakeApi(), h = harness(api, 'session', [image('one', 'file:///broken.png')]);
  h.value.failed(0, 'file:///broken.png'); h.render();
  assert.deepEqual(h.statuses, [failed]);
  h.value.retry(0);
  await h.settle();
  assert.equal(api.requests.length, 1);
  api.requests[0].succeed('cmVtb3Rl');
  await h.settle();
  assert.deepEqual(h.statuses, [ready('cmVtb3Rl')]);
  h.unmount();
});

test('API change discards late results and old retry/decode callbacks cannot alter the new scope', async () => {
  const apiA = fakeApi(), apiB = fakeApi(), h = harness(apiA);
  await h.settle();
  const old = h.value;
  h.render({ api: apiB });
  await h.settle();
  assert.equal(apiB.requests.length, 1);
  apiB.requests[0].succeed('Qg==');
  await h.settle();
  const updates = h.updates;
  apiA.requests[0].succeed('QQ==');
  await h.settle();
  assert.equal(h.updates, updates, 'late old API result must not call setState');
  old.retry(0); old.failed(0, dataUri('Qg==')); h.render();
  assert.deepEqual(h.statuses, [ready('Qg==')]);
  assert.equal(apiA.requests.length, 1);
  h.unmount();
});

test('session change discards a late failure from the previous session', async () => {
  const api = fakeApi(), h = harness(api, 'old-session');
  await h.settle();
  h.render({ sessionId: 'new-session' });
  assert.deepEqual(h.statuses, [loading]);
  await h.settle();
  assert.equal(api.requests[1].sessionId, 'new-session');
  api.requests[1].succeed('bmV3');
  await h.settle();
  const updates = h.updates;
  api.requests[0].fail();
  await h.settle();
  assert.equal(h.updates, updates);
  assert.deepEqual(h.statuses, [ready('bmV3')]);
  h.unmount();
});

test('attachment replacement discards a late result at the same list index', async () => {
  const api = fakeApi(), h = harness(api);
  await h.settle();
  h.render({ images: [image('replacement')] });
  await h.settle();
  assert.equal(api.requests[1].attachmentId, 'replacement');
  api.requests[1].succeed('cmVwbGFjZW1lbnQ=');
  await h.settle();
  const updates = h.updates;
  api.requests[0].succeed('b2xk');
  await h.settle();
  assert.equal(h.updates, updates);
  assert.deepEqual(h.statuses, [ready('cmVwbGFjZW1lbnQ=')]);
  h.unmount();
});

test('list reorder reuses pending requests but assigns each result to its current index', async () => {
  const api = fakeApi(), h = harness(api, 'session', [image('a'), image('b')]);
  await h.settle();
  h.render({ images: [image('b'), image('a')] });
  await h.settle();
  assert.equal(api.requests.length, 2);
  api.requests[0].succeed('YQ==');
  await h.settle();
  assert.deepEqual(h.statuses, [loading, ready('YQ==')]);
  api.requests[1].succeed('Yg==');
  await h.settle();
  assert.deepEqual(h.statuses, [ready('Yg=='), ready('YQ==')]);
  h.unmount();
});

test('removing all attachments discards late results without state updates', async () => {
  const api = fakeApi(), h = harness(api);
  await h.settle();
  h.render({ images: [] });
  const updates = h.updates;
  api.requests[0].succeed('bGF0ZQ==');
  await h.settle();
  assert.equal(h.updates, updates);
  assert.deepEqual(h.statuses, []);
  h.unmount();
});

for (const outcome of ['succeed', 'fail']) {
  test(`unmount prevents updates from ${outcome} and retained callbacks`, async () => {
    const api = fakeApi(), h = harness(api);
    await h.settle();
    const old = h.value;
    h.unmount();
    const updates = h.updates;
    api.requests[0][outcome]('bGF0ZQ==');
    await h.settle();
    old.retry(0); old.failed(0, 'file:///late.png');
    assert.equal(h.updates, updates);
    assert.equal(h.afterUnmount, 0);
    assert.equal(api.requests.length, 1);
  });
}

test('rapid retries before and after renders coalesce until the request settles', async () => {
  const api = fakeApi(), h = harness(api);
  await h.settle();
  // Retry during initial loading joins/suppresses rather than starting another request.
  for (let i = 0; i < 5; i++) h.value.retry(0);
  await h.settle();
  assert.equal(api.requests.length, 1);
  api.requests[0].fail();
  await h.settle();
  for (let i = 0; i < 5; i++) h.value.retry(0);
  h.render();
  assert.deepEqual(h.statuses, [loading]);
  for (let i = 0; i < 5; i++) h.value.retry(0);
  await h.settle();
  assert.equal(api.requests.length, 2);
  api.requests[1].fail();
  await h.settle();
  assert.deepEqual(h.statuses, [failed]);
  h.value.retry(0);
  await h.settle();
  assert.equal(api.requests.length, 3, 'failure releases pending so a later retry works');
  api.requests[2].succeed('b2s=');
  await h.settle();
  assert.deepEqual(h.statuses, [ready('b2s=')]);
  h.unmount();
});

test('retry completion after a scope change cannot replace the new image', async () => {
  const api = fakeApi(), h = harness(api);
  await h.settle();
  api.requests[0].fail();
  await h.settle();
  h.value.retry(0);
  await h.settle();
  h.render({ sessionId: 'next-session' });
  await h.settle();
  api.requests[2].succeed('bmV4dA==');
  await h.settle();
  const updates = h.updates;
  api.requests[1].succeed('bGF0ZS1yZXRyeQ==');
  await h.settle();
  assert.equal(h.updates, updates);
  assert.deepEqual(h.statuses, [ready('bmV4dA==')]);
  h.unmount();
});
