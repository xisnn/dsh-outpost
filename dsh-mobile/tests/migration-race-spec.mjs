/**
 * P1-2：`lastCookie` 迁移时的异步竞争。
 *
 * ## 缺陷是什么
 *
 * 旧版本 `signOut()` 会把当前 Cookie 复制到 `@dsh/lastCookie`（「上次配对」
 * 备份）再删 `@dsh/cookie`。所以「只有 lastCookie、没有 cookie」这个状态，
 * 是**旧版里用户主动点过「断开连接」的唯一证据**。
 *
 * 而迁移函数会把 `@dsh/lastCookie` 删掉（那本来就是一份该消失的明文副本）。
 * 原来的启动流程是：
 *
 *   ```ts
 *   const migration = await migrateLegacyCredentials();   // ← 证据在这一行消失
 *   ...
 *   if (migration.fromLastCookie) {
 *     void setLoginIntent('signed-out');                  // ← 不等，也不看结果
 *   }
 *   ```
 *
 * 两个问题：
 *
 *   1. **`void` 了**：不 wait 也不检查写入结果。
 *   2. **顺序反了**：证据先被销毁，退出意图才去落盘。
 *
 * 于是存在一个致命窗口：
 *
 *   lastCookie 已删 → signed-out 还没写进去 → App 被系统杀掉
 *   → 下次启动：意图键不存在 → loadLoginIntent() 返回 'active'
 *     （升级兼容语义）→ **自动登录**
 *
 * 用户「我主动断开过」的决定就这样被程序丢掉了。
 *
 * ## 修法
 *
 * 1. **先读证据、先落意图、再迁移**（顺序见 App.tsx 的
 *    `peekLegacySignedOutEvidence()`）。
 * 2. 意图写入必须 `await` 并检查结果。
 * 3. 写失败时不能硬着头皮销毁证据 —— 而是**移除可自动登录的凭据**
 *    （`CredentialKey.cookie`），这样即使意图丢了也没有东西能自动登录。
 *    这跟 P0-1 的「持久化失败就移除可自动恢复的凭据」是同一策略。
 *
 * ## 本文件怎么测
 *
 * App.tsx 的启动逻辑是 React 组件内部的一段 await 链，没法直接调用。
 * 所以这里**复刻那段顺序**（这是它的规格说明），并驱动真实产品模块：
 *
 *   · credentialMigration 的真实 `migrateLegacyCredentials()`
 *   · loginIntent 的真实 `setLoginIntent()` / `loadLoginIntent()`
 *   · secureStore 的真实 `saveCredential()` / `loadCredential()`
 *
 * 另外再加一组**静态断言**，锁住 App.tsx 里那段顺序不被改回去
 * （顺序是修法的核心，不能只靠行为测试 —— 行为测试复刻的是副本）。
 *
 * 每个阶段都模拟「在这里崩溃」，然后模拟重启，断言**不会自动登录**。
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

const AsyncStorageStub = (await imp(path.join(SHIM_DIR, 'async-storage-stub.mjs'))).default;
const AsyncStorageCjs = createRequire(import.meta.url)('./support/_async-storage-shim.cjs');

const migrationMod = await imp(
  path.join(__dirname, '..', 'src', 'core', 'credentialMigration.ts'),
);
const { migrateLegacyCredentials, LegacyCredentialKey } = migrationMod;
const intentMod = await imp(path.join(__dirname, '..', 'src', 'core', 'loginIntent.ts'));
const { loadLoginIntent, setLoginIntent, __resetLoginIntentCache } = intentMod;
const secure = await imp(path.join(__dirname, '..', 'src', 'core', 'secureStore.ts'));
const { CredentialKey, loadCredential, saveCredential, clearCredential } = secure;

const KC_KEY = '__dshTestKeychainState__';
function ks() {
  if (!globalThis[KC_KEY]) globalThis[KC_KEY] = { store: new Map() };
  return globalThis[KC_KEY].store;
}

const COOKIE = 'dsh-auth-test=v1.SECRET-COOKIE-VALUE';
const LAST_COOKIE = 'dsh-auth-test=v1.SECRET-LAST-COOKIE-VALUE';

function resetAll() {
  AsyncStorageStub.__reset();
  ks().clear();
  __resetLoginIntentCache();
}

/** 模拟「从旧版本升级上来、用户点过断开连接」 */
async function seedLegacySignedOut() {
  await AsyncStorageCjs.setItem(LegacyCredentialKey.lastCookie, LAST_COOKIE);
}

