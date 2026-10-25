/**
 * P1-4：「清原生 cookie 容器」的结果必须可信。
 *
 * ## 要守的那个假成功
 *
 * 登录时 RN 原生层会把 `dsh-auth-*` 存进 CookieManager，和 Keystore 里
 * 那份是**两份独立的凭据**。所以「退出并清除所有授权」必须把原生容器
 * 也清掉 —— 否则下次启动 `readCookieFromJar()` 又会把它读回来。
 *
 * 旧实现返回 `boolean`，而 boolean 表达不了**三种完全不同**的处境：
 *
 *   · 清干净了              → true
 *   · 有残留                → false
 *   · 根本没法确认（读不出来）→ 旧代码 `catch {}` 之后保持 `ok = true` → **true**
 *
 * 第三种就是假成功：复核 `getAll()` 抛异常时，旧代码把「不确定」报成了
 * 「确认清干净」。用户点「清除授权」，界面说干净了，容器里其实还有一份
 * 可用的 cookie。
 *
 * ## 现在的契约（CookieCleanupResult）
 *
 *   · `{kind:'cleared'}`                  复核确认没有残留
 *   · `{kind:'unavailable', reason}`      原生模块**本身**加载不到 ——
 *                                         平台上不存在第二个存储，
 *                                         没有东西可清（不是残留问题）
 *   · `{kind:'partial', remaining}`       复核**确认**还有残留
 *   · `{kind:'unverified', reason}`       **无法确认** —— 绝不等于成功
 *
 * UI 依赖这个区分：
 *   - `unavailable`  → 不算问题（平台没有第二个存储）
 *   - `partial` / `unverified` → 必须告知用户「无法确认 cookie 缓存已清除」
 *
 * 所以本文件的重点是证明 **`unverified` 和 `unavailable` 可以被区分开**，
 * 且 `unverified` 永远不会被报成 `cleared`。
 *
 * 全部用例驱动**真实产品代码**（src/core/cookieJar.ts）。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

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

// ══════════════════════════════════════════════════════════════
// 「模块不可用」的模拟
//
// 产品代码用**动态 `import('@react-native-cookies/cookies')`** 加载原生模块，
// 拦截它必须用 ESM loader hook。`rn-module-hook.mjs` 已经把这个说明符
// 映射到测试替身；这里再注册一个**后注册、优先生效**的 hook 覆盖它，
// 让解析指向一个不存在的文件 —— 于是 import 抛错，产品代码走「模块
// 不可用」分支。
//
// ⚠️ 为什么不用 `globalThis.__flag` 之类在运行时翻转：
//    loader hook 跑在**独立线程**里，看不到主线程对 globalThis / process.env
//    的修改（实测确认过）。所以只能靠「开关文件」这种跨线程可见的信号。
// ══════════════════════════════════════════════════════════════

const ABSENT_FLAG = path.join(
  process.env.TEMP ?? process.env.TMP ?? __dirname,
  'dsh-cookie-spec-absent.flag',
);

/** 让下一次 import('@react-native-cookies/cookies') 解析到不存在的文件 */
function enableModuleAbsent() {
  fs.writeFileSync(ABSENT_FLAG, '1');
}
function disableModuleAbsent() {
  try {
    fs.unlinkSync(ABSENT_FLAG);
  } catch {
    /* 本来就没有 */
  }
}

{
  // 后注册的 hook 先执行 → 覆盖 rn-module-hook 的映射
  const overrideCode = `
import fs from 'node:fs';
const FLAG = ${JSON.stringify(ABSENT_FLAG)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@react-native-cookies/cookies') {
    if (fs.existsSync(FLAG)) {
      // 指向不存在的文件 → 动态 import 抛错 → 产品代码判「模块不可用」
      return { url: 'file:///dsh-test/definitely-absent-cookie-manager.cjs',
               shortCircuit: true, format: 'commonjs' };
    }
  }
  return nextResolve(specifier, context);
}
`;
  register('data:text/javascript,' + encodeURIComponent(overrideCode));
}

// ── 产品代码 ─────────────────────────────────────────────────

