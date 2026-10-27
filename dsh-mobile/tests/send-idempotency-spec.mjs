/**
 * 消息发送的**幂等性**回归测试。
 *
 * ## 这条为什么重要
 *
 * 上一轮修了「失败重试产生重复消息」—— 但那只是 **UI 重复**
 * （本地列表里多一条），并没有解决**服务端重复执行**。
 *
 * DSH 服务端的 `sessionController.prompt` 是这样的：
 *
 *     async prompt(request, source) {
 *       const agent = await this.resolveAgent(request.sessionId);
 *       if (hasPromptRequest(agent, request.requestId)) return { accepted: true };
 *       ...真正入队...
 *     }
 *
 * `hasPromptRequest` 同时检查：
 *   · `agent.inbox.nextTurn` / `nextStep`  —— 还在排队的
 *   · `agent.session.snapshotEvents()` 里的 `user/message.rpcId` —— 已经执行的
 *
 * 所以**服务端是有幂等键的**，键就是 `requestId`。
 *
 * 关键在于客户端：如果重试时换一个新的 requestId，服务端就当成两条
 * 不同的消息 —— 任务会真的跑两遍。对有副作用的工具调用（写文件、
 * 执行命令）这是灾难性的。
 *
 * ## 这组测试守什么
 *
 * 1. `store.send()` 必须把 requestId 透传给 `session/prompt`
 * 2. 重试路径必须复用同一个 requestId
 * 3. 改了内容必须换新 requestId（否则会被服务端误判成重复而丢弃）
 * 4. 成功之后必须清掉，下一次发送是新的 id
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

register('./support/rn-module-hook.mjs', import.meta.url);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

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

// 源码文本，供静态断言用（提前声明，避免顺序问题）
const chatSrc = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const storeSrc = readFileSync('src/core/store.ts', 'utf8');
const apiSrc = readFileSync('src/core/rpc/session.ts', 'utf8');

let pass = 0;
let fail = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
async function check(n, fn) {
  try {
    const r = await fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

// ⚠️ Node 20 没有全局 WebSocket（Node 21+ 才有）。
// DshConnection 构造时会检查 WS 实现，缺了直接抛
// 「no WebSocket implementation available」。
// 其他集成测试都调了 ensureWebSocket()，这里也必须调。
const wsMod = await imp(path.join(__dirname, 'support', 'ws-compat.mjs'));
wsMod.ensureWebSocket();

const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);
const { Store } = await imp(path.join(__dirname, '..', 'src', 'core', 'store.ts'));

/** 造一个 Store，记录每次 prompt 的 requestId */
function makeStore({ failTimes = 0 } = {}) {
  const conn = new DshConnection({ baseUrl: 'http://127.0.0.1:1', cookie: 'dsh-auth-test=v1' });
  const store = new Store(conn);
  const seen = [];
  let calls = 0;
  store.api.prompt = async (params) => {
    calls += 1;
    seen.push(params.requestId);
    if (calls <= failTimes) throw new Error('Network request failed');
    return undefined;
  };
  return { store, seen };
}

const SID = 'session-idem-1';

// ══════════════════════════════════════════════════════════════
// 一、requestId 必须透传到 session/prompt
// ══════════════════════════════════════════════════════════════

await check('store.send 把 requestId 透传给 prompt', async () => {
  const { store, seen } = makeStore();
  await store.send(SID, 'hello', [], 'queue', 'fixed-req-id-1');
  if (seen.length !== 1) return `prompt 被调用 ${seen.length} 次`;
  return seen[0] === 'fixed-req-id-1'
    ? true
    : `透传的是 ${JSON.stringify(seen[0])}，不是调用方给的 id`;
});

