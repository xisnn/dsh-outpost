/**
 * 端到端验证：用 Node 的 fetch + ws 驱动 transport/rpc/fold 的等价逻辑。
 *
 * 由于 src 是 TypeScript，这里用 Node 24 的原生 TS 支持直接 import
 * （node --experimental-strip-types，或 Node 24 默认支持 .ts）。
 */
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.env.DSH_HOST ?? '192.168.1.10';
const PORT = Number(process.env.DSH_PORT ?? 3096);
const TOKEN = process.env.DSH_TOKEN;
if (!TOKEN) { console.error('need DSH_TOKEN'); process.exit(1); }

const BASE = `http://${HOST}:${PORT}`;

// ── 极简 cookie 提取（Node fetch 的 getSetCookie） ─────────────────
async function login() {
  const res = await fetch(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, {
    redirect: 'manual',
    headers: { Host: `${HOST}:${PORT}` },
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  const cookie = sc.map(c => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`login failed: HTTP ${res.status}`);
  return cookie;
}

let counter = 0;
async function call(cookie, endpoint, args) {
  const body = {
    type: 'client-request',
    rpcId: `r${Date.now()}-${++counter}`,
    method: endpoint,
    payload: { args },
  };
  const res = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: `${HOST}:${PORT}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
  const parsed = await res.json();
  const r = parsed?.result;
  if (!r || r.ok === false) {
    throw new Error(`${endpoint}: ${r?.error?.code} ${r?.error?.message}`);
  }
  return r.value;
}

// ── 极简 WS ──────────────────────────────────────────────────────
//
// ⚠️ 不要直接 `new WebSocket(...)`：Node 20 **没有**全局 WebSocket
// （21+ 才有）。这里通过兼容层保证任何支持的 Node 版本都能跑。
async function openFollow(cookie, sessionId) {
  const wsUrl = `ws://${HOST}:${PORT}/api/remote.mux`;
  const { ensureWebSocket } = await import('./support/ws-compat.mjs');
  ensureWebSocket();
  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie } });

  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('ws open timeout')), 10000);
    ws.onopen = () => { clearTimeout(t); res(); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws error')); };
  });

  const streamId = 'test-' + Math.random().toString(36).slice(2, 8);
  const inbox = [];
  let wake = null;
  let closed = false;

  ws.onmessage = (ev) => {
    let f;
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f.streamId !== streamId) return;
    if (f.type === 'item') { inbox.push(f.value); wake?.(); wake = null; }
    else if (f.type === 'end' || f.type === 'error') { closed = true; wake?.(); wake = null; }
  };

  ws.send(JSON.stringify({
    type: 'open',
    streamId,
    endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId } } } },
  }));

  const next = () => new Promise(async (resolve) => {
    while (true) {
      if (inbox.length) return resolve(inbox.shift());
      if (closed) return resolve(undefined);
      await new Promise(r => { wake = r; });
    }
  });

  const snapshot = await next();
  return { ws, snapshot, next, streamId };
}

// ── 从 fold 源码里取纯函数（用正则导出不现实，这里复制关键逻辑验证） ──
function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks.filter(b => b && b.type === 'text').map(b => b.text ?? '').join('');
}

const passed = [];
const failed = [];
function check(name, cond, detail) {
  if (cond) { passed.push(name); console.log(`  OK    ${name}`); }
  else { failed.push(name); console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); }
}

/**
 * 挑一个「内容足够丰富」的会话来做事件断言。
 *
 * 不能直接拿第一个非空会话：那个是最近更新的，可能只是刚建的、
 * 或者一轮就报错结束的（没有 assistant/message、没有 tool/call），
 * 断言会随环境数据漂移。按 sessionStats.turns 取最大的那个更稳。
 */
function pickRichestSession(sessions) {
  const nonBlank = sessions.filter((s) => !s.blank);
  const turnsOf = (s) => s.projections?.values?.sessionStats?.turns ?? 0;
  const sorted = [...nonBlank].sort((a, b) => turnsOf(b) - turnsOf(a));
  return sorted[0] ?? sessions[0];
}

console.log('=== 端到端验证\n');

// 1. 登录
const cookie = await login();
check('token → cookie', !!cookie, cookie?.slice(0, 20));

// 2. session/list
const list = await call(cookie, 'session/list', { _request: {} });
check('session/list 返回 items', Array.isArray(list?.items), `count=${list?.items?.length}`);