const cookieJar = await imp(path.join(__dirname, '..', 'src', 'core', 'cookieJar.ts'));
const { clearNativeCookieJar, clearNativeCookieJarDetailed } = cookieJar;

/** shim 里的 CookieManager（和产品代码共享同一份 jar） */
const cmMod = await imp(path.join(SHIM_DIR, '_cookie-manager-shim.cjs'));
const cm = cmMod.default ?? cmMod;

const BASE = 'http://127.0.0.1:9999';

/**
 * 故障注入作用域：所有替换都还原，避免一条用例污染后续用例。
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
          /* 还原失败只能继续 */
        }
      }
    },
    /** 让 CookieManager 的某个方法抛错 */
    breakMethod(name) {
      const orig = cm[name];
      cm[name] = async () => {
        throw new Error(`cookie manager ${name} failed`);
      };
      restores.push(() => {
        cm[name] = orig;
      });
    },
    /** 让某个方法抛指定错误码（验证错误码被保留但不含 cookie 值） */
    breakMethodWithCode(name, code) {
      const orig = cm[name];
      cm[name] = async () => {
        const e = new Error('native failure');
        e.code = code;
        throw e;
      };
      restores.push(() => {
        cm[name] = orig;
      });
    },
    /** 让某个方法「返回成功但什么也不做」（模拟部分机型的假成功） */
    noopMethod(name) {
      const orig = cm[name];
      cm[name] = async () => true;
      restores.push(() => {
        cm[name] = orig;
      });
    },
    /** 删掉某个方法（模拟平台没有这个 API） */
    removeMethod(name) {
      const had = name in cm;
      const orig = cm[name];
      delete cm[name];
      restores.push(() => {
        if (had) cm[name] = orig;
        else delete cm[name];
      });
    },
    /** 让某个方法在「复核」那次调用时抛错（前一次正常） */
    failOnNthCall(name, nth) {
      const orig = cm[name];
      let count = 0;
      cm[name] = async (...args) => {
        count += 1;
        if (count === nth) throw new Error(`cookie manager ${name} failed on call ${nth}`);
        return orig.apply(cm, args);
      };
      restores.push(() => {
        cm[name] = orig;
      });
    },
  };
}

function resetJar() {
  if (typeof cm.__reset === 'function') cm.__reset();
  else if (typeof cm.clearAll === 'function') void cm.clearAll();
}

/** 在容器里造一份 DSH cookie */
async function seedDshCookie(base = BASE) {
  await cm.set(base, { name: 'dsh-auth-test', value: 'v1.secret-value', path: '/' });
}

/** 数容器里还剩几个 dsh-auth* */
async function countDshCookies(base = BASE) {
  const all = await cm.get(base);
  return Object.keys(all ?? {}).filter((k) => k.startsWith('dsh-auth')).length;
}

/** 断言结果对象形状合法 */
function checkShape(r) {
  if (!r || typeof r !== 'object') return '返回值不是对象';
  const kinds = ['cleared', 'unavailable', 'partial', 'unverified'];
  if (!kinds.includes(r.kind)) return `未知的 kind：${r.kind}`;
  if (r.kind === 'unavailable' && typeof r.reason !== 'string') {
    return 'unavailable 必须带 reason';
  }
  if (r.kind === 'unverified' && typeof r.reason !== 'string') {
    return 'unverified 必须带 reason';
  }
  if (r.kind === 'partial' && typeof r.remaining !== 'number') {
    return 'partial 必须带 remaining 数字';
  }
  return true;
}

// ══════════════════════════════════════════════════════════════
// 一、成功路径
// ══════════════════════════════════════════════════════════════

await check('成功：清掉 dsh-auth* 后返回 {kind:cleared}', async () => {
  resetJar();
  await seedDshCookie();
  if ((await countDshCookies()) === 0) return '前置条件不成立：没能造出 cookie';

  const r = await clearNativeCookieJarDetailed(BASE);
  const shape = checkShape(r);
  if (shape !== true) return shape;
  if (r.kind !== 'cleared') return `期望 cleared，实际 ${r.kind}`;
  if ('remaining' in r) return 'cleared 不该带 remaining';

  const left = await countDshCookies();
  return left === 0 ? true : `返回 cleared，但容器里还有 ${left} 个`;
});

