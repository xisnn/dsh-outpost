// Exercise actual TSX with controlled hooks and Animated completions; no native runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// ToolCard 现在共用真实的状态判定模块。这里注入**真实实现**而不是桩，
// 免得 motion 用例跑在一个和产品不同的状态逻辑上。
//
// ⚠️ 不能在运行时直接加载 ../src/core/toolStatus.ts：本文件在链里由
// `node --test` 启动，Node 20 不认 .ts 扩展名（ERR_UNKNOWN_FILE_EXTENSION），
// 而 Node 24 有原生类型剥离 —— 会变成「本地过、CI 挂」。
// 因此按本文件加载 TSX 的同一套办法：转译后在 vm 里求值。
const toolStatusModule = (() => {
  const src = readFileSync(new URL('../src/core/toolStatus.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(src, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  // toolStatus.ts 只有 type-only import，转译后不产生 require
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
})();

const MOTION = { press: 100, enter: 160, exit: 120, layout: 240, navigation: 240 };
const source = name => readFileSync(new URL('../src/components/' + name, import.meta.url), 'utf8');
function load(name, modules, extra = '') {
  const code = ts.transpileModule(source(name), { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code + extra, { exports, require(name) {
    assert.ok(name in modules, 'Unexpected import: ' + name);
    return modules[name];
  } });
  return exports;
}

function harness(name = 'MotionCollapse.tsx', extra = '') {
  const slots = [], pendingEffects = [], runs = [], loops = [];
  let cursor = 0, dirty = false, tree, props, Component, reduced = false, updates = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = value;
      return [slots[i], next => {
        const value = typeof next === 'function' ? next(slots[i]) : next;
        if (!Object.is(slots[i], value)) { slots[i] = value; dirty = true; updates += 1; }
      }];
    },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useLayoutEffect(fn, deps) {
      const i = cursor++;
      if (same(slots[i]?.deps, deps)) return;
      pendingEffects.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  react.useEffect = react.useLayoutEffect;
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
    interpolate(config) { return { value: this, config }; }
  }
  const Animated = {
    Value, View: 'Animated.View', timing: (value, config) => ({ value, ...config }),
    parallel(parts) {
      const run = {
        parts, stopped: false,
        start(cb) { this.cb = cb; this.from = parts.map(p => p.value.value); runs.push(this); },
        stop() { this.stopped = true; this.cb?.({ finished: false }); },
        advance(fraction) { parts.forEach((p, i) => p.value.setValue(this.from[i] + (p.toValue - this.from[i]) * fraction)); },
        finish() { this.advance(1); this.cb({ finished: true }); },
        staleFinish() { this.cb({ finished: true }); },
      };
      return run;
    },
    sequence: parts => parts, delay: duration => ({ duration }),
    loop() {
      const loop = { started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; } };
      loops.push(loop);
      return loop;
    },
  };
  const exports = load(name, {
    react: { ...react, default: react },
    'react-native': { Animated, View: 'View', Text: 'Text', StyleSheet: { create: x => x },
      Easing: { in: x => x, out: x => x, quad: 'quad', ease: 'ease' } },
    '../design/motion': { MOTION, useMotionPreference: () => reduced },
    '../design/useReduceMotion': { useReduceMotion: () => reduced },
    '../design/theme': { useTheme: () => ({}) },
    '../design/tokens': { motion: { thinkingCycleMs: 1600 }, toolMeta: () => ({}) },
    '../core/toolDiff': {}, './ui': { Collapse: 'Collapse' },
    '../core/toolStatus': toolStatusModule,
    './MotionPressable': { MotionPressable: 'Pressable' }, './ToolOutputViewer': {},
  }, extra);
  Component = exports.MotionCollapse || exports.Decoration;
  const api = {
    runs, loops,
    get tree() { return tree; }, get updates() { return updates; },
    render(next = props) {
      props = next;
      let renders = 0;
      do {
        assert.ok(++renders < 10, 'render loop');
        dirty = false; cursor = 0;
        tree = Component(props);
        while (pendingEffects.length) pendingEffects.shift()();
      } while (dirty);
      return tree;
    },
    measure(height) {
      tree.children[0].props.onLayout({ nativeEvent: { layout: { height } } });
      return api.render();
    },
    reduce(value) { reduced = value; return props === undefined ? undefined : api.render(); },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); tree = null; },
    get height() { return tree.props.style[1].height.value; },
    get opacity() { return tree.props.style[1].opacity.value; },
  };
  return api;
}

