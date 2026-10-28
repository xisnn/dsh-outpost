/**
 * P0-1 阶段 3 附件发送编排测试（Node 内存存储 + 内存暂存，不访问网络/原生模块）。
 *
 * 覆盖：纯图片、纯文件、混合、同文件名同大小但内容不同、上传失败、
 * 上传成功但 prompt 失败、prompt 已受理但回执丢失、重启恢复、内容变化、
 * 暂存失败、清理。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
const { PendingSendStagingError } = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'staging.ts'));
const { ensureWebSocket } = await imp(path.join(__dirname, '..', 'tests', 'support', 'ws-compat.mjs'));

ensureWebSocket();

class MemoryPersistence {
  constructor() {
    this.value = undefined;
    this.writes = 0;
    this.failWrites = 0;
  }
  async readRaw() {
    return this.value;
  }
  async writeRaw(value) {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error('simulated keychain write failure');
    }
    this.writes += 1;
    this.value = value;
  }
  async clear() {
    this.value = undefined;
  }
}

class MemoryStaging {
  constructor() {
    this.sources = new Map();
    this.files = new Map();
    this.next = 0;
    this.failStage = false;
    this.failClear = false;
    this.dir = mkdtempSync(`${os.tmpdir()}/p0-attach-`);
  }
  addSource(uri, bytes) {
    this.sources.set(uri, Buffer.from(bytes));
  }
  stage(draft) {
    if (this.failStage) {
      return Promise.reject(
        new PendingSendStagingError('attachment-copy-failed', 'simulated stage failure'),
      );
    }
    const bytes = this.sources.get(draft.uri);
    if (!bytes) {
      return Promise.reject(
        new PendingSendStagingError('attachment-missing', `missing source ${draft.uri}`),
      );
    }
    const stagedUri = `${this.dir}/${++this.next}-${draft.name}`;
    writeFileSync(stagedUri, bytes);
    this.files.set(stagedUri, Buffer.from(bytes));
    return Promise.resolve({
      kind: draft.kind,
      localUri: draft.uri,
      stagedUri,
      name: draft.name,
      size: bytes.length,
      mime: draft.mime,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  async verify(attachment) {
    let bytes;
    try {
      bytes = readFileSync(attachment.stagedUri);
    } catch {
      throw new PendingSendStagingError('attachment-missing', 'simulated missing staged file');
    }
    if (bytes.length !== attachment.size) {
      throw new PendingSendStagingError('attachment-changed', 'simulated size change');
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== attachment.contentSha256) {
      throw new PendingSendStagingError('attachment-changed', 'simulated content change');
    }
  }
  async removeAttachments(attachments) {
    const fs = await import('node:fs');
    for (const a of attachments) {
      try {
        fs.unlinkSync(a.stagedUri);
      } catch {
        /* ignore */
      }
      this.files.delete(a.stagedUri);
    }
  }
  async clearAll() {
    if (this.failClear) {
      throw new PendingSendStagingError('cleanup-failed', 'simulated staging clear failure');
    }
    const fs = await import('node:fs');
    for (const key of this.files.keys()) {
      try {
        fs.unlinkSync(key);
      } catch {
        /* ignore */
      }
    }
    this.files.clear();
  }
  async cleanupOrphans(referenced) {
    const refs = new Set(referenced);
    let removed = 0;
    for (const key of [...this.files.keys()]) {
      if (!refs.has(key)) {
        this.files.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
  change(uri, bytes) {
    writeFileSync(uri, Buffer.from(bytes));
    this.files.set(uri, Buffer.from(bytes));
  }
}

let clock = 1_800_000_000_000;
let seq = 0;
const binding = {
  baseUrl: 'http://127.0.0.1:3095',
  gatewayId: 'gateway-A',
  authContextHash: 'a'.repeat(64),
  identityQuality: 'confirmed',
};

function makeHarness() {
  const persistence = new MemoryPersistence();
  const staging = new MemoryStaging();
  const pending = new PendingSendStore({
    persistence,
    staging,
    now: () => clock++,
    idFactory: () => `req-attach-${++seq}`,
  });
  const conn = new DshConnection({ baseUrl: 'http://127.0.0.1:1', cookie: 'dsh-auth-test=v1' });
  const prompts = [];
  const uploads = [];
  let uploadShouldFail = false;
  const acceptedIds = new Set();
  const store = new Store(conn, {
    pendingSendStore: pending,
    loadPendingBinding: async () => binding,
    verifyPendingBinding: async () => undefined,
  });
  store.api.prompt = async (params) => {
    prompts.push(params);
    acceptedIds.add(params.requestId);
    if (promptError) throw promptError;
  };
  let promptError;
  store.upload.uploadBinary = async (sessionId, stagedUri, name) => {
    uploads.push({ sessionId, stagedUri, name });
    if (uploadShouldFail) throw new Error('upload failed');
    return {
      receiptId: `receipt-${uploads.length}`,
      file: { attachmentId: `att-${uploads.length}`, name, bytes: 4 },
    };
  };
  return {
    persistence,
    staging,
    pending,
    store,
    prompts,
    uploads,
    acceptedIds,
    setup: async function () {
      await pending.hydrate();
      return this;
    },
    setUploadFail: (value) => {
      uploadShouldFail = value;
    },
    setPromptError: (error) => {
      promptError = error;
    },
  };
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

function fileDraft(uri, name = 'a.txt', size = 4) {
  return { kind: 'file', uri, name, size, mime: 'text/plain' };
}
function imageDraft(uri, name = 'a.png', size = 4) {
  return { kind: 'image', uri, name, size, mime: 'image/png' };
}

await check('纯图片：真实字节 SHA-256，prompt 内联 base64，无 upload', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://image', Buffer.from('PNG!'));
  const record = await h.store.sendPending('s1', '', [imageDraft('mem://image')]);
  assert.equal(record.state, 'accepted');
  assert.equal(h.uploads.length, 0);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].parts[0].type, 'image');
  assert.equal(h.prompts[0].parts[0].data, Buffer.from('PNG!').toString('base64'));
  assert.equal(record.attachments[0].contentSha256, createHash('sha256').update('PNG!').digest('hex'));
});

