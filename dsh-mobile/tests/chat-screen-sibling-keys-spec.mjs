// D-1：同一父节点下的兄弟 key 必须唯一，否则 React 会 warnOnInvalidKey 并可能重复/丢弃子节点。
// 这里渲染真实的 ChatScreen，按 React 的兄弟集合口径检查 key 冲突。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import ts from 'typescript';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const srcRoot = new URL('../src/', import.meta.url);
const tokens = loadTs('design/tokens.ts');
const theme = { ...tokens, colors: tokens.lightPalette };

function loadTs(file, modules) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(new URL(file, srcRoot), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(code, {
    exports, console, __DEV__: true, process,
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); t.unref(); return t; },
    clearTimeout, setInterval(fn, ms) { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval,
    require: makeRequire(file, modules),
  });
  return exports;
}

// 组件一律降级成字符串占位：本用例只关心它们的 key，不关心内部实现。
const componentProxy = () => new Proxy({}, { get: (_t, key) => (key === '__esModule' ? false : String(key)) });

function makeRequire(fromFile, modules = {}) {
  return (name) => {
    if (name in modules) return modules[name];
    if (name.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), name));
      // 只有纯逻辑模块才加载真实实现；UI 组件降级为占位，本用例只校验它们的 key。
      if (/^(core|design)\//.test(resolved)) {
        for (const ext of ['.ts', '.tsx']) {
          if (fs.existsSync(new URL(resolved + ext, srcRoot))) return loadTs(resolved + ext, modules);
        }
      }
      return componentProxy();
    }
    // 纯 JS 依赖（哈希等）用真实实现，避免把被测逻辑换成假的。
    try { return nodeRequire(name); } catch { return componentProxy(); }
  };
}

const noop = () => {};
const chat = {
  agentTeam: undefined, contextUsed: 0, contextWindow: 0, error: undefined, hasOlder: false,
  items: [], loading: false, loadingOlder: false, model: 'stub', provider: 'stub',
  reasoningEffort: undefined, running: false, tokenUsage: undefined, turns: [],
};
const store = {
  getChat: () => chat, subscribe: () => noop, openChat: async () => {}, closeChat: noop,
  connection: 'connected', connectionError: undefined, authInvalidated: false, gatewayStatus: 'online',
  pendingApprovals: [], resolvedApprovalIds: [], authoritativeApprovalAt: undefined,
  sessions: [], workspaces: [], teamNotices: [], fileBaseUrl: 'http://127.0.0.1:3996', fileCookie: '',
  pendingSends: { ensureHydrated: async () => {}, prune: async () => [], list: async () => [] },
  abandonPending: noop, answerApproval: noop, canPrepareForkReply: () => false, cancel: async () => {},
  dismissNotice: noop, forkReply: async () => {}, loadOlder: async () => {}, loadSessions: async () => {},
  refreshChatMeta: async () => {}, retryPending: async () => {}, sendPending: async () => {}, upload: async () => {},
};

const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: 'Fragment', memo: fn => fn, forwardRef: fn => fn,
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, noop]; },
  useMemo: fn => fn(), useCallback: fn => fn, useEffect: noop, useLayoutEffect: noop,
  useRef(value) { return { current: value }; },
};
react.default = react;

const modules = {
  react,
  'react-native': {
    View: 'View', Text: 'Text', FlatList: 'FlatList', ActivityIndicator: 'ActivityIndicator',
    KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView', Image: 'Image',
    StyleSheet: { create: x => x, hairlineWidth: 1, flatten: x => x },
    Platform: { OS: 'android', select: v => v.android ?? v.default },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: noop }) },
    useWindowDimensions: () => ({ width: 360, height: 800 }),
    I18nManager: { isRTL: false },
  },
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
  '@react-native-async-storage/async-storage': {
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, getAllKeys: async () => [] },
  },
  '../App': { useApp: () => ({ store, baseUrl: 'http://127.0.0.1:3996', butlerWorkspace: '', pickButlerWorkspace: noop, butlerNeedWorkspace: false }) },
  '../nav/NavHost': { useNav: () => ({ pop: noop, push: noop, stack: [] }) },
  '../design/theme': { useTheme: () => theme },
  '../design/tokens': tokens,
  '../components/useChatScroll': {
    useChatScroll: () => ({
      scrollRef: { current: null }, awayFromBottom: false, hasNewContent: false, anchorReady: true, kbHeight: 0,
      jumpToBottom: noop, applyScrollMetrics: noop, beginDrag: noop, endDrag: noop,
      beginMomentum: noop, endMomentum: noop, contentSizeChanged: noop, viewportChanged: noop,
    }),
  },
  '../components/useChatMetaPolling': { useChatMetaPolling: noop },
  '../components/useSharedComposer': { useSharedComposer: noop },
  '../components/useButlerApprovalSessions': { useButlerApprovalSessions: () => [] },
  '../core/draftStore': { draftStore: { get: () => '', set: noop, ensureHydrated: async () => {}, flush: async () => {} }, MAX_DRAFT_CHARS: 20000 },
};

const ChatScreen = loadTs('screens/ChatScreen.tsx', modules).ChatScreen;

function label(node) {
  const t = typeof node.type === 'string' ? node.type : (node.type?.name ?? 'Component');
  return node.props?.key != null ? `${t}#${node.props.key}` : t;
}

// React 把同一 children 数组（含嵌套数组展平）当作一个兄弟集合来校验 key。
function collisions(tree) {
  const found = [];
  const visit = (node, trail) => {
    if (Array.isArray(node)) { for (const c of node) visit(c, trail); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'function') { visit(node.type({ ...node.props, children: node.children }), trail); return; }
    const kids = (node.children ?? []).flat(Infinity);
    const seen = new Map();
    for (const kid of kids) {
      if (!kid || typeof kid !== 'object' || Array.isArray(kid)) continue;
      const key = kid.props?.key;
      if (key == null) continue;
      const here = [...trail, label(node)];
      if (seen.has(key)) found.push({ key: String(key), parent: here.join(' > '), first: seen.get(key), second: label(kid) });
      else seen.set(key, label(kid));
    }
    for (const kid of kids) visit(kid, [...trail, label(node)]);
  };
  visit(tree, []);
  return found;
}

function render(props = {}) {
  return ChatScreen({ sessionId: 'session-inject-0001', title: 'P3', active: true, ...props });
}

test('普通聊天：输入区兄弟节点 key 唯一（ApprovalBanner 与 ChatComposer 不得同 key）', () => {
  const found = collisions(render());
  assert.deepEqual(found, [], `存在重复兄弟 key：${JSON.stringify(found, null, 1)}`);
});

test('管家模式与只读模式下同样没有重复兄弟 key', () => {
  for (const props of [{ butler: true }, { readOnly: true }, { butler: true, readOnly: true }, { embedded: true }]) {
    const found = collisions(render(props));
    assert.deepEqual(found, [], `${JSON.stringify(props)} 存在重复兄弟 key：${JSON.stringify(found)}`);
  }
});

test('切换 sessionId 后两个兄弟节点的 key 仍然互不相同', () => {
  for (const sessionId of ['s-a', 's-b', 'session-inject-0001']) {
    const found = collisions(render({ sessionId }));
    assert.deepEqual(found, [], `${sessionId} 存在重复兄弟 key：${JSON.stringify(found)}`);
  }
});