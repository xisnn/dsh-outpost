/**
 * 旧版本明文凭据迁移的回归测试。
 *
 * ## 守什么
 *
 * v0.16.0 把 Cookie / 网关 token / device id 从 AsyncStorage 搬进了
 * Keychain，但**只搬了新写入的**。老版本升级上来的用户：
 *
 *   · 凭据还躺在 AsyncStorage 里（`@dsh/cookie` 等四个键）
 *   · 新版本只读 Keychain → 读不到 → 被踢回配对页，要重新扫码
 *   · 那几份明文**永远不会被删**
 *
 * 所以这组测试盯的是「升级路径」本身，而不是新装路径。
 *
 * ## 为什么必须驱动真实函数
 *
 * 迁移的正确性全在顺序上：先写安全存储 → 回读校验 → 再删明文。
 * 静态检查只能看到「有没有调用这几个函数」，看不出顺序对不对、
 * 失败时有没有误删。所以这里直接跑 `migrateLegacyCredentials()`，
 * 用内存版 AsyncStorage + Keychain 替身观察每一步的副作用。
 *
 * ## 关键断言
 *
 *   · 写入失败时**明文必须还在**（否则用户的登录态凭空消失）
 *   · 安全存储已有值时**不能覆盖**（可能比明文副本新）
 *   · 迁移成功后旧键必须为空（不留明文认证入口）
 *   · 重复调用不破坏有效凭据
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
 * Keychain 替身的状态直接读写 globalThis。
 *
 * ⚠️ 不能 require('./support/_keychain-shim.cjs') —— 产品代码经转译后
 * 走另一条模块解析路径，require 拿到的是**另一个实例**，状态不共享。
 */
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

const { CredentialKey } = await imp(path.join(__dirname, '..', 'src', 'core', 'secureStore.ts'));
const migration = await imp(
  path.join(__dirname, '..', 'src', 'core', 'credentialMigration.ts'),
);
const {
  migrateLegacyCredentials,
  clearLegacyCredentialStorage,
  clearLegacyCredentialStorageVerified,
  shouldBlockAutoLogin,
  ALL_LEGACY_KEYS,
  LegacyCredentialKey,
} = migration;

/**
 * 产品代码实际用的是 **CJS shim**（经 Module._resolveFilename 重定向）。
 *
 * ⚠️ 和 ESM 版 `async-storage-stub.mjs` 是**两个不同的对象**（虽然共享
 * 同一份 globalThis 存储）。要注入失败必须替换 CJS 那个的方法 ——
 * 替换 ESM 的不会影响产品代码（见 security-review-fixes-spec.mjs 的注释）。
 */
const AsyncStorageCjs = createRequire(import.meta.url)('./support/_async-storage-shim.cjs');

/** 临时替换一个方法，返回恢复函数（用例里一定要在 finally 里调用） */
function patch(obj, name, impl) {
  const orig = obj[name];
  obj[name] = impl;
  return () => {
    obj[name] = orig;
  };
}

/** 从 shim 里读当前存储（绕过被 patch 掉的方法） */
function rawStore() {
  if (!globalThis.__dshTestAsyncStorageState__) {
    globalThis.__dshTestAsyncStorageState__ = { store: new Map(), calls: [] };
  }
  return globalThis.__dshTestAsyncStorageState__.store;
}

/** 读 Keychain 替身模块（产品代码和测试共享同一个 CJS 实例） */
async function keychainApi() {
  const shim = await imp(path.join(__dirname, 'support', '_keychain-shim.cjs'));
  return shim.default ?? shim;
}

/** 每次用例前重置两个存储 */
function reset() {
  AsyncStorageStub.__reset();
  ksReset();
}

// ══════════════════════════════════════════════════════════════
// 一、全新安装
// ══════════════════════════════════════════════════════════════

await check('全新安装：没有历史凭据时不动任何存储', async () => {
  reset();
  const r = await migrateLegacyCredentials();
  if (r.status !== 'clean') return `状态应为 clean，实际 ${r.status}`;
  if (r.migrated.length !== 0) return '不该迁移任何东西';
  if (ks().size !== 0) return `安全存储被写了 ${ks().size} 项（不该碰）`;
  return Object.keys(AsyncStorageStub.__dump()).length === 0 ? true : 'AsyncStorage 被写了东西';
});

