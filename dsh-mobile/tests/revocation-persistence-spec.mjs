/**
 * P0-1：撤销标记**持久化失败**的降级与如实上报。
 *
 * ## 要守的那个 fail-open
 *
 * 撤销标记是「用户在这台手机上撤销了审批授权」在**本地**的唯一证据。
 * 服务端撤销失败时（serverOk=false），它是**唯一**屏障 —— 没有 4003
 * 会来兜底，因为服务端根本没删掉那条记录。
 *
 * 而「写存储」这件事本身会失败：磁盘满、SQLite 被锁、Keychain 因为
 * 用户改了锁屏方式导致密钥失效、进程被杀在写入中途……
 *
 * 旧实现的写法是：
 *
 *   try { await AsyncStorage.setItem(...) } catch { /* 忽略 *\/ }
 *
 * 后果链很具体：
 *
 *   用户点撤销 → 标记没写进去（静默吞掉）→ 界面提示「已撤销」
 *   → 用户以为安全了 → 重启 App → 读不到标记 → not-revoked
 *   → 自动申请配对码 → 设备**重新获得**审批权限
 *   而服务端那条记录还在（撤销本就失败了）→ 全程无人拦
 *
 * ## 现在的契约
 *
 * 1. **双通道**：主 AsyncStorage，降级 Keystore（`revocationMarker`）
 * 2. **写后回读校验**：写调用没抛错**不算**成功，必须读回来内容一致
 * 3. **如实上报**：`markApprovalRevoked()` 返回
 *    `{ok, persisted, memoryOnly, error?}`，UI 能区分
 *      · 「已撤销（已保存）」
 *      · 「已撤销（本次运行有效，重启后可能失效）」  ← 必须警告
 *      · 「无法确认撤销状态」
 * 4. **内存态兜底**：即使两个存储都写失败，本次运行仍是 `revoked`，
 *    绝不因为「没存上」就放行自动配对
 * 5. **读取 fail-closed**：只有**两个通道都读成功且都确认没有**才
 *    返回 `not-revoked`；其余一律 `unknown`
 *
 * 全部用例都驱动**真实产品代码**（deviceRevocation.ts / secureStore.ts /
 * approvalGateway.ts），用项目既有的 shim 注入存储故障。
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

// ── 存储替身（和产品代码共享同一份 globalThis 状态）──────────

const AsyncStorageStub = (await imp(path.join(SHIM_DIR, 'async-storage-stub.mjs'))).default;
/**
 * 产品代码走的是 **CJS shim**（经 Module._resolveFilename 重定向）。
 * 要注入失败必须替换 CJS 那份的方法 —— 替换 ESM 的不生效。
 */
const AsyncStorageCjs = createRequire(import.meta.url)('./support/_async-storage-shim.cjs');

const KEYCHAIN_STATE = '__dshTestKeychainState__';
function ks() {
  if (!globalThis[KEYCHAIN_STATE]) {
    globalThis[KEYCHAIN_STATE] = { store: new Map() };
  }
  return globalThis[KEYCHAIN_STATE].store;
}
const _keychainShim = await imp(path.join(SHIM_DIR, '_keychain-shim.cjs'));
const keychainApi = _keychainShim.default ?? _keychainShim;

const KS_COOKIE = 'com.dshpocket.credentials.dsh.cookie';
const KS_GW_TOKEN = 'com.dshpocket.credentials.dsh.gatewayToken';
const KS_GW_DEVICE_ID = 'com.dshpocket.credentials.dsh.gatewayDeviceId';
const KS_REVOCATION_MARKER = 'com.dshpocket.credentials.dsh.revocationMarker';

const REVOKED_KEY = '@dsh/approvalRevoked';

// ── 产品代码 ─────────────────────────────────────────────────

const cookieMod = await imp(path.join(SHIM_DIR, 'cookie-fetch.mjs'));
const cookieFetch = cookieMod.makeCookieFetch();
const wsMod = await imp(path.join(SHIM_DIR, 'ws-compat.mjs'));
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
  loadRevocationState,
  getApprovalRevocationStatus,
  isApprovalRevoked,
  markApprovalRevoked,
  clearApprovalRevoked,
  __resetRevocationCache,
} = revocation;
const { clearAllCredentials } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'secureStore.ts'),
);
const { startFakeDsh } = await imp(path.join(SHIM_DIR, 'fake-dsh.mjs'));

// ── 故障注入工具 ─────────────────────────────────────────────

/**
 * 收集「还原函数」，每个用例结束时统一还原。
 *
 * 每个用例都 try/finally 还原，避免一次故障泄漏到后续用例
 * （这个坑项目里踩过：一个测试留下的坏状态让后面几十个用例连带失败）。
 */
