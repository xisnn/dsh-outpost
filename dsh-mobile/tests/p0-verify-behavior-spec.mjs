/**
 * Behavior test for the Debug-only P0 confirmation isolation.
 * Uses the real Store + PendingSendStore with in-memory persistence and a mock
 * session/prompt; no production code is bypassed.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.__DEV__ = true;

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.join(__dirname, 'support');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(SHIM_DIR, '_async-storage-shim.cjs');
  }
  if (request === '@react-native-cookies/cookies') {
    return path.join(SHIM_DIR, '_cookie-manager-shim.cjs');
  }
  if (request === 'react-native-keychain') {
    return path.join(SHIM_DIR, '_keychain-shim.cjs');
  }
  if (request === 'react-native') {
    return path.join(SHIM_DIR, '_react-native-shim.cjs');
  }
  if (request === 'react-native-blob-util') {
    return path.join(SHIM_DIR, '_blob-util-shim.cjs');
  }
  return origResolve.call(this, request, parent, ...rest);
};
const imp = (p) => import(pathToFileURL(p).href);
const { DshConnection } = await imp(path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'));
const { Store } = await imp(path.join(__dirname, '..', 'src', 'core', 'store.ts'));
const { PendingSendStore } = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'store.ts'));
const {
  clearP0TestState,
  isP0ConfirmationBlocked,
  shouldDropP0Response,
} = await imp(path.join(__dirname, '..', 'src', 'dev', 'p0Verify.ts'));

const binding = {
  baseUrl: 'http://127.0.0.1:1',
  gatewayId: 'gateway-A',
  authContextHash: 'a'.repeat(64),
  identityQuality: 'confirmed',
};

class MemoryPersistence {
  constructor() { this.value = undefined; }
  async readRaw() { return this.value; }
  async writeRaw(value) { this.value = value; }
  async clear() { this.value = undefined; }
}

let seq = 0;
function makeHarness() {
  const pending = new PendingSendStore({
    persistence: new MemoryPersistence(),
    now: () => 1_800_000_000_000,
    idFactory: () => `req-p0-${++seq}`,
  });
  const prompts = [];
  let verify = async () => undefined;
  const store = new Store(
    new DshConnection({ baseUrl: 'http://127.0.0.1:1', cookie: 'dsh-auth-test=v1' }),
    {
      pendingSendStore: pending,
      loadPendingBinding: async () => binding,
      verifyPendingBinding: () => verify(),
    },
  );
  store.api.prompt = async (params) => { prompts.push(params); };
  return {
    pending,
    prompts,
    store,
    setVerify(fn) { verify = fn; },
  };
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  OK    ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL  ${name} — ${e?.message ?? e}`); }
}

await check('首次发送进入 unknown；重试同 requestId 不再注入，最终 confirmed 并清理', async () => {
  clearP0TestState();
  const h = makeHarness();
  await h.pending.hydrate();
  const first = await h.store.sendPending('s1', '[P0_BLOCK] task A');
  assert.equal(first.state, 'unknown');
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].requestId, first.requestId);
  assert.equal(isP0ConfirmationBlocked(first.requestId), true);
  assert.equal(shouldDropP0Response(first.requestId), false);
  const retried = await h.store.retryPending('s1', first.requestId);
  assert.equal(retried.requestId, first.requestId);
  assert.equal(h.prompts.length, 2);
  assert.equal(h.prompts[1].requestId, first.requestId);
  assert.equal(isP0ConfirmationBlocked(first.requestId), false);
  await h.pending.apply(first.requestId, { type: 'confirm' });
  await h.pending.prune();
  assert.equal((await h.pending.list()).length, 0);
});

await check('身份验证失败时保持 unknown 和隔离，不提前解除', async () => {
  clearP0TestState();
  const h = makeHarness();
  await h.pending.hydrate();
  const first = await h.store.sendPending('s1', '[P0_BLOCK] identity fail');
  assert.equal(first.state, 'unknown');
  assert.equal(isP0ConfirmationBlocked(first.requestId), true);
  h.setVerify(async () => { throw new Error('identity unavailable'); });
  await assert.rejects(() => h.store.retryPending('s1', first.requestId), /identity unavailable/);
  assert.equal(isP0ConfirmationBlocked(first.requestId), true);
  assert.equal((await h.pending.get(first.requestId)).state, 'unknown');
});

await check('确认事件在重试前到达也被隔离；重试后恢复并被 confirmed 清理', async () => {
  clearP0TestState();
  const h = makeHarness();
  await h.pending.hydrate();
  const first = await h.store.sendPending('s1', '[P0_BLOCK] early event');
  assert.equal(first.state, 'unknown');
  // Simulate a session/follow snapshot already containing the server event.
  h.store.streams.set('s1', {
    records: new Map([
      [1, { event: { type: 'user/message', data: { source: { kind: 'user', rpcId: first.requestId } } } }],
    ]),
  });
  await h.store.reconcilePendingNow('s1');
  assert.equal((await h.pending.get(first.requestId)).state, 'unknown');
  const retried = await h.store.retryPending('s1', first.requestId);
  assert.equal(retried.requestId, first.requestId);
  assert.equal((await h.pending.get(first.requestId)).state, 'confirmed');
  await h.pending.prune();
  assert.equal((await h.pending.list()).length, 0);
});

await check('其他 requestId 不受影响', async () => {
  clearP0TestState();
  const h = makeHarness();
  await h.pending.hydrate();
  const a = await h.store.sendPending('s1', '[P0_BLOCK] blocked');
  const b = await h.store.sendPending('s1', 'normal');
  assert.equal(a.state, 'unknown');
  assert.equal(b.state, 'accepted');
  assert.equal(isP0ConfirmationBlocked(a.requestId), true);
  assert.equal(isP0ConfirmationBlocked(b.requestId), false);
});

console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exitCode = 1;