// ══════════════════════════════════════════════════════════════
// 二、从旧版本升级，只有明文凭据
// ══════════════════════════════════════════════════════════════

await check('升级：明文 cookie 迁进安全存储，明文被删除', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'COOKIE_PLAINTEXT_1');

  const r = await migrateLegacyCredentials();
  if (r.status !== 'migrated') return `状态应为 migrated，实际 ${r.status}`;
  if (ksGet(CredentialKey.cookie) !== 'COOKIE_PLAINTEXT_1') {
    return '安全存储里没有迁移后的 cookie';
  }
  const leftover = await AsyncStorageStub.getItem(LegacyCredentialKey.cookie);
  if (leftover !== null) return '明文 cookie 还在（明文认证入口没清掉）';
  return r.cleared.includes(LegacyCredentialKey.cookie) ? true : '报告里没记录清理项';
});

await check('升级：明文 token + deviceId 一起迁走', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C2');
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, 'TOKEN_PLAINTEXT_2');
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayDeviceId, 'dsh-outpost-legacy');

  const r = await migrateLegacyCredentials();
  if (r.status !== 'migrated') return `状态应为 migrated，实际 ${r.status}`;
  if (ksGet(CredentialKey.gatewayToken) !== 'TOKEN_PLAINTEXT_2') return 'token 没迁过去';
  if (ksGet(CredentialKey.gatewayDeviceId) !== 'dsh-outpost-legacy') return 'deviceId 没迁过去';

  // 三个明文键都必须空
  const dump = AsyncStorageStub.__dump();
  const stillThere = ALL_LEGACY_KEYS.filter((k) => k in dump);
  return stillThere.length === 0
    ? true
    : `明文还在：${stillThere.join('、')}`;
});

await check('升级：只有 lastCookie（旧版点过「断开连接」）→ 迁移但不自动登录', async () => {
  reset();
  // 旧版本 signOut 的行为：把 @dsh/cookie 复制到 @dsh/lastCookie 再删前者
  await AsyncStorageStub.setItem(LegacyCredentialKey.lastCookie, 'LAST_COOKIE_3');

  const r = await migrateLegacyCredentials();
  if (r.status !== 'migrated') return `状态应为 migrated，实际 ${r.status}`;
  if (!r.fromLastCookie) {
    return '没有标记 fromLastCookie（上层会误判成「当前登录态」而自动登录）';
  }
  if (ksGet(CredentialKey.cookie) !== 'LAST_COOKIE_3') return 'cookie 没迁过去';
  const leftover = await AsyncStorageStub.getItem(LegacyCredentialKey.lastCookie);
  return leftover === null ? true : 'lastCookie 明文还在（退出后残留的认证入口）';
});

await check('升级：cookie 和 lastCookie 同时存在 → 用 cookie，两份明文都删', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'CURRENT_COOKIE');
  await AsyncStorageStub.setItem(LegacyCredentialKey.lastCookie, 'OLDER_COOKIE');

  const r = await migrateLegacyCredentials();
  if (ksGet(CredentialKey.cookie) !== 'CURRENT_COOKIE') {
    return `应该优先用当前登录态，实际存了 ${ksGet(CredentialKey.cookie)}`;
  }
  if (r.fromLastCookie) return '不该标成 fromLastCookie（当前登录态才是真的）';
  const dump = AsyncStorageStub.__dump();
  const still = [LegacyCredentialKey.cookie, LegacyCredentialKey.lastCookie].filter(
    (k) => k in dump,
  );
  return still.length === 0 ? true : `明文还在：${still.join('、')}`;
});

// ══════════════════════════════════════════════════════════════
// 三、同时存在明文和安全存储凭据
// ══════════════════════════════════════════════════════════════

