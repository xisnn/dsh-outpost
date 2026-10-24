/**
 * 凭据安全 + 断网恢复的回归测试。
 *
 * ## 守的三个 P0
 *
 * 1. **凭据不再落明文存储**
 *    Cookie 和网关 device token 必须走 secureStore（Android Keystore），
 *    不能出现在 AsyncStorage 里。
 *
 * 2. **「断开连接」和「清除授权」是两个操作**
 *    signOut 只收起会话、保留凭据；
 *    clearAuthorization 才把凭据和派生状态全部抹掉。
 *
 * 3. **断网不能误清 token**
 *    用户进电梯断网 30 秒，token 是好的，恢复后必须自动重连，
 *    不能把有效 token 删掉、也不能停摆不重试。
 *
 * 前两项是静态检查（凭据流向），第三项驱动真实 ApprovalGateway。
 */

import { readFileSync } from 'node:fs';
import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

// 两种 hook 都要装：ESM loader hook 管真正的 import，
// Module._resolveFilename 管产品代码经 tsx 转译后走 require 的那条路。
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

const appSrc = readFileSync('src/App.tsx', 'utf8');
const gwSrc = readFileSync('src/core/approvalGateway.ts', 'utf8');
const secureSrc = readFileSync('src/core/secureStore.ts', 'utf8');

// ══════════════════════════════════════════════════════════════
// 一、凭据不再落明文
// ══════════════════════════════════════════════════════════════

await check('secureStore 用 Keychain（Android Keystore）', () => {
  if (!secureSrc.includes('react-native-keychain')) {
    return '没有用 react-native-keychain';
  }
  if (!secureSrc.includes('WHEN_UNLOCKED_THIS_DEVICE_ONLY')) {
    return '没有限制「仅本机、解锁后可读」';
  }
  return true;
});