function makeFaultScope() {
  const restores = [];
  return {
    restore() {
      while (restores.length) {
        const fn = restores.pop();
        try {
          fn();
        } catch {
          /* 还原失败也只能继续 */
        }
      }
    },
    /** 让 AsyncStorage 的某个方法抛错 */
    breakAsyncStorage(method) {
      const orig = AsyncStorageCjs[method];
      AsyncStorageCjs[method] = async () => {
        throw new Error(`storage unavailable: ${method}`);
      };
      restores.push(() => {
        AsyncStorageCjs[method] = orig;
      });
    },
    /** AsyncStorage 写入「成功」但内容被篡改（回读不一致） */
    corruptAsyncStorageWrites(replacement) {
      const orig = AsyncStorageCjs.setItem;
      AsyncStorageCjs.setItem = async (key, _value) => {
        return orig.call(AsyncStorageCjs, key, replacement);
      };
      restores.push(() => {
        AsyncStorageCjs.setItem = orig;
      });
    },
    /** 让 Keychain 的某个方法抛错 */
    breakKeychain(method) {
      const orig = keychainApi[method];
      keychainApi[method] = async () => {
        throw new Error(`keystore unavailable: ${method}`);
      };
      restores.push(() => {
        keychainApi[method] = orig;
      });
    },
    /** Keychain 写入「成功」但内容被篡改（回读不一致） */
    corruptKeychainWrites(replacement) {
      const orig = keychainApi.setGenericPassword;
      keychainApi.setGenericPassword = async (username, _password, options) => {
        return orig.call(keychainApi, username, replacement, options);
      };
      restores.push(() => {
        keychainApi.setGenericPassword = orig;
      });
    },
  };
}

/** 全量重置：两个存储 + 内存缓存 */
function resetAll() {
  AsyncStorageStub.__reset();
  ks().clear();
  __resetRevocationCache();
}

/** 读 Keystore 里某个 service 的原始值 */
function ksGet(service) {
  const rec = ks().get(service);
  return rec ? rec.password : undefined;
}

/** 解析 AsyncStorage 里的标记 */
async function readStoredMarker() {
  const raw = await AsyncStorageStub.getItem(REVOKED_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable: raw };
  }
}

/** 给服务端准备一个有效 cookie（模拟「已登录、Cookie 仍有效」） */
async function seedCookie(srv) {
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

async function waitFor(fn, timeoutMs = 6000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function closeGateway(gw) {
  gw.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  gw.disconnect();
}

// ══════════════════════════════════════════════════════════════
// 一、正常路径：写 + 回读校验
// ══════════════════════════════════════════════════════════════

await check('正常：标记写进 AsyncStorage 并回读校验通过，ok=true', async () => {
  resetAll();
  const r = await markApprovalRevoked('self-revoked');

  if (r.ok !== true) return `ok 应为 true，实际 ${r.ok}（error=${r.error}）`;
  if (r.persisted !== 'async-storage') {
    return `persisted 应为 async-storage，实际 ${r.persisted}`;
  }
  if (r.memoryOnly !== false) return 'memoryOnly 应为 false（已经落盘了）';
  if (r.error !== undefined) return `成功时不该有 error，实际 ${r.error}`;

  const marker = await readStoredMarker();
  if (!marker) return 'AsyncStorage 里没有标记';
  if (marker.revoked !== true) return '标记里没有 revoked:true';
  if (marker.v !== 2) return `标记版本应为 2，实际 ${marker.v}`;
  if (typeof marker.at !== 'number') return '标记里没有时间戳';
  return marker.reason === 'self-revoked' ? true : `reason 不对：${marker.reason}`;
});

await check('正常：标记结构是 {v:2, revoked:true, at, reason}', async () => {
  resetAll();
  const before = Date.now();
  await markApprovalRevoked('cleared');
  const after = Date.now();
  const marker = await readStoredMarker();
  if (!marker) return '没有标记';
  const keys = Object.keys(marker).sort().join(',');
  if (keys !== 'at,reason,revoked,v') return `字段集合不对：${keys}`;
  if (marker.at < before || marker.at > after) return '时间戳不在合理区间';
  return marker.reason === 'cleared' ? true : `reason 不对：${marker.reason}`;
});

await check('正常：重启后（丢缓存）仍读到 revoked', async () => {
  resetAll();
  const r = await markApprovalRevoked('self-revoked');
  if (!r.ok) return '前置条件不成立：没写成功';

  __resetRevocationCache(); // 模拟进程重启
  const s = await loadRevocationState();
  if (s.status !== 'revoked') return `重启后应为 revoked，实际 ${s.status}`;
  return s.reason === 'self-revoked' ? true : `reason 丢了：${s.reason}`;
});

// ══════════════════════════════════════════════════════════════
// 二、AsyncStorage 写失败 → 降级到 Keystore
// ══════════════════════════════════════════════════════════════

await check('降级：AsyncStorage.setItem 抛错 → 写进 Keystore，ok=true', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }

  if (r.ok !== true) return `ok 应为 true（Keystore 已存下），实际 false：${r.error}`;
  if (r.persisted !== 'secure-store') {
    return `persisted 应为 secure-store，实际 ${r.persisted}`;
  }
  if (r.memoryOnly !== false) return 'memoryOnly 应为 false（Keystore 是持久化存储）';

  const inKeychain = ksGet(KS_REVOCATION_MARKER);
  if (!inKeychain) return 'Keystore 里没有降级标记';
  const parsed = JSON.parse(inKeychain);
  if (parsed.revoked !== true) return '降级标记内容不对';
  if (parsed.v !== 2) return `降级标记版本应为 2，实际 ${parsed.v}`;
  return parsed.reason === 'self-revoked' ? true : '降级标记里 reason 不对';
});

