/**
 * P0：撤销状态读取失败时必须 fail-closed。
 *
 * ## 背景
 *
 * 撤销标记存在 AsyncStorage 里，而「读存储」本身会失败：磁盘满、
 * 系统清理、进程被杀在写入中途、文件损坏。
 *
 * 之前的实现把「读不到」当成「未撤销」。这是一个 fail-open：
 *
 *   用户撤销自己 → 服务端撤销失败（serverOk=false）→ 本地标记是唯一屏障
 *   → 下次启动存储抖动一下 → 程序认为「没撤销过」→ 自动申请配对码
 *   → 设备重新获得审批权限。这次**没有** 4003 来兜底，
 *     因为服务端根本没删掉那条记录。
 *
 * ## 现在的要求
 *
 * 必须区分三态：
 *   · not-revoked  读成功且确认没有标记   → 允许自动配对
 *   · revoked      读成功且标记有效       → 禁止
 *   · unknown      读失败/损坏/不可用     → **禁止**，等存储恢复
 *
 * 这个文件驱动真实产品函数（deviceRevocation.ts + ApprovalGateway），
 * 用真实 WebSocket 连模拟服务端，断言「配对码申请次数」这个可观测事实。
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

const AsyncStorageStub = (await imp(path.join(SHIM_DIR, 'async-storage-stub.mjs')))
  .default;
const AsyncStorageCjs = createRequire(import.meta.url)('./support/_async-storage-shim.cjs');
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
const { startFakeDsh } = await imp(path.join(SHIM_DIR, 'fake-dsh.mjs'));

const REVOKED_KEY = '@dsh/approvalRevoked';

function ks() {
  if (!globalThis.__dshTestKeychainState__) {
    globalThis.__dshTestKeychainState__ = { store: new Map() };
  }
  return globalThis.__dshTestKeychainState__.store;
}

function reset() {
  AsyncStorageStub.__reset();
  ks().clear();
  __resetRevocationCache();
}

/** 预置登录 cookie */
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

/** 让 AsyncStorage 的 getItem 对某个 key 失败 n 次 */
function failGetItem(key, times = Infinity) {
  const orig = AsyncStorageCjs.getItem;
  let count = 0;
  AsyncStorageCjs.getItem = async (k) => {
    if (k === key && count < times) {
      count += 1;
      throw new Error('storage unavailable');
    }
    return orig.call(AsyncStorageCjs, k);
  };
  return () => {
    AsyncStorageCjs.getItem = orig;
  };
}

// ══════════════════════════════════════════════════════════════
// 一、三态读取（纯函数层）
// ══════════════════════════════════════════════════════════════

await check('无标记且读正常 → not-revoked', async () => {
  reset();
  const s = await loadRevocationState();
  return s.status === 'not-revoked' ? true : `期望 not-revoked，实际 ${s.status}`;
});

await check('有标记且读正常 → revoked', async () => {
  reset();
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();
  const s = await loadRevocationState();
  return s.status === 'revoked' ? true : `期望 revoked，实际 ${s.status}`;
});

await check('读抛异常 → unknown（不是 not-revoked）', async () => {
  reset();
  const restore = failGetItem(REVOKED_KEY);
  let s;
  try {
    s = await loadRevocationState();
  } finally {
    restore();
  }
  return s.status === 'unknown'
    ? true
    : `期望 unknown，实际 ${s.status} —— 读失败被当成了「未撤销」（fail-open）`;
});

await check('损坏数据（非法 JSON）→ unknown', async () => {
  reset();
  await AsyncStorageStub.setItem(REVOKED_KEY, 'not-json{{{');
  const s = await loadRevocationState();
  return s.status === 'unknown' ? true : `期望 unknown，实际 ${s.status}`;
});

await check('损坏数据（结构不对）→ unknown', async () => {
  reset();
  await AsyncStorageStub.setItem(REVOKED_KEY, JSON.stringify({ foo: 'bar' }));
  const s = await loadRevocationState();
  return s.status === 'unknown' ? true : `期望 unknown，实际 ${s.status}`;
});

