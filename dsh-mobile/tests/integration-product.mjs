/**
 * 集成测试（驱动真实产品代码）。
 *
 * ## 和 integration-transport / gateway 的区别
 *
 * 那两个文件测的是「协议本身长什么样」—— 手搓 fetch 和 WS，验证服务端行为。
 * **这个文件测的是「我的代码能不能正确对接」** —— import 真实的
 * `DshConnection` 和 `ApprovalGateway`，让它们跑在模拟服务端上。
 *
 * 差别很实在：
 *   · 协议测试验证「服务端返回 401」
 *   · 产品代码测试验证「ApprovalGateway 收到 401 后有没有清 token 重连」
 *
 * 后者才是用户真正会遇到的。
 *
 * ## 怎么解决 RN 依赖
 *
 * `ApprovalGateway` import 了 `@react-native-async-storage/async-storage`，
 * 在 Node 里会报 NativeModule is null。
 *
 * 解法：在 import 产品代码**之前**，用 `Module._resolveFilename` hook
 * 把它重定向到一个内存实现（support/_async-storage-shim.cjs）。
 *
 * `Store` 没法这样处理 —— 它 import notify.ts → react-native，
 * 而 react-native 的入口是 ESM+Flow 语法，esbuild 解析不了。
 * 所以分页测试直接驱动 `DshConnection.call`，绕过 Store。
 */

import { createRequire } from 'node:module';
import { register } from 'node:module';
import Module from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import WS from 'ws';

// ⚠️ 必须最先注册：把 RN 原生模块重定向到测试替身。
//
// 用 ESM loader hook 而不是 Module._resolveFilename ——
// 后者只拦 require()，拦不到 `await import('...')`
// （DshConnection.readCookieFromJar 用的正是动态 import）。
register('./support/rn-module-hook.mjs', import.meta.url);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Windows 下动态 import 必须用 file:// URL，不能用裸路径 */
const imp = (absPath) => import(pathToFileURL(absPath).href);

// ── 注册 RN 原生模块的 stub（必须在 import 产品代码之前）────────────
const stubMod = await imp(path.join(__dirname, 'support', 'async-storage-stub.mjs'));
const AsyncStorageStub = stubMod.default;

// cookie 容器 + 带浏览器语义的 fetch 共用一个 jar
const cookieMod = await imp(path.join(__dirname, 'support', 'cookie-fetch.mjs'));
const cookieFetch = cookieMod.makeCookieFetch();

/** 把 jar 里的 cookie 塞进 CookieManager stub —— 产品代码从那里读 */
async function syncJarToCookieManager(srv) {
  const cm = require(path.join(__dirname, 'support', '_cookie-manager-shim.cjs'));
  cm.__reset();
  const cookies = cookieMod.getCookies(srv.baseUrl);
  for (const [name, value] of Object.entries(cookies)) {
    await cm.set(srv.baseUrl, { name, value });
  }
  return cm;
}

// （模块重定向已在顶部用 register() 完成，这里不再需要 CJS hook）

/**
 * 建一个带 cookie 语义的 DshConnection。
 *
 * 关键：注入 fetchImpl，否则产品代码用的是裸 Node fetch ——
 * 它不处理 Set-Cookie，会导致 `no cookie in jar`。
 * RN 里这个行为由原生实现提供，测试里由 cookieFetch 补齐。
 */
/**
 * 建一个带 cookie 语义的 DshConnection。
 *
 * 两处注入：
 *
 * 1. `fetchImpl` —— 补齐浏览器的 cookie 语义。
 *    Node 的 fetch 不处理 Set-Cookie，RN 里由原生实现负责。
 *
 * 2. `setCookieReader` —— 产品代码**专门为此预留的注入点**
 *    （见 transport.setCookieReader 的注释：「由宿主注入从原生 cookie
 *    容器读取的能力（RN 下必需）」）。
 *    用它比 mock 整个 @react-native-cookies/cookies 模块干净得多，
 *    而且这正是 RN 里的真实调用方式。
 */
