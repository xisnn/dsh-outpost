import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, loadSource } from './support/component-harness.mjs';
const tokens = loadSource('design/tokens.ts');
const secret1 = 'sk-' + 'FabricatedScreenOnly0123456789';
const secret2 = 'ghp_' + 'FabricatedScreenOnly9876543210';
const original = `保留这段文字\n${secret1}\n第二处 ${secret2}\n结束`;
const flushStyle = value => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));

// Small effect-aware renderer for disclosure lifecycle; native layout is checked separately.
function harness(file, exported, initialProps = {}, extra = {}) {
  let props = initialProps, cursor = 0, dirty = false, dead = false, tree;
  const slots = [], effects = [], listeners = new Set();
  const env = { state: 'active' };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    createElement: (type, attributes, ...children) => ({ type, props: attributes || {}, children }),
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useState(initial) {
      const i = cursor++; slots[i] ??= { value: initial };
      return [slots[i].value, value => { assert.equal(dead, false, 'no state updates after unmount'); slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; dirty = true; }];
    },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  react.default = react;
  const native = { ...Object.fromEntries(['Text', 'View', 'ActivityIndicator'].map(name => [name, name])),
    StyleSheet: { create: value => value, hairlineWidth: 1, absoluteFill: {} },
    AppState: { get currentState() { return env.state; }, addEventListener(_name, fn) { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } },
  };
  const theme = { ...tokens, colors: tokens.lightPalette };
  const modules = { react, 'react-native': native, '../design/theme': { useTheme: () => theme },
    './MotionPressable': { MotionPressable: 'Pressable' }, './MotionModal': { MotionModal: 'Modal' },
    './Attachment': { AttachmentGallery: 'AttachmentGallery' }, './AssistantRichText': { AssistantRichText: 'AssistantRichText' }, ...extra };
  modules['./CredentialText'] = loadSource('components/CredentialText.tsx', modules);
  const Component = loadSource(file, modules)[exported];
  function render(patch = {}) {
    props = { ...props, ...patch };
    for (let count = 0; count < 10; count++) {
      dirty = false; cursor = 0; tree = Component(props);
      while (effects.length) effects.shift()();
      if (!dirty) return tree;
    }
    throw Error('Unsettled component render');
  }
  function nodes(node = tree) {
    if (!node || typeof node !== 'object') return [];
    if (typeof node.type === 'function') return nodes(node.type({ ...node.props, children: node.children }));
    return [node, ...node.children.flat(Infinity).flatMap(child => nodes(child))];
  }
  render();
  return { render, theme, nodes, env,
    text: () => nodes().filter(n => n.type === 'Text').map(n => n.children.flat(Infinity).filter(c => typeof c === 'string').join('')).join('\n'),
    button: label => nodes().find(n => n.props.accessibilityLabel === label),
    emit(state) { env.state = state; for (const fn of [...listeners]) fn(state); },
    listenerCount: () => listeners.size,
    unmount() { for (const slot of slots) slot?.cleanup?.(); dead = true; },
  };
}
const user = props => harness('components/Message.tsx', 'UserBubble', { text: original, displayScope: 's:a', ...props });

test('history masks every recognized credential in rendered and accessibility text, preserving original long press', () => {
  let selected;
  const h = user({ onLongPress: value => { selected = value; } });
  assert.ok(!h.text().includes(secret1) && !h.text().includes(secret2));
  assert.match(h.text(), /凭据 1 已隐藏/); assert.match(h.text(), /凭据 2 已隐藏/);
  assert.match(h.text(), /保留这段文字/);
  for (const node of h.nodes()) for (const name of ['accessibilityLabel', 'accessibilityHint']) {
    assert.ok(!String(node.props[name]).includes(secret1));
    assert.ok(!String(node.props[name]).includes(secret2));
  }
  h.nodes().find(n => n.props.onLongPress).props.onLongPress(); assert.equal(selected, original);
  for (const palette of [tokens.lightPalette, tokens.warmPalette, tokens.darkPalette]) {
    h.theme.colors = palette; h.render();
    assert.ok(flushStyle(h.button('显示第 1 处凭据').props.style).minHeight >= 44);
    assert.equal(flushStyle(h.button('显示第 1 处凭据').props.style).borderWidth, undefined);
  }
});

test('reveals one selected range and re-hides it without exposing other ranges or firing bubble actions', () => {
  let longPress = 0; const h = user({ onLongPress: () => longPress++ });
  h.button('显示第 1 处凭据').props.onPress(); h.render();
  assert.ok(h.text().includes(secret1)); assert.ok(!h.text().includes(secret2));
  assert.equal(h.button('隐藏第 1 处凭据').props.accessibilityState.expanded, true);
  h.button('隐藏第 1 处凭据').props.onPress(); h.render();
  assert.ok(!h.text().includes(secret1)); assert.equal(longPress, 0);
});

