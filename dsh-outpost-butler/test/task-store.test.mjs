import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { TaskStore, newTaskRecord } from '../lib/task-store.js';

class FakeTable {
  constructor() {
    this.map = new Map();
    this.readKeys = [];
    this.writeKeys = [];
    this.beforePut = null;
    this.afterPut = null;
  }
  get(key) {
    this.readKeys.push(key);
    return this.map.get(key);
  }
  set(key, value) {
    this.map.set(key, structuredClone(value));
  }
  *entries() {
    for (const [key, value] of this.map) yield [key, structuredClone(value)];
  }
  get size() {
    return this.map.size;
  }
  async put(key, value) {
    this.writeKeys.push(key);
    await this.beforePut?.(key, value);
    this.map.set(key, structuredClone(value));
    await this.afterPut?.(key, value);
  }
  async delete(key) {
    return this.map.delete(key);
  }
}

class FakeDomain {
  constructor() {
    this.tables = {
      tasks: new FakeTable(),
      journal: new FakeTable(),
      idempotency: new FakeTable(),
    };
  }
  table(name) {
    return this.tables[name];
  }
}

function makeStore(domain = new FakeDomain(), now = () => 1000) {
  let counter = 0;
  return {
    domain,
    store: new TaskStore({
      domain,
      now,
      idFactory: () => `task-${++counter}`,
    }),
  };
}

const base = {
  objective: 'summarize the release notes',
  cwd: 'C:/work/example',
  maxGoalRounds: 8,
  autoResume: false,
  title: 'release summary',
};

test('creates a task and lists it', async () => {
  const { store } = makeStore();
  await store.load();
  const task = await store.create(base);
  assert.equal(task.id, 'task-1');
  assert.equal(task.status, 'created');
  assert.equal(task.revision, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(task.id).objective, base.objective);
});

test('updates bump revision and persist the full task', async () => {
  const { store } = makeStore();
  await store.load();
  const task = await store.create(base);
  const running = await store.update(task.id, { status: 'running', sessionId: 'session-1' });
  assert.equal(running.revision, 2);
  assert.equal(running.status, 'running');
  assert.equal(store.get(task.id).sessionId, 'session-1');
});

test('journal replays over a stale task snapshot', async () => {
  const { store, domain } = makeStore();
  await store.load();
  const task = await store.create(base);
  await store.update(task.id, { status: 'running' });

  // Simulate a crash after the journal write but before the snapshot write.
  domain.tables.tasks.set(task.id, { ...task, status: 'created', revision: 1 });

  const replayed = new TaskStore({ domain });
  await replayed.load();
  assert.equal(replayed.get(task.id).status, 'running');
  assert.equal(replayed.get(task.id).revision, 2);
  assert.equal(domain.tables.tasks.get(task.id).status, 'running');
});

test('idempotency key returns the same task', async () => {
  const { store } = makeStore();
  await store.load();
  const first = await store.create({ ...base, idempotencyKey: 'key-1' });
  const second = await store.create({ ...base, idempotencyKey: 'key-1' });
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
});

