import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../lib/memory-store.js';
import { MEMORY_LIMITS } from '../lib/memory-limits.js';

function fakeDomain() {
  const tables = new Map();
  return {
    tables,
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const table = tables.get(name);
      return {
        get: key => table.get(key),
        put: async (key, value) => { table.set(key, structuredClone(value)); },
        delete: async key => { table.delete(key); },
        entries: () => [...table.entries()].map(([key, value]) => [key, structuredClone(value)]),
      };
    },
  };
}

function expectCode(fn, code) {
  return assert.rejects(fn, error => error?.code === code);
}

test('identity is generated once and survives reload', async () => {
  const domain = fakeDomain();
  const first = new MemoryStore({ domain });
  await first.load();
  const id = first.identity().butlerId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const second = new MemoryStore({ domain });
  await second.load();
  assert.equal(second.identity().butlerId, id);
  assert.equal(second.snapshot().entries.length, 0);
});

test('user memory supports create, update and delete with revisions', async () => {
  const domain = fakeDomain();
  let now = 100;
  const store = new MemoryStore({ domain, now: () => now++, idFactory: () => 'mem-11111111-1111-4111-8111-111111111111' });
  await store.load();
  const created = await store.set({ kind: 'preference', key: '回答风格', value: '  简洁  ' });
  assert.equal(created.value, '简洁');
  assert.equal(created.source, 'user');
  assert.equal(created.revision, 1);
  assert.equal(store.snapshot().revision, 1);
  const updated = await store.set({ id: created.id, kind: 'preference', key: '回答风格', value: '更简洁', expectedRevision: 1 });
  assert.equal(updated.id, created.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, created.createdAt);
  await expectCode(() => store.set({ id: created.id, kind: 'preference', key: '回答风格', value: 'x', expectedRevision: 1 }), 'memory-conflict');
  const deleted = await store.delete({ id: created.id, expectedRevision: 2 });
  assert.equal(deleted.id, created.id);
  assert.equal(store.snapshot().entries.length, 0);
  assert.deepEqual(store.history().map(change => change.action), ['set', 'set', 'delete']);
});

test('same key in the same kind updates one entry; another kind is independent', async () => {
  const domain = fakeDomain();
  const store = new MemoryStore({ domain });
  await store.load();
  const one = await store.set({ kind: 'preference', key: '语言', value: '中文' });
  const two = await store.set({ kind: 'preference', key: '语言', value: '中文为主' });
  assert.equal(two.id, one.id);
  assert.equal(two.revision, 2);
  const project = await store.set({ kind: 'project', key: '语言', value: 'TypeScript' });
  assert.notEqual(project.id, one.id);
  assert.equal(store.snapshot().entries.length, 2);
});

test('memory bounds and validation fail closed', async () => {
  const domain = fakeDomain();
  const store = new MemoryStore({ domain });
  await store.load();
  await expectCode(() => store.set({ kind: 'secret', key: 'k', value: 'v' }), 'memory-kind');
  await expectCode(() => store.set({ kind: 'preference', key: '', value: 'v' }), 'memory-arguments');
  await expectCode(() => store.set({ kind: 'preference', key: 'k'.repeat(MEMORY_LIMITS.key + 1), value: 'v' }), 'memory-arguments');
  await expectCode(() => store.set({ kind: 'preference', key: 'k', value: 'v'.repeat(MEMORY_LIMITS.value + 1) }), 'memory-arguments');
  await expectCode(() => store.delete({ id: 'mem-00000000-0000-4000-8000-000000000000' }), 'memory-not-found');
  for (let i = 0; i < MEMORY_LIMITS.entries; i += 1) {
    await store.set({ kind: 'project', key: `k${i}`, value: `v${i}` });
  }
  await expectCode(() => store.set({ kind: 'project', key: 'one-more', value: 'v' }), 'memory-full');
});

test('reload replays the journal and keeps history', async () => {
  const domain = fakeDomain();
  const first = new MemoryStore({ domain });
  await first.load();
  const entry = await first.set({ kind: 'project', key: '仓库', value: 'dsBot' });
  await first.set({ kind: 'preference', key: '语气', value: '直接' });
  const second = new MemoryStore({ domain });
  await second.load();
  assert.equal(second.identity().butlerId, first.identity().butlerId);
  assert.equal(second.snapshot().entries.length, 2);
  assert.ok(second.snapshot().entries.some(item => item.id === entry.id && item.value === 'dsBot'));
  assert.deepEqual(second.history().map(change => change.action), ['set', 'set']);
});

test('compaction preserves entries and the most recent change audit', async () => {
  const domain = fakeDomain();
  let now = 1;
  const store = new MemoryStore({ domain, now: () => now++ });
  await store.load();
  const entry = await store.set({ kind: 'preference', key: 'k', value: 'v0' });
  for (let i = 1; i <= 300; i += 1) {
    await store.set({ id: entry.id, kind: 'preference', key: 'k', value: `v${i}` });
  }
  assert.ok(domain.table('journal').entries().length <= 256, 'journal stays bounded');
  assert.ok(domain.table('journal').entries().length < 300, 'journal does not grow with every edit');
  const reloaded = new MemoryStore({ domain });
  await reloaded.load();
  const [only] = reloaded.snapshot().entries;
  assert.equal(only.id, entry.id);
  assert.equal(only.value, 'v300');
  assert.equal(reloaded.history().length, MEMORY_LIMITS.history);
  assert.equal(reloaded.history().at(-1).action, 'set');
});

test('a corrupt journal fails closed without inventing identity or entries', async () => {
  const domain = fakeDomain();
  const first = new MemoryStore({ domain });
  await first.load();
  await first.set({ kind: 'preference', key: 'k', value: 'v' });
  const journal = domain.table('journal');
  const [[key, event]] = journal.entries();
  await journal.put(key, { ...event, entry: { ...event.entry, value: '' } });
  const broken = new MemoryStore({ domain });
  await assert.rejects(() => broken.load(), /butler memory is corrupt/);
  assert.throws(() => broken.snapshot(), /butler memory is corrupt/);
});
