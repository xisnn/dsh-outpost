/**
 * 旧明文凭据迁移的**崩溃 / 中断**回归测试（P1-3）。
 *
 * ## 为什么单独一个文件
 *
 * `credential-migration-spec.mjs` 守的是「正常路径 + 单点失败」；
 * 这个文件守的是**进程在迁移中途被打断**时的后果。
 *
 * 真实场景：迁移一开始要读明文 → 写 Keychain → 回读校验 → 删明文。
 * 这四个阶段之间都可能被杀：
 *
 *   · 用户切走 App、系统回收内存 → 进程直接死
 *   · 用户强杀
 *   · 系统 OOM
 *
 * 中断本身不可怕（下次启动会重跑迁移，它是幂等的）。可怕的是
 * **中断之后报告撒谎**：比如进程死在「写 Keychain 之前」，下次启动
 * 却报 'clean' —— 那用户永远不知道自己的明文凭据还躺在磁盘上。
 *
 * 所以这里的每条用例都是同一个句式：
 *
 *   在第 N 阶段注入失败 → 立刻断言语义正确 → **再跑一次** →
 *   断言凭据没丢、且没有出现假的 'clean'。
 *
 * ## 怎么模拟「崩溃」
 *
 * Node 里没法真的杀自己，所以用两种方式模拟「这个阶段的存储操作
 * 失败了 / 进程在这之后就不存在了」：
 *
 *   1. **让某个存储操作抛错** —— 等价于该阶段没做成（崩溃在该阶段）
 *   2. **换掉 Keychain / AsyncStorage 的实例状态** —— 等价于重启后
 *      面对一个「不知道上次做到哪」的世界
 *
 * 两种都不会真的破坏产品代码，因为注入的都是测试替身的方法。
 *
 * ## 一条铁律
 *
 *   **只有 multiGet 成功返回时，才允许出现 status === 'clean'。**
 *
 * `clean` 的语义是「确认没有明文凭据」。读都没读到就报 clean，
 * 等于把「未知」当成「安全」—— 这正是 P1-3 要修的缺陷。
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

const AsyncStorageStub = (await imp(path.join(__dirname, 'support', 'async-storage-stub.mjs')))
  .default;

/**
 * 产品代码用的是 **CJS shim**（经 Module._resolveFilename 重定向）。
 * 和 ESM 版共享 globalThis 存储，但是**两个不同的对象** ——
 * 注入失败必须替换 CJS 这个（替换 ESM 的不生效，踩过一次）。
 */
const AsyncStorageCjs = createRequire(import.meta.url)('./support/_async-storage-shim.cjs');

/** Keychain 替身状态直接读写 globalThis（和产品代码共享） */
function ks() {
  if (!globalThis.__dshTestKeychainState__) {
    globalThis.__dshTestKeychainState__ = { store: new Map() };
  }
  return globalThis.__dshTestKeychainState__.store;
}
function ksReset() {
  ks().clear();
}
function ksHas(credentialKey) {
  return ks().has(`com.dshpocket.credentials.${credentialKey}`);
}
function ksGet(credentialKey) {
  const rec = ks().get(`com.dshpocket.credentials.${credentialKey}`);
  return rec ? rec.password : undefined;
}

async function keychainApi() {
  const shim = await imp(path.join(__dirname, 'support', '_keychain-shim.cjs'));
  return shim.default ?? shim;
}

/** AsyncStorage 底层状态（绕过被 patch 掉的方法） */
function rawStore() {
  if (!globalThis.__dshTestAsyncStorageState__) {
    globalThis.__dshTestAsyncStorageState__ = { store: new Map(), calls: [] };
  }
  return globalThis.__dshTestAsyncStorageState__.store;
}

/** 临时替换一个方法，返回恢复函数 */
function patch(obj, name, impl) {
  const orig = obj[name];
  obj[name] = impl;
  return () => {
    obj[name] = orig;
  };
}

const { CredentialKey } = await imp(path.join(__dirname, '..', 'src', 'core', 'secureStore.ts'));
const migration = await imp(
  path.join(__dirname, '..', 'src', 'core', 'credentialMigration.ts'),
);
const {
  migrateLegacyCredentials,
  clearLegacyCredentialStorageVerified,
  shouldBlockAutoLogin,
  ALL_LEGACY_KEYS,
  LegacyCredentialKey,
} = migration;

function reset() {
  AsyncStorageStub.__reset();
  ksReset();
}

