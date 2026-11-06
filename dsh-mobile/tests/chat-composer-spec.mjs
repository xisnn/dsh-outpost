import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, modules) {
  const code = ts.transpileModule(fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: name => {
    assert.ok(name in modules, 'Unexpected import: ' + name);
    return modules[name];
  } });
  return exports;
}
const tokens = load('design/tokens.ts', {});
function harness(patch = {}) {
  const props = { value: '', attachments: [], sending: false, uploading: false, running: false, maxLength: 100, ...patch };
  const calls = [];
  for (const key of ['onChangeText', 'onAddAttachment', 'onRemoveAttachment', 'onSend', 'onStop']) {
    props[key] = (...args) => calls.push([key, ...args]);
  }
  let cursor = 0, memoCursor = 0, refCursor = 0, tree;
  const states = [], memos = [], refs = [];
  const theme = { ...tokens, colors: tokens.lightPalette };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useMemo(fn, deps) {
      const i = memoCursor++, old = memos[i];
      if (!old || old.deps.length !== deps.length || deps.some((d, j) => !Object.is(d, old.deps[j]))) memos[i] = { deps, value: fn() };
      return memos[i].value;
    },
    useEffect() {},
    useRef(value) { return refs[refCursor++] ??= { current: value }; },
    useState(initial) {
      const i = cursor++; states[i] ??= { value: initial };
      return [states[i].value, value => { states[i].value = typeof value === 'function' ? value(states[i].value) : value; }];
    },
  };
  const { ChatComposer } = load('components/ChatComposer.tsx', {
    react: { ...react, default: react },
    'react-native': { ...Object.fromEntries(['ActivityIndicator', 'Image', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])), Platform: { OS: 'android' }, useWindowDimensions: () => ({fontScale: 1}), StyleSheet: { create: value => value, hairlineWidth: 1 } },
    './MotionPressable': { MotionPressable: 'Pressable' },
    './FileTypeBadge': { FileTypeBadge: 'FileTypeBadge' },
    '../design/theme': { useTheme: () => theme },
    '../core/picker': { formatBytes: bytes => `${bytes} B` },
  });
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flat(Infinity).flatMap(nodes)];
  const render = (patch = {}) => { Object.assign(props, patch); cursor = memoCursor = refCursor = 0; tree = ChatComposer(props); return tree; };
  render();
  return { props, calls, render, theme,
    find: predicate => nodes(tree).find(predicate),
    button: label => nodes(tree).find(node => node.props.accessibilityLabel === label),
    text: () => nodes(tree).filter(node => node.type === 'Text').map(node => node.children.join('')).join(' '),
  };
}

test('composer forwards CJK multiline drafts without sending and respects empty/attachment send states', () => {
  const h = harness();
  assert.equal(h.button('发送消息').props.disabled, true);
  assert.equal(h.button('发送消息').props.accessibilityRole, 'button');
  assert.equal(h.button('发送消息').props.accessibilityState.disabled, true);
  const input = h.find(node => node.type === 'TextInput');
  input.props.onChangeText('中文输入\n第二行');
  assert.deepEqual(h.calls, [['onChangeText', '中文输入\n第二行']]);
  assert.equal(input.props.multiline, true);
  h.render({ value: '   ' });
  assert.equal(h.button('发送消息').props.disabled, true);
  h.render({ value: '中文输入\n第二行' });
  assert.equal(h.button('发送消息').props.disabled, false);
  h.button('发送消息').props.onPress();
  assert.equal(h.calls.at(-1)[0], 'onSend');
});

test('compact input expands for wrapping without a height loop, then contracts after shortening; other send states stay complete', () => {
  const h = harness({value: 'a short draft'});
  h.render().props.onLayout({nativeEvent: {layout: {width: 320}}}); h.render();
  assert.ok(!h.text().includes('添加'));
  h.find(n => n.type === 'TextInput').props.onContentSizeChange({nativeEvent: {contentSize: {height: 70}}}); h.render();
  assert.ok(h.text().includes('添加'));
  // A full-width input now fits one line; it must not trigger a collapse loop.
  h.find(n => n.type === 'TextInput').props.onContentSizeChange({nativeEvent: {contentSize: {height: 33}}}); h.render();
  assert.ok(h.text().includes('添加'));
  h.render({value: 'short'}); assert.ok(!h.text().includes('添加'));
  h.render({value: '第一行\n第二行'}); assert.ok(h.text().includes('添加'));
  h.render({value: '', uploading: true}); assert.ok(h.text().includes('添加'));
  h.render({uploading: false, running: true}); assert.ok(h.button('插话到当前轮')); assert.ok(h.button('打断当前回复'));
  assert.equal(h.calls.length, 0, 'Layout changes never send or mutate the controlled draft');
});

