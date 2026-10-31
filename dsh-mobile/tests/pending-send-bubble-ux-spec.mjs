/**
 * F-05 PendingSendBubble 体验优化专项测试。
 *
 * 覆盖：
 *   1. preparing/sending 延迟 600ms 转圈；快速完成不显示，持续发送才显示；
 *   2. 仅确定未发出/明确失败状态允许移除；sending/accepted/unknown 禁止移除；
 *   3. PendingSendStore.abandon 复用状态机 abandon 事件与附件清理机制；
 *   4. requestId 不变、持久化恢复正确、共享附件不被误删；
 *   5. UI 接线：移除入口 + ConfirmSheet 二次确认 + store.abandonPending。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

const { PendingSendStore } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'store.ts'),
);
const { canAbandonPendingSend, canUserRetry } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'state.ts'),
);
const { pendingSendSpinnerDelayMs, PENDING_SEND_SPINNER_DELAY_MS } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'ui.ts'),
);

let pass = 0;
let fail = 0;
function ok(name) {
  pass += 1;
  console.log(`  OK    ${name}`);
}
function bad(name, detail) {
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const value = await fn();
    if (value === true) ok(name);
    else bad(name, String(value));
  } catch (e) {
    bad(name, e?.stack ?? String(e));
  }
}

class MemoryPersistence {
  constructor() {
    this.value = undefined;
  }
  async readRaw() {
    return this.value;
  }
  async writeRaw(value) {
    this.value = value;
  }
}

class MemoryStaging {
  constructor() {
    this.removed = [];
  }
  async removeAttachments(attachments) {
    this.removed.push(...attachments.map((a) => a.stagedUri));
  }
  async cleanupOrphans() {
    return 0;
  }
}

let clock = 1_800_000_000_000;
let seq = 0;
const binding = {
  baseUrl: 'http://127.0.0.1:3095',
  gatewayId: 'gateway-f05',
  authContextHash: 'f'.repeat(64),
  identityQuality: 'confirmed',
};

function makeStore(persistence, staging) {
  return new PendingSendStore({
    persistence,
    staging,
    now: () => clock,
    idFactory: () => `req-f05-${++seq}`,
  });
}

function attachment(name, stagedUri, sha = 'a'.repeat(64)) {
  return {
    kind: 'file',
    localUri: `mem://${name}`,
    stagedUri,
    name,
    size: 4,
    contentSha256: sha,
  };
}

async function makeRecord(store, name, attachments = []) {
  return store.create({
    sessionId: 'session-f05',
    mode: 'queue',
    text: name,
    attachments,
    binding,
  });
}

async function moveTo(store, record, state) {
  let cur = record;
  if (state === 'queued') return cur;
  cur = await store.apply(cur.requestId, { type: 'begin-preparing' });
  if (state === 'preparing') return cur;
  cur = await store.apply(cur.requestId, { type: 'attachments-ready' });
  if (state === 'ready') return cur;
  if (state === 'failed') {
    return store.apply(cur.requestId, { type: 'definite-failure', code: 'attachment-invalid' });
  }
  cur = await store.apply(cur.requestId, { type: 'begin-send' });
  if (state === 'sending') return cur;
  if (state === 'accepted') return store.apply(cur.requestId, { type: 'accept' });
  if (state === 'unknown') {
    return store.apply(cur.requestId, { type: 'unknown-failure', code: 'network-lost' });
  }
  throw new Error(`unsupported state ${state}`);
}

function recordLike(state, updatedAt = clock) {
  return {
    state, updatedAt, attemptCount: 0,
    ...(state === 'failed'
      ? { lastError: { classification: 'definite', code: 'attachment-invalid' } }
      : {}),
  };
}

console.log('\n── 1. preparing/sending 600ms 延迟转圈 ──────────────');
await check('延迟常量为 600ms', () => PENDING_SEND_SPINNER_DELAY_MS === 600);
await check('刚进入 preparing 时延迟 600ms，599ms 时还剩 1ms，600ms 时立即显示', () => {
  return (
    pendingSendSpinnerDelayMs(recordLike('preparing', 1000), 1000) === 600 &&
    pendingSendSpinnerDelayMs(recordLike('preparing', 1000), 1599) === 1 &&
    pendingSendSpinnerDelayMs(recordLike('preparing', 1000), 1600) === 0
  );
});
await check('sending 持续超过 600ms 后转圈立即显示', () =>
  pendingSendSpinnerDelayMs(recordLike('sending', 1000), 1700) === 0 ? true : 'sending 延迟错误',
);
await check('ready/accepted/unknown/failed 不显示发送转圈', () => {
  return (
    pendingSendSpinnerDelayMs(recordLike('ready')) === null &&
    pendingSendSpinnerDelayMs(recordLike('accepted')) === null &&
    pendingSendSpinnerDelayMs(recordLike('unknown')) === null &&
    pendingSendSpinnerDelayMs(recordLike('failed')) === null
  );
});

console.log('\n── 2. 可移除状态与安全边界 ─────────────────────────');
await check('queued/preparing/ready/failed 允许移除；sending/accepted/unknown 禁止移除', () => {
  const safe = ['queued', 'preparing', 'ready', 'failed'];
  const unsafe = ['sending', 'accepted', 'unknown', 'confirmed', 'abandoned', 'expired'];
  return (
    safe.every((s) => canAbandonPendingSend(recordLike(s))) &&
    unsafe.every((s) => !canAbandonPendingSend(recordLike(s)))
  );
});
await check('unknown 仍保留安全重试（复用原 requestId），不因禁止移除而失去恢复能力', () =>
  canUserRetry(recordLike('unknown')) ? true : 'unknown 安全重试被误删',
);
await check('accepted/sending 不可重试也不可移除，只能等待确认', () => {
  return !canUserRetry(recordLike('accepted')) &&
    !canAbandonPendingSend(recordLike('accepted')) &&
    !canUserRetry(recordLike('sending')) &&
    !canAbandonPendingSend(recordLike('sending'));
});

console.log('\n── 3. PendingSendStore.abandon 持久化、ID 与附件清理 ─');
await check('queued 记录 abandon 后状态为 abandoned，requestId 保持不变，重载后仍持久化', async () => {
  const persistence = new MemoryPersistence();
  const staging = new MemoryStaging();
  const store = makeStore(persistence, staging);
  await store.hydrate();
  const rec = await makeRecord(store, 'queued-remove', [attachment('a.txt', '/stage/a')]);
  const abandoned = await store.abandon(rec.requestId);
  assert.equal(abandoned.state, 'abandoned');
  assert.equal(abandoned.requestId, rec.requestId);

  const reloaded = makeStore(persistence, staging);
  await reloaded.hydrate();
  const fromDisk = await reloaded.get(rec.requestId);
  assert.equal(fromDisk?.state, 'abandoned');
  assert.equal(fromDisk?.requestId, rec.requestId);
  assert.deepEqual(staging.removed, ['/stage/a']);
  return true;
});

await check('failed 明确未发出可移除，附件同步清理', async () => {
  const persistence = new MemoryPersistence();
  const staging = new MemoryStaging();
  const store = makeStore(persistence, staging);
  await store.hydrate();
  const rec = await makeRecord(store, 'failed-remove', [attachment('f.txt', '/stage/f')]);
  const failed = await moveTo(store, rec, 'failed');
  const abandoned = await store.abandon(failed.requestId);
  assert.equal(abandoned.state, 'abandoned');
  assert.deepEqual(staging.removed, ['/stage/f']);
  return true;
});

await check('unknown/accepted 禁止移除且记录保持原状态，不静默丢弃', async () => {
  const persistence = new MemoryPersistence();
  const staging = new MemoryStaging();
  const store = makeStore(persistence, staging);
  await store.hydrate();
  const unknownRec = await moveTo(store, await makeRecord(store, 'unknown'), 'unknown');
  const acceptedRec = await moveTo(store, await makeRecord(store, 'accepted'), 'accepted');
  for (const rec of [unknownRec, acceptedRec]) {
    let threw = false;
    try {
      await store.abandon(rec.requestId);
    } catch {
      threw = true;
    }
    assert.equal(threw, true);
    assert.equal((await store.get(rec.requestId))?.state, rec.state);
  }
  assert.deepEqual(staging.removed, []);
  return true;
});

await check('共享 stagedUri 的附件被其他未决记录引用时，移除一条不得误删附件', async () => {
  const persistence = new MemoryPersistence();
  const staging = new MemoryStaging();
  const store = makeStore(persistence, staging);
  await store.hydrate();
  const shared = attachment('shared.txt', '/stage/shared');
  const first = await makeRecord(store, 'first', [shared]);
  const second = await makeRecord(store, 'second', [shared]);
  await store.abandon(first.requestId);
  assert.deepEqual(staging.removed, []);
  assert.equal((await store.get(second.requestId))?.state, 'queued');
  await store.abandon(second.requestId);
  assert.deepEqual(staging.removed, ['/stage/shared']);
  return true;
});

console.log('\n── 4. UI 接线静态检查 ──────────────────────────────');
const bubbleSrc = readFileSync(
  path.join(__dirname, '..', 'src', 'components', 'PendingSendBubble.tsx'),
  'utf8',
);
const chatSrc = readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'ChatScreen.tsx'),
  'utf8',
);
await check('PendingSendBubble 使用延迟转圈并渲染可移除入口', () =>
  /pendingSendSpinnerDelayMs/.test(bubbleSrc) &&
  /<DelayedSpinner/.test(bubbleSrc) &&
  /onRemove\?\.\(record\)/.test(bubbleSrc) &&
  />移除</.test(bubbleSrc)
    ? true
    : '缺少延迟转圈或移除入口',
);
await check('ChatScreen 接入 store.abandonPending、onRemove 与 ConfirmSheet 二次确认', () =>
  /store\.abandonPending\(/.test(chatSrc) &&
  /onRemove=\{setPendingRemove\}/.test(chatSrc) &&
  /title="移除待发送消息？"/.test(chatSrc) &&
  /destructive/.test(chatSrc) &&
  /<ConfirmSheet/.test(chatSrc)
    ? true
    : '缺少移除确认或 store 接线',
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
