import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the real components with deterministic hooks/Animated, without RN's
// native runtime. Late completion callbacks deliberately remain callable so races
// between an interrupted pop, a new push and unmount are covered.
const require = createRequire(import.meta.url);
function fixture() {
  const env = { reduced: false, width: 400, height: 800, fontScale: 1, keyboard: {}, animations: [], back: null };
  let owner;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    createElement: (type, props, ...children) => ({
      type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
    }),
    useRef(value) {
      const i = owner.cursor++;
      return owner.hooks[i] ??= { current: value };
    },
    useState(initial) {
      const current = owner;
      const i = current.cursor++;
      const slot = current.hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, (value) => {
        assert.equal(current.rendering, false, 'state updates must stay outside render');
        assert.equal(current.unmounted, false, 'state update after unmount');
        slot.value = typeof value === 'function' ? value(slot.value) : value;
      }];
    },
    useMemo(fn, deps) {
      const i = owner.cursor++;
      let slot = owner.hooks[i];
      if (!slot || !same(slot.deps, deps)) slot = owner.hooks[i] = { value: fn(), deps };
      return slot.value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const current = owner;
      const i = current.cursor++;
      const old = current.hooks[i];
      if (!old || !same(old.deps, deps)) {
        current.effects.push(() => {
          old?.cleanup?.();
          current.hooks[i] = { deps, cleanup: fn() };
        });
      }
    },
  };
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) {
      assert.ok(!owner?.rendering, 'Animated values must not change in render');
      this.value = value;
    }
    stopAnimation() { this.animation?.stop(); }
    interpolate(config) { return { value: this, ...config }; }
  }
  const animation = (kind, value, config) => {
    const result = {
      kind, value, config, stopped: false,
      start(callback) {
        this.callback = callback;
        value.animation = this;
        env.animations.push(this);
      },
      stop() {
        if (this.stopped) return;
        this.stopped = true;
        if (value.animation === this) value.animation = null;
        this.callback?.({ finished: false });
      },
      finish() {
        assert.equal(this.stopped, false);
        value.value = config.toValue;
        if (value.animation === this) value.animation = null;
        this.callback?.({ finished: true });
      },
    };
    return result;
  };
  const native = {
    Animated: {
      Value, View: 'AnimatedView',
      timing: (value, config) => animation('timing', value, config),
      spring: (value, config) => animation('spring', value, config),
      add: (a, b) => ({ a, b }),
    },
    BackHandler: { addEventListener: (_, fn) => {
      env.back = fn;
      return { remove: () => { env.back = null; } };
    } },
    PanResponder: { create: (handlers) => ({ panHandlers: handlers }) },
    useWindowDimensions: () => ({ width: env.width, height: env.height, fontScale: env.fontScale }),
    Platform: {OS: 'android'},
    Dimensions: {get: () => ({width: env.width, height: env.height})},
    Keyboard: {isVisible: () => false, addListener: (name, fn) => {
      env.keyboard[name] = fn;
      return {remove: () => {delete env.keyboard[name];}};
    }},
    StyleSheet: { create: (styles) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
    View: 'View', Pressable: 'Pressable', Text: 'Text',
  };
  const modules = {
    react,
    'react-native': native,
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    '../design/motion': {
      useMotionPreference: () => env.reduced,
      MOTION: { press: 100, enter: 160, exit: 120, layout: 240, navigation: 240 },
    },
    '../design/theme': { useTheme: () => ({ colors: {}, type: {}, weight: {} }) },
  };
  function load(path) {
    const src = readFileSync(new URL(path, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
    });
    const exports = {};
    vm.runInNewContext(outputText, { exports, require: (id) => modules[id] ?? require(id) });
    return exports;
  }
  function mount(component, initialProps) {
    const current = { hooks: [], effects: [], cursor: 0, rendering: false, unmounted: false };
    let props = initialProps;
    return {
      tree: null,
      render(next = props) {
        props = next;
        current.cursor = 0;
        current.effects = [];
        current.rendering = true;
        owner = current;
        try { this.tree = component(props); } finally { current.rendering = false; owner = null; }
        current.effects.forEach((effect) => effect());
        return this.tree;
      },
      unmount() {
        current.unmounted = true;
        current.hooks.forEach((slot) => slot?.cleanup?.());
      },
    };
  }
  modules['../core/adaptiveNavigation'] = load('../src/core/adaptiveNavigation.ts');
  const nav = load('../src/nav/NavHost.tsx');
  function host(render = (screen) => screen.name, rootIsList = false) {
    const result = mount(nav.NavHost, { initial: { name: 'Home' }, render, rootIsList });
    result.render();
    Object.defineProperties(result, {
      nav: { get: () => result.tree.props.value },
      panes: { get: () => result.tree.props.children.props.children },
      gesture: { get: () => result.tree.props.children.props },
    });
    return result;
  }
  return { env, load, mount, host };
}