await check('共存：安全存储已有值时用安全存储的，明文只是删掉', async () => {
  reset();
  // 用户升级后重新配对过 → 安全存储里是**更新**的 cookie
  ks().set('com.dshpocket.credentials.dsh.cookie', {
    username: 'k',
    password: 'NEWER_COOKIE',
  });
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'STALE_COOKIE');

  const r = await migrateLegacyCredentials();
  if (ksGet(CredentialKey.cookie) !== 'NEWER_COOKIE') {
    return `覆盖了安全存储里更新的值（现在是 ${ksGet(CredentialKey.cookie)}）`;
  }
  if (r.status !== 'already-secure') return `状态应为 already-secure，实际 ${r.status}`;
  const leftover = await AsyncStorageStub.getItem(LegacyCredentialKey.cookie);
  return leftover === null ? true : '陈旧明文副本没删';
});

await check('共存：部分迁移（token 缺、cookie 已有）互不干扰', async () => {
  reset();
  ks().set('com.dshpocket.credentials.dsh.cookie', { username: 'k', password: 'EXISTING' });
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'OLD_C');
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, 'TOK_TO_MIGRATE');

  const r = await migrateLegacyCredentials();
  if (r.status !== 'migrated') return `状态应为 migrated，实际 ${r.status}`;
  if (ksGet(CredentialKey.cookie) !== 'EXISTING') return 'cookie 被覆盖了';
  if (ksGet(CredentialKey.gatewayToken) !== 'TOK_TO_MIGRATE') return 'token 没迁过去';
  const dump = AsyncStorageStub.__dump();
  return Object.keys(dump).length === 0 ? true : `明文残留：${Object.keys(dump).join('、')}`;
});

// ══════════════════════════════════════════════════════════════
// 四、迁移过程中安全存储写入失败
// ══════════════════════════════════════════════════════════════

await check('写入失败：不静默降级，明文保留待重试，报告 failed', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_MUST_SURVIVE');

  // 让 Keystore 的写入直接抛错（模拟锁屏方式变更导致密钥失效）
  const store = ks();
  const realSet = store.set.bind(store);
  let broken = true;
  globalThis.__dshKeychainSetHook = () => {
    if (broken) throw new Error('keystore unavailable');
    return false;
  };
  // 通过替换 shim 的 setGenericPassword 行为来注入失败
  const shim = await imp(path.join(__dirname, 'support', '_keychain-shim.cjs'));
  const shimApi = shim.default ?? shim;
  const origSet = shimApi.setGenericPassword;
  shimApi.setGenericPassword = async () => {
    throw new Error('keystore unavailable');
  };
  // 让「可用性探测」也失败 —— 真实场景里两者一起坏
  const origGet = shimApi.getGenericPassword;
  shimApi.getGenericPassword = async () => false;

  try {
    const r = await migrateLegacyCredentials();
    if (r.status !== 'failed') return `状态应为 failed，实际 ${r.status}`;
    if (!r.error) return '没有给出失败原因';
    // 关键：明文必须还在，不能被删掉
    const leftover = await AsyncStorageStub.getItem(LegacyCredentialKey.cookie);
    if (leftover !== 'C_MUST_SURVIVE') {
      return '明文被删了 —— 写入失败还删明文等于让用户丢失登录态';
    }
    // 报告里不能出现凭据值
    const blob = JSON.stringify(r);
    if (blob.includes('C_MUST_SURVIVE')) {
      return '迁移报告里泄露了凭据值（会进日志）';
    }
    return r.leftover.includes(LegacyCredentialKey.cookie) ? true : '没记录待重试的键';
  } finally {
    shimApi.setGenericPassword = origSet;
    shimApi.getGenericPassword = origGet;
    broken = false;
    void realSet;
    void globalThis.__dshKeychainSetHook;
  }
});

await check('安全存储不可用：报告 failed 且不碰明文', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, 'TOK_KEEP');

  const shim = await imp(path.join(__dirname, 'support', '_keychain-shim.cjs'));
  const shimApi = shim.default ?? shim;
  const origSet = shimApi.setGenericPassword;
  shimApi.setGenericPassword = async () => {
    throw new Error('no keystore');
  };
  try {
    const r = await migrateLegacyCredentials();
    if (r.status !== 'failed') return `状态应为 failed，实际 ${r.status}`;
    const leftover = await AsyncStorageStub.getItem(LegacyCredentialKey.gatewayToken);
    return leftover === 'TOK_KEEP' ? true : '安全存储不可用时把明文删了';
  } finally {
    shimApi.setGenericPassword = origSet;
  }
});