function makeConn(srv) {
  const conn = new DshConnection({ baseUrl: srv.baseUrl, fetchImpl: cookieFetch });
  conn.setCookieReader(async (baseUrl) => {
    const cookies = cookieMod.getCookies(baseUrl);
    const parts = Object.entries(cookies)
      .filter(([name]) => name.startsWith('dsh-auth'))
      .map(([name, value]) => `${name}=${value}`);
    return parts.length ? parts.join('; ') : undefined;
  });
  return conn;
}

/** 登录（cookie 会自动进 jar，setCookieReader 会读到） */
async function login(conn, srv) {
  cookieMod.resetCookies();
  return conn.loginWithToken(srv.token);
}

/**
 * 把 cookie 灌进 jar，模拟「用户已经配过对」的状态。
 *
 * 真实流程：PairScreen 用 DshConnection 换到 cookie → 存进
 * AsyncStorage + 原生 cookie 容器。之后 ApprovalGateway.connect()
 * 才有权限调 POST /mgw/pair。
 *
 * ⚠️ **必须清掉 AsyncStorage 里的 device token**。
 *
 * 踩过的坑：不清的话，第二个测试会带着上一个（已关闭的）服务实例
 * 的 token 走「复用 token」路径。那条路径**不调 /mgw/pair**，
 * 于是拿不到 endpoints，pickUrl() 落到兜底逻辑 → 硬编码
 * `ws://<host>:3081/ws/mobile` → 连了个不存在的端口 → 1006 失败。
 *
 * 这也是产品的一个真实限制：**有 token 时重连不知道正确端口**，
 * 只能猜 3081 或等用户重新配对。测试里通过清 token 规避，
 * 保证每次都走「新配对」的完整路径。
 */
async function seedCookie(srv) {
  AsyncStorageStub.__reset();
  const conn = makeConn(srv);
  await conn.loginWithToken(srv.token);
  conn.close();
  // 确保 cookie 真的进了全局 jar —— ApprovalGateway 用的是裸 fetch
  // （走 globalThis.fetch = cookieFetch），两边必须共用同一个 jar。
  const jarKeys = Object.keys(cookieMod.getCookies(srv.baseUrl));
  if (jarKeys.length === 0) {
    throw new Error(`seedCookie 失败：${srv.baseUrl} 的 jar 里没有 cookie`);
  }
}

/**
 * 关掉一个网关并等它的重连定时器彻底停下。
 *
 * 为什么需要：disconnect() 只 clearTimeout 当前的 retryTimer，
 * 但如果此刻正处在「连接中」状态，onclose 可能又调一次 scheduleRetry，
 * 于是留下一个指向「即将关闭的服务端」的定时器。
 * 那个定时器在后面几个测试里疯狂重连，造成状态污染
 * （表现就是「第二个测试怎么也连不上」）。
 */
async function closeGateway(gw) {
  gw.disconnect();
  // 给在途的 onclose / scheduleRetry 一个落地的机会
  await new Promise((r) => setTimeout(r, 300));
  gw.disconnect();
}

/**
 * 建一条「裸」网关连接（不经过 ApprovalGateway）。
 *
 * 用于验证协议的可行性和边界：配对码一次性、dsh-token 能不能重连等。
 * 用 ws 库因为要往握手塞 X-DSH-Device-ID 头。
 */
function openRawGateway(srv, { code, token, deviceId } = {}) {
  const protocols = ['dsh-mobile-v1'];
  if (code) protocols.push(`dsh-pair.${code}`);
  if (token) protocols.push(`dsh-token.${token}`);

  const headers = {};
  if (deviceId) headers['X-DSH-Device-ID'] = deviceId;

  const ws = new WS(`ws://${srv.authority}/ws/mobile`, protocols, { headers });
  const opened = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 3000);
    ws.on('open', () => {
      clearTimeout(t);
      resolve(true);
    });
    ws.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    ws.on('close', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  return { ws, opened };
}

// ── 现在可以 import 产品代码了 ────────────────────────────────
const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);