const names = (host) => Array.from(host.nav.stack, (screen) => screen.name);
const touch = (pageX, locationX = pageX) => ({ nativeEvent: { pageX, locationX } });

test('only the top entry is active, including duplicate Chat sessions', () => {
  const seen = [];
  const h = fixture().host((screen, active) => { seen.push({ name: screen.name, active }); return screen.name; });
  assert.deepEqual(seen, [{ name: 'Home', active: true }]);
  h.nav.push('Chat', { sessionId: 'same' });
  h.nav.push('Chat', { sessionId: 'same' });
  seen.length = 0;
  h.render();
  assert.deepEqual(seen, [
    { name: 'Home', active: false },
    { name: 'Chat', active: false },
    { name: 'Chat', active: true },
  ]);
  h.unmount();
});

test('Home stays still; pushed panes enter on mount and stop on gesture/unmount', () => {
  const f = fixture();
  const h = f.host();
  const home = f.mount(h.panes[0].type, h.panes[0].props);
  home.render();
  assert.equal(f.env.animations.length, 0);
  h.nav.push('Chat'); h.render();
  const pane = f.mount(h.panes[1].type, h.panes[1].props);
  pane.render();
  const enter = f.env.animations.at(-1);
  assert.equal(enter.value.value, 0);
  assert.equal(enter.config.toValue, 1);
  assert.equal(enter.config.duration, 240);
  h.gesture.onPanResponderGrant(); h.render();
  pane.render(h.panes[1].props);
  assert.equal(enter.stopped, true);
  assert.equal(enter.value.value, 1);
  pane.unmount(); home.unmount(); h.unmount();
});

test('programmatic pop animates and late completion cannot remove a rapid push', () => {
  const f = fixture(); const h = f.host();
  h.nav.push('A'); h.nav.push('B'); h.render();
  h.nav.pop();
  const pop = f.env.animations.at(-1);
  assert.equal(pop.config.toValue, 400);
  h.render();
  assert.deepEqual(names(h), ['Home', 'A', 'B']);
  h.nav.push('C'); h.render();
  assert.deepEqual(names(h), ['Home', 'A', 'C']);
  assert.equal(pop.stopped, true);
  pop.callback({ finished: true }); h.render();
  assert.deepEqual(names(h), ['Home', 'A', 'C']);
  h.nav.pop(); f.env.animations.at(-1).finish(); h.render();
  assert.deepEqual(names(h), ['Home', 'A']);
  assert.equal(h.panes.at(-1).props.dragX.value, 0);
  h.unmount();
});

test('rapid pops, same-screen reset and Android back preserve stack identity', () => {
  const f = fixture(); const h = f.host();
  h.nav.push('A'); h.nav.push('B'); h.render();
  h.nav.pop(); const old = f.env.animations.at(-1);
  h.nav.pop(); f.env.animations.at(-1).finish(); h.render();
  assert.deepEqual(names(h), ['Home']);
  old.callback({ finished: true }); h.render();
  assert.deepEqual(names(h), ['Home']);
  assert.equal(f.env.back(), false);
  const oldKey = h.panes[0].props.key;
  h.nav.reset('Home'); h.render();
  assert.notEqual(h.panes[0].props.key, oldKey);
  assert.equal(h.panes[0].props.animateEnter, false);
  h.nav.push('Chat'); h.render();
  assert.equal(f.env.back(), true);
  f.env.animations.at(-1).finish(); h.render();
  assert.deepEqual(names(h), ['Home']); h.unmount();
});

test('returning to root preserves its key and defeats a late pop callback', () => {
  const f = fixture(); const h = f.host();
  const key = h.panes[0].props.key;
  h.nav.push('A'); h.nav.push('B'); h.render();
  h.nav.pop(); const old = f.env.animations.at(-1);
  h.nav.popToRoot(); h.render();
  assert.deepEqual(names(h), ['Home']);
  assert.equal(h.panes[0].props.key, key);
  old.callback({ finished: true }); h.render();
  assert.equal(h.panes[0].props.key, key);
  h.nav.popToRoot(); h.render(); assert.equal(h.panes[0].props.key, key);
  h.unmount();
});

test('cancelled edge drags settle; new navigation and unmount stop old animations', () => {
  const f = fixture(); const h = f.host();
  h.nav.push('A'); h.render();
  h.gesture.onPanResponderGrant();
  h.gesture.onPanResponderMove(null, { dx: 80 });
  const drag = h.panes.at(-1).props.dragX;
  assert.equal(drag.value, 80);
  h.gesture.onPanResponderTerminate();
  const settle = f.env.animations.at(-1);
  assert.equal(settle.kind, 'spring');
  assert.equal(settle.config.toValue, 0);
  h.nav.push('B'); h.render();
  assert.equal(settle.stopped, true);
  assert.equal(drag.value, 0);
  h.nav.pop(); const pop = f.env.animations.at(-1);
  h.unmount(); assert.equal(pop.stopped, true);
  pop.callback({ finished: true });
});