await check('isApprovalRevoked 只在明确 revoked 时返回 true', async () => {
  reset();
  // unknown 时也不能返回 true（那是「确认撤销」，不是「不知道」）
  const restore = failGetItem(REVOKED_KEY);
  let r;
  try {
    r = await isApprovalRevoked();
  } finally {
    restore();
  }
  if (r !== false) return 'unknown 被当成了「已撤销」（会让界面误报）';
  // 明确的 revoked 要返回 true
  reset();
  await markApprovalRevoked('self-revoked');
  return (await isApprovalRevoked()) === true ? true : 'revoked 没返回 true';
});

await check('getApprovalRevocationStatus 返回三态', async () => {
  reset();
  const a = await getApprovalRevocationStatus();
  if (a !== 'not-revoked') return `空存储应为 not-revoked，实际 ${a}`;

  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();
  const b = await getApprovalRevocationStatus();
  if (b !== 'revoked') return `标记后应为 revoked，实际 ${b}`;

  reset();
  const restore = failGetItem(REVOKED_KEY);
  let c;
  try {
    c = await getApprovalRevocationStatus();
  } finally {
    restore();
  }
  return c === 'unknown' ? true : `读失败应为 unknown，实际 ${c}`;
});

await check('unknown 不进缓存：存储恢复后能读到真实状态', async () => {
  reset();
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();

  // 第一次读失败
  const restore = failGetItem(REVOKED_KEY, 1);
  let first;
  try {
    first = await loadRevocationState();
  } finally {
    restore();
  }
  if (first.status !== 'unknown') return `第一次应为 unknown，实际 ${first.status}`;

  // 存储恢复后必须能读到真实状态（revoked）
  const second = await loadRevocationState();
  return second.status === 'revoked'
    ? true
    : `存储恢复后应为 revoked，实际 ${second.status} —— unknown 被缓存了`;
});

await check('读失败不会清除已有标记', async () => {
  reset();
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();

  const restore = failGetItem(REVOKED_KEY);
  try {
    await loadRevocationState(); // 触发一次失败读取
  } finally {
    restore();
  }

  // 存储里的标记必须还在
  const raw = await AsyncStorageStub.getItem(REVOKED_KEY);
  if (!raw) return '读失败把标记清掉了 —— 用户撤销决定丢失';
  const parsed = JSON.parse(raw);
  return parsed.revoked === true ? true : '标记内容被破坏';
});

// ══════════════════════════════════════════════════════════════
// 二、网关行为：状态未知时绝不自动配对（核心验收标准）
// ══════════════════════════════════════════════════════════════