let pass = 0;
function check(name, fn) { fn(); pass += 1; console.log('PASS ' + name); }
const body = { control: 'selectable content and viewer trigger' };

check('default-open history mount measures immediately without entering', () => {
  const h = harness();
  h.render({ children: body }); h.measure(120);
  assert.equal(h.height, 120); assert.equal(h.opacity, 1);
  assert.equal(h.runs.length, 0);
  assert.equal(h.tree.props.pointerEvents, 'auto');
  assert.equal(h.tree.props.accessibilityElementsHidden, false);
});

check('closed mount is lazy; opening waits for a fresh natural-height measurement', () => {
  const h = harness();
  assert.equal(h.render({ open: false, children: body }), null);
  h.render({ open: true, children: body });
  assert.equal(h.runs.length, 0); assert.equal(h.height, 0);
  h.measure(160);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].parts[0].toValue, 160);
  assert.equal(h.runs[0].parts[0].duration, MOTION.layout);
  assert.equal(h.runs[0].parts[1].duration, MOTION.enter);
  assert.ok(h.runs[0].parts.every(p => !p.useNativeDriver));
  h.runs[0].finish(); h.render();
  assert.equal(h.height, 160); assert.equal(h.opacity, 1);
});

check('close retains children until completion and immediately blocks touch and accessibility', () => {
  const h = harness();
  h.render({ open: true, children: body }); h.measure(120);
  h.render({ open: false, children: body });
  assert.equal(h.tree.children[0].children[0], body);
  assert.equal(h.tree.props.pointerEvents, 'none');
  assert.equal(h.tree.props.accessibilityElementsHidden, true);
  assert.equal(h.tree.props.importantForAccessibility, 'no-hide-descendants');
  assert.equal(h.tree.props['aria-hidden'], true);
  assert.equal(h.runs[0].parts[1].duration, MOTION.exit);
  h.runs[0].advance(0.5);
  assert.equal(h.height, 60); assert.equal(h.opacity, 0.5);
  h.runs[0].finish();
  assert.equal(h.render(), null);
});

check('rapid reversal continues from current values and ignores stale close completion', () => {
  const h = harness();
  h.render({ open: true, children: body }); h.measure(120);
  h.render({ open: false, children: body });
  const closing = h.runs.at(-1); closing.advance(0.5);
  h.render({ open: true, children: body });
  assert.equal(closing.stopped, true);
  assert.equal(h.height, 60); assert.equal(h.opacity, 0.5);
  closing.staleFinish(); h.render();
  assert.ok(h.tree); assert.equal(h.height, 60);
  h.runs.at(-1).finish(); h.render();
  assert.equal(h.height, 120); assert.equal(h.opacity, 1);
  h.render({ open: false, children: body });
  h.runs.at(-1).finish(); assert.equal(h.render(), null);
});

check('closing an in-progress opening reverses without resetting to full height', () => {
  const h = harness();
  h.render({ open: false, children: body });
  h.render({ open: true, children: body }); h.measure(200);
  const opening = h.runs.at(-1); opening.advance(0.25);
  h.render({ open: false, children: body });
  assert.equal(h.height, 50); assert.equal(h.opacity, 0.25);
  opening.staleFinish(); assert.equal(h.height, 50);
  h.runs.at(-1).finish(); assert.equal(h.render(), null);
});

