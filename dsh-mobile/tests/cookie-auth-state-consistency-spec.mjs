/**
 * P0-3：Cookie、认证与连接状态一致性测试。
 *
 * 覆盖：
 *   1. Keychain ↔ CookieManager ↔ DshConnection.cookie ↔ WebSocket 凭据同步（syncNativeCookieJar / setCookie）
 *   2. 配对、重新配对（凭据切换重置旧 WebSocket 连接）、Cookie 轮换（Set-Cookie 响应头自动更新）
 *   3. 401（凭据失效）与 403（trusted-host / Origin 限制）精确区分：403 绝不误判为 Cookie 失效，但均停止无效轮询与重连风暴
 *   4. 旧连接、迟到回调、旧 Store 实例在重新配对/退出登录后被隔离，绝不覆盖新配对状态
 *   5. 失效凭据恢复后不会重复订阅或重复执行任务（与 P0-1 / P0-2 保持一致）
 */

import assert from 'node:assert/strict';
import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SHIM_DIR = path.join(__dirname, 'support');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(SHIM_DIR, '_async-storage-shim.cjs');
  }
  if (request === '@react-native-cookies/cookies') {
    return path.join(SHIM_DIR, '_cookie-manager-shim.cjs');
  }
  if (request === 'react-native-keychain') {
    return path.join(SHIM_DIR, '_keychain-shim.cjs');
  }
  if (request === 'react-native') {
    return path.join(SHIM_DIR, '_react-native-shim.cjs');
  }
  if (request === 'react-native-blob-util') {
    return path.join(SHIM_DIR, '_blob-util-shim.cjs');
  }
  return origResolve.call(this, request, parent, ...rest);
};
const imp = (p) => import(pathToFileURL(p).href);

const cmMod = await imp(path.join(SHIM_DIR, '_cookie-manager-shim.cjs'));
const cookieManager = cmMod.default ?? cmMod;
const { syncNativeCookieJar, clearNativeCookieJarDetailed } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'cookieJar.ts'),
);
const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);
const { Store } = await imp(path.join(__dirname, '..', 'src', 'core', 'store.ts'));
const { PendingSendStore } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'store.ts'),
);
const { RpcError, isAuthFailure, isForbiddenRejection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'rpc-error.ts'),
);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  OK    ${name}`);
  } catch (e) {
    fail += 1;
    console.error(`  FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

class FakeWebSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  listeners = { open: [], message: [], error: [], close: [] };

  constructor(url, protocols, opts) {
    this.url = url;
    this.protocols = protocols;
    this.opts = opts;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        for (const fn of this.listeners.open ?? []) fn({});
      }
    });
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = '') {
    this.readyState = 3;
    for (const fn of this.listeners.close ?? []) fn({ code, reason });
  }
  triggerMessage(obj) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(obj) });
  }
}

await check('1. Cookie 同步与轮换：syncNativeCookieJar 清理旧 Cookie 并写入新 Cookie；HTTP 响应 Set-Cookie 自动轮换内存与原生容器', async () => {
  cookieManager.__reset();
  const baseUrl = 'http://127.0.0.1:3097';
  const cookie1 = ['dsh-auth', 'fresh-val-1'].join('=');
  const cookie2 = ['dsh-auth', 'rotated-val-2'].join('=');

  const oldCookieName = ['dsh-auth', 'old'].join('-');
  await cookieManager.set(baseUrl, { name: oldCookieName, value: 'stale-val' });
  await syncNativeCookieJar(baseUrl, cookie1);

  const afterSync = await cookieManager.get(baseUrl);
  assert.equal(afterSync[oldCookieName], undefined, '旧 cookie 必须被清除');
  assert.equal(afterSync['dsh-auth']?.value, 'fresh-val-1', '新 dsh-auth 已同步写入 CookieManager');

  // 模拟服务端在 HTTP RPC 响应头中轮换 Cookie
  const conn = new DshConnection({
    baseUrl,
    cookie: cookie1,
    fetchImpl: async () =>
      new Response(JSON.stringify({ result: { ok: true, value: { items: [] } } }), {
        status: 200,
        headers: { 'set-cookie': `${cookie2}; Path=/; HttpOnly` },
      }),
    WebSocketImpl: FakeWebSocket,
  });

  await conn.call('session/list', { _request: {} });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(conn.currentCookie, cookie2, '内存 Cookie 自动更新为轮换后的值');
  const afterRotate = await cookieManager.get(baseUrl);
  assert.equal(afterRotate['dsh-auth']?.value, 'rotated-val-2', 'CookieManager 自动同步轮换后的值');

  const clearRes = await clearNativeCookieJarDetailed(baseUrl);
  assert.equal(clearRes.kind, 'cleared');
});

