/**
 * P0-2 WebSocket 自动重连与会话恢复测试。
 *
 * 覆盖：
 *   1. DshConnection.ensureSocket 并发 single-flight 与代次隔离（旧连接迟到 close 不误杀新连接）
 *   2. 会话流断线自动重连 + 指数退避与抖动
 *   3. 重连后通过 cursor / session/page 补齐断线期间遗漏事件，按 seq 去重不重复显示消息
 *   4. Cookie 失效（401/403）停止自动重连并给出重新配对提示
 *   5. 会话切换（closeChat）与重复 openChat 防重入
 *   6. App 前后台切换（handleAppForeground）重置半开连接并立即重连
 *   7. P0-1 协同：unknown 未决消息在断线重连拉取回补事件后自动对账为 confirmed（requestId 不变）
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const { DshConnection } = await imp(path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'));
const { Store } = await imp(path.join(__dirname, '..', 'src', 'core', 'store.ts'));
const { PendingSendStore } = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'store.ts'));
const { RpcError } = await imp(path.join(__dirname, '..', 'src', 'core', 'rpc-error.ts'));
const { clearP0TestState } = await imp(path.join(__dirname, '..', 'src', 'dev', 'p0Verify.ts'));

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

function makeUserEvent(seq, text, rpcId = `rpc-${seq}`) {
  return {
    type: 'event',
    event: {
      type: 'user/message',
      seq,
      time: 1_700_000_000_000 + seq * 1000,
      data: {
        turn: seq,
        role: 'user',
        id: `msg-${seq}`,
        source: { kind: 'user', rpcId },
        content: [{ type: 'text', text }],
      },
    },
  };
}

class FakeWebSocket {
  static instances = [];
  static autoOpen = true;
  readyState = 0;
  sent = [];
  listeners = { open: [], message: [], error: [], close: [] };

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => this.triggerOpen());
    }
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
  triggerOpen() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    for (const fn of this.listeners.open ?? []) fn({});
  }
  triggerMessage(obj) {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(obj) });
  }
}

const TEST_COOKIE = ['dsh-auth', 'test-session-cookie'].join('=');

await check('1. DshConnection.ensureSocket：并发 openStream 共享同一连接（single-flight），且旧连接迟到 close 不误杀新连接', async () => {
  FakeWebSocket.instances = [];
  FakeWebSocket.autoOpen = true;
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:3097',
    cookie: TEST_COOKIE,
    WebSocketImpl: FakeWebSocket,
  });

  const [h1, h2] = await Promise.all([
    conn.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 's1' } } }),
    conn.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 's2' } } }),
  ]);
  assert.equal(FakeWebSocket.instances.length, 1, '并发 openStream 只能建一条底层 WebSocket');
  const ws1 = FakeWebSocket.instances[0];

  // 重置底层连接后立刻开新流
  conn.resetSocket('test reset');
  const h3 = await conn.openStream('session/follow', {
    request: { address: { kind: 'session', sessionId: 's3' } },
  });
  assert.equal(FakeWebSocket.instances.length, 2);
  const ws2 = FakeWebSocket.instances[1];

  // 旧 ws1 迟到的 close 事件不能把 ws2 上的 h3 杀掉
  ws1.close(1006, 'late close from old socket');
  const openMsg = ws2.sent[0];
  ws2.triggerMessage({
    type: 'item',
    streamId: openMsg.streamId,
    value: { type: 'snapshot', cursor: 1, records: [], hasMore: false },
  });
  const it3 = h3[Symbol.asyncIterator]();
  const first = await it3.next();
  assert.equal(first.done, false);
  assert.equal(first.value.cursor, 1);
  h1.close();
  h2.close();
  h3.close();
});

await check('2. 断线自动重连 + 指数退避 + cursor/session/page 补齐遗漏事件且不重复显示消息', async () => {
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:3097',
    cookie: TEST_COOKIE,
    WebSocketImpl: FakeWebSocket,
  });
  const store = new Store(conn, {
    reconnectBaseMs: 30,
    reconnectMaxMs: 200,
    random: () => 0.5, // jitterFactor = 1.0
  });

  let followCalls = 0;
  const pageCalls = [];
  let dropCurrentStream;

  store.api.follow = async () => {
    followCalls += 1;
    if (followCalls === 1) {
      // 首次连接：返回 seq 1, 2
      return {
        handle: { close() {} },
        snapshot: {
          type: 'snapshot',
          header: {},
          cursor: 2,
          records: [makeUserEvent(1, 'Msg-1'), makeUserEvent(2, 'Msg-2')],
          hasMore: false,
        },
        next: () =>
          new Promise((_, reject) => {
            dropCurrentStream = () => reject(new Error('连接已断开（code 1006）'));
          }),
      };
    }
    if (followCalls === 2) {
      // 第一次重连失败（模拟服务重启中）
      throw new Error('WebSocket 连接失败');
    }
    // 第二次重连成功：服务端快照只带最新窗口 seq 5, 6（中间缺了 seq 3, 4）
    return {
      handle: { close() {} },
      snapshot: {
        type: 'snapshot',
        header: {},
        cursor: 6,
        records: [makeUserEvent(5, 'Msg-5'), makeUserEvent(6, 'Msg-6')],
        hasMore: true,
      },
      next: () => new Promise(() => {}),
    };
  };

  store.api.page = async (params) => {
    pageCalls.push(params);
    // 补齐 seq 2 < seq < 5 的事件，并故意混入已有的 seq 2 验证去重
    return {
      records: [
        makeUserEvent(2, 'Msg-2'),
        makeUserEvent(3, 'Msg-3'),
        makeUserEvent(4, 'Msg-4'),
      ],
      hasMore: false,
    };
  };

  await store.openChat('s-gap');
  let chat = store.getChat('s-gap');
  assert.deepEqual(
    chat.items.filter((i) => i.kind === 'user').map((i) => i.text),
    ['Msg-1', 'Msg-2'],
  );

  // 触发断线：第一次重连 (~30ms) 失败，第二次重连 (~60ms) 成功并自动调 session/page 补齐
  dropCurrentStream();
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(followCalls, 3, '经历一次失败退避后第二次重连成功');
  assert.equal(pageCalls.length, 1, '自动通过 session/page 补齐断档缺口');
  assert.equal(pageCalls[0].throughSeq, 6);
  assert.equal(pageCalls[0].beforeSeq, 5);

  chat = store.getChat('s-gap');
  assert.equal(chat.error, undefined, '重连成功后清除错误提示');
  assert.deepEqual(
    chat.items.filter((i) => i.kind === 'user').map((i) => i.text),
    ['Msg-1', 'Msg-2', 'Msg-3', 'Msg-4', 'Msg-5', 'Msg-6'],
    '遗漏事件全部补齐且无任何重复消息',
  );
  store.closeChat('s-gap');
});

await check('3. Cookie 失效（401/403）停止自动重连，不无限重试', async () => {
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:3097',
    cookie: TEST_COOKIE,
    WebSocketImpl: FakeWebSocket,
  });
  const store = new Store(conn, {
    reconnectBaseMs: 25,
    reconnectMaxMs: 100,
    random: () => 0.5,
  });

  let followCalls = 0;
  store.api.follow = async () => {
    followCalls += 1;
    throw new RpcError({
      endpoint: 'remote.mux',
      kind: 'http',
      raw: 'HTTP 401 Unauthorized',
      userTitle: '登录状态失效了',
      userHint: '请重新配对',
      retryable: false,
    });
  };

  await store.openChat('s-auth');
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(followCalls, 1, '401 鉴权失败后不得继续退避重试');
  const chat = store.getChat('s-auth');
  assert.match(chat.error ?? '', /登录状态已失效/);
  store.closeChat('s-auth');
});

await check('4. 会话切换（closeChat）取消待定重连定时器，重复 openChat 不重复建流', async () => {
  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:3097',
    cookie: TEST_COOKIE,
    WebSocketImpl: FakeWebSocket,
  });
  const store = new Store(conn, {
    reconnectBaseMs: 40,
    reconnectMaxMs: 200,
    random: () => 0.5,
  });

  let followCalls = 0;
  let dropStream;
  store.api.follow = async () => {
    followCalls += 1;
    return {
      handle: { close() {} },
      snapshot: {
        type: 'snapshot',
        header: {},
        cursor: 1,
        records: [makeUserEvent(1, 'Hello')],
        hasMore: false,
      },
      next: () =>
        new Promise((_, reject) => {
          dropStream = () => reject(new Error('network drop'));
        }),
    };
  };

  await Promise.all([store.openChat('s-switch'), store.openChat('s-switch')]);
  assert.equal(followCalls, 1, '重复 openChat 只建一条流');

  dropStream();
  await new Promise((r) => setTimeout(r, 10));
  // 在退避定时器触发前关闭会话（切换离开）
  store.closeChat('s-switch');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(followCalls, 1, 'closeChat 后退避定时器已被取消，不再后台重连');
});

await check('5. App 前后台切换（handleAppForeground）与 P0-1 unknown 消息重连后自动对账确认', async () => {
  clearP0TestState();
  const persistence = {
    val: undefined,
    async readRaw() { return this.val; },
    async writeRaw(v) { this.val = v; },
    async clear() { this.val = undefined; },
  };
  const pending = new PendingSendStore({
    persistence,
    now: () => 1_800_000_000_000,
    idFactory: () => 'req-p01-p02-1',
  });
  await pending.hydrate();

  const conn = new DshConnection({
    baseUrl: 'http://127.0.0.1:3097',
    cookie: TEST_COOKIE,
    WebSocketImpl: FakeWebSocket,
  });
  const binding = {
    baseUrl: 'http://127.0.0.1:3097',
    gatewayId: 'gw-1',
    authContextHash: 'h-1',
    identityQuality: 'confirmed',
  };
  const store = new Store(conn, {
    pendingSendStore: pending,
    loadPendingBinding: async () => binding,
    verifyPendingBinding: async () => undefined,
    reconnectBaseMs: 30,
    reconnectMaxMs: 100,
  });
  store.api.list = async () => [];

  let followCalls = 0;
  store.api.follow = async () => {
    followCalls += 1;
    if (followCalls === 1) {
      return {
        handle: { close() {} },
        snapshot: { type: 'snapshot', header: {}, cursor: 1, records: [], hasMore: false },
        next: () => new Promise(() => {}),
      };
    }
    // App 回到前台重连时，服务端快照已经落盘了刚才回执丢失的 req-p01-p02-1
    return {
      handle: { close() {} },
      snapshot: {
        type: 'snapshot',
        header: {},
        cursor: 2,
        records: [makeUserEvent(2, 'msg before drop', 'req-p01-p02-1')],
        hasMore: false,
      },
      next: () => new Promise(() => {}),
    };
  };

  await store.openChat('s-fg');

  // 模拟发送时网络回执丢失 → 记录进入 unknown
  store.api.prompt = async () => {
    throw new Error('Network request failed');
  };
  await assert.rejects(() => store.sendPending('s-fg', 'msg before drop'));
  assert.equal((await pending.get('req-p01-p02-1')).state, 'unknown');

  // 模拟 App 从后台切回前台：立即触发重连并拉取最新快照，自动对账把 unknown 置为 confirmed
  store.handleAppForeground('http://127.0.0.1:3097');
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(followCalls, 2);
  const rec = await pending.get('req-p01-p02-1');
  assert.equal(rec.requestId, 'req-p01-p02-1');
  assert.equal(rec.state, 'confirmed', '重连后收到服务端真实 user/message 自动将 unknown 对账为 confirmed');
  store.close();
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