// ══════════════════════════════════════════════════════════════
// 五、迁移成功后再次启动
// ══════════════════════════════════════════════════════════════

await check('迁移成功后再启动：幂等，不重复迁移也不破坏凭据', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'IDEMPOTENT_C');

  const first = await migrateLegacyCredentials();
  if (first.status !== 'migrated') return `第一次应为 migrated，实际 ${first.status}`;

  const tokenAfterFirst = ksGet(CredentialKey.cookie);
  if (tokenAfterFirst !== 'IDEMPOTENT_C') return '第一次迁移后凭据不对';

  // 第二次启动
  const second = await migrateLegacyCredentials();
  if (second.status !== 'clean') return `第二次应为 clean，实际 ${second.status}`;
  if (ksGet(CredentialKey.cookie) !== 'IDEMPOTENT_C') return '第二次启动破坏了凭据';

  // 第三次也一样
  const third = await migrateLegacyCredentials();
  return third.status === 'clean' && ksGet(CredentialKey.cookie) === 'IDEMPOTENT_C'
    ? true
    : '重复调用不稳定';
});

await check('迁移成功后重试失败用例不会误删凭据', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'ONCE');
  await migrateLegacyCredentials();

  // 模拟「又跑了一遍迁移，但这次安全存储挂了」——
  // 此时已经没明文了，不该做任何事，更不该清掉已有的安全凭据。
  const shim = await imp(path.join(__dirname, 'support', '_keychain-shim.cjs'));
  const shimApi = shim.default ?? shim;
  const origSet = shimApi.setGenericPassword;
  shimApi.setGenericPassword = async () => {
    throw new Error('keystore unavailable');
  };
  try {
    const r = await migrateLegacyCredentials();
    if (r.status !== 'clean') return `应为 clean（没有明文可迁），实际 ${r.status}`;
    return ksGet(CredentialKey.cookie) === 'ONCE' ? true : '有效凭据被破坏了';
  } finally {
    shimApi.setGenericPassword = origSet;
  }
});

// ══════════════════════════════════════════════════════════════
// 六、退出登录后再次启动
// ══════════════════════════════════════════════════════════════

await check('退出登录后重启：凭据仍在安全存储，明文不复活', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'SIGNOUT_C');
  await migrateLegacyCredentials();

  // 「断开连接」不清凭据（这是设计），所以重启后应该还能读到
  const r = await migrateLegacyCredentials();
  if (r.status !== 'clean') return `重启时应为 clean，实际 ${r.status}`;
  if (ksGet(CredentialKey.cookie) !== 'SIGNOUT_C') {
    return '断开连接后凭据丢了（应该保留，下次自动恢复）';
  }
  // 明文不能因为「重启 + 迁移」而重新出现
  return (await AsyncStorageStub.getItem(LegacyCredentialKey.cookie)) === null
    ? true
    : '明文复活了';
});

// ══════════════════════════════════════════════════════════════
// 七、彻底清除授权后检查残留存储
// ══════════════════════════════════════════════════════════════

await check('彻底清除授权：安全存储 + 全部历史明文键都为空', async () => {
  reset();
  // 造一个「迁移失败过」的状态：安全存储有 cookie，明文也有残留
  ks().set('com.dshpocket.credentials.dsh.cookie', { username: 'k', password: 'X' });
  ks().set('com.dshpocket.credentials.dsh.gatewayToken', { username: 'k', password: 'Y' });
  ks().set('com.dshpocket.credentials.dsh.gatewayDeviceId', { username: 'k', password: 'Z' });
  for (const k of ALL_LEGACY_KEYS) {
    await AsyncStorageStub.setItem(k, `LEFTOVER_${k}`);
  }

  const { clearAllCredentialStorage } = migration;
  await clearAllCredentialStorage();

  if (ks().size !== 0) {
    return `安全存储还有 ${ks().size} 项：${[...ks().keys()].join('、')}`;
  }
  const dump = AsyncStorageStub.__dump();
  const still = ALL_LEGACY_KEYS.filter((k) => k in dump);
  return still.length === 0 ? true : `明文残留：${still.join('、')}`;
});