await check('纯文件：上传回执进入 prompt，重启前可复用', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  const record = await h.store.sendPending('s1', '', [fileDraft('mem://file')]);
  assert.equal(record.state, 'accepted');
  assert.equal(h.uploads.length, 1);
  assert.equal(h.prompts[0].parts[0].type, 'file');
  assert.equal(h.prompts[0].parts[0].receiptId, 'receipt-1');
});

await check('混合消息：图片 + 文件统一进入 PendingSendStore', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://image', Buffer.from('IMG!'));
  h.staging.addSource('mem://file', Buffer.from('DOC!'));
  const record = await h.store.sendPending('s1', 'mix', [
    imageDraft('mem://image'),
    fileDraft('mem://file'),
  ]);
  assert.equal(record.state, 'accepted');
  assert.equal(h.uploads.length, 1);
  assert.equal(h.prompts[0].parts.length, 3);
  assert.deepEqual(
    h.prompts[0].parts.map((p) => p.type),
    ['text', 'image', 'file'],
  );
});

await check('相同文件名/大小、不同内容：指纹不同，绝不合并', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://a', Buffer.from('AAAA'));
  h.staging.addSource('mem://b', Buffer.from('BBBB'));
  const a = await h.store.sendPending('s1', '', [fileDraft('mem://a', 'same.bin', 4)]);
  const b = await h.store.sendPending('s1', '', [fileDraft('mem://b', 'same.bin', 4)]);
  assert.notEqual(a.requestId, b.requestId);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.notEqual(a.attachments[0].contentSha256, b.attachments[0].contentSha256);
  assert.equal(h.uploads.length, 2);
});

await check('上传失败：记录 failed，prompt 不被调用；显式重试复用 ID', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  h.setUploadFail(true);
  await assert.rejects(() => h.store.sendPending('s1', '', [fileDraft('mem://file')]), /upload failed/);
  const failed = (await h.pending.list('s1'))[0];
  assert.equal(failed.state, 'failed');
  assert.equal(h.prompts.length, 0);
  h.setUploadFail(false);
  const retried = await h.store.retryPending('s1', failed.requestId);
  assert.equal(retried.requestId, failed.requestId);
  assert.equal(h.prompts.length, 1);
  assert.equal(retried.state, 'accepted');
});

await check('多文件上传中断：已成功回执保留，重试只补失败附件', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://one', Buffer.from('ONE!'));
  h.staging.addSource('mem://two', Buffer.from('TWO!'));
  let failSecond = true;
  h.store.upload.uploadBinary = async (_s, _p, name) => {
    if (name === 'two.txt' && failSecond) {
      throw new Error('simulated upload interruption');
    }
    return {
      receiptId: `receipt-${name}`,
      file: { attachmentId: `att-${name}`, name, bytes: 4 },
    };
  };
  await assert.rejects(
    () =>
      h.store.sendPending('s1', '', [
        fileDraft('mem://one', 'one.txt', 4),
        fileDraft('mem://two', 'two.txt', 4),
      ]),
    /upload interruption/,
  );
  const failed = (await h.pending.list('s1'))[0];
  assert.equal(failed.state, 'failed');
  assert.equal(h.prompts.length, 0);
  assert.ok(failed.attachments[0].receiptId);
  assert.equal(failed.attachments[1].receiptId, undefined);
  failSecond = false;
  const retried = await h.store.retryPending('s1', failed.requestId);
  assert.equal(retried.requestId, failed.requestId);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].parts.filter((p) => p.type === 'file').length, 2);
});