await check('降级：重启后从 Keystore 读回标记（跨重启仍然拦得住）', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  try {
    const r = await markApprovalRevoked('self-revoked');
    if (!r.ok) return `前置条件不成立：降级也没成功（${r.error}）`;
  } finally {
    faults.restore();
  }

  // 重启：AsyncStorage 里确实没有标记，只有 Keystore 有
  if ((await AsyncStorageStub.getItem(REVOKED_KEY)) !== null) {
    return '前置条件不成立：AsyncStorage 里竟然有标记';
  }
  __resetRevocationCache();

  const s = await loadRevocationState();
  return s.status === 'revoked'
    ? true
    : `重启后读到 ${s.status} —— 降级标记没被读过（会重新自动配对）`;
});

await check('降级：AsyncStorage 回读不一致 → 视为写失败，改走 Keystore', async () => {
  resetAll();
  const faults = makeFaultScope();
  // 写入「成功」但存进去的是别的内容（模拟静默损坏）
  faults.corruptAsyncStorageWrites(JSON.stringify({ revoked: false }));
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }

  if (r.ok !== true) return `ok 应为 true（Keystore 接住了），实际 false`;
  if (r.persisted !== 'secure-store') {
    return `回读不一致时应判主通道失败、走降级；实际 persisted=${r.persisted}`;
  }
  return ksGet(KS_REVOCATION_MARKER) ? true : 'Keystore 里没有标记';
});

await check('降级：两个通道都回读不一致 → ok=false，不谎报成功', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.corruptAsyncStorageWrites(JSON.stringify({ revoked: false }));
  faults.corruptKeychainWrites(JSON.stringify({ revoked: false }));
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }

  if (r.ok !== false) return '回读都不一致却报成功（正是要修的 fail-open）';
  if (r.persisted !== 'none') return `persisted 应为 none，实际 ${r.persisted}`;
  if (r.memoryOnly !== true) return 'memoryOnly 应为 true';
  return r.error ? true : '失败时没有给出 error 说明';
});

// ══════════════════════════════════════════════════════════════
// 三、两个存储都坏 → ok:false，但本次运行仍然拒绝自动配对
// ══════════════════════════════════════════════════════════════

await check('全坏：两个存储都写不进 → ok=false / persisted=none', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  faults.breakKeychain('setGenericPassword');
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }

  if (r.ok !== false) return '两个存储都失败却报 ok=true';
  if (r.persisted !== 'none') return `persisted 应为 none，实际 ${r.persisted}`;
  if (r.memoryOnly !== true) return 'memoryOnly 应为 true（只有内存生效）';
  return r.error ? true : '没有给出失败原因（UI 无法警告用户）';
});

await check('全坏：即使持久化失败，本次运行仍不自动配对（内存态兜底）', async () => {
  const srv = await startFakeDsh();
  try {
    resetAll();
    await seedCookie(srv);

    const faults = makeFaultScope();
    faults.breakAsyncStorage('setItem');
    faults.breakKeychain('setGenericPassword');
    let r;
    try {
      r = await markApprovalRevoked('self-revoked');
    } finally {
      faults.restore();
    }
    if (r.ok !== false) return '前置条件不成立：本该写失败';

    // 关键：内存态必须还是 revoked —— 不能因为「没存上」就放行
    if ((await isApprovalRevoked()) !== true) {
      return '持久化失败后内存态变成「未撤销」→ 当前进程会立刻自动配对';
    }

    const pairsBefore = srv.pairCalls;
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });
    await gw.connect();
    await new Promise((res) => setTimeout(res, 1200));
    await closeGateway(gw);

    if (srv.pairCalls > pairsBefore) {
      return `持久化失败后仍然申请了配对码（${pairsBefore} → ${srv.pairCalls}）`;
    }
    return statuses.includes('revoked:审批授权已撤销，需要重新授权')
      ? true
      : `没进入 revoked 状态（${statuses.slice(-3).join(' | ')}）`;
  } finally {
    await srv.close();
  }
});

