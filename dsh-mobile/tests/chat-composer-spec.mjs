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
  let focused = false, tree;
  const theme = { ...tokens, colors: tokens.lightPalette };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useMemo: fn => fn(),
    useState: () => [focused, value => { focused = value; }],
  };
  const { ChatComposer } = load('components/ChatComposer.tsx', {
    react: { ...react, default: react },
    'react-native': { ...Object.fromEntries(['ActivityIndicator', 'Image', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])), Platform: { OS: 'android' }, StyleSheet: { create: value => value, hairlineWidth: 1 } },
    './MotionPressable': { MotionPressable: 'Pressable' },
    './FileTypeBadge': { FileTypeBadge: 'FileTypeBadge' },
    '../design/theme': { useTheme: () => theme },
    '../core/picker': { formatBytes: bytes => `${bytes} B` },
  });
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flat(Infinity).flatMap(nodes)];
  const render = (patch = {}) => { Object.assign(props, patch); tree = ChatComposer(props); return tree; };
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