await check('上传成功但 prompt 失败：回执保留，重试不重复上传', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  h.setPromptError(new Error('Network request failed'));
  await assert.rejects(() => h.store.sendPending('s1', '', [fileDraft('mem://file')]), /Network request failed/);
  const failed = (await h.pending.list('s1'))[0];
  assert.equal(failed.state, 'unknown');
  assert.equal(h.uploads.length, 1);
  h.setPromptError(undefined);
  const retried = await h.store.retryPending('s1', failed.requestId);
  assert.equal(retried.requestId, failed.requestId);
  assert.equal(h.uploads.length, 1, '必须复用已保存的上传回执');
  assert.equal(h.prompts.length, 2);
});

await check('prompt 已受理但回执丢失：同 requestId 重试，服务端去重', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  h.setPromptError(new Error('请求超时（模拟回执丢失）'));
  await assert.rejects(() => h.store.sendPending('s1', '', [fileDraft('mem://file')]), /请求超时/);
  const uncertain = (await h.pending.list('s1'))[0];
  assert.equal(uncertain.state, 'unknown');
  assert.equal(h.acceptedIds.size, 1);
  h.setPromptError(undefined);
  const retried = await h.store.retryPending('s1', uncertain.requestId);
  assert.equal(retried.requestId, uncertain.requestId);
  assert.equal(h.acceptedIds.size, 1, 'mock 服务端只接受同一个 ID 一次');
  assert.equal(h.uploads.length, 1);
});

await check('App 重启不自动重发：preparing 恢复为 failed，显式 retry 才发', async () => {
  const h = await makeHarness();
  await h.pending.hydrate();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  const staged = await h.pending.stageDrafts([fileDraft('mem://file')]);
  const created = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged,
    binding,
  });
  await h.pending.apply(created.requestId, { type: 'begin-preparing' });
  const restarted = new PendingSendStore({
    persistence: h.persistence,
    staging: h.staging,
    now: () => clock++,
  });
  await restarted.hydrate();
  const recovered = await restarted.get(created.requestId);
  assert.equal(recovered.state, 'failed');
  assert.equal(h.prompts.length, 0, '重启后不得自动 prompt');
});

await check('原始 URI 失效后，仍从私有暂存副本重试', async () => {
  const h = await makeHarness();
  await h.pending.hydrate();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  const staged = await h.pending.stageDrafts([fileDraft('mem://file', 'p0-file.txt', 4)]);
  h.staging.sources.delete('mem://file'); // 原选择器 URI 已不可用
  const created = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged,
    binding,
  });
  h.store.upload.uploadBinary = async (_s, _p, name) => ({
    receiptId: 'receipt-source-gone',
    file: { attachmentId: 'att-source-gone', name, bytes: 4 },
  });
  const retried = await h.store.retryPending('s1', created.requestId);
  assert.equal(retried.state, 'accepted');
  assert.equal(h.prompts.length, 1);
});

await check('暂存文件被删除：重试前拒绝，不 prompt', async () => {
  const h = await makeHarness();
  await h.pending.hydrate();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  const staged = await h.pending.stageDrafts([fileDraft('mem://file')]);
  await import('node:fs').then((fs) => fs.unlinkSync(staged[0].stagedUri));
  h.staging.files.delete(staged[0].stagedUri);
  const created = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged,
    binding,
  });
  await assert.rejects(
    () => h.store.retryPending('s1', created.requestId),
    /missing|不存在|attachment/i,
  );
  assert.equal(h.prompts.length, 0);
});

await check('附件内容被修改：重试前拒绝，prompt 不被调用', async () => {
  const h = await makeHarness();
  await h.pending.hydrate();
  h.staging.addSource('mem://file', Buffer.from('AAAA'));
  const staged = await h.pending.stageDrafts([fileDraft('mem://file', 'same.bin', 4)]);
  const created = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged,
    binding,
  });
  h.staging.change(staged[0].stagedUri, Buffer.from('BBBB'));
  await assert.rejects(
    () => h.store.retryPending('s1', created.requestId),
    /内容已变化|content|changed/i,
  );
  assert.equal(h.prompts.length, 0);
  assert.equal((await h.pending.get(created.requestId)).state, 'failed');
});

