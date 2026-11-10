import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopMemoryClient, LocalMemoryClient } from '../src/core/butlerMemory.ts';

const ENTRY = {
  id: 'mem-11111111-1111-4111-8111-111111111111', kind: 'preference', key: '回答风格', value: '简洁',
  source: 'user', createdAt: 1, updatedAt: 2, revision: 1,
};
const snapshot = (butlerId, entries = [ENTRY]) => ({ butlerId, revision: 3, entries });

function desktop(overrides = {}) {
  const calls = [];
  const store = {
    async getButlerMemory() { calls.push(['load']); return overrides.load ?? snapshot('desktop-butler'); },
    async listButlerMemoryHistory(id) { calls.push(['history', id]); return overrides.history ?? []; },
    async setButlerMemory(input) { calls.push(['set', input]); return overrides.set ?? ENTRY; },
    async deleteButlerMemory(id, revision) { calls.push(['delete', id, revision]); return 4; },
  };
  return { store, calls, client: new DesktopMemoryClient(store) };
}

test('desktop memory client delegates to the paired host store', async () => {
  const { store, calls, client } = desktop();
  assert.equal(client.location, 'desktop');
  assert.equal((await client.load()).butlerId, 'desktop-butler');
  await client.history('mem-1');
  await client.set({ kind: 'preference', key: '回答风格', value: '简洁' });
  assert.equal(await client.remove(ENTRY.id, 1), 4);
  assert.deepEqual(calls, [
    ['load'], ['history', 'mem-1'],
    ['set', { kind: 'preference', key: '回答风格', value: '简洁' }],
    ['delete', ENTRY.id, 1],
  ]);
  assert.ok(store);
});

test('local memory client uses only the fixed local pipe operations', async () => {
  const calls = [];
  const runtime = {
    async query(operation, args) {
      calls.push([operation, args]);
      if (operation === 'memory') return snapshot('local-butler');
      if (operation === 'memory-history') return { changes: [{ seq: 1, at: 1, action: 'set', id: ENTRY.id, kind: 'preference', key: '回答风格' }] };
      if (operation === 'memory-set') return { entry: ENTRY, revision: 4 };
      if (operation === 'memory-delete') return { revision: 5 };
      throw new Error('unexpected ' + operation);
    },
  };
  const client = new LocalMemoryClient(runtime);
  assert.equal(client.location, 'local');
  assert.equal((await client.load()).butlerId, 'local-butler');
  assert.equal((await client.history(ENTRY.id))[0].key, '回答风格');
  await client.set({ id: ENTRY.id, kind: 'preference', key: '回答风格', value: '更简洁', expectedRevision: 1 });
  assert.equal(await client.remove(ENTRY.id, 4), 5);
  assert.deepEqual(calls, [
    ['memory', undefined],
    ['memory-history', { id: ENTRY.id }],
    ['memory-set', { id: ENTRY.id, kind: 'preference', key: '回答风格', value: '更简洁', expectedRevision: 1 }],
    ['memory-delete', { id: ENTRY.id, expectedRevision: 4 }],
  ]);
  void runtime;
});

test('the two locations never share a snapshot', async () => {
  const desktopClient = desktop({ load: snapshot('desktop-butler', [{ ...ENTRY, key: '电脑偏好' }]) }).client;
  const localClient = new LocalMemoryClient({
    async query(operation) {
      if (operation === 'memory') return snapshot('local-butler', [{ ...ENTRY, key: '本机偏好' }]);
      if (operation === 'memory-history') return { changes: [] };
      throw new Error('unexpected');
    },
  });
  const [desktopView, localView] = await Promise.all([desktopClient.load(), localClient.load()]);
  assert.notEqual(desktopView.butlerId, localView.butlerId);
  assert.equal(desktopView.entries[0].key, '电脑偏好');
  assert.equal(localView.entries[0].key, '本机偏好');
});

test('malformed snapshots fail closed instead of showing another host data', async () => {
  const client = desktop({ load: { butlerId: 7, entries: 'nope' } }).client;
  await assert.rejects(() => client.load(), /Invalid butler memory snapshot/);
});