/**
 * 复刻 App.tsx 启动时**修正后**的顺序（P1-2 的规格）。
 *
 * 返回本次启动最终「会不会自动登录」。这就是被测的规格本身。
 *
 * @param opts.failIntentWrite 模拟 setLoginIntent 抛错
 * @param opts.failPeek 模拟读证据时抛错
 * @param opts.crashAfter 在某个阶段后「崩溃」（抛错中断，不再往下走）
 */
async function bootstrap(opts = {}) {
  const log = [];
  let exitIntentPersisted = null;

  // ── 阶段 1：迁移前先读证据 ─────────────────────────────────
  let peek;
  if (opts.failPeek) {
    peek = { fromLastCookieOnly: false, unknown: true };
  } else {
    const entries = await AsyncStorageCjs.multiGet([
      LegacyCredentialKey.cookie,
      LegacyCredentialKey.lastCookie,
    ]);
    const map = new Map(entries);
    peek = {
      fromLastCookieOnly: !!map.get(LegacyCredentialKey.lastCookie) && !map.get(LegacyCredentialKey.cookie),
      unknown: false,
    };
  }
  log.push(`peek:${peek.fromLastCookieOnly ? 'last-cookie-only' : peek.unknown ? 'unknown' : 'normal'}`);

  // ── 阶段 2：先落退出意图（await + 检查结果）────────────────
  if (peek.fromLastCookieOnly) {
    if (opts.failIntentWrite) {
      exitIntentPersisted = false;
    } else {
      exitIntentPersisted = await setLoginIntent('signed-out')
        .then((r) => r === true)
        .catch(() => false);
    }
    log.push(`intent:${exitIntentPersisted ? 'persisted' : 'failed'}`);
  } else if (peek.unknown) {
    exitIntentPersisted = false;
    log.push('intent:unconfirmed');
  }

  // 模拟「意图写完之后、迁移之前崩了」
  if (opts.crashAfter === 'intent') throw new Error('simulated crash after intent');

  // ── 阶段 3：迁移（会删掉 lastCookie 这份证据）──────────────
  const report = await migrateLegacyCredentials();
  log.push(`migration:${report.status}:fromLastCookie=${report.fromLastCookie}`);

  if (opts.crashAfter === 'migration') throw new Error('simulated crash after migration');

  // 迁移报告说 fromLastCookie 也要兜一层
  if (report.fromLastCookie && exitIntentPersisted === null) {
    exitIntentPersisted = opts.failIntentWrite
      ? false
      : await setLoginIntent('signed-out')
          .then((r) => r === true)
          .catch(() => false);
  }

  const savedCookie = await loadCredential(CredentialKey.cookie);
  const baseUrl = 'http://127.0.0.1:3095';

  // ── 阶段 4：写失败 → 移除可自动登录的凭据 ─────────────────
  let exitIntentLost = false;
  if (exitIntentPersisted === false && savedCookie) {
    await clearCredential(CredentialKey.cookie);
    exitIntentLost = true;
    log.push('cookie-removed');
  }

  if (opts.crashAfter === 'cookie-removal') throw new Error('simulated crash');

  // ── 阶段 5：判定要不要自动登录 ─────────────────────────────
  const intent = await loadLoginIntent();
  const autoResume =
    intent === 'active' && !report.fromLastCookie && !exitIntentLost;
  const authed = !!(baseUrl && (await loadCredential(CredentialKey.cookie)) && autoResume);
  log.push(`final:${authed ? 'AUTO-LOGIN' : 'stay-on-pairing'}`);
  return { authed, intent, exitIntentPersisted, exitIntentLost, report, log };
}

/** 模拟 App 被杀死后重启：清掉所有内存缓存，只留持久化状态 */
function restartApp() {
  __resetLoginIntentCache();
}

// ══════════════════════════════════════════════════════════════
// 一、有序迁移：核心场景
// ══════════════════════════════════════════════════════════════

await check('核心：只剩 lastCookie 时，首次启动不自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  const r = await bootstrap();
  if (r.authed) return '首次启动就自动登录了 —— 用户「断开过」的证据被无视';
  return r.exitIntentPersisted === true ? true : '退出意图没落盘';
});

await check('核心：首次启动后，连续重启仍然不自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  await bootstrap(); // 第 1 次启动：迁移完成，lastCookie 被删
  // 迁移后 lastCookie 必须消失（否则明文凭据一直留着）
  const left = await AsyncStorageCjs.getItem(LegacyCredentialKey.lastCookie);
  if (left) return 'lastCookie 明文没被清掉';

  for (let i = 1; i <= 4; i += 1) {
    restartApp();
    const r = await bootstrap(); // 第 2..5 次启动
    if (r.authed) {
      return `第 ${i + 1} 次启动自动登录了 —— 用户「断开过」的决定在重启后丢失`;
    }
  }
  return true;
});

