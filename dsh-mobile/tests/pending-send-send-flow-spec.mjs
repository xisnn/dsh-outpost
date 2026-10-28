/**
 * P0-1 阶段 2 发送编排测试（Store.sendPending / retryPending）。
 *
 * 不接真实网络：mock session/prompt；真实 Keychain 由 Android 测试覆盖。
 * 重点守：先持久化再 prompt、正常新发送新 ID、显式重试复用 ID、
 * 发送中 single-flight、accepted 状态写失败不假装未发送。
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const { PendingSendPostAcceptError } = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'errors.ts'));
const { PendingSendStoreError } = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'store.ts'));
const { ensureWebSocket } = await imp(path.join(__dirname, '..', 'tests', 'support', 'ws-compat.mjs'));

ensureWebSocket();
const binding = {
  baseUrl: 'http://127.0.0.1:3095',
  gatewayId: 'gateway-A',
  authContextHash: 'a'.repeat(64),
  identityQuality: 'confirmed',
};

class MemoryPersistence {
  constructor() {
    this.value = undefined;
    this.writes = 0;
    this.failOnWriteNumber = 0;
    this.writeDelay = 0;
  }
  async readRaw() {
    return this.value;
  }
  async writeRaw(value) {
    this.writes += 1;
    if (this.writeDelay > 0) await new Promise((r) => setTimeout(r, this.writeDelay));
    if (this.failOnWriteNumber && this.writes === this.failOnWriteNumber) {
      throw new Error('simulated write failure');
    }
    this.value = value;
  }
  async clear() {
    this.value = undefined;
  }
}

let clock = 1_800_000_000_000;
let seq = 0;
function makeHarness() {
  const backend = new MemoryPersistence();
  const pending = new PendingSendStore({
    persistence: backend,
    now: () => clock,
    idFactory: () => `req-flow-${++seq}`,
  });
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:1',
    cookie: 'dsh-auth-test=v1',
  });
  const prompts = [];
  const store = new Store(conn, {
    pendingSendStore: pending,
    loadPendingBinding: async () => binding,
    // 网络身份验证由 service-binding 专项测试覆盖；这里避免测试访问真实网络。
    verifyPendingBinding: async () => undefined,
  });
  store.api.prompt = async (params) => {
    prompts.push(params);
  };
  return { backend, pending, store, prompts };
}

async function setup() {
  const h = makeHarness();
  await h.pending.hydrate();
  return h;
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  OK    ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL  ' + name + (e?.message ? ' — ' + e.message : ''));
  }
}

await check('sendPending：先持久化再 prompt，accepted 记录可见', async () => {
  const { store, pending, prompts } = await setup();
  const record = await store.sendPending('s1', 'hello');
  assert.equal(record.state, 'accepted');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].requestId, record.requestId);
  const stored = await pending.get(record.requestId);
  assert.equal(stored.state, 'accepted');
  assert.equal(stored.text, 'hello');
});

await check('同文本连续两次新发送：两个不同 requestId，两次 prompt', async () => {
  const { store, prompts } = await setup();
  const a = await store.sendPending('s1', 'same');
  const b = await store.sendPending('s1', 'same');
  assert.notEqual(a.requestId, b.requestId);
  assert.equal(prompts.length, 2);
  assert.notEqual(prompts[0].requestId, prompts[1].requestId);
});

await check('普通发送失败 → unknown；显式 retry 复用旧 ID', async () => {
  const { store, pending, prompts } = await setup();
  let calls = 0;
  store.api.prompt = async (params) => {
    prompts.push(params);
    calls += 1;
    if (calls === 1) throw new Error('Network request failed');
  };
  let failed = false;
  try {
    await store.sendPending('s1', 'retry-me');
  } catch {
    failed = true;
  }
  assert.equal(failed, true);
  const afterFailure = (await pending.list('s1'))[0];
  assert.equal(afterFailure.state, 'unknown');
  const retried = await store.retryPending('s1', afterFailure.requestId);
  assert.equal(retried.requestId, afterFailure.requestId);
  assert.equal(retried.state, 'accepted');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].requestId, prompts[1].requestId);
});

await check('发送前持久化失败：不调用 session/prompt', async () => {
  const { store, backend, prompts } = await setup();
  backend.failOnWriteNumber = 1; // create 第一次写入失败
  await assert.rejects(
    () => store.sendPending('s1', 'blocked'),
    (e) => e instanceof PendingSendStoreError,
  );
  assert.equal(prompts.length, 0);
});

await check('accepted 状态写入失败：保留 requestId，不假装未发送；重启后可 safe retry', async () => {
  const { store, backend, pending, prompts } = await setup();
  // 写入顺序：create=1, begin-preparing=2, attachments-ready=3,
  // begin-send=4, accepted=5。让 accepted 写入失败。
  backend.failOnWriteNumber = 5;
  let error;
  try {
    await store.sendPending('s1', 'accepted-but-local-fail');
  } catch (e) {
    error = e;
  }
  assert.equal(error instanceof PendingSendPostAcceptError, true);
  assert.equal(prompts.length, 1);
  const stillSending = await pending.get(error.requestId);
  assert.equal(stillSending.state, 'sending');

  // 模拟重启：新 store 读同一个 backend；sending -> unknown。
  const pending2 = new PendingSendStore({
    persistence: backend,
    now: () => clock,
    idFactory: () => `req-flow-${++seq}`,
  });
  await pending2.hydrate();
  const recovered = await pending2.get(error.requestId);
  assert.equal(recovered.state, 'unknown');
});

await check('同一未决记录并发 retry：single-flight 只发一次 prompt', async () => {
  const { store, pending, prompts } = await setup();
  let first = true;
  store.api.prompt = async (params) => {
    prompts.push(params);
    if (first) {
      first = false;
      throw new Error('Network request failed');
    }
    await new Promise((r) => setTimeout(r, 30));
  };
  try {
    await store.sendPending('s1', 'single-flight');
  } catch {
    /* 预期第一次失败 */
  }
  const rec = (await pending.list('s1'))[0];
  assert.equal(rec.state, 'unknown');
  const before = prompts.length;
  await Promise.all([store.retryPending('s1', rec.requestId), store.retryPending('s1', rec.requestId)]);
  assert.equal(prompts.length, before + 1);
});

