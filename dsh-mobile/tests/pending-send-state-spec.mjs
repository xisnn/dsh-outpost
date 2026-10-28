/**
 * PendingSend 状态机纯函数测试。
 *
 * 覆盖：
 *   · 正常路径与非法迁移
 *   · accepted / confirmed 的区分
 *   · 重启恢复：sending→unknown、preparing→failed、不自动重发
 *   · 服务实例/授权上下文绑定匹配
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

const { transitionPendingSend, canUserRetry, evaluatePendingSendBinding, PendingSendTransitionError } =
  await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'state.ts'));

const NOW = 1_800_000_000_000;

function record(over = {}) {
  return {
    schema: 1,
    requestId: 'req-test-1',
    sessionId: 'session-1',
    mode: 'queue',
    text: 'hello',
    attachments: [],
    fingerprint: 'f'.repeat(64),
    state: 'queued',
    attemptCount: 0,
    binding: {
      baseUrl: 'http://127.0.0.1:3095',
      gatewayId: 'gateway-A',
      authContextHash: 'a'.repeat(64),
      identityQuality: 'confirmed',
    },
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 7 * 24 * 3600 * 1000,
    ...over,
  };
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  OK    ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL  ' + name + (e?.message ? ' — ' + e.message : ''));
  }
}

check('正常路径 queued→preparing→ready→sending→accepted→confirmed', () => {
  let r = record();
  r = transitionPendingSend(r, { type: 'begin-preparing' }, NOW + 1);
  assert.equal(r.state, 'preparing');
  r = transitionPendingSend(r, { type: 'attachments-ready' }, NOW + 2);
  assert.equal(r.state, 'ready');
  r = transitionPendingSend(r, { type: 'begin-send' }, NOW + 3);
  assert.equal(r.state, 'sending');
  r = transitionPendingSend(r, { type: 'accept' }, NOW + 4);
  assert.equal(r.state, 'accepted');
  assert.equal(r.acceptedAt, NOW + 4);
  r = transitionPendingSend(r, { type: 'confirm' }, NOW + 5);
  assert.equal(r.state, 'confirmed');
  assert.equal(r.confirmedAt, NOW + 5);
  assert.equal(r.requestId, 'req-test-1');
});

check('sending 超时→unknown；用户显式重试→preparing 且复用同一 requestId', () => {
  let r = record({ state: 'sending', attemptCount: 1 });
  r = transitionPendingSend(
    r,
    { type: 'unknown-failure', code: 'timeout', message: '请求超时' },
    NOW + 10,
  );
  assert.equal(r.state, 'unknown');
  assert.equal(r.lastError.code, 'timeout');
  assert.equal(canUserRetry(r), true);
  const beforeId = r.requestId;
  r = transitionPendingSend(r, { type: 'user-retry' }, NOW + 11);
  assert.equal(r.state, 'preparing');
  assert.equal(r.requestId, beforeId);
  assert.equal(r.attemptCount, 2);
});

check('sending 明确失败→failed；requestId 不变', () => {
  let r = record({ state: 'sending' });
  r = transitionPendingSend(r, { type: 'definite-failure', code: 'http-400' }, NOW + 10);
  assert.equal(r.state, 'failed');
  assert.equal(r.lastError.classification, 'definite');
  assert.equal(r.requestId, 'req-test-1');
});

check('非法迁移抛 PendingSendTransitionError', () => {
  assert.throws(
    () => transitionPendingSend(record({ state: 'accepted' }), { type: 'accept' }, NOW),
    PendingSendTransitionError,
  );
  assert.throws(
    () => transitionPendingSend(record({ state: 'confirmed' }), { type: 'begin-send' }, NOW),
    PendingSendTransitionError,
  );
  assert.throws(
    () => transitionPendingSend(record({ state: 'sending' }), { type: 'begin-preparing' }, NOW),
    PendingSendTransitionError,
  );
});

check('accepted 不能用户重试，只能 confirm', () => {
  const r = record({ state: 'accepted' });
  assert.equal(canUserRetry(r), false);
  assert.equal(transitionPendingSend(r, { type: 'confirm' }, NOW).state, 'confirmed');
});

check('重启恢复：sending→unknown，不自动重发', () => {
  const r = transitionPendingSend(
    record({ state: 'sending' }),
    { type: 'recover-after-restart' },
    NOW + 100,
  );
  assert.equal(r.state, 'unknown');
  assert.equal(r.lastError.code, 'process-restarted');
  assert.equal(r.requestId, 'req-test-1');
});

check('重启恢复：preparing→failed（prompt 一定没发）', () => {
  const r = transitionPendingSend(
    record({ state: 'preparing' }),
    { type: 'recover-after-restart' },
    NOW + 100,
  );
  assert.equal(r.state, 'failed');
  assert.equal(r.lastError.code, 'process-restarted-before-send');
});

check('重启恢复：queued/ready 保持原状态，等用户明确操作', () => {
  for (const state of ['queued', 'ready']) {
    const r = record({ state });
    const after = transitionPendingSend(r, { type: 'recover-after-restart' }, NOW + 100);
    assert.equal(after.state, state);
    assert.equal(after.requestId, r.requestId);
  }
});

check('绑定匹配：地址+gateway+授权上下文全同才放行', () => {
  const binding = record().binding;
  assert.deepEqual(
    evaluatePendingSendBinding(binding, {
      baseUrl: 'http://127.0.0.1:3095/',
      gatewayId: 'gateway-A',
      authContextHash: 'a'.repeat(64),
    }),
    { ok: true },
  );
});

check('绑定拒绝：地址变化 / 无 gateway / gateway 变化 / 授权上下文变化', () => {
  const binding = record().binding;
  const cases = [
    [
      { baseUrl: 'http://127.0.0.1:3096', gatewayId: 'gateway-A', authContextHash: 'a'.repeat(64) },
      'service-address-changed',
    ],
    [
      { baseUrl: 'http://127.0.0.1:3095', gatewayId: null, authContextHash: 'a'.repeat(64) },
      'server-identity-unverifiable',
    ],
    [
      { baseUrl: 'http://127.0.0.1:3095', gatewayId: 'gateway-B', authContextHash: 'a'.repeat(64) },
      'server-instance-changed',
    ],
    [
      { baseUrl: 'http://127.0.0.1:3095', gatewayId: 'gateway-A', authContextHash: 'b'.repeat(64) },
      'authorization-context-changed',
    ],
  ];
  for (const [current, reason] of cases) {
    const v = evaluatePendingSendBinding(binding, current);
    assert.equal(v.ok, false);
    assert.equal(v.reason, reason);
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
