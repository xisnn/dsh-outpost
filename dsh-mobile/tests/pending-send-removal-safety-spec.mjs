/** F-05 三项安全边界：真实 Store/PendingSendStore + 内存存储/可控异步暂停，无网络/LLM。 */
import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

register('./support/rn-module-hook.mjs', import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const origResolve = Module._resolveFilename;
const shims = {
  '@react-native-async-storage/async-storage': '_async-storage-shim.cjs',
  '@react-native-cookies/cookies': '_cookie-manager-shim.cjs',
  'react-native-keychain': '_keychain-shim.cjs',
  'react-native': '_react-native-shim.cjs',
  'react-native-blob-util': '_blob-util-shim.cjs',
};
Module._resolveFilename = function (request, parent, ...rest) {
  return shims[request]
    ? path.join(testDir, 'support', shims[request])
    : origResolve.call(this, request, parent, ...rest);
};
const load = (name) => import(pathToFileURL(path.join(testDir, '../src/core', name)).href);
const { PendingSendStore } = await load('pendingSend/store.ts');
const { Store } = await load('store.ts');
const { DshConnection } = await load('transport/index.ts');
const { RpcError } = await load('rpc-error.ts');
const { classifyPromptFailure } = await load('pendingSend/errors.ts');
const { canAbandonPendingSend } = await load('pendingSend/state.ts');
const { pendingSendFailureLabel } = await load('pendingSend/ui.ts');
const { ReactNativePendingSendStaging } = await load('pendingSend/staging.ts');

const binding = {
  baseUrl: 'http://127.0.0.1:1', gatewayId: 'f05-safety',
  authContextHash: 'a'.repeat(64), identityQuality: 'confirmed',
};
let id = 0;
const now = 1800000000000;
class MemoryPersistence {
  raw;
  fail = false;
  async readRaw() { return this.raw; }
  async writeRaw(raw) {
    if (this.fail) throw new Error('disk unavailable');
    this.raw = raw;
  }
}
class MemoryStaging {
  files = new Set();
  removed = [];
  copies = 0;
  failRemoval = false;
  async stage(draft) {
    const stagedUri = `/private/stage-${++this.copies}`;
    this.files.add(stagedUri);
    return {
      kind: draft.kind, name: draft.name, localUri: draft.uri, stagedUri,
      size: 4, contentSha256: 'b'.repeat(64),
    };
  }
  async verify(a) { assert.ok(this.files.has(a.stagedUri), 'missing staged file'); }
  async removeAttachments(attachments) {
    if (attachments.length && this.failRemoval) throw new Error('unlink denied');
    for (const a of attachments) {
      this.files.delete(a.stagedUri);
      this.removed.push(a.stagedUri);
    }
  }
  async cleanupOrphans(references) {
    let removed = 0;
    for (const file of [...this.files]) {
      if (!references.includes(file) && !this.failRemoval) {
        this.files.delete(file);
        removed++;
      }
    }
    return removed;
  }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, bad) => { resolve = ok; reject = bad; });
  return { promise, resolve, reject };
};
function pauseMethod(object, key, shouldPause = () => true) {
  const entered = deferred();
  const release = deferred();
  const original = object[key].bind(object);
  let paused = false;
  object[key] = async (...args) => {
    if (!paused && shouldPause(...args)) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return original(...args);
  };
  return { entered: entered.promise, release: release.resolve, reject: release.reject };
}
async function harness() {
  const persistence = new MemoryPersistence();
  const staging = new MemoryStaging();
  const options = { persistence, staging, now: () => now, idFactory: () => `f05-safety-${++id}` };
  const pending = new PendingSendStore(options);
  await pending.hydrate();
  const store = new Store(new DshConnection({ baseUrl: binding.baseUrl, cookie: 'mock' }), {
    pendingSendStore: pending,
    loadPendingBinding: async () => binding,
    verifyPendingBinding: async () => undefined,
  });
  const prompts = [];
  const uploads = [];
  store.api.prompt = async (p) => { prompts.push(p); };
  store.upload.uploadBinary = async (sessionId, stagedUri, name) => {
    uploads.push(stagedUri);
    return { receiptId: `receipt-${uploads.length}`, file: { attachmentId: 'attachment', name, bytes: 4 } };
  };
  return { persistence, staging, options, pending, store, prompts, uploads };
}
const draft = (name = 'a.txt') => ({ kind: 'file', name, uri: `mem://${name}` });
const create = (h, attachments = [], text = 'test') => h.pending.create({
  sessionId: 's1', mode: 'queue', text, attachments, binding,
});
async function sending(h, rec) {
  await h.pending.apply(rec.requestId, { type: 'begin-preparing' });
  await h.pending.apply(rec.requestId, { type: 'attachments-ready' });
  return h.pending.apply(rec.requestId, { type: 'begin-send' });
}
const rpcError = (kind, raw) => new RpcError({
  endpoint: 'session/prompt', kind, raw, userTitle: 'Mock failure', userHint: '', retryable: false,
});
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`OK ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n${e.stack}`); }
}
async function assertRemoved(h, task, requestId, expectedUploads = 0) {
  const result = await task;
  assert.equal(result.state, 'abandoned');
  assert.equal(result.requestId, requestId);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.uploads.length, expectedUploads);
  assert.equal(h.staging.files.size, 0);
  assert.equal((await h.pending.get(requestId)).state, 'abandoned');
  const reload = new PendingSendStore(h.options);
  await reload.hydrate();
  assert.equal((await reload.get(requestId)).state, 'abandoned');
}