await check('accepted 与 confirmed 分开：只有真实 user/message.rpcId 命中才确认', async () => {
  const { store, pending } = await setup();
  const record = await store.sendPending('s1', 'confirm-me');
  assert.equal(record.state, 'accepted');
  // 模拟会话流里出现真实 user/message（source.rpcId 与 requestId 一致）
  store.streams = new Map([
    [
      's1',
      {
        handle: { close() {} },
        cursor: 1,
        records: new Map([
          [
            1,
            {
              event: {
                seq: 1,
                type: 'user/message',
                data: { source: { kind: 'user', rpcId: record.requestId } },
              },
            },
          ],
        ]),
        snapshot: {},
      },
    ],
  ]);
  await store.reconcilePendingNow('s1');
  const after = await pending.get(record.requestId);
  assert.equal(after.state, 'confirmed');
});

await check('远端身份验证失败：不调用 session/prompt，记录标记失败', async () => {
  const { store, pending, prompts } = await setup();
  store.verifyPendingBinding = async () => {
    throw new Error('remote identity mismatch');
  };
  await assert.rejects(
    () => store.sendPending('s1', 'blocked-by-identity'),
    /remote identity mismatch/,
  );
  assert.equal(prompts.length, 0);
  const records = await pending.list('s1');
  assert.equal(records[0].state, 'failed');
  assert.equal(records[0].lastError.code, 'identity-verification-failed');
});

await check('事件乱序：confirmed 先于 accepted 到达时状态不倒退', async () => {
  const { store, pending } = await setup();
  const rec = await pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: 'out-of-order',
    attachments: [],
    binding,
  });
  await pending.apply(rec.requestId, { type: 'begin-preparing' });
  await pending.apply(rec.requestId, { type: 'attachments-ready' });
  await pending.apply(rec.requestId, { type: 'begin-send' });
  store.streams = new Map([
    [
      's1',
      {
        handle: { close() {} },
        cursor: 1,
        records: new Map([
          [
            1,
            {
              event: {
                seq: 1,
                type: 'user/message',
                data: { source: { kind: 'user', rpcId: rec.requestId } },
              },
            },
          ],
        ]),
        snapshot: {},
      },
    ],
  ]);
  await store.reconcilePendingNow('s1');
  assert.equal((await pending.get(rec.requestId)).state, 'confirmed');
  // 迟到的 accepted 事件必须是 no-op，不能把 confirmed 退回去。
  await pending.apply(rec.requestId, { type: 'accept' });
  assert.equal((await pending.get(rec.requestId)).state, 'confirmed');
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
