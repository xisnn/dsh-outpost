import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const theme = {
  colors: { border: 'border', bgRaised: 'raised' }, space: { sm: 8, md: 12, lg: 16 },
  type: { sm: 14, xs: 12, micro: 10 }, radius: { sm: 4, md: 8 }, layout: { screenPadding: 16 },
};
function load(file, modules, globals = {}) {
  const source = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) { assert.ok(name in modules, name); return modules[name]; }, Error, ...globals });
  return exports;
}
function fixture() {
  let cursor = 0, pending = [], unmounted = false, dirty = false;
  const slots = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    memo: fn => fn,
    useState(initial) { const i = cursor++; const slot = slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, value => { assert.equal(unmounted, false, 'state update after unmount'); const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) dirty = true; slot.value = next; }]; },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !equal(slots[i].deps, deps)) pending.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); },
  };
  const announcements = [], app = { store: null }, nav = { stack: [{ name: 'ButlerTasks' }] };
  const native = Object.fromEntries(['View', 'Text', 'FlatList', 'ScrollView', 'RefreshControl', 'TextInput', 'ActivityIndicator'].map(x => [x, x]));
  Object.assign(native, { StyleSheet: { create: x => x, hairlineWidth: 1 }, AccessibilityInfo: { announceForAccessibility: label => announcements.push(label) }, AppState: { currentState: 'active', addEventListener() { return { remove() {} }; } } });
  const modules = {
    react: { ...react, default: react }, 'react-native': native,
    '../App': { useApp: () => ({ store: app.store }) }, '../design/theme': { useTheme: () => theme },
    '../design/tokens': theme,
    '../components/Header': { Header: 'Header' }, '../components/LoadingSkeleton': { LoadingSkeleton: 'Skeleton' },
    './LoadingSkeleton': { LoadingSkeleton: 'Skeleton' }, './MotionModal': { MotionModal: 'Modal' },
    './MotionPressable': { MotionPressable: 'Pressable' }, '../components/MotionPressable': { MotionPressable: 'Pressable' },
    '../components/FileCard': { FileCard: 'FileCard' }, '../components/TaskDetailSheet': { TaskDetailSheet: 'Sheet' },
    '../components/TaskMotion': { TaskPressable: 'Pressable', TaskStatus: 'Status', TaskDisclosure: 'Disclosure', TaskSection: 'Section' },
    '../nav/NavHost': { useNav: () => nav }, 'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    '../core/butlerTaskList': load('core/butlerTaskList.ts', {}),
    '../core/rpc/model': { flattenCatalog: c => c.rows, findCatalogModel: () => null },
  };
  return { app, native, modules, announcements,
    load(file) { return load(file, modules, { setTimeout: () => 1, clearTimeout() {} }); },
    render(Component, props = {}) { let tree, passes = 0; do { assert.ok(passes++ < 10, 'render loop'); dirty = false; cursor = 0; tree = Component(props); while (pending.length) pending.shift()(); } while (dirty); return tree; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); unmounted = true; },
  };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  const children = tree.type === 'FlatList'
    ? [tree.props.ListHeaderComponent, ...tree.props.data.map(item => tree.props.renderItem({ item })), tree.props.data.length ? null : tree.props.ListEmptyComponent]
    : tree.children;
  return [tree, ...children.flat(Infinity).flatMap(nodes)];
}
const hasSkeleton = tree => nodes(tree).some(n => n.type === 'Skeleton');
const text = tree => nodes(tree).filter(n => n.type === 'Text').flatMap(n => n.children).join(' ');
function press(tree, label) {
  const button = nodes(tree).find(n => n.type === 'Pressable' && text(n).includes(label));
  assert.ok(button, 'Missing button ' + label); button.props.onPress();
}

test('static skeleton announces once and hides every decorative row', () => {
  const h = fixture(), { LoadingSkeleton } = h.load('components/LoadingSkeleton.tsx');
  let tree = h.render(LoadingSkeleton, { label: '正在加载任务' });
  h.render(LoadingSkeleton, { label: '正在加载任务' });
  h.render(LoadingSkeleton, { label: 'loading' });
  assert.deepEqual(h.announcements, ['正在加载任务']);
  assert.equal(tree.props.pointerEvents, 'none');
  assert.equal(tree.props.accessibilityElementsHidden, true);
  assert.equal(tree.props.importantForAccessibility, 'no-hide-descendants');
  assert.equal(tree.props.accessible, false);
  assert.equal(nodes(tree).filter(n => n.type === 'View').length, 13);
  tree = h.render(LoadingSkeleton, { label: 'loading', variant: 'model' });
  assert.equal(nodes(tree).filter(n => n.type === 'View').length, 10);
  assert.equal(nodes(tree).some(n => n.type === 'ActivityIndicator'), false);
});

test('Butler initial failure gives retry; empty refresh and cached tasks never revert to skeletons', async () => {
  const h = fixture(), requests = [];
  h.app.store = { workspaces: [{ path: '/workspace' }], listButlerTasks() { const d = deferred(); requests.push(d); return d.promise; } };
  const { ButlerTasksScreen } = h.load('screens/ButlerTasksScreen.tsx');
  const render = () => h.render(ButlerTasksScreen);
  assert.equal(hasSkeleton(render()), true);
  requests[0].reject(new Error('offline')); await flush();
  let tree = render(); assert.equal(hasSkeleton(tree), false); assert.match(text(tree), /offline/);
  press(tree, '重新加载'); tree = render(); assert.equal(hasSkeleton(tree), false); assert.match(text(tree), /重新加载中/);
  requests[1].resolve([]); await flush(); tree = render(); assert.match(text(tree), /还没有任务/);
  const refresh = () => nodes(render()).find(n => n.type === 'FlatList').props.refreshControl.props.onRefresh();
  refresh(); assert.equal(hasSkeleton(render()), false);
  const task = { id: '1', title: 'Keep task', objective: 'Objective', status: 'running', revision: 1, deliverables: [], updatedAt: 1 };
  requests[2].resolve([task]); await flush(); refresh();
  assert.equal(hasSkeleton(render()), false);
  assert.equal(nodes(render()).find(n => n.type === 'FlatList').props.data[0].title, 'Keep task');
  requests[3].reject(new Error('refresh failed')); await flush();
  assert.equal(nodes(render()).find(n => n.type === 'FlatList').props.data[0].title, 'Keep task');
  h.unmount();
});