await test('HTTP 500 经真实发送路径归 unknown；旧 failed/http-500 也不可移除或声称未发送', async () => {
  const h = await harness();
  try {
    const error = rpcError('http', 'HTTP 500');
    assert.equal(classifyPromptFailure(error).classification, 'unknown');
    h.store.api.prompt = async (p) => { h.prompts.push(p); throw error; };
    await assert.rejects(h.store.sendPending('s1', 'server may have executed'));
    const [rec] = await h.pending.list();
    assert.equal(rec.state, 'unknown');
    assert.equal(h.prompts.length, 1);
    await assert.rejects(h.pending.abandon(rec.requestId), { code: 'request-not-abandonable' });
    const legacy = await create(h);
    await sending(h, legacy);
    const failed = await h.pending.apply(legacy.requestId, { type: 'definite-failure', code: 'http-500' });
    assert.equal(canAbandonPendingSend(failed), false);
    assert.match(pendingSendFailureLabel(failed), /执行结果未确认/);
  } finally { h.store.close(); }
});

for (const error of [rpcError('rpc', 'internal error'), rpcError('rpc', 'permission-denied'), rpcError('http', 'HTTP 403'), new Error('unexpected server error')]) {
  await test(`begin-send 后失败 ${error.message}：保留记录、原 ID，禁移除并修正文案`, async () => {
    const h = await harness();
    try {
      h.store.api.prompt = async (p) => { h.prompts.push(p); throw error; };
      await assert.rejects(h.store.sendPending('s1', 'failed does not prove unsent'));
      const [rec] = await h.pending.list();
      assert.equal(rec.state, 'failed'); // 保留原 P0-1 分类/迁移契约
      assert.equal(rec.requestId, h.prompts[0].requestId);
      assert.equal(canAbandonPendingSend(rec), false);
      assert.match(pendingSendFailureLabel(rec), /执行结果未确认/);
      await assert.rejects(h.pending.abandon(rec.requestId), { code: 'request-not-abandonable' });
      assert.equal((await h.pending.get(rec.requestId)).state, 'failed');
    } finally { h.store.close(); }
  });
}

