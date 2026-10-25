/**
 * 审批 WebSocket 异常恢复的回归测试。
 *
 * ## 缺陷是什么
 *
 * 旧实现「连续两次 WebSocket 握手失败就清设备 Token」。但握手失败
 * 和凭据失效**没有因果关系**，能导致它的原因至少包括：
 *
 *   · 手机切换 Wi-Fi（IP 变了，旧连接断了，新连接还在握手）
 *   · 移动网络暂时中断 / 进电梯 / 地铁
 *   · 电脑休眠或重启
 *   · DSH 服务重启（网关进程跟着起落）
 *   · WebSocket 服务不可达（3081 被防火墙拦）
 *   · HTTP 正常但 WS 握手失败（代理、企业网关只放行 HTTP）
 *   · 代理或防火墙异常
 *
 * 这些情况下 Token 完全有效。清掉它 → 用户莫名失去审批权限，
 * 而且断网期间连配对码都申请不到，整条链路停摆。
 *
 * ## 正确判据
 *
 * 只有**服务端明确证明凭据无效**才清 Token：
 *   · 关闭码 4003（device revoked）→ 授权被作废
 *   · close reason / 握手异常里明确写着 401 / 403 / unauthorized
 *
 * 「失败了几次」永远不能作为判据。
 *
 * ## 这一组测什么
 *
 * 每条用例都驱动**真实的 ApprovalGateway** 跑在模拟服务端上，
 * 覆盖任务要求的全部场景。断言的核心永远是同一个问题：
 * **有效 Token 还在不在，以及连接能不能自己回来。**
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

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
  return origResolve.call(this, request, parent, ...rest);
};
void require;

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

function ks() {
  if (!globalThis.__dshTestKeychainState__) {
    globalThis.__dshTestKeychainState__ = { store: new Map() };
  }
  return globalThis.__dshTestKeychainState__.store;
}
const GW_TOKEN_SERVICE = 'com.dshpocket.credentials.dsh.gatewayToken';
function ksToken() {
  const rec = ks().get(GW_TOKEN_SERVICE);
  return rec ? rec.password : undefined;
}

const AsyncStorageStub = (await imp(path.join(__dirname, 'support', 'async-storage-stub.mjs')))
  .default;
const cookieMod = await imp(path.join(__dirname, 'support', 'cookie-fetch.mjs'));
const cookieFetch = cookieMod.makeCookieFetch();
const wsMod = await imp(path.join(__dirname, 'support', 'ws-compat.mjs'));
wsMod.ensureWebSocket();
globalThis.fetch = cookieFetch;

const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);
const gatewayModule = await imp(
  path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
);
const { ApprovalGateway, isCredentialRejection } = gatewayModule;
const { __resetRevocationCache, isApprovalRevoked } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceRevocation.ts'),
);
const { startFakeDsh } = await imp(path.join(__dirname, 'support', 'fake-dsh.mjs'));

/** 建带 cookie 语义的连接并预置登录态 */
async function seedCookie(srv) {
  AsyncStorageStub.__reset();
  ks().clear();
  __resetRevocationCache();
  const conn = new DshConnection({ baseUrl: srv.baseUrl, fetchImpl: cookieFetch });
  conn.setCookieReader(async () => {
    const cookies = cookieMod.getCookies(srv.baseUrl);
    const parts = Object.entries(cookies)
      .filter(([name]) => name.startsWith('dsh-auth'))
      .map(([name, value]) => `${name}=${value}`);
    return parts.length ? parts.join('; ') : undefined;
  });
  await conn.loginWithToken(srv.token);
  conn.close();
}

