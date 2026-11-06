// Exercise the actual components with controlled requests and foreground events.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';

const flush = () => new Promise(resolve => setImmediate(resolve));
function load(file, modules, globals = {}) {
  const source = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) {
    assert.ok(name in modules, 'Unexpected import: ' + name);
    return modules[name];
  }, ...globals });
  return exports;
}
function hooks() {
  const states = [], effects = [], refs = [], memos = [];
  let cursor = 0, refCursor = 0, memoCursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useMemo(fn, deps) {
      const i = memoCursor++, old = memos[i];
      if (!old || !deps || !old.deps || deps.length !== old.deps.length || deps.some((value, index) => !Object.is(value, old.deps[index]))) memos[i] = { deps, value: fn() };
      return memos[i].value;
    }, useCallback: fn => fn, memo: fn => fn,
    useEffect: fn => effects.push(fn),
    useRef(initial) { const i = refCursor++; return refs[i] ??= { current: initial }; },
  };
  return { states, effects, react: { ...react, default: react }, begin() { cursor = refCursor = memoCursor = 0; } };
}
const theme = { colors: {}, radius: {}, space: {}, type: {}, weight: {}, layout: { screenPadding: 10 } };
function native(extra = {}) {
  return Object.fromEntries([
    ...['ActivityIndicator', 'Modal', 'Pressable', 'RefreshControl', 'ScrollView', 'FlatList', 'Text', 'TextInput', 'View', 'Image'].map(name => [name, name]),
    ['StyleSheet', { create: x => x, hairlineWidth: 1 }], ['Dimensions', { get: () => ({ width: 400 }) }], ['useWindowDimensions', () => ({ width: 400, height: 800 })], ...Object.entries(extra),
  ]);
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (typeof tree.type === 'function') return [tree, ...nodes(tree.type(tree.props))];
  const children = tree.type === 'FlatList'
    ? [tree.props.ListHeaderComponent, ...(tree.props.data ?? []).map(item => tree.props.renderItem({ item })), tree.props.data?.length ? null : tree.props.ListEmptyComponent, tree.props.ListFooterComponent]
    : tree.children;
  return [tree, ...children.flat(Infinity).flatMap(nodes)];
}
const taskListLogic = load('core/butlerTaskList.ts', {});
function button(tree, text) {
  const result = nodes(tree).find(node => node.type === 'Pressable' && nodes(node).some(child => child.type === 'Text' && child.children.includes(text)));
  assert.ok(result, 'Missing button: ' + text);
  return result;
}
const task = { id: 'task-1', title: 'Test', status: 'blocked', objective: 'Test', cwd: '/workspace', sessionId: 'session-1', revision: 1, maxGoalRounds: 32, deliverables: [], createdAt: 1 };
function taskHarness(store, nativeExtras = {}, globals = {}) {
  const h = hooks();
  const nav = { stack: [{ name: 'ButlerTasks' }], push(name, params) { this.stack.push({ name, params }); } };
  const { ButlerTasksScreen } = load('screens/ButlerTasksScreen.tsx', {
    react: h.react, 'react-native': native(nativeExtras),
    '../App': { useApp: () => ({ store, butlerWorkspace: '/workspace' }) },
    '../components/Header': { Header: 'Header' }, '../components/FileCard': { FileCard: 'FileCard' },
    '../components/LoadingSkeleton': { LoadingSkeleton: 'LoadingSkeleton' },
    '../components/TaskDetailSheet': { TaskDetailSheet: 'TaskDetailSheet' },
    '../components/TaskMotion': { TaskPressable: 'Pressable', TaskSection: 'View', TaskStatus: 'TaskStatus', TaskDisclosure: 'View' },
    '../design/theme': { useTheme: () => theme }, '../nav/NavHost': { useNav: () => nav },
    '../core/butlerTaskList': taskListLogic,
  }, globals);
  return { ...h, nav, render() { h.begin(); return ButlerTasksScreen({}); } };
}

