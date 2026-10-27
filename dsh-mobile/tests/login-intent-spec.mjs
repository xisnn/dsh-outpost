/**
 * 登录意图持久化 —— 用户「主动断开」的决定必须跨重启保持。
 *
 * ## 守什么
 *
 * 旧版本 `signOut()` 会把 `@dsh/cookie` **复制**到 `@dsh/lastCookie`
 * 再删原键，用于「退出后一键恢复」。
 *
 * 上一轮的修复方式是：迁移时把 lastCookie 搬进 Keychain，标记
 * `fromLastCookie=true`，启动时不自动登录。但那个标记是**一次性函数
 * 返回值**，而迁移会删掉 lastCookie —— 于是第二次启动时
 * `fromLastCookie` 变成 false，用户「我主动断开过」的决定被推翻。
 *
 * 这一组测试验证现在的实现（core/loginIntent.ts）能在**任意次重启**
 * 后保持用户意图。
 *
 * ## 测的是真实产品函数
 *
 * 直接 import `src/core/loginIntent.ts`，用 AsyncStorage 的内存替身，
 * 通过 `__resetLoginIntentCache()` 模拟「App 重启」（丢内存缓存）。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

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
/**
 * 产品代码走的是 CJS shim（经 Module._resolveFilename 重定向）。
 * 注入失败必须替换**这一份**，替换 ESM 版不会影响产品代码（踩过）。
 */
const AsyncStorageCjs = createRequire(import.meta.url)('./support/_async-storage-shim.cjs');

const {
  loadLoginIntent,
  setLoginIntent,
  clearLoginIntent,
  __resetLoginIntentCache,
} = await imp(path.join(__dirname, '..', 'src', 'core', 'loginIntent.ts'));

const INTENT_KEY = '@dsh/loginIntent';

/** 模拟 App 重启：清空内存缓存，强制下次从存储读 */
function restartApp() {
  __resetLoginIntentCache();
}

function reset() {
  AsyncStorageStub.__reset();
  __resetLoginIntentCache();
}

// ══════════════════════════════════════════════════════════════
// 一、基本语义
// ══════════════════════════════════════════════════════════════

await check('全新安装（没有记录）→ active（升级兼容）', async () => {
  reset();
  const v = await loadLoginIntent();
  return v === 'active'
    ? true
    : `期望 active（存量用户升级不该被踢到配对页），实际 ${v}`;
});

await check('写 signed-out 后能读回来', async () => {
  reset();
  const okWrite = await setLoginIntent('signed-out');
  if (!okWrite) return '写入返回 false';
  restartApp();
  const v = await loadLoginIntent();
  return v === 'signed-out' ? true : `期望 signed-out，实际 ${v}`;
});

await check('写 active 后能读回来', async () => {
  reset();
  await setLoginIntent('active');
  restartApp();
  const v = await loadLoginIntent();
  return v === 'active' ? true : `期望 active，实际 ${v}`;
});

// ══════════════════════════════════════════════════════════════
// 二、核心：跨**多次**重启保持（上一轮的真实缺陷）
// ══════════════════════════════════════════════════════════════

await check('核心：主动断开后，连续 3 次重启都保持 signed-out', async () => {
  reset();

  // 用户主动断开
  await setLoginIntent('signed-out');

  // 第 1/2/3 次重启
  for (let i = 1; i <= 3; i += 1) {
    restartApp();
    const v = await loadLoginIntent();
    if (v !== 'signed-out') {
      return `第 ${i} 次重启后变成了 ${v} —— 用户的退出决定被程序推翻`;
    }
  }
  return true;
});

await check('核心：断开 → 点「直接继续」→ 后续重启都自动登录', async () => {
  reset();

  await setLoginIntent('signed-out');
  restartApp();
  if ((await loadLoginIntent()) !== 'signed-out') return '前置条件不成立';

  // 用户点「直接继续」（resumePairing 会写 active）
  await setLoginIntent('active');

  for (let i = 1; i <= 3; i += 1) {
    restartApp();
    const v = await loadLoginIntent();
    if (v !== 'active') {
      return `第 ${i} 次重启后变成了 ${v} —— 用户已经选择继续，却又被挡住`;
    }
  }
  return true;
});

await check('核心：彻底清除后重启，保持不自动登录', async () => {
  reset();
  await setLoginIntent('active');

  // 彻底清除授权（clearAuthorization 会写 signed-out）
  await setLoginIntent('signed-out');

  restartApp();
  const v = await loadLoginIntent();
  return v === 'signed-out' ? true : `清除后重启变成了 ${v}`;
});

