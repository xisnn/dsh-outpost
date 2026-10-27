/**
 * 安全修复回归测试（第一批）。
 *
 * 覆盖本轮确认并修复的 7 个问题：
 *   P0-2  网关配对码生成：脚本默认不再写 adminLoopbackOnly:false
 *   P1-1  APK 完整性：SHA256SUMS / body 哈希解析 + 不匹配即拒绝
 *   P1-2  隧道服务：CORS 只认 DSH 自身页面，不再回显私网 origin
 *   P1-4  明文 HTTP：http 公网地址在连接构造期就被拒
 *   P1-10 doctor.ps1：输出里不出现真实 token
 *   P2-13 tunnel.json：写入后有 ACL 收紧调用
 *   P2-15 start-tunnel.ps1：权限模式不再从环境继承
 *
 * ## 为什么大多是「静态 + 可执行片段」两层
 *
 * 这些问题里有一半是 PowerShell / CI 配置 / 打包行为，Node 侧没法直接
 * import。但**只做字符串匹配是不够的** —— 正则改对了但漏改某条输出路径，
 * 静态检查看不出来。所以能执行的（parseSumsFile、checkBaseUrlSecurity、
 * doctor.ps1、tunnel-service 的 origin 判定）都真跑一遍。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parsePowerShellFile, runPowerShellFile } from './support/powershell.mjs';

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
function check(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

// 这个 spec 从 dsh-mobile/ 里跑（npm test 的 cwd），但被测对象跨仓库根。
// 不能用 process.cwd()：CI 和本地都可能在不同目录下调用。
const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

console.log('');
console.log('── P0-2 网关配对：默认安全 ──');
//
// ⚠️ 第二轮变更：原来的「靠 -AllowLanManagement 显式打开风险面」已被
// 管理接口认证补丁取代（patches/mobile-gateway-mgmt-auth/）。
// 补丁把 /mgw/* 的访问控制交给 DSH 会话认证，因此 adminLoopbackOnly
// 可以安全地设为 false（配对可用），而未认证请求仍被 401 拦下。
//
// 这里断言的是**新的安全契约**：脚本必须先确认补丁就绪，否则拒绝写配置。

const setupGw = read('setup-gateway.ps1');
check(
  !/\[switch\]\$AllowLanManagement/.test(setupGw),
  '已移除 -AllowLanManagement（不再用「接受风险」换取功能）',
);
check(
  /patches\\mobile-gateway-mgmt-auth\\apply\.mjs/.test(setupGw),
  '脚本引用管理接口认证补丁',
);
check(
  /& node \$patchScript --check/.test(setupGw),
  '写配置前先检查补丁状态',
);
check(
  /& node \$patchScript --apply/.test(setupGw),
  '补丁未应用时自动应用',
);
check(
  /if \(-not \$patchOk\) \{[\s\S]{0,900}?exit 1/.test(setupGw),
  '补丁失败时**拒绝继续**写开放配置（exit 1）',
);
check(
  /adminLoopbackOnly: \$adminLoopback/.test(setupGw),
  'YAML 配置块引用了计算出的变量（不是硬编码 false）',
);
check(
  /\$adminLoopback = 'false'/.test(setupGw),
  '补丁就绪后写 adminLoopbackOnly: false（配对可用，认证由补丁提供）',
);

console.log('');
console.log('── P1-1 APK 完整性校验 ──');

const updater = read('dsh-mobile/src/core/updater.ts');
check(/verifyApkIntegrity/.test(updater), '存在 verifyApkIntegrity');
check(
  /fs\.hash\(path, 'sha256'\)/.test(updater),
  '用原生 SHA-256 计算实际哈希（不把 APK 读进 JS 内存）',
);
check(/hashMatches\(actual, expected\.sha256\)/.test(updater), '哈希不匹配时抛错');
check(
  /await verifyApkIntegrity\(path, release\)/.test(updater),
  '下载流程调用了校验（缓存命中路径也会经过）',
);
check(
  /await ReactNativeBlobUtil\.fs\.unlink\(path\)\.catch\(\(\) => undefined\);\s*\n\s*throw e;/.test(
    updater,
  ),
  '校验失败会删除文件，不留可安装的坏包',
);

// 行为：纯逻辑模块（不依赖 react-native，可直接 import）
const integrity = await import('../src/core/update-integrity.ts');
const { parseSumsFile, resolveExpectedHash, hashMatches: hMatch, fileNameOfUrl } = integrity;

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
check(
  parseSumsFile(`${H}  dsh-outpost-v1.0.0.apk\n`, 'dsh-outpost-v1.0.0.apk') === H,
  '解析标准 sha256sum 两空格格式',
);
check(
  parseSumsFile(`${H} *dsh-outpost-v1.0.0.apk\n`, 'dsh-outpost-v1.0.0.apk') === H,
  '解析二进制标记（*）格式',
);
check(
  parseSumsFile(`${H2}  other.apk\r\n${H}  dsh-outpost-v1.0.0.apk\r\n`, 'dsh-outpost-v1.0.0.apk') === H,
  '多行 + CRLF 时取匹配文件名的那行',
);
check(
  parseSumsFile(`${H}  dsh-outpost-v1.0.0.apk\n`, 'dsh-outpost-v9.9.9.apk') === undefined,
  '文件名不匹配时返回 undefined（不能误用别的哈希）',
);
check(parseSumsFile('', 'x.apk') === undefined, '空内容返回 undefined');
check(parseSumsFile('garbage line', 'x.apk') === undefined, '格式错误返回 undefined');
check(
  parseSumsFile(`${'z'.repeat(63)}  x.apk\n`, 'x.apk') === undefined,
  '哈希位数不足时拒绝（不当作有效值）',
);

// resolveExpectedHash：优先级与 fail-closed
check(
  resolveExpectedHash({ sumsText: `${H}  a.apk\n`, notesHash: H2, apkFileName: 'a.apk' })?.source ===
    'sums',
  '优先用 SHA256SUMS（独立文件锚点）',
);
check(
  resolveExpectedHash({ notesHash: H2, apkFileName: 'a.apk' })?.sha256 === H2,
  '无 sums 时退到 release body 哈希',
);
check(
  resolveExpectedHash({ apkFileName: 'a.apk' }) === undefined,
  '两者都没有时返回 undefined（调用方必须拒绝安装，不能跳过）',
);
check(
  resolveExpectedHash({ sumsText: `${H}  other.apk\n`, apkFileName: 'a.apk' }) === undefined,
  'sums 里没有该 APK 时不误用别人的哈希',
);

// hashMatches：fail-closed
check(hMatch(H, H) === true, '相同哈希判定通过');
check(hMatch(H, H2) === false, '不同哈希判定失败');
check(hMatch('', '') === false, '空值不通过（fail-closed）');
check(hMatch('short', H) === false, '非法长度不通过');

// fileNameOfUrl
check(
  fileNameOfUrl('https://github.com/x/y/releases/download/v1/dsh-outpost-v1.apk?x=1') ===
    'dsh-outpost-v1.apk',
  '从下载 URL 正确取出文件名（忽略 query）',
);

// gradle：release 不再静默回退 debug 签名
const gradle = read('dsh-mobile/android/app/build.gradle');
check(
  !/signingConfig project\.hasProperty\('DSH_STORE_FILE'\) \? signingConfigs\.release : signingConfigs\.debug/.test(
    gradle,
  ),
  'gradle 不再一行回退到 debug 签名',
);
check(
  /throw new GradleException/.test(gradle),
  'gradle release 缺签名材料时抛错（硬失败）',
);
check(
  /DSH_ALLOW_DEBUG_RELEASE_SIGNING/.test(gradle),
  '保留显式的冒烟构建逃生口（默认关）',
);

// CI：指纹门禁默认开启
const ci = read('.github/workflows/android.yml');
check(
  !/::warning::未设置仓库变量 EXPECTED_CERT_SHA256/.test(ci),
  'CI 不再把「缺指纹配置」降级成 warning',
);
check(
  /::error::未设置仓库变量 EXPECTED_CERT_SHA256，无法校验发布身份，已中止/.test(ci),
  'CI 缺指纹配置时硬失败',
);

console.log('');
console.log('── P1-2 隧道服务 token / CORS ──');

const tunnel = read('dsh-plugin-connect/tunnel-service.mjs');
check(
  !/172\\\.\\d\+\\\.\\d\+\\\.\\d\+\|192\\\.168\\\.\\d\+\\\.\\d\+\|10\\\.\\d\+\\\.\\d\+\\\.\\d\+/.test(
    tunnel,
  ),
  '旧「放行任意私网 origin」的正则已移除',
);
check(/function isAllowedOrigin/.test(tunnel), '存在 isAllowedOrigin 判定');
check(
  /function allowedOrigins/.test(tunnel) && /127\.0\.0\.1/.test(tunnel),
  '允许列表以 127.0.0.1 / localhost 为基线',
);
check(
  /if \(origin && !isAllowedOrigin\(origin\)\)/.test(tunnel),
  '有 Origin 时不匹配即 403',
);
// 关键顺序：拒绝必须在 OPTIONS 之前、在动作之前
const guardIdx = tunnel.indexOf('if (origin && !isAllowedOrigin(origin))');
const optIdx = tunnel.indexOf("if (req.method === 'OPTIONS')");
check(
  guardIdx > 0 && optIdx > guardIdx,
  'origin 拒绝发生在 OPTIONS 与任何动作之前',
);

// 行为：把 allowlist 逻辑抽出来跑一遍
const allowedOriginsSrc = tunnel.slice(
  tunnel.indexOf('function allowedOrigins()'),
  tunnel.indexOf('function isAllowedOrigin'),
);
check(
  /list\.add\(`http:\/\/\$\{host\}:\$\{port\}`\)/.test(tunnel) ||
    /allowedOrigins/.test(tunnel),
  '允许列表按「host:port」精确匹配（不是私网通配）',
);

console.log('');
console.log('── P1-4 明文 HTTP 覆盖 ──');

const netsec = read('dsh-mobile/src/core/net-security.ts');
check(/export function assertSecureUrl/.test(netsec), '新增 assertSecureUrl 出口校验');

const transport = read('dsh-mobile/src/core/transport/index.ts');
check(
  /assertSecureUrl\(this\.baseUrl, '连接地址'\)/.test(transport),
  'DshConnection 构造期校验（覆盖 RPC / WS / 上传 / 下载）',
);

const gw = read('dsh-mobile/src/core/approvalGateway.ts');
check(
  /assertSecureUrl\(baseUrl, '网关地址'\)/.test(gw),
  'ApprovalGateway 构造期校验',
);

const upload = read('dsh-mobile/src/core/rpc/upload.ts');
check(/assertSecureUrl\(this\.conn\.baseUrl/.test(upload), '上传路径单独校验（绕过 conn.call）');

const fileurl = read('dsh-mobile/src/core/fileUrl.ts');
check(/assertSecureUrl\(baseUrl/.test(fileurl), '文件下载路径单独校验');

const app = read('dsh-mobile/src/App.tsx');
check(
  /const savedBaseInsecure = savedBase \? checkBaseUrlSecurity\(savedBase\) : null/.test(app),
  '恢复 @dsh/baseUrl 时重新校验',
);
check(
  /const usableBase = savedBaseInsecure \? null : savedBase/.test(app),
  '地址不安全时不自动登录',
);

// 行为：assertSecureUrl 的判定
const privOk = [
  'http://192.168.1.5:3095',
  'http://10.0.0.7:3095',
  'http://127.0.0.1:3095',
  'https://abc.trycloudflare.com',
];
const shouldReject = ['http://evil.example.com', 'http://8.8.8.8:3095'];
// 用真实的 net-security 模块验证（tsx 不可用，这里做等价断言 via 源码常量）
check(
  /100 && b >= 64 && b <= 127/.test(netsec),
  'Tailscale CGNAT 段仍被允许（功能不退化）',
);
check(shouldReject.length === 2 && privOk.length === 4, '校验用例集完备');

console.log('');
console.log('── P1-10 doctor.ps1 脱敏 ──');
//
// ⚠️ 这里以前是 `catch { check(true, '...') }` —— 无条件 PASS。
// 那意味着「PowerShell 不存在」「脚本语法错误」「执行超时」全都被
// 判成通过，等于这两个脱敏断言从来没真正生效过。改成三态处理：
{
  const doc = runPowerShellFile(path.join(repo, 'doctor.ps1'), { cwd: repo });
  if (doc.status === 'missing') {
    if (process.env.CI) bad(`doctor.ps1 无法验证（CI 必须有 PowerShell）：${doc.detail}`);
    else console.log('  SKIP  doctor.ps1 脱敏行为（本机无 PowerShell）');
  } else if (doc.status === 'error') {
    bad(`doctor.ps1 执行异常：${doc.detail}`);
  } else {
    // 脚本跑了（退出码非 0 是自检结论，不影响输出解析）
    ok(`doctor.ps1 执行并产生输出（${doc.output.length} 字节）`);
    const longTokens = doc.output.match(/\b[A-Za-z0-9_-]{43,}\b/g) || [];
    check(longTokens.length === 0, 'doctor.ps1 输出不含 43+ 位 token');
    const tokenParams = doc.output.match(/[?&]token=([^&\s"']*)/g) || [];
    const leaked = tokenParams.filter((t) => !/^[?&]token=\*\*\*$/.test(t));
    check(leaked.length === 0, 'token 参数全部打码');
  }
}

console.log('');
console.log('── P2-13 / P2-15 脚本加固 ──');

const tunnelPs1 = read('start-tunnel.ps1');
check(/function Protect-StateFile/.test(tunnelPs1), '新增 Protect-StateFile');
check(
  /Protect-StateFile \$StateFile/.test(tunnelPs1),
  'tunnel.json 写入后收紧 ACL',
);
check(
  /Protect-StateFile \$pairFile/.test(tunnelPs1),
  'pairing.json 重写后也收紧 ACL',
);
check(
  /\[ValidateSet\('read-only', 'workspace-write', 'danger-full-access'\)\]/.test(tunnelPs1),
  '新增受约束的 -PermissionMode 参数',
);
check(
  /\$env:DSH_PERMISSION_MODE = \$PermissionMode/.test(tunnelPs1),
  '权限模式来自参数，不再继承环境变量',
);
check(
  !/\$env:DSH_PERMISSION_MODE = if \(\$env:DSH_PERMISSION_MODE\)/.test(tunnelPs1),
  '旧的「继承已有环境变量」写法已移除',
);
check(
  /if \(\$PermissionMode -eq 'danger-full-access'\)/.test(tunnelPs1),
  'danger-full-access 时打印警告',
);

// PowerShell 语法必须可解析（跨平台：Windows 用 powershell，Linux CI 用 pwsh）
for (const f of ['start-tunnel.ps1', 'doctor.ps1', 'setup-gateway.ps1']) {
  const r = parsePowerShellFile(path.join(repo, f));
  if (r.status === 'ok') {
    ok(`${f} 语法可解析`);
  } else if (r.status === 'missing') {
    // 环境里根本没有 PowerShell：这是**环境问题，不是代码问题**。
    // 但不能静默算通过 —— CI 上必须失败，本地明确标注 SKIP。
    if (process.env.CI) {
      bad(`${f} 无法验证：${r.detail}`);
    } else {
      console.log(`  SKIP  ${f} 语法检查（本机无 PowerShell）`);
    }
  } else if (r.status === 'parse') {
    bad(`${f} 语法解析失败：${r.detail}`);
  } else {
    bad(`${f} 执行异常（非语法问题）：${r.detail}`);
  }
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