/**
 * 「重启」：清掉所有内存态的注入，然后重跑迁移。
 *
 * 真实的重启不会保留任何 JS 状态，但会保留**磁盘**（AsyncStorage）
 * 和 **Keystore**（Keychain）。这里对应地只清 patch、不动存储。
 */
function restart() {
  return migrateLegacyCredentials();
}

/** 断言一份报告没有撒谎：读失败时绝不能是 clean */
function noFalseClean(report, statuses, label) {
  if (report.status === 'clean' && report.readSucceeded === false) {
    return `${label}：读失败却报 clean（把「未知」当成「确认没有」）`;
  }
  if (!statuses.includes(report.status)) {
    return `${label}：状态 ${report.status} 不在预期集合 [${statuses.join(', ')}] 内`;
  }
  return '';
}

// ══════════════════════════════════════════════════════════════
// 一、崩溃在「读明文」阶段
// ══════════════════════════════════════════════════════════════

await check('崩溃@读明文：multiGet 失败 → read-failed，重启后仍能正常迁移', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_CRASH_READ');

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('database is locked');
  });
  let first;
  try {
    first = await restart();
  } finally {
    restore();
  }

  const err = noFalseClean(first, ['read-failed'], '第一次');
  if (err) return err;
  if (first.readSucceeded !== false) return 'readSucceeded 应为 false';
  if (shouldBlockAutoLogin(first) !== true) return 'read-failed 没有拦下自动登录';

  // 明文必须完好（我们什么都没碰）
  if (rawStore().get(LegacyCredentialKey.cookie) !== 'C_CRASH_READ') {
    return '读失败却动了明文（不该发生）';
  }

  // 「重启」：存储恢复后重跑，这次应该成功
  const second = await restart();
  if (second.status !== 'migrated') return `重启后应为 migrated，实际 ${second.status}`;
  if (ksGet(CredentialKey.cookie) !== 'C_CRASH_READ') return '重启后凭据没迁过去';
  if (rawStore().has(LegacyCredentialKey.cookie)) return '重启后明文没删掉';
  return true;
});

// ══════════════════════════════════════════════════════════════
// 二、崩溃在「写 Keychain」阶段
// ══════════════════════════════════════════════════════════════

await check('崩溃@写 Keychain：写入抛错 → failed，明文保留，重启后迁移成功', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_CRASH_WRITE');

  const api = await keychainApi();
  const origSet = api.setGenericPassword;
  api.setGenericPassword = async () => {
    throw new Error('keystore unavailable');
  };
  let first;
  try {
    first = await restart();
  } finally {
    api.setGenericPassword = origSet;
  }

  const err = noFalseClean(first, ['failed'], '第一次');
  if (err) return err;
  if (shouldBlockAutoLogin(first) !== true) return 'failed 没有拦下自动登录';

  // 关键：明文必须还在（否则用户登录态凭空消失）
  if (rawStore().get(LegacyCredentialKey.cookie) !== 'C_CRASH_WRITE') {
    return '写入失败却把明文删了（用户会彻底丢失登录态）';
  }
  if (!first.leftover.includes(LegacyCredentialKey.cookie)) return '没记录待重试的键';

  // 重启后重跑
  const second = await restart();
  if (second.status !== 'migrated') return `重启后应为 migrated，实际 ${second.status}`;
  if (ksGet(CredentialKey.cookie) !== 'C_CRASH_WRITE') return '重启后凭据没迁过去';
  return rawStore().has(LegacyCredentialKey.cookie) ? '重启后明文没删掉' : true;
});

await check('崩溃@写 Keychain：写完回读校验不匹配 → failed，明文保留', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_CRASH_VERIFY');

  const api = await keychainApi();
  const origSet = api.setGenericPassword;
  const origGet = api.getGenericPassword;
  // 写入「成功」了，但读出来是别的东西（Keystore 偶发的静默损坏）
  api.setGenericPassword = async (username, password, options) => {
    const service = options?.service ?? 'default';
    ks().set(service, { username, password: 'CORRUPTED' });
    return { service };
  };
  let first;
  try {
    first = await restart();
  } finally {
    api.setGenericPassword = origSet;
    api.getGenericPassword = origGet;
  }

  const err = noFalseClean(first, ['failed'], '第一次');
  if (err) return err;
  // 写进去的值和明文不一致 => 绝不能删明文（那等于把用户凭据换成垃圾）
  if (rawStore().get(LegacyCredentialKey.cookie) !== 'C_CRASH_VERIFY') {
    return '回读校验失败却删了明文';
  }
  if (!first.error) return '没有给出失败原因';
  return shouldBlockAutoLogin(first) === true ? true : 'failed 没有拦下自动登录';
});

