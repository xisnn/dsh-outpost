import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HOST_LOCATION,
  HOST_LOCATION_KEY,
  loadHostLocation,
  localRuntimeSupported,
  parseHostLocation,
  saveHostLocation,
} from '../src/core/hostLocation.ts';

function memory(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(key) { return map.get(key) ?? null; },
    async setItem(key, value) { map.set(key, value); },
  };
}

test('location defaults to desktop for missing, invalid or unreadable storage', async () => {
  assert.equal(DEFAULT_HOST_LOCATION, 'desktop');
  assert.equal(parseHostLocation(null), 'desktop');
  assert.equal(parseHostLocation(''), 'desktop');
  assert.equal(parseHostLocation('local'), 'local');
  assert.equal(parseHostLocation('LOCAL'), 'desktop');
  assert.equal(await loadHostLocation(memory()), 'desktop');
  assert.equal(await loadHostLocation(memory({ [HOST_LOCATION_KEY]: 'nonsense' })), 'desktop');
  assert.equal(await loadHostLocation({ async getItem() { throw new Error('storage down'); } }), 'desktop');
});

test('location persists under its own additive key', async () => {
  const storage = memory();
  await saveHostLocation(storage, 'local');
  assert.equal(storage.map.get(HOST_LOCATION_KEY), 'local');
  assert.equal(await loadHostLocation(storage), 'local');
  assert.notEqual(HOST_LOCATION_KEY, '@dsh/baseUrl');
  assert.notEqual(HOST_LOCATION_KEY, '@dsh/butlerMode');
  await saveHostLocation(storage, 'desktop');
  assert.equal(await loadHostLocation(storage), 'desktop');
});

test('local runtime support is Android + native module only', () => {
  assert.equal(localRuntimeSupported('android', {}), true);
  assert.equal(localRuntimeSupported('android', null), false);
  assert.equal(localRuntimeSupported('ios', {}), false);
  assert.equal(localRuntimeSupported('web', {}), false);
});