await test('首次发送前失败可移除；未知历史的重试 preparing/ready/failed 均不能移除', async () => {
  const h = await harness();
  try {
    const first = await create(h);
    await h.pending.apply(first.requestId, { type: 'begin-preparing' });
    const beforePrompt = await h.pending.apply(first.requestId, { type: 'definite-failure', code: 'attachment-upload-failed' });
    assert.equal(canAbandonPendingSend(beforePrompt), true);
    assert.equal(pendingSendFailureLabel(beforePrompt), '未发出');
    await h.pending.abandon(first.requestId);
    const rec = await create(h);
    await sending(h, rec);
    await h.pending.apply(rec.requestId, { type: 'unknown-failure', code: 'timeout' });
    const preparing = await h.pending.retry(rec.requestId, binding);
    const ready = await h.pending.apply(rec.requestId, { type: 'attachments-ready' });
    const failed = await h.pending.apply(rec.requestId, { type: 'definite-failure', code: 'attachment-invalid' });
    for (const r of [preparing, ready, failed]) {
      assert.equal(r.attemptCount, 1);
      assert.equal(r.requestId, rec.requestId);
      assert.equal(canAbandonPendingSend(r), false);
    }
    await assert.rejects(h.pending.abandon(rec.requestId), { code: 'request-not-abandonable' });
    const reloaded = new PendingSendStore(h.options);
    await reloaded.hydrate();
    assert.equal(canAbandonPendingSend(await reloaded.get(rec.requestId)), false);
    for (const lastError of [undefined, { classification: 'definite', code: 'new-unverified-code' }]) {
      assert.equal(canAbandonPendingSend({ ...beforePrompt, lastError }), false);
    }
  } finally { h.store.close(); }
});

await test('附件清理失败明确报 partial outcome；重启立即补清（不等 1h），共享附件不误删', async () => {
  const h = await harness();
  try {
    const [shared, unique] = await h.pending.stageDrafts([draft('shared'), draft('unique')]);
    const removed = await create(h, [shared, unique]);
    const kept = await create(h, [shared], 'keep');
    h.staging.failRemoval = true;
    await assert.rejects(h.pending.abandon(removed.requestId), (e) => e.code === 'cleanup-failed' && /记录已移除/.test(e.message));
    assert.equal((await h.pending.get(removed.requestId)).state, 'abandoned');
    assert.equal(h.staging.files.size, 2);
    const retryStillFailing = new PendingSendStore(h.options);
    await retryStillFailing.hydrate();
    assert.equal(h.staging.files.size, 2);
    h.staging.failRemoval = false;
    const restart = new PendingSendStore(h.options);
    await restart.hydrate();
    assert.deepEqual([...h.staging.files], [shared.stagedUri]);
    assert.equal((await restart.get(removed.requestId)).state, 'abandoned');
    assert.equal((await restart.get(kept.requestId)).state, 'queued');
    assert.equal(h.staging.removed.includes(shared.stagedUri), false);
  } finally { h.store.close(); }
});

await test('移除写盘失败时不清理附件，原记录/ID 保留', async () => {
  const h = await harness();
  try {
    const a = await h.pending.stageDrafts([draft()]);
    const rec = await create(h, a);
    h.persistence.fail = true;
    await assert.rejects(h.pending.abandon(rec.requestId));
    assert.equal((await h.pending.get(rec.requestId)).state, 'queued');
    assert.equal(h.staging.files.size, 1);
    assert.deepEqual(h.staging.removed, []);
  } finally { h.store.close(); }
});

await test('真实 staging 删除抛错或静默不删均可识别；成功/文件已不存在才算清理完成', async () => {
  const blob = require('react-native-blob-util');
  const oldDocDir = blob.fs.dirs.DocumentDir;
  const oldUnlink = blob.fs.unlink;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'f05-removal-'));
  blob.fs.dirs.DocumentDir = dir;
  const file = path.join(dir, 'source.txt');
  writeFileSync(file, 'mock');
  try {
    const staging = new ReactNativePendingSendStaging();
    const a = await staging.stage({ kind: 'file', uri: file, name: 'a.txt' });
    blob.fs.unlink = async () => { throw new Error('injected unlink failure'); };
    await assert.rejects(staging.removeAttachments([a]), { code: 'cleanup-failed' });
    assert.ok(existsSync(a.stagedUri));
    blob.fs.unlink = async () => {};
    await assert.rejects(staging.removeAttachments([a]), { code: 'cleanup-failed' });
    blob.fs.unlink = oldUnlink;
    await staging.removeAttachments([a]);
    assert.equal(existsSync(a.stagedUri), false);
    await staging.removeAttachments([a]); // 幂等补清
  } finally {
    blob.fs.unlink = oldUnlink;
    blob.fs.dirs.DocumentDir = oldDocDir;
  }
});

