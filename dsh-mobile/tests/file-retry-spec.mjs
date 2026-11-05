// Execute actual file-card and document-viewer handlers with controlled I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const flush = () => new Promise(resolve => setImmediate(resolve));
const theme = {
  colors: {}, radius: {}, space: {}, type: {}, weight: {},
  layout: { screenPadding: 16 },
};
function load(file, modules) {
  const source = fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Error, require(name) {
    assert.ok(name in modules, 'Unexpected import: ' + name);
    return modules[name];
  } });
  return exports;
}
const docx = load('core/docx.ts', {});
const native = {
  ...Object.fromEntries(['ActivityIndicator', 'Image', 'ScrollView', 'Text', 'View'].map(name => [name, name])),
  StyleSheet: { create: value => value, hairlineWidth: 1 },
  Dimensions: { get: () => ({ width: 400 }) },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
};
function nodes(tree) {
  return !tree || typeof tree !== 'object' ? []
    : [tree, ...tree.children.flat(Infinity).flatMap(nodes)];
}
function harness(file, exported, modules, initialProps) {
  const slots = [], effects = [], props = { ...initialProps };
  let cursor = 0, dirty = false, dead = false, tree;
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++;
      const slot = slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, value => {
        assert.ok(!dead, 'No state writes after unmount');
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      }];
    },
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useMemo(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { value: fn(), deps };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !equal(slots[i].deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  react.default = react;
  const component = load(file, {
    react, 'react-native': native,
    './MotionPressable': { MotionPressable: 'Pressable' },
    './MotionModal': { MotionModal: 'Modal' },
    '../design/theme': { useTheme: () => theme }, ...modules,
  })[exported];
  const render = (patch = {}) => {
    Object.assign(props, patch);
    let attempts = 0;
    do {
      assert.ok(attempts++ < 20, 'Render must settle');
      dirty = false; cursor = 0;
      tree = component(props);
      while (effects.length) effects.shift()();
    } while (dirty);
    return tree;
  };
  return {
    render,
    find: predicate => nodes(tree).find(predicate),
    text: () => nodes(tree).filter(node => node.type === 'Text').flatMap(node => node.children).join(' '),
    unmount() { slots.forEach(slot => slot?.cleanup?.()); dead = true; },
  };
}
const file = { uri: 'file:///cache/result.md', fsPath: '/cache/result.md', name: 'result.md' };
function cardHarness({ fetch, fs: fileSystem = {}, gateway = null, download, props = {} }) {
  return harness('components/FileCard.tsx', 'FileCard', {
    'react-native-blob-util': { default: { fs: fileSystem } },
    '../App': { useApp: () => ({ store: { fileBaseUrl: 'http://127.0.0.1:9', gatewayChannel: gateway }, butlerWorkspace: '/workspace' }) },
    '../core/fileUrl': { fetchRemoteFile: fetch, openLocalFile: async () => assert.fail('Markdown must use its viewer') },
    '../core/gatewayFiles': { downloadWorkspaceFile: download ?? (async () => assert.fail('Unexpected gateway download')) },
    './ImageViewer': { ImageViewer: 'ImageViewer' },
    './FileTypeBadge': { FileTypeBadge: 'FileTypeBadge' },
    '../core/picker': { formatBytes: bytes => `${bytes} B` },
    './DocumentViewer': { DocumentViewer: 'DocumentViewer', canPreviewInside: docx.canPreviewInside },
  }, { path: 'result.md', workspacePath: '/workspace', ...props });
}
function documentHarness(props, readFile) {
  return harness('components/DocumentViewer.tsx', 'DocumentViewer', {
    'react-native-blob-util': { default: { fs: { readFile } } },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    './MarkdownView': { MarkdownView: 'MarkdownView' },
    './FileActionSheet': { FileActionSheet: 'FileActionSheet' },
    '../core/docx': docx,
  }, props);
}
const cardButton = h => h.find(node => node.type === 'Pressable');
const viewer = h => h.find(node => node.type === 'DocumentViewer');
const retryButton = h => h.find(node => node.props.accessibilityLabel === '重新下载并打开文档');

// Keep promises pending to exercise multiple presses before React can rerender.
test('download failure waits for an explicit fresh retry and coalesces rapid presses', async () => {
  const requests = [];
  const h = cardHarness({ fetch: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) });
  h.render(); const firstPress = cardButton(h).props.onPress;
  firstPress(); firstPress();
  assert.equal(requests.length, 1);
  requests[0].reject(new Error('下载超时')); await flush(); h.render();
  assert.match(h.text(), /下载超时.*点击重试/);
  assert.equal(cardButton(h).props.accessibilityLabel, '重试加载 result.md');
  for (let i = 0; i < 3; i++) { h.render(); await flush(); }
  assert.equal(requests.length, 1, 'Rerenders never retry failed downloads automatically');
  const retry = cardButton(h).props.onPress;
  retry(); retry(); h.render();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].args[2], '/workspace/result.md');
  assert.equal(requests[1].args[3].forceDownload, true);
  assert.equal(cardButton(h).props.disabled, true);
  assert.doesNotMatch(h.text(), /下载超时|点击重试/);
  requests[1].resolve(file); await flush(); h.render();
  assert.equal(viewer(h).props.visible, true);
  assert.equal(cardButton(h).props.disabled, false);
  h.unmount();
});