await check('成功：容器本来就空 → 仍然是 cleared（复核确认没有残留）', async () => {
  resetJar();
  const r = await clearNativeCookieJarDetailed(BASE);
  return r.kind === 'cleared' ? true : `期望 cleared，实际 ${r.kind}`;
});

await check('成功：不传 baseUrl + 有全局枚举 getAll（iOS）→ cleared', async () => {
  resetJar();
  await seedDshCookie();

  // 模拟 iOS：有全局 getAll（真实 Android 的 getAll 永远 reject，
  // 所以「不传 baseUrl 也能复核」只在 iOS 成立）
  const origGetAll = cm.getAll;
  cm.getAll = async () => {
    const hosts = cm.__jar ?? new Map();
    const merged = {};
    for (const cookies of hosts.values()) Object.assign(merged, cookies);
    return Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, { name: k, value: v }]),
    );
  };
  const restoreGetAll = () => {
    if (origGetAll === undefined) delete cm.getAll;
    else cm.getAll = origGetAll;
  };

  let r;
  try {
    r = await clearNativeCookieJarDetailed();
  } finally {
    restoreGetAll();
  }

  const shape = checkShape(r);
  if (shape !== true) return shape;
  return r.kind === 'cleared'
    ? true
    : `期望 cleared（有全局枚举，可以复核），实际 ${r.kind}`;
});

await check('诚实：不传 baseUrl 且平台无全局枚举（Android 实况）→ unverified', async () => {
  resetJar();
  await seedDshCookie();

  // 真实 Android：getAll 永远 reject（GET_ALL_NOT_SUPPORTED），
  // 而没有 baseUrl 就没法用 get(url) 复核 → 结论只能是「不确定」。
  //
  // 这条断言守的是**不撒谎**：当复核做不到时，宁可报 unverified
  // （界面会提示「无法确认已清除」），也不能报 cleared。
  const faults = makeFaultScope();
  faults.breakMethod('getAll');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(); // 注意：不传 baseUrl
  } finally {
    faults.restore();
  }

  const shape = checkShape(r);
  if (shape !== true) return shape;
  // shim 没有 getAll，这里同样走「无全局枚举」路径
  return r.kind === 'unverified'
    ? true
    : `期望 unverified，实际 ${r.kind} —— 复核不了却报了确定结论`;
});

await check('Android 实况：getAll 永远 reject，但有 baseUrl → 用 get(url) 复核并 cleared', async () => {
  resetJar();
  await seedDshCookie();

  // 这是真实 Android 的行为：CookieManagerModule.getAll() 直接
  // promise.reject(GET_ALL_NOT_SUPPORTED)。如果实现只在 getAll 上复核，
  // Android 每次清理都会误报「无法确认」→ 用户学会忽略警告。
  const faults = makeFaultScope();
  faults.breakMethod('getAll');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  const shape = checkShape(r);
  if (shape !== true) return shape;
  return r.kind === 'cleared'
    ? true
    : `期望 cleared（已回退到 get(url) 复核），实际 ${r.kind}`;
});

await check('精准清：clearAll 不可用时只删 dsh-auth*，不动别的 cookie', async () => {
  resetJar();
  await seedDshCookie();
  const other = 'http://127.0.0.1:8888';
  await cm.set(other, { name: 'third-party', value: 'x', path: '/' });

  // 关掉 clearAll 兜底 → 只剩「按名字精准清」这条路径
  //
  // 注意：**有** clearAll 时它是**全局**彻底清（实现里明确写了
  // 「退出登录场景可以接受」），连别的站点一起清 —— 那是既有设计，
  // 不是这里要改的事。这条用例守的是精准清那条路径确实只按前缀删。
  const faults = makeFaultScope();
  faults.removeMethod('clearAll');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  const shape = checkShape(r);
  if (shape !== true) return shape;
  if (r.kind !== 'cleared') return `期望 cleared，实际 ${r.kind}`;

  const otherLeft = await cm.get(other);
  if (!Object.keys(otherLeft ?? {}).includes('third-party')) {
    return '精准清把别的站点的 cookie 也删了（不该清那么宽）';
  }
  const dshLeft = await countDshCookies();
  return dshLeft === 0 ? true : `dsh-auth* 还有 ${dshLeft} 个残留`;
});