await check('核心：迁移前已落盘 signed-out（顺序正确）', async () => {
  resetAll();
  await seedLegacySignedOut();
  const r = await bootstrap();
  // 日志顺序必须是 peek → intent → migration
  const peekIdx = r.log.findIndex((x) => x.startsWith('peek:'));
  const intentIdx = r.log.findIndex((x) => x.startsWith('intent:'));
  const migIdx = r.log.findIndex((x) => x.startsWith('migration:'));
  if (peekIdx < 0 || intentIdx < 0 || migIdx < 0) return `日志不全：${r.log.join(' | ')}`;
  if (!(peekIdx < intentIdx && intentIdx < migIdx)) {
    return `顺序不对（证据/意图必须先于迁移）：${r.log.join(' | ')}`;
  }
  return true;
});

await check('旧版正常登录态（有 cookie）：迁移后仍然自动登录', async () => {
  resetAll();
  // 旧版里用户没断开过 → @dsh/cookie 有值，没有 lastCookie
  await AsyncStorageCjs.setItem(LegacyCredentialKey.cookie, COOKIE);
  const r = await bootstrap();
  if (!r.authed) return '正常登录态被误判成「已断开」，用户被踢回配对页';
  const v = await loadCredential(CredentialKey.cookie);
  return v === COOKIE ? true : 'Cookie 没有迁移进 Keystore';
});

// ══════════════════════════════════════════════════════════════
// 二、写入失败：不能静默继续
// ══════════════════════════════════════════════════════════════

await check('意图写入失败：本次启动不自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  const r = await bootstrap({ failIntentWrite: true });
  if (r.authed) return '意图写失败了却自动登录了';
  return r.exitIntentPersisted === false ? true : '失败没被记录';
});

await check('意图写入失败：移除可自动登录的凭据（跨重启兜底）', async () => {
  resetAll();
  await seedLegacySignedOut();
  const r = await bootstrap({ failIntentWrite: true });
  if (!r.exitIntentLost) return '没有触发「移除可自动登录凭据」的降级';
  // 关键：凭据真的没了 —— 这样即使意图丢了也没东西能自动登录
  const c = await loadCredential(CredentialKey.cookie);
  if (c) return '降级没生效，Cookie 还在（下次启动会按 active 自动登录）';
  return true;
});

await check('意图写入失败 + 重启：仍然不自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  await bootstrap({ failIntentWrite: true });
  restartApp();
  const r = await bootstrap();
  return r.authed ? false : true;
});

await check('意图写入在崩溃边缘（写完就崩）：重启后不自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  let crashed = false;
  try {
    await bootstrap({ crashAfter: 'intent' });
  } catch {
    crashed = true;
  }
  if (!crashed) return '没有触发模拟崩溃';
  // 崩溃发生在迁移之前 → lastCookie 可能还在，但意图已经落盘
  restartApp();
  const r = await bootstrap();
  return r.authed ? false : true;
});

// ══════════════════════════════════════════════════════════════
// 三、各阶段崩溃 + 重启：任何一处都不能变成自动登录
// ══════════════════════════════════════════════════════════════

for (const stage of ['intent', 'migration', 'cookie-removal']) {
  await check(`崩溃在「${stage}」之后 + 重启：不自动登录`, async () => {
    resetAll();
    await seedLegacySignedOut();
    try {
      await bootstrap({ crashAfter: stage });
    } catch {
      /* 模拟崩溃 */
    }
    restartApp();
    const r = await bootstrap();
    return r.authed ? `崩溃在 ${stage} 之后，重启竟然自动登录了` : true;
  });
}

await check('连续崩溃 3 次后仍不自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  for (let i = 0; i < 3; i += 1) {
    try {
      await bootstrap({ crashAfter: 'migration' });
    } catch {
      /* 模拟崩溃 */
    }
    restartApp();
  }
  const r = await bootstrap();
  return r.authed ? '连续崩 3 次后自动登录了' : true;
});

// ══════════════════════════════════════════════════════════════
// 四、迁移读失败：不确定性必须 fail-closed
// ══════════════════════════════════════════════════════════════

await check('读证据失败（存储异常）：不自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  // 让「先存 cookie 再模拟正常登录态」，然后让 peek 读失败
  await saveCredential(CredentialKey.cookie, COOKIE);
  const r = await bootstrap({ failPeek: true });
  if (r.authed) return '读不到证据却自动登录了 —— 等于替用户猜「他没退出过」';
  return true;
});

