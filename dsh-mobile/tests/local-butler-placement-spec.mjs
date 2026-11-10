import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from './support/component-harness.mjs';

function home(overrides = {}) {
  const context = {
    authed: false,
    butlerMode: true,
    location: 'local',
    butlerSessionId: 'main',
    butlerBusy: false,
    butlerNeedWorkspace: false,
    pickButlerWorkspace: () => undefined,
    store: {
      workspaces: [],
      consumeOpenSession: () => null,
      subscribe: () => () => undefined,
    },
    ...overrides,
  };
  return componentHarness('screens/HomeScreen.tsx', 'HomeScreen', { active: true }, {
    '../components/TabBar': { TabBar: 'TabBar' },
    '../components/ButlerWorkspacePicker': { ButlerWorkspacePicker: 'Picker' },
    '../App': { useApp: () => context },
    '../nav/NavHost': {
      useNav: () => ({ stack: [{ name: 'Home' }], push: () => undefined, popToRoot: () => undefined }),
    },
    './ChatScreen': { ChatScreen: 'Chat' },
    './LocalButlerScreen': { LocalButlerScreen: 'LocalButler' },
    './AgentButlerScreen': { AgentButlerScreen: 'AgentButler' },
    './LocalProfileScreen': { LocalProfileScreen: 'LocalProfile' },
    './ProfileScreen': { ProfileScreen: 'Profile' },
    './WorkspacesScreen': { WorkspacesScreen: 'Workspaces' },
  });
}

const hasType = (h, type) => h.nodes().some(node => node.type === type);

test('unpaired local mode swaps the butler pane and uses the local profile', () => {
  const h = home();
  assert.equal(hasType(h, 'AgentButler'), true);
  assert.equal(hasType(h, 'LocalButler'), false);
  assert.equal(hasType(h, 'Chat'), false);
  assert.equal(hasType(h, 'LocalProfile'), true, 'unpaired users get the local settings page');
  assert.equal(hasType(h, 'Profile'), false);
});

test('paired users keep the existing desktop profile even in local mode', () => {
  const h = home({ authed: true });
  assert.equal(hasType(h, 'AgentButler'), true);
  assert.equal(hasType(h, 'LocalButler'), false);
  assert.equal(hasType(h, 'Profile'), true);
  assert.equal(hasType(h, 'LocalProfile'), false);
});

test('desktop location keeps the existing butler chat untouched', () => {
  const h = home({ authed: true, location: 'desktop' });
  assert.equal(hasType(h, 'Chat'), true);
  assert.equal(hasType(h, 'AgentButler'), false);
  assert.equal(hasType(h, 'LocalButler'), false);
});

test('local location does not require a desktop butler session', () => {
  const h = home({ butlerSessionId: null, butlerNeedWorkspace: true });
  assert.equal(hasType(h, 'AgentButler'), true);
  assert.equal(hasType(h, 'LocalButler'), false);
  assert.equal(hasType(h, 'Chat'), false);
});

test('desktop without a session keeps the existing preparation placeholder', () => {
  const h = home({ authed: true, location: 'desktop', butlerSessionId: null });
  assert.equal(hasType(h, 'Chat'), false);
  assert.equal(hasType(h, 'AgentButler'), false);
  assert.equal(hasType(h, 'LocalButler'), false);
  assert.match(h.text(), /管家还没有准备好/);
});
