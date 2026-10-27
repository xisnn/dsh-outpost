/**
 * P0-1 回归测试：WebSocket 断线后，活跃流必须**立刻失败**而不是永久挂起。
 *
 * ## 这个 bug 为什么严重
 *
 * 修之前 `ensureSocket()` 只监听 open / error / message，**没有 close 监听**。
 * socket 断开后：
 *   · 不会再有帧到达
 *   · 流的 async iterator 永远卡在 `await new Promise(r => notify = r)`
 *   · `store.pump()` 的 `await next()` 永不返回
 *   · 聊天页既不报错也不结束 → 转圈动画一直转，只能杀 App
 *
 * 这是「假死」类缺陷里最难排查的：界面上没有任何错误提示。
 *
 * ## 怎么测
 *
 * 用一个**可控的假 WebSocket**（不连真网络），驱动真实的 `DshConnection`：
 *   1. 连上 → 开一条流
 *   2. 模拟服务端推一帧
 *   3. 模拟 socket close
 *   4. 断言 iterator 在**有限时间内**抛出错误，而不是一直 pending
 *
 * 关键断言是「有超时上限」：如果修复失效，测试会超时失败，而不是静默通过。
 */

import { register } from 'node:module';

register('./support/ts-resolve.mjs', import.meta.url);

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass += 1;
  console.log('  OK    ' + n);
};
const bad = (n, d) => {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
};
const check = (c, n, d) => (c ? ok(n) : bad(n, d));

/** 可控的假 WebSocket：能手动触发 open / message / close / error */
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = { open: [], close: [], error: [], message: [] };
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  // ── 测试驱动 ──
  _emit(type, ev) {
    for (const fn of this.listeners[type] || []) {
      try {
        fn(ev);
      } catch {
        /* ignore */
      }
    }
  }
  _open() {
    this.readyState = 1;
    this._emit('open', {});
  }
  _push(obj) {
    this._emit('message', { data: JSON.stringify(obj) });
  }
  _serverClose(code = 1006, reason = '') {
    this.readyState = 3;
    this._emit('close', { code, reason });
  }
}

/** 把 promise 包上超时，避免测试本身挂死 */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT(${label}) ${ms}ms`)), ms)),
  ]);
}

const { DshConnection } = await import('../src/core/transport/index.ts');

/** 建一个已连上的连接（用假 WS） */
async function makeConnected() {
  let sock;
  const conn = new DshConnection({
    baseUrl: 'http://192.168.1.10:3095',
    cookie: 'dsh-auth-x=v1.abc',
    WebSocketImpl: function Ws(url) {
      sock = new FakeWebSocket(url);
      // ensureSocket 会 await open：下一 tick 触发
      setTimeout(() => sock._open(), 0);
      return sock;
    },
  });
  const handle = await withTimeout(conn.openStream('session/follow', { request: {} }), 3000, 'openStream');
  // openStream 内部 await ensureSocket()，再 send open 帧
  return { conn, handle, sock };
}

/** 消费 iterator，收集结果 */
function makeReader(handle) {
  const it = handle[Symbol.asyncIterator]();
  return {
    it,
    next: () => it.next(),
  };
}

console.log('');
console.log('── 1. 正常情况下流能work ──');

{
  const { conn, handle, sock } = await makeConnected();
  const reader = makeReader(handle);
  check(sock.sent.length >= 1, 'openStream 发出了 open 帧');

  // 推两帧：一帧 item，一帧 end
  sock._push({ type: 'item', streamId: handle.streamId, value: { hello: 1 } });
  const first = await withTimeout(reader.next(), 2000, 'first item');
  check(!first.done && first.value?.hello === 1, '能正常收到 item 帧');

  sock._push({ type: 'end', streamId: handle.streamId });
  const second = await withTimeout(reader.next(), 2000, 'end');
  check(second.done === true, '收到 end 帧后 iterator 结束');
  conn.close();
}

console.log('');
console.log('── 2. 核心：断线必须让活跃流立刻失败（P0-1）──');

{
  const { conn, handle, sock } = await makeConnected();
  const reader = makeReader(handle);

  // 先确认流在等数据（没有立刻结束）
  let settled = false;
  const pending = reader.next().then(
    () => {
      settled = true;
      return 'resolved';
    },
    (e) => {
      settled = true;
      return e;
    },
  );
  await new Promise((r) => setTimeout(r, 50));
  check(settled === false, '断线前流处于等待状态（符合预期）');

  // 服务端异常断开（1006 = 没有 close 帧的异常断开）
  sock._serverClose(1006, '');

  // 关键断言：必须在有限时间内 reject，而不是永远 pending
  const result = await withTimeout(pending, 2000, 'close-fail');
  const isError = result instanceof Error;
  check(isError, '断线后流 iterator 立刻抛错（不是永久挂起）');
  if (isError) {
    check(
      /断开|关闭|网络|WebSocket/i.test(result.message),
      '错误信息可读（含「断开/关闭/网络」等字样）',
      result.message,
    );
  }
  conn.close();
}

console.log('');
console.log('── 3. 正常关闭（code 1000）也要失败，不能挂起 ──');

{
  const { conn, handle, sock } = await makeConnected();
  const reader = makeReader(handle);
  const pending = reader.next().catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));
  sock._serverClose(1000, 'normal');
  const result = await withTimeout(pending, 2000, 'close-1000');
  check(result instanceof Error, 'code 1000 时流同样结束（不挂起）');
  conn.close();
}

console.log('');
console.log('── 4. error 事件也要触发失败 ──');

{
  const { conn, handle, sock } = await makeConnected();
  const reader = makeReader(handle);
  const pending = reader.next().catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));
  sock._emit('error', {});
  const result = await withTimeout(pending, 2000, 'error-event');
  check(result instanceof Error, 'error 事件后流失败');
  conn.close();
}

console.log('');
console.log('── 5. 多条流同时失败（不能只处理第一条）──');

{
  const conn = new DshConnection({
    baseUrl: 'http://192.168.1.10:3095',
    cookie: 'dsh-auth-x=v1.abc',
    WebSocketImpl: function Ws() {
      const s = new FakeWebSocket();
      setTimeout(() => s._open(), 0);
      return s;
    },
  });
  const h1 = await withTimeout(conn.openStream('session/follow', {}), 3000, 'h1');
  const h2 = await withTimeout(conn.openStream('session/follow', {}), 3000, 'h2');
  const r1 = h1[Symbol.asyncIterator]().next().catch((e) => e);
  const r2 = h2[Symbol.asyncIterator]().next().catch((e) => e);
  await new Promise((r) => setTimeout(r, 30));

  // 从 conn 内部拿 socket（ensureSocket 复用了同一个）
  const ws = conn.ws;
  ws._serverClose(1006, 'gone');

  const [a, b] = await withTimeout(Promise.all([r1, r2]), 2000, 'both');
  check(a instanceof Error, '第 1 条流失败');
  check(b instanceof Error, '第 2 条流也失败（不是只处理一条）');
  conn.close();
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