await test('异步附件复制先于记录创建：期间无可移除记录；落盘后立即移除不会产生孤儿/发送', async () => {
  const h = await harness();
  try {
    const copy = pauseMethod(h.staging, 'stage');
    const verify = pauseMethod(h.staging, 'verify');
    const task = h.store.sendPending('s1', 'copy race', [draft()]);
    await copy.entered;
    assert.equal((await h.pending.list()).length, 0);
    copy.release();
    await verify.entered;
    const [rec] = await h.pending.list();
    await h.store.abandonPending('s1', rec.requestId);
    verify.release();
    await assertRemoved(h, task, rec.requestId);
    assert.equal(h.staging.copies, 1);
  } finally { h.store.close(); }
});

for (const lateFailure of [false, true]) {
  await test(`preparing 移除与在途上传交错（迟到${lateFailure ? '失败' : '成功'}）：不续传、不发 prompt、不复活`, async () => {
    const h = await harness();
    try {
      const entered = deferred(), finish = deferred();
      h.store.upload.uploadBinary = async (_s, uri, name) => {
        h.uploads.push(uri);
        entered.resolve();
        await finish.promise;
        return { receiptId: 'late', file: { attachmentId: 'late', bytes: 4, name } };
      };
      const task = h.store.sendPending('s1', 'upload race', [draft('a'), draft('b')]);
      await entered.promise;
      const [rec] = await h.pending.list();
      assert.equal(rec.state, 'preparing');
      await h.store.abandonPending('s1', rec.requestId);
      if (lateFailure) finish.reject(new Error('late upload error')); else finish.resolve();
      await assertRemoved(h, task, rec.requestId, 1);
      assert.equal((await h.pending.get(rec.requestId)).attachments[0].receiptId, undefined);
      assert.equal(h.staging.copies, 2);
    } finally { h.store.close(); }
  });
}

for (const point of ['verify', 'build', 'identity']) {
  await test(`ready 移除与 ${point} 等待交错：最终 begin-send 被阻止且返回 abandoned`, async () => {
    const h = await harness();
    try {
      const gate = point === 'verify'
        ? pauseMethod(h.pending, 'verifyAttachments', (attachments) => attachments.length === 0)
        : point === 'build'
          ? pauseMethod(h.store, 'buildOutgoingAttachments')
          : pauseMethod(h.store, 'verifyPendingBinding');
      const task = h.store.sendPending('s1', `ready race ${point}`);
      await gate.entered;
      const [rec] = await h.pending.list();
      assert.equal(rec.state, 'ready');
      await h.store.abandonPending('s1', rec.requestId);
      gate.release();
      await assertRemoved(h, task, rec.requestId);
    } finally { h.store.close(); }
  });
}

await test('begin-send 先落盘则移除必须拒绝；只发一个 prompt，原 ID 正常变 accepted', async () => {
  const h = await harness();
  try {
    const entered = deferred(), finish = deferred();
    h.store.api.prompt = async (p) => { h.prompts.push(p); entered.resolve(); await finish.promise; };
    const task = h.store.sendPending('s1', 'send wins race');
    await entered.promise;
    const [rec] = await h.pending.list();
    assert.equal(rec.state, 'sending');
    await assert.rejects(h.store.abandonPending('s1', rec.requestId), { code: 'request-not-abandonable' });
    finish.resolve();
    assert.equal((await task).state, 'accepted');
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0].requestId, rec.requestId);
  } finally { h.store.close(); }
});

await test('确认框不宣称所有 failed 都未发出；清理失败会关闭确认并保留明确提示', () => {
  const chat = readFileSync(path.join(testDir, '../src/screens/ChatScreen.tsx'), 'utf8');
  const bubble = readFileSync(path.join(testDir, '../src/components/PendingSendBubble.tsx'), 'utf8');
  assert.ok(chat.includes("e.code === 'cleanup-failed'"));
  assert.ok(!chat.includes('这条消息已确认未发出'));
  assert.ok(bubble.includes('pendingSendFailureLabel(record)'));
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败（Mock；真实 LLM 调用 0 次）`);
process.exitCode = failed ? 1 : 0;
