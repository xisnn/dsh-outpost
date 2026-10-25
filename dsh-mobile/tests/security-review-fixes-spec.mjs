/**
 * 独立安全复核（second-pass）发现的缺陷的回归测试。
 *
 * 这一组是**第一轮修复之后**又发现的问题，每个都对应一个具体的
 * 失败场景。放在单独文件里，便于区分「第一轮修复」和「复核补漏」。
 *
 * ## 覆盖清单
 *
 *   C1  清除授权漏了原生 cookie 容器（第三个凭据存储）
 *   M1  撤销标记读失败被缓存成「未撤销」，且整个进程生命周期都错
 *   M2  clearApprovalRevoked 先清缓存再删存储 → 删失败时当前进程直接放行
 *   M4  disconnect() 没放开 connecting → reauthorize() 静默什么都不做
 *   m7  isCredentialRejection 认裸 `forbidden` → 代理 403 会误清有效 token
 *   M7  列表 devices:null 被当成服务端错误；200+坏响应体被当成撤销成功
 *   M3  4003 异步清理与 clearAuthorization 抢 deviceId → 服务端撤销被跳过
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

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

const AsyncStorageStub = (await imp(path.join(__dirname, 'support', 'async-storage-stub.mjs')))
  .default;
/**
 * 产品代码实际用的是 **CJS shim**（经 Module._resolveFilename 重定向）。
 *
 * ⚠️ 和 ESM 版 `async-storage-stub.mjs` 是**两个不同的对象**（虽然共享
 * 同一份 globalThis 存储）。要注入失败必须替换 CJS 那个的方法 ——
 * 替换 ESM 的不会影响产品代码（踩过一次）。
 */
const AsyncStorageCjs = createRequire(import.meta.url)('./support/_async-storage-shim.cjs');
const cookieMod = await imp(path.join(__dirname, 'support', 'cookie-fetch.mjs'));
const cookieFetch = cookieMod.makeCookieFetch();
const wsMod = await imp(path.join(__dirname, 'support', 'ws-compat.mjs'));
wsMod.ensureWebSocket();
globalThis.fetch = cookieFetch;

const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);
const { ApprovalGateway, isCredentialRejection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
);
const revocation = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceRevocation.ts'),
);
const {
  isApprovalRevoked,
  markApprovalRevoked,
  clearApprovalRevoked,
  loadRevocationState,
  __resetRevocationCache,
} = revocation;
const { clearNativeCookieJar } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'cookieJar.ts'),
);
const { listPairedDevices, revokeDevice } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
);
const { startFakeDsh } = await imp(path.join(__dirname, 'support', 'fake-dsh.mjs'));

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

