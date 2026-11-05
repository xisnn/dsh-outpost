// Run actual component handlers with controlled native boundaries; not a layout renderer.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import assert from 'node:assert/strict';
const sourceRoot = new URL('../../src/', import.meta.url);
export function loadSource(file, modules = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(file, sourceRoot), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.React },
  }).outputText;
  vm.runInNewContext(code, { exports, console,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    require(name) {
    if (name in modules) return modules[name];
    assert.ok(name.startsWith('.'), `Unmocked native dependency: ${name}`);
    return loadSource(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)) + '.ts', modules);
  } });
  return exports;
}
const tokens = loadSource('design/tokens.ts');
export function componentHarness(file, exported, initialProps, extraModules = {}) {
  const slots = [], refs = [];
  let cursor = 0, refCursor = 0, props = { ...initialProps }, tree;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useMemo: fn => fn(), useEffect() {},
    useRef(value) { const index = refCursor++; return refs[index] ??= { current: value }; },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
  };
  react.default = react;
  const theme = { ...tokens, colors: tokens.lightPalette };
  const native = { ...Object.fromEntries(['ActivityIndicator', 'Image', 'ScrollView', 'Text', 'View'].map(name => [name, name])),
    StyleSheet: { create: value => value, hairlineWidth: 1 }, Platform: { OS: 'android', select: values => values.android ?? values.default },
    Animated: { Value: class { interpolate() { return 0; } }, View: 'Animated.View' },
    useWindowDimensions: () => ({ width: 360, height: 800 }),
  };
  const modules = { react, 'react-native': native, '../design/theme': { useTheme: () => theme },
    '../design/useReduceMotion': { useReduceMotion: () => false },
    './MotionPressable': { MotionPressable: 'Pressable' },
    './ui': { Collapse: 'Collapse' }, './ToolOutputViewer': { ToolOutputViewer: 'ToolOutputViewer' },
    ...extraModules,
  };
  modules['./FileTypeBadge'] = loadSource('components/FileTypeBadge.tsx', modules);
  modules['./CredentialText'] = loadSource('components/CredentialText.tsx', modules);
  const Component = loadSource(file, modules)[exported];
  function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    if (typeof node.type === 'function') return nodes(node.type({ ...node.props, children: node.children }));
    if (node.type === 'Collapse' && !node.props.open) return [];
    return [node, ...node.children.flat(Infinity).flatMap(nodes)];
  }
  const render = (patch = {}) => { props = { ...props, ...patch }; cursor = 0; refCursor = 0; tree = Component(props); return tree; };
  render();
  return { render, theme, nodes: () => nodes(tree),
    find: predicate => nodes(tree).find(predicate),
    button: label => nodes(tree).find(node => node.props.accessibilityLabel === label),
    text: () => nodes(tree).filter(node => node.type === 'Text').map(node => node.children.filter(child => typeof child !== 'object').join('')).join('\n'),
  };
}
