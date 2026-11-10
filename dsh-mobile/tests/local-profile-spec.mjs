import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from './support/component-harness.mjs';

const theme = {
  colors: {
    bg: '#fff', bgRaised: '#f7f7f7', text: '#111', textSecondary: '#444', textTertiary: '#777',
    accent: '#06f', accentWash: '#eef', border: '#ddd', borderStrong: '#ccc',
  },
  space: { sm: 8, md: 12, lg: 16, xl: 24, xxxl: 40 },
  type: { micro: 11, xs: 12, sm: 14, base: 16, lg: 18 },
  radius: { sm: 8, md: 12, lg: 16 },
  layout: { screenPadding: 16 },
  modes: ['light', 'warm', 'dark'],
  mode: 'light',
  setMode: () => undefined,
};

function profile({ location = 'local', setLocation = () => undefined, onOpenButler = () => undefined } = {}) {
  return componentHarness('screens/LocalProfileScreen.tsx', 'LocalProfileScreen', { onOpenButler }, {
    '../App': { useApp: () => ({ location, setLocation }) },
    '../design/theme': { useTheme: () => theme },
    '../components/Header': { Header: 'Header' },
    '../nav/NavHost': { useNav: () => ({ push: () => undefined }) },
    '../components/MotionPressable': { MotionPressable: 'Pressable' },
    '../components/SlideSegmented': { SlideSegmented: 'SlideSegmented' },
    '../components/ui': { SectionLabel: 'SectionLabel' },
    '../core/version': { APP_VERSION_LABEL: 'v0.18.3 (180300)' },
  });
}

test('the unpaired profile states the local-only boundary', () => {
  const h = profile();
  assert.match(h.text(), /还没有连接电脑/);
  assert.match(h.text(), /只是本机|仅本机|本机管家可以独立执行任务/);
  assert.match(h.text(), /v0\.18\.3/);
});

test('choosing desktop leaves local mode through the same persisted location', () => {
  const calls = [];
  const h = profile({ setLocation: next => calls.push(next) });
  const segmented = h.nodes().find(node => node.type === 'SlideSegmented' && node.props.accessibilityLabel === '管家运行位置');
  assert.ok(segmented);
  assert.equal(segmented.props.value, 'local');
  segmented.props.onChange('desktop');
  assert.deepEqual(calls, ['desktop']);
});

test('the local butler entry opens the local pane without touching the store', () => {
  let opened = 0;
  const h = profile({ onOpenButler: () => { opened += 1; } });
  h.button('打开本机管家').props.onPress();
  assert.equal(opened, 1);
});