// ══════════════════════════════════════════════════════════════
// 三、读失败必须 fail-closed
// ══════════════════════════════════════════════════════════════

await check('读存储抛异常 → unknown（不自动登录）', async () => {
  reset();
  await setLoginIntent('active');

  const orig = AsyncStorageCjs.getItem;
  AsyncStorageCjs.getItem = async () => {
    throw new Error('storage unavailable');
  };
  let v;
  try {
    restartApp();
    v = await loadLoginIntent();
  } finally {
    AsyncStorageCjs.getItem = orig;
  }
  return v === 'unknown'
    ? true
    : `期望 unknown（fail-closed），实际 ${v} —— 读失败被当成了「已登录」`;
});

await check('读失败**不缓存**：存储恢复后能读到真实状态', async () => {
  reset();
  await setLoginIntent('signed-out');

  const orig = AsyncStorageCjs.getItem;
  let failed = false;
  AsyncStorageCjs.getItem = async () => {
    if (!failed) {
      failed = true;
      throw new Error('storage unavailable');
    }
    return orig.call(AsyncStorageCjs, INTENT_KEY);
  };
  try {
    restartApp();
    const first = await loadLoginIntent();
    if (first !== 'unknown') return `第一次应为 unknown，实际 ${first}`;
    // 存储恢复
    const second = await loadLoginIntent();
    if (second !== 'signed-out') {
      return `存储恢复后应读到 signed-out，实际 ${second} —— 读失败被缓存了`;
    }
    return true;
  } finally {
    AsyncStorageCjs.getItem = orig;
  }
});

await check('非法 JSON → unknown（不自动登录）', async () => {
  reset();
  await AsyncStorageStub.setItem(INTENT_KEY, 'not-json{{{');
  restartApp();
  const v = await loadLoginIntent();
  return v === 'unknown' ? true : `期望 unknown，实际 ${v}`;
});

await check('结构不对（缺 status）→ unknown', async () => {
  reset();
  await AsyncStorageStub.setItem(INTENT_KEY, JSON.stringify({ foo: 'bar' }));
  restartApp();
  const v = await loadLoginIntent();
  return v === 'unknown' ? true : `期望 unknown，实际 ${v}`;
});

await check('status 是未知值 → unknown', async () => {
  reset();
  await AsyncStorageStub.setItem(INTENT_KEY, JSON.stringify({ status: 'whatever' }));
  restartApp();
  const v = await loadLoginIntent();
  return v === 'unknown' ? true : `期望 unknown，实际 ${v}`;
});

// ══════════════════════════════════════════════════════════════
// 四、写入可靠性（崩溃 / 部分写入）
// ══════════════════════════════════════════════════════════════

await check('写失败 → 返回 false（调用方必须能感知）', async () => {
  reset();
  const orig = AsyncStorageCjs.setItem;
  AsyncStorageCjs.setItem = async () => {
    throw new Error('disk full');
  };
  let r;
  try {
    r = await setLoginIntent('signed-out');
  } finally {
    AsyncStorageCjs.setItem = orig;
  }
  return r === false ? true : '写失败却返回 true —— 界面会误报「已断开」';
});

await check('写「成功」但实际没落盘 → 回读校验发现并返回 false', async () => {
  reset();
  // 模拟部分机型的行为：setItem 不抛错但没真的写
  const orig = AsyncStorageCjs.setItem;
  AsyncStorageCjs.setItem = async () => null;
  let r;
  try {
    r = await setLoginIntent('signed-out');
  } finally {
    AsyncStorageCjs.setItem = orig;
  }
  return r === false
    ? true
    : '没落盘却返回 true —— 用户以为断开了，下次启动会直接登录';
});

await check('clearLoginIntent 之后读回 active（升级兼容语义）', async () => {
  reset();
  await setLoginIntent('signed-out');
  await clearLoginIntent();
  restartApp();
  const v = await loadLoginIntent();
  return v === 'active'
    ? true
    : `删键后应回到 active（升级兼容语义），实际 ${v}`;
});

// ══════════════════════════════════════════════════════════════
// 五、App.tsx 接线（静态检查 —— 这些分支无法在 Node 里跑）
// ══════════════════════════════════════════════════════════════

const appSrc = readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

