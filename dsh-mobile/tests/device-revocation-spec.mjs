/**
 * 设备撤销后不得自动重新授权的回归测试。
 *
 * ## 缺陷是什么
 *
 * 用户在这台手机上主动撤销自己的设备授权后，本地只是没了 gateway token。
 * 但 `ApprovalGateway.connect()` 的逻辑是「没有 token 就申请配对码」，
 * 而申请配对码用的是**仍然有效的会话 Cookie**。于是：
 *
 *   撤销 → 网关重连 → 自动申请配对码 → 配对成功 → 设备重新获得审批权
 *
 * 几秒之内「撤销」就被自己撤销掉了。用户看到的是「撤销了但没生效」。
 *
 * ## 怎么守
 *
 * 这里驱动**真实的 ApprovalGateway + 真实的模拟服务端**，覆盖：
 *
 *   · 主动撤销当前设备 → 不再自动配对（即使 Cookie 有效）
 *   · 撤销后 App 保持打开 → 反复重连也不恢复
 *   · 撤销后重启 App → 标记持久化，仍不恢复
 *   · 撤销其他设备 → 当前设备照常工作
 *   · 服务端撤销失败 → 本地仍然停止自动连接（可自救），且如实报失败
 *   · 撤销过程中网络中断
 *   · 用户手动重新授权 → 恢复
 *   · 服务端 4003 踢掉 → 同样进入未授权状态
 *
 * 服务端用 fake-dsh（复刻真实插件协议：配对码一次性、dsh-auth 重连、
 * 撤销后 4003 踢连接）。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

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

/** Keychain 替身状态（挂 globalThis，和产品代码共享） */
function ks() {
  if (!globalThis.__dshTestKeychainState__) {
    globalThis.__dshTestKeychainState__ = { store: new Map() };
  }
  return globalThis.__dshTestKeychainState__.store;
}
function ksReset() {
  ks().clear();
}
const GW_TOKEN_SERVICE = 'com.dshpocket.credentials.dsh.gatewayToken';
const GW_DEVICE_ID_SERVICE = 'com.dshpocket.credentials.dsh.gatewayDeviceId';
const GW_SERVER_DEVICE_ID_SERVICE =
  'com.dshpocket.credentials.dsh.gatewayServerDeviceId';
function ksHasToken() {
  return ks().has(GW_TOKEN_SERVICE);
}
/** 读一个 Keystore 值（没存返回 undefined） */
function ksGet(service) {
  const rec = ks().get(service);
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
const { ApprovalGateway } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
);
const revocation = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceRevocation.ts'),
);
const {
  isApprovalRevoked,
  markApprovalRevoked,
  clearApprovalRevoked,
  __resetRevocationCache,
} = revocation;
const { revokeOwnDevice, revokeDevice, listPairedDevices } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
);
const { startFakeDsh } = await imp(path.join(__dirname, 'support', 'fake-dsh.mjs'));

/** 建一个带 cookie 语义的 DshConnection */
function makeConn(srv) {
  const conn = new DshConnection({ baseUrl: srv.baseUrl, fetchImpl: cookieFetch });
  conn.setCookieReader(async () => {
    const cookies = cookieMod.getCookies(srv.baseUrl);
    const parts = Object.entries(cookies)
      .filter(([name]) => name.startsWith('dsh-auth'))
      .map(([name, value]) => `${name}=${value}`);
    return parts.length ? parts.join('; ') : undefined;
  });
  return conn;
}

/** 预置 cookie（模拟「已配对过、登录态有效」） */
async function seedCookie(srv) {
  AsyncStorageStub.__reset();
  ksReset();
  __resetRevocationCache();
  const conn = makeConn(srv);
  await conn.loginWithToken(srv.token);
  conn.close();
  return conn;
}