await check('全坏：持久化失败仍然清掉 gateway token（少一份可用凭据）', async () => {
  resetAll();
  ks().set(KS_GW_TOKEN, { username: 'k', password: 'TOKEN_MUST_DIE' });

  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  faults.breakKeychain('setGenericPassword');
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }

  if (r.ok !== false) return '前置条件不成立：本该写失败';
  if (ks().has(KS_GW_TOKEN)) {
    return '标记没存上，token 也没清 —— 用户撤销后凭据仍然可用';
  }
  return true;
});

await check('全坏：不谎报成功后，重启（丢缓存）读到 not-revoked —— 已知边界', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  faults.breakKeychain('setGenericPassword');
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }
  if (r.ok !== false) return '前置条件不成立：本该写失败';

  // 这条断言是为了把「保证的上限」钉住：两个存储都写失败时，
  // 跨重启的拦截**无法保证**。正因为如此，markApprovalRevoked 才必须
  // 返回 ok:false 让 UI 警告用户 —— 否则就是静默失效。
  __resetRevocationCache();
  const s = await loadRevocationState();
  if (s.status === 'revoked') {
    return '重启后居然还是 revoked（说明有两个通道都没坏）—— 前置条件不成立';
  }
  // ok:false 是用户被警告的唯一凭据，必须存在
  return r.error ? true : '没有 error 字段 —— 界面无法解释「重启后可能失效」';
});

// ══════════════════════════════════════════════════════════════
// 四、读取侧的 fail-closed（双通道）
// ══════════════════════════════════════════════════════════════

await check('读：AsyncStorage 读失败但 Keystore 有标记 → revoked', async () => {
  resetAll();
  // 直接往 Keystore 放一个标记（模拟上次主通道写失败降级过来的）
  ks().set(KS_REVOCATION_MARKER, {
    username: 'k',
    password: JSON.stringify({
      v: 2,
      revoked: true,
      at: 1700000000000,
      reason: 'self-revoked',
    }),
  });

  const faults = makeFaultScope();
  faults.breakAsyncStorage('getItem');
  let s;
  try {
    s = await loadRevocationState();
  } finally {
    faults.restore();
  }
  return s.status === 'revoked'
    ? true
    : `读到 ${s.status} —— 降级通道里的标记被忽略了`;
});

await check('读：AsyncStorage 读失败且 Keystore 无标记 → unknown（不是 not-revoked）', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.breakAsyncStorage('getItem');
  let s;
  try {
    s = await loadRevocationState();
  } finally {
    faults.restore();
  }
  return s.status === 'unknown'
    ? true
    : `读到 ${s.status} —— 「读不到」被当成了「没撤销」（fail-open）`;
});

await check('读：AsyncStorage 坏数据 + Keystore 无标记 → unknown', async () => {
  resetAll();
  await AsyncStorageStub.setItem(REVOKED_KEY, 'not-json{{{');
  const s = await loadRevocationState();
  return s.status === 'unknown' ? true : `读到 ${s.status}`;
});

await check('读：Keystore 不可用（探测失败）→ unknown，不当作「没有标记」', async () => {
  resetAll();
  // 主通道读成功、明确没有标记；降级通道读不出来（Keystore 坏）
  const faults = makeFaultScope();
  faults.breakKeychain('getGenericPassword');
  let s;
  try {
    s = await loadRevocationState();
  } finally {
    faults.restore();
  }
  return s.status === 'unknown'
    ? true
    : `读到 ${s.status} —— 一个通道读不到就敢说「没撤销」是 fail-open`;
});

await check('读：两通道都读成功且都无标记 → not-revoked', async () => {
  resetAll();
  const s = await loadRevocationState();
  return s.status === 'not-revoked'
    ? true
    : `读到 ${s.status} —— 两个存储都确认没有，应该允许自动配对`;
});

await check('读：unknown 不进缓存（存储恢复后能读到真实状态）', async () => {
  resetAll();
  await AsyncStorageStub.setItem(
    REVOKED_KEY,
    JSON.stringify({ v: 2, revoked: true, at: 1, reason: 'self-revoked' }),
  );

  const faults = makeFaultScope();
  faults.breakKeychain('getGenericPassword');
  faults.breakAsyncStorage('getItem');
  let first;
  try {
    first = await loadRevocationState();
  } finally {
    faults.restore();
  }
  if (first.status !== 'unknown') return `第一次应为 unknown，实际 ${first.status}`;

  const second = await loadRevocationState();
  return second.status === 'revoked'
    ? true
    : `恢复后读到 ${second.status} —— unknown 被缓存了`;
});