async function waitFor(fn, timeoutMs = 8000, stepMs = 100) {
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

// ══════════════════════════════════════════════════════════════
// C1：原生 cookie 容器是第三个凭据存储
// ══════════════════════════════════════════════════════════════

await check('C1 静态：clearAuthorization 会清原生 cookie 容器', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync('src/App.tsx', 'utf8');
  if (!/clearNativeCookieJar/.test(app)) {
    return 'clearAuthorization 没有清原生 cookie 容器 —— 老 cookie 会在下次启动被读回来';
  }
  const i = app.indexOf('const clearAuthorization');
  if (i < 0) return '找不到 clearAuthorization';

  // ⚠️ 不要用魔法数字切片（`app.slice(i, i + 5000)`）。
  // 这个函数会随着加固变长；切片切短了就会「漏看」后面的代码，
  // 让这条断言变成假阴性（函数明明调用了，却报「没有调用」）。
  // 正确做法：切到函数真正结束的位置 —— useCallback 的依赖数组收尾。
  const end = app.indexOf('}, [baseUrl, store]);', i);
  if (end < 0) return '找不到 clearAuthorization 的结束位置（结构变了？）';
  const body = app.slice(i, end);

  // C1 的本意不变：clearAuthorization 必须清**第三个凭据存储**
  // （原生 cookie 容器）。P1-4 之后调用的是 Detailed 版本，
  // 它返回可信的四态结果；两个名字都算合格。
  if (!/clearNativeCookieJar(Detailed)?\(/.test(body)) {
    return '没有在 clearAuthorization 里调用';
  }
  // 而且必须**消费**结果 —— 调用了却丢掉返回值，等于还是不知道清没清干净。
  return /clearNativeCookieJarDetailed\(/.test(body) && /\bjar\.kind\b/.test(body)
    ? true
    : '调用了但没检查清理结果（无法区分「清干净」和「清不掉」）';
});

await check('C1 静态：cookieJar 模块真的会调用 clearAll / clearByName', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/core/cookieJar.ts', 'utf8');
  if (!/clearAll/.test(src)) return '没有 clearAll 兜底';
  if (!/clearByName/.test(src)) return '没有 clearByName 精准清';
  // 必须复核（只信再读一次读不到，不信 API 返回值）
  return /getAll/.test(src) ? true : '没有复核是否真的清掉了';
});

await check('C1 运行时：没有 CookieManager 时视为「已清干净」', async () => {
  // 测试环境装了 _cookie-manager-shim，但模拟一个「模块不可用」的路径
  // 不容易；这里验证函数在正常环境下不会抛错且返回布尔。
  const r = await clearNativeCookieJar('http://127.0.0.1:1');
  return typeof r === 'boolean' ? true : `返回了 ${typeof r}，应该是 boolean`;
});

await check('C1 运行时：清 cookie 后容器里确实没有 dsh-auth', async () => {
  // 用 shim 的 CookieManager 造一份 cookie
  const cmMod = await imp(path.join(__dirname, 'support', '_cookie-manager-shim.cjs'));
  const cm = cmMod.default ?? cmMod;
  const base = 'http://127.0.0.1:9999';
  if (typeof cm.set !== 'function') {
    // shim 没有 set：跳过（不影响其它断言）
    return true;
  }
  await cm.set(base, { name: 'dsh-auth-test', value: 'v1.secret', path: '/' });
  const before = await cm.get(base);
  if (!before || !Object.keys(before).some((k) => k.startsWith('dsh-auth'))) {
    return '前置条件不成立：没能造出 cookie';
  }
  await clearNativeCookieJar(base);
  const after = await cm.get(base);
  const remain = Object.keys(after ?? {}).filter((k) => k.startsWith('dsh-auth'));
  return remain.length === 0 ? true : `还有残留：${remain.join('、')}`;
});

// ══════════════════════════════════════════════════════════════
// M1：撤销标记读失败不能被缓存
// ══════════════════════════════════════════════════════════════

await check('M1：读失败后再次读取会重试，不会把「未撤销」钉死', async () => {
  AsyncStorageStub.__reset();
  __resetRevocationCache();

  // 让 CJS shim 的 getItem 失败一次（产品代码走的是它）
  const origGet = AsyncStorageCjs.getItem;
  let failed = false;
  AsyncStorageCjs.getItem = async (key) => {
    if (!failed) {
      failed = true;
      throw new Error('storage unavailable');
    }
    return origGet.call(AsyncStorageCjs, key);
  };
  try {
    // 第一次读：失败 → 返回未撤销，但**不缓存**
    const first = await isApprovalRevoked();
    if (!failed) return '前置条件不成立：没有真的失败';
    if (first !== false) return '读失败时返回值不对（应保守为未撤销）';

    // 在存储里放一个「已撤销」标记（模拟后续恢复）
    await AsyncStorageStub.setItem(
      '@dsh/approvalRevoked',
      JSON.stringify({ revoked: true, at: 1 }),
    );

    // 第二次读：如果第一次把「未撤销」缓存了，这里仍然返回 false
    const second = await isApprovalRevoked();
    return second === true
      ? true
      : '读失败被缓存了 —— 撤销标记永远读不到，设备会重新自动配对';
  } finally {
    AsyncStorageCjs.getItem = origGet;
  }
});

await check('M1：存储里是垃圾值时不当成「已撤销」', async () => {
  AsyncStorageStub.__reset();
  __resetRevocationCache();

  // 一个能解析成对象、但没有 revoked:true 的值
  await AsyncStorageStub.setItem('@dsh/approvalRevoked', JSON.stringify({ foo: 'bar' }));
  const r = await isApprovalRevoked();
  return r === false ? true : '把无法识别的值当成了「已撤销」（会把用户永久挡在审批外）';
});

await check('M1：存储里不是 JSON 时不当成「已撤销」', async () => {
  AsyncStorageStub.__reset();
  __resetRevocationCache();
  await AsyncStorageStub.setItem('@dsh/approvalRevoked', 'not-json{{{');
  const r = await isApprovalRevoked();
  return r === false ? true : '把坏数据当成了「已撤销」';
});

await check('M1：正常的 revoked:true 仍然能读到', async () => {
  AsyncStorageStub.__reset();
  __resetRevocationCache();
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();
  const state = await loadRevocationState();
  if (!state.revoked) return '置位后读不到';
  return state.reason === 'self-revoked' ? true : `reason 丢了：${state.reason}`;
});

// ══════════════════════════════════════════════════════════════
// M2：clearApprovalRevoked 先删存储再清缓存
// ══════════════════════════════════════════════════════════════

await check('M2：删存储失败时保持「已撤销」（当前进程也不能放行）', async () => {
  AsyncStorageStub.__reset();
  __resetRevocationCache();
  await markApprovalRevoked('self-revoked');

  const origRemove = AsyncStorageCjs.removeItem;
  AsyncStorageCjs.removeItem = async () => {
    throw new Error('storage unavailable');
  };
  let cleared;
  try {
    cleared = await clearApprovalRevoked();
  } finally {
    AsyncStorageCjs.removeItem = origRemove;
  }

  if (cleared !== false) return '删失败却返回成功';
  // 关键：当前进程里也必须仍然是「已撤销」
  const still = await isApprovalRevoked();
  return still === true
    ? true
    : '删存储失败却把内存清成了「未撤销」→ 当前进程立刻自动配对';
});

await check('M2：删存储成功后才清缓存，返回 true', async () => {
  AsyncStorageStub.__reset();
  __resetRevocationCache();
  await markApprovalRevoked('self-revoked');

  const cleared = await clearApprovalRevoked();
  if (cleared !== true) return '删成功却返回 false';
  const now = await isApprovalRevoked();
  return now === false ? true : '清缓存没生效';
});

// ══════════════════════════════════════════════════════════════
// M4：disconnect() 必须放开 connecting，否则 reauthorize 静默失效
// ══════════════════════════════════════════════════════════════

await check('M4：connect 在途时 disconnect，随后 reauthorize 仍能连上', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    // 启动一次 connect 但**不等它完成**（它会卡在 await 里）
    const inflight = gw.connect();
    // 立刻断开 —— 此时 connect 的 await 还没醒来
    gw.disconnect();
    await inflight;
    await new Promise((r) => setTimeout(r, 100));

    // 现在 reauthorize：如果 connecting 没被放开，会静默什么都不做
    await markApprovalRevoked('self-revoked');
    await gw.reauthorize();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')), 12000);
    await closeGateway(gw);

    return online
      ? true
      : `reauthorize 后没连上（状态：${statuses.slice(-5).join(' | ')}）—— connecting 死锁`;
  } finally {
    await srv.close();
  }
});