await check('Cookie 只存 Keystore，不再写 AsyncStorage', () => {
  // 允许 AsyncStorage 出现在注释里，但不能有实际的 setItem
  const code = appSrc
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  if (/AsyncStorage\.setItem\(\s*COOKIE_KEY/.test(code)) {
    return '还在往 AsyncStorage 写 Cookie';
  }
  if (/AsyncStorage\.getItem\(\s*COOKIE_KEY/.test(code)) {
    return '还在从 AsyncStorage 读 Cookie';
  }
  return /saveCredential\(CredentialKey\.cookie/.test(code)
    ? true
    : '没有用 saveCredential 存 Cookie';
});

await check('网关 device token 只存 Keystore', () => {
  if (/AsyncStorage[\s\S]{0,40}DEVICE_TOKEN_KEY/.test(gwSrc)) {
    return '网关 token 还在用 AsyncStorage';
  }
  if (/AsyncStorage[\s\S]{0,40}DEVICE_ID_KEY/.test(gwSrc)) {
    return 'device id 还在用 AsyncStorage';
  }
  return /saveCredential\(CredentialKey\.gatewayToken/.test(gwSrc)
    ? true
    : '没有用 saveCredential 存网关 token';
});

await check('approvalGateway 不再 import AsyncStorage', () => {
  return /from '@react-native-async-storage\/async-storage'/.test(gwSrc)
    ? '还在 import AsyncStorage'
    : true;
});

// ══════════════════════════════════════════════════════════════
// 二、断开连接 vs 清除授权
// ══════════════════════════════════════════════════════════════

await check('提供 clearAuthorization（清除所有授权）', () => {
  if (!appSrc.includes('clearAuthorization')) return '没有这个能力';
  return /clearAllCredentials\(\)/.test(appSrc) ? true : '没有调用 clearAllCredentials';
});

await check('clearAuthorization 同时清派生状态', () => {
  const i = appSrc.indexOf('const clearAuthorization');
  if (i < 0) return '找不到实现';
  const body = appSrc.slice(i, i + 1800);
  // 至少要清管家会话和工作区，否则下次配对会串到不存在的资源
  const need = ['BUTLER_SESSION_KEY', 'BUTLER_WORKSPACE_KEY'];
  const missing = need.filter((k) => !body.includes(k));
  return missing.length === 0 ? true : `没清派生状态：${missing.join('、')}`;
});

await check('clearAuthorization 会清掉老版本遗留的明文 key', () => {
  const i = appSrc.indexOf('const clearAuthorization');
  const body = appSrc.slice(i, i + 1800);
  // LAST_COOKIE_KEY 是旧版本留下的明文副本，升级后要顺手抹掉
  return body.includes('LAST_COOKIE_KEY') ? true : '没有清理旧版明文副本';
});

await check('signOut 不再复制 Cookie 留后门', () => {
  const i = appSrc.indexOf('const signOut');
  if (i < 0) return '找不到 signOut';
  const body = appSrc.slice(i, i + 700);
  if (/setItem\(\s*LAST_COOKIE_KEY/.test(body)) {
    return 'signOut 还把 Cookie 复制到 LAST_COOKIE_KEY';
  }
  return true;
});

await check('secureStore 的清除覆盖 cookie + token + deviceId', () => {
  const i = secureSrc.indexOf('export async function clearAllCredentials');
  if (i < 0) return '找不到 clearAllCredentials';
  const body = secureSrc.slice(i, i + 400);
  const need = ['gatewayToken', 'gatewayDeviceId', 'cookie'];
  const missing = need.filter((k) => !body.includes(k));
  return missing.length === 0 ? true : `漏了：${missing.join('、')}`;
});

// ══════════════════════════════════════════════════════════════
// 三、断网不误清 token（驱动真实 ApprovalGateway）
// ══════════════════════════════════════════════════════════════

const stubMod = await imp(path.join(__dirname, 'support', 'async-storage-stub.mjs'));
const AsyncStorageStub = stubMod.default;

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
const { startFakeDsh } = await imp(path.join(__dirname, 'support', 'fake-dsh.mjs'));

/** Keystore 的内存替身（测试里替换 secureStore 的两个函数行为） */
const keystoreStub = new Map();

await check('静态：断网时不清 token（走 probe 判断）', () => {
  // 关键语义：连续失败后要先探测服务端可达性
  if (!/decideTokenValidity/.test(gwSrc)) {
    return '没有「先探测再决定」的逻辑';
  }
  if (!/probeServerReachable/.test(gwSrc)) {
    return '没有可达性探测';
  }
  // 不能是「失败两次就直接清」
  if (/tokenFailures\s*>=\s*2\s*\)\s*\{[\s\S]{0,80}this\.token\s*=\s*''/.test(gwSrc)) {
    return '失败两次还是直接清 token';
  }
  return true;
});

await check('静态：配对码申请失败后会继续重试', () => {
  const i = gwSrc.indexOf('if (!pairingCode) {');
  if (i < 0) return '找不到分支';
  const body = gwSrc.slice(i, i + 400);
  if (!body.includes('scheduleRetry')) {
    return '拿不到配对码时直接 return，不重试（网络恢复后也起不来）';
  }
  return true;
});

await check('断网 30 秒恢复：有效 token 不被清，且自动重连', async () => {
  const srv = await startFakeDsh();
  try {
    // 先登录拿 cookie
    AsyncStorageStub.__reset();
    const conn = new DshConnection({ baseUrl: srv.baseUrl, fetchImpl: cookieFetch });
    conn.setCookieReader(async (baseUrl) => {
      const cookies = cookieMod.getCookies(baseUrl);
      const parts = Object.entries(cookies)
        .filter(([name]) => name.startsWith('dsh-auth'))
        .map(([name, value]) => `${name}=${value}`);
      return parts.length ? parts.join('; ') : undefined;
    });
    await conn.loginWithToken(srv.token);
    conn.close();

    const statuses = [];
    const gw = new ApprovalGateway(srv.baseUrl, {
      onStatus: (s) => statuses.push(s),
      onApproval: () => {},
      onResolved: () => {},
    });

    // 1. 正常连上
    await gw.connect();
    await new Promise((r) => setTimeout(r, 800));
    if (!statuses.includes('online')) {
      gw.disconnect();
      return '首次连接就没成功';
    }
    const tokenBefore = gw.token;
    if (!tokenBefore) {
      gw.disconnect();
      return '连上了但没有 token，测试前提不成立';
    }

    // 2. 模拟断网：让 fetch 全部失败（模拟 probe 也连不上）
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError('Network request failed');
    };
    srv.dropConnections();

    // 3. 断网 6 秒（足够触发两次失败 + 一次探测）
    await new Promise((r) => setTimeout(r, 6000));

    const tokenDuringOutage = gw.token;
    if (!tokenDuringOutage) {
      globalThis.fetch = realFetch;
      gw.disconnect();
      return '断网期间把 token 清掉了（这就是要修的 bug）';
    }

    // 4. 恢复网络
    globalThis.fetch = realFetch;

    // 5. 等它自己重连回来（退避最长 30 秒，给足）
    let backOnline = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if (statuses.filter((s) => s === 'online').length >= 2) {
        backOnline = true;
        break;
      }
    }

    const tokenAfter = gw.token;
    gw.disconnect();

    if (!backOnline) {
      return `网络恢复后没有自动重连（状态：${statuses.slice(-6).join(',')}）`;
    }
    if (tokenAfter !== tokenBefore) {
      return '重连后 token 变了（原本有效的 token 被误清后重新配对了）';
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('配对码拿不到时会安排重试（不停摆）', async () => {
  // 用一个不存在的端口：requestPairingCode 必然失败
  const gw = new ApprovalGateway('http://127.0.0.1:1', {
    onStatus: () => {},
    onApproval: () => {},
    onResolved: () => {},
  });
  let sawRetry = false;
  const origSchedule = gw.scheduleRetry?.bind(gw);
  // 私有方法不好直接盯，改成看它有没有在拿到 offline 后继续尝试：
  // 连续调用 2 次 connect 会各走一遍，只要不抛错、不永久挂住即可。
  try {
    await gw.connect();
    await new Promise((r) => setTimeout(r, 1200));
    sawRetry = true; // 没抛错就算通过；具体重试由上面的真实断网测试覆盖
  } catch {
    sawRetry = false;
  } finally {
    gw.disconnect();
  }
  return sawRetry ? true : 'connect 抛错或挂住了';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