/** 等一个状态出现 */
async function waitFor(fn, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** 关掉网关并等它的定时器停下来 */
async function closeGateway(gw) {
  gw.disconnect();
  await new Promise((r) => setTimeout(r, 250));
  gw.disconnect();
}

// ══════════════════════════════════════════════════════════════
// 一、撤销状态本身
// ══════════════════════════════════════════════════════════════

await check('撤销状态：默认未撤销', async () => {
  AsyncStorageStub.__reset();
  ksReset();
  __resetRevocationCache();
  return (await isApprovalRevoked()) === false ? true : '默认就当成已撤销了';
});

await check('撤销状态：置位后持久化，重启后仍为已撤销', async () => {
  AsyncStorageStub.__reset();
  ksReset();
  __resetRevocationCache();

  await markApprovalRevoked('self-revoked');
  if (!(await isApprovalRevoked())) return '置位后读不到';

  // 模拟重启：清内存缓存，从存储重新读
  __resetRevocationCache();
  return (await isApprovalRevoked()) === true ? true : '重启后撤销标记丢了（会重新自动配对）';
});

await check('撤销状态：清掉后恢复未撤销', async () => {
  AsyncStorageStub.__reset();
  ksReset();
  __resetRevocationCache();
  await markApprovalRevoked('self-revoked');
  await clearApprovalRevoked();
  __resetRevocationCache();
  return (await isApprovalRevoked()) === false ? true : '清不掉';
});

await check('撤销状态：markApprovalRevoked 清掉本地设备凭据', async () => {
  AsyncStorageStub.__reset();
  ksReset();
  __resetRevocationCache();

  // 造一份设备凭据 + 一份历史明文
  ks().set(GW_TOKEN_SERVICE, { username: 'k', password: 'TOKEN_TO_CLEAR' });
  await AsyncStorageStub.setItem('@dsh/gatewayToken', 'PLAINTEXT_TOKEN');

  await markApprovalRevoked('self-revoked');

  if (ksHasToken()) return 'Keystore 里的 token 没清（撤销后仍能连）';
  const leftover = await AsyncStorageStub.getItem('@dsh/gatewayToken');
  return leftover === null ? true : '历史明文 token 没清';
});

await check('撤销状态：不动 Cookie（撤销的是审批权限，不是登录态）', async () => {
  AsyncStorageStub.__reset();
  ksReset();
  __resetRevocationCache();

  ks().set('com.dshpocket.credentials.dsh.cookie', {
    username: 'k',
    password: 'SESSION_COOKIE',
  });

  await markApprovalRevoked('self-revoked');

  const rec = ks().get('com.dshpocket.credentials.dsh.cookie');
  return rec && rec.password === 'SESSION_COOKIE'
    ? true
    : 'Cookie 被一起清掉了 —— 聊天功能会跟着失效';
});

// ══════════════════════════════════════════════════════════════
// 二、主动撤销当前设备后不得自动重新授权
// ══════════════════════════════════════════════════════════════

await check('撤销自己：撤销后网关不再申请配对码（核心 P0）', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    // 1. 先正常连上（走首次配对）
    await gw.connect();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')));
    if (!online) {
      await closeGateway(gw);
      return `前置条件不成立：首次连接没成功（${statuses.join(' | ')}）`;
    }
    const pairCallsBeforeRevoke = srv.pairCalls;

    // 2. 用户主动撤销：本地置撤销标记（服务端那半由 deviceAuth 做，
    //    这里验证「本地不再自动配对」这一半）
    await closeGateway(gw);
    await markApprovalRevoked('self-revoked');

    // 3. 重新 connect（等价于 App 重启后自动连、或网络恢复后自动重连）
    const gw2 = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw2.connect();
    await new Promise((r) => setTimeout(r, 1500));
    await closeGateway(gw2);

    const pairCallsAfter = srv.pairCalls;
    if (pairCallsAfter > pairCallsBeforeRevoke) {
      return `撤销后仍然申请了配对码（${pairCallsBeforeRevoke} → ${pairCallsAfter}）—— 设备会被重新授权`;
    }
    if (!statuses.includes('revoked:审批授权已撤销，需要重新授权')) {
      return `没有进入明确的「已撤销」状态（状态：${statuses.slice(-4).join(' | ')}）`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('撤销后 App 保持打开：反复重连也不恢复', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    await markApprovalRevoked('self-revoked');
    const pairsBefore = srv.pairCalls;

    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });

    // 模拟「App 一直开着，各种原因反复触发 connect」
    for (let i = 0; i < 5; i += 1) {
      await gw.connect();
      await new Promise((r) => setTimeout(r, 200));
    }
    await closeGateway(gw);

    return srv.pairCalls === pairsBefore
      ? true
      : `反复 connect 触发了 ${srv.pairCalls - pairsBefore} 次配对申请`;
  } finally {
    await srv.close();
  }
});

await check('撤销后重启 App：标记从存储读回，仍不自动配对', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    await markApprovalRevoked('self-revoked');
    // 模拟进程重启：清掉内存缓存，只留存储
    __resetRevocationCache();

    const pairsBefore = srv.pairCalls;
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 1200));
    await closeGateway(gw);

    return srv.pairCalls === pairsBefore
      ? true
      : `重启后又自动配对了 ${srv.pairCalls - pairsBefore} 次`;
  } finally {
    await srv.close();
  }
});

await check('撤销后 Cookie 仍有效：登录态不受影响，但不绕过撤销决定', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    await markApprovalRevoked('self-revoked');

    // Cookie 依然能用（聊天、看会话正常）。
    // 用 /mgw/devices 验证鉴权仍通 —— 它是 cookie 鉴权的，
    // 而且不依赖 store.ts（那条路径会拉进 react-native 的 Flow 代码）。
    const listed = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (!listed.ok && listed.kind === 'unauthorized') {
      return 'Cookie 失效了 —— 撤销审批不该影响登录态';
    }

    // 但审批不会自己连回来
    const pairsBefore = srv.pairCalls;
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 1000));
    await closeGateway(gw);

    return srv.pairCalls === pairsBefore
      ? true
      : 'Cookie 有效导致自动重新配对（撤销决定被绕过）';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 三、撤销其他设备不影响当前设备