// ⚠️ ApprovalGateway 用全局 WebSocket 的「第三参数传 headers」扩展，
// Node 的全局 WebSocket 会静默忽略它。必须在 connect() 之前换成支持 header 的实现。
// 用统一的兼容层（Node 20 没有全局 WebSocket，CI 会挂）
const wsMod = await imp(path.join(__dirname, 'support', 'ws-compat.mjs'));
wsMod.ensureWebSocket();

// ⚠️ requestPairingCode() 里用的是**裸 fetch**（没有 fetchImpl 注入点），
// 靠 `credentials:'include'` 让原生层带上 cookie。Node 的 fetch 不会。
// 所以这里把全局 fetch 也换成带 cookie 语义的版本。
globalThis.fetch = cookieFetch;

const { ApprovalGateway } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
);
const { parsePairingText } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pairing.ts'),
);
const { startFakeDsh } = await imp(path.join(__dirname, 'support', 'fake-dsh.mjs'));

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

// ═══════════════════════════════════════════════════════════════
// 一、扫码配对：parsePairingText + DshConnection 全链路
// ═══════════════════════════════════════════════════════════════
//
// 用户实际路径：扫码/粘贴 -> parsePairingText 拆出 baseUrl+token ->
//   DshConnection.loginWithToken 换 cookie。
// 这里整条链路都跑真实代码。

await check('配对：扫码文本 -> parsePairingText -> loginWithToken 全链路', async () => {
  const srv = await startFakeDsh({
    handlers: { 'session/list': async () => ({ items: [], hasMore: false }) },
  });
  try {
    // 用户扫到的就是这种带 token 的 URL
    const scanned = `${srv.baseUrl}/?token=${encodeURIComponent(srv.token)}`;
    const parsed = parsePairingText(scanned);
    if (!parsed) return 'parsePairingText 没解析出东西';
    if (!parsed.token) return '没解析出 token';
    // baseUrl 必须不含查询串（否则后续拼接会出问题）
    if (parsed.baseUrl.includes('token=')) return 'baseUrl 里混进了 token';

    cookieMod.resetCookies();
    // 这里 baseUrl 来自 parsePairingText（不是 srv.baseUrl），
    // 但两者应该一致 —— 顺便验证解析没把地址搞坏。
    const conn = new DshConnection({ baseUrl: parsed.baseUrl, fetchImpl: cookieFetch });
    conn.setCookieReader(async (baseUrl) => {
      const cookies = cookieMod.getCookies(baseUrl);
      const parts = Object.entries(cookies)
        .filter(([name]) => name.startsWith('dsh-auth'))
        .map(([name, value]) => `${name}=${value}`);
      return parts.length ? parts.join('; ') : undefined;
    });
    const cookie = await conn.loginWithToken(parsed.token);
    conn.close();
    return cookie && cookie.length > 0 ? true : '没换到 cookie';
  } finally {
    await srv.close();
  }
});

await check('配对：粘进来的裸 token 也能解析', async () => {
  const srv = await startFakeDsh();
  try {
    // 用户从终端复制的就是裸 token
    const parsed = parsePairingText(srv.token);
    if (!parsed) return '裸 token 没解析出来';
    if (parsed.baseUrl) return '裸 token 不该带 baseUrl';
    return parsed.token === srv.token ? true : 'token 被改动了';
  } finally {
    await srv.close();
  }
});

await check('配对：带引号/空白的粘贴内容能清洗', async () => {
  const srv = await startFakeDsh();
  try {
    const dirty = `  "${srv.baseUrl}/?token=${srv.token}"  `;
    const parsed = parsePairingText(dirty);
    if (!parsed) return '带引号的内容没解析出来';
    if (parsed.token !== srv.token) return 'token 没洗干净';
    return true;
  } finally {
    await srv.close();
  }
});

await check('配对：错误 token -> loginWithToken 抛错（不静默成功）', async () => {
  const srv = await startFakeDsh();
  try {
    cookieMod.resetCookies();
    const conn = makeConn(srv);
    let threw = false;
    try {
      await conn.loginWithToken('WRONGTOKEN_xxxxxxxxxxxxxxxx');
    } catch {
      threw = true;
    }
    conn.close();
    return threw ? true : '错误 token 居然没抛错';
  } finally {
    await srv.close();
  }
});