await check('核心：撤销状态未知时 connect() **不申请配对码**', async () => {
  const srv = await startFakeDsh();
  try {
    reset();
    await seedCookie(srv);
    reset(); // 清掉 seed 期间可能的写入，保留 cookie
    await seedCookie(srv);

    // 没有 token（模拟撤销后本地凭据已清）+ 存储读不出来
    const restore = failGetItem(REVOKED_KEY);
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
      // 给它一点时间（如果它要配对，会在这期间发请求）
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      restore();
      if (gw) await closeGateway(gw);
    }

    const pairsAfter = srv.pairCalls;
    if (pairsAfter > pairsBefore) {
      return (
        `撤销状态读不出来时仍然申请了配对码（${pairsBefore} → ${pairsAfter}）` +
        ' —— 设备会被静默重新授权'
      );
    }
    if (!statuses.some((s) => s.startsWith('unknown'))) {
      return `没有进入明确的「状态未知」（状态：${statuses.slice(-4).join(' | ')}）`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('核心：撤销状态未知时重启 App 也不自动配对', async () => {
  const srv = await startFakeDsh();
  try {
    reset();
    await seedCookie(srv);

    const restore = failGetItem(REVOKED_KEY);
    const pairsBefore = srv.pairCalls;
    let gw;
    try {
      // 模拟「重启」：全新网关实例 + 丢缓存
      __resetRevocationCache();
      gw = new ApprovalGateway(srv.baseUrl, {
        onStatus: () => {},
        onApproval: () => {},
        onResolved: () => {},
      });
      await gw.connect();
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      restore();
      if (gw) await closeGateway(gw);
    }

    return srv.pairCalls === pairsBefore
      ? true
      : `重启后自动配对了（${pairsBefore} → ${srv.pairCalls}）`;
  } finally {
    await srv.close();
  }
});

await check('存储恢复后能自动重连（不永久停摆）', async () => {
  const srv = await startFakeDsh();
  try {
    reset();
    await seedCookie(srv);

    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    // 第一次读失败
    const restore = failGetItem(REVOKED_KEY, 1);
    try {
      await gw.connect();
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      restore();
    }

    if (!statuses.some((s) => s.startsWith('unknown'))) {
      await closeGateway(gw);
      return `没有先进入 unknown（状态：${statuses.slice(-3).join(' | ')}）`;
    }

    // 存储恢复后，下一次 connect（等价于重试）应该能正常配对连上
    await gw.connect();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')), 12000);
    await closeGateway(gw);

    return online
      ? true
      : `存储恢复后仍连不上（状态：${statuses.slice(-5).join(' | ')}）—— 永久停摆`;
  } finally {
    await srv.close();
  }
});

await check('核心：明确未撤销时正常自动配对（不误伤正常用户）', async () => {
  const srv = await startFakeDsh();
  try {
    reset();
    await seedCookie(srv);

    const pairsBefore = srv.pairCalls;
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    await gw.connect();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')), 12000);
    await closeGateway(gw);

    if (!online) return `正常用户连不上（状态：${statuses.slice(-4).join(' | ')}）`;
    return srv.pairCalls > pairsBefore
      ? true
      : '没有申请配对码（首次使用本该自动配对）';
  } finally {
    await srv.close();
  }
});

await check('核心：明确已撤销时仍然不配对（原有行为不变）', async () => {
  const srv = await startFakeDsh();
  try {
    reset();
    await seedCookie(srv);
    await markApprovalRevoked('self-revoked');
    __resetRevocationCache();

    const pairsBefore = srv.pairCalls;
    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    await gw.connect();
    await new Promise((r) => setTimeout(r, 1200));
    await closeGateway(gw);

    if (srv.pairCalls > pairsBefore) {
      return `已撤销状态下仍然配对了（${pairsBefore} → ${srv.pairCalls}）`;
    }
    return statuses.includes('revoked:审批授权已撤销，需要重新授权')
      ? true
      : `没进入 revoked 状态（${statuses.slice(-3).join(' | ')}）`;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 三、用户主动重新授权仍然有效（不能被 fail-closed 卡死）
// ══════════════════════════════════════════════════════════════

await check('用户主动重新授权：清标记后能重新配对连上', async () => {
  const srv = await startFakeDsh();
  try {
    reset();
    await seedCookie(srv);
    await markApprovalRevoked('self-revoked');
    __resetRevocationCache();

    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
      onApproval: () => {},
      onResolved: () => {},
    });

    await gw.reauthorize();
    const online = await waitFor(() => statuses.some((s) => s.startsWith('online')), 15000);
    await closeGateway(gw);

    return online
      ? true
      : `重新授权后连不上（状态：${statuses.slice(-5).join(' | ')}）`;
  } finally {
    await srv.close();
  }
});

await check('用户主动重新授权：存储不可用时如实失败，不静默放行', async () => {
  reset();
  await markApprovalRevoked('self-revoked');
  __resetRevocationCache();

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
  const still = await getApprovalRevocationStatus();
  return still === 'revoked'
    ? true
    : `删失败后状态变成了 ${still} —— 当前进程会立刻自动配对`;
});

// ══════════════════════════════════════════════════════════════
// 四、状态类型同步（所有调用方都处理了三态）
// ══════════════════════════════════════════════════════════════

await check('类型同步：GatewayStatus 包含 unknown', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
    'utf8',
  );
  if (!/export type GatewayStatus[\s\S]{0,400}'unknown'/.test(src)) {
    return 'GatewayStatus 没有 unknown';
  }
  return true;
});

await check('类型同步：ProfileScreen 的文案表覆盖 unknown', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    path.join(__dirname, '..', 'src', 'screens', 'ProfileScreen.tsx'),
    'utf8',
  );
  const i = src.indexOf('GATEWAY_LABELS');
  if (i < 0) return '找不到 GATEWAY_LABELS';
  const body = src.slice(i, i + 500);
  return /unknown:/.test(body) ? true : '文案表缺 unknown（类型检查会报错）';
});

await check('类型同步：store.syncRevokedState 处理 unknown', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'store.ts'),
    'utf8',
  );
  const i = src.indexOf('syncRevokedState');
  if (i < 0) return '找不到 syncRevokedState';
  const body = src.slice(i, i + 900);
  return /'unknown'/.test(body) ? true : 'store 没处理 unknown 状态';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