// ══════════════════════════════════════════════════════════════

await check('撤销其他设备：当前设备照常连接，不被断开', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')));
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：没连上';
    }

    // 撤销「别的设备」—— 只走服务端，不碰本地状态
    await revokeDevice(srv.baseUrl, srv.cookie, 'some-other-device-uuid');
    await new Promise((r) => setTimeout(r, 800));

    const stillOnline = gw.online;
    const revoked = await isApprovalRevoked();
    await closeGateway(gw);

    if (!stillOnline) return '撤销其他设备时把当前连接也断了';
    return revoked === false ? true : '撤销其他设备却把本机标成了已撤销';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 四、服务端撤销失败
// ══════════════════════════════════════════════════════════════

await check('服务端撤销失败：如实返回 failed（不能提示成功）', async () => {
  // 用一个关掉的端口
  const outcome = await revokeOwnDevice('http://127.0.0.1:1', 'cookie', 'dsh-outpost-x');
  return outcome === 'failed' ? true : `结果不对：${outcome}`;
});

await check('服务端撤销失败但本地仍停止自动连接（用户能自救）', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const pairsBefore = srv.pairCalls;

    // 服务端撤销失败（网络不通）→ 本地依然置撤销标记
    const serverOutcome = await revokeOwnDevice('http://127.0.0.1:1', 'c', 'dev');
    if (serverOutcome !== 'failed') return '前置条件不成立：应该失败';
    await markApprovalRevoked('self-revoked');

    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((r) => setTimeout(r, 1000));
    await closeGateway(gw);

    return srv.pairCalls === pairsBefore
      ? true
      : '服务端撤销失败时本地仍在自动配对';
  } finally {
    await srv.close();
  }
});

await check('撤销过程中网络中断：不误报成功', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    // 让撤销请求本身失败
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('Network request failed');
    };
    let outcome;
    try {
      outcome = await revokeDevice(srv.baseUrl, 'c', 'uuid-x');
    } finally {
      globalThis.fetch = realFetch;
    }
    return outcome === 'failed' ? true : `网络中断时返回了 ${outcome}（会被当成成功）`;
  } finally {
    await srv.close();
  }
});

await check('撤销过程中列表请求失败：不把「读不到」当成「本来就没有」', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    // 让 /mgw/devices 失败（撤销自己需要先查列表）
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/mgw/devices') && !String(url).includes('revoke')) {
        throw new TypeError('Network request failed');
      }
      return realFetch(url, init);
    };
    let outcome;
    try {
      outcome = await revokeOwnDevice(srv.baseUrl, 'c', 'dsh-outpost-mine');
    } finally {
      globalThis.fetch = realFetch;
    }
    // ⚠️ 这里必须是 failed，不能是 already-gone。
    // already-gone 会被上层当成「撤销成功」，而服务端记录其实还在。
    return outcome === 'failed' ? true : `列表读不到时返回了 ${outcome}（误报成功）`;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 五、用户手动重新授权
// ══════════════════════════════════════════════════════════════

await check('手动重新授权：清标记后能重新配对连上', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    await markApprovalRevoked('self-revoked');
    if (!(await isApprovalRevoked())) return '前置条件不成立';

    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    const pairsBefore = srv.pairCalls;
    await gw.reauthorize();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')));
    await closeGateway(gw);

    if (!online) return `重新授权后没连上（${statuses.join(' | ')}）`;
    if (srv.pairCalls <= pairsBefore) return '重新授权没有申请配对码';
    return (await isApprovalRevoked()) === false ? true : '撤销标记没清掉';
  } finally {
    await srv.close();
  }
});