await check('clearLegacyCredentialStorage 只清明文，不碰安全存储', async () => {
  reset();
  ks().set('com.dshpocket.credentials.dsh.cookie', { username: 'k', password: 'KEEP_ME' });
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'PLAINTEXT');

  const cleared = await clearLegacyCredentialStorage();
  if (!cleared.includes(LegacyCredentialKey.cookie)) return '没有清理明文键';
  if (ksGet(CredentialKey.cookie) !== 'KEEP_ME') {
    return '误删了安全存储里的凭据（这个函数只该清明文）';
  }
  return (await AsyncStorageStub.getItem(LegacyCredentialKey.cookie)) === null
    ? true
    : '明文没清掉';
});

// ══════════════════════════════════════════════════════════════
// 八、不得泄露凭据
// ══════════════════════════════════════════════════════════════

await check('迁移报告不含任何凭据值', async () => {
  reset();
  const SECRET_COOKIE = 'SUPER_SECRET_COOKIE_VALUE_9f3a';
  const SECRET_TOKEN = 'SUPER_SECRET_TOKEN_VALUE_7b2c';
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, SECRET_COOKIE);
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, SECRET_TOKEN);

  const r = await migrateLegacyCredentials();
  const blob = JSON.stringify(r);
  if (blob.includes(SECRET_COOKIE) || blob.includes(SECRET_TOKEN)) {
    return '报告里带出了凭据值';
  }
  return r.status === 'migrated' ? true : `状态不对：${r.status}`;
});

await check('失败报告里也不含凭据值', async () => {
  reset();
  const SECRET = 'SECRET_IN_FAILURE_PATH_1a2b';
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, SECRET);

  const shim = await imp(path.join(__dirname, 'support', '_keychain-shim.cjs'));
  const shimApi = shim.default ?? shim;
  const origSet = shimApi.setGenericPassword;
  shimApi.setGenericPassword = async () => {
    throw new Error('keystore unavailable');
  };
  try {
    const r = await migrateLegacyCredentials();
    const blob = JSON.stringify(r);
    if (blob.includes(SECRET)) return '失败报告里带出了凭据值';
    return r.status === 'failed' ? true : `状态不对：${r.status}`;
  } finally {
    shimApi.setGenericPassword = origSet;
  }
});

// ══════════════════════════════════════════════════════════════
// 九、P1-3：区分「确认没有」和「读不到」
//
// 这一组守的是**报告诚实性**：旧实现在 multiGet 抛错时直接返回默认报告，
// 而默认 status 是 'clean' —— 「存储读不出来」被报成了「确认没有明文」。
// 未知被当成干净，上层就会放心地自动登录，明文继续躺在磁盘上。
// ══════════════════════════════════════════════════════════════

await check('P1-3：multiGet 抛错 → read-failed，绝不报 clean', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_HIDDEN');

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('database is locked');
  });
  try {
    const r = await migrateLegacyCredentials();
    // 核心断言：不能是 clean
    if (r.status === 'clean') {
      return '读失败被报成了 clean —— 会把「未知」当成「确认没有明文凭据」';
    }
    if (r.status !== 'read-failed') return `状态应为 read-failed，实际 ${r.status}`;
    if (r.readSucceeded !== false) return 'readSucceeded 应为 false';
    if (!r.error) return '没有给出失败原因';
    // 读失败时绝不能谎称删过东西
    if (r.cleared.length > 0) return '读都读不到，却报告「已清理」';
    // 明文必须原封不动（我们根本没碰它）
    return (await AsyncStorageCjs.getItem(LegacyCredentialKey.cookie)) === 'C_HIDDEN'
      ? true
      : '读失败却把明文动了（不该发生）';
  } finally {
    restore();
  }
});

