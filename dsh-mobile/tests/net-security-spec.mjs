/**
 * 网络通信安全测试。
 *
 * 覆盖四件事：
 *   1. 明文 HTTP 只允许私有地址（公网必须 https）
 *   2. token 脱敏（不出现在错误信息 / 日志文本里）
 *   3. Android 侧配置没有「全局放开明文」还能保留局域网能力
 *   4. 日志和 pairing.json 落在加固过的目录
 */

import { readFileSync, existsSync } from 'node:fs';
import {
  checkBaseUrlSecurity,
  isPlainHttp,
  isPublicHost,
  redactUrl,
  safeErrorMessage,
} from '../src/core/net-security.ts';

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
function check(n, fn) {
  try {
    const r = fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

// ── 1. 地址安全校验 ─────────────────────────────────────────────
const ALLOW = [
  ['局域网 192.168', 'http://192.168.151.223:3095'],
  ['局域网 10.x', 'http://10.0.2.2:3095'],
  ['局域网 172.16-31', 'http://172.20.1.5:3095'],
  ['Tailscale 100.64/10', 'http://100.101.102.103:3095'],
  ['链路本地 169.254', 'http://169.254.1.1:3095'],
  ['回环', 'http://127.0.0.1:3095'],
  ['localhost', 'http://localhost:3095'],
  ['公网 https', 'https://xxx.trycloudflare.com'],
  ['公网 https 带 IP', 'https://203.0.113.5:443'],
];

for (const [name, url] of ALLOW) {
  check(`允许：${name}`, () => {
    const r = checkBaseUrlSecurity(url);
    return r === null ? true : `被拒了：${r}`;
  });
}

const DENY = [
  ['公网 http 域名', 'http://evil.example.com'],
  ['公网 http IP', 'http://203.0.113.5:3095'],
  ['公网 http 带端口', 'http://1.2.3.4:8080'],
  ['非 http 协议', 'ftp://192.168.1.1'],
  ['file 协议', 'file:///etc/passwd'],
];

for (const [name, url] of DENY) {
  check(`拒绝：${name}`, () => {
    const r = checkBaseUrlSecurity(url);
    return r !== null ? true : '居然放行了';
  });
}

check('畸形地址被拒', () => checkBaseUrlSecurity('not a url') !== null);
check('空串被拒', () => checkBaseUrlSecurity('') !== null);

// ── 2. token 脱敏 ───────────────────────────────────────────────
const TOKEN = 'UduFeAGTmhPNOMmx9dkLmYn3rmzuVPv6gFWnanrGE0E';

check('脱敏：URL 查询串里的 token', () => {
  const out = redactUrl(`http://192.168.1.1:3095/?token=${TOKEN}`);
  return !out.includes(TOKEN) && out.includes('token=***') ? true : out;
});

check('脱敏：Cookie 头', () => {
  const out = redactUrl(`Cookie: dsh-auth-abc=${TOKEN}`);
  return !out.includes(TOKEN) ? true : out;
});

check('脱敏：dsh-auth-xxx=v1.xxx', () => {
  const out = redactUrl(`dsh-auth-Kt_5zaFxzi=v1.eyJ2ZXJzaW9uIjoxfQ.sig`);
  return !out.includes('eyJ2ZXJzaW9uIjoxfQ') ? true : out;
});

check('脱敏：裸的长 token', () => {
  const out = redactUrl(`连接失败 ${TOKEN} 结束`);
  return !out.includes(TOKEN) ? true : out;
});

check('脱敏：不影响普通文本', () => {
  const out = redactUrl('局域网地址 192.168.1.1:3095，服务运行中');
  return out === '局域网地址 192.168.1.1:3095，服务运行中' ? true : out;
});

check('脱敏：safeErrorMessage 处理 Error', () => {
  const out = safeErrorMessage(new Error(`fetch failed for ?token=${TOKEN}`));
  return !out.includes(TOKEN) ? true : out;
});

check('脱敏：safeErrorMessage 处理非 Error', () => {
  const out = safeErrorMessage(`raw string with token=${TOKEN}`);
  return !out.includes(TOKEN) ? true : out;
});

// ── 3. Android 配置 ─────────────────────────────────────────────
const manifest = readFileSync(
  'android/app/src/main/AndroidManifest.xml',
  'utf8',
);
const nsc = readFileSync(
  'android/app/src/main/res/xml/network_security_config.xml',
  'utf8',
);

check('manifest 不再有 usesCleartextTraffic（避免和 NSC 语义打架）', () =>
  !manifest.includes('android:usesCleartextTraffic')
    ? true
    : '还在用 usesCleartextTraffic，会覆盖 NSC 的部分语义',
);

check('manifest 引用了 networkSecurityConfig', () =>
  manifest.includes('android:networkSecurityConfig="@xml/network_security_config"')
    ? true
    : '没引用网络配置',
);

check('NSC 允许明文（局域网必需）', () =>
  nsc.includes('cleartextTrafficPermitted="true"') ? true : '局域网会连不上',
);

check('debug 构建才信任用户证书', () => {
  const i = nsc.indexOf('debug-overrides');
  if (i < 0) return '没有 debug-overrides';
  return nsc.slice(i).includes('src="user"') ? true : 'debug 段里没有用户证书';
});

check('release 段不信任用户证书', () => {
  // base-config 里只能有系统证书
  const m = /<base-config[\s\S]*?<\/base-config>/.exec(nsc);
  if (!m) return '找不到 base-config';
  return !m[0].includes('src="user"') ? true : 'release 也信任用户证书，有 MITM 风险';
});

// ── 4. 代码里没有明文发 token 到公网的口子 ──────────────────────
const transport = readFileSync('src/core/transport/index.ts', 'utf8');

check('loginWithToken 有地址安全校验', () => {
  const i = transport.indexOf('async loginWithToken');
  if (i < 0) return '找不到 loginWithToken';
  const body = transport.slice(i, i + 900);
  return body.includes('checkBaseUrlSecurity') ? true : '登录前没校验地址';
});

check('登录失败的错误信息做了脱敏', () => {
  const i = transport.indexOf('连接失败（fetch 阶段）');
  if (i < 0) return '找不到错误信息';
  const around = transport.slice(Math.max(0, i - 200), i + 300);
  return around.includes('redactUrl') ? true : '错误信息里直接拼了 baseUrl';
});

const gateway = readFileSync('src/core/approvalGateway.ts', 'utf8');
check('网关 close reason 做了脱敏', () => {
  const i = gateway.indexOf("ev?.reason");
  if (i < 0) return '找不到 reason 使用处';
  const around = gateway.slice(Math.max(0, i - 300), i + 200);
  return around.includes('redactUrl') ? true : '服务端 reason 会直接显示给用户';
});

const pairScreen = readFileSync('src/screens/PairScreen.tsx', 'utf8');
check('配对页在连接前校验地址安全性', () =>
  pairScreen.includes('checkBaseUrlSecurity')
    ? true
    : '配对页没校验，用户要等连接失败才知道地址不安全',
);

// ── 5. 日志与凭据落盘位置 ───────────────────────────────────────
const startWeb = readFileSync('../start-dsh-web.ps1', 'utf8');

check('日志不再放 %TEMP%', () => {
  // 允许注释里提到 TEMP，但不能有实际的 Join-Path $env:TEMP 写日志
  const code = startWeb
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  return /Join-Path \$env:TEMP \("dsh-web-/.test(code)
    ? '日志还是写在 %TEMP%，含 token 且权限宽松'
    : true;
});

check('日志落在状态目录的 logs/ 下', () =>
  startWeb.includes("Join-Path $stateDir 'logs'") ? true : '日志目录不在状态目录下',
);

check('日志文件收紧了 ACL', () => {
  const i = startWeb.indexOf("Join-Path $logDir");
  if (i < 0) return '找不到日志路径';
  const after = startWeb.slice(i, i + 1800);
  return after.includes('Set-Acl') ? true : '日志含 token 但没收紧权限';
});

check('pairing.json 收紧了 ACL', () => {
  const i = startWeb.indexOf("$pairFile = Join-Path $stateDir 'pairing.json'");
  if (i < 0) return '找不到 pairing.json 写入处';
  const after = startWeb.slice(i, i + 2000);
  return after.includes('Set-Acl') ? true : 'pairing.json 含 token 但没收紧权限';
});

check('$stateDir 在日志段之前定义', () => {
  const stateIdx = startWeb.indexOf('$stateDir = if ($env:DSH_STATE_DIR)');
  const logIdx = startWeb.indexOf("Join-Path $stateDir 'logs'");
  return stateIdx > 0 && logIdx > stateIdx ? true : '$stateDir 用在了定义之前（会拿到 $null）';
});

check('$stateDir 只定义一次', () => {
  const count = (startWeb.match(/\$stateDir = if/g) || []).length;
  return count === 1 ? true : `定义了 ${count} 次，后面的会覆盖前面`;
});

check('PS 脚本带 BOM（否则 5.1 会乱码）', () => {
  const b = readFileSync('../start-dsh-web.ps1');
  return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf
    ? true
    : '无 BOM，PowerShell 5.1 会把中文读成乱码并报语法错';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
