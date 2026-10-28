/**
 * PendingSendStore 测试（内存 persistence，不依赖原生 Keystore）。
 *
 * 重点守：
 *   · 正常新发送永远生成新 requestId（连续两次完全相同文本也必须不同）
 *   · 只有用户显式 retry 才复用旧 requestId
 *   · 所有写入串行化，并发 create 不丢记录
 *   · 写失败/回读不一致不改变内存状态，也不产生新 ID
 *   · 重启恢复不自动重发，retry 前做服务实例/授权上下文绑定校验
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

const { PendingSendStore, PendingSendStoreError, PendingSendBindingError } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'store.ts'),
);
const { createRequestId } = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'ids.ts'));

class MemoryPersistence {
  constructor() {
    this.value = undefined;
    this.writes = 0;
    this.failWrites = 0;
    this.failReads = 0;
    this.mismatchAfterWrite = false;
    this.writeDelay = 0;
  }
  async readRaw() {
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('read failed');
    }
    if (this.mismatchAfterWrite) return '{"schema":1,"revision":999,"records":[]}';
    return this.value;
  }
  async writeRaw(value) {
    if (this.writeDelay > 0) await new Promise((r) => setTimeout(r, this.writeDelay));
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error('write failed');
    }
    this.writes += 1;
    this.value = value;
  }
  async clear() {
    this.value = undefined;
  }
}

const CLOCK0 = 1_800_000_000_000;
let clock = CLOCK0;
let idSeq = 0;
const now = () => clock;
const idFactory = () => {
  idSeq += 1;
  return `req-test-${idSeq}`;
};
const bindingA = {
  baseUrl: 'http://127.0.0.1:3095',
  gatewayId: 'gateway-A',
  authContextHash: 'a'.repeat(64),
  identityQuality: 'confirmed',
};
const bindingB = { ...bindingA, gatewayId: 'gateway-B' };

function makeStore(backend, extra = {}) {
  return new PendingSendStore({
    persistence: backend,
    now,
    idFactory,
    ...extra,
  });
}

function input(over = {}) {
  return {
    sessionId: 'session-1',
    mode: 'queue',
    text: 'hello',
    attachments: [],
    binding: bindingA,
    ...over,
  };
}

async function hydrated(extra = {}) {
  const backend = new MemoryPersistence();
  const store = makeStore(backend, extra);
  await store.hydrate();
  return { backend, store };
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

await check('连续两次发送完全相同文本 → 生成两个不同 requestId（禁止指纹自动复用）', async () => {
  clock = CLOCK0;
  const { store } = await hydrated({ limits: { maxRecords: 20 } });
  const first = await store.create(input({ text: 'same text' }));
  const second = await store.create(input({ text: 'same text' }));
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(first.fingerprint, second.fingerprint);
  const records = await store.list();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.state),
    ['queued', 'queued'],
  );
});

await check('用户显式 retry 复用旧 requestId；之后再正常发送仍用新 ID', async () => {
  clock = CLOCK0;
  const { store } = await hydrated();
  const created = await store.create(input({ text: 'dangerous' }));
  await store.apply(created.requestId, { type: 'begin-preparing' });
  await store.apply(created.requestId, { type: 'attachments-ready' });
  await store.apply(created.requestId, { type: 'begin-send' });
  await store.apply(created.requestId, {
    type: 'unknown-failure',
    code: 'timeout',
    message: '请求超时',
  });
  const retried = await store.retry(created.requestId, bindingA);
  assert.equal(retried.requestId, created.requestId);
  assert.equal(retried.state, 'preparing');
  assert.equal(retried.attemptCount, 1);
  const next = await store.create(input({ text: 'dangerous' }));
  assert.notEqual(next.requestId, created.requestId);
});

await check('写失败：不生成新记录，内存不改变', async () => {
  clock = CLOCK0;
  const { backend, store } = await hydrated();
  backend.failWrites = 1;
  await assert.rejects(
    () => store.create(input()),
    (e) => e instanceof PendingSendStoreError && e.code === 'write-failed',
  );
  assert.equal((await store.list()).length, 0);
  assert.equal(backend.value, undefined);
});

await check('写后回读不一致：拒绝并保持内存为空', async () => {
  clock = CLOCK0;
  const { backend, store } = await hydrated();
  backend.mismatchAfterWrite = true;
  await assert.rejects(
    () => store.create(input()),
    (e) => e instanceof PendingSendStoreError && e.code === 'read-back-mismatch',
  );
  assert.equal((await store.list()).length, 0);
});

await check('确认状态写入失败：保持 accepted，不改变 requestId', async () => {
  clock = CLOCK0;
  const { backend, store } = await hydrated();
  const r = await store.create(input());
  await store.apply(r.requestId, { type: 'begin-preparing' });
  await store.apply(r.requestId, { type: 'attachments-ready' });
  await store.apply(r.requestId, { type: 'begin-send' });
  await store.apply(r.requestId, { type: 'accept' });
  const idBefore = r.requestId;
  backend.failWrites = 1;
  await assert.rejects(
    () => store.apply(idBefore, { type: 'confirm' }),
    (e) => e instanceof PendingSendStoreError && e.code === 'write-failed',
  );
  const after = await store.get(idBefore);
  assert.equal(after.state, 'accepted');
  assert.equal(after.requestId, idBefore);
});

await check('并发 create 40 条：串行化后全部保留', async () => {
  clock = CLOCK0;
  const { backend, store } = await hydrated({ limits: { maxRecords: 50 } });
  const records = await Promise.all(
    Array.from({ length: 40 }, (_, i) => store.create(input({ text: `text-${i}` }))),
  );
  assert.equal(new Set(records.map((r) => r.requestId)).size, 40);
  assert.equal((await store.list()).length, 40);
  assert.equal(backend.writes, 40);
});

await check('容量上限：超过 maxRecords 拒绝，旧记录保留', async () => {
  clock = CLOCK0;
  const { store } = await hydrated({ limits: { maxRecords: 2 } });
  await store.create(input({ text: 'one' }));
  await store.create(input({ text: 'two' }));
  await assert.rejects(
    () => store.create(input({ text: 'three' })),
    (e) => e instanceof PendingSendStoreError && e.code === 'limit-exceeded',
  );
  assert.equal((await store.list()).length, 2);
});

await check('文档大小上限：拒绝超大文档', async () => {
  clock = CLOCK0;
  const { store } = await hydrated({ limits: { maxDocumentBytes: 300 } });
  await assert.rejects(
    () => store.create(input({ text: 'x'.repeat(1000) })),
    (e) => e instanceof PendingSendStoreError && e.code === 'document-too-large',
  );
  assert.equal((await store.list()).length, 0);
});

await check('过期提示：未决记录到期后先标记 expired 并保留提示', async () => {
  clock = CLOCK0;
  const { store } = await hydrated();
  await store.create(input({ text: 'old', expiresAt: clock + 1000 }));
  clock += 2000;
  const affected = await store.prune();
  assert.equal(affected.length, 1);
  const afterExpire = await store.list();
  assert.equal(afterExpire.length, 1);
  assert.equal(afterExpire[0].state, 'expired');
  assert.equal(afterExpire[0].expiredFrom, 'queued');
  // 超过过期提示保留期后真正删除
  clock += 2 * 60 * 60 * 1000;
  const removed = await store.prune();
  assert.equal(removed.length, 1);
  assert.equal((await store.list()).length, 0);
});

await check('过期保留原状态：unknown 不能被显示成未发送', async () => {
  clock = CLOCK0;
  const { store } = await hydrated();
  const r = await store.create(input({ text: 'unknown-expire', expiresAt: clock + 1000 }));
  await store.apply(r.requestId, { type: 'begin-preparing' });
  await store.apply(r.requestId, { type: 'attachments-ready' });
  await store.apply(r.requestId, { type: 'begin-send' });
  await store.apply(r.requestId, { type: 'unknown-failure', code: 'timeout' });
  clock += 2000;
  await store.prune();
  const expired = await store.get(r.requestId);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.expiredFrom, 'unknown');
});

await check('过期保留原状态：accepted 不能被显示成未发送', async () => {
  clock = CLOCK0;
  const { store } = await hydrated({ acceptedTtlMs: 1000 });
  const r = await store.create(input({ text: 'accepted-expire' }));
  await store.apply(r.requestId, { type: 'begin-preparing' });
  await store.apply(r.requestId, { type: 'attachments-ready' });
  await store.apply(r.requestId, { type: 'begin-send' });
  await store.apply(r.requestId, { type: 'accept' });
  clock += 2000;
  await store.prune();
  const expired = await store.get(r.requestId);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.expiredFrom, 'accepted');
});

await check('重启恢复：sending→unknown，用户 retry 仍用旧 requestId', async () => {
  clock = CLOCK0;
  const { backend, store } = await hydrated();
  const r = await store.create(input({ text: 'restart-me' }));
  await store.apply(r.requestId, { type: 'begin-preparing' });
  await store.apply(r.requestId, { type: 'attachments-ready' });
  await store.apply(r.requestId, { type: 'begin-send' });
  // 模拟进程被杀：不调用 accept/unknown，直接新建 store 读同一 persistence
  const store2 = makeStore(backend);
  const result = await store2.hydrate();
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].from, 'sending');
  assert.equal(result.recovered[0].to, 'unknown');
  const recovered = await store2.get(r.requestId);
  assert.equal(recovered.state, 'unknown');
  const retried = await store2.retry(r.requestId, bindingA);
  assert.equal(retried.requestId, r.requestId);
  assert.equal(retried.state, 'preparing');
});

await check('跨服务端重试被拒绝：gateway 不同 / 地址不同 / 授权上下文不同', async () => {
  clock = CLOCK0;
  const { store } = await hydrated();
  const r = await store.create(input());
  await store.apply(r.requestId, { type: 'begin-preparing' });
  await store.apply(r.requestId, { type: 'attachments-ready' });
  await store.apply(r.requestId, { type: 'begin-send' });
  await store.apply(r.requestId, { type: 'unknown-failure', code: 'timeout' });
  for (const current of [
    bindingB,
    { ...bindingA, baseUrl: 'http://127.0.0.1:3096' },
    { ...bindingA, authContextHash: 'b'.repeat(64) },
    { ...bindingA, gatewayId: null },
  ]) {
    await assert.rejects(
      () => store.retry(r.requestId, current),
      (e) => e instanceof PendingSendBindingError,
    );
  }
  const after = await store.get(r.requestId);
  assert.equal(after.state, 'unknown');
  assert.equal(after.requestId, r.requestId);
});

await check('clearAll 清空文档并保持 revision 单调', async () => {
  clock = CLOCK0;
  const { backend, store } = await hydrated();
  await store.create(input({ text: 'one' }));
  await store.create(input({ text: 'two' }));
  const before = await store.stats();
  await store.clearAll();
  const after = await store.stats();
  assert.equal(after.count, 0);
  assert.equal(after.revision >= before.revision, true);
  assert.equal((await store.list()).length, 0);
  const disk = JSON.parse(backend.value);
  assert.equal(disk.records.length, 0);
});

await check('损坏文档：hydrate 拒绝，不静默覆盖', async () => {
  clock = CLOCK0;
  const backend = new MemoryPersistence();
  backend.value = '{"schema":1,"revision":0,"records":[{"bad":true}]}';
  const store = makeStore(backend);
  await assert.rejects(
    () => store.hydrate(),
    (e) => e instanceof PendingSendStoreError && e.code === 'corrupt-document',
  );
  assert.equal(backend.value.includes('bad'), true);
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