await check('配对：公网 http 地址被 checkBaseUrlSecurity 拦住', async () => {
  // 这是 v0.11.0 加的安全校验，走真实 DshConnection 验证它确实生效
  const conn = new DshConnection({ baseUrl: 'http://8.8.8.8:3095' });
  let msg = '';
  try {
    await conn.loginWithToken('sometoken_xxxxxxxxxxxxxx');
  } catch (e) {
    msg = e?.message ?? '';
  }
  conn.close();
  return msg.includes('明文') || msg.includes('https')
    ? true
    : '公网 http 没被拦住，错误信息：' + msg;
});

// ═══════════════════════════════════════════════════════════════
// 二、RPC：驱动真实 DshConnection
// ═══════════════════════════════════════════════════════════════

await check('RPC：DshConnection.call 发出的请求形状正确', async () => {
  const srv = await startFakeDsh({
    handlers: { 'session/list': async () => ({ items: [{ id: 's1' }], hasMore: false }) },
  });
  try {
    const conn = makeConn(srv);
    await login(conn, srv);

    const result = await conn.call('session/list', { _request: {} });
    conn.close();

    if (!srv.calls.length) return '服务端没收到请求';
    const call = srv.calls[0];
    if (call.endpoint !== 'session/list') return 'endpoint 不对';
    if (!call.args || typeof call.args !== 'object') return 'args 不是对象';
    return result?.items?.length === 1 ? true : '返回值没正确解析';
  } finally {
    await srv.close();
  }
});

await check('RPC：服务端返回 ok:false 时 DshConnection 抛错', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/list': async () => {
        throw new Error('gateway/input-invalid: bad args');
      },
    },
  });
  try {
    const conn = makeConn(srv);
    await login(conn, srv);
    let err = '';
    try {
      await conn.call('session/list', {});
    } catch (e) {
      err = e?.message ?? '';
    }
    conn.close();
    return err.includes('input-invalid') ? true : '错误没透传上来：' + err;
  } finally {
    await srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// 三、WebSocket 重连：驱动真实 ApprovalGateway
// ═══════════════════════════════════════════════════════════════
//
// 这是最重要的部分。ApprovalGateway 里的重连/自愈逻辑很复杂，
// 之前踩过「失效 token 永远 401」的坑，那段逻辑从没被自动化测过。
//
// 注意 API：方法是 disconnect() / respond(pending, outcome)，
// 不是 close() / resolve()。第一版就是猜错了方法名，集成测试直接报错
// —— 这正是它比静态检查强的地方。

await check('网关：ApprovalGateway 能连上并收到审批帧', async () => {
  const srv = await startFakeDsh();
  // 真实场景：用户已经用 DshConnection 配过对（cookie 在容器里），
  // 然后开审批通道。这里先把 cookie 灌进 jar。
  await seedCookie(srv);
  try {
    const statuses = [];
    const approvals = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s) => statuses.push(s),
      onApproval: (a) => approvals.push(a),
      onResolved: () => {},
    });

    await gw.connect();
    // 等配对完成
    await new Promise((r) => setTimeout(r, 300));

    if (!statuses.includes('online')) {
      await closeGateway(gw);
      return '状态没变成 online：' + statuses.join(',');
    }

    // 服务端推一条审批
    srv.pushGateway({
      kind: 'approval-requested',
      rpcId: 'rpc-real-1',
      sessionId: 'sess-real',
      approvalId: 'appr-real-1',
      toolName: 'pwsh',
      reason: '测试用',
      replay: false,
    });

    await new Promise((r) => setTimeout(r, 300));
    await closeGateway(gw);

    return approvals.length === 1 && approvals[0].approvalId === 'appr-real-1'
      ? true
      : '没收到审批或用例不对：' + JSON.stringify(approvals);
  } finally {
    await srv.close();
  }
});