test('reduced motion keeps direct edge dragging and immediately settles/dismisses', () => {
  const f = fixture(); f.env.reduced = true; const h = f.host();
  h.nav.push('A'); h.render();
  const pane = f.mount(h.panes[1].type, h.panes[1].props); pane.render();
  h.gesture.onPanResponderGrant();
  h.gesture.onPanResponderMove(null, { dx: 60 });
  const drag = h.panes[1].props.dragX;
  assert.equal(drag.value, 60);
  h.gesture.onPanResponderRelease(null, { dx: 60, vx: 0 });
  assert.equal(drag.value, 0);
  h.gesture.onPanResponderGrant();
  h.gesture.onPanResponderMove(null, { dx: 180 });
  h.gesture.onPanResponderRelease(null, { dx: 180, vx: 0 }); h.render();
  assert.deepEqual(names(h), ['Home']);
  h.nav.push('B'); h.nav.pop(); h.render();
  assert.deepEqual(names(h), ['Home']);
  assert.equal(f.env.animations.length, 0);
  pane.unmount(); h.unmount();
});

test('width/preference changes complete pending pops without stale callbacks', () => {
  const f = fixture(); const h = f.host();
  h.nav.push('A'); h.render(); h.nav.pop();
  const pop = f.env.animations.at(-1);
  f.env.reduced = true; h.render(); h.render();
  assert.equal(pop.stopped, true);
  assert.deepEqual(names(h), ['Home']);
  pop.callback({ finished: true }); h.render();
  assert.deepEqual(names(h), ['Home']);
  f.env.reduced = false; h.render();
  h.nav.push('B'); h.render(); h.nav.pop();
  const resizePop = f.env.animations.at(-1);
  f.env.width = 700; h.render(); h.render();
  assert.equal(resizePop.stopped, true);
  assert.deepEqual(names(h), ['Home']);
  h.nav.push('C'); h.render(); h.nav.pop();
  assert.equal(f.env.animations.at(-1).config.toValue, 700);
  f.env.animations.at(-1).finish(); h.render();
  assert.deepEqual(names(h), ['Home']); h.unmount();
});

test('wide columns retain entry keys through resizing and keep only the current chat active', () => {
  const f=fixture(); const seen=[];
  const h=f.host((screen,active)=>{seen.push([screen.name,active]);return screen.name;},true);
  h.nav.push('Sessions');h.nav.push('Chat',{sessionId:'first'});h.nav.push('Chat',{sessionId:'second'});h.render();
  const keys=Array.from(h.panes,p=>p.props.key);
  f.env.width=1200;f.env.height=800;seen.length=0;h.render();h.render();
  assert.deepEqual(Array.from(h.panes,p=>p.props.key),keys);
  assert.deepEqual(Array.from(h.panes,p=>p.props.active),[false,true,false,true]);
  assert.equal(h.panes[1].props.covered,false);assert.equal(h.panes[2].props.layoutStyle.display,'none');
  assert.equal(h.panes[3].props.layoutStyle.left,336);
  assert.equal(h.panes[1].props.children.props.value.column,'master');
  assert.equal(h.panes[3].props.children.props.value.column,'detail');
  assert.equal(h.panes[1].props.children.props.value.selectedSessionId,'second');
  assert.equal(h.gesture.onMoveShouldSetPanResponderCapture(touch(15),{dx:10,dy:0}),false);
  const master=f.mount(h.panes[1].type,h.panes[1].props);const tree=master.render();
  assert.equal(tree.props.pointerEvents,'auto');assert.equal(tree.props.accessibilityElementsHidden,false);
  f.env.width=400;h.render();h.render();assert.deepEqual(Array.from(h.panes,p=>p.props.key),keys);
  assert.deepEqual(Array.from(h.panes,p=>p.props.active),[false,false,false,true]);
  assert.equal(h.gesture.onMoveShouldSetPanResponderCapture(touch(15),{dx:10,dy:0}),true);
  master.unmount();h.unmount();assert.equal(Object.keys(f.env.keyboard).length,0);
});

