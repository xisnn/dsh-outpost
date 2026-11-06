import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, loadSource } from './support/component-harness.mjs';
const core = loadSource('core/approvalDock.ts');
const tokens = loadSource('design/tokens.ts');
const flatten = style => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
const styleOf = node => flatten(typeof node.props.style === 'function' ? node.props.style({ pressed: false }) : node.props.style);
const normal = { id: 'one', sessionId: 's', toolName: 'bash', reason: '核对本地构建结果', displayReason: {
  command: 'npm run verify -- ' + '--include=local-fixture '.repeat(40) + '--final-argument=keep-me',
  cwd: '/local/project/' + 'directory/'.repeat(30),
  environment: '{"mode":"fixture","complete":true}',
} };
const high = { id: 'high', sessionId: 's', toolName: 'bash', reason: 'rm -rf /local/fixture-only' };
function setup(patch = {}) {
  const controller = new core.ApprovalSubmitController();
  const sent = [];
  const h = componentHarness('components/ApprovalBanner.tsx', 'ApprovalBanner', {
    approvals: [normal], sessionId: 's', gatewayOnline: true,
    onAnswer: (item, outcome) => { sent.push([item, outcome]); return true; }, ...patch,
  }, { '../core/approvalDock': { ...core, ApprovalSubmitController: class { constructor() { return controller; } } } });
  return { h, sent, controller };
}
function click(h, label) { const button = h.button(label); assert.ok(button, label); button.props.onPress(); h.render(); }
function fullText(h, text) { return h.nodes().find(n => n.type === 'Text' && n.children.includes(text) && n.props.numberOfLines === undefined); }

test('approval summary identifies command, target and reason before allowing; details expose every full argument', () => {
  const { h, sent } = setup();
  assert.ok(h.text().includes(normal.displayReason.command));
  assert.ok(h.text().includes(normal.displayReason.cwd));
  assert.ok(h.text().includes(normal.reason));
  assert.equal(h.button('查看详情').props.accessibilityState.expanded, false);
  assert.equal(fullText(h, normal.displayReason.command), undefined);
  assert.ok(!h.text().includes(normal.displayReason.environment));
  assert.match(h.text(), /风险提示/);
  click(h, '查看详情');
  assert.equal(h.button('收起详情').props.accessibilityState.expanded, true);
  for (const text of Object.values(normal.displayReason)) {
    assert.equal(fullText(h, text)?.props.selectable, true, 'full original value is selectable without line limits');
  }
  assert.equal(fullText(h, normal.reason)?.props.selectable, true);
  click(h, '收起详情');
  assert.match(h.text(), /风险提示/);
  assert.equal(sent.length, 0, 'reading details never approves a request');
  click(h, '允许一次');
  assert.equal(sent.length, 1); assert.equal(sent[0][0], normal); assert.equal(sent[0][1], 'allowed-once');
  assert.equal(h.button('允许一次'), undefined, 'in-flight request cannot be submitted twice');
});

test('network request target is visible before opening details', () => {
  const request = { id: 'network', sessionId: 's', toolName: 'fetch', reason: '读取接口文档', displayReason: { url: 'https://docs.example.test/reference', method: 'GET' } };
  const { h, sent } = setup({ approvals: [request] });
  assert.match(h.text(), /请求目标/); assert.ok(h.text().includes(request.displayReason.url));
  assert.ok(h.button('查看详情')); assert.equal(sent.length, 0);
  click(h, '查看详情'); assert.equal(fullText(h, 'GET').props.selectable, true);
});

test('queue navigation and replacement ids close details without clearing submission errors', () => {
  const other = { ...normal, id: 'two', reason: '另一个请求' };
  const { h } = setup({ approvals: [normal, other], onAnswer: () => false });
  click(h, '查看详情'); click(h, '允许一次');
  assert.match(h.text(), /未能送达电脑/);
  click(h, '收起详情'); assert.match(h.text(), /未能送达电脑/);
  click(h, '查看详情'); click(h, '下一条待审批');
  assert.equal(h.button('查看详情').props.accessibilityState.expanded, false);
  click(h, '查看详情'); click(h, '上一条待审批');
  assert.ok(h.button('查看详情')); assert.match(h.text(), /未能送达电脑/);
  click(h, '查看详情');
  h.render({ approvals: [{ ...normal, id: 'replacement' }] });
  assert.ok(h.button('查看详情'), 'new request at same queue index starts with closed details');
});