// ══════════════════════════════════════════════════════════════
// 三、崩溃在「删明文」阶段
// ══════════════════════════════════════════════════════════════

await check('崩溃@删明文：removeItem 抛错 → 凭据已进 Keychain，明文残留被如实报告', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_CRASH_DELETE');

  const restore = patch(AsyncStorageCjs, 'removeItem', async () => {
    throw new Error('disk full');
  });
  let first;
  try {
    first = await restart();
  } finally {
    restore();
  }

  if (first.status !== 'clear-failed') return `状态应为 clear-failed，实际 ${first.status}`;
  if (shouldBlockAutoLogin(first) !== true) return 'clear-failed 没有拦下自动登录';

  // 最重要的一条：凭据已经安全迁走，不能因为删失败就丢
  if (ksGet(CredentialKey.cookie) !== 'C_CRASH_DELETE') {
    return '删明文失败时把已迁移的凭据弄丢了';
  }
  if (!first.leftover.includes(LegacyCredentialKey.cookie)) return '没记录明文残留';

  // 重启后重跑：这次明文能删掉
  const second = await restart();
  if (second.status !== 'already-secure') {
    return `重启后应为 already-secure（安全存储已有值，只需清明文），实际 ${second.status}`;
  }
  if (rawStore().has(LegacyCredentialKey.cookie)) return '重启后明文没删掉';
  return ksGet(CredentialKey.cookie) === 'C_CRASH_DELETE' ? true : '重启后凭据被覆盖或丢了';
});

await check('崩溃@删明文：removeItem 静默失败（返回成功但没删）→ 回读发现残留', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_SILENT_FAIL');

  // 原生桥静默失败：Promise resolve 了，但磁盘上什么都没变
  const restore = patch(AsyncStorageCjs, 'removeItem', async () => null);
  let first;
  try {
    first = await restart();
  } finally {
    restore();
  }

  if (first.status !== 'clear-failed') {
    return `removeItem 的返回值不能当事实，状态应为 clear-failed，实际 ${first.status}`;
  }
  if (first.clearVerified !== false) return 'clearVerified 应为 false';
  if (first.cleared.includes(LegacyCredentialKey.cookie)) {
    return '把回读发现还在的键算进了 cleared';
  }
  // 凭据仍在安全存储里
  return ksGet(CredentialKey.cookie) === 'C_SILENT_FAIL' ? true : '迁移的凭据丢了';
});

await check('崩溃@删明文：回读校验抛错 → verify-failed，凭据不丢', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, 'TOK_CRASH_VERIFY');

  // 读取（第 1 次 multiGet）正常，校验（第 2 次）抛错
  let calls = 0;
  const realMultiGet = AsyncStorageCjs.multiGet;
  const restore = patch(AsyncStorageCjs, 'multiGet', async (keys) => {
    calls += 1;
    if (calls >= 2) throw new Error('verification read failed');
    return realMultiGet.call(AsyncStorageCjs, keys);
  });
  let first;
  try {
    first = await restart();
  } finally {
    restore();
  }

  if (first.status !== 'verify-failed') return `状态应为 verify-failed，实际 ${first.status}`;
  if (first.clearVerified !== false) return '校验失败却说 clearVerified=true';
  if (shouldBlockAutoLogin(first) !== true) return 'verify-failed 没有拦下自动登录';
  return ksGet(CredentialKey.gatewayToken) === 'TOK_CRASH_VERIFY'
    ? true
    : '校验失败时把已迁移的凭据弄丢了';
});

// ══════════════════════════════════════════════════════════════
// 四、每个阶段都注入一次「全存储不可用」，确认报告永不假 clean
// ══════════════════════════════════════════════════════════════

await check('全存储不可用（读和写同时坏）：报告为 read-failed，不是 clean', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_ALL_BROKEN');

  const api = await keychainApi();
  const origSet = api.setGenericPassword;
  const restoreMg = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('storage totally unavailable');
  });
  api.setGenericPassword = async () => {
    throw new Error('keystore unavailable');
  };
  let r;
  try {
    r = await restart();
  } finally {
    restoreMg();
    api.setGenericPassword = origSet;
  }

  const err = noFalseClean(r, ['read-failed'], '全存储不可用');
  if (err) return err;
  return shouldBlockAutoLogin(r) === true ? true : '没有拦下自动登录';
});

