import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Store 的 CJS 和动态 ESM 路径都只用原生模块替身；不启动服务或真实模型。
register('./support/rn-module-hook.mjs', import.meta.url);
const originalResolve = Module._resolveFilename;
const shims = {
  '@react-native-async-storage/async-storage': '_async-storage-shim.cjs',
  '@react-native-cookies/cookies': '_cookie-manager-shim.cjs',
  'react-native-keychain': '_keychain-shim.cjs',
  'react-native': '_react-native-shim.cjs',
  'react-native-blob-util': '_blob-util-shim.cjs',
};
Module._resolveFilename = function (request, parent, ...rest) {
  if (shims[request]) return fileURLToPath(new URL(`./support/${shims[request]}`, import.meta.url));
  return originalResolve.call(this, request, parent, ...rest);
};

const { Store } = await import('../src/core/store.ts');
const { RpcError } = await import('../src/core/rpc-error.ts');
const { buildButlerPrime, buildButlerWake, modeSwitchMessage } = await import('../src/core/butler.ts');
const LIST = '/api/outpost/butler/tasks';
const SESSION = 'host-session';
const task = (status = 'running', sessionId = SESSION) => ({ id: 'task-1', status, sessionId });
const controls = [buildButlerPrime(), modeSwitchMessage('plan'), buildButlerWake(['coder 完成'])];
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function httpError(status, endpoint = LIST) {
  return new RpcError({ endpoint, kind: 'http', raw: `HTTP ${status}`,
    userTitle: 'test', userHint: 'test', retryable: false });
}

const timerContexts = new WeakSet();
function fixture(t, respond = () => ({ tasks: [task()] })) {
  if (!timerContexts.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    timerContexts.add(t);
  }
  const requests = [];
  const prompts = [];
  const conn = {
    baseUrl: 'http://127.0.0.1:1',
    request: async (path, init) => { requests.push(path); return respond(path, init); },
    call: async (method, args) => {
      assert.equal(method, 'session/prompt', `unexpected RPC: ${method}`);
      prompts.push(args.request);
      return { accepted: true };
    },
    close() {},
  };
  const store = new Store(conn, { pendingSendStore: {
    ensureHydrated: async () => {}, list: async () => [],
  } });
  // 真实 openChat 路径，follow 快照和队员投影由内存提供。
  store.api.follow = async () => {
    const closed = deferred();
    return {
      handle: { close: () => closed.resolve({ done: true }) },
      snapshot: { cursor: 0, records: [], hasMore: false },
      next: () => closed.promise,
    };
  };
  t.after(() => store.close());
  return { store, prompts, requests };
}

async function denyControls(store, sessionId = SESSION) {
  for (const text of controls) await assert.rejects(store.send(sessionId, text, []), /自动驱动/);
}

async function completeTeam(store, sessionId = SESSION) {
  let status = 'in_progress';
  store.api.list = async () => [{ sessionId, running: false, projections: { values: {
    agentTeam: { members: [], tasks: [{ id: 'team-task', status, subject: 'work', ownerName: 'coder' }] },
  } } }];
  await store.refreshChatMeta(sessionId);
  status = 'completed';
  await store.refreshChatMeta(sessionId);
  await settle();
}

test('cold open discovers Host ownership before persona/mode/wake; terminal task statuses stay protected', async (t) => {
  for (const status of ['created', 'preparing', 'running', 'waiting_user', 'blocked', 'completed', 'failed', 'cancelled']) {
    const { store, requests, prompts } = fixture(t, () => ({ tasks: [task(status)] }));
    await store.openChat(SESSION);
    await denyControls(store);
    assert.deepEqual(requests, [LIST], 'known positive ownership needs no additional probe');
    assert.equal(prompts.length, 0);
    assert.equal(store.getChat(SESSION).running, false);
    assert.equal(store.getChat(SESSION).error, undefined);
  }
});

test('fresh Store after phone restart rediscovers ownership without opening the task screen', async (t) => {
  const first = fixture(t);
  await first.store.listButlerTasks();
  const restarted = fixture(t);
  await denyControls(restarted.store);
  assert.deepEqual(restarted.requests, [LIST]);
  assert.equal(restarted.prompts.length, 0);
});

test('task list (including filtered), get, create, cancel and resume all remember session ownership', async (t) => {
  const operations = [
    (s) => s.listButlerTasks('completed'), (s) => s.getButlerTask('task-1'),
    (s) => s.createButlerTask({ objective: 'test', cwd: 'C:/fake' }),
    (s) => s.cancelButlerTask('task-1'), (s) => s.resumeButlerTask('task-1'),
  ];
  for (const operation of operations) {
    let offline = false;
    const { store, requests, prompts } = fixture(t, (path) => {
      if (offline) throw new Error('offline');
      return path.startsWith(`${LIST}?`) ? { tasks: [task('completed')] } : { task: task() };
    });
    await operation(store);
    offline = true;
    await denyControls(store);
    assert.equal(requests.length, 1);
    assert.equal(prompts.length, 0);
  }
});

