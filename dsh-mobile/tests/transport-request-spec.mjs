import assert from 'node:assert/strict';
import { DshConnection } from '../src/core/transport/index.ts';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

{
  const calls = [];
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: 'dsh-auth=abc',
    WebSocketImpl: class {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ ok: true });
    },
  });

  const out = await conn.request('/api/outpost/butler/health');
  assert.deepEqual(out, { ok: true });
  assert.equal(calls[0].url, 'http://127.0.0.1:9/api/outpost/butler/health');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.match(calls[0].init.headers.Cookie, /dsh-auth=abc/);
}

{
  const calls = [];
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: 'dsh-auth=abc',
    WebSocketImpl: class {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ task: { id: 't1' } }, 201);
    },
  });

  const out = await conn.request('/api/outpost/butler/tasks/create', {
    method: 'POST',
    body: { objective: 'o', cwd: 'C:/work' },
    headers: { 'Idempotency-Key': 'k1' },
  });
  assert.equal(out.task.id, 't1');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, JSON.stringify({ objective: 'o', cwd: 'C:/work' }));
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'k1');
}

{
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: 'dsh-auth=abc',
    WebSocketImpl: class {},
    fetchImpl: async () => response({}, 403),
  });
  await assert.rejects(() => conn.request('/api/x'), /HTTP 403/);
}

{
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: 'dsh-auth=abc',
    WebSocketImpl: class {},
    fetchImpl: async () => response({}),
  });
  await assert.rejects(() => conn.request('/not-api'), /must start with \/api\//);
}

{
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: ['dsh-auth', 'test'].join('='),
    WebSocketImpl: class {},
    fetchImpl: async (_url, init) => ({
      ok: true, status: 200, headers: { get: () => null },
      text: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }),
    }),
  });
  await assert.rejects(conn.request('/api/outpost/butler/health', { timeoutMs: 20 }), /请求超时/);
}

{
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: ['dsh-auth', 'test'].join('='),
    WebSocketImpl: class {},
    fetchImpl: async () => response({ message: 'the previous turn is still stopping' }, 409),
  });
  await assert.rejects(conn.request('/api/outpost/butler/tasks/resume'), /HTTP 409: the previous turn is still stopping/);
}

console.log('transport-request-spec: PASS');