await check('读：标记版本 v1（老数据）仍然算有效标记', async () => {
  resetAll();
  // 老版本写的标记没有 v 字段
  await AsyncStorageStub.setItem(
    REVOKED_KEY,
    JSON.stringify({ revoked: true, at: 123, reason: 'self-revoked' }),
  );
  __resetRevocationCache();
  const s = await loadRevocationState();
  return s.status === 'revoked'
    ? true
    : `老版本标记被当成 ${s.status} —— 升级后用户的撤销决定被作废`;
});

// ══════════════════════════════════════════════════════════════
// 五、服务端撤销 与 本地持久化 的四种组合
// ══════════════════════════════════════════════════════════════

await check('组合①：服务端撤销成功 + 本地持久化成功 → 双保险', async () => {
  const srv = await startFakeDsh();
  try {
    resetAll();
    await seedCookie(srv);

    // 服务端那半：用真实 deviceAuth 走真实 HTTP
    const { revokeDevice } = await imp(
      path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
    );
    const serverOutcome = await revokeDevice(
      srv.baseUrl,
      srv.cookie,
      '00000000-0000-0000-0000-000000000000',
    );
    // 这个 UUID 不存在 → already-gone（服务端确实没有这条记录）
    if (serverOutcome === 'failed') return '前置条件不成立：服务端调用失败';

    const r = await markApprovalRevoked('self-revoked');
    if (!r.ok) return `本地持久化失败：${r.error}`;
    __resetRevocationCache();
    const s = await loadRevocationState();
    return s.status === 'revoked'
      ? true
      : `服务端成功 + 本地成功，重启后却是 ${s.status}`;
  } finally {
    await srv.close();
  }
});

await check('组合②：服务端撤销成功 + 本地持久化失败 → 必须上报失败', async () => {
  const srv = await startFakeDsh();
  try {
    resetAll();
    await seedCookie(srv);

    const { revokeDevice } = await imp(
      path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
    );
    const serverOutcome = await revokeDevice(
      srv.baseUrl,
      srv.cookie,
      '00000000-0000-0000-0000-000000000000',
    );
    if (serverOutcome === 'failed') return '前置条件不成立：服务端调用失败';

    const faults = makeFaultScope();
    faults.breakAsyncStorage('setItem');
    faults.breakKeychain('setGenericPassword');
    let r;
    try {
      r = await markApprovalRevoked('self-revoked');
    } finally {
      faults.restore();
    }

    if (r.ok !== false) {
      return '本地没写成功却报 ok=true —— 用户会以为「已保存」，重启后失效';
    }
    if (r.memoryOnly !== true) return 'memoryOnly 应为 true';
    return r.persisted === 'none' ? true : `persisted 应为 none，实际 ${r.persisted}`;
  } finally {
    await srv.close();
  }
});

await check('组合③：服务端撤销失败 + 本地持久化成功 → 本地是唯一屏障，仍有效', async () => {
  const srv = await startFakeDsh();
  try {
    resetAll();
    await seedCookie(srv);

    // 服务端撤销失败：打一个关掉的端口
    const { revokeOwnDevice } = await imp(
      path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
    );
    const serverOutcome = await revokeOwnDevice('http://127.0.0.1:1', 'c', 'dev');
    if (serverOutcome !== 'failed') return '前置条件不成立：服务端本该失败';

    const r = await markApprovalRevoked('self-revoked');
    if (!r.ok) return `本地是唯一屏障，却没能持久化：${r.error}`;

    // 重启后仍然拦得住（这是这个组合的全部意义）
    __resetRevocationCache();
    const s = await loadRevocationState();
    return s.status === 'revoked'
      ? true
      : `服务端失败 + 本地虽成功但重启后读到 ${s.status} —— 无任何屏障`;
  } finally {
    await srv.close();
  }
});