test('new message text, identity and hidden navigation reset disclosure immediately', () => {
  const h = user();
  const show = () => { h.button('显示第 1 处凭据').props.onPress(); h.render(); assert.ok(h.text().includes(secret1)); };
  show(); const stale = h.button('隐藏第 1 处凭据').props.onPress;
  h.render({ displayScope: 's:b' }); stale(); h.render(); assert.ok(!h.text().includes(secret1));
  show(); h.render({ text: secret2 }); h.render({ text: original }); assert.ok(!h.text().includes(secret1));
  show(); h.render({ allowReveal: false }); assert.ok(!h.text().includes(secret1));
  assert.equal(h.button('显示第 1 处凭据'), undefined);
  h.render({ allowReveal: true }); assert.ok(!h.text().includes(secret1));
});

test('inactive/background clears disclosure and rejects stale presses; foreground and unmount stay safe', () => {
  const h = user();
  assert.equal(h.listenerCount(), 1);
  h.button('显示第 1 处凭据').props.onPress(); h.render();
  const stale = h.button('隐藏第 1 处凭据').props.onPress;
  h.emit('inactive'); h.render(); assert.ok(!h.text().includes(secret1));
  h.emit('active'); stale(); h.render(); assert.ok(!h.text().includes(secret1));
  h.button('显示第 1 处凭据').props.onPress(); h.render(); assert.ok(h.text().includes(secret1));
  h.emit('background'); h.render(); assert.ok(!h.text().includes(secret1));
  h.emit('active'); h.render(); const after = h.button('显示第 1 处凭据').props.onPress;
  h.unmount(); assert.equal(h.listenerCount(), 0); after();
});

test('ordinary and pure attachment user messages keep their presentation and create no AppState listeners', () => {
  const h = user({ text: '普通文本' }); assert.equal(h.text(), '普通文本'); assert.equal(h.listenerCount(), 0);
  h.render({ text: '', sessionId: 's', api: {}, parts: [{ type: 'file', id: 'f' }] });
  assert.equal(h.text(), ''); assert.ok(h.nodes().some(n => n.type === 'AttachmentGallery'));
  assert.equal(h.listenerCount(), 0);
});

test('pending text stays masked while safety retry receives the unchanged original record', () => {
  const record = { requestId: 'credential-test-only', text: original, state: 'unknown', attemptCount: 1, updatedAt: 0, attachments: [], lastError: { classification: 'unknown' } };
  let retried;
  const h = componentHarness('components/PendingSendBubble.tsx', 'PendingSendBubble', { record, onRetry: value => { retried = value; }, onRemove: () => assert.fail('unknown removal') });
  assert.ok(!h.text().includes(secret1) && !h.text().includes(secret2));
  assert.match(h.text(), /凭据 1 已隐藏/); assert.match(h.text(), /结果未知/);
  assert.equal(h.button('显示第 1 处凭据'), undefined); assert.equal(h.button('移除待发送消息'), undefined);
  h.button('安全重试（复用原 ID）').props.onPress(); assert.equal(retried, record); assert.equal(retried.text, original);
  h.render({ record: { ...record, state: 'accepted' } }); assert.equal(h.button('安全重试（复用原 ID）'), undefined);
});

function sheet(text = original, write = () => true) {
  const copied = []; const h = harness('components/MessageActionSheet.tsx', 'MessageActionSheet', { visible: true, text, onClose() {} }, {
    './clipboard': { copyTextToClipboard(value) { copied.push(value); return write(value); } },
    './LocalExportPanel': { LocalExportPanel: 'LocalExportPanel' },
  });
  return { ...h, copied };
}

test('copy preview masks before shortening, with separate exact original and hidden copy payloads', () => {
  const h = sheet('x'.repeat(80) + ' ' + secret1 + '\r\n' + secret2);
  assert.ok(!h.text().includes(secret1.slice(0, 8))); assert.ok(!h.text().includes(secret2));
  h.button('复制隐藏后文本').props.onPress(); h.render();
  assert.ok(!h.copied[0].includes(secret1) && !h.copied[0].includes(secret2));
  assert.match(h.copied[0], /凭据 1 已隐藏/); assert.ok(h.copied[0].includes('\r\n'));
  assert.match(h.text(), /已复制隐藏后文本/);
  h.button('复制原文（含凭据）').props.onPress(); h.render();
  assert.equal(h.copied[1], 'x'.repeat(80) + ' ' + secret1 + '\r\n' + secret2);
  assert.match(h.text(), /已复制原文/);
});

test('ordinary copy keeps existing action and failed clipboard writes never show success', () => {
  const plain = sheet('hello\n world'); assert.equal(plain.button('复制隐藏后文本'), undefined);
  plain.button('复制全文').props.onPress(); assert.equal(plain.copied[0], 'hello\n world');
  const failed = sheet(original, () => false); failed.button('复制隐藏后文本').props.onPress(); failed.render();
  assert.doesNotMatch(failed.text(), /已复制隐藏后文本/);
  failed.button('复制原文（含凭据）').props.onPress(); failed.render(); assert.doesNotMatch(failed.text(), /已复制原文/);
});