await check('安全存储不可用 + 明文可读：failed，明文保留待重试', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_SECURE_DOWN');

  const api = await keychainApi();
  const origSet = api.setGenericPassword;
  api.setGenericPassword = async () => {
    throw new Error('no keystore');
  };
  let first;
  try {
    first = await restart();
  } finally {
    api.setGenericPassword = origSet;
  }

  const err = noFalseClean(first, ['failed'], '安全存储不可用');
  if (err) return err;
  if (rawStore().get(LegacyCredentialKey.cookie) !== 'C_SECURE_DOWN') {
    return '安全存储不可用时把明文删了（用户下次启动就彻底没凭据了）';
  }

  // 重启后安全存储恢复 → 迁移成功
  const second = await restart();
  return second.status === 'migrated' && ksGet(CredentialKey.cookie) === 'C_SECURE_DOWN'
    ? true
    : `重启后应迁移成功，实际 ${second.status}`;
});

// ══════════════════════════════════════════════════════════════
// 五、反复中断的幂等性
// ══════════════════════════════════════════════════════════════

await check('连续三次中断在写阶段 → 凭据始终不丢，最终一次成功', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_REPEAT');
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, 'TOK_REPEAT');

  const api = await keychainApi();
  const origSet = api.setGenericPassword;

  for (let i = 0; i < 3; i += 1) {
    api.setGenericPassword = async () => {
      throw new Error(`crash #${i + 1}`);
    };
    let r;
    try {
      r = await restart();
    } finally {
      api.setGenericPassword = origSet;
    }
    if (r.status !== 'failed') return `第 ${i + 1} 次中断后状态应为 failed，实际 ${r.status}`;
    if (rawStore().get(LegacyCredentialKey.cookie) !== 'C_REPEAT') {
      return `第 ${i + 1} 次中断后明文丢了`;
    }
    if (rawStore().get(LegacyCredentialKey.gatewayToken) !== 'TOK_REPEAT') {
      return `第 ${i + 1} 次中断后 token 明文丢了`;
    }
  }

  // 第 4 次：存储正常
  const final = await restart();
  if (final.status !== 'migrated') return `最终应 migrated，实际 ${final.status}`;
  if (ksGet(CredentialKey.cookie) !== 'C_REPEAT') return '最终 cookie 没迁过去';
  if (ksGet(CredentialKey.gatewayToken) !== 'TOK_REPEAT') return '最终 token 没迁过去';
  return rawStore().size === 0 ? true : `最终仍有明文残留：${[...rawStore().keys()].join('、')}`;
});

await check('迁移完成后再遇读失败 → 仍报 read-failed（不假设上次删过就干净）', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_DONE');
  const first = await restart();
  if (first.status !== 'migrated') return `前置条件不成立：${first.status}`;

  // 重启后存储坏了 —— 但明文确实已经没了。此时读失败仍是 read-failed
  // （我们无法确认，这正是重点：不能假设「上次删过所以这次一定干净」）。
  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('storage broke after migration');
  });
  let second;
  try {
    second = await restart();
  } finally {
    restore();
  }

  if (second.status !== 'read-failed') {
    return `读失败应报 read-failed（不能假设上次删过这次就干净），实际 ${second.status}`;
  }
  // 但凭据本身必须好好地在安全存储里
  return ksGet(CredentialKey.cookie) === 'C_DONE' ? true : '已迁移的凭据被破坏了';
});

// ══════════════════════════════════════════════════════════════
// 六、不泄露凭据
// ══════════════════════════════════════════════════════════════

await check('崩溃报告（read-failed / verify-failed / clear-failed）都不含凭据值', async () => {
  const SECRET = '{{SECRET_crash01}}';
  const cases = [];

  // ① read-failed
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, SECRET);
  let restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('locked');
  });
  try {
    cases.push(await restart());
  } finally {
    restore();
  }

  // ② verify-failed
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, SECRET);
  let calls = 0;
  const realMultiGet = AsyncStorageCjs.multiGet;
  restore = patch(AsyncStorageCjs, 'multiGet', async (keys) => {
    calls += 1;
    if (calls >= 2) throw new Error('verify failed');
    return realMultiGet.call(AsyncStorageCjs, keys);
  });
  try {
    cases.push(await restart());
  } finally {
    restore();
  }

  // ③ clear-failed
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, SECRET);
  restore = patch(AsyncStorageCjs, 'removeItem', async () => {
    throw new Error('disk full');
  });
  try {
    cases.push(await restart());
  } finally {
    restore();
  }

  for (const r of cases) {
    const blob = JSON.stringify(r);
    if (blob.includes(SECRET)) {
      return `状态 ${r.status} 的报告里带出了凭据值（会进日志）`;
    }
  }
  return cases.length === 3 ? true : `只跑了 ${cases.length} 个场景`;
});

