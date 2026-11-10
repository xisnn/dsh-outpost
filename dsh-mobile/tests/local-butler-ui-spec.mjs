import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from './support/component-harness.mjs';

const GENERATION = '00000000-0000-4000-8000-000000000001';
const TASK = 'task-11111111-1111-4111-8111-111111111111';

function view(over = {}) {
  return {
    client: {},
    supported: true,
    snapshot: {
      phase: 'stopped', generation: GENERATION, reason: '', requiresReconciliation: false,
      observedAt: 1, installed: { installed: true, id: 'p1-verification-x86_64', version: 'p2-1' },
    },
    error: null,
    busy: false,
    distributions: [],
    refresh: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    importPackage: async () => undefined,
    ...over,
  };
}

function panel(runtime, handlers = {}) {
  return componentHarness('components/LocalRuntimePanel.tsx', 'LocalRuntimePanel', {
    view: runtime,
    onStart: handlers.start ?? (() => undefined),
    onStop: handlers.stop ?? (() => undefined),
    onRefresh: handlers.refresh ?? (() => undefined),
  });
}

function click(harness, label) {
  const button = harness.button(label);
  assert.ok(button, label);
  button.props.onPress();
  harness.render();
}

test('unsupported devices explain the fallback instead of offering a broken start', () => {
  const h = panel(view({ supported: false }));
  assert.match(h.text(), /本机运行不可用/);
  assert.match(h.text(), /电脑模式不受影响/);
  assert.equal(h.button('启动本机运行环境'), undefined);
});

test('a stopped installed runtime starts only when the user taps', () => {
  let starts = 0;
  const h = panel(view(), { start: () => { starts += 1; } });
  assert.match(h.text(), /本机运行环境已就绪/);
  assert.equal(starts, 0);
  click(h, '启动本机运行环境');
  assert.equal(starts, 1);
});

test('a missing runtime package cannot be started and explains missing metadata', () => {
  const h = panel(view({ snapshot: { ...view().snapshot, installed: { installed: false } } }));
  assert.match(h.text(), /本机运行包尚未安装/);
  assert.equal(h.button('启动本机运行环境'), undefined);
  assert.match(h.text(), /当前安装未包含运行包描述/);
  assert.equal(h.button('导入运行包'), undefined);
});

test('a bundled manifest offers the import entry and never starts before install', () => {
  let imports = 0;
  const h = panel(view({
    snapshot: { ...view().snapshot, installed: { installed: false } },
    distributions: [{ id: 'p1-verification-x86_64', version: 'p2-1', abi: 'x86_64' }],
    importPackage: async () => { imports += 1; },
  }));
  assert.equal(h.button('启动本机运行环境'), undefined);
  assert.match(h.text(), /本机运行包未安装/);
  const importButton = h.button('导入运行包');
  assert.ok(importButton);
  importButton.props.onPress();
  assert.equal(imports, 1);
});

test('an in-flight import disables the import entry', () => {
  const h = panel(view({
    busy: true,
    snapshot: { ...view().snapshot, installed: { installed: false } },
    distributions: [{ id: 'p1-verification-x86_64', version: 'p2-1', abi: 'x86_64' }],
  }));
  assert.match(h.text(), /正在安装/);
  assert.equal(h.button('导入运行包').props.accessibilityState.disabled, true);
});

test('a clean stop that needs acknowledgement is not mislabelled as a crash', () => {
  const h = panel(view({
    snapshot: { ...view().snapshot, phase: 'stopped', requiresReconciliation: true, lastHeartbeatElapsedMs: 1200 },
  }));
  assert.match(h.text(), /本机运行环境已停止/);
  assert.match(h.text(), /启动需要确认未核对状态/);
  assert.ok(h.button('启动本机运行环境'));
});

test('interrupted reconciliation is stated before starting and never promises replay', () => {
  const h = panel(view({
    snapshot: { ...view().snapshot, phase: 'interrupted', requiresReconciliation: true },
  }));
  assert.match(h.text(), /上次运行未正常结束/);
  assert.match(h.text(), /旧任务、旧审批和旧队列都不会自动恢复/);
  assert.ok(h.button('启动本机运行环境'));
});

test('stop-unconfirmed requires another stop before any start', () => {
  let stops = 0;
  const h = panel(view({
    snapshot: { ...view().snapshot, phase: 'stop-unconfirmed', requiresReconciliation: true },
  }), { stop: () => { stops += 1; } });
  assert.match(h.text(), /上次停止尚未确认/);
  assert.equal(h.button('启动本机运行环境'), undefined);
  click(h, '再次停止并确认清理');
  assert.equal(stops, 1);
});

test('running runtime shows its generation and a stop action', () => {
  let stops = 0;
  const h = panel(view({
    snapshot: { ...view().snapshot, phase: 'running', lastHeartbeatElapsedMs: 1200 },
  }), { stop: () => { stops += 1; } });
  assert.match(h.text(), /本机运行中/);
  assert.match(h.text(), /心跳 1 秒前/);
  click(h, '停止本机运行环境');
  assert.equal(stops, 1);
});

test('an unreadable journal reports the machine code and offers a retry', () => {
  let refreshes = 0;
  const h = panel(view({ snapshot: null, error: 'LOCAL_RUNTIME_STATE' }), { refresh: () => { refreshes += 1; } });
  assert.match(h.text(), /暂时读不到本机运行环境/);
  assert.match(h.text(), /LOCAL_RUNTIME_STATE/);
  click(h, '重试读取本机运行环境');
  assert.equal(refreshes, 1);
});

const approval = (over = {}) => ({
  id: 'approval-1', taskId: TASK, toolCallId: 'call-1', toolName: 'write',
  argumentDigest: 'a'.repeat(64),
  arguments: { file_path: '/outpost-data/workspace/out.txt', content: 'hello' },
  generation: GENERATION, expiresAt: Date.now() + 60_000, ...over,
});

function card(over = {}) {
  return componentHarness('components/LocalApprovalCard.tsx', 'LocalApprovalCard', {
    approval: approval(),
    busy: false,
    locked: false,
    error: undefined,
    now: Date.now(),
    onDecide: () => undefined,
    ...over,
  });
}

test('local approval shows the tool, frozen arguments and digest before any answer', () => {
  const h = card();
  assert.match(h.text(), /本机审批 · write/);
  assert.match(h.text(), /file_path/);
  assert.match(h.text(), /\/outpost-data\/workspace\/out\.txt/);
  assert.match(h.text(), /hello/);
  assert.match(h.text(), /参数摘要 aaaaaaaaaaaa…/);
});

test('allow and reject produce exactly one decision each', () => {
  const decisions = [];
  const h = card({ onDecide: decision => decisions.push(decision) });
  click(h, '允许一次本机审批');
  click(h, '拒绝本机审批');
  assert.deepEqual(decisions, ['allowed-once', 'rejected']);
});

test('an unknown outcome locks the allow action and says it will not resend', () => {
  const h = card({ locked: true });
  assert.match(h.text(), /已提交但结果未知/);
  assert.match(h.text(), /不会自动重发/);
  assert.equal(h.button('允许一次本机审批').props.accessibilityState.disabled, true);
  assert.equal(h.button('拒绝本机审批').props.accessibilityState.disabled, true);
});

test('expired approvals cannot be reused', () => {
  const h = card({ approval: approval({ expiresAt: Date.now() - 1000 }) });
  assert.match(h.text(), /审批已过期/);
  assert.equal(h.button('允许一次本机审批').props.accessibilityState.disabled, true);
});