await check('文档化行为：有 clearAll 时是全局彻底清（含别的站点，已知取舍）', async () => {
  resetJar();
  await seedDshCookie();
  const other = 'http://127.0.0.1:8888';
  await cm.set(other, { name: 'third-party', value: 'x', path: '/' });

  const r = await clearNativeCookieJarDetailed(BASE);
  if (r.kind !== 'cleared') return `期望 cleared，实际 ${r.kind}`;

  // 把既有取舍**钉成断言**，避免后人误以为「误删了别的站点」是 bug
  // 而去掉 clearAll 兜底 —— 那样 HttpOnly cookie 会清不掉。
  const otherLeft = await cm.get(other);
  const othersGone = !Object.keys(otherLeft ?? {}).includes('third-party');
  return othersGone
    ? true
    : 'clearAll 兜底没生效（HttpOnly cookie 会清不掉的，这个兜底必须保留）';
});

// ══════════════════════════════════════════════════════════════
// 二、unavailable：原生模块本身加载不到
//
// 这**不是**清理失败 —— 平台上不存在第二个 cookie 存储。
// 必须能和 unverified 区分开。
// ══════════════════════════════════════════════════════════════

await check('unavailable：原生模块加载不到 → {kind:unavailable, reason}', async () => {
  resetJar();
  enableModuleAbsent();
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    disableModuleAbsent();
  }
  const shape = checkShape(r);
  if (shape !== true) return shape;
  if (r.kind !== 'unavailable') {
    return `期望 unavailable，实际 ${r.kind} —— 「模块不存在」被报成了别的结论`;
  }
  return r.reason ? true : 'unavailable 没有给 reason';
});

await check('unavailable ≠ unverified：两者 kind 必须不同（UI 靠它决定要不要警告）', async () => {
  resetJar();

  enableModuleAbsent();
  let unavailable;
  try {
    unavailable = await clearNativeCookieJarDetailed(BASE);
  } finally {
    disableModuleAbsent();
  }

  // 现在造一个「模块在、但复核抛异常」的 unverified
  resetJar();
  await seedDshCookie();
  const faults = makeFaultScope();
  faults.failOnNthCall('get', 2);
  let unverified;
  try {
    unverified = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  if (unavailable.kind !== 'unavailable') return `第一个应为 unavailable，实际 ${unavailable.kind}`;
  if (unverified.kind !== 'unverified') return `第二个应为 unverified，实际 ${unverified.kind}`;
  // 这是 load-bearing：App.tsx 把 unavailable 当「没问题」、unverified 当「要警告」
  return unavailable.kind !== unverified.kind
    ? true
    : 'unavailable 和 unverified 混成了同一个 kind —— UI 无法区分';
});

await check('unavailable：模块不可用时 boolean 包装仍是 true（历史行为，保留）', async () => {
  resetJar();
  enableModuleAbsent();
  let b;
  try {
    b = await clearNativeCookieJar(BASE);
  } finally {
    disableModuleAbsent();
  }
  // 平台没有第二个存储 → 没有东西需要清 → true。
  // 这条是 security-review-fixes-spec C1 的既有契约，不能破。
  return b === true
    ? true
    : '模块不存在时布尔包装返回了 false —— 会把「平台不支持」误报成「清理失败」';
});

// ══════════════════════════════════════════════════════════════
// 三、unverified：无法确认（**绝不能**报成 cleared）
// ══════════════════════════════════════════════════════════════

await check('核心：复核 getAll 抛异常 → unverified（不是 cleared！）', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  // 产品代码优先用 getAll 复核；让它抛错
  faults.failOnNthCall('get', 2);
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  const shape = checkShape(r);
  if (shape !== true) return shape;
  if (r.kind === 'cleared') {
    return '复核抛异常却报 cleared —— 旧实现的假成功（用户以为清干净了）';
  }
  return r.kind === 'unverified' ? true : `期望 unverified，实际 ${r.kind}`;
});