await check('组合④：服务端失败 + 本地失败 → 双重失败必须如实反映', async () => {
  const srv = await startFakeDsh();
  try {
    resetAll();
    await seedCookie(srv);

    const { revokeOwnDevice } = await imp(
      path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
    );
    const serverOutcome = await revokeOwnDevice('http://127.0.0.1:1', 'c', 'dev');
    if (serverOutcome !== 'failed') return '前置条件不成立：服务端本该失败';

    const faults = makeFaultScope();
    faults.breakAsyncStorage('setItem');
    faults.breakKeychain('setGenericPassword');
    let r;
    try {
      r = await markApprovalRevoked('self-revoked');
    } finally {
      faults.restore();
    }

    if (r.ok !== false) {
      return '服务端和本地都失败，却报本地成功 —— 用户完全无从得知';
    }
    // 本次运行仍然是 revoked（唯一残留的保护）
    if ((await isApprovalRevoked()) !== true) {
      return '本次运行的内存屏障也没了 —— 会立刻自动重新配对';
    }
    return true;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 六、持久化失败 → 重启：fail-closed 的真实链路
// ══════════════════════════════════════════════════════════════

await check('重启后 fail-closed：上一次持久化失败且存储仍坏 → unknown，不配对', async () => {
  const srv = await startFakeDsh();
  try {
    resetAll();
    await seedCookie(srv);

    // 上一次运行：两个存储都写失败
    const faults = makeFaultScope();
    faults.breakAsyncStorage('setItem');
    faults.breakKeychain('setGenericPassword');
    try {
      await markApprovalRevoked('self-revoked');
    } finally {
      faults.restore();
    }

    // 模拟重启 + 存储仍然读不出来
    __resetRevocationCache();
    const readFaults = makeFaultScope();
    readFaults.breakAsyncStorage('getItem');
    readFaults.breakKeychain('getGenericPassword');

    const pairsBefore = srv.pairCalls;
    const statuses = [];
    let gw;
    try {
      gw = new ApprovalGateway(srv.baseUrl, {
        onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
        onApproval: () => {},
        onResolved: () => {},
      });
      await gw.connect();
      await new Promise((res) => setTimeout(res, 1200));
    } finally {
      readFaults.restore();
      if (gw) await closeGateway(gw);
    }

    if (srv.pairCalls > pairsBefore) {
      return `存储读不出来时仍然配对了（${pairsBefore} → ${srv.pairCalls}）`;
    }
    return statuses.some((s) => s.startsWith('unknown'))
      ? true
      : `没有进入 unknown（${statuses.slice(-3).join(' | ')}）`;
  } finally {
    await srv.close();
  }
});

await check('重启后 fail-closed：主通道坏、降级通道有标记 → 仍然 revoked', async () => {
  const srv = await startFakeDsh();
  try {
    resetAll();
    await seedCookie(srv);

    // 上一次运行：主通道写失败 → 降级到 Keystore
    const faults = makeFaultScope();
    faults.breakAsyncStorage('setItem');
    try {
      const r = await markApprovalRevoked('self-revoked');
      if (!r.ok) return `前置条件不成立：降级没成功（${r.error}）`;
    } finally {
      faults.restore();
    }

    // 重启 + 这次主通道**读**也坏了
    __resetRevocationCache();
    const readFaults = makeFaultScope();
    readFaults.breakAsyncStorage('getItem');

    const pairsBefore = srv.pairCalls;
    const statuses = [];
    let gw;
    try {
      gw = new ApprovalGateway(srv.baseUrl, {
        onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
        onApproval: () => {},
        onResolved: () => {},
      });
      await gw.connect();
      await new Promise((res) => setTimeout(res, 1200));
    } finally {
      readFaults.restore();
      if (gw) await closeGateway(gw);
    }

    if (srv.pairCalls > pairsBefore) {
      return `降级通道里有标记却仍然配对了（${pairsBefore} → ${srv.pairCalls}）`;
    }
    return statuses.includes('revoked:审批授权已撤销，需要重新授权')
      ? true
      : `没进入 revoked（${statuses.slice(-3).join(' | ')}）`;
  } finally {
    await srv.close();
  }
});

await check('存储恢复后能重新读到真实状态（不永久停摆）', async () => {
  resetAll();
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();

  // 第一次读失败
  const faults = makeFaultScope();
  faults.breakAsyncStorage('getItem');
  faults.breakKeychain('getGenericPassword');
  let first;
  try {
    first = await loadRevocationState();
  } finally {
    faults.restore();
  }
  if (first.status !== 'unknown') return `第一次应为 unknown，实际 ${first.status}`;

  // 恢复后
  const second = await loadRevocationState();
  return second.status === 'revoked'
    ? true
    : `恢复后读到 ${second.status} —— 永久停摆`;
});

// ══════════════════════════════════════════════════════════════
// 七、用户重新授权：两个标记都要清掉
// ══════════════════════════════════════════════════════════════

await check('重新授权：两个存储里的标记都被删掉', async () => {
  resetAll();
  // 手动造两份标记（模拟历史上两个通道都写过）
  await AsyncStorageStub.setItem(
    REVOKED_KEY,
    JSON.stringify({ v: 2, revoked: true, at: 1, reason: 'self-revoked' }),
  );
  ks().set(KS_REVOCATION_MARKER, {
    username: 'k',
    password: JSON.stringify({ v: 2, revoked: true, at: 1, reason: 'self-revoked' }),
  });
  __resetRevocationCache();

  const cleared = await clearApprovalRevoked();
  if (cleared !== true) return '两个通道都正常却返回 false';

  if ((await AsyncStorageStub.getItem(REVOKED_KEY)) !== null) {
    return 'AsyncStorage 里的标记没删掉';
  }
  if (ks().has(KS_REVOCATION_MARKER)) return 'Keystore 里的降级标记没删掉';

  // 重启后也必须是 not-revoked（两个通道都确认没有了）
  __resetRevocationCache();
  const s = await loadRevocationState();
  return s.status === 'not-revoked'
    ? true
    : `清掉后重启读到 ${s.status} —— 有个通道的标记还在`;
});

await check('重新授权：只清主通道不够 —— 降级通道残留会让重启后又被拦住', async () => {
  resetAll();
  // 只有 Keystore 里有标记（典型的「上次主通道写失败」现场）
  ks().set(KS_REVOCATION_MARKER, {
    username: 'k',
    password: JSON.stringify({ v: 2, revoked: true, at: 1, reason: 'server-revoked' }),
  });
  __resetRevocationCache();

  const cleared = await clearApprovalRevoked();
  if (cleared !== true) return '正常路径应返回 true';
  if (ks().has(KS_REVOCATION_MARKER)) {
    return '只清了 AsyncStorage，Keystore 里的标记还留着';
  }

  __resetRevocationCache();
  const s = await loadRevocationState();
  return s.status === 'not-revoked'
    ? true
    : `重启后读到 ${s.status} —— 重新授权在重启后失效`;
});

await check('重新授权：主通道删不掉 → 返回 false 且保持「已撤销」', async () => {
  resetAll();
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();
  await loadRevocationState(); // 缓存成 revoked

  const faults = makeFaultScope();
  faults.breakAsyncStorage('removeItem');
  let cleared;
  try {
    cleared = await clearApprovalRevoked();
  } finally {
    faults.restore();
  }

  if (cleared !== false) return '删失败却返回 true';
  return (await isApprovalRevoked()) === true
    ? true
    : '删失败后内存态变成未撤销 —— 当前进程会立刻自动配对';
});

await check('重新授权：Keystore 删不掉 → 返回 false（不谎报清干净）', async () => {
  resetAll();
  ks().set(KS_REVOCATION_MARKER, {
    username: 'k',
    password: JSON.stringify({ v: 2, revoked: true, at: 1, reason: 'self-revoked' }),
  });
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();
  await loadRevocationState();

  const faults = makeFaultScope();
  faults.breakKeychain('resetGenericPassword');
  let cleared;
  try {
    cleared = await clearApprovalRevoked();
  } finally {
    faults.restore();
  }

  if (cleared !== false) return '降级通道删不掉却返回 true';
  return (await isApprovalRevoked()) === true
    ? true
    : '降级通道删不掉，内存态却放行了';
});

await check('重新授权后能重新读到 not-revoked 并清掉缓存', async () => {
  resetAll();
  await markApprovalRevoked('self-revoked');
  if ((await isApprovalRevoked()) !== true) return '前置条件不成立';

  const cleared = await clearApprovalRevoked();
  if (cleared !== true) return '正常清理失败';
  if ((await isApprovalRevoked()) !== false) return '清掉后内存态没更新';

  __resetRevocationCache();
  return (await getApprovalRevocationStatus()) === 'not-revoked'
    ? true
    : '重启后不是 not-revoked';
});

// ══════════════════════════════════════════════════════════════
// 八、降级标记必须熬过「彻底清除授权」
//
// 这是一条**很容易被后人「优化」掉**的性质：
// 有人看到 clearAllCredentials() 不清 revocationMarker，会觉得是漏了，
// 顺手补上 —— 那就等于把「用户撤销过」的唯一证据在清除授权时抹掉。
// ══════════════════════════════════════════════════════════════

await check('降级标记熬过 clearAllCredentials()：撤销证据不被「彻底清除」抹掉', async () => {
  resetAll();
  // 造一个「主通道写失败 → 降级到 Keystore」的现场
  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }
  if (r.persisted !== 'secure-store') {
    return `前置条件不成立：期望降到 secure-store，实际 ${r.persisted}`;
  }
  if (!ks().has(KS_REVOCATION_MARKER)) return '前置条件不成立：Keystore 里没标记';

  // 「退出并清除所有授权」会调这个
  await clearAllCredentials();

  if (!ks().has(KS_REVOCATION_MARKER)) {
    return 'clearAllCredentials 把撤销标记一起清掉了 —— Cookie 若没删干净就会自动重新配对';
  }

  // 重启后仍然读得到 → 撤销决定仍然有效
  __resetRevocationCache();
  const s = await loadRevocationState();
  if (s.status !== 'revoked') {
    return `彻底清除后读到 ${s.status} —— 撤销证据丢了`;
  }
  return s.reason === 'self-revoked' ? true : 'reason 丢了';
});

await check('降级标记熬过彻底清除：其他凭据确实被清了（不是没生效）', async () => {
  resetAll();
  ks().set(KS_COOKIE, { username: 'k', password: 'COOKIE' });
  ks().set(KS_GW_TOKEN, { username: 'k', password: 'TOKEN' });
  ks().set(KS_GW_DEVICE_ID, { username: 'k', password: 'dsh-outpost-x' });
  ks().set(KS_REVOCATION_MARKER, {
    username: 'k',
    password: JSON.stringify({ v: 2, revoked: true, at: 1, reason: 'self-revoked' }),
  });

  await clearAllCredentials();

  const leftover = [KS_COOKIE, KS_GW_TOKEN, KS_GW_DEVICE_ID].filter((s) => ks().has(s));
  if (leftover.length > 0) return `这些凭据没被清：${leftover.join('、')}`;
  return ks().has(KS_REVOCATION_MARKER)
    ? true
    : '撤销标记被误清（这条用例的前置条件不成立也说明清得过头了）';
});

// ══════════════════════════════════════════════════════════════
// 九、返回值契约（UI 三态文案的依据）
// ══════════════════════════════════════════════════════════════

await check('契约：成功时 ok=true / memoryOnly=false / 无 error', async () => {
  resetAll();
  const r = await markApprovalRevoked('self-revoked');
  const shape = `${r.ok}|${r.persisted}|${r.memoryOnly}`;
  if (shape !== 'true|async-storage|false') return `形状不对：${shape}`;
  return r.error === undefined ? true : `成功时不该有 error：${r.error}`;
});

await check('契约：降级成功时也必须是 ok=true / memoryOnly=false', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }
  const shape = `${r.ok}|${r.persisted}|${r.memoryOnly}`;
  // 「降级通道」仍然是**持久化**的 —— 不能因为没走主通道就说 memoryOnly
  return shape === 'true|secure-store|false'
    ? true
    : `形状不对：${shape}（降级成功不该算 memoryOnly）`;
});