await check('App 启动用持久化意图判断，而不是只用 fromLastCookie', () => {
  if (!/loadLoginIntent\(\)/.test(appSrc)) {
    return '启动流程没有读登录意图';
  }
  // 关键：autoResume 必须同时考虑持久化意图
  if (!/intentAllowsAutoLogin/.test(appSrc)) {
    return '自动登录判断没有用持久化意图';
  }
  // 不能只靠 fromLastCookie（那就是上一轮的 bug）
  if (/const autoResume = !migration\.fromLastCookie;\s*\n\s*if \(savedBase/.test(appSrc)) {
    return '仍然只靠 fromLastCookie 判断（第二次启动就会自动登录）';
  }
  return true;
});

await check('signOut 会把 signed-out 落盘', () => {
  const i = appSrc.indexOf('const signOut');
  if (i < 0) return '找不到 signOut';
  const body = appSrc.slice(i, i + 1200);
  if (!/setLoginIntent\('signed-out'\)/.test(body)) {
    return '断开连接没有持久化退出意图 —— 下次启动仍会自动登录';
  }
  return true;
});

await check('signOut 先落盘再改内存状态（崩在中间方向安全）', () => {
  const i = appSrc.indexOf('const signOut');
  const body = appSrc.slice(i, i + 1200);
  const persistIdx = body.indexOf("setLoginIntent('signed-out')");
  const setCookieIdx = body.indexOf('setCookie(undefined)');
  if (persistIdx < 0) return '没有落盘';
  if (setCookieIdx < 0) return '没有改内存状态';
  return persistIdx < setCookieIdx
    ? true
    : '先改内存再落盘 —— 崩在中间会「界面已退出但下次启动自动登录」';
});

await check('saveCookie 会把意图置回 active', () => {
  const i = appSrc.indexOf('const saveCookie');
  if (i < 0) return '找不到 saveCookie';
  const body = appSrc.slice(i, i + 1200);
  return /setLoginIntent\('active'\)/.test(body)
    ? true
    : '扫码配对后没把意图置回 active，下次启动会被当成「已断开」';
});

await check('saveCookie 先存凭据再写意图', () => {
  const i = appSrc.indexOf('const saveCookie');
  const body = appSrc.slice(i, i + 1200);
  const saveIdx = body.indexOf('saveCredential(CredentialKey.cookie');
  const intentIdx = body.indexOf("setLoginIntent('active')");
  if (saveIdx < 0) return '没有存凭据';
  if (intentIdx < 0) return '没有写意图';
  return saveIdx < intentIdx
    ? true
    : '先写 active 再存凭据 —— 崩在中间会「意图说已登录但没有凭据」';
});

await check('resumePairing 会把意图置回 active', () => {
  const i = appSrc.indexOf('const resumePairing');
  if (i < 0) return '找不到 resumePairing';
  const body = appSrc.slice(i, i + 1400);
  return /setLoginIntent\('active'\)/.test(body)
    ? true
    : '点「直接继续」后没置回 active —— 每次启动都要再点一次';
});

await check('clearAuthorization 不会用 clearLoginIntent 绕过安全检查', () => {
  const i = appSrc.indexOf('const clearAuthorization');
  if (i < 0) return '找不到 clearAuthorization';
  const body = appSrc.slice(i, i + 6000);
  // 只看**代码**，不看注释 —— 注释里解释「为什么不能用它」是正常的，
  // 一开始没排除注释，这条测试误报了。
  const codeOnly = body
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');
  // 删掉意图键会让 loadLoginIntent 返回 active（升级兼容），
  // 万一凭据没删干净就会自动登录回被清除的账号。
  if (/clearLoginIntent\(/.test(codeOnly)) {
    return '清除授权里调用了 clearLoginIntent —— 删键后读回 active，是 fail-open';
  }
  return /setLoginIntent\('signed-out'\)/.test(codeOnly)
    ? true
    : '清除授权后没写 signed-out，下次启动可能自动登录';
});

await check('凭据不存在时即使意图是 active 也不会登录', () => {
  // 启动条件是 `<地址> && savedCookie && autoResume`。
  //
  // v0.16.7 起地址变量叫 usableBase：它表示「校验通过、可以用的地址」
  // （地址不安全时为 null，同样不登录）。语义比 savedBase 更强，
  // 所以这里接受两者之一，但仍然**要求** cookie 与 autoResume 同时在场。
  const i = appSrc.indexOf('const autoResume');
  const body = appSrc.slice(i, i + 800);
  const hasBase = /(?:savedBase|usableBase)\s*&&\s*savedCookie/.test(body);
  const hasResume = /savedCookie\s*&&\s*autoResume/.test(body);
  if (!hasBase || !hasResume) {
    return '自动登录条件里没有同时检查地址、cookie 与意图';
  }
  // setAuthed(true) 必须落在这个条件分支里（不是无条件执行）
  const condIdx = body.indexOf('autoResume)');
  const authIdx = body.indexOf('setAuthed(true)');
  return authIdx > condIdx ? true : 'setAuthed(true) 不在自动登录条件分支内';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