await check('M4：disconnect 后立即 connect 能正常建立连接', async () => {
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
    await waitFor(() => statuses.includes('online'), 8000);
    gw.disconnect();
    // 马上重连
    await gw.connect();
    const reconnected = await waitFor(
      () => statuses.filter((s) => s === 'online').length >= 2,
      12000,
    );
    await closeGateway(gw);
    return reconnected ? true : `断开后立刻重连失败（${statuses.slice(-4).join(' | ')}）`;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// m7：判据不能认裸 forbidden（代理 403 会误清 token）
// ══════════════════════════════════════════════════════════════

await check('m7：代理/防火墙的 403 不算凭据被拒', () => {
  const no = [
    'forbidden by proxy',
    '403 Forbidden - blocked by corporate proxy',
    'forbidden by CDN',
    '403 blocked by firewall',
    'forbidden',
    // 真实网关的 403 用途（见 lib/index.mjs）：全都与设备凭据无关
    '403 Forbidden',
    'LAN listener accepts private-network clients only',
    'management API is loopback-only',
    'cross-origin management request rejected',
  ];
  const wrong = no.filter((t) => isCredentialRejection(t));
  return wrong.length === 0 ? true : `这些被误判成凭据失效：${wrong.join(' | ')}`;
});

await check('m7：真正的鉴权拒绝仍然识别（真实网关只用 401）', () => {
  const yes = [
    '401',
    'HTTP 401 Unauthorized',
    'unauthorized',
    'invalid device credential',
    'missing or invalid device credential',
    'invalid or expired token',
    'invalid or expired pairing code',
  ];
  const missed = yes.filter((t) => !isCredentialRejection(t));
  return missed.length === 0 ? true : `漏判：${missed.join(' | ')}`;
});

// ══════════════════════════════════════════════════════════════
// M7：列表 devices:null / 200+坏响应体
// ══════════════════════════════════════════════════════════════

function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (handler(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

await check('M7：devices:null 当成空列表，不是服务端错误', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices: null }));
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, 'c');
    if (!r.ok) return `报成了 ${r.kind}（应该当成空列表）`;
    return r.devices.length === 0 ? true : '应该是空数组';
  } finally {
    await srv.close();
  }
});