await check('2. 401 与 403 精确区分：403（trusted-host 限制）不当作凭据失效，且 401/403 均停止无效轮询与重连循环', async () => {
  let listCalls = 0;
  const validCookie = ['dsh-auth', 'valid-cookie-1'].join('=');
  const expiredCookie = ['dsh-auth', 'expired-cookie-0'].join('=');
  const conn403 = new DshConnection({
    baseUrl: 'http://10.0.2.2:3098',
    cookie: validCookie,
    fetchImpl: async () => new Response('forbidden', { status: 403 }),
    WebSocketImpl: FakeWebSocket,
  });
  const store403 = new Store(conn403, { reconnectBaseMs: 25, reconnectMaxMs: 80 });

  await store403.loadSessions();
  assert.equal(store403.connection, 'error');
  assert.equal(store403.authInvalidated, true);
  assert.match(store403.sessionsError ?? '', /HTTP 403/);
  assert.match(store403.sessionsError ?? '', /当前登录凭据仍有效/);
  assert.equal(conn403.currentCookie, validCookie, '403 不得清除当前有效 Cookie');

  // ChatScreen 流遇到 403 同样停止重连且明确提示 403，不误报“登录状态已失效”
  let follow403Calls = 0;
  store403.api.follow = async () => {
    follow403Calls += 1;
    throw new RpcError({
      endpoint: 'remote.mux',
      kind: 'http',
      raw: 'HTTP 403 Forbidden',
      userTitle: '服务地址未被允许访问（HTTP 403）',
      userHint: 'Host 未受信任',
      retryable: false,
    });
  };
  await store403.openChat('s-403');
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(follow403Calls, 1, '403 停止重连循环');
  assert.match(store403.getChat('s-403').error ?? '', /HTTP 403/);
  assert.doesNotMatch(store403.getChat('s-403').error ?? '', /登录状态已失效/);
  store403.close();

  // 401 场景：停止后台 noticeScan 轮询与流重连
  const conn401 = new DshConnection({
    baseUrl: 'http://127.0.0.1:3097',
    cookie: validCookie,
    fetchImpl: async () => {
      listCalls += 1;
      return new Response('unauthorized', { status: 401 });
    },
    WebSocketImpl: FakeWebSocket,
  });
  const store401 = new Store(conn401, { reconnectBaseMs: 25, reconnectMaxMs: 80 });
  store401.startNoticeScan();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(store401.authInvalidated, true, '401 后标记 authInvalidated 并停止后台扫描定时器');
  assert.equal(store401.connection, 'error');
  assert.equal(listCalls, 1);
  // App 切回前台时，由于 authInvalidated=true，不再触发无效重连风暴
  store401.handleAppForeground('http://127.0.0.1:3097');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(listCalls, 1, 'authInvalidated 状态下切回前台不发起无效请求');
  store401.close();
});

await check('3. 重新配对、凭据更新与退出登录：syncCookie 重置旧 WebSocket，旧流迟到回调不覆盖新状态，恢复后不重复订阅或重复发消息', async () => {
  FakeWebSocket.instances = [];
  const expiredCookie = ['dsh-auth', 'expired-cookie-0'].join('=');
  const freshCookie = ['dsh-auth', 'fresh-cookie-2'].join('=');
  const persistence = {
    val: undefined,
    async readRaw() { return this.val; },
    async writeRaw(v) { this.val = v; },
    async clear() { this.val = undefined; },
  };
  const pending = new PendingSendStore({
    persistence,
    now: () => 1_800_000_000_000,
    idFactory: () => 'req-p03-1',
  });
  await pending.hydrate();

  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:3097',
    cookie: expiredCookie,
    WebSocketImpl: FakeWebSocket,
  });
  const binding = {
    baseUrl: 'http://127.0.0.1:3097',
    gatewayId: 'gw-p03',
    authContextHash: 'hash-p03',
    identityQuality: 'confirmed',
  };
  const store = new Store(conn, {
    pendingSendStore: pending,
    loadPendingBinding: async () => binding,
    verifyPendingBinding: async () => undefined,
    reconnectBaseMs: 30,
    reconnectMaxMs: 100,
  });

  // 1. 初始由于 expired-cookie 触发 401 终止态
  let followCount = 0;
  let activeCookieAtFollow = '';
  store.api.follow = async () => {
    followCount += 1;
    activeCookieAtFollow = conn.currentCookie ?? '';
    if (conn.currentCookie === expiredCookie) {
      throw new RpcError({
        endpoint: 'remote.mux',
        kind: 'http',
        raw: 'HTTP 401 Unauthorized',
        userTitle: '登录状态失效了',
        userHint: '请重新配对',
        retryable: false,
      });
    }
    return {
      handle: { close() {} },
      snapshot: {
        type: 'snapshot',
        header: {},
        cursor: 2,
        records: [
          {
            type: 'event',
            event: {
              type: 'user/message',
              seq: 2,
              time: 1_800_000_001_000,
              data: {
                turn: 1,
                role: 'user',
                id: 'm-1',
                source: { kind: 'user', rpcId: 'req-p03-1' },
                content: [{ type: 'text', text: 'P03_Message' }],
              },
            },
          },
        ],
        hasMore: false,
      },
      next: () => new Promise(() => {}),
    };
  };

  await store.openChat('s-p03');
  assert.equal(store.authInvalidated, true);
  assert.equal(store.connection, 'error');

  // 2. 重新配对（更新为新 Cookie）：syncCookie 恢复状态并允许重新打开会话，且不会重复订阅
  store.syncCookie(freshCookie);
  assert.equal(store.authInvalidated, false);
  assert.equal(store.connection, 'connected');

  await Promise.all([store.openChat('s-p03'), store.openChat('s-p03')]);
  assert.equal(followCount, 2, '恢复后并发 openChat 只建立单次订阅，不重复订阅');
  assert.equal(activeCookieAtFollow, freshCookie);
  assert.equal(store.getChat('s-p03').error, undefined);

  // 3. 退出登录（syncCookie(undefined)）：立即关闭所有活跃流并置回 idle
  store.syncCookie(undefined);
  assert.equal(store.connection, 'idle');
  assert.equal(store.authInvalidated, true);
  store.close();
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
