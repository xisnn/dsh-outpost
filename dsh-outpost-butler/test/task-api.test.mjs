import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTaskApi } from '../lib/task-api.js';
import { TaskError } from '../lib/task-manager.js';

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