await check('Keychain 写入失败：不生成记录、不 prompt，暂存文件被丢弃', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  h.persistence.failWrites = 1;
  await assert.rejects(
    () => h.store.sendPending('s1', '', [fileDraft('mem://file')]),
    /write failure|写入失败/i,
  );
  assert.equal((await h.pending.list('s1')).length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.staging.files.size, 0);
});

await check('暂存失败：没有记录、没有 prompt', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  h.staging.failStage = true;
  await assert.rejects(() => h.store.sendPending('s1', '', [fileDraft('mem://file')]), /stage failure/);
  assert.equal((await h.pending.list('s1')).length, 0);
  assert.equal(h.prompts.length, 0);
});

await check('共享附件引用：一条过期时不能误删另一条仍在使用的文件', async () => {
  const h = await makeHarness();
  await h.pending.hydrate();
  h.staging.addSource('mem://shared', Buffer.from('SHARED'));
  const staged = await h.pending.stageDrafts([fileDraft('mem://shared', 'shared.bin', 6)]);
  const first = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged,
    binding,
    expiresAt: clock + 1000,
  });
  const second = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged,
    binding,
    expiresAt: clock + 60000,
  });
  clock += 2000;
  await h.pending.prune();
  assert.equal((await h.pending.get(first.requestId)).state, 'expired');
  assert.equal((await h.pending.get(second.requestId)).state, 'queued');
  assert.ok(h.staging.files.has(staged[0].stagedUri), '共享文件仍被第二条引用');
  clock += 120000;
  await h.pending.prune();
  assert.equal((await h.pending.get(first.requestId)).state, 'expired');
  assert.equal((await h.pending.get(second.requestId)).state, 'expired');
  assert.equal(h.staging.files.has(staged[0].stagedUri), false);
});

await check('暂存目录清理失败：不虚报成功，后续可再次清理', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  await h.store.sendPending('s1', '', [fileDraft('mem://file')]);
  h.staging.failClear = true;
  const partial = await h.pending.clearAll();
  assert.equal(partial.records, 'cleared');
  assert.equal(partial.staging, 'failed');
  assert.equal((await h.pending.list()).length, 0);
  assert.ok(h.staging.files.size > 0, '清理失败时文件应仍存在');
  h.staging.failClear = false;
  await h.pending.clearAll();
  assert.equal(h.staging.files.size, 0);
});

await check('启动时清理无记录引用的孤儿暂存文件', async () => {
  const h = await makeHarness();
  h.staging.files.set(`mem://orphan`, Buffer.from('ORPHAN'));
  await h.pending.hydrate();
  assert.equal(h.staging.files.has('mem://orphan'), false);
});

await check('已确认/已放弃任务清理时释放附件', async () => {
  const h = await makeHarness();
  await h.pending.hydrate();
  h.staging.addSource('mem://cleanup', Buffer.from('CLEAN'));
  const staged = await h.pending.stageDrafts([fileDraft('mem://cleanup', 'clean.txt', 5)]);
  const confirmed = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged,
    binding,
  });
  await h.pending.apply(confirmed.requestId, { type: 'begin-preparing' });
  await h.pending.apply(confirmed.requestId, { type: 'attachments-ready' });
  await h.pending.apply(confirmed.requestId, { type: 'begin-send' });
  await h.pending.apply(confirmed.requestId, { type: 'accept' });
  await h.pending.apply(confirmed.requestId, { type: 'confirm' });
  assert.equal(h.staging.files.has(staged[0].stagedUri), true);
  await h.pending.prune();
  assert.equal(h.staging.files.has(staged[0].stagedUri), false);

  h.staging.addSource('mem://abandon', Buffer.from('DROP'));
  const staged2 = await h.pending.stageDrafts([fileDraft('mem://abandon', 'drop.txt', 4)]);
  const abandoned = await h.pending.create({
    sessionId: 's1',
    mode: 'queue',
    text: '',
    attachments: staged2,
    binding,
  });
  await h.pending.apply(abandoned.requestId, { type: 'abandon' });
  clock += 2 * 60 * 60 * 1000;
  await h.pending.prune();
  assert.equal(h.staging.files.has(staged2[0].stagedUri), false);
});

await check('clearAll 同时清理待发送记录与附件暂存文件', async () => {
  const h = await makeHarness().setup();
  h.staging.addSource('mem://file', Buffer.from('FILE'));
  await h.store.sendPending('s1', '', [fileDraft('mem://file')]);
  assert.equal(h.staging.files.size, 1);
  await h.pending.clearAll();
  assert.equal(h.staging.files.size, 0);
  assert.equal((await h.pending.list()).length, 0);
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
