import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTaskApi } from '../lib/task-api.js';
import { TaskError } from '../lib/task-manager.js';
import { MemoryStore } from '../lib/memory-store.js';

class FakeConnection {
  constructor() {
    this.routes = new Map();
    this.fetch = {
      register: (route) => {
        this.routes.set(route.path, route);
        return async () => {};
      },
    };
  }
}

function makeManager() {
  const calls = [];
  return {
    calls,
    activeTaskId: null,
    queue: [],
    list: () => [{ id: 'task-1', status: 'running' }],
    get: (id) => {
      if (id !== 'task-1') throw new TaskError('not-found', `task not found: ${id}`, 404);
      return { id: 'task-1', status: 'running' };
    },
    publicTask: (task) => task,
    create: async (input) => {
      calls.push(['create', input]);
      return { id: 'task-1', status: 'created', objective: input.objective, cwd: input.cwd };
    },
    cancel: async (id) => {
      calls.push(['cancel', id]);
      return { id, status: 'cancelled' };
    },
    resume: async (id) => {
      calls.push(['resume', id]);
      return { id, status: 'running' };
    },
  };
}

test('capabilities report unsupported writes on legacy Host', async () => {
  const { connection } = await setup();
  const response = await route(connection, '/api/outpost/butler/capabilities').fetch(new Request('http://localhost/api/outpost/butler/capabilities'));
  assert.deepEqual(await body(response), { version: 1, enabled: false, durableReceipts: false });
  const denied = await route(connection, '/api/outpost/butler/commands').fetch(new Request('http://localhost/api/outpost/butler/commands', { method: 'POST', body: '{}' }));
  assert.equal(denied.status, 409);
  assert.equal((await body(denied)).code, 'unsupported-capability');
});

test('local mutations require commands and receipt lookup preserves unknown state', async () => {
  const connection = new FakeConnection(), manager = makeManager();
  const receipt = { commandId: 'unknown-command', state: 'unknown' };
  let observed;
  registerTaskApi({ connection, manager, logger: { warn() {} }, commands: {
    submit: async envelope => { observed = envelope; return receipt; },
    receipt: id => id === receipt.commandId ? receipt : null,
    reconcile: () => ({ generation: 'g', unresolved: [receipt] }),
    capabilities: () => ({ version: 1, enabled: true }),
  } });
  for (const op of ['create', 'cancel', 'resume']) {
    const denied = await route(connection, '/api/outpost/butler/tasks/' + op).fetch(new Request('http://localhost/api/outpost/butler/tasks/' + op, { method: 'POST', body: '{}' }));
    assert.equal(denied.status, 409); assert.equal((await body(denied)).code, 'command-required');
  }
  assert.deepEqual(manager.calls, []);
  const envelope = { version: 1, commandId: 'unknown-command' };
  const submitted = await route(connection, '/api/outpost/butler/commands').fetch(new Request('http://localhost/api/outpost/butler/commands', { method: 'POST', body: JSON.stringify(envelope) }));
  assert.deepEqual(observed, envelope); assert.deepEqual(await body(submitted), { receipt });
  for (const id of ['unknown-command', 'absent']) {
    const response = await route(connection, '/api/outpost/butler/commands/get').fetch(new Request('http://localhost/api/outpost/butler/commands/get?commandId=' + id));
    assert.equal(response.status, id === 'absent' ? 404 : 200);
    if (response.status === 200) assert.equal((await body(response)).receipt.state, 'unknown');
  }
});

function memoryDomain() {
  const tables = new Map();
  return { table(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    const table = tables.get(name);
    return {
      get: key => table.get(key),
      put: async (key, value) => { table.set(key, structuredClone(value)); },
      delete: async key => { table.delete(key); },
      entries: () => [...table.entries()].map(([key, value]) => [key, structuredClone(value)]),
    };
  } };
}

test('memory routes expose identity and user edits; unavailable memory fails closed', async () => {
  const connection = new FakeConnection(), manager = makeManager();
  const store = new MemoryStore({ domain: memoryDomain() });
  await store.load();
  registerTaskApi({ connection, manager, memory: store, logger: { warn() {} } });
  const base = 'http://localhost/api/outpost/butler/memory';
  const snapshotResponse = await route(connection, '/api/outpost/butler/memory').fetch(new Request(base));
  const snapshot = await body(snapshotResponse);
  assert.match(snapshot.butlerId, /^[0-9a-f-]{36}$/);
  const setResponse = await route(connection, '/api/outpost/butler/memory/set').fetch(new Request(base + '/set', { method: 'POST', body: JSON.stringify({ kind: 'project', key: '仓库', value: 'dsBot' }) }));
  const setBody = await body(setResponse);
  assert.equal(setBody.entry.key, '仓库');
  assert.equal(setBody.entry.source, 'user');
  assert.equal(typeof setBody.revision, 'number');
  const historyResponse = await route(connection, '/api/outpost/butler/memory/history').fetch(new Request(base + '/history'));
  assert.equal((await body(historyResponse)).changes[0].action, 'set');
  const deleteResponse = await route(connection, '/api/outpost/butler/memory/delete').fetch(new Request(base + '/delete', { method: 'POST', body: JSON.stringify({ id: setBody.entry.id, expectedRevision: 1 }) }));
  assert.equal((await body(deleteResponse)).deleted, setBody.entry.id);

  const unavailableConnection = new FakeConnection();
  registerTaskApi({ connection: unavailableConnection, manager, memory: null, logger: { warn() {} } });
  const unavailable = await route(unavailableConnection, '/api/outpost/butler/memory').fetch(new Request(base));
  assert.equal(unavailable.status, 503);
  assert.equal((await body(unavailable)).code, 'memory-unavailable');
});