// Commit only changed effects, so rerenders cannot manufacture image downloads/retries.
function fileCardHarness(fetchRemoteFile, fileSystem = {}, props = {}) {
  const h = hooks(), effectSlots = [], pending = [];
  let effectCursor = 0;
  const react = { ...h.react, useEffect(fn, deps) {
    const i = effectCursor++, previous = effectSlots[i];
    if (previous && deps.length === previous.deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
    pending.push(() => { previous?.cleanup?.(); effectSlots[i] = { deps, cleanup: fn() }; });
  } };
  const { FileCard } = load('components/FileCard.tsx', {
    react, 'react-native': native(),
    './MotionPressable': { MotionPressable: 'Pressable' },
    'react-native-blob-util': { default: { fs: { readFile: async () => 'aW1hZ2U=', ...fileSystem } } },
    '../design/theme': { useTheme: () => theme },
    '../App': { useApp: () => ({ store: { fileBaseUrl: 'http://127.0.0.1:9', gatewayChannel: null }, butlerWorkspace: '/workspace' }) },
    '../core/fileUrl': { fetchRemoteFile, openLocalFile: async () => assert.fail('Images must use their viewer') },
    '../core/gatewayFiles': { downloadWorkspaceFile: async () => assert.fail('Gateway is offline') },
    '../core/filePreview': { isTextPreviewable: () => false },
    './FileTypeBadge': { FileTypeBadge: 'FileTypeBadge' },
    '../core/picker': { formatBytes: bytes => `${bytes} B` },
    './ImageViewer': { ImageViewer: 'ImageViewer' },
    './DocumentViewer': { DocumentViewer: 'DocumentViewer', canPreviewInside: () => true },
  }, { Error });
  return { ...h, render() {
    h.begin(); effectCursor = 0;
    const tree = FileCard({ path: 'result.png', image: true, workspacePath: '/workspace', ...props });
    while (pending.length) pending.shift()();
    return tree;
  }, unmount() { effectSlots.forEach(effect => effect.cleanup?.()); } };
}

for (const action of ['resume', 'cancel']) {
  let finish;
  const h = taskHarness({ workspaces: [], listButlerTasks: async () => [task],
    resumeButlerTask: () => new Promise(resolve => { finish = resolve; }),
    cancelButlerTask: () => new Promise(resolve => { finish = resolve; }),
  }, { Alert: { alert(_title, _body, actions) { actions.find(action => action.style === 'destructive').onPress(); } } });
  h.render(); h.states[4] = task;
  const tree = h.render();
  button(tree, action === 'resume' ? '继续执行' : '取消任务').props.onPress();
  button(tree, '打开会话').props.onPress();
  assert.equal(h.states[4], null);
  assert.equal(h.nav.stack.at(-1).name, 'ButlerTasks', 'navigation waits for the sheet to close');
  finish({ ...task, revision: 2, status: action === 'resume' ? 'running' : 'cancelled' });
  await flush();
  const sheet = nodes(h.render()).find(node => node.type === 'TaskDetailSheet');
  assert.equal(sheet.props.visible, false);
  sheet.props.onAfterClose();
  assert.equal(h.nav.stack.at(-1).name, 'Chat');
  sheet.props.onAfterClose();
  assert.equal(h.nav.stack.length, 2, 'duplicate dismissal cannot navigate twice');
  console.log('PASS late ' + action + ' cannot reopen task detail over Chat');
}

{
  const requests = [];
  let onState, tick, scheduled = 0;
  const h = taskHarness({ workspaces: [{ name: 'Test', path: '/workspace' }], listButlerTasks: () => new Promise(resolve => requests.push(resolve)) }, {
    AppState: { currentState: 'active', addEventListener(_event, listener) { onState = listener; return { remove() {} }; } },
  }, { setTimeout(fn) { tick = fn; scheduled++; return scheduled; }, clearTimeout() {} });
  h.render();
  const cleanup = h.effects[1]();
  onState('background'); onState('active');
  assert.equal(requests.length, 2, 'foreground starts a fresh request immediately');
  requests[0]([{ ...task, revision: 1 }]); await flush();
  assert.equal(scheduled, 0, 'no next poll is scheduled until the current foreground request settles');
  assert.equal(requests.length, 2, 'obsolete request cannot schedule another poll');
  assert.equal(h.states[0].length, 0, 'old response is discarded');
  requests[1]([{ ...task, revision: 3 }]); await flush();
  assert.equal(h.states[0][0].revision, 3);
  assert.equal(scheduled, 1);
  tick();
  assert.equal(requests.length, 3, 'one next poll starts after settling');
  tick();
  assert.equal(requests.length, 3, 'a stale timer cannot overlap the pending request');
  cleanup();
  requests[2]([{ ...task, revision: 4 }]); await flush();
  assert.equal(h.states[0][0].revision, 3, 'cleanup invalidates pending results');
  console.log('PASS foreground refresh ignores an obsolete pending request');
}

for (const serverDigest of ['expected', 'tampered']) {
  const h = hooks();
  let digest = 'cached-old', freshDownloads = 0;
  const file = { uri: 'file:///cache/result.md', fsPath: '/cache/result.md', name: 'result.md' };
  const { FileCard } = load('components/FileCard.tsx', {
    react: h.react, 'react-native': native(),
    './MotionPressable': { MotionPressable: 'Pressable' },
    'react-native-blob-util': { default: { fs: { stat: async () => ({ size: 3 }), hash: async () => digest, unlink: async () => {} } } },
    '../design/theme': { useTheme: () => theme },
    '../App': { useApp: () => ({ store: { fileBaseUrl: 'http://127.0.0.1:9', gatewayChannel: null }, butlerWorkspace: '/workspace' }) },
    '../core/fileUrl': { fetchRemoteFile: async (_base, _cookie, _path, options) => {
      if (options?.forceDownload) { freshDownloads++; digest = serverDigest; }
      return file;
    }, openLocalFile: async () => assert.fail('Markdown must use its viewer') },
    '../core/gatewayFiles': { downloadWorkspaceFile: async () => assert.fail('Gateway is offline') },
    '../core/filePreview': { isTextPreviewable: () => false },
    './FileTypeBadge': { FileTypeBadge: 'FileTypeBadge' },
    '../core/picker': { formatBytes: bytes => `${bytes} B` },
    './ImageViewer': { ImageViewer: 'ImageViewer' }, './DocumentViewer': { DocumentViewer: 'DocumentViewer', canPreviewInside: () => true },
  });
  const render = () => { h.begin(); return FileCard({ path: 'result.md', workspacePath: '/workspace', expectedSha256: 'expected', expectedSize: 3 }); };
  nodes(render()).find(node => node.type === 'Pressable').props.onPress();
  await flush();
  assert.equal(freshDownloads, 1, 'retry is bounded to one forced fresh download');
  const viewer = nodes(render()).find(node => node.type === 'DocumentViewer');
  if (serverDigest === 'expected') {
    assert.equal(viewer.props.visible, true);
    assert.equal(h.states[1], null);
  } else {
    assert.equal(viewer, undefined);
    assert.match(h.states[1], /文件内容与交付记录不一致/);
  }
  console.log('PASS ' + (serverDigest === 'expected' ? 'redelivery refreshes stale cache and opens in one tap' : 'fresh mismatched delivery stays closed'));
}

for (const failure of ['download', 'thumbnail', 'viewer']) {
  const requests = [];
  const file = { uri: 'file:///cache/result.png', fsPath: '/cache/result.png', name: 'result.png' };
  const h = fileCardHarness((_base, _cookie, path, options) => new Promise((resolve, reject) => {
    requests.push({ path, options, resolve, reject });
  }));
  h.render();
  assert.equal(requests.length, 1, 'mount starts one image download');
  assert.equal(requests[0].path, '/workspace/result.png');
  assert.equal(requests[0].options.forceDownload, false);
  if (failure === 'download') requests[0].reject(new Error('image download failed'));
  else requests[0].resolve(file);
  await flush();
  let tree = h.render();
  if (failure === 'thumbnail') {
    nodes(tree).find(node => node.type === 'Image').props.onError({ nativeEvent: { error: 'bad image bytes' } });
  } else if (failure === 'viewer') {
    nodes(tree).find(node => node.type === 'Pressable').props.onPress();
    await flush(); tree = h.render();
    const viewer = nodes(tree).find(node => node.type === 'ImageViewer');
    assert.equal(viewer.props.visible, true);
    viewer.props.images[0].onError();
  }
  tree = h.render();
  assert.match(h.states[1], failure === 'download' ? /image download failed/ : /图片加载失败/);
  if (failure !== 'download') {
    const thumbnail = nodes(tree).find(node => node.type === 'Pressable');
    assert.match(thumbnail.props.accessibilityLabel, /重试图片/);
    assert.ok(nodes(tree).some(node => node.type === 'Text' && node.children.some(text => typeof text === 'string' && text.includes('点击重试'))));
    assert.equal(nodes(tree).find(node => node.type === 'ImageViewer').props.images[0].failed, true);
  }
  for (let i = 0; i < 3; i++) { h.render(); await flush(); }
  assert.equal(requests.length, 1, 'failed images stay failed across rerenders until explicit retry');
  if (failure === 'viewer') nodes(tree).find(node => node.type === 'ImageViewer').props.images[0].onRetry();
  else nodes(tree).find(node => node.type === 'Pressable').props.onPress();
  tree = h.render();
  assert.equal(requests.length, 2, 'explicit retry starts exactly one new download');
  assert.equal(requests[1].options.forceDownload, true, 'retry bypasses cached image bytes');
  assert.equal(h.states[0], null, 'retry clears the broken local file');
  assert.equal(h.states[1], null, 'retry clears the failure');
  assert.equal(h.states[3], false, 'retry closes the old viewer');
  tree = h.render();
  assert.equal(nodes(tree).find(node => node.type === 'Pressable').props.disabled, true);
  nodes(tree).find(node => node.type === 'Pressable').props.onPress();
  h.render();
  assert.equal(requests.length, 2, 'pressing while retry is pending does not download again');
  requests[1].resolve(file); await flush();
  tree = h.render();
  assert.equal(h.states[1], null);
  assert.equal(nodes(tree).find(node => node.type === 'Image').props.source.uri, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(nodes(tree).find(node => node.type === 'ImageViewer').props.visible, false);
  nodes(tree).find(node => node.type === 'Pressable').props.onPress(); await flush();
  assert.equal(nodes(h.render()).find(node => node.type === 'ImageViewer').props.visible, true, 'recovered image opens normally');
  assert.equal(requests.length, 2, 'opening recovered bytes reuses the local file');
  h.unmount();
  console.log('PASS FileCard ' + failure + ' failure waits for explicit fresh image retry');
}

for (const mismatch of ['size', 'sha256']) {
  for (const freshMatches of [true, false]) {
    const file = { uri: 'file:///cache/result.png', fsPath: '/cache/result.png', name: 'result.png' };
    const requests = [], deleted = [], checkedSizes = [], checkedHashes = [];
    let fresh = false;
    const h = fileCardHarness(async (_base, _cookie, path, options) => {
      requests.push({ path, options });
      if (options?.forceDownload) fresh = true;
      return file;
    }, {
      stat: async path => { checkedSizes.push(path); return { size: fresh && freshMatches || mismatch !== 'size' ? 3 : 4 }; },
      hash: async (path, algorithm) => { checkedHashes.push({ path, algorithm }); return fresh && freshMatches || mismatch !== 'sha256' ? 'EXPECTED' : 'tampered'; },
      unlink: async path => { deleted.push(path); },
    }, { expectedSha256: 'expected', expectedSize: 3 });
    h.render(); await flush();
    nodes(h.render()).find(node => node.type === 'Pressable').props.onPress(); await flush();
    const tree = h.render(), viewer = nodes(tree).find(node => node.type === 'ImageViewer');
    assert.equal(requests.length, 2, 'image prefetch plus exactly one fresh integrity retry');
    assert.equal(requests.filter(request => request.options?.forceDownload).length, 1, 'integrity retry is bounded to one fresh image download');
    assert.ok(requests.every(request => request.path === '/workspace/result.png'));
    assert.deepEqual(checkedSizes, [file.fsPath, file.fsPath], 'size is checked before and after fresh download');
    assert.deepEqual(checkedHashes, [{ path: file.fsPath, algorithm: 'sha256' }, { path: file.fsPath, algorithm: 'sha256' }]);
    assert.deepEqual(deleted, Array(freshMatches ? 1 : 2).fill(file.fsPath), 'each mismatching file is removed');
    if (freshMatches) {
      assert.equal(viewer.props.visible, true);
      assert.equal(viewer.props.images[0].save.fsPath, file.fsPath);
      assert.equal(h.states[1], null);
    } else {
      assert.equal(viewer, undefined, 'tampered image cannot open in the viewer');
      assert.equal(nodes(tree).find(node => node.type === 'Image'), undefined, 'rejected bytes are removed from inline preview');
      assert.match(h.states[1], /文件内容与交付记录不一致/);
    }
    for (let i = 0; i < 3; i++) { h.render(); await flush(); }
    assert.equal(requests.length, 2, 'settled integrity result does not trigger more downloads');
    h.unmount();
    console.log('PASS image ' + mismatch + ' mismatch ' + (freshMatches ? 'refreshes once and opens verified delivery' : 'denies still-mismatched fresh delivery'));
  }
}

{
  let exists = true, downloads = 0, deletes = 0;
  const { fetchRemoteFile } = load('core/fileUrl.ts', {
    'react-native-blob-util': { default: {
      fs: { dirs: { CacheDir: '/cache' }, exists: async () => exists, stat: async () => ({ size: 3 }), unlink: async () => { deletes++; exists = false; } },
      config: () => ({ fetch: async () => { downloads++; exists = true; return { info: () => ({ status: 200 }) }; } }),
    } }, './net-security': { assertSecureUrl() {} }, './installable': { isInstallablePackage: () => false },
    './pendingSend/fingerprint': { sha256Hex: value => createHash('sha256').update(value).digest('hex') },
  }, { URLSearchParams });
  await fetchRemoteFile('http://127.0.0.1:9', undefined, '/workspace/result.md');
  assert.equal(downloads, 0);
  await fetchRemoteFile('http://127.0.0.1:9', undefined, '/workspace/result.md', { forceDownload: true });
  assert.equal(downloads, 1); assert.equal(deletes, 1);
  console.log('PASS forced file download replaces a nonempty HTTP cache entry');
}
// Control the sheet's native handle; assertions exercise its actual close/reopen logic.
{
  const h = hooks();
  let presented = 0, dismissed = 0, closed = 0, afterClose = 0, back;
  const { TaskDetailSheet } = load('components/TaskDetailSheet.tsx', {
    react: h.react,
    'react-native': native({ BackHandler: { addEventListener(_name, callback) { back = callback; return { remove() {} }; } } }),
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 24, bottom: 16 }) },
    '@gorhom/bottom-sheet': { BottomSheetModal: 'Sheet', BottomSheetBackdrop: 'Backdrop', BottomSheetScrollView: 'Scroll', useBottomSheetSpringConfigs: value => value },
    'react-native-reanimated': { ReduceMotion: { System: 'system' } },
    '../design/theme': { useTheme: () => theme }, './TaskMotion': { TaskPressable: 'Pressable' },
  });
  const render = (visible, children) => {
    h.begin(); h.effects.length = 0;
    const tree = TaskDetailSheet({ visible, children, onClose: () => { closed++; }, onAfterClose: () => { afterClose++; } });
    tree.props.ref.current = { present() { presented++; }, dismiss() { dismissed++; } };
    h.effects.forEach(effect => effect());
    return tree;
  };
  let tree = render(true, 'first task');
  assert.equal(presented, 1);
  tree.props.onChange(0);
  assert.equal(back(), true);
  assert.equal(closed, 1, 'Android Back requests closure');
  tree = render(false, null);
  assert.equal(dismissed, 1);
  assert.equal(afterClose, 0, 'completion waits for native dismissal');
  assert.ok(nodes(tree).find(node => node.type === 'Scroll').children.includes('first task'), 'closing retains its content');
  tree.props.onDismiss();
  assert.equal(afterClose, 1);
  console.log('PASS sheet retains closing content and completes after native dismissal');

  render(true, 'second task').props.onChange(0);
  const closing = render(false, null);
  tree = render(true, 'third task');
  const before = { presented, closed, afterClose };
  closing.props.onDismiss();
  assert.equal(presented, before.presented, 'reopen waits for the fresh native ref to commit');
  const oldKey = tree.props.key;
  tree = render(true, 'third task');
  assert.notEqual(tree.props.key, oldKey, 'each dismissed presentation gets a fresh native instance');
  assert.equal(presented, before.presented + 1, 'fresh native instance presents after commit');
  closing.props.onDismiss();
  assert.equal(closed, before.closed, 'old dismissal cannot clear the new selection');
  assert.equal(afterClose, before.afterClose, 'reopen cannot trigger pending navigation');
  assert.ok(nodes(tree).find(node => node.type === 'Scroll').children.includes('third task'));
  tree.props.onDismiss();
  assert.equal(afterClose, before.afterClose + 1, 'gesture dismissal completes normally');
  console.log('PASS sheet reopens latest task without completing the superseded close');

  render(true, 'quickly closed task');
  const dismissCount = dismissed;
  tree = render(false, null);
  assert.equal(dismissed, dismissCount, 'a not-yet-mounted native sheet cannot be dismissed');
  tree.props.onChange(0);
  assert.equal(dismissed, dismissCount + 1, 'queued close runs after native opening');
  tree.props.onDismiss();
  const presentCount = presented;
  render(true, 'reopened after quick Back');
  assert.equal(presented, presentCount + 1, 'quick Back cannot leave presentation locked');
  console.log('PASS close before native mount is deferred and does not lock reopening');
}
{
  const h = taskHarness({ workspaces: [] });
  h.render(); h.states[0] = [task];
  button(h.render(), 'Test').props.onPress();
  let tree = h.render();
  const background = () => nodes(tree).find(node => 'importantForAccessibility' in node.props);
  assert.equal(background().props.importantForAccessibility, 'no-hide-descendants');
  let sheet = nodes(tree).find(node => node.type === 'TaskDetailSheet');
  sheet.props.onClose(); tree = h.render();
  assert.equal(background().props.importantForAccessibility, 'no-hide-descendants', 'background stays hidden during exit');
  sheet = nodes(tree).find(node => node.type === 'TaskDetailSheet');
  sheet.props.onAfterClose(); tree = h.render();
  assert.equal(background().props.importantForAccessibility, 'auto');
  console.log('PASS detail isolates background accessibility until native dismissal');
}
{
  const requests = [], timers = [];
  let onState;
  const h = taskHarness({workspaces: [{path:'/workspace'}], listButlerTasks: () => new Promise(resolve => requests.push(resolve))}, {
    AppState: {currentState:'active', addEventListener(_name, listener) {onState=listener;return {remove(){}};}},
  }, {setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){}});
  h.render();const cleanup=h.effects[1]();
  requests[0]([{...task,status:'completed'}]);await flush();
  assert.equal(timers.at(-1).ms,15000);
  const first=h.states[0];timers.at(-1).fn();requests[1]([{...task,status:'completed'}]);await flush();
  assert.equal(h.states[0],first,'unchanged polls preserve the complete list reference');
  timers.at(-1).fn();requests[2]([{...task,status:'running',revision:2}]);await flush();
  assert.equal(timers.at(-1).ms,3000,'running tasks restore fast polling');
  const oldTick=timers.at(-1).fn;onState('background');oldTick();assert.equal(requests.length,3,'background stops scheduling');
  onState('active');assert.equal(requests.length,4,'foreground refreshes immediately');cleanup();requests[3]([]);await flush();
  console.log('PASS real page polling adapts to full task state, reuses data and stops in background');
}
{
  const h=taskHarness({workspaces:[]});h.render();
  h.states[0]=[task,{...task,id:'running',title:'Running',status:'running'},{...task,id:'done',title:'Done',status:'completed'}];
  let tree=h.render();button(tree,'待处理').props.onPress();tree=h.render();
  let list=nodes(tree).find(n=>n.type==='FlatList');assert.deepEqual(Array.from(list.props.data,t=>t.id),['task-1']);
  assert.equal(list.props.initialNumToRender,6);assert.equal(list.props.maxToRenderPerBatch,8);
  button(tree,'已结束').props.onPress();tree=h.render();list=nodes(tree).find(n=>n.type==='FlatList');assert.deepEqual(Array.from(list.props.data,t=>t.id),['done']);
  assert.equal(h.states[0].length,3,'filters do not replace the authoritative task collection');
  button(tree,'全部').props.onPress();tree=h.render();assert.equal(nodes(tree).find(n=>n.type==='FlatList').props.data.length,3);
  console.log('PASS page filters preserve all data and use a bounded virtualized list');
}
{
  const requests=[],timers=[];const h=taskHarness({workspaces:[{path:'/workspace'}],listButlerTasks:()=>new Promise(resolve=>requests.push(resolve))},{
    AppState:{currentState:'active',addEventListener(){return {remove(){}};}},
  },{setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){}});
  h.render();const cleanup=h.effects[1]();requests[0]([task]);await flush();
  const tick=timers.at(-1);tick();
  const list=nodes(h.render()).find(n=>n.type==='FlatList');list.props.refreshControl.props.onRefresh();
  assert.equal(requests.length,3);requests[2]([{...task,revision:7,status:'completed'}]);await flush();requests[1]([{...task,revision:2}]);await flush();
  assert.equal(h.states[0][0].revision,7);assert.equal(h.states[2],false,'manual refresh settles its spinner');cleanup();
  console.log('PASS manual refresh supersedes a pending poll without stale rollback');
}
{
  const h=taskHarness({workspaces:[],resumeButlerTask:async()=>({...task,revision:5,status:'running'}),listButlerTasks:async()=>[task]});
  h.render();h.states[0]=[task];button(h.render(),'Test').props.onPress();
  button(h.render(),'继续执行').props.onPress();await flush();
  assert.equal(h.states[0][0].revision,5,'action result appears immediately and survives an older list response');
  assert.equal(h.states[4].revision,5);
  console.log('PASS action result revision protects both list and open detail');
}
console.log('butler-mobile-flow-spec: 21 passed');