await check('网关：断线后服务端接受 dsh-token 重连（协议层验证）', async () => {
  const srv = await startFakeDsh();
  try {
    // 第一步：配对，拿到长期 token
    const code = srv.makePairingCode();
    const first = openRawGateway(srv, { code, deviceId: 'reconnect-probe' });
    const opened = await first.opened;
    if (!opened) return '配对连接没建起来';

    const paired = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 2000);
      first.ws.on('message', (raw) => {
        try {
          const f = JSON.parse(String(raw));
          if (f.kind === 'paired') {
            clearTimeout(t);
            resolve(f);
          }
        } catch {
          /* ignore */
        }
      });
    });
    first.ws.close();
    if (!paired || !paired.token) return '配对帧里没有 token';

    // 第二步：断开，用 token 重连（这是重连该有的方式）
    srv.dropConnections();
    await new Promise((r) => setTimeout(r, 200));

    const second = openRawGateway(srv, { token: paired.token, deviceId: 'reconnect-probe' });
    const reopened = await second.opened;
    second.ws.close();
    return reopened ? true : '用 dsh-token 重连被拒（协议不支持）';
  } finally {
    await srv.close();
  }
});

await check('网关：旧配对码不能重复使用（这是重连 bug 的根因）', async () => {
  const srv = await startFakeDsh();
  try {
    const code = srv.makePairingCode();

    const first = openRawGateway(srv, { code, deviceId: 'reuse-probe' });
    const ok1 = await first.opened;
    first.ws.close();
    if (!ok1) return '第一次配对就没成功';

    // 同一个码再用一次 —— 应该被拒。
    // 真实 DSH 网关的 claimPairing 里 `pairings.delete(codeHash)`，
    // 所以配对码永远是一次性的。
    const second = openRawGateway(srv, { code, deviceId: 'reuse-probe' });
    const ok2 = await second.opened;
    second.ws.close();
    return ok2 ? '配对码能重复使用（安全性问题）' : true;
  } finally {
    await srv.close();
  }
});

await check('网关：ApprovalGateway 首次连接会申请配对码', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const details = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => {
        statuses.push(s);
        if (d) details.push(`${s}:${d}`);
      },
      onApproval: () => {},
      onResolved: () => {},
    });

    await gw.connect();
    await new Promise((r) => setTimeout(r, 500));
    const online = statuses.includes('online');
    const pairs = srv.pairCalls;
    await closeGateway(gw);

    if (!online) return '首次连接没成功；详情 ' + details.join(' | ');
    // 首次连接必须调 /mgw/pair 拿配对码
    return pairs >= 1 ? true : '首次连接没有申请配对码（pairCalls=0）';
  } finally {
    await srv.close();
  }
});
await check('网关：失效 token 的重连会被服务端拒绝（协议层）', async () => {
  const srv = await startFakeDsh();
  try {
    // 用一个服务端不认识的 token 去连
    const attempt = openRawGateway(srv, {
      token: 'stale-token-that-will-401',
      deviceId: 'stale-probe',
    });
    const opened = await attempt.opened;
    attempt.ws.close();
    // 必须被拒 —— 否则「失效 token 自愈」这条逻辑永远不会触发
    return opened ? '失效 token 居然连上了' : true;
  } finally {
    await srv.close();
  }
});

await check('网关：清掉失效 token 后重新配对能恢复', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    AsyncStorageStub.__reset();

    // 预置一个失效的 device token
    await AsyncStorageStub.setItem('@dsh/gatewayToken', 'stale-token-that-will-401');

    // 第一步：带着失效 token 连 —— 会被拒
    const bad = openRawGateway(srv, {
      token: 'stale-token-that-will-401',
      deviceId: 'heal-probe',
    });
    const badOpen = await bad.opened;
    bad.ws.close();
    if (badOpen) return '前置条件不对：失效 token 不该连上';

    // 第二步：模拟自愈（产品代码在检测到 401 时会清 token 再连）
    // 注意：真实实现里 onclose 的 reason 在握手阶段 401 时拿不到
    // （ws 层只会给 1006），所以这条自愈路径**可能触发不了** ——
    // 见 docs/known-issues.md。这里验证的是「清掉后能恢复」。
    await AsyncStorageStub.removeItem('@dsh/gatewayToken');

    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s) => statuses.push(s),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 600));
    const online = statuses.includes('online');
    await closeGateway(gw);

    return online ? true : '清掉 token 后仍连不上（自愈链路断了）';
  } finally {
    await srv.close();
  }
});

