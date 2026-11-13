/**
 * P4-0.1 P0-2（N1）：Cookie 配对必须有界、可分类、可恢复。
 *
 * 修前缺陷（真实 Emulator 验收发现）：
 *   · 登录前清理调用原生 CookieManager，**全链路无超时** —— 原生不回调时
 *     loginWithToken 永久挂起，「连接」按钮无限转圈，且一个 HTTP 请求都没发。
 *   · 读取侧 5s 超时被空 catch 吞掉 → 空 jar 落进状态码分支 → 误导性
 *     「token exchange failed: HTTP 401」，把原生故障伪装成服务端拒绝。
 *
 * 本文件驱动**真实产品代码**（src/core/cookieJar.ts + src/core/transport），
 * 用共享 jar 的 CookieManager 替身注入「永不返回 / 抛异常 / 正常」三类行为。
 * 所有挂起类用例都有看门狗：修前会超时判 FAIL（RED），修后必须有界失败（GREEN）。
 *
 * 不变量（不得因修复而削弱）：
 *   · 登录前必须清 cookie；清理无法确认时**中止登录**，不得带着旧凭据继续。
 *   · 不得用旧 cookie 判定新 token 成功。
 *   · 错误信息不含 token / cookie 值。
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
function ok(n) { pass += 1; console.log(`  OK    ${n}`); }
function bad(n, d) { fail += 1; console.log(`  FAIL  ${n}${d ? ' :: ' + d : ''}`); }
function check(c, n, d) { c ? ok(n) : bad(n, d); }

const ABSENT_FLAG = path.join(process.env.TEMP ?? process.env.TMP ?? __dirname, 'dsh-cookie-timeout-spec-absent.flag');
{
  const overrideCode = `
import fs from 'node:fs';
const FLAG = ${JSON.stringify(ABSENT_FLAG)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@react-native-cookies/cookies') {
    if (fs.existsSync(FLAG)) {
      return { url: 'file:///dsh-test/definitely-absent-cookie-manager.cjs', shortCircuit: true, format: 'commonjs' };
    }
  }
  return nextResolve(specifier, context);
}
`;
  register('data:text/javascript,' + encodeURIComponent(overrideCode));
}

const cookieJar = await imp(path.join(__dirname, '..', 'src', 'core', 'cookieJar.ts'));
const { clearNativeCookieJarDetailed } = cookieJar;
const transport = await imp(path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'));
const { DshConnection } = transport;

const cmMod = await imp(path.join(SHIM_DIR, '_cookie-manager-shim.cjs'));
const cm = cmMod.default ?? cmMod;
const ORIGINAL = { get: cm.get, getAll: cm.getAll, clearAll: cm.clearAll, clearByName: cm.clearByName };
function restoreCm() { for (const [k, v] of Object.entries(ORIGINAL)) cm[k] = v; }

const BASE = 'http://127.0.0.1:9999';
const SECRET_COOKIE = 'dsh-auth-test=SECRET-COOKIE-VALUE-123';
const SECRET_TOKEN = 'SECRET-TOKEN-VALUE-456';

/** 看门狗：挂起类用例修前会永久等待；这里限定 12s 判 FAIL 而不是吊死整套 */
async function bounded(promise, ms = 12000) {
  let timer;
  try {
    return await Promise.race([
      promise.then((v) => ({ kind: 'settled', value: v }), (e) => ({ kind: 'threw', error: e })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: 'hung' }), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 模拟 RN 原生层：fetch 收到 Set-Cookie 后写进共享 jar */
function fetchSetsCookie(status = 401) {
  return async () => {
    await cm.set(BASE, { name: 'dsh-auth-test', value: 'SECRET-COOKIE-VALUE-123' });
    return { status, ok: status < 400, headers: new Headers() };
  };
}
function fetchNoCookie(status = 401) {
  return async () => ({ status, ok: status < 400, headers: new Headers() });
}
function conn(fetchImpl) {
  return new DshConnection({ baseUrl: BASE, fetchImpl, WebSocketImpl: function WS() {} });
}

console.log('N1 cookie pairing bounded-timeout regression (P4-0.1 P0-2)');

// ── 1. 正常 token 配对成功 ──
{
  cm.__reset(); restoreCm();
  const c = conn(fetchSetsCookie());
  const r = await bounded(c.loginWithToken(SECRET_TOKEN));
  check(r.kind === 'settled' && typeof r.value === 'string' && r.value.includes('dsh-auth-test'),
    'normal token pairing succeeds', JSON.stringify(r).slice(0, 120));
}

// ── 2. 错误 token 被拒绝（jar 读成功但为空 → 服务端 401）──
{
  cm.__reset(); restoreCm();
  const c = conn(fetchNoCookie(401));
  const r = await bounded(c.loginWithToken('wrong-token'));
  check(r.kind === 'threw' && /401/.test(r.error.message), 'wrong token is rejected with the server 401', JSON.stringify(r).slice(0, 160));
}

// ── 3. cookie 清理成功（有旧 cookie 也清干净）──
{
  cm.__reset(); restoreCm();
  await cm.set(BASE, { name: 'dsh-auth-old', value: 'old' });
  const res = await clearNativeCookieJarDetailed(BASE);
  check(res.kind === 'cleared', 'cleanup reports cleared after recheck', JSON.stringify(res));
}

// ── 4. cookie 清理永久不返回 → 有界失败，且登录中止（不得带旧凭据继续）──
{
  cm.__reset(); restoreCm();
  await cm.set(BASE, { name: 'dsh-auth-old', value: 'old' });
  cm.clearAll = () => new Promise(() => {});
  cm.clearByName = () => new Promise(() => {});
  const t0 = Date.now();
  const res = await bounded(clearNativeCookieJarDetailed(BASE), 20000);
  const elapsed = Date.now() - t0;
  check(res.kind !== 'hung', 'cleanup that never returns is bounded (no infinite hang)', `elapsed=${elapsed}ms`);
  check(res.kind === 'settled' && (res.value.kind === 'unverified' || res.value.kind === 'partial'),
    'unconfirmable cleanup is unverified/partial, never cleared', JSON.stringify(res).slice(0, 160));
  const c = conn(fetchSetsCookie());
  const login = await bounded(c.loginWithToken(SECRET_TOKEN), 20000);
  check(login.kind === 'threw', 'login aborts when cleanup cannot be confirmed', JSON.stringify(login).slice(0, 160));
  check(login.kind !== 'hung', 'login does not hang on a dead cookie container');
  restoreCm();
}

// ── 5. cookie 读取永久不返回 → 有界、且错误不是误导 401 ──
{
  cm.__reset(); restoreCm();
  cm.get = () => new Promise(() => {});
  const c = conn(fetchSetsCookie());
  const t0 = Date.now();
  const r = await bounded(c.loginWithToken(SECRET_TOKEN));
  const elapsed = Date.now() - t0;
  check(r.kind !== 'hung', 'read that never returns is bounded', `elapsed=${elapsed}ms`);
  check(r.kind === 'threw' && !/HTTP 401/.test(r.error.message),
    'dead read is classified as a cookie-container fault, not HTTP 401', JSON.stringify(r).slice(0, 200));
  restoreCm();
}

// ── 6. CookieManager 抛异常 → 分类为容器故障，不是 401 ──
{
  cm.__reset(); restoreCm();
  cm.get = () => Promise.reject(Object.assign(new Error('native boom'), { code: 'E_NATIVE' }));
  const c = conn(fetchSetsCookie());
  const r = await bounded(c.loginWithToken(SECRET_TOKEN));
  check(r.kind === 'threw' && !/HTTP 401/.test(r.error.message),
    'CookieManager exception is not misreported as HTTP 401', JSON.stringify(r).slice(0, 200));
  restoreCm();
}

// ── 7. cookie 容器不可用（模块加载不到）→ 不算残留问题，登录仍可按服务端判定 ──
{
  cm.__reset(); restoreCm();
  fs.writeFileSync(ABSENT_FLAG, '1');
  const res = await clearNativeCookieJarDetailed(BASE);
  check(res.kind === 'unavailable', 'absent native module is unavailable, not unverified', JSON.stringify(res));
  const c = conn(fetchNoCookie(401));
  const r = await bounded(c.loginWithToken('wrong-token'));
  check(r.kind === 'threw' && /401/.test(r.error.message), 'with no native jar the server verdict still applies', JSON.stringify(r).slice(0, 160));
  try { fs.unlinkSync(ABSENT_FLAG); } catch {}
}

// ── 8. 旧 cookie 存在但新 token 无效 → 不得用旧 cookie 判成功 ──
{
  cm.__reset(); restoreCm();
  await cm.set(BASE, { name: 'dsh-auth-old', value: 'old-session' });
  const c = conn(fetchNoCookie(401));
  const r = await bounded(c.loginWithToken('invalid-new-token'));
  check(r.kind === 'threw', 'old cookie must not authenticate an invalid new token', JSON.stringify(r).slice(0, 160));
  const names = Object.keys((await cm.get(BASE)) ?? {});
  check(names.length === 0, 'pre-login cleanup removed the old cookie', names.join(','));
}

// ── 9. 网络连接中断 → 有界、归类为 fetch 阶段失败 ──
{
  cm.__reset(); restoreCm();
  const c = conn(async () => { throw new TypeError('Network request failed'); });
  const r = await bounded(c.loginWithToken(SECRET_TOKEN));
  check(r.kind === 'threw' && /fetch/.test(r.error.message), 'network interruption is a fetch-stage failure', JSON.stringify(r).slice(0, 160));
}

// ── 10. 失败后重试可成功（UI 可恢复）──
{
  cm.__reset(); restoreCm();
  cm.get = () => new Promise(() => {});
  const c1 = conn(fetchSetsCookie());
  const first = await bounded(c1.loginWithToken(SECRET_TOKEN));
  check(first.kind === 'threw', 'first attempt fails bounded');
  restoreCm();
  const c2 = conn(fetchSetsCookie());
  const second = await bounded(c2.loginWithToken(SECRET_TOKEN));
  check(second.kind === 'settled' && typeof second.value === 'string', 'retry after a container fault succeeds', JSON.stringify(second).slice(0, 120));
}

// ── 11. 错误信息不泄露 token / cookie 值 ──
{
  cm.__reset(); restoreCm();
  cm.get = () => Promise.reject(new Error('leak ' + SECRET_COOKIE));
  const c = conn(fetchSetsCookie());
  const r = await bounded(c.loginWithToken(SECRET_TOKEN));
  const msg = r.kind === 'threw' ? r.error.message : '';
  check(!msg.includes('SECRET-COOKIE-VALUE-123') && !msg.includes(SECRET_TOKEN),
    'error text carries no cookie value or token', msg.slice(0, 160));
  restoreCm();
}

cm.__reset(); restoreCm();
console.log(`\nN1 cookie pairing: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);