test('running selection forwards steer for this message and resets the next message to queue', () => {
  const h = harness({ running: true, value: '先检查配置' });
  assert.equal(h.button('下一轮处理').props.accessibilityState.checked, true);
  h.button('插话到当前轮').props.onPress(); h.render();
  assert.equal(h.button('插话到当前轮').props.accessibilityState.checked, true);
  assert.match(h.text(), /不会强停/);
  h.button('发送消息').props.onPress();
  assert.deepEqual(h.calls.at(-1), ['onSend', 'steer']);
  h.button('发送消息').props.onPress();
  assert.equal(h.calls.filter(c => c[0] === 'onSend').length, 1, 'Same-frame double tap cannot duplicate send');
  h.render({ value: '下一条' });
  assert.equal(h.button('下一轮处理').props.accessibilityState.checked, true);
  h.button('发送消息').props.onPress();
  assert.deepEqual(h.calls.at(-1), ['onSend', 'queue']);
});

test('scope changes, end of run and disabled ownership invalidate old mode and send handlers', () => {
  const h = harness({ running: true, value: '中文', sendScope: {} });
  h.button('插话到当前轮').props.onPress(); h.render();
  const oldSend = h.button('发送消息').props.onPress;
  const oldSelect = h.button('插话到当前轮').props.onPress;
  h.render({ sendScope: {} });
  oldSend(); oldSelect(); h.render();
  assert.equal(h.calls.length, 0);
  assert.equal(h.button('下一轮处理').props.accessibilityState.checked, true);
  h.button('插话到当前轮').props.onPress(); h.render();
  h.render({ running: false });
  assert.equal(h.button('插话到当前轮'), undefined);
  h.button('发送消息').props.onPress();
  assert.deepEqual(h.calls.at(-1), ['onSend', 'queue']);
  h.render({ running: true, enabled: false });
  assert.equal(h.button('发送消息').props.disabled, true);
  h.button('发送消息').props.onPress();
  assert.equal(h.calls.length, 1);
});

test('sending locks mode changes and pure attachments can be sent as steer', () => {
  const h = harness({ running: true, attachments: [{ id: 'f', kind: 'file', name: '文档.txt', uri: 'content://f' }] });
  h.button('插话到当前轮').props.onPress(); h.render();
  h.render({ sending: true });
  assert.equal(h.button('插话到当前轮').props.disabled, true);
  h.button('下一轮处理').props.onPress(); h.render();
  assert.equal(h.button('插话到当前轮').props.accessibilityState.checked, true);
  h.render({ sending: false }); h.button('发送消息').props.onPress();
  assert.deepEqual(h.calls.at(-1), ['onSend', 'steer']);
});

test('mixed attachments remain controlled and each removal identifies the original attachment', () => {
  const attachments = [
    { id: 'image-1', kind: 'image', uri: 'content://local/image', name: '预览.png', size: 12 },
    { id: 'file-1', kind: 'file', uri: 'content://local/document', name: '一个很长的验收报告最终修订版.docx', size: 30 },
  ];
  const h = harness({ attachments });
  assert.equal(h.button('发送消息').props.disabled, false, 'Pure attachments can still be sent');
  assert.equal(h.find(node => node.type === 'Image').props.source.uri, attachments[0].uri);
  assert.equal(h.find(node => node.type === 'FileTypeBadge').props.name, attachments[1].name);
  assert.ok(h.find(node => node.type === 'Text' && node.children.includes(attachments[1].name)).props.ellipsizeMode === 'middle');
  h.button('移除 ' + attachments[1].name).props.onPress();
  assert.deepEqual(h.calls, [['onRemoveAttachment', 'file-1']]);
  assert.equal(attachments.length, 2, 'The surface never mutates the owner draft array');
  h.render({ attachments: [] });
  assert.equal(h.button('发送消息').props.disabled, true);
});

test('sending locks add/send, keeps stop available, and preserves the draft limit and focus styling', () => {
  const h = harness({ value: 'x'.repeat(100), sending: true, uploading: true, running: true });
  assert.equal(h.button('发送消息').props.accessibilityState.busy, true);
  assert.equal(h.button('发送消息').props.disabled, true);
  assert.equal(h.button('添加附件').props.disabled, true);
  h.button('打断当前回复').props.onPress();
  assert.deepEqual(h.calls, [['onStop']]);
  assert.match(h.text(), /已达 100 字草稿上限/);
  const input = h.find(node => node.type === 'TextInput');
  assert.equal(input.props.maxLength, 100);
  assert.equal(input.props.placeholder, '正在上传附件…');
  input.props.onFocus();
  assert.equal(h.render().props.style[1].borderColor, h.theme.colors.accentDim);
  h.find(node => node.type === 'TextInput').props.onBlur();
  assert.equal(h.render().props.style[1], null);
  h.render({ sending: false, uploading: false, running: false });
  assert.equal(h.button('打断当前回复'), undefined);
  h.button('添加附件').props.onPress();
  assert.equal(h.calls.at(-1)[0], 'onAddAttachment');
});