await check('核心：复核抛异常时 boolean 包装返回 false（不报成功）', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  faults.failOnNthCall('get', 2);
  let b;
  try {
    b = await clearNativeCookieJar(BASE);
  } finally {
    faults.restore();
  }
  return b === false
    ? true
    : '无法确认清理结果却返回 true —— 「不确定」被当成了「清干净」';
});

await check('unverified：完全没有枚举 API（平台缺 getAll/get）→ unverified', async () => {
  resetJar();
  const faults = makeFaultScope();
  faults.removeMethod('get');
  faults.removeMethod('getAll');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }
  const shape = checkShape(r);
  if (shape !== true) return shape;
  // 没有枚举 API 就**无法复核** → 只能是不确定。
  // 注意：这**不是** unavailable（模块是在的，只是这个平台没有枚举接口）。
  return r.kind === 'unverified'
    ? true
    : `期望 unverified，实际 ${r.kind} —— 无法复核却报了确定结论`;
});

await check('unverified：reason 里带错误码但不含 cookie 值', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  faults.breakMethodWithCode('get', 'E_COOKIE_NATIVE');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  if (r.kind !== 'unverified') return `期望 unverified，实际 ${r.kind}`;
  const blob = JSON.stringify(r);
  if (blob.includes('v1.secret-value')) return '返回值里泄露了 cookie 值';
  if (blob.includes('dsh-auth-test')) return '返回值里泄露了 cookie 名';
  // 错误码应该保留（便于排查），但它属于「类别」不是凭据
  return r.reason.includes('E_COOKIE_NATIVE')
    ? true
    : `reason 里没有错误码，无法排查：${r.reason}`;
});

// ══════════════════════════════════════════════════════════════
// 四、partial：复核确认还有残留
// ══════════════════════════════════════════════════════════════

await check('partial：clearAll 假成功（返回 true 但没删）→ partial + remaining', async () => {
  resetJar();
  await seedDshCookie();
  const before = await countDshCookies();

  const faults = makeFaultScope();
  // 模拟「API 返回成功但实际没删」——这正是代码注释里说的部分机型行为
  faults.noopMethod('clearAll');
  faults.noopMethod('clearByName');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  const shape = checkShape(r);
  if (shape !== true) return shape;
  if (r.kind !== 'partial') {
    return `期望 partial，实际 ${r.kind} —— 复核明明还能读到残留`;
  }
  if (r.remaining !== before) {
    return `remaining 应为 ${before}，实际 ${r.remaining}`;
  }

  // 而且容器里确实还有
  const left = await countDshCookies();
  return left === before ? true : `报告 ${r.remaining} 个残留，实际剩 ${left} 个`;
});

await check('partial：只有 clearByName 失败、clearAll 生效 → 仍然是 cleared', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  faults.breakMethod('clearByName');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }
  // clearAll 兜底成功 → 复核确认没有残留 → cleared。
  // 这条防止「把可恢复的中间失败误报成残留」。
  return r.kind === 'cleared'
    ? true
    : `期望 cleared（clearAll 兜底已清干净），实际 ${r.kind}`;
});

await check('partial：boolean 包装返回 false（确认有残留）', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  faults.noopMethod('clearAll');
  faults.noopMethod('clearByName');
  let b;
  try {
    b = await clearNativeCookieJar(BASE);
  } finally {
    faults.restore();
  }
  return b === false ? true : '有确认残留却返回 true';
});

// ══════════════════════════════════════════════════════════════
// 五、clearByName / clearAll 抛错时的分类
// ══════════════════════════════════════════════════════════════

await check('clearByName 抛错：clearAll 成功了 → cleared（不误报失败）', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  faults.breakMethod('clearByName');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }
  return r.kind === 'cleared'
    ? true
    : `期望 cleared（兜底已清干净），实际 ${r.kind}`;
});