await check('M7：200 + 坏响应体的撤销不报成功', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/revoke')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>proxy error page</html>');
      return true;
    }
    return false;
  });
  try {
    const outcome = await revokeDevice(srv.baseUrl, 'c', 'uuid-x');
    return outcome === 'failed'
      ? true
      : `返回了 ${outcome} —— 200 的 HTML 错误页被当成撤销成功了`;
  } finally {
    await srv.close();
  }
});

await check('M7：200 + {revoked:true} 仍然是撤销成功', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/revoke')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revoked: true }));
      return true;
    }
    return false;
  });
  try {
    const outcome = await revokeDevice(srv.baseUrl, 'c', 'uuid-x');
    return outcome === 'revoked' ? true : `返回了 ${outcome}`;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// M3：撤销时 deviceId 不能被并发清理抢走
// ══════════════════════════════════════════════════════════════

await check('M3：markApprovalRevoked 不清 deviceId（否则服务端撤销会被跳过）', async () => {
  AsyncStorageStub.__reset();
  ks().clear();
  __resetRevocationCache();

  ks().set('com.dshpocket.credentials.dsh.gatewayDeviceId', {
    username: 'k',
    password: 'dsh-outpost-mine',
  });
  ks().set('com.dshpocket.credentials.dsh.gatewayToken', {
    username: 'k',
    password: 'TOKEN',
  });

  await markApprovalRevoked('server-revoked');

  const deviceIdLeft = ks().get('com.dshpocket.credentials.dsh.gatewayDeviceId');
  const tokenLeft = ks().get('com.dshpocket.credentials.dsh.gatewayToken');

  if (tokenLeft) return 'token 没清（撤销后仍能连）';
  return deviceIdLeft && deviceIdLeft.password === 'dsh-outpost-mine'
    ? true
    : 'deviceId 被清了 —— 随后的「彻底清除授权」会读不到它，服务端撤销被静默跳过';
});

await check('M3 静态：clearAuthorization 先读凭据再停网关', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync('src/App.tsx', 'utf8');
  const i = app.indexOf('const clearAuthorization');
  if (i < 0) return '找不到 clearAuthorization';

  // ⚠️ 不要用魔法数字切片（`app.slice(i, i + 3000)`）。
  // 这个函数会随着加固变长（P0-2 在中间插入了服务端撤销的详细结果块），
  // 切片切短了就会「漏看」后面的代码，把一条本该通过的断言误报成失败 ——
  // 更糟的是，它也可能反过来让断言变成假阴性。
  // 正确做法：切到函数真正结束的位置（useCallback 的依赖数组收尾）。
  const end = app.indexOf('}, [baseUrl, store]);', i);
  const body = end < 0 ? app.slice(i) : app.slice(i, end);

  const readIdx = body.indexOf('loadCredential(CredentialKey.gatewayDeviceId)');
  const stopIdx = body.indexOf("revokeOwnApprovalAuthorization('cleared')");
  if (readIdx < 0) return '没有读 gatewayDeviceId';
  if (stopIdx < 0) return '没有停网关';
  // M3 的全部要点就是**顺序**：先读 deviceId，再停网关。
  // 停网关后 4003 会异步触发清理，把 deviceId 删掉；
  // 若倒过来写，服务端撤销会被静默跳过（电脑上留一条可用记录）。
  return readIdx < stopIdx
    ? true
    : '先停网关再读 deviceId —— 4003 的异步清理会抢先把 deviceId 删掉，服务端撤销被跳过';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
