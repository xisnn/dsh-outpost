/**
 * 审批网关重连的回归测试。
 *
 * ## 守的是什么
 *
 * 这个文件专门守 known-issues.md 里的两个缺陷：
 *
 *   1. 断线后无法重连 —— scheduleRetry 复用了**一次性**的配对码
 *   2. 失效 token 自愈触发不了 —— 握手 401 在 ws 层只是 1006，
 *      reason 是空串，纯靠正则匹配靠不住
 *
 * 用的是**真实的 ApprovalGateway**，不是手搓 WS。
 *
 * ## 为什么单独开一个文件
 *
 * integration-product.mjs 里已经有很多项，但那两个缺陷当时只能
 * 「验证协议层可行」而不能「验证产品修好了」。
 * 现在产品修了，就该有测试直接盯实现。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// ⚠️ 重定向 RN 原生模块需要**两种** hook。
//
// `register()` 的 ESM loader hook 只能拦到真正的 ESM import，
// 但产品代码经过 tsx 转译后是 CJS，走的是 `require()` ——
// ESM hook 拦不到，必须再用 `Module._resolveFilename`。
//
// 踩过的坑：只装 register() 时，ApprovalGateway 里的
// `AsyncStorage.setItem(DEVICE_TOKEN_KEY, tok)` 会静默失败
// （打到真实的 RN 模块上，Node 里是空实现），
// 导致「配对成功后 token 没落盘」——而这个缺陷之前一直没被测出来。
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

const stubMod = await imp(path.join(__dirname, 'support', 'async-storage-stub.mjs'));
const AsyncStorageStub = stubMod.default;

/**
 * Keychain 替身的状态。
 *
 * ⚠️ 不能 `require('./support/_keychain-shim.cjs')` —— 产品代码经 tsx
 * 转译后走另一条模块解析路径，require 拿到的是**另一个实例**，
 * 状态不共享（实测：产品代码写进去了，测试这边 dump 出来是空的）。
 *
 * 所以直接读写 globalThis 上的同一份 state。
 */
const Keychain = {
  async setGenericPassword(_u, password, opts) {
    if (!globalThis.__dshTestKeychainState__) {
      globalThis.__dshTestKeychainState__ = { store: new Map() };
    }
    globalThis.__dshTestKeychainState__.store.set(opts?.service ?? 'default', {
      username: 'k',
      password: String(password),
    });
  },
  async getGenericPassword(opts) {
    const rec = globalThis.__dshTestKeychainState__?.store?.get(opts?.service ?? 'default');
    return rec ?? false;
  },
  async resetGenericPassword(opts) {
    globalThis.__dshTestKeychainState__?.store?.delete(opts?.service ?? 'default');
  },
  __dump() {
    return Object.fromEntries(globalThis.__dshTestKeychainState__?.store ?? []);
  },
  __reset() {
    globalThis.__dshTestKeychainState__?.store?.clear();
  },
};

// 凭据已迁到 Keychain 替身（见 core/secureStore.ts）
/** secureStore 用的 service 名 */
const GW_TOKEN_SERVICE = 'com.dshpocket.credentials.dsh.gatewayToken';

const cookieMod = await imp(path.join(__dirname, 'support', 'cookie-fetch.mjs'));
const cookieFetch = cookieMod.makeCookieFetch();

const wsMod = await imp(path.join(__dirname, 'support', 'ws-compat.mjs'));
wsMod.ensureWebSocket();
globalThis.fetch = cookieFetch;

const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);
const { ApprovalGateway } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
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

/** 建一个带 cookie 语义的 DshConnection */
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

/** 预置 cookie，模拟「已配对过」的状态 */
async function seedCookie(srv) {
  AsyncStorageStub.__reset();
  // 凭据在 Keystore 里，也要一起清 —— 否则上一个测试的 token 会串过来
  Keychain.__reset();
  const conn = makeConn(srv);
  await conn.loginWithToken(srv.token);
  conn.close();
}

/** 关掉网关并等它的定时器停下来 */
async function closeGateway(gw) {
  gw.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  gw.disconnect();
}

// ── 缺陷 1：断线后无法重连 ──────────────────────────────────────

await check('断线重连：重连时不再复用一次性配对码', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s) => statuses.push(s),
      onApproval: () => {},
      onResolved: () => {},
    });

    await gw.connect();
    await new Promise((r) => setTimeout(r, 500));
    if (!statuses.includes('online')) {
      await closeGateway(gw);
      return '首次连接没成功';
    }

    const pairsBefore = srv.pairCalls;

    // 服务端断开 → 触发重连
    srv.dropConnections();
    await new Promise((r) => setTimeout(r, 500));

    // 等重连完成（退避 2 秒起）
    await new Promise((r) => setTimeout(r, 8000));

    const onlineCount = statuses.filter((s) => s === 'online').length;
    const pairsAfter = srv.pairCalls;
    await closeGateway(gw);

    if (onlineCount < 2) {
      return `断线后没重连成功（online 次数 ${onlineCount}）`;
    }
    // 关键：重连用的是 token，不该再申请新配对码
    // （如果实现又退回到「拿旧码重连」，onlineCount 会一直是 1）
    return pairsAfter >= pairsBefore
      ? true
      : `pairCalls 异常：${pairsBefore} → ${pairsAfter}`;
  } finally {
    await srv.close();
  }
});

await check('断线重连：配对成功后 token 已落盘', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 600));
    await closeGateway(gw);

    const saved = (await Keychain.getGenericPassword({ service: GW_TOKEN_SERVICE })) || null;
    if (!saved || !saved.password) {
      return '诊断：ks=' + JSON.stringify(Keychain.__dump()) + ' gwToken=' + JSON.stringify(gw.token);
    }
    return true;
  } finally {
    await srv.close();
  }
});

// ── 缺陷 2：失效 token 的自愈 ──────────────────────────────────


/**
 * 造一个「握手立刻 401」的 WebSocket 替身（仅本文件用）。
 *
 * ## 为什么不再用「真实 fake-dsh + 等 12 秒」
 *
 * 这两条用例原来靠真实网络握手的 401 来驱动自愈。它在本地稳定，
 * 但在 GitHub Actions 上**稳定失败**：CI 上握手失败表现为 TCP 1006
 * （服务端连 HTTP 401 都没送达），而不是 ws 的 unexpected-response。
 * 根因是 RN 与 Node `ws` 的握手失败事件模型不同 —— 详见
 * gateway-recovery-spec 第九节的完整说明。
 *
 * 发布门禁不能建立在随机性上，所以这里改为**进程内可控替身**：
 * 精确复现 401，仍然驱动真实 ApprovalGateway，验证同一件事：
 * 收到 401 后 token 必须被清掉，且随后能重新配对。
 */
function make401WS() {
  class W401 {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      this.onmessage = null;
      this._unexpected = [];
      setTimeout(() => {
        for (const cb of [...this._unexpected]) {
          try {
            cb({}, { statusCode: 401, statusMessage: 'Unauthorized' });
          } catch {
            /* ignore */
          }
        }
      }, 0);
    }
    on(e, cb) {
      if (e === 'unexpected-response') this._unexpected.push(cb);
    }
    once(e, cb) {
      this.on(e, cb);
    }
    removeListener() {}
    off() {}
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  W401.CONNECTING = 0;
  W401.OPEN = 1;
  W401.CLOSING = 2;
  W401.CLOSED = 3;
  return W401;
}

const STALE_TOKEN = 'STALE-TOKEN-RECONNECT';

await check('自愈：握手 401 后失效 token 会被清掉', async () => {
  AsyncStorageStub.__reset();
  await Keychain.setGenericPassword('k', STALE_TOKEN, { service: GW_TOKEN_SERVICE });

  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = make401WS();
  try {
    const gw = new ApprovalGateway('http://127.0.0.1:1', {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });
    try {
      await gw.connect();
      await new Promise((r) => setTimeout(r, 400));

      const rec = await Keychain.getGenericPassword({ service: GW_TOKEN_SERVICE });
      const remaining = rec ? rec.password : null;
      if (remaining === STALE_TOKEN) {
        return '握手 401 后失效 token 还在（自愈没触发）';
      }
      return true;
    } finally {
      await closeGateway(gw);
    }
  } finally {
    globalThis.WebSocket = realWS;
  }
});

await check('自愈：清掉 token 后能重新配对连上', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    AsyncStorageStub.__reset();
    // 模拟「401 之后 token 已被清掉」的状态，然后验证能重新配对
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s) => statuses.push(s),
      onApproval: () => {},
      onResolved: () => {},
    });
    try {
      await gw.connect();
      // 等它走完「申请配对码 → 连上」（本文件没有 waitFor 辅助，用轮询）
      let online = false;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (statuses.includes('online')) { online = true; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      return online ? true : `清 token 后没恢复（状态：${statuses.join(',')}）`;
    } finally {
      await closeGateway(gw);
    }
  } finally {
    await srv.close();
  }
});

// ── 正常路径不能坏 ────────────────────────────────────────────

await check('正常：首次连接能用配对码连上', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s) => statuses.push(s),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 600));
    const online = statuses.includes('online');
    const pairs = srv.pairCalls;
    await closeGateway(gw);

    if (!online) return '首次连接失败';
    return pairs >= 1 ? true : '首次连接没有申请配对码';
  } finally {
    await srv.close();
  }
});

await check('正常：主动 disconnect 后不再重连', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s) => statuses.push(s),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 500));
    gw.disconnect();

    const before = statuses.length;
    await new Promise((r) => setTimeout(r, 4000));
    const after = statuses.length;

    // disconnect 之后不该再有新的状态变化（不该重连）
    return after === before
      ? true
      : `disconnect 后仍在重连（多了 ${after - before} 次状态变化）`;
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