test('recovers idempotency when the index write was lost', async () => {
  const { store, domain } = makeStore();
  await store.load();
  const first = await store.create({ ...base, idempotencyKey: 'key-2' });
  domain.tables.idempotency.map.clear();

  const replayed = new TaskStore({ domain });
  await replayed.load();
  const second = await replayed.create({ ...base, idempotencyKey: 'key-2' });
  assert.equal(first.id, second.id);
  assert.equal(replayed.list().length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function persistedTask(overrides = {}) {
  return { ...newTaskRecord({ ...base, id: 'legacy-task', now: 1000 }), ...overrides };
}

function seedEvent(domain, seq, task, kind = 'created') {
  domain.tables.journal.set(String(seq).padStart(8, '0'), {
    seq, taskId: task.id, at: 1000, kind, task,
  });
}

test('concurrent creates with the same key share one committed task', async () => {
  const { store, domain } = makeStore();
  await store.load();
  const entered = deferred();
  const release = deferred();
  domain.tables.journal.beforePut = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = store.create({ ...base, idempotencyKey: 'shared-request' });
  await entered.promise;
  const rest = Array.from({ length: 23 }, () => store.create({
    ...base, idempotencyKey: 'shared-request',
  }));
  await nextTurn();
  const attemptsWhileBlocked = domain.tables.journal.writeKeys.length;
  release.resolve();
  const tasks = await Promise.all([first, ...rest]);
  assert.equal(attemptsWhileBlocked, 1);
  assert.ok(tasks.every((task) => task === tasks[0]));
  assert.equal(domain.tables.journal.size, 1);
  assert.equal(domain.tables.tasks.size, 1);
  assert.equal(domain.tables.idempotency.size, 1);
  assert.equal(store.list().length, 1);
});

test('concurrent creates with different keys serialize journal writes across tasks', async () => {
  const { store, domain } = makeStore();
  await store.load();
  let active = 0;
  let peak = 0;
  domain.tables.journal.beforePut = async () => {
    peak = Math.max(peak, ++active);
    await nextTurn();
  };
  domain.tables.journal.afterPut = () => { active -= 1; };
  const tasks = await Promise.all(Array.from({ length: 16 }, (_, i) => store.create({
    ...base, idempotencyKey: `distinct-request-${i}`,
  })));
  assert.equal(peak, 1);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 16);
  assert.deepEqual([...domain.tables.journal.entries()].map(([, event]) => event.seq),
    Array.from({ length: 16 }, (_, i) => i + 1));
  const replayed = new TaskStore({ domain });
  await replayed.load();
  assert.equal(replayed.list().length, 16);
});

test('concurrent updates and creates preserve task revisions and global append order', async () => {
  const { store, domain } = makeStore();
  await store.load();
  const first = await store.create(base);
  const second = await store.create(base);
  let active = 0;
  let peak = 0;
  domain.tables.journal.beforePut = async () => {
    peak = Math.max(peak, ++active);
    await nextTurn();
  };
  domain.tables.journal.afterPut = () => { active -= 1; };
  await Promise.all(Array.from({ length: 6 }, () => [
    store.update(first.id, (task) => ({ goalRevision: task.goalRevision + 1 })),
    store.update(second.id, (task) => ({ goalRevision: task.goalRevision + 1 })),
    store.create(base),
  ]).flat());
  assert.equal(peak, 1);
  assert.equal(store.get(first.id).revision, 7);
  assert.equal(store.get(first.id).goalRevision, 6);
  assert.equal(store.get(second.id).revision, 7);
  assert.equal(store.get(second.id).goalRevision, 6);
  const replayed = new TaskStore({ domain });
  await replayed.load();
  assert.deepEqual(replayed.list(), store.list());
  assert.equal(replayed.seq, 20);
});

test('committed creates survive interrupted snapshot and index writes', async (t) => {
  for (const tableName of ['tasks', 'idempotency']) {
    for (const phase of ['beforePut', 'afterPut']) {
      await t.test(`${tableName} ${phase}`, async () => {
        const { store, domain } = makeStore();
        await store.load();
        const table = domain.tables[tableName];
        table[phase] = () => { throw new Error('injected cache write interruption'); };
        const first = await store.create({ ...base, idempotencyKey: 'interrupted-request' });
        assert.equal(store.get(first.id), first);
        assert.equal(domain.tables.journal.size, 1);
        const retry = await store.create({ ...base, idempotencyKey: 'interrupted-request' });
        assert.equal(retry.id, first.id);

        // Even persistent cache failure must not block journal recovery.
        const replayed = new TaskStore({ domain });
        await replayed.load();
        assert.equal(replayed.get(first.id).id, first.id);
        const recovered = await replayed.create({ ...base, idempotencyKey: 'interrupted-request' });
        assert.equal(recovered.id, first.id);
        assert.equal(domain.tables.journal.size, 1);
        table[phase] = null;
        await replayed.load();
        await replayed.findByIdempotency('interrupted-request');
        assert.deepEqual(domain.tables.tasks.get(first.id), first);
        assert.equal(domain.tables.idempotency.size, 1);
      });
    }
  }
});

test('failed update snapshots leave the journal authoritative in memory and on repeated load', async () => {
  const { store, domain } = makeStore();
  await store.load();
  const first = await store.create(base);
  domain.tables.tasks.beforePut = () => { throw new Error('injected snapshot failure'); };
  const running = await store.update(first.id, { status: 'running' });
  assert.equal(store.get(first.id), running);
  assert.equal(domain.tables.tasks.get(first.id).revision, 1);
  const replayed = new TaskStore({ domain });
  await replayed.load();
  await replayed.load();
  assert.deepEqual(replayed.get(first.id), running);
  const completed = await replayed.update(first.id, { status: 'completed' });
  assert.equal(completed.revision, 3);
  domain.tables.tasks.beforePut = null;
  await replayed.load();
  assert.deepEqual(domain.tables.tasks.get(first.id), completed);
  assert.equal(replayed.seq, 3);
});

test('journal overrides conflicting snapshots at the same or a higher revision', async (t) => {
  for (const revision of [2, 99]) {
    await t.test(`snapshot revision ${revision}`, async () => {
      const { store, domain } = makeStore();
      await store.load();
      const first = await store.create(base);
      const running = await store.update(first.id, { status: 'running' });
      domain.tables.tasks.set(first.id, { ...first, revision });
      await store.load();
      assert.deepEqual(store.get(first.id), running);
      assert.deepEqual(domain.tables.tasks.get(first.id), running);
    });
  }
});

test('legacy snapshots and raw indexes remain readable without a schema migration', async () => {
  const domain = new FakeDomain();
  const legacy = persistedTask({ revision: 4, idempotencyKey: 'legacy-request' });
  delete legacy.pendingApprovals;
  domain.tables.tasks.set(legacy.id, legacy);
  domain.tables.idempotency.set(legacy.idempotencyKey, { taskId: legacy.id });
  const { store } = makeStore(domain);
  await store.load();
  const task = await store.create({ ...base, idempotencyKey: legacy.idempotencyKey });
  assert.deepEqual(task, legacy);
  assert.equal(domain.tables.journal.size, 0);
  assert.ok(domain.tables.idempotency.readKeys.every((key) => /^sha256-[a-f0-9]{64}$/.test(key)));
  assert.ok(domain.tables.idempotency.writeKeys.every((key) => /^sha256-[a-f0-9]{64}$/.test(key)));
  assert.equal(domain.tables.idempotency.size, 2);
  // A legacy task's first journal record may already be an update.
  const updated = await store.update(legacy.id, { status: 'running' });
  assert.equal(updated.revision, 5);
  const replayed = new TaskStore({ domain });
  await replayed.load();
  assert.deepEqual(replayed.get(legacy.id), updated);
});

test('legacy reserved sequence gaps remain readable and numeric replay determines the next append', async () => {
  const domain = new FakeDomain();
  const first = persistedTask();
  const running = { ...first, status: 'running', revision: 2 };
  // Deliberately enumerate in reverse order and leave a failed reservation gap.
  seedEvent(domain, 3, running, 'updated');
  seedEvent(domain, 1, first);
  const { store } = makeStore(domain);
  await store.load();
  assert.deepEqual(store.get(first.id), running);
  assert.equal(store.seq, 3);
  const completed = await store.update(first.id, { status: 'completed' });
  assert.equal(completed.revision, 3);
  assert.equal(domain.tables.journal.get('00000004').task.status, 'completed');
  const replayed = new TaskStore({ domain });
  await replayed.load();
  assert.deepEqual(replayed.get(first.id), completed);
});

test('unsafe idempotency keys only reach storage as fixed length hashes', async () => {
  const { store, domain } = makeStore();
  await store.load();
  const isHash = (key) => /^sha256-[a-f0-9]{64}$/.test(key);
  const index = domain.tables.idempotency;
  index.beforePut = (key) => { assert.ok(isHash(key), 'index writes must use a hash'); };
  const keys = [
    '../../escape', '..\\..\\escape', '/absolute/path', 'C:\\absolute\\path',
    'CON', '__proto__', 'control\u0000value', 'x'.repeat(4096), 'unicode-\u4efb\u52a1',
  ];
  const tasks = await Promise.all(keys.map((idempotencyKey) => store.create({ ...base, idempotencyKey })));
  assert.equal(new Set(tasks.map((task) => task.id)).size, keys.length);
  assert.equal(index.size, keys.length);
  assert.ok(index.readKeys.every(isHash));
  assert.ok(index.writeKeys.every(isHash));
  // Reconstruct an empty index using only original keys in journal task records.
  index.map.clear();
  domain.tables.tasks.map.clear();
  const replayed = new TaskStore({ domain });
  await replayed.load();
  for (let i = 0; i < keys.length; i += 1) {
    const recovered = await replayed.create({ ...base, idempotencyKey: keys[i] });
    assert.equal(recovered.id, tasks[i].id);
  }
  assert.equal(domain.tables.journal.size, keys.length);
  assert.equal(index.size, keys.length);
  assert.ok(index.readKeys.every(isHash));
  assert.ok(index.writeKeys.every(isHash));
});

test('a stale or unreadable index cannot return a task owned by another key', async () => {
  const { store, domain } = makeStore();
  await store.load();
  const first = await store.create({ ...base, idempotencyKey: 'first-request' });
  const storageKey = [...domain.tables.idempotency.map.keys()][0];
  const second = await store.create({ ...base, idempotencyKey: 'second-request' });
  domain.tables.idempotency.set(storageKey, { taskId: second.id });
  assert.equal((await store.create({ ...base, idempotencyKey: 'first-request' })).id, first.id);
  assert.equal(domain.tables.idempotency.get(storageKey).taskId, first.id);
  domain.tables.idempotency.get = () => { throw new Error('injected corrupt index'); };
  assert.equal((await store.create({ ...base, idempotencyKey: 'first-request' })).id, first.id);
  assert.equal(domain.tables.journal.size, 2);
});

test('malformed or conflicting journals fail closed before publishing any tasks', async (t) => {
  const cases = [
    ['non-object entry', (event) => null],
    ['missing sequence', (event) => { delete event.seq; return event; }],
    ['string sequence', (event) => ({ ...event, seq: '2' })],
    ['fractional sequence', (event) => ({ ...event, seq: 1.5 })],
    ['unsafe sequence', (event) => ({ ...event, seq: Number.MAX_SAFE_INTEGER + 1 })],
    ['nonfinite sequence', (event) => ({ ...event, seq: NaN })],
    ['zero sequence', (event) => ({ ...event, seq: 0 })],
    ['sequence key conflict', (event) => ({ ...event, seq: 1 })],
    ['unknown kind', (event) => ({ ...event, kind: 'deleted' })],
    ['invalid timestamp', (event) => ({ ...event, at: Infinity })],
    ['missing task', (event) => ({ ...event, task: null })],
    ['task identity conflict', (event) => ({ ...event, taskId: 'another-task' })],
    ['unknown status', (event) => ({ ...event, task: { ...event.task, status: 'unknown' } })],
    ['missing task field', (event) => {
      delete event.task.objective;
      return event;
    }],
    ['invalid nested task field', (event) => ({
      ...event, task: { ...event.task, pendingApprovals: [{ id: 'approval' }] },
    })],
    ['conflicting revision', (event) => ({ ...event, task: { ...event.task, revision: 1 } })],
    ['revision gap', (event) => ({ ...event, task: { ...event.task, revision: 3 } })],
    ['repeated creation', (event) => ({
      ...event, kind: 'created', task: { ...event.task, revision: 1 },
    })],
    ['changed original key', (event) => ({
      ...event, task: { ...event.task, idempotencyKey: 'changed-request' },
    })],
    ['changed creation time', (event) => ({
      ...event, task: { ...event.task, createdAt: 2000 },
    })],
    ['conflicting key ownership', (event) => ({
      ...event, taskId: 'another-task', kind: 'created',
      task: { ...event.task, id: 'another-task', revision: 1 },
    })],
  ];
  for (const [name, corrupt, storageKey = '00000002'] of cases) {
    await t.test(name, async () => {
      const domain = new FakeDomain();
      const first = persistedTask({ idempotencyKey: 'original-request' });
      seedEvent(domain, 1, first);
      const second = { seq: 2, taskId: first.id, at: 1000, kind: 'updated',
        task: { ...first, status: 'running', revision: 2 } };
      domain.tables.journal.set(storageKey, corrupt(second));
      // A valid runnable snapshot must not hide a broken journal.
      domain.tables.tasks.set(first.id, first);
      const { store } = makeStore(domain);
      await assert.rejects(store.load(), /invalid|conflict|gap/);
      assert.throws(() => store.list(), /invalid|conflict|gap/);
      assert.throws(() => store.get(first.id), /invalid|conflict|gap/);
      await assert.rejects(store.create(base), /invalid|conflict|gap/);
      await assert.rejects(store.update(first.id, { status: 'running' }), /invalid|conflict|gap/);
      await assert.rejects(store.findByIdempotency('original-request'), /invalid|conflict|gap/);
      assert.equal(domain.tables.journal.writeKeys.length, 0);
      assert.equal(domain.tables.tasks.writeKeys.length, 0);
    });
  }
});

test('unrepresented legacy snapshots fail closed on malformed identity or duplicate ownership', async (t) => {
  for (const corruption of ['identity', 'record', 'ownership']) {
    await t.test(corruption, async () => {
      const domain = new FakeDomain();
      const first = persistedTask({ idempotencyKey: 'original-request' });
      seedEvent(domain, 1, first);
      const snapshot = persistedTask({ id: 'snapshot-task', idempotencyKey: 'snapshot-request' });
      if (corruption === 'identity') snapshot.id = 'wrong-id';
      if (corruption === 'record') delete snapshot.status;
      if (corruption === 'ownership') snapshot.idempotencyKey = first.idempotencyKey;
      domain.tables.tasks.set('snapshot-task', snapshot);
      const { store } = makeStore(domain);
      await assert.rejects(store.load(), /invalid|conflict/);
      assert.throws(() => store.list(), /invalid|conflict/);
      assert.equal(domain.tables.tasks.writeKeys.length, 0);
    });
  }
});

test('journal write interruptions block further writes until validated reload', async (t) => {
  for (const phase of ['beforePut', 'afterPut']) {
    await t.test(phase, async () => {
      const { store, domain } = makeStore();
      await store.load();
      domain.tables.journal[phase] = () => { throw new Error('injected journal interruption'); };
      const results = await Promise.allSettled([
        store.create({ ...base, idempotencyKey: 'uncertain-request' }),
        store.create(base),
      ]);
      assert.ok(results.every((result) => result.status === 'rejected'));
      assert.equal(domain.tables.journal.writeKeys.length, 1);
      assert.throws(() => store.list(), /reload required/);
      domain.tables.journal[phase] = null;
      await store.load();
      const task = await store.create({ ...base, idempotencyKey: 'uncertain-request' });
      assert.equal(store.get(task.id).id, task.id);
      assert.equal(domain.tables.journal.size, 1);
      assert.equal(store.seq, 1);
      if (phase === 'afterPut') assert.equal(task.id, 'task-1');
    });
  }
});
