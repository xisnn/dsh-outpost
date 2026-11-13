// P4-0.1 P1-1（N2）：首启工作区弹层必须有真实退出路径。
//
// 修前：HomeScreen 传 onCancel={() => {}} 且未传 allowCancel → 空工作区时
// 弹层无取消按钮、BACK 走 no-op、背板不可点，用户被锁死；butlerMode 已持久化
// → force-stop 重启后再次陷入（真实 Emulator 复现，见 p401-n2-modal-red.png）。
//
// 本文件驱动真实组件代码（ButlerWorkspacePicker + HomeScreen 接线），
// 断言：取消按钮存在且生效、Android BACK（onRequestClose）生效、
// 取消只关闭管家模式（不清数据）、普通模式不弹、已有会话不弹。
import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, loadSource } from './support/component-harness.mjs';

const pickerModules = {
  './MotionModal': { MotionModal: 'Modal' },
  './MotionPressable': { MotionPressable: 'Pressable' },
  '../design/theme': {
    useTheme: () => ({
      colors: { scrim: '#000', bgRaised: '#fff', bgCard: '#eee', text: '#000', textTertiary: '#666', textFaint: '#999', textSecondary: '#333' },
      radius: { lg: 12, sm: 6 },
      type: { lg: 18, xs: 12, base: 16, sm: 14, micro: 10 },
      weight: { semibold: '600', medium: '500' },
    }),
  },
  'react-native': {
    FlatList: (props) => ({
      type: 'View',
      props: {},
      children: (props.data ?? []).map((item) => props.renderItem({ item })),
    }),
    StyleSheet: { create: (v) => v },
    Text: 'Text',
    View: 'View',
  },
};

// loadSource() outside componentHarness needs an explicit react stub.
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useState: (i) => [i, () => {}],
};
reactStub.default = reactStub;

function picker(props) {
  return componentHarness('components/ButlerWorkspacePicker.tsx', 'ButlerWorkspacePicker', props, pickerModules);
}

function texts(h) {
  return h.nodes().filter((n) => n.type === 'Text').map((n) => n.children.flat(Infinity).join(''));
}
function descendantTexts(node) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'Text') out.push((n.children ?? []).flat(Infinity).join(''));
    for (const c of (n.children ?? []).flat(Infinity)) walk(c);
  };
  walk(node);
  return out;
}
function cancelButton(h) {
  return h.nodes().find((n) => n.type === 'Pressable' && descendantTexts(n).includes('取消'));
}
function modal(h) {
  return h.nodes().find((n) => n.type === 'Modal');
}

test('empty picker without allowCancel has no exit (documents the old trap shape)', () => {
  let cancelled = 0;
  const h = picker({ visible: true, workspaces: [], onPick: () => {}, onCancel: () => { cancelled += 1; } });
  assert.equal(cancelButton(h), undefined);
  // BACK reaches the component but the old caller supplied a no-op; the
  // component itself must still forward the event so a real onCancel works.
  modal(h).props.onRequestClose();
  assert.equal(cancelled, 1);
});

test('allowCancel renders a working cancel button', () => {
  let cancelled = 0;
  const h = picker({ visible: true, workspaces: [], allowCancel: true, onPick: () => {}, onCancel: () => { cancelled += 1; } });
  const btn = cancelButton(h);
  assert.ok(btn, 'cancel button must exist when allowCancel');
  btn.props.onPress();
  assert.equal(cancelled, 1);
});

test('Android back (onRequestClose) cancels when allowCancel', () => {
  let cancelled = 0;
  const h = picker({ visible: true, workspaces: [], allowCancel: true, onPick: () => {}, onCancel: () => { cancelled += 1; } });
  modal(h).props.onRequestClose();
  assert.equal(cancelled, 1);
});

test('picking a workspace still works and is unchanged', () => {
  const picked = [];
  const ws = [{ path: '/proj/a', name: 'A', sessions: [] }];
  const h = picker({ visible: true, workspaces: ws, allowCancel: true, onPick: (p) => picked.push(p), onCancel: () => {} });
  const row = h.nodes().find((n) => n.type === 'Pressable' && n.props.onPress && descendantTexts(n).some((t) => t.includes('/proj/a')));
  assert.ok(row, 'workspace row present');
  row.props.onPress();
  assert.deepEqual(picked, ['/proj/a']);
});

// ── HomeScreen wiring: the first-run picker must be cancellable ──
function home(ctx) {
  const calls = [];
  const realPicker = loadSource('components/ButlerWorkspacePicker.tsx', { ...pickerModules, react: reactStub });
  const modules = {
    '../App': { useApp: () => ({ ...ctx, setButlerMode: (on) => calls.push(on) }) },
    '../nav/NavHost': { useNav: () => ({ stack: [], push: () => {}, popToRoot: () => {} }) },
    '../components/TabBar': { TabBar: 'TabBar' },
    '../components/ButlerWorkspacePicker': realPicker,
    './ChatScreen': { ChatScreen: 'ChatScreen' },
    './AgentButlerScreen': { AgentButlerScreen: 'AgentButlerScreen' },
    './LocalProfileScreen': { LocalProfileScreen: 'LocalProfileScreen' },
    './ProfileScreen': { ProfileScreen: 'ProfileScreen' },
    './WorkspacesScreen': { WorkspacesScreen: 'WorkspacesScreen' },
    './MotionModal': { MotionModal: 'Modal' },
    'react-native': {
      ActivityIndicator: 'ActivityIndicator',
      FlatList: 'FlatList',
      StyleSheet: { create: (v) => v },
      Text: 'Text',
      View: 'View',
    },
  };
  const h = componentHarness('screens/HomeScreen.tsx', 'HomeScreen', { active: true }, modules);
  return { h, calls };
}

const trapped = {
  authed: false,
  butlerMode: true,
  location: 'desktop',
  butlerSessionId: null,
  butlerBusy: false,
  butlerNeedWorkspace: true,
  pickButlerWorkspace: () => {},
  store: { workspaces: [] },
};

test('first-run empty-workspace modal is visible and cancellable', () => {
  const { h, calls } = home(trapped);
  const m = modal(h);
  assert.ok(m, 'modal shown when butler+desktop+no session+needs workspace');
  assert.equal(m.props.visible, true);
  const btn = cancelButton(h);
  assert.ok(btn, 'HomeScreen must pass allowCancel so a cancel button exists');
  btn.props.onPress();
  assert.deepEqual(calls, [false], 'cancel turns butler mode off (persisted), no data cleared');
});

test('Android back on the first-run modal turns butler mode off', () => {
  const { h, calls } = home(trapped);
  modal(h).props.onRequestClose();
  assert.deepEqual(calls, [false]);
});

test('no modal when butler mode is off', () => {
  const { h } = home({ ...trapped, butlerMode: false });
  assert.notEqual(modal(h)?.props.visible, true, 'picker must not be visible');
});

test('no modal once a butler session exists', () => {
  const { h } = home({ ...trapped, butlerSessionId: 's1' });
  assert.notEqual(modal(h)?.props.visible, true, 'picker must not be visible');
});

test('no modal in local location', () => {
  const { h } = home({ ...trapped, location: 'local' });
  assert.notEqual(modal(h)?.props.visible, true, 'picker must not be visible');
});