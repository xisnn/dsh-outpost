import assert from 'node:assert/strict';
import { DshConnection } from '../src/core/transport/index.ts';

// call() 的 fetch 失败分支会读 RN 全局 __DEV__（transport/index.ts:406）。
// 纯 tsx 环境里没有它，不补就会抛 ReferenceError 而不是预期的超时错误。
// 与 tests/p0-verify-behavior-spec.mjs 的做法一致。
globalThis.__DEV__ = false;

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

// ── call() 的响应体生命周期（BUG-02）──────────────────────────────
//
// request() 把定时器保持到响应体读完（finally @ :537），而 call() 此前
// 在**收到响应头**时就 clearTimeout（:398/:400），于是 :440 的
// `await res.json()` 完全没有超时保护：服务端回了 200 头再卡住响应体，
// Promise 就永久挂起 —— 不报错、不返回，上层 pending 状态永远结束不了。
//
// 下面这组用例守的是「响应体阶段也必须有超时」，以及「超时要说超时，
// 不能说成 malformed」——后者是因为 :441 的 catch 会吞掉 AbortError。

/** call() 读的是 json()，不是 request() 的 text() */
function rpcResponse(value, status = 200, headers = { get: () => null }) {
  return { ok: status >= 200 && status < 300, status, headers, json: async () => value };
}

/** 响应体在 abort 之前永不 settle：复现「200 头已回、body 卡死」 */
function hangingBody(init) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener(
      'abort',
      () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      { once: true },
    );
  });
}

function hangingConn(extra = {}) {
  return new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: ['dsh-auth', 'test'].join('='),
    WebSocketImpl: class {},
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => hangingBody(init),
    }),
    ...extra,
  });
}

/**
 * 记录定时器的创建与清理。
 *
 * 旧的 timeout-throttle-spec 用「clearTimeout 出现次数 >= 2」来近似
 * 「每条退出路径都清了定时器」——那是把实现细节当契约，正确的单一
 * finally 修复反而会让它失败。这里直接观测真实行为：调用结束后是否
 * 还有本次创建的定时器没被清掉。
 */
function trackTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSet(fn, ms, ...rest);
    live.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    live.delete(id);
    return realClear(id);
  };
  return {
    leaked: () => live.size,
    restore() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

// B2 —— 挂起的显式复现。
//
// 修复前：定时器在响应头处就被清掉，abort 永不触发，json() 永久挂起。
// 用「有限时间内是否 settle」来断言，而不是让测试自己挂死拖垮整条 CI 链。
{
  const conn = hangingConn();
  let settled = false;
  const p = conn.call('session/list', { __timeoutMs: 30 }).then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(settled, true, 'call() 响应体卡住时必须在超时处结束，不能永久挂起');
  await p;
}

// B1 —— 响应体阶段超时必须抛「请求超时」
{
  const conn = hangingConn();
  await assert.rejects(conn.call('session/list', { __timeoutMs: 30 }), /请求超时/);
}

// B3 —— 超时不得被误报成 malformed。
//
// :441 的 catch 吞掉所有异常 → parsed=undefined → :447 抛「malformed
// response」。只把 clearTimeout 移进 finally 而不判别 abort，就会把
// 「超时」说成「上游改了返回格式」，两者的可操作建议完全不同。
{
  const conn = hangingConn();
  await assert.rejects(conn.call('session/list', { __timeoutMs: 30 }), (e) => {
    assert.match(e.message, /请求超时/);
    assert.doesNotMatch(e.message, /malformed/);
    return true;
  });
}

// B4 —— 正常快速响应：返回值与语义零变化
{
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: ['dsh-auth', 'test'].join('='),
    WebSocketImpl: class {},
    fetchImpl: async () => rpcResponse({ result: { ok: true, value: { sessions: [1, 2] } } }),
  });
  const out = await conn.call('session/list', {});
  assert.deepEqual(out, { sessions: [1, 2] });
}

// B5 —— HTTP 非 2xx：仍抛 HTTP 状态，且定时器被清理
{
  const t = trackTimers();
  try {
    const conn = new DshConnection({
      baseUrl: 'http://127.0.0.1:9',
      cookie: ['dsh-auth', 'test'].join('='),
      WebSocketImpl: class {},
      fetchImpl: async () => rpcResponse({}, 403),
    });
    await assert.rejects(conn.call('session/list', {}), /HTTP 403/);
    assert.equal(t.leaked(), 0, 'HTTP 错误路径必须清掉定时器');
  } finally {
    t.restore();
  }
}

// B6 —— json() 抛非 abort 异常：仍走 malformed（既有语义不变）
{
  const t = trackTimers();
  try {
    const conn = new DshConnection({
      baseUrl: 'http://127.0.0.1:9',
      cookie: ['dsh-auth', 'test'].join('='),
      WebSocketImpl: class {},
      fetchImpl: async () => ({
        ok: true, status: 200, headers: { get: () => null },
        json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      }),
    });
    await assert.rejects(conn.call('session/list', {}), /malformed response/);
    assert.equal(t.leaked(), 0, '解析失败路径必须清掉定时器');
  } finally {
    t.restore();
  }
}

// B7 —— result.ok === false：仍抛 rpc 错误（既有语义不变）
{
  const t = trackTimers();
  try {
    const conn = new DshConnection({
      baseUrl: 'http://127.0.0.1:9',
      cookie: ['dsh-auth', 'test'].join('='),
      WebSocketImpl: class {},
      fetchImpl: async () => rpcResponse({ result: { ok: false, error: { code: 'E_BUSY', message: 'busy' } } }),
    });
    await assert.rejects(conn.call('session/list', {}), /E_BUSY busy/);
    assert.equal(t.leaked(), 0, 'rpc 错误路径必须清掉定时器');
  } finally {
    t.restore();
  }
}

// B8 —— Set-Cookie 轮换路径：行为不变，且定时器被清理
{
  const t = trackTimers();
  try {
    const rotated = 'dsh-auth=rotated-value';
    const conn = new DshConnection({
      baseUrl: 'http://127.0.0.1:9',
      cookie: 'dsh-auth=old',
      WebSocketImpl: class {},
      fetchImpl: async () => rpcResponse(
        { result: { ok: true, value: 1 } },
        200,
        { get: (k) => (String(k).toLowerCase() === 'set-cookie' ? `${rotated}; Path=/` : null) },
      ),
    });
    assert.equal(await conn.call('session/list', {}), 1);
    assert.equal(conn.cookie, rotated, 'Set-Cookie 轮换必须仍然生效');
    assert.equal(t.leaked(), 0, '成功路径必须清掉定时器');
  } finally {
    t.restore();
  }
}

// B9 —— fetch 阶段就超时：既有行为不变（回归护栏）
{
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:9',
    cookie: ['dsh-auth', 'test'].join('='),
    WebSocketImpl: class {},
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    }),
  });
  await assert.rejects(conn.call('session/list', { __timeoutMs: 30 }), /请求超时/);
}

console.log('transport-request-spec: PASS');