await check('P1-3：read-failed 时不应写安全存储', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_HIDDEN_2');

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('storage unavailable');
  });
  try {
    await migrateLegacyCredentials();
    // 读不到明文就没法迁移；此时碰安全存储只会写进垃圾
    return ks().size === 0 ? true : `安全存储被写了 ${ks().size} 项（读失败时不该碰）`;
  } finally {
    restore();
  }
});

await check('P1-3：读失败 + 安全存储已有凭据 → 仍是 read-failed（不被 already-secure 吞掉）', async () => {
  reset();
  // 用户早已重新配对过，Keychain 里有值；但明文存储这次读不出来
  ks().set('com.dshpocket.credentials.dsh.cookie', { username: 'k', password: 'NEW_COOKIE' });

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('database is locked');
  });
  try {
    const r = await migrateLegacyCredentials();
    if (r.status !== 'read-failed') return `状态应为 read-failed，实际 ${r.status}`;
    if (r.readSucceeded !== false) return 'readSucceeded 应为 false';
    // 安全存储里的值不能被动
    return ksGet(CredentialKey.cookie) === 'NEW_COOKIE'
      ? true
      : '安全存储里的有效凭据被改了';
  } finally {
    restore();
  }
});

await check('P1-3：read-failed 的报告不含凭据值', async () => {
  reset();
  const SECRET = '{{SECRET_readfail01}}';
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, SECRET);

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    // 异常信息里故意带上「可能的内容」，报告不能把它原样透出来
    throw new Error(`read failed while loading ${SECRET}`);
  });
  try {
    const r = await migrateLegacyCredentials();
    const blob = JSON.stringify(r);
    if (blob.includes(SECRET)) return 'read-failed 报告里带出了凭据值';
    return r.status === 'read-failed' ? true : `状态不对：${r.status}`;
  } finally {
    restore();
  }
});

// ══════════════════════════════════════════════════════════════
// 十、P1-3：删除的回读校验
// ══════════════════════════════════════════════════════════════

await check('P1-3：removeItem 抛错 → clear-failed，明文仍在', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_STUCK');

  const restore = patch(AsyncStorageCjs, 'removeItem', async () => {
    throw new Error('disk full');
  });
  try {
    const r = await migrateLegacyCredentials();
    // 凭据已经安全迁走了，但明文副本删不掉
    if (r.status !== 'clear-failed') return `状态应为 clear-failed，实际 ${r.status}`;
    if (r.clearVerified !== false) return '删失败却说 verified=true';
    if (r.cleared.includes(LegacyCredentialKey.cookie)) {
      return '报告里把「没删掉」的键算进了 cleared（撒谎）';
    }
    if (!r.leftover.includes(LegacyCredentialKey.cookie)) return '没记录明文残留';
    // 关键：凭据不能丢（已迁进安全存储）
    if (ksGet(CredentialKey.cookie) !== 'C_STUCK') return '迁移的凭据丢了';
    // 明文确实还在
    return rawStore().get(LegacyCredentialKey.cookie) === 'C_STUCK'
      ? true
      : '测试前提不成立：明文本该还在';
  } finally {
    restore();
  }
});

await check('P1-3：removeItem 报成功但键还在（静默失败）→ 回读发现残留，clear-failed', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_SILENT');

  // 模拟「原生桥静默失败」：removeItem 返回成功，实际什么都没删
  const restore = patch(AsyncStorageCjs, 'removeItem', async () => null);
  try {
    const r = await migrateLegacyCredentials();
    if (r.status !== 'clear-failed') {
      return `回读必须发现残留，实际状态 ${r.status}（removeItem 的返回值不能当事实）`;
    }
    if (r.clearVerified !== false) return 'verifed 应为 false';
    if (r.cleared.includes(LegacyCredentialKey.cookie)) {
      return '把「回读发现还在」的键算进了 cleared';
    }
    return r.leftover.includes(LegacyCredentialKey.cookie)
      ? true
      : '没把残留键记进 leftover';
  } finally {
    restore();
  }
});