// 3. 按 cwd 分组
const sessions = list.items.filter(s => s.origin !== 'subagent');
const byCwd = new Map();
for (const s of sessions) {
  const k = s.cwd ?? '';
  byCwd.set(k, (byCwd.get(k) ?? 0) + 1);
}
check('按 cwd 分组得到工作区', byCwd.size > 0, `${byCwd.size} 个：${[...byCwd.keys()].join(' | ')}`);

// 4. projections 有 token 数据
const withTokens = sessions.find(s => s.projections?.values?.tokenUsage);
check('projections 带 tokenUsage', !!withTokens, withTokens ? 'yes' : 'no');
// 不能只看「第一个有 tokenUsage 的会话」——那可能是刚建的空白会话，
// 还没有 contextPressure。按属性找，别依赖列表顺序。
const withPressure = sessions.find(
  s => typeof s.projections?.values?.contextPressure?.pressureTokens === 'number',
);
if (withPressure) {
  const p = withPressure.projections.values.contextPressure;
  check('contextPressure 可用于量表', true, `used=${p?.pressureTokens}/${p?.contextWindow}`);
} else {
  check('contextPressure 可用于量表', false, '没有任何会话带 contextPressure');
}

// 5. follow 拿快照
const target = pickRichestSession(sessions);
console.log(`\n  目标会话: ${target.sessionId.slice(0, 16)} (${target.projections?.values?.title ?? '无标题'})`);
const { ws, snapshot, next } = await openFollow(cookie, target.sessionId);

check('follow 首帧有 cursor', typeof snapshot?.cursor === 'number', `cursor=${snapshot?.cursor}`);
check('follow 首帧有 records', Array.isArray(snapshot?.records), `records=${snapshot?.records?.length}`);
check('follow 首帧有 projections', !!snapshot?.projections);
check('hasMore 存在', typeof snapshot?.hasMore === 'boolean', String(snapshot?.hasMore));

// 6. 用 cursor 取更早历史
let allRecords = [...snapshot.records];
if (snapshot.hasMore) {
  const earliest = Math.min(...allRecords.map(r => r.event?.seq ?? Infinity));
  const page = await call(cookie, 'session/page', {
    request: {
      address: { kind: 'session', sessionId: target.sessionId },
      throughSeq: snapshot.cursor,
      beforeSeq: earliest,
      maxMessages: 300,
    },
  });
  check('session/page 用 cursor 成功', Array.isArray(page?.records), `+${page?.records?.length}`);
  allRecords = [...(page?.records ?? []), ...allRecords];
}

// 7. page 超出 cursor 应报错
try {
  await call(cookie, 'session/page', {
    request: {
      address: { kind: 'session', sessionId: target.sessionId },
      throughSeq: snapshot.cursor + 100000,
    },
  });
  check('throughSeq 越界应报错', false, '没有报错');
} catch (e) {
  check('throughSeq 越界正确报错', /past cursor/.test(String(e)), String(e).slice(0, 80));
}

// 8. 事件字段核对
const events = allRecords.map(r => r.event).filter(Boolean);
check('总事件数 > 0', events.length > 0, `${events.length} 条`);

const userMsg = events.find(e => e.type === 'user/message');
check('user/message 有 content[]', Array.isArray(userMsg?.data?.content));
check('user/message 能抽出文本', textOf(userMsg?.data?.content).length > 0);

const asstMsg = events.find(e => e.type === 'assistant/message');
check('assistant/message 在 message.content', !!asstMsg?.data?.message?.content);

const toolCall = events.find(e => e.type === 'tool/call');
check('tool/call 有 callId', typeof toolCall?.data?.callId === 'string');
check('tool/call.arguments 是字符串', typeof toolCall?.data?.arguments === 'string');

const toolResult = events.find(e => e.type === 'tool/result');
check('tool/result 有 toolCallId', typeof toolResult?.data?.message?.toolCallId === 'string');
check('tool/result 可通过 callId 匹配 tool/call',
  toolCall && toolResult && toolCall.data.callId === toolResult.data.message.toolCallId,
  `${toolCall?.data?.callId?.slice(0, 12)} vs ${toolResult?.data?.message?.toolCallId?.slice(0, 12)}`);

// 9. turn/step 号可用于归组
const turnCount = new Set(events.filter(e => e.type === 'turn/start').map(e => e.data.turn)).size;
check('turn/start 的 turn 号可归组', turnCount > 0, `${turnCount} 个 turn`);

ws.close();

// 等 WS 句柄真正关掉再退出：Node 24 在 handle 还在 closing 时 process.exit
// 会触发 libuv 断言（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）。
setTimeout(() => {
  console.log(`\n结果：${passed.length} 通过，${failed.length} 失败`);
  process.exit(failed.length === 0 ? 0 : 1);
}, 200);
