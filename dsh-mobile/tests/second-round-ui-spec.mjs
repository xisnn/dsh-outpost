import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, loadSource } from './support/component-harness.mjs';
const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
const tokens = loadSource('design/tokens.ts');
const record = (state = 'unknown') => ({ requestId: 'same-request', state, text: '长提示词\n'.repeat(100), updatedAt: 0, attemptCount: state === 'unknown' ? 1 : 0, attachments: [], lastError: { classification: 'unknown' } });
const measure = (h, height) => { h.find(n => n.props.onLayout).props.onLayout({ nativeEvent: { layout: { height } } });h.render(); };

test('long pending text folds independently while status and original retry record stay available', () => {
  const original = record();let retried;
  const h = componentHarness('components/PendingSendBubble.tsx', 'PendingSendBubble', { record: original, onRetry: r => { retried = r; }, onRemove: () => assert.fail('unknown must not remove') });
  measure(h, 900);
  assert.equal(h.button('展开待发送全文').props.accessibilityState.expanded, false);
  assert.ok(h.nodes().some(n => flatten(n.props.style).maxHeight === tokens.motion.collapseThresholdPx));
  assert.match(h.text(), /结果未知，可能已在电脑执行/);
  assert.equal(h.button('移除待发送消息'), undefined);
  h.button('安全重试（复用原 ID）').props.onPress();assert.equal(retried, original);
  h.button('展开待发送全文').props.onPress();h.render();
  assert.equal(h.button('收起待发送全文').props.accessibilityState.expanded, true);
  assert.ok(!h.nodes().some(n => flatten(n.props.style).maxHeight === tokens.motion.collapseThresholdPx));
  assert.ok(h.text().includes(original.text), 'full original text remains available');
  h.render({ record: { ...original, state: 'accepted' } });
  assert.ok(h.button('收起待发送全文'), 'status update must not reset reading choice');
  assert.equal(h.button('安全重试（复用原 ID）'), undefined);
  assert.equal(h.button('移除待发送消息'), undefined);
});

test('short and attachment-only pending messages do not get a fold action; busy and removal semantics remain', () => {
  const original = { ...record('queued'), text: 'short', lastError: undefined };let removed;
  const h = componentHarness('components/PendingSendBubble.tsx', 'PendingSendBubble', { record: original, onRetry() {}, onRemove: r => { removed = r; } });
  measure(h, 24);assert.equal(h.button('展开待发送全文'), undefined);
  h.button('移除待发送消息').props.onPress();assert.equal(removed, original);
  h.render({ busy: true });
  assert.equal(h.button('移除待发送消息').props.disabled, true);
  assert.equal(h.button('继续发送').props.disabled, true);
  h.render({ record: { ...original, requestId: 'new-id', text: '' } });
  assert.equal(h.button('展开待发送全文'), undefined);
});

const normal = { id: 'normal', sessionId: 's', toolName: 'read', reason: '读取 README.md', input: { file_path: 'README.md' } };
const high = { id: 'high', sessionId: 's', toolName: 'bash', reason: 'rm -rf ./temporary-test-only' };
function approval(item, extra = {}) {
  return componentHarness('components/ApprovalBanner.tsx', 'ApprovalBanner', { approvals: [item], sessionId: 's', gatewayOnline: true, onAnswer() {}, ...extra });
}
function hasBackground(h, color) { return h.nodes().some(n => flatten(typeof n.props.style === 'function' ? n.props.style({ pressed: false }) : n.props.style).backgroundColor === color); }

test('approval cards stay neutral with risk accents and high-risk two-step authorization', () => {
  const normalView = approval(normal);assert.ok(hasBackground(normalView, normalView.theme.colors.bgRaised));
  assert.ok(hasBackground(normalView, normalView.theme.colors.warningWash), 'warning wash is limited to the risk summary');
  assert.match(normalView.text(), /需要授权/);assert.doesNotMatch(normalView.text(), /高危操作需要授权/);
  normalView.button('收起审批卡片').props.onPress();normalView.render();assert.ok(normalView.button('展开待审批：read'));
  assert.ok(hasBackground(normalView, normalView.theme.colors.bgRaised));
  assert.match(normalView.text(), /风险提示/);
  let sent = 0;
  const dangerView = approval(high, { onAnswer() { sent++; } });assert.ok(hasBackground(dangerView, dangerView.theme.colors.dangerWash));
  assert.match(dangerView.text(), /高危操作需要授权/);
  dangerView.button('允许一次').props.onPress();dangerView.render();assert.equal(sent, 0);
  assert.ok(dangerView.button('再次点击确认允许'));
  dangerView.button('再次点击确认允许').props.onPress();assert.equal(sent, 1);
});

test('approval styling leaves offline, identity and readonly guards intact', () => {
  for (const extra of [{ gatewayOnline: false }, { authInvalidated: true }, { authInvalidated: 'forbidden' }]) {
    const h = approval(normal, extra);assert.equal(h.button('允许一次'), undefined);assert.equal(h.button('拒绝'), undefined);
  }
  const unknown = approval({ ...normal, sessionId: undefined });assert.equal(unknown.button('允许一次'), undefined);assert.match(unknown.text(), /来源不明/);
  const readonly = approval(normal, { approvals: [], readonlyApprovals: [normal] });assert.equal(readonly.button('允许一次'), undefined);
});

test('approval reminder aggregates high-risk cue without treating all ordinary approvals as danger', () => {
  const h = componentHarness('components/ApprovalBanner.tsx', 'ApprovalReminderStrip', { approvals: [{ ...normal, rpcId: normal.id }], onOpenSession() {} });
  assert.ok(hasBackground(h, h.theme.colors.warningWash));assert.doesNotMatch(h.text(), /含高危/);
  h.render({ approvals: [{ ...high, rpcId: high.id }] });assert.ok(hasBackground(h, h.theme.colors.dangerWash));assert.match(h.text(), /含高危/);
});

test('confirmation uses shared hierarchy across all palettes and preserves exact callbacks', () => {
  let confirmed = 0, cancelled = 0;
  const h = componentHarness('components/ConfirmSheet.tsx', 'ConfirmSheet', { visible: true, title: '确认', onConfirm() { confirmed++; }, onCancel() { cancelled++; } }, { './MotionModal': { MotionModal: 'Modal' } });
  for (const colors of [tokens.lightPalette, tokens.warmPalette, tokens.darkPalette]) {
    h.theme.colors = colors;h.render();
    assert.equal(flatten(h.button('确定').props.style).backgroundColor, colors.accent);
    assert.equal(flatten(h.button('取消').props.style).minHeight, 44);
    assert.equal(flatten(h.button('取消').props.style).borderWidth, undefined);
    h.render({ destructive: true });assert.equal(flatten(h.button('确定').props.style).backgroundColor, colors.danger);
    h.render({ destructive: false });
  }
  h.button('确定').props.onPress();h.button('取消').props.onPress();assert.equal(confirmed, 1);assert.equal(cancelled, 1);
});