await check('读证据失败：移除可自动登录凭据（不留猜测余地）', async () => {
  resetAll();
  await seedLegacySignedOut();
  await saveCredential(CredentialKey.cookie, COOKIE);
  const r = await bootstrap({ failPeek: true });
  if (r.exitIntentPersisted !== false) return '未知状态没被记成「未确认」';
  const c = await loadCredential(CredentialKey.cookie);
  return c ? '凭据还在 —— 意图丢失时会自动登录' : true;
});

// ══════════════════════════════════════════════════════════════
// 五、用户重新授权后恢复正常
// ══════════════════════════════════════════════════════════════

await check('用户重新扫码（写 active）+ 重启：恢复自动登录', async () => {
  resetAll();
  await seedLegacySignedOut();
  await bootstrap(); // 第一次不自动登录

  // 用户主动扫码配对 → saveCookie() 会写 active
  await saveCredential(CredentialKey.cookie, COOKIE);
  await setLoginIntent('active');

  restartApp();
  const r = await bootstrap();
  return r.authed ? true : '用户明确重新配对后却没恢复自动登录';
});

await check('有效凭据不因迁移失败而丢失', async () => {
  resetAll();
  // 只有 lastCookie（迁移源），让一次正常迁移跑完
  await seedLegacySignedOut();
  await bootstrap();
  // 迁移必须把 lastCookie 的值搬进 Keystore（凭据不能丢）
  const c = await loadCredential(CredentialKey.cookie);
  return c === LAST_COOKIE ? true : `凭据丢了或不对：${c ? '值不匹配' : 'undefined'}`;
});

// ══════════════════════════════════════════════════════════════
// 六、静态：锁住 App.tsx 里的顺序（行为测试复刻的是副本）
// ══════════════════════════════════════════════════════════════

const appSrc = readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');

await check('静态：App.tsx 在迁移前先读 lastCookie 证据', () => {
  const peekIdx = appSrc.indexOf('peekLegacySignedOutEvidence(');
  const migIdx = appSrc.indexOf('migrateLegacyCredentials(');
  if (peekIdx < 0) return '没有 peekLegacySignedOutEvidence —— 证据会在迁移时被销毁';
  if (migIdx < 0) return '找不到 migrateLegacyCredentials';
  // 注意：函数声明在前，调用点在 bootstrap 里
  const callPeek = appSrc.indexOf('await peekLegacySignedOutEvidence()');
  const callMig = appSrc.indexOf('await migrateLegacyCredentials()');
  if (callPeek < 0 || callMig < 0) return '找不到调用点';
  return callPeek < callMig
    ? true
    : '先迁移再读证据 —— lastCookie 已经被删，读不到任何东西';
});

await check('静态：不再用 `void setLoginIntent(...)` 丢弃结果', () => {
  // P1-2 的核心缺陷之一：void 掉写入，既不等待也不检查。
  //
  // ⚠️ 必须先剥掉注释再断言 —— App.tsx 里有一段注释**描述**了旧的错误
  // 写法（`void setLoginIntent('signed-out')`）。直接正则扫全文会命中
  // 注释里的那段说明，产生一个永远修不掉的假失败。
  const code = appSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  if (/void\s+setLoginIntent\s*\(/.test(code)) {
    return '仍然用 void 丢弃 setLoginIntent 的结果 —— 写失败会被静默忽略';
  }
  return true;
});

await check('静态：退出意图写入被 await 且检查了结果', () => {
  // 迁移前后的两处写入都必须 await + catch 成 boolean
  const occurrences = appSrc.split("setLoginIntent('signed-out')").length - 1;
  if (occurrences < 2) return `signed-out 写入点只有 ${occurrences} 处，迁移路径可能漏了`;
  if (!/exitIntentPersisted\s*=\s*await\s+setLoginIntent\('signed-out'\)/.test(appSrc)) {
    return '没有把写入结果存进变量（无法判断是否落盘）';
  }
  return true;
});

await check('静态：意图写失败时会移除可自动登录的凭据', () => {
  const i = appSrc.indexOf('exitIntentPersisted === false');
  if (i < 0) return '没有处理「意图写失败」的分支';
  const body = appSrc.slice(i, i + 600);
  if (!/clearCredential\(\s*CredentialKey\.cookie\s*\)/.test(body)) {
    return '写失败时没有移除 Cookie —— 下次启动会按 active 自动登录';
  }
  return true;
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