check('streaming and nested size changes update directly without per-token transitions', () => {
  const h = harness();
  h.render({ open: false, children: body });
  h.render({ open: true, children: body }); h.measure(80);
  const opening = h.runs[0]; opening.advance(0.5);
  h.measure(100);
  assert.equal(opening.stopped, true);
  for (const size of [101, 110, 160, 70]) {
    h.measure(size); assert.equal(h.height, size); assert.equal(h.opacity, 1);
  }
  assert.equal(h.runs.length, 1);
  opening.staleFinish(); assert.equal(h.height, 70);
  h.render({ open: true, children: 'new text' });
  assert.equal(h.runs.length, 1);
});

check('reopening a completed close measures changed content instead of reusing stale height', () => {
  const h = harness();
  h.render({ open: true, children: body }); h.measure(100);
  h.render({ open: false, children: body }); h.runs.at(-1).finish(); h.render();
  h.render({ open: true, children: 'longer content' });
  assert.equal(h.runs.length, 1);
  h.measure(300);
  assert.equal(h.runs.at(-1).parts[0].toValue, 300);
});

check('reduced motion settles open and closed immediately, including preference changes mid-transition', () => {
  const h = harness();
  h.render({ open: false, children: body }); h.reduce(true);
  h.render({ open: true, children: body }); h.measure(100);
  assert.equal(h.height, 100); assert.equal(h.opacity, 1); assert.equal(h.runs.length, 0);
  assert.equal(h.render({ open: false, children: body }), null);
  h.reduce(false); h.render({ open: true, children: body }); h.measure(150);
  const opening = h.runs.at(-1); opening.advance(0.3);
  h.reduce(true);
  assert.equal(opening.stopped, true); assert.equal(h.height, 150); assert.equal(h.opacity, 1);
  h.reduce(false); h.render({ open: false, children: body });
  const closing = h.runs.at(-1); closing.advance(0.5);
  assert.equal(h.reduce(true), null);
  closing.staleFinish(); assert.equal(h.render(), null);
});

check('unmount stops pending animation and prevents stale completion from setting state', () => {
  const h = harness();
  h.render({ open: true, children: body }); h.measure(100);
  h.render({ open: false, children: body });
  const closing = h.runs.at(-1), updates = h.updates;
  h.unmount(); closing.staleFinish();
  assert.equal(closing.stopped, true); assert.equal(h.updates, updates);
});

for (const [file, decoration] of [['Thinking.tsx', 'Dot'], ['ToolCard.tsx', 'PulseDot']]) {
  check(file + ' persistent decoration stops and restarts with reduced motion', () => {
    const h = harness(file, '\nexports.Decoration = ' + decoration + ';');
    const props = { delay: 0, color: '#888', styles: {}, reduceMotion: true };
    h.reduce(true); // Set preference before first render for PulseDot.
    h.render(props);
    assert.equal(h.loops.length, 0);
    h.reduce(false); h.render({ ...props, reduceMotion: false });
    assert.equal(h.loops.length, 1); assert.equal(h.loops[0].started, true);
    h.reduce(true); h.render(props);
    assert.equal(h.loops[0].stopped, true);
    h.unmount();
  });
}

check('all three callers retain controlled Collapse and shared press feedback', () => {
  for (const file of ['Thinking.tsx', 'ToolCard.tsx', 'WorkGroupCard.tsx']) {
    const text = source(file);
    assert.match(text, /<Collapse open=\{open\}>/);
    assert.doesNotMatch(text, /\{open\s*\?\s*\(\s*<Collapse/);
    assert.match(text, /MotionPressable as Pressable/);
    assert.match(text, /accessibilityState=\{\{ expanded: open \}\}/);
  }
  assert.match(source('ui.tsx'), /export \{ MotionCollapse as Collapse \} from '\.\/MotionCollapse'/);
});

console.log(`\n${pass} collapse behavior checks passed`);