test('team completion discovered through refreshChatMeta cannot wake a cold Host-managed session', async (t) => {
  const { store, prompts, requests } = fixture(t);
  await completeTeam(store);
  assert.deepEqual(requests, [LIST]);
  assert.equal(prompts.length, 0);
  assert.equal(store.teamNotices.length, 1, 'completion notice remains available');
});

test('ordinary unowned butler works on a capable Host; every control refreshes negative ownership', async (t) => {
  const { store, requests, prompts } = fixture(t, () => ({ tasks: [task(), task('created', null)] }));
  for (const text of controls) await store.send('legacy-session', text, []);
  await completeTeam(store, 'legacy-session');
  assert.equal(prompts.length, 4);
  assert.deepEqual(requests, [LIST, LIST, LIST, LIST]);
  assert.equal(prompts.at(-1).content[0].text, buildButlerWake(['coder 完成了「work」']));
});

test('older Host with missing task route still permits persona, mode and automatic completion wake', async (t) => {
  const { store, prompts, requests } = fixture(t, () => { throw httpError(404); });
  for (const text of controls) await store.send('legacy-session', text, []);
  await completeTeam(store, 'legacy-session');
  assert.equal(prompts.length, 4);
  assert.deepEqual(requests, [LIST, LIST, LIST, LIST]);
});

test('network/timeout/auth/server/malformed failures never authorize control messages', async (t) => {
  const failures = [new Error('timeout'), new TypeError('Network request failed'),
    ...[401, 403, 500, 503].map((n) => httpError(n)),
    httpError(404, '/different/path'),
    new RpcError({ endpoint: LIST, kind: 'malformed', raw: 'not JSON', userTitle: '', userHint: '', retryable: true })];
  for (const error of failures) {
    const { store, prompts } = fixture(t, () => { throw error; });
    await denyControls(store);
    await completeTeam(store);
    assert.equal(prompts.length, 0);
  }
  for (const result of [undefined, {}, { tasks: null }, { tasks: {} }, { tasks: [null] },
    { tasks: [{ id: 'task-1' }] }, { tasks: [{ id: '', sessionId: null }] }]) {
    const { store, prompts } = fixture(t, () => result);
    await denyControls(store);
    assert.equal(prompts.length, 0);
  }
});

test('failed verification can recover, but a previously capable Host returning 404 cannot downgrade to legacy', async (t) => {
  let response = () => { throw new Error('offline'); };
  const { store, prompts } = fixture(t, () => response());
  await assert.rejects(store.send(SESSION, controls[0]), /无法确认/);
  response = () => ({ tasks: [] });
  await store.send(SESSION, controls[0]);
  response = () => { throw httpError(404); };
  await denyControls(store);
  assert.equal(prompts.length, 1);
});

test('legacy unsupported result is not cached across reconnect/upgrade or later Host task assignment', async (t) => {
  let response = () => { throw httpError(404); };
  const { store, prompts } = fixture(t, () => response());
  await store.send(SESSION, controls[0]);
  response = () => ({ tasks: [] });
  await store.send(SESSION, controls[1]);
  response = () => ({ tasks: [task()] });
  await denyControls(store);
  response = () => ({ tasks: [] });
  await denyControls(store);
  assert.equal(prompts.length, 2, 'remembered ownership survives empty/filtered later lists');
});

test('slow ownership discovery blocks concurrent kickoff and completion wake until verified', async (t) => {
  const mapping = deferred();
  const { store, prompts, requests } = fixture(t, () => mapping.promise);
  const kickoff = assert.rejects(store.send(SESSION, controls[0]), /Host 管理/);
  await completeTeam(store);
  assert.equal(requests.length, 2);
  assert.equal(prompts.length, 0);
  mapping.resolve({ tasks: [task()] });
  await kickoff;
  await settle();
  assert.equal(prompts.length, 0);
});

test('concurrent task responses override an older in-flight empty mapping or missing endpoint', async (t) => {
  for (const discover of [
    (s) => s.getButlerTask('task-1'),
    (s) => s.createButlerTask({ objective: 'test', cwd: 'C:/fake' }),
    (s) => s.listButlerTasks('completed'),
  ]) {
    for (const missing of [false, true]) {
      const mapping = deferred();
      const { store, prompts } = fixture(t, (path) => path === LIST
        ? mapping.promise.then(() => { if (missing) throw httpError(404); return { tasks: [] }; })
        : path.startsWith(`${LIST}?`) ? { tasks: [task()] } : { task: task() });
      const kickoff = assert.rejects(store.send(SESSION, controls[0]), /Host 管理/);
      await discover(store);
      mapping.resolve();
      await kickoff;
      assert.equal(prompts.length, 0);
    }
  }
});

test('explicit user messages still send to managed sessions or when ownership service is down', async (t) => {
  let offline = false;
  const { store, prompts, requests } = fixture(t, () => {
    if (offline) throw new Error('offline');
    return { tasks: [task()] };
  });
  await store.listButlerTasks();
  offline = true;
  await store.send(SESSION, '用户明确要求继续', [], 'queue', 'user-request-1');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].requestId, 'user-request-1');
  assert.deepEqual(requests, [LIST], 'ordinary input does not depend on ownership discovery');
});