test('TaskBoard settles errors, retries without skeletons, and keeps cached tasks', async () => {
  const h = fixture(), requests = []; let team;
  h.app.store = { sessions: [], getChat: () => ({ agentTeam: team }), subscribe: () => () => {}, refreshChatMeta() { const d = deferred(); requests.push(d); return d.promise; } };
  const { TaskBoardScreen } = h.load('screens/TaskBoardScreen.tsx');
  const render = () => h.render(TaskBoardScreen, { sessionId: 'one' });
  assert.equal(hasSkeleton(render()), true);
  requests[0].reject(new Error('offline')); await flush();
  let tree = render(); assert.equal(hasSkeleton(tree), false); assert.match(text(tree), /offline/);
  press(tree, '重新加载'); tree = render(); assert.equal(hasSkeleton(tree), false);
  requests[1].resolve(); await flush(); assert.match(text(render()), /还没有任务/);
  assert.match(text(render()), /重新加载/, 'missing metadata retains retry even when the store swallows a transport error');
  team = { tasks: [{ id: 't', subject: 'Cached task', status: 'pending', blockedBy: [], writeScopes: [] }], failure: 'Failed projection' };
  tree = render(); assert.match(text(tree), /Cached task/); press(tree, '重新加载');
  tree = render(); assert.equal(hasSkeleton(tree), false); assert.match(text(tree), /Cached task/);
  requests[2].reject(new Error('offline')); await flush(); assert.match(text(render()), /Cached task/);
  h.unmount();
});

test('TaskBoard cached empty projection skips skeleton and changed session ignores stale completion', async () => {
  const h = fixture(), requests = [];
  h.app.store = { sessions: [], getChat: id => ({ agentTeam: id === 'cached' ? { tasks: [] } : undefined }), subscribe: () => () => {}, refreshChatMeta() { const d = deferred(); requests.push(d); return d.promise; } };
  const { TaskBoardScreen } = h.load('screens/TaskBoardScreen.tsx');
  assert.equal(hasSkeleton(h.render(TaskBoardScreen, { sessionId: 'cached' })), false);
  assert.equal(hasSkeleton(h.render(TaskBoardScreen, { sessionId: 'next' })), true);
  requests[0].resolve(); await flush();
  assert.equal(hasSkeleton(h.render(TaskBoardScreen, { sessionId: 'next' })), true);
  requests[1].resolve(); await flush();
  assert.equal(hasSkeleton(h.render(TaskBoardScreen, { sessionId: 'next' })), false);
  h.unmount();
});

test('model catalog failure retries, caches success, and retains catalog after a selection error', async () => {
  const h = fixture(), requests = [];
  h.app.store = { modelCatalog() { const d = deferred(); requests.push(d); return d.promise; }, selectModel: async () => { throw new Error('selection failed'); } };
  const { ModelSwitcher } = h.load('components/ModelSwitcher.tsx');
  const render = () => h.render(ModelSwitcher, { sessionId: 'one', contextUsed: 0, contextWindow: 100 });
  nodes(render()).find(n => n.type === 'Pressable').props.onPress();
  assert.equal(hasSkeleton(render()), true);
  requests[0].reject(new Error('catalog offline')); await flush();
  let tree = render(); assert.equal(hasSkeleton(tree), false); assert.match(text(tree), /catalog offline/);
  press(tree, '重新加载'); tree = render(); assert.equal(hasSkeleton(tree), false); assert.match(text(tree), /重新加载中/);
  requests[1].resolve({ default: { provider: 'local', model: 'a' }, rows: [{ provider: 'local', model: { id: 'a', name: 'Model A' } }] }); await flush();
  tree = render(); assert.match(text(tree), /Model A/); press(tree, 'Model A'); await flush();
  tree = render(); assert.match(text(tree), /selection failed/); assert.match(text(tree), /Model A/);
  nodes(tree).find(n => n.type === 'Modal').props.onRequestClose(); render();
  nodes(render()).find(n => n.type === 'Pressable').props.onPress(); tree = render();
  assert.equal(hasSkeleton(tree), false); assert.equal(requests.length, 2);
  h.unmount();
});

test('catalog completion after close or unmount cannot change the next opening', async () => {
  const h = fixture(), requests = [];
  h.app.store = { modelCatalog() { const d = deferred(); requests.push(d); return d.promise; } };
  const { ModelSwitcher } = h.load('components/ModelSwitcher.tsx');
  const render = () => h.render(ModelSwitcher, { sessionId: 'one', contextUsed: 0, contextWindow: 100 });
  nodes(render()).find(n => n.type === 'Pressable').props.onPress(); let tree = render();
  nodes(tree).find(n => n.type === 'Modal').props.onRequestClose(); render();
  requests[0].reject(new Error('stale failure')); await flush();
  nodes(render()).find(n => n.type === 'Pressable').props.onPress(); tree = render();
  assert.equal(hasSkeleton(tree), true); assert.equal(requests.length, 2); assert.doesNotMatch(text(tree), /stale failure/);
  h.unmount(); requests[1].resolve({}); await flush();
});