await check('契约：失败时 error 只描述类别，不含凭据值', async () => {
  resetAll();
  ks().set(KS_COOKIE, { username: 'k', password: 'SECRET_COOKIE_VALUE' });
  ks().set(KS_GW_TOKEN, { username: 'k', password: 'SECRET_TOKEN_VALUE' });

  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  faults.breakKeychain('setGenericPassword');
  let r;
  try {
    r = await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }

  const blob = JSON.stringify(r);
  if (blob.includes('SECRET_COOKIE_VALUE')) return '返回值里泄露了 cookie 值';
  if (blob.includes('SECRET_TOKEN_VALUE')) return '返回值里泄露了 token 值';
  if (blob.includes(REVOKED_KEY)) {
    return '返回值里带了存储键（不是凭据，但也没必要外泄）';
  }
  return r.error && r.error.length < 400 ? true : 'error 为空或异常长';
});

await check('契约：markApprovalRevoked 返回 Promise（不是 void）', async () => {
  resetAll();
  const ret = markApprovalRevoked('self-revoked');
  if (!ret || typeof ret.then !== 'function') return '没有返回 Promise';
  const r = await ret;
  if (!r || typeof r !== 'object') return 'resolve 出的不是对象';
  const need = ['ok', 'persisted', 'memoryOnly'];
  const missing = need.filter((k) => !(k in r));
  return missing.length === 0 ? true : `缺字段：${missing.join('、')}`;
});