await check('P1-3：删除后的回读校验抛错 → verify-failed（不谎称已删干净）', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_UNVERIFIABLE');

  // 第一次 multiGet（读取）正常，第二次（校验）抛错
  let call = 0;
  const realMultiGet = AsyncStorageCjs.multiGet;
  const restore = patch(AsyncStorageCjs, 'multiGet', async (keys) => {
    call += 1;
    if (call >= 2) throw new Error('verification read failed');
    return realMultiGet.call(AsyncStorageCjs, keys);
  });
  try {
    const r = await migrateLegacyCredentials();
    if (r.status !== 'verify-failed') return `状态应为 verify-failed，实际 ${r.status}`;
    if (r.clearVerified !== false) return '校验失败却说 verified=true';
    if (!r.error) return '没有给出失败原因';
    // 凭据本身不能丢
    return ksGet(CredentialKey.cookie) === 'C_UNVERIFIABLE'
      ? true
      : '迁移的凭据丢了';
  } finally {
    restore();
  }
});

await check('P1-3：clean 必须带 clearVerified（成功路径确实校验过）', async () => {
  reset();
  const r = await migrateLegacyCredentials();
  if (r.status !== 'clean') return `状态应为 clean，实际 ${r.status}`;
  if (r.readSucceeded !== true) return '读取成功时 readSucceeded 应为 true';
  // clean 路径也走过回读校验（确认「真的没有」）
  return r.clearVerified === true ? true : 'clean 却没有经过回读校验';
});

await check('P1-3：迁移成功后 clearVerified=true 且 cleared 与事实一致', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_OK');
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, 'TOK_OK');

  const r = await migrateLegacyCredentials();
  if (r.status !== 'migrated') return `状态应为 migrated，实际 ${r.status}`;
  if (r.clearVerified !== true) return ' migrated 却说 clearVerified=false';
  if (r.readSucceeded !== true) return 'readSucceeded 应为 true';
  if (r.leftover.length !== 0) return `不该有 leftover：${r.leftover.join('、')}`;
  // cleared 里的键在磁盘上必须真的是空的
  const still = [...rawStore().keys()].filter((k) => ALL_LEGACY_KEYS.includes(k));
  return still.length === 0 ? true : `报告说清了，实际还在：${still.join('、')}`;
});

// ══════════════════════════════════════════════════════════════
// 十一、P1-3：shouldBlockAutoLogin 的判定
// ══════════════════════════════════════════════════════════════

await check('P1-3：shouldBlockAutoLogin 拦截所有「不确定 / 明文暴露」的状态', async () => {
  const mustBlock = ['read-failed', 'failed', 'verify-failed', 'clear-failed'];
  for (const status of mustBlock) {
    const blocked = shouldBlockAutoLogin({
      status,
      readSucceeded: false,
      migrated: [],
      cleared: [],
      leftover: [],
      fromLastCookie: false,
      clearVerified: false,
    });
    if (!blocked) return `状态 ${status} 应该拦下自动登录，实际放行了`;
  }
  return true;
});

await check('P1-3：shouldBlockAutoLogin 不拦成功态', async () => {
  for (const status of ['clean', 'migrated', 'already-secure']) {
    const blocked = shouldBlockAutoLogin({
      status,
      readSucceeded: true,
      migrated: [],
      cleared: [],
      leftover: [],
      fromLastCookie: false,
      clearVerified: true,
    });
    if (blocked) return `状态 ${status} 是成功态，不该拦自动登录`;
  }
  return true;
});

await check('P1-3：真实 read-failed 报告必须被 shouldBlockAutoLogin 拦下', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_REAL');

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('database is locked');
  });
  try {
    const r = await migrateLegacyCredentials();
    return shouldBlockAutoLogin(r) === true
      ? true
      : `${r.status} 的报告没有拦下自动登录（fail-open）`;
  } finally {
    restore();
  }
});

await check('P1-3：真实成功报告不会被误拦', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'C_FINE');
  const r = await migrateLegacyCredentials();
  return shouldBlockAutoLogin(r) === false
    ? true
    : `${r.status} 是成功态，不该拦自动登录`;
});