await check('clearAll 抛错：clearByName 已清干净 → cleared', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  faults.breakMethod('clearAll');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }
  const shape = checkShape(r);
  if (shape !== true) return shape;
  // 只信复核：复核确认没有残留就是 cleared，不管中途哪个 API 抛过错
  return r.kind === 'cleared' ? true : `期望 cleared，实际 ${r.kind}`;
});

await check('clearByName + clearAll 都抛错、cookie 还在 → partial（确认残留）', async () => {
  resetJar();
  await seedDshCookie();
  const before = await countDshCookies();

  const faults = makeFaultScope();
  faults.breakMethod('clearByName');
  faults.breakMethod('clearAll');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  const shape = checkShape(r);
  if (shape !== true) return shape;
  // 两个删除都失败，但复核**成功且确认有残留** → partial（不是 unverified）
  if (r.kind !== 'partial') {
    return `期望 partial（复核成功且确认残留），实际 ${r.kind}`;
  }
  return r.remaining === before ? true : `remaining 不对：${r.remaining} ≠ ${before}`;
});

await check('clearByName + clearAll 都抛错但复核也抛错 → unverified', async () => {
  resetJar();
  await seedDshCookie();

  const faults = makeFaultScope();
  faults.breakMethod('clearByName');
  faults.breakMethod('clearAll');
  faults.breakMethod('get'); // 复核（第二次 get）也会抛
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }
  const shape = checkShape(r);
  if (shape !== true) return shape;
  return r.kind === 'unverified'
    ? true
    : `期望 unverified（什么都确认不了），实际 ${r.kind}`;
});

// ══════════════════════════════════════════════════════════════
// 六、boolean 包装的映射规则（逐条钉住）
// ══════════════════════════════════════════════════════════════

await check('包装映射：cleared → true', async () => {
  resetJar();
  await seedDshCookie();
  const r = await clearNativeCookieJarDetailed(BASE);
  const b = await clearNativeCookieJar(BASE);
  if (r.kind !== 'cleared') return `前置条件不成立：${r.kind}`;
  return b === true ? true : 'cleared 却返回 false';
});

await check('包装映射：partial → false', async () => {
  resetJar();
  await seedDshCookie();
  const faults = makeFaultScope();
  faults.noopMethod('clearAll');
  faults.noopMethod('clearByName');
  try {
    const detail = await clearNativeCookieJarDetailed(BASE);
    const b = await clearNativeCookieJar(BASE);
    if (detail.kind !== 'partial') return `前置条件不成立：${detail.kind}`;
    return b === false ? true : 'partial 却返回 true';
  } finally {
    faults.restore();
  }
});

await check('包装映射：unverified → false（关键：不确定不报成功）', async () => {
  resetJar();
  await seedDshCookie();
  const faults = makeFaultScope();
  faults.failOnNthCall('get', 2);
  try {
    const detail = await clearNativeCookieJarDetailed(BASE);
    if (detail.kind !== 'unverified') return `前置条件不成立：${detail.kind}`;
  } finally {
    faults.restore();
  }

  // 再跑一次单独的包装调用（同样的故障）
  const faults2 = makeFaultScope();
  faults2.failOnNthCall('get', 2);
  let b;
  try {
    b = await clearNativeCookieJar(BASE);
  } finally {
    faults2.restore();
  }
  return b === false ? true : 'unverified 映射成了 true —— 「不确定」被当成成功';
});

await check('包装映射：unavailable → true（平台没有第二个存储）', async () => {
  resetJar();
  enableModuleAbsent();
  try {
    const detail = await clearNativeCookieJarDetailed(BASE);
    if (detail.kind !== 'unavailable') return `前置条件不成立：${detail.kind}`;
  } finally {
    disableModuleAbsent();
  }

  enableModuleAbsent();
  let b;
  try {
    b = await clearNativeCookieJar(BASE);
  } finally {
    disableModuleAbsent();
  }
  return b === true ? true : 'unavailable 映射成了 false（会误报「清理失败」）';
});