// ══════════════════════════════════════════════════════════════
// 十、不设置「只在内存里撤销」的隐患：缓存规则
// ══════════════════════════════════════════════════════════════

await check('缓存：持久化失败后内存态保持 revoked（不被 unknown 覆盖）', async () => {
  resetAll();
  const faults = makeFaultScope();
  faults.breakAsyncStorage('setItem');
  faults.breakKeychain('setGenericPassword');
  try {
    await markApprovalRevoked('self-revoked');
  } finally {
    faults.restore();
  }

  // 即使此刻存储整体不可读，内存缓存也应继续给出 revoked
  const readFaults = makeFaultScope();
  readFaults.breakAsyncStorage('getItem');
  readFaults.breakKeychain('getGenericPassword');
  let s;
  try {
    s = await loadRevocationState();
  } finally {
    readFaults.restore();
  }
  return s.status === 'revoked'
    ? true
    : `读到 ${s.status} —— 持久化失败后内存屏障没保住`;
});

await check('缓存：持久化成功后不残留旧的 not-revoked 缓存', async () => {
  resetAll();
  // 先读出 not-revoked 并缓存
  if ((await getApprovalRevocationStatus()) !== 'not-revoked') {
    return '前置条件不成立';
  }
  // 不重置缓存直接置撤销
  await markApprovalRevoked('self-revoked');
  return (await getApprovalRevocationStatus()) === 'revoked'
    ? true
    : '缓存没被更新 —— 撤销后立刻读还是未撤销（当前进程会放行）';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