await check('P1-3：fromLastCookie 语义未被改动（迁移成功仍标记）', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.lastCookie, 'LAST_ONLY');

  const r = await migrateLegacyCredentials();
  if (r.status !== 'migrated') return `状态应为 migrated，实际 ${r.status}`;
  if (!r.fromLastCookie) return 'fromLastCookie 语义被破坏了';
  // 成功态不该拦（是否自动登录由 fromLastCookie 单独决定）
  return shouldBlockAutoLogin(r) === false ? true : 'fromLastCookie 成功态被误拦';
});

// ══════════════════════════════════════════════════════════════
// 十二、P1-3：clearLegacyCredentialStorageVerified
// ══════════════════════════════════════════════════════════════

await check('P1-3：clearLegacyCredentialStorageVerified 成功时 verified=true', async () => {
  reset();
  for (const k of ALL_LEGACY_KEYS) await AsyncStorageStub.setItem(k, `PLAINTEXT_${k}`);

  const r = await clearLegacyCredentialStorageVerified();
  if (r.verified !== true) return '删成功却报 verified=false';
  if (r.remaining.length !== 0) return `不该有 remaining：${r.remaining.join('、')}`;
  if (r.cleared.length !== ALL_LEGACY_KEYS.length) {
    return `cleared 应含全部 ${ALL_LEGACY_KEYS.length} 个键，实际 ${r.cleared.length}`;
  }
  return rawStore().size === 0 ? true : '磁盘上仍有明文键';
});

await check('P1-3：clearLegacyCredentialStorageVerified 删失败时 verified=false', async () => {
  reset();
  for (const k of ALL_LEGACY_KEYS) await AsyncStorageStub.setItem(k, `PLAINTEXT_${k}`);

  const restore = patch(AsyncStorageCjs, 'removeItem', async () => {
    throw new Error('disk full');
  });
  try {
    const r = await clearLegacyCredentialStorageVerified();
    if (r.verified !== false) return '删失败却说 verified=true';
    // 回读仍能看到全部键
    if (r.remaining.length !== ALL_LEGACY_KEYS.length) {
      return `remaining 应含全部键，实际 ${r.remaining.length}`;
    }
    if (r.cleared.length !== 0) return '删失败却报告了 cleared';
    return true;
  } finally {
    restore();
  }
});

await check('P1-3：clearLegacyCredentialStorageVerified 回读失败时 verified=false', async () => {
  reset();
  for (const k of ALL_LEGACY_KEYS) await AsyncStorageStub.setItem(k, `P_${k}`);

  const restore = patch(AsyncStorageCjs, 'multiGet', async () => {
    throw new Error('verification read failed');
  });
  try {
    const r = await clearLegacyCredentialStorageVerified();
    // 无法确认 => 不能说 verified
    return r.verified === false ? true : '回读失败却说 verified=true（无法确认就报成功）';
  } finally {
    restore();
  }
});

await check('P1-3：兼容版 clearLegacyCredentialStorage 仍返回键名数组', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'P');
  await AsyncStorageStub.setItem(LegacyCredentialKey.gatewayToken, 'Q');

  const cleared = await clearLegacyCredentialStorage();
  // App.tsx 依赖 `cleared.length === LEGACY_KEY_COUNT`
  if (!Array.isArray(cleared)) return '返回值不再是数组（破坏 App.tsx 兼容性）';
  if (cleared.length !== ALL_LEGACY_KEYS.length) {
    return `应返回 ${ALL_LEGACY_KEYS.length} 个键，实际 ${cleared.length}`;
  }
  return cleared.includes(LegacyCredentialKey.cookie) ? true : '缺少键名';
});

await check('P1-3：兼容版在删失败时不再谎报成功（返回空/短数组）', async () => {
  reset();
  await AsyncStorageStub.setItem(LegacyCredentialKey.cookie, 'P');

  const restore = patch(AsyncStorageCjs, 'removeItem', async () => {
    throw new Error('disk full');
  });
  try {
    const cleared = await clearLegacyCredentialStorage();
    // 旧实现这里会返回全部 4 个键（因为只 catch 不检查），上层误判成清干净了
    return cleared.length === 0
      ? true
      : `删失败却返回了 ${cleared.length} 个「已清理」键（谎报成功）`;
  } finally {
    restore();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