await check('网关：自己回的审批服务端能收到', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 400));

    const received = new Promise((resolve) => {
      srv.onGatewayMessage((msg) => {
        if (msg.type === 'approval-response') resolve(msg);
      });
    });

    // respond 的签名是 (pending, outcome) —— 对象在前
    gw.respond(
      {
        rpcId: 'rpc-real-2',
        sessionId: 'sess-real',
        approvalId: 'appr-real-2',
        toolName: 'pwsh',
      },
      'allowed-once',
    );

    const got = await Promise.race([
      received,
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    await closeGateway(gw);

    if (!got) return '服务端没收到审批回复';
    return got.outcome === 'allowed-once' ? true : 'outcome 不对：' + got.outcome;
  } finally {
    await srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════
// 四、长会话分页：驱动真实 DshConnection
// ═══════════════════════════════════════════════════════════════
//
// 不用 Store：它 import notify.ts -> react-native，Node 里跑不了。
// 但分页的核心逻辑在 DshConnection.call + 调用方的游标管理，
// 这部分能完整验证。

await check('长会话：真实 DshConnection 拉分页，60 条记录不丢', async () => {
  const TOTAL = 60;
  const PAGE = 20;
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async (args) => {
        const req = args?.request ?? {};
        const throughSeq = req.throughSeq;
        const beforeSeq = req.beforeSeq;
        const max = req.maxMessages ?? PAGE;
        const cursor = TOTAL - 1;
        if (throughSeq > cursor) {
          throw new Error(`session page through seq ${throughSeq} is past cursor ${cursor}`);
        }
        const all = Array.from({ length: TOTAL }, (_, i) => ({ seq: i }));
        const upper = typeof beforeSeq === 'number' ? beforeSeq : throughSeq;
        const candidates = all.filter((r) => r.seq <= upper);
        const page = candidates.slice(-max);
        return { records: page, hasMore: candidates.length > page.length };
      },
    },
  });
  try {
    const conn = makeConn(srv);
    await login(conn, srv);

    const collected = [];
    let throughSeq = TOTAL - 1;
    let beforeSeq;
    let guard = 0;
    while (guard < 10) {
      guard += 1;
      const json = await conn.call('session/page', {
        request: {
          address: { kind: 'session', sessionId: 'sess-long' },
          throughSeq,
          ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
          maxMessages: PAGE,
        },
      });
      const records = json?.records ?? [];
      collected.unshift(...records);
      if (!json?.hasMore || records.length === 0) break;
      beforeSeq = records[0].seq - 1;
      if (beforeSeq < 0) break;
    }
    conn.close();

    if (collected.length !== TOTAL) {
      return `只拉到 ${collected.length} 条，期望 ${TOTAL}`;
    }
    const unique = new Set(collected.map((r) => r.seq));
    if (unique.size !== TOTAL) return '有重复记录';
    return collected[0].seq === 0 ? true : '最旧的不是 seq=0';
  } finally {
    await srv.close();
  }
});

await check('长会话：throughSeq 超过游标时错误能透传到调用方', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async (args) => {
        const throughSeq = args?.request?.throughSeq;
        if (throughSeq > 9) {
          throw new Error(`session page through seq ${throughSeq} is past cursor 9`);
        }
        return { records: [], hasMore: false };
      },
    },
  });
  try {
    const conn = makeConn(srv);
    await login(conn, srv);
    let err = '';
    try {
      await conn.call('session/page', {
        request: { address: { kind: 'session', sessionId: 's' }, throughSeq: 999 },
      });
    } catch (e) {
      err = e?.message ?? '';
    }
    conn.close();
    return err.includes('past cursor') ? true : '错误没透传：' + err;
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