test('high risk stays visible with details closed and card collapsed; allow arms first and reject sends immediately', () => {
  const { h, sent } = setup({ approvals: [high] });
  const reason = core.assessApprovalRisk(high).riskReasons[0];
  assert.ok(h.text().includes(reason));
  click(h, '允许一次'); assert.equal(sent.length, 0); assert.ok(h.button('再次点击确认允许'));
  click(h, '收起审批卡片'); assert.ok(h.text().includes(reason));
  click(h, '展开高危待审批：bash'); assert.ok(h.button('允许一次'), 'card collapse disarms');
  click(h, '允许一次'); click(h, '再次点击确认允许');
  assert.equal(sent.length, 1); assert.equal(sent[0][1], 'allowed-once');
  const rejected = setup({ approvals: [high] }); click(rejected.h, '拒绝');
  assert.equal(rejected.sent.length, 1); assert.equal(rejected.sent[0][1], 'rejected');
});

test('neutral token surfaces, vertical full-width decisions and bounded scroll survive every palette', () => {
  const { h } = setup();
  for (const colors of [tokens.lightPalette, tokens.warmPalette, tokens.darkPalette]) {
    h.theme.colors = colors; h.render();
    const card = h.find(n => n.type === 'View' && n.children.some(c => c?.props?.style && flatten(c.props.style).alignItems === 'stretch'));
    assert.equal(styleOf(card).backgroundColor, colors.bgRaised);
    const actionRow = h.find(n => n.type === 'View' && n.children.includes(h.button('允许一次')));
    assert.notEqual(styleOf(actionRow).flexDirection, 'row'); assert.equal(styleOf(actionRow).alignItems, 'stretch');
    assert.deepEqual(actionRow.children.map(n => n.props.accessibilityLabel), ['允许一次', '拒绝']);
    for (const label of ['允许一次', '拒绝', '查看详情']) assert.ok(styleOf(h.button(label)).minHeight >= 44);
    assert.equal(styleOf(h.button('允许一次')).backgroundColor, colors.accent);
    assert.equal(styleOf(h.button('拒绝')).backgroundColor, colors.bgCard);
    const scroll = h.find(n => n.type === 'ScrollView');
    assert.ok(styleOf(scroll).maxHeight <= 240);
    assert.ok(!scroll.children.flat(Infinity).includes(h.button('允许一次')), 'decisions stay outside scrolling content');
    assert.doesNotMatch(h.text(), /始终允许|永久允许/);
  }
});

test('unknown session, readonly, offline and auth failures expose no approval decisions', () => {
  for (const [patch, message] of [
    [{ approvals: [{ ...normal, sessionId: undefined }] }, /来源不明/],
    [{ approvals: [], readonlyApprovals: [normal] }, /来自会话记录/],
    [{ gatewayOnline: false }, /审批通道还没连上/],
    [{ authInvalidated: true }, /401/],
    [{ authInvalidated: 'forbidden' }, /403.*凭据已保留/],
  ]) {
    const { h, sent } = setup(patch);
    assert.equal(h.button('允许一次'), undefined); assert.equal(h.button('拒绝'), undefined);
    assert.match(h.text(), message); click(h, '查看详情'); assert.equal(sent.length, 0);
  }
});

test('other sessions remain jump entries and never enter the current approval queue', () => {
  let opened;
  const elsewhere = { ...high, id: 'elsewhere', sessionId: 'other' };
  const { h, sent } = setup({ approvals: [normal, elsewhere], sessions: [{ sessionId: 'other', projections: { values: { title: '其他任务' } } }], onOpenSession: (...args) => { opened = args; } });
  assert.equal(h.button('下一条待审批'), undefined);
  click(h, '其他会话待审批：其他任务，共 1 个，点击前往');
  assert.deepEqual(opened, ['other', '其他任务']); assert.equal(sent.length, 0);
  click(h, '拒绝'); assert.equal(sent[0][0], normal);
});

test('unknown result locks both actions through detail toggles until authoritative replay', () => {
  const { h, controller, sent } = setup();
  click(h, '允许一次');
  controller.reconcile({ serverPendingIds: new Set([normal.id]), gatewayOnline: false });
  h.render(); assert.match(h.text(), /结果未知/);
  assert.equal(h.button('允许一次'), undefined); assert.equal(h.button('拒绝'), undefined);
  click(h, '查看详情'); click(h, '收起详情'); assert.match(h.text(), /结果未知/);
  click(h, '收起审批卡片'); assert.match(h.text(), /结果未知/);
  click(h, '展开待审批：bash'); assert.equal(sent.length, 1);
  controller.reconcile({ serverPendingIds: new Set([normal.id]), gatewayOnline: true, authoritativePendingAt: new Map([[normal.id, Date.now() + 1]]) });
  h.render(); assert.ok(h.button('允许一次')); assert.match(h.text(), /权威重放/);
});