await check('不传 requestId 时 SessionApi 会生成默认值（注入消息用）', async () => {
  // 注意：默认生成发生在 SessionApi.prompt 内部
  // （`params.requestId ?? req-${Date.now()}-...`），不在 store.send。
  // 上面的 mock 替换掉了 api.prompt，所以这里只能静态确认。
  const okDefault = /params\.requestId \?\? `req-/.test(apiSrc);
  if (!okDefault) return 'SessionApi 没有默认生成 requestId';

  // 同时确认 store.send 允许不传（参数可选）
  const { store, seen } = makeStore();
  await store.send(SID, 'hello', [], 'queue');
  return seen.length === 1 && seen[0] === undefined
    ? true
    : `不传时应透传 undefined 给 SessionApi，实际 ${JSON.stringify(seen[0])}`;
});

// ══════════════════════════════════════════════════════════════
// 二、重试必须复用同一个 requestId（核心）
// ══════════════════════════════════════════════════════════════

await check('🔴 重试复用同一个 requestId → 服务端才能去重', async () => {
  const { store, seen } = makeStore({ failTimes: 1 });
  // 第一次失败
  try {
    await store.send(SID, 'dangerous-task', [], 'queue', 'stable-id-A');
  } catch {
    /* 预期 */
  }
  // 重试 —— 同一个 id
  await store.send(SID, 'dangerous-task', [], 'queue', 'stable-id-A');

  if (seen.length !== 2) return `prompt 被调用 ${seen.length} 次`;
  return seen[0] === seen[1]
    ? true
    : `两次用了不同 id（${seen[0]} vs ${seen[1]}）—— 服务端会重复执行任务`;
});

await check('🔴 若换新 id → 服务端会当成两条（反证）', async () => {
  // 这个测试证明「为什么必须复用」：换 id 时服务端无法去重
  const { store, seen } = makeStore({ failTimes: 1 });
  try {
    await store.send(SID, 'task', [], 'queue', 'id-1');
  } catch {
    /* 预期 */
  }
  await store.send(SID, 'task', [], 'queue', 'id-2');

  // 两个不同 id → 服务端 hasPromptRequest 两次都返回 false → 入队两次
  return seen[0] !== seen[1]
    ? true
    : '这个反证测试本身失效了（两个 id 竟然相同）';
});

// ══════════════════════════════════════════════════════════════
// 三、静态检查：ChatScreen 的重试逻辑
// ══════════════════════════════════════════════════════════════



await check('ChatScreen 保存了失败请求的 requestId', () => {
  if (!/retryReq/.test(chatSrc)) return '没有 retryReq 状态';
  const i = chatSrc.indexOf('setRetryReq({ id: requestId, text })');
  return i > 0 ? true : '失败分支没有记住 requestId';
});

await check('ChatScreen 重试时复用（而不是重新生成）', () => {
  const i = chatSrc.indexOf('const isRetry =');
  if (i < 0) return '找不到 isRetry 判断';
  const seg = chatSrc.slice(i, i + 500);
  if (!/retryReq\.id/.test(seg)) return '重试分支没用 retryReq.id';
  return /isRetry \? retryReq\.id :/.test(seg)
    ? true
    : '判断结构不对，可能总是生成新 id';
});

await check('ChatScreen 成功后会清掉 retryReq', () => {
  const i = chatSrc.indexOf('await store.send(sessionId, text, attachments,');
  if (i < 0) return '找不到发送调用';
  const seg = chatSrc.slice(i, i + 400);
  return /setRetryReq\(undefined\)/.test(seg)
    ? true
    : '成功后没清掉 —— 下次再发同样内容会被误判成重试';
});

await check('改了文字必须换新 requestId（否则被服务端丢弃）', () => {
  const i = chatSrc.indexOf('const isRetry =');
  const seg = chatSrc.slice(i, i + 300);
  return /retryReq\.text === text/.test(seg)
    ? true
    : '没有按文字内容判断，用户改完内容重发会被当成重复而丢弃';
});

await check('store.send 把 requestId 传给 api.prompt', () => {
  const i = storeSrc.indexOf('await this.api.prompt(');
  if (i < 0) return '找不到 prompt 调用';
  const seg = storeSrc.slice(i, i + 300);
  return /\brequestId\b/.test(seg) ? true : 'prompt 调用没带 requestId';
});

await check('SessionApi.prompt 支持 requestId 参数', () => {
  return /requestId\?: string/.test(apiSrc) && /params\.requestId \?\?/.test(apiSrc)
    ? true
    : 'SessionApi 没有 requestId 支持';
});

// ══════════════════════════════════════════════════════════════
// 四、错误提示必须区分「未知」和「失败」
// ══════════════════════════════════════════════════════════════

await check('超时要提示「结果未知」而不是「失败」', () => {
  const i = chatSrc.indexOf('function describeSendError');
  if (i < 0) return '找不到 describeSendError';
  const seg = chatSrc.slice(i, i + 1600);
  if (!/发送结果未知/.test(seg)) return '超时没有说明结果未知';
  return /不会重复执行/.test(seg) ? true : '没有告诉用户重试是安全的';
});

await check('网络不通要说清「没发出去」', () => {
  const i = chatSrc.indexOf('function describeSendError');
  const seg = chatSrc.slice(i, i + 1600);
  return /消息没发出去/.test(seg) ? true : '没有区分「没发出去」';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