await check('崩溃后 shouldBlockAutoLogin 对每种失败态都返回 true', async () => {
  // 这是上层的安全闸门：任何「不确定」都不能放行自动登录。
  const statuses = ['read-failed', 'failed', 'clear-failed', 'verify-failed'];
  for (const status of statuses) {
    if (
      shouldBlockAutoLogin({
        status,
        readSucceeded: status !== 'read-failed',
        migrated: [],
        cleared: [],
        leftover: [],
        fromLastCookie: false,
        clearVerified: false,
      }) !== true
    ) {
      return `${status} 没有拦下自动登录`;
    }
  }
  return true;
});

await check('崩溃后恢复：shouldBlockAutoLogin 从 true 变回 false', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_RECOVER');

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('locked');
  });
  let broken;
  try {
    broken = await restart();
  } finally {
    restore();
  }
  if (shouldBlockAutoLogin(broken) !== true) return '中断时没有拦';

  const recovered = await restart();
  return shouldBlockAutoLogin(recovered) === false
    ? true
    : `恢复后（${recovered.status}）仍在拦自动登录`;
});

// ══════════════════════════════════════════════════════════════
// 七、clearLegacyCredentialStorageVerified 在崩溃场景下的结论
// ══════════════════════════════════════════════════════════════

await check('清除明文时回读失败 → verified=false（用户必须被告知没清干净）', async () => {
  reset();
  for (const k of ALL_LEGACY_KEYS) await AsyncStorageStub.setItem(k, `P_${k}`);

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('verification unavailable');
  });
  let r;
  try {
    r = await clearLegacyCredentialStorageVerified();
  } finally {
    restore();
  }

  if (r.verified !== false) return '回读失败却说 verified=true';
  // 无法确认时不能把键算成「已清理」
  return r.remaining.length > 0 || r.cleared.length === 0
    ? true
    : '无法确认却报告了 cleared（自相矛盾）';
});

await check('清除明文时部分键删不掉 → verified=false，且这些键进 remaining', async () => {
  reset();
  for (const k of ALL_LEGACY_KEYS) await AsyncStorageStub.setItem(k, `P_${k}`);

  const onlyStuck = ALL_LEGACY_KEYS[0];
  const realRemove = AsyncStorageCjs.removeItem;
  const restore = patch(AsyncStorageCjs, 'removeItem', async (key) => {
    if (key === onlyStuck) throw new Error('this key is stuck');
    return realRemove.call(AsyncStorageCjs, key);
  });
  let r;
  try {
    r = await clearLegacyCredentialStorageVerified();
  } finally {
    restore();
  }

  if (r.verified !== false) return '有键没删掉却说 verified=true';
  if (!r.remaining.includes(onlyStuck)) return '没把删不掉的键记进 remaining';
  if (r.cleared.includes(onlyStuck)) return '把删不掉的键算进了 cleared';
  // 其它三个键应该真的删掉了
  return r.cleared.length === ALL_LEGACY_KEYS.length - 1
    ? true
    : `cleared 应为 ${ALL_LEGACY_KEYS.length - 1} 个，实际 ${r.cleared.length}`;
});

await check('清除明文成功后再调用：verified=true 且没有残留', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'P');

  const first = await clearLegacyCredentialStorageVerified();
  if (first.verified !== true) return '第一次清理没确认成功';

  const second = await clearLegacyCredentialStorageVerified();
  if (second.verified !== true) return '已清空时仍报 verified=false';
  if (second.remaining.length !== 0) return '已清空却报有残留';
  // `cleared` 的语义是「回读确认不存在的键」，不是「本次删掉的键」——
  // removeItem 对不存在的键是幂等的，所以这里仍然会列出全部键。
  // 这正是 App.tsx 兼容版需要的语义（cleared.length === LEGACY_KEY_COUNT）。
  return second.cleared.length === ALL_LEGACY_KEYS.length
    ? true
    : `cleared 应列出所有确认不存在的键，实际 ${second.cleared.length}`;
});

await check('clearLegacyCredentialStorageVerified 不碰安全存储', async () => {
  reset();
  ks().set('com.dshpocket.credentials.dsh.cookie', { username: 'k', password: 'KEEP' });
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'PLAINTEXT');

  await clearLegacyCredentialStorageVerified();
  return ksGet(CredentialKey.cookie) === 'KEEP'
    ? true
    : '误删了安全存储里的凭据（这个函数只该清明文）';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