test('a failed retry releases its lock, retains the new reason and permits another retry', async () => {
  let calls = 0;
  const h = cardHarness({ fetch: async (_base, _cookie, _path, options) => {
    calls++;
    if (calls < 3) throw new Error(calls === 1 ? '网络断开' : '服务仍不可用');
    assert.equal(options.forceDownload, true);
    return file;
  } });
  h.render(); cardButton(h).props.onPress(); await flush(); h.render();
  cardButton(h).props.onPress(); await flush(); h.render();
  assert.match(h.text(), /服务仍不可用.*点击重试/);
  assert.equal(cardButton(h).props.disabled, false);
  assert.equal(viewer(h), undefined);
  cardButton(h).props.onPress(); await flush(); h.render();
  assert.equal(calls, 3);
  assert.equal(viewer(h).props.visible, true);
  h.unmount();
});

test('actual document read failure redownloads, revalidates and rereads the same local path', async () => {
  let reads = 0, checks = 0;
  const requests = [];
  const h = cardHarness({
    fetch: (...args) => new Promise(resolve => requests.push({ args, resolve })),
    fs: { stat: async () => ({ size: 3 }), hash: async () => { checks++; return 'EXPECTED'; } },
    props: { expectedSize: 3, expectedSha256: 'expected' },
  });
  h.render(); cardButton(h).props.onPress(); requests[0].resolve(file); await flush(); h.render();
  const d = documentHarness(viewer(h).props, async () => {
    reads++;
    if (reads === 1) throw new Error('本地文档读取失败');
    return '# 已恢复';
  });
  d.render(); await flush(); d.render();
  assert.match(d.text(), /本地文档读取失败/);
  assert.ok(retryButton(d));
  d.render({ file: { uri: file.uri, name: file.name } }); await flush();
  assert.equal(reads, 1, 'An equivalent file object does not restart document parsing');
  const retry = retryButton(d).props.onPress;
  retry(); retry(); h.render();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].args[3].forceDownload, true);
  assert.equal(viewer(h).props.visible, false, 'Old viewer closes before replacing its bytes');
  d.render(viewer(h).props);
  requests[1].resolve(file); await flush(); h.render();
  assert.equal(checks, 2, 'Fresh bytes pass the original integrity gate again');
  d.render(viewer(h).props); await flush(); d.render();
  assert.equal(reads, 2, 'Reopening rereads even when URI and format are unchanged');
  assert.equal(d.find(node => node.type === 'MarkdownView').props.text, '# 已恢复');
  assert.equal(retryButton(d), undefined);
  d.unmount(); h.unmount();
});

test('document redownload failure returns to the retryable card instead of reopening stale bytes', async () => {
  let calls = 0;
  const h = cardHarness({ fetch: async () => {
    if (++calls === 2) throw new Error('重新下载失败');
    return file;
  } });
  h.render(); cardButton(h).props.onPress(); await flush(); h.render();
  viewer(h).props.onRetry(); await flush(); h.render();
  assert.equal(viewer(h).props.visible, false);
  assert.match(h.text(), /重新下载失败.*点击重试/);
  cardButton(h).props.onPress(); await flush(); h.render();
  assert.equal(calls, 3);
  assert.equal(viewer(h).props.visible, true);
  h.unmount();
});

for (const mismatch of ['size', 'sha256']) {
  test(`document retry refuses fresh ${mismatch} mismatches after one automatic redownload`, async () => {
    let tampered = false, calls = 0;
    const deleted = [], optionsSeen = [];
    const h = cardHarness({
      fetch: async (_base, _cookie, _path, options) => { calls++; optionsSeen.push(options); return file; },
      fs: {
        stat: async () => ({ size: tampered && mismatch === 'size' ? 4 : 3 }),
        hash: async () => tampered && mismatch === 'sha256' ? 'tampered' : 'expected',
        unlink: async path => { deleted.push(path); },
      },
      props: { expectedSize: 3, expectedSha256: 'expected' },
    });
    h.render(); cardButton(h).props.onPress(); await flush(); h.render();
    assert.equal(viewer(h).props.visible, true);
    tampered = true; viewer(h).props.onRetry(); await flush(); h.render();
    assert.equal(calls, 3, 'Initial open, explicit retry and one bounded integrity retry');
    assert.deepEqual(optionsSeen.map(options => options.forceDownload), [false, true, true]);
    assert.deepEqual(deleted, [file.fsPath, file.fsPath]);
    assert.equal(viewer(h), undefined, 'Rejected bytes cannot open');
    assert.match(h.text(), /文件内容与交付记录不一致.*点击重试/);
    for (let i = 0; i < 3; i++) { h.render(); await flush(); }
    assert.equal(calls, 3);
    h.unmount();
  });
}

test('explicit retry keeps gateway priority and recovers when the authenticated fallback had failed', async () => {
  let downloads = 0, http = 0;
  const gateway = {};
  const h = cardHarness({ gateway, props: { sessionId: 'session-1' },
    download: async (channel, sessionId, path) => {
      assert.equal(channel, gateway); assert.equal(sessionId, 'session-1'); assert.equal(path, 'result.md');
      if (++downloads === 1) throw new Error('网关离线');
      return { path: file.uri, name: file.name };
    },
    fetch: async () => { http++; throw new Error('HTTP 下载失败'); },
  });
  h.render(); cardButton(h).props.onPress(); await flush(); h.render();
  assert.match(h.text(), /HTTP 下载失败.*点击重试/);
  cardButton(h).props.onPress(); await flush(); h.render();
  assert.equal(downloads, 2); assert.equal(http, 1);
  assert.equal(viewer(h).props.visible, true);
  h.unmount();
});

test('document failure without a retry callback exposes no inactive retry control', async () => {
  const h = documentHarness({ visible: true, file, onClose() {} }, async () => { throw new Error('读取失败'); });
  h.render(); await flush(); h.render();
  assert.match(h.text(), /读取失败/);
  assert.equal(retryButton(h), undefined);
  assert.doesNotMatch(h.text(), /下面的按钮/);
  h.unmount();
});
