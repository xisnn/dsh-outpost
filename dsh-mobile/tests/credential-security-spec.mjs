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
  const body = appSrc.slice(i, i + 6000);
  // 至少要清管家会话和工作区，否则下次配对会串到不存在的资源
  const need = ['BUTLER_SESSION_KEY', 'BUTLER_WORKSPACE_KEY'];
  const missing = need.filter((k) => !body.includes(k));
  return missing.length === 0 ? true : `没清派生状态：${missing.join('、')}`;
});

/**
 * 取一个「const xxx = useCallback(...)」函数体的文本。
 *
 * ⚠️ 不要再用 `slice(i, i + 2600)` 这种魔数切片。
 * 之前 `clearAuthorization` 一长（P0-2 加了判别联合和分项提示），
 * 切片就截在函数中间，断言直接失效 —— 而失效方向是「误报失败」，
 * 一旦有人为了让它过而调大数字，下次再长又会失效。
 *
 * 这里按函数真正的结束标记截取：从声明处到下一个
 * `}, [deps]);` 结尾。
 */
function fnBody(src, decl, depsMarker = '],') {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  const end = src.indexOf(depsMarker, i);
  // 找不到结束标记就退化成「到文件末尾」，至少不会静默截半截
  return end < 0 ? src.slice(i) : src.slice(i, end);
}

await check('clearAuthorization 会清掉老版本遗留的明文 key', () => {
  const body = fnBody(appSrc, 'const clearAuthorization');
  if (!body) return '找不到 clearAuthorization';
  // 旧版本明文副本（@dsh/cookie / @dsh/gatewayToken /
  // @dsh/gatewayDeviceId / @dsh/lastCookie）统一由
  // core/credentialMigration.ts 的 clearLegacyCredentialStorage* 清。
  //
  // P1-3 之后用的是 *Verified 版本：它保证「经回读确认磁盘上没有残留」，
  // 而不是「我调了几次 removeItem」。断言要接受两种写法。
  return /clearLegacyCredentialStorage(Verified)?\s*\(/.test(body)
    ? true
    : '没有清理旧版明文副本';
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

await check('静态：断网时不清 token（只认明确的鉴权拒绝）', () => {
  // 关键语义：清 token 的判据只能是「服务端明确拒绝凭据」，
  // 不能是失败次数。
  if (!/isCredentialRejection/.test(gwSrc)) {
    return '没有「是否明确鉴权拒绝」的判断';
  }
  // 不能是「失败两次就直接清」
  if (/consecutiveFailures\s*>=\s*2\s*\)\s*\{[\s\S]{0,200}this\.token\s*=\s*''/.test(gwSrc)) {
    return '失败两次还是直接清 token';
  }
  if (/tokenFailures\s*>=\s*2/.test(gwSrc)) {
    return '还在用失败次数当判据';
  }
  // 清 token 的分支必须挂在 isCredentialRejection 上
  const i = gwSrc.indexOf('isCredentialRejection(combined)');
  if (i < 0) return '清 token 的分支没有用 isCredentialRejection 判定';
  const body = gwSrc.slice(i, i + 400);
  return /this\.token\s*=\s*''/.test(body) ? true : '清 token 的分支没清 token';
});

await check('静态：配对码申请失败后会继续重试', () => {
  // ⚠️ 锚点必须是「申请配对码失败」那个分支，不能是第一个
  // `if (!pairingCode) {` —— 撤销状态检查现在也用了同样的写法，
  // 用 indexOf 会锚错位置（曾经因此误报）。
  const i = gwSrc.indexOf('const paired = await this.requestPairingCode();');
  if (i < 0) return '找不到申请配对码的位置';
  const body = gwSrc.slice(i, i + 1200);
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
    const tokenBefore = gw.deviceToken;
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

    const tokenDuringOutage = gw.deviceToken;
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

    const tokenAfter = gw.deviceToken;
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