// ══════════════════════════════════════════════════════════════
// 七、返回值契约 / 不泄露
// ══════════════════════════════════════════════════════════════

await check('契约：四种 kind 都是可穷举的字符串字面量', async () => {
  resetJar();
  const seen = new Set();

  // cleared
  seen.add((await clearNativeCookieJarDetailed(BASE)).kind);

  // partial
  await seedDshCookie();
  {
    const faults = makeFaultScope();
    faults.noopMethod('clearAll');
    faults.noopMethod('clearByName');
    try {
      seen.add((await clearNativeCookieJarDetailed(BASE)).kind);
    } finally {
      faults.restore();
    }
  }

  // unverified
  {
    const faults = makeFaultScope();
    faults.removeMethod('get');
    faults.removeMethod('getAll');
    try {
      seen.add((await clearNativeCookieJarDetailed(BASE)).kind);
    } finally {
      faults.restore();
    }
  }

  // unavailable
  enableModuleAbsent();
  try {
    seen.add((await clearNativeCookieJarDetailed(BASE)).kind);
  } finally {
    disableModuleAbsent();
  }

  const expected = ['cleared', 'partial', 'unverified', 'unavailable'];
  const missing = expected.filter((k) => !seen.has(k));
  if (missing.length) return `这些 kind 没被覆盖到：${missing.join('、')}`;
  const extra = [...seen].filter((k) => !expected.includes(k));
  return extra.length === 0 ? true : `出现了未定义的 kind：${extra.join('、')}`;
});

await check('契约：任何分支都不抛错（调用方可以不用 try/catch）', async () => {
  resetJar();
  const scenarios = [];

  // 1) 正常
  scenarios.push(async () => clearNativeCookieJarDetailed(BASE));

  // 2) 所有方法都抛
  scenarios.push(async () => {
    const f = makeFaultScope();
    f.breakMethod('get');
    f.breakMethod('getAll');
    f.breakMethod('clearAll');
    f.breakMethod('clearByName');
    try {
      return await clearNativeCookieJarDetailed(BASE);
    } finally {
      f.restore();
    }
  });

  // 3) 模块缺失
  scenarios.push(async () => {
    enableModuleAbsent();
    try {
      return await clearNativeCookieJarDetailed(BASE);
    } finally {
      disableModuleAbsent();
    }
  });

  for (let idx = 0; idx < scenarios.length; idx += 1) {
    try {
      const r = await scenarios[idx]();
      const shape = checkShape(r);
      if (shape !== true) return `场景 ${idx + 1}：${shape}`;
    } catch (e) {
      return `场景 ${idx + 1} 抛错了：${e?.message ?? e}`;
    }
  }
  return true;
});

await check('契约：失败时 reason 不含 cookie 名/值（不泄露）', async () => {
  resetJar();
  await cm.set(BASE, {
    name: 'dsh-auth-SECRETNAME',
    value: 'SECRETVALUE123',
    path: '/',
  });

  const faults = makeFaultScope();
  faults.breakMethod('get');
  faults.breakMethod('getAll');
  let r;
  try {
    r = await clearNativeCookieJarDetailed(BASE);
  } finally {
    faults.restore();
  }

  const blob = JSON.stringify(r);
  if (blob.includes('SECRETVALUE123')) return 'reason 里泄露了 cookie 值';
  if (blob.includes('dsh-auth-SECRETNAME')) return 'reason 里泄露了 cookie 名';
  return true;
});

await check('契约：static 检查 cookieJar 源码没有把 cookie 值写进日志', async () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'cookieJar.ts'),
    'utf8',
  );
  // 不该出现 console.* / 把 cookie 值拼进字符串的写法
  if (/console\.(log|warn|error|info|debug)/.test(src)) {
    return 'cookieJar.ts 里有 console 输出（可能把 cookie 打进日志）';
  }
  if (/\.value\b/.test(src)) {
    return 'cookieJar.ts 里读了 cookie.value —— 只应关心名字，不该碰值';
  }
  return true;
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