async function setup() {
  const connection = new FakeConnection();
  const manager = makeManager();
  const dispose = registerTaskApi({ connection, manager, logger: { warn() {} } });
  return { connection, manager, dispose };
}

function route(connection, path) {
  const found = connection.routes.get(path);
  assert.ok(found, `route ${path} is registered`);
  return found;
}

async function body(response) {
  return JSON.parse(await response.text());
}

test('health reports the lane and queue', async () => {
  const { connection } = await setup();
  const response = await route(connection, '/api/outpost/butler/health').fetch(
    new Request('http://localhost/api/outpost/butler/health'),
  );
  assert.equal(response.status, 200);
  const json = await body(response);
  assert.equal(json.ok, true);
  assert.equal(json.service, 'dsh-outpost-butler');
});

test('list returns tasks and supports a status filter', async () => {
  const { connection } = await setup();
  const response = await route(connection, '/api/outpost/butler/tasks').fetch(
    new Request('http://localhost/api/outpost/butler/tasks'),
  );
  assert.equal(response.status, 200);
  assert.equal((await body(response)).tasks.length, 1);

  const filtered = await route(connection, '/api/outpost/butler/tasks').fetch(
    new Request('http://localhost/api/outpost/butler/tasks?status=waiting_user'),
  );
  assert.equal((await body(filtered)).tasks.length, 0);
});

test('get requires an id and maps a missing task to 404', async () => {
  const { connection } = await setup();
  const listRoute = route(connection, '/api/outpost/butler/tasks/get');

  const missing = await listRoute.fetch(new Request('http://localhost/api/outpost/butler/tasks/get'));
  assert.equal(missing.status, 400);
  assert.equal((await body(missing)).error, 'missing-id');

  const notFound = await listRoute.fetch(
    new Request('http://localhost/api/outpost/butler/tasks/get?id=task-x'),
  );
  assert.equal(notFound.status, 404);
  assert.equal((await body(notFound)).error, 'not-found');

  const found = await listRoute.fetch(
    new Request('http://localhost/api/outpost/butler/tasks/get?id=task-1'),
  );
  assert.equal(found.status, 200);
  assert.equal((await body(found)).task.id, 'task-1');
});

test('create forwards the idempotency header', async () => {
  const { connection, manager } = await setup();
  const response = await route(connection, '/api/outpost/butler/tasks/create').fetch(
    new Request('http://localhost/api/outpost/butler/tasks/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: JSON.stringify({ objective: 'o', cwd: 'C:/work' }),
    }),
  );
  assert.equal(response.status, 201);
  assert.equal((await body(response)).task.id, 'task-1');
  assert.deepEqual(manager.calls[0], [
    'create',
    {
      objective: 'o',
      cwd: 'C:/work',
      title: undefined,
      maxGoalRounds: undefined,
      autoResume: undefined,
      idempotencyKey: 'key-1',
    },
  ]);
});

test('invalid JSON and missing ids are rejected', async () => {
  const { connection } = await setup();
  const createRoute = route(connection, '/api/outpost/butler/tasks/create');
  const badJson = await createRoute.fetch(
    new Request('http://localhost/api/outpost/butler/tasks/create', {
      method: 'POST',
      body: '{not json',
    }),
  );
  assert.equal(badJson.status, 400);
  assert.equal((await body(badJson)).error, 'invalid-json');

  const cancelRoute = route(connection, '/api/outpost/butler/tasks/cancel');
  const missingId = await cancelRoute.fetch(
    new Request('http://localhost/api/outpost/butler/tasks/cancel', {
      method: 'POST',
      body: '{}',
    }),
  );
  assert.equal(missingId.status, 400);
  assert.equal((await body(missingId)).error, 'missing-id');
});

test('body limit counts UTF-8 bytes and internal failures do not expose paths', async () => {
  const { connection, manager } = await setup();
  const createRoute = route(connection, '/api/outpost/butler/tasks/create');
  const oversized = await createRoute.fetch(new Request('http://localhost/api/outpost/butler/tasks/create', {
    method: 'POST', body: JSON.stringify({ objective: '中'.repeat(25000) }),
  }));
  assert.equal(oversized.status, 413);
  manager.create = async () => { throw new Error('private-profile-path: secret data'); };
  const failed = await createRoute.fetch(new Request('http://localhost/api/outpost/butler/tasks/create', { method: 'POST', body: '{}' }));
  assert.equal(failed.status, 500);
  assert.doesNotMatch(JSON.stringify(await body(failed)), /private-profile|secret data/);
});

test('cancel and resume call the manager', async () => {
  const { connection, manager } = await setup();
  const cancel = await route(connection, '/api/outpost/butler/tasks/cancel').fetch(
    new Request('http://localhost/api/outpost/butler/tasks/cancel', {
      method: 'POST',
      body: JSON.stringify({ id: 'task-1' }),
    }),
  );
  assert.equal(cancel.status, 200);
  assert.equal((await body(cancel)).task.status, 'cancelled');

  const resume = await route(connection, '/api/outpost/butler/tasks/resume').fetch(
    new Request('http://localhost/api/outpost/butler/tasks/resume', {
      method: 'POST',
      body: JSON.stringify({ id: 'task-1' }),
    }),
  );
  assert.equal(resume.status, 200);
  assert.deepEqual(manager.calls, [
    ['cancel', 'task-1'],
    ['resume', 'task-1'],
  ]);
});