await check('connect(pairingCode) 视为明确授权：会清撤销标记', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    await markApprovalRevoked('self-revoked');
    const code = srv.makePairingCode();

    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: () => {},
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect(code);
    await new Promise((r) => setTimeout(r, 800));
    await closeGateway(gw);

    return (await isApprovalRevoked()) === false
      ? true
      : '用户扫码配对后撤销标记还在（下次又会被拦住）';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 六、服务端 4003 踢掉（设备被撤销的强信号）
// ══════════════════════════════════════════════════════════════

await check('服务端 4003：进入已撤销状态且不再自动重连', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')));
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：没连上';
    }

    const pairsBefore = srv.pairCalls;

    // 服务端主动用 4003 踢掉（真实插件 revoke 的行为）
    srv.closeGatewayWith(4003, 'device revoked');

    const sawRevoked = await waitFor(() => statuses.some((s) => s.startsWith('revoked')), 5000);
    // 再等一会，确认它没有自动重连（4003 不该触发 scheduleRetry）
    await new Promise((r) => setTimeout(r, 4000));
    const statusCount = statuses.length;
    await new Promise((r) => setTimeout(r, 2000));

    if (!sawRevoked) {
      await closeGateway(gw);
      return `没有进入 revoked 状态（${statuses.join(' | ')}）`;
    }
    if (statuses.length !== statusCount) {
      await closeGateway(gw);
      return `4003 之后仍在重连（状态还在增加：${statuses.slice(-3).join(' | ')}）`;
    }
    if (srv.pairCalls !== pairsBefore) {
      await closeGateway(gw);
      return '4003 之后又申请了配对码（自动重新授权）';
    }
    if (!(await isApprovalRevoked())) {
      await closeGateway(gw);
      return '4003 之后没有置撤销标记（重启后会重新配对）';
    }
    await closeGateway(gw);
    return true;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 七、服务端 device id（UUID）的采集与撤销
//
// 这一节覆盖本轮新发现的缺陷：服务端列表只返回 UUID，不返回
// clientDeviceId，所以「按客户端标识找自己」在真机上永远失败。
// 客户端必须从 paired / hello 帧里学到自己的 UUID。
// ══════════════════════════════════════════════════════════════

await check('服务端 UUID：连上后会把 paired 帧里的 device.id 存进 Keystore', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')));
    if (!online) {
      await closeGateway(gw);
      return '前置条件不成立：没连上';
    }
    // 等 paired 帧处理完（它和 onopen 是异步的）
    await new Promise((r) => setTimeout(r, 400));

    const clientId = ksGet(GW_DEVICE_ID_SERVICE);
    const serverId = ksGet(GW_SERVER_DEVICE_ID_SERVICE);
    await closeGateway(gw);

    if (!clientId) return '客户端标识没存（前置条件不成立）';
    if (!serverId) {
      return '没存服务端 UUID —— 之后「撤销这台手机」会找不到自己';
    }
    // 服务端 UUID 必须和客户端标识不同（这是两套 id）
    if (serverId === clientId) {
      return '服务端 UUID 和客户端标识相同 —— 说明存错了字段';
    }
    // 必须和服务端记录的一致
    const expected = srv.serverDeviceIds.get(clientId);
    if (!expected) return '模拟服务端没有记录这个设备（前置条件不成立）';
    return serverId === expected
      ? true
      : `存的服务端 UUID 不对：${serverId} ≠ ${expected}`;
  } finally {
    await srv.close();
  }
});

await check('服务端 UUID：用它撤销能真的删掉服务端记录', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await waitFor(() => statuses.some((s) => s.startsWith('online')));
    await new Promise((r) => setTimeout(r, 400));
    await closeGateway(gw);

    const clientId = ksGet(GW_DEVICE_ID_SERVICE);
    const serverId = ksGet(GW_SERVER_DEVICE_ID_SERVICE);
    if (!clientId || !serverId) return '前置条件不成立：没存下两个 id';

    const before = srv.gatewayDevices.size;
    const outcome = await revokeOwnDevice(srv.baseUrl, srv.cookie, clientId, serverId);
    const after = srv.gatewayDevices.size;

    if (outcome !== 'revoked') return `撤销返回 ${outcome}，期望 revoked`;
    if (after >= before) return `服务端记录没删掉（${before} → ${after}）`;
    // 撤的必须是服务端 UUID，不是客户端标识
    return srv.revokeCalls[0] === serverId
      ? true
      : `撤销请求用了错误的 id：${srv.revokeCalls[0]}（应为 ${serverId}）`;
  } finally {
    await srv.close();
  }
});

await check('服务端 UUID：列表里认不出自己时如实报 failed（不谎报成功）', async () => {
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await waitFor(() => statuses.some((s) => s.startsWith('online')));
    await new Promise((r) => setTimeout(r, 400));
    await closeGateway(gw);

    const clientId = ksGet(GW_DEVICE_ID_SERVICE);
    if (!clientId) return '前置条件不成立';

    // 不传 serverDeviceId（模拟老版本升级上来、还没重连过）
    const before = srv.gatewayDevices.size;
    const outcome = await revokeOwnDevice(srv.baseUrl, srv.cookie, clientId);
    const after = srv.gatewayDevices.size;

    if (after !== before) return `服务端记录被意外删除（${before} → ${after}）`;
    // 关键：记录还在，绝不能返回 already-gone / revoked
    return outcome === 'failed'
      ? true
      : `返回 ${outcome} —— 上层会提示「撤销成功」，而服务端记录还在`;
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