test('wide list selection reuses an existing chat owner and list back targets the list', () => {
  const f=fixture();f.env.width=1200;const h=f.host(undefined,true);
  h.nav.push('Sessions');h.render();h.nav.push('Chat',{sessionId:'A'});h.render();
  const key=h.panes[2].props.key;h.nav.push('Chat',{sessionId:'A',title:'updated'});h.render();
  assert.equal(h.panes.length,3);assert.equal(h.panes[2].props.key,key);
  h.nav.push('Chat',{sessionId:'B'});h.render();h.nav.push('Chat',{sessionId:'A'});h.render();
  assert.equal(h.panes.length,3);assert.equal(h.panes[2].props.key,key);
  const scoped=h.panes[1].props.children.props.value;assert.equal(scoped.canGoBack,true);
  scoped.pop();h.render();assert.deepEqual(names(h),['Home']);
  scoped.pop();h.render();assert.deepEqual(names(h),['Home'],'stale list callback ignored');h.unmount();
});

test('docked keyboard preserves wide columns; short windows and large fonts use the original stack', () => {
  const f=fixture();f.env.width=1200;const h=f.host(undefined,true);h.nav.push('Chat');h.render();h.render();
  const key=h.panes[1].props.key;assert.equal(h.panes[0].props.active,true);
  f.env.height=450;f.env.keyboard.keyboardDidShow({endCoordinates:{height:350}});h.render();
  assert.equal(h.panes[0].props.active,true);assert.equal(h.panes[1].props.key,key);
  f.env.height=150;h.render();assert.equal(h.panes[0].props.active,false,'same-width real height reduction must requalify');
  f.env.height=450;h.render();assert.equal(h.panes[0].props.active,true);
  f.env.keyboard.keyboardDidHide();h.render();h.render();assert.equal(h.panes[0].props.active,false);
  f.env.height=800;f.env.fontScale=1.5;h.render();assert.equal(h.panes[0].props.active,false);
  f.env.fontScale=1;h.render();assert.equal(h.panes[0].props.active,true);
  f.env.reduced=true;h.render();assert.equal(f.env.back(),true);h.render();assert.deepEqual(names(h),['Home']);h.unmount();
  const butler=f.host(undefined,false);butler.nav.push('Chat');butler.render();assert.equal(butler.panes[0].props.active,false);butler.unmount();
});

test('segmented cancellation returns to selection and confirmed release/accessibility still select', () => {
  const f = fixture(); const changes = [];
  const { SlideSegmented } = f.load('../src/components/SlideSegmented.tsx');
  const props = { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a', itemWidth: 100, onChange: (v) => changes.push(v) };
  const segment = f.mount(SlideSegmented, props); let tree = segment.render();
  assert.equal(f.env.animations.length, 0);
  tree.props.onPressIn(touch(30)); tree.props.onResponderMove(touch(150));
  tree.props.onTouchCancel();
  assert.deepEqual(changes, []);
  assert.equal(f.env.animations.at(-1).config.toValue, 0);
  const cancelled = f.env.animations.at(-1);
  tree.props.onPressIn(touch(150));
  assert.equal(cancelled.stopped, true);
  tree.props.onPressOut(); tree.props.onPress(touch(150));
  assert.deepEqual(changes, ['b']);
  tree = segment.render({ ...props, value: 'b' });
  const animationCount = f.env.animations.length;
  segment.render({ ...props, value: 'b', options: [...props.options] });
  assert.equal(f.env.animations.length, animationCount, 'streaming rerender must not animate');
  tree.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } });
  assert.deepEqual(changes, ['b', 'a']);
  f.env.reduced = true; tree = segment.render(props);
  const reducedCount = f.env.animations.length;
  tree.props.onPressIn(touch(30)); tree.props.onResponderMove(touch(150)); tree.props.onPressOut();
  tree.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
  assert.deepEqual(changes, ['b', 'a', 'b']);
  assert.equal(f.env.animations.length, reducedCount);
  segment.unmount();
});

test('tabs animate only selection/press, preserve a11y and snap with reduced motion', () => {
  const f = fixture(); const { TabBar } = f.load('../src/components/TabBar.tsx');
  const bar = f.mount(TabBar, { tab: 'workspaces', items: ['workspaces', 'me'], onChange() {} });
  const tree = bar.render(); const item = tree.props.children[1];
  const tab = f.mount(item.type, item.props); let button = tab.render();
  assert.equal(f.env.animations.length, 0);
  assert.equal(button.props.accessibilityRole, 'tab');
  button = tab.render({ ...item.props, active: true });
  assert.equal(f.env.animations.at(-1).config.duration, 160);
  const count = f.env.animations.length;
  tab.render({ ...item.props, active: true, onPress() {} });
  assert.equal(f.env.animations.length, count);
  button.props.onPressIn();
  assert.equal(f.env.animations.at(-1).config.duration, 100);
  button.props.onPressOut(); const release = f.env.animations.at(-1);
  f.env.reduced = true; button = tab.render({ ...item.props, active: true });
  assert.equal(release.stopped, true);
  button.props.onPressIn(); button.props.onPressOut();
  assert.equal(release.value.value, 1);
  assert.equal(f.env.animations.at(-1), release);
  tab.unmount(); bar.unmount();
});