async function waitFor(fn, timeoutMs = 10000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function closeGateway(gw) {
  gw.disconnect();
  await new Promise((r) => setTimeout(r, 250));
  gw.disconnect();
}

/** 建一个已配对（有 token）的网关 */
async function connectedGateway(srv) {
  const statuses = [];
  const gw = new ApprovalGateway(srv.baseUrl, {
    onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
    onApproval: () => {},
    onResolved: () => {},
  });
  await gw.connect();
  const online = await waitFor(() => statuses.some((s) => s.startsWith('online')));
  return { gw, statuses, online };
}

// ══════════════════════════════════════════════════════════════
// 一、判据函数本身（纯函数，直接测）
// ══════════════════════════════════════════════════════════════

await check('判据：401/unauthorized 等明确鉴权拒绝算凭据失效', () => {
  const yes = [
    '401',
    'HTTP 401 Unauthorized',
    "Expected HTTP 101 response but was '401 Unauthorized'",
    'unauthorized',
    'invalid device credential',
    'missing or invalid device credential',
    'invalid or expired token',
    'invalid or expired pairing code',
  ];
  const missed = yes.filter((t) => !isCredentialRejection(t));
  return missed.length === 0 ? true : `这些没识别出来：${missed.join(' | ')}`;
});

await check('判据：403 **不**算凭据失效（真实网关的 403 与凭据无关）', () => {
  // 这一条是照着真实插件源码核对的（dsh-plugin-mobile-gateway 0.10.3
  // lib/index.mjs）：设备凭据无效只会 rejectUpgrade(401)；
  // 403 只用于 loopback 限制 / CSRF / 私网地址限制 —— 全都与凭据无关。
  //
  // 把 403 当凭据失效会造成真实误删：
  //   手机从公司网络接入 → 局域网监听回
  //   403 'LAN listener accepts private-network clients only'
  //   → 客户端以为 token 失效 → 删掉它 → 换回家里 Wi-Fi 时凭据已经没了。
  const no = [
    '403',
    '403 Forbidden',
    'forbidden',
    'forbidden by proxy',
    '403 blocked by firewall',
    'HTTP/1.1 403 Forbidden',
    'LAN listener accepts private-network clients only',
    'cross-origin management request rejected',
    'management API is loopback-only',
  ];
  const wrong = no.filter((t) => isCredentialRejection(t));
  return wrong.length === 0 ? true : `这些被误判成凭据失效：${wrong.join(' | ')}`;
});

await check('判据：网络类错误**不**算凭据被拒（这是误清 token 的根源）', () => {
  const no = [
    '',
    'Network request failed',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'timeout',
    'Connection refused',
    'Unable to resolve host',
    'WebSocket is closed before the connection is established',
    'device revoked',
    // 端口号 / 时间戳里的数字不能误判
    'connect ECONNREFUSED 127.0.0.1:4011',
    'failed at 14012',
  ];
  const wrong = no.filter((t) => isCredentialRejection(t));
  return wrong.length === 0 ? true : `这些被误判成凭据失效：${wrong.join(' | ')}`;
});

// ══════════════════════════════════════════════════════════════
// 二、网络中断 30 秒后恢复（核心场景）
// ══════════════════════════════════════════════════════════════

await check('网络中断 30 秒恢复：有效 Token 不被清，且自动重连', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const { gw, statuses, online } = await connectedGateway(srv);
    if (!online) {
      await closeGateway(gw);
      return `前置条件不成立：首次连接失败（${statuses.join(' | ')}）`;
    }
    const tokenBefore = gw.deviceToken;
    if (!tokenBefore) {
      await closeGateway(gw);
      return '连上了但没有 token，测试前提不成立';
    }

    // 断网：fetch 全失败 + 服务端踢掉连接
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('Network request failed');
    };
    srv.dropConnections();

    // 断网 30 秒 —— 期间会经历多次握手失败和退避重连
    await new Promise((r) => setTimeout(r, 30000));

    const tokenDuringOutage = gw.deviceToken;
    const failures = gw.failures;
    if (!tokenDuringOutage) {
      globalThis.fetch = realFetch;
      await closeGateway(gw);
      return '断网期间把有效 token 清掉了（这正是要修的 bug）';
    }
    if (failures < 2) {
      // 不断言具体次数，只确认「确实经历了多次失败」
      // —— 失败次数本来就不该影响任何决策
    }

    // 恢复网络
    globalThis.fetch = realFetch;
    const reconnected = await waitFor(
      () => statuses.filter((s) => s.startsWith('online')).length >= 2,
      60000,
      500,
    );
    const tokenAfter = gw.deviceToken;
    await closeGateway(gw);

    if (!reconnected) {
      return `网络恢复后没有自动重连（状态：${statuses.slice(-6).join(' | ')}）`;
    }
    return tokenAfter === tokenBefore
      ? true
      : '重连后 token 变了（有效 token 被误清后重新配对了）';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 三、Wi-Fi 切移动网络 / DSH 重启
// ══════════════════════════════════════════════════════════════

await check('切换网络（Wi-Fi → 移动网络）：token 保留且能重连', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const { gw, statuses, online } = await connectedGateway(srv);
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：首次连接失败';
    }
    const tokenBefore = gw.deviceToken;

    // 切网络的表现：旧连接直接断，新连接握手会有短暂失败
    srv.dropConnections();
    await new Promise((r) => setTimeout(r, 1500));

    const reconnected = await waitFor(
      () => statuses.filter((s) => s.startsWith('online')).length >= 2,
      30000,
      300,
    );
    const tokenAfter = gw.deviceToken;
    await closeGateway(gw);

    if (!reconnected) return `切换网络后没重连（${statuses.slice(-5).join(' | ')}）`;
    return tokenAfter === tokenBefore ? true : '切网络把 token 清了';
  } finally {
    await srv.close();
  }
});

await check('DSH 服务重启：token 保留，服务回来后自动重连', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const { gw, statuses, online } = await connectedGateway(srv);
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：首次连接失败';
    }
    const tokenBefore = gw.deviceToken;

    // 服务重启：连接全断，且接下来一段时间 HTTP 也不可达
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('Network request failed');
    };
    srv.dropConnections();

    await new Promise((r) => setTimeout(r, 5000));
    if (!gw.deviceToken) {
      globalThis.fetch = realFetch;
      await closeGateway(gw);
      return '服务重启期间把 token 清了（重启不是凭据失效）';
    }

    // 服务回来
    globalThis.fetch = realFetch;
    const reconnected = await waitFor(
      () => statuses.filter((s) => s.startsWith('online')).length >= 2,
      45000,
      500,
    );
    const tokenAfter = gw.deviceToken;
    await closeGateway(gw);

    if (!reconnected) return `服务恢复后没重连（${statuses.slice(-5).join(' | ')}）`;
    return tokenAfter === tokenBefore ? true : 'token 变了';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 四、HTTP 可用但 WebSocket 不可用
// ══════════════════════════════════════════════════════════════

await check('HTTP 可用但 WS 不可用：不清 token，退避重试而不刷请求', async () => {
  // 场景：HTTP（/mgw/pair、/mgw/devices）通，但 WebSocket 握手被拒 ——
  // 典型原因是代理/企业网关只放行 HTTP，或防火墙只放行了 DSH 的 web 端口。
  //
  // ⚠️ 这个用例必须**先正常配对成功**再关掉 WS：
  //   · pickUrl() 的兜底是硬编码 3081，若没有 endpoints，
  //     它会去连那台机器上的 3081 —— 而开发机上可能真的跑着 DSH，
  //     测出来就不是「WS 不可用」而是「连到了别的服务」。
  //   · 先配对成功，endpoints 就会指向本测试服务端，链路才可控。
  const sockets = new Set();
  let upgradeAttempts = 0;
  /** 关掉之后所有 upgrade 都返回 502 */
  let wsBlocked = false;
  let authority = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices: [] }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mgw/pair') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          payload: {
            pairingCode: 'code-abc',
            // 指向本服务端 —— 这样 pickUrl() 会挑这条，而不是兜底 3081
            endpoints: [`ws://${authority}/ws/mobile`],
            publicUrl: `ws://${authority}/ws/mobile`,
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  // 极简 WebSocket 握手：只做 101 + 发 paired 帧，够配对用
  server.on('upgrade', (req, socket) => {
    upgradeAttempts += 1;
    if (wsBlocked) {
      socket.write(
        'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        'Sec-WebSocket-Protocol: dsh-mobile-v1\r\n\r\n',
    );
    // 发一个 paired 帧（服务端不掩码）
    const payload = Buffer.from(
      JSON.stringify({ kind: 'paired', token: 'TOKEN_FROM_GOOD_HANDSHAKE' }),
      'utf8',
    );
    const header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length;
    socket.write(Buffer.concat([header, payload]));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  authority = `127.0.0.1:${server.address().port}`;
  const baseUrl = `http://${authority}`;

  AsyncStorageStub.__reset();
  ks().clear();
  __resetRevocationCache();

  const statuses = [];
  const gw = new ApprovalGateway(baseUrl, {
    onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
    onApproval: () => {},
    onResolved: () => {},
  });

  try {
    // ── 第一步：正常配对，拿到 token 和 endpoints ──────────────
    await gw.connect();
    const paired = await waitFor(() => statuses.some((s) => s.startsWith('online')), 8000);
    if (!paired) {
      return `前置条件不成立：首次配对没成功（${statuses.slice(-4).join(' | ')}）`;
    }
    const tokenBefore = gw.deviceToken;
    if (!tokenBefore) return '配对成功但没有 token，前提不成立';

    // ── 第二步：只关掉 WebSocket，HTTP 保持可用 ────────────────
    wsBlocked = true;
    upgradeAttempts = 0;
    // 让现有连接断开（模拟代理开始拒绝 Upgrade）
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }

    // 观察 12 秒：会经历多次握手失败 + 退避重试
    await new Promise((r) => setTimeout(r, 12000));

    if (!gw.deviceToken) {
      return `WS 不可用（HTTP 通）时把 token 清了 —— 这正是要修的 bug（${statuses.slice(-3).join(' | ')}）`;
    }
    if (ksToken() !== tokenBefore) {
      return 'Keystore 里的 token 被清了';
    }
    // 不能疯狂重试：12 秒内退避序列 1,2,4,8 秒 → 最多 5 次左右
    if (upgradeAttempts > 8) {
      return `重试过于频繁（12 秒内 ${upgradeAttempts} 次握手），会耗电和刷日志`;
    }
    if (upgradeAttempts < 2) {
      return `没有重试（只有 ${upgradeAttempts} 次握手），网络恢复后不会自己好`;
    }

    // ── 第三步：WS 恢复后应该自己连回来 ───────────────────────
    wsBlocked = false;
    const recovered = await waitFor(
      () => statuses.filter((s) => s.startsWith('online')).length >= 2,
      45000,
      500,
    );
    if (!recovered) {
      return `WS 恢复后没重连（${statuses.slice(-5).join(' | ')}）`;
    }
    return gw.deviceToken === tokenBefore ? true : '恢复后 token 变了';
  } finally {
    await closeGateway(gw);
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

// ══════════════════════════════════════════════════════════════
// 五、服务端明确拒绝失效 Token
// ══════════════════════════════════════════════════════════════

await check('服务端明确拒绝失效 token：会清 token 并重新配对', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    AsyncStorageStub.__reset();
    ks().clear();
    __resetRevocationCache();
    // 预置一个服务端不认识的 token
    ks().set(GW_TOKEN_SERVICE, { username: 'k', password: 'stale-token-abc123' });

    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    await gw.connect();
    // 让它走完「401 → 清 token → 重新配对 → 连上」
    const recovered = await waitFor(
      () => statuses.some((s) => s.startsWith('online')),
      25000,
      300,
    );
    await closeGateway(gw);

    if (!recovered) {
      return `失效 token 没有自愈（${statuses.slice(-6).join(' | ')}）`;
    }
    // 新 token 应该和旧的不同（说明真的重新配对了）
    return gw.deviceToken !== 'stale-token-abc123'
      ? true
      : 'token 没换，说明没重新配对';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 六、用户主动断开
// ══════════════════════════════════════════════════════════════

await check('用户主动断开：不重连、不清 token、不改变授权状态', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const { gw, statuses, online } = await connectedGateway(srv);
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：首次连接失败';
    }
    const tokenBefore = gw.deviceToken;

    gw.disconnect();
    const countAtDisconnect = statuses.length;
    await new Promise((r) => setTimeout(r, 5000));

    if (statuses.length !== countAtDisconnect) {
      await closeGateway(gw);
      return `主动断开后仍在重连（多了 ${statuses.length - countAtDisconnect} 次状态变化）`;
    }
    if (gw.deviceToken !== tokenBefore) {
      await closeGateway(gw);
      return '主动断开把 token 清了（下次进 App 又要重新配对）';
    }
    if (await isApprovalRevoked()) {
      await closeGateway(gw);
      return '主动断开被当成了撤销授权';
    }
    await closeGateway(gw);
    return true;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 七、撤销授权和自动重连同时发生（竞态）
// ══════════════════════════════════════════════════════════════

await check('撤销与重连竞态：撤销后旧连接的回调不得重新连上', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const { gw, statuses, online } = await connectedGateway(srv);
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：首次连接失败';
    }

    // 制造竞态：先让连接处于「刚要重连」的状态，再撤销
    srv.dropConnections();
    await new Promise((r) => setTimeout(r, 300));

    const pairsAtRevoke = srv.pairCalls;
    // 撤销（等价于 store.revokeOwnApprovalAuthorization）
    const { markApprovalRevoked } = await imp(
      path.join(__dirname, '..', 'src', 'core', 'deviceRevocation.ts'),
    );
    await markApprovalRevoked('self-revoked');
    gw.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    // 撤销后再来一次 connect（模拟 store/UI 重新挂载）
    await gw.connect();
    await new Promise((r) => setTimeout(r, 4000));
    await closeGateway(gw);

    if (srv.pairCalls > pairsAtRevoke) {
      return `撤销后仍申请了配对码（${pairsAtRevoke} → ${srv.pairCalls}）—— 竞态导致重新授权`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('旧连接迟到的 close 不影响新连接状态', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    // 连续快速 connect/disconnect —— 会产生多代连接，
    // 旧代的回调如果没做代次校验，会把新连接的状态踩掉
    for (let i = 0; i < 4; i += 1) {
      await gw.connect();
      await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 3000));

    const online = statuses.some((s) => s.startsWith('online'));
    const isOnlineNow = gw.online;
    await closeGateway(gw);

    if (!online) return `反复连接后没连上（${statuses.slice(-5).join(' | ')}）`;
    // 关键：最后一次状态不能是「被旧连接关掉」导致的 offline
    return isOnlineNow ? true : '新连接被旧连接的 close 回调踩掉了';
  } finally {
    await srv.close();
  }
});

await check('切前后台（重复 connect）不会建立多条连接', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const { gw, online } = await connectedGateway(srv);
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：首次连接失败';
    }

    const pairsBefore = srv.pairCalls;
    // App 切前后台会反复触发 connect —— 必须去重
    for (let i = 0; i < 6; i += 1) {
      await gw.connect();
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 800));

    const stillOnline = gw.online;
    const pairsAfter = srv.pairCalls;
    await closeGateway(gw);

    if (!stillOnline) return '重复 connect 把已有连接弄断了';
    return pairsAfter === pairsBefore
      ? true
      : `重复 connect 触发了 ${pairsAfter - pairsBefore} 次配对申请`;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 八、不允许无限申请配对码
// ══════════════════════════════════════════════════════════════

await check('拿不到配对码：有限次重试后停下，不无限打服务端', async () => {
  // 一个 HTTP 全 500 的服务端（模拟移动网关没装 / 没开）
  const sockets = new Set();
  let pairAttempts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').startsWith('/mgw/pair')) {
      pairAttempts += 1;
    }
    res.writeHead(500);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  AsyncStorageStub.__reset();
  ks().clear();
  __resetRevocationCache();

  const gw = new ApprovalGateway(baseUrl, {
    onStatus: () => {},
    onApproval: () => {},
    onResolved: () => {},
  });

  try {
    await gw.connect();
    // 30 秒足够走完「申请 → 失败 → 退避重试」好几轮
    await new Promise((r) => setTimeout(r, 30000));
    // 上限是 3 次（MAX_PAIRING_ATTEMPTS）
    if (pairAttempts > 3) {
      return `30 秒内申请了 ${pairAttempts} 次配对码（上限应为 3）—— 会刷爆服务端`;
    }
    if (pairAttempts === 0) return '一次都没申请（功能没生效）';
    return true;
  } finally {
    await closeGateway(gw);
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

// ══════════════════════════════════════════════════════════════
// 八、握手被拒的跨平台差异（真实缺陷的回归防线）
// ══════════════════════════════════════════════════════════════

/**
 * 这个用例守的是一个**真实发生过**的缺陷。
 *
 * ## 背景
 *
 * 「失效 token 自愈」依赖 `isCredentialRejection(lastErrorText)` 判断
 * 服务端是不是明确拒绝了我们的凭据。而 `lastErrorText` 只在 `onerror`
 * 里被赋值。
 *
 * ## 问题
 *
 * 握手失败（401）在两个平台上的事件模型**完全不同**：
 *
 *   · RN（Android okhttp / iOS）→ 触发 `error`，message 里带
 *     `Expected HTTP 101 response but was '401 Unauthorized'`
 *   · Node `ws` 库 → **既不触发 `error` 也不触发 `close`**，
 *     只发一个 `unexpected-response` 事件
 *
 * 我们的测试跑在 Node 上，所以只监听 onerror/onclose 时，401 路径
 * **永远不触发**：`lastErrorText` 恒为空 → 判定为「不是凭据问题」→
 * 保留失效 token → 反复重连 1006 → 最终超时。
 *
 * 表现为 `gateway-recovery-spec` 的「失效 token 自愈」偶发失败
 * （本地 5 次中 1 次、CI 上更明显）。修复方式是显式处理
 * `unexpected-response` 并主动 close，让 onclose 走正常分支。
 *
 * ## 断言
 *
 * 直接把「401 拒绝」这条链路单独跑一遍，并在**很短的超时**内要求
 * 出现「重新配对」的迹象（不是靠 25 秒的宽松等待碰运气）。
 */
await check('回归：握手 401 在 Node(ws) 下也能被识别为凭据拒绝', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    AsyncStorageStub.__reset();
    ks().clear();
    __resetRevocationCache();
    // 预置一个服务端不认识的 token
    ks().set(GW_TOKEN_SERVICE, { username: 'k', password: 'STALE-TOKEN-REGRESSION' });

    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    try {
      await gw.connect();
      // 关键：必须出现「配对凭据已失效，正在重新配对」这条状态，
      // 说明 401 被识别出来了（而不是被当成普通网络失败一直重试）。
      const recognised = await waitFor(
        () => statuses.some((s) => s.includes('凭据已失效')),
        12000,
        150,
      );
      if (!recognised) {
        return `握手 401 没有被识别为凭据拒绝（状态链：${statuses.slice(-8).join(' | ')}）`;
      }
      // 而且最终要靠重新配对连上
      const backOnline = await waitFor(
        () => statuses.some((s) => s.startsWith('online')),
        20000,
        200,
      );
      return backOnline ? true : `识别到失效但没能自愈（${statuses.slice(-6).join(' | ')}）`;
    } finally {
      await closeGateway(gw);
    }
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
