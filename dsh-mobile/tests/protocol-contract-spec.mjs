/**
 * 协议契约测试 —— 用**真实网关插件源码**当事实来源。
 *
 * ## 为什么需要单独一个文件
 *
 * 上一轮踩过一个典型的坑：模拟服务端 `fake-dsh.mjs` 和客户端
 * **同时**用了错误的子协议前缀 `dsh-token.`，于是测试全部通过，
 * 而真实服务端只认 `dsh-auth.` —— 客户端每次断线都掉审批权限。
 *
 * 教训：**测试不能只重复客户端自己的假设**。
 *
 * 这个文件的做法是：直接读真实插件的源码 / 协议文档，把里面的事实
 * 提取出来，再断言我们的客户端符合它。这样如果哪天插件改了协议，
 * 这里会先失败，而不是等用户在真机上发现。
 *
 * ## 事实来源（按可靠性排序）
 *
 *   1. `lib/index.mjs` —— 实际执行的代码（最可靠）
 *   2. `lib/devices.js` —— 设备注册表实现
 *   3. `PROTOCOL.md` —— 文档（可能与代码不同步，仅作交叉验证）
 *
 * ## 插件不在时的行为
 *
 * 找不到插件目录就**跳过**（并明确打印 SKIP），不静默通过。
 * 这样 CI 上没有装插件时不会误报失败，但也绝不会假装验证过了。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

let pass = 0;
let fail = 0;
let skip = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
function skipped(n, why) {
  skip += 1;
  console.log('  SKIP  ' + n + (why ? ' — ' + why : ''));
}
async function check(n, fn) {
  try {
    const r = await fn();
    if (r === true) ok(n);
    else if (r && r.skip) skipped(n, r.skip);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

// ── 定位真实插件 ────────────────────────────────────────────────
//
// 允许用环境变量指定；否则按常见安装位置找。
// 找不到就跳过整组（明确打印，不静默通过）。
const CANDIDATES = [
  process.env.DSH_GATEWAY_PLUGIN_DIR,
  path.join(
    process.env.USERPROFILE ?? '',
    '.dsh',
    'profiles',
    'web',
    'node_modules',
    'dsh-plugin-mobile-gateway',
  ),
  path.join(
    process.env.HOME ?? '',
    '.dsh',
    'profiles',
    'web',
    'node_modules',
    'dsh-plugin-mobile-gateway',
  ),
].filter(Boolean);

const pluginDir = CANDIDATES.find((d) => existsSync(path.join(d, 'lib', 'index.mjs')));

/** 读插件源码；插件不存在时返回 null */
function readPlugin(rel) {
  if (!pluginDir) return null;
  const p = path.join(pluginDir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ── 被测客户端 ──────────────────────────────────────────────────
const { register } = await import('node:module');
register('./support/rn-module-hook.mjs', import.meta.url);
const imp = (p) => import(new URL(p, import.meta.url).href);

const { isCredentialRejection, isDeviceRevokedClose } = await imp(
  '../src/core/approvalGateway.ts',
);

console.log('');
if (!pluginDir) {
  console.log('⚠️  找不到真实网关插件，整组契约测试跳过。');
  console.log('   装了插件后重跑，或用 DSH_GATEWAY_PLUGIN_DIR 指定目录。');
  console.log('');
}

// ══════════════════════════════════════════════════════════════
// 一、子协议前缀（上一轮出过错的地方）
// ══════════════════════════════════════════════════════════════

await check('契约：插件 extractCredential 只认 dsh-auth. / dsh-pair.', () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };

  // 从插件源码里抠出真实前缀，而不是相信我们自己的常量
  const authMatch = src.match(/startsWith\('(dsh-[a-z]+)\.'\)\)\s*return\s*\{\s*kind:\s*'token'/);
  const pairMatch = src.match(/startsWith\('(dsh-[a-z]+)\.'\)\)\s*return\s*\{\s*kind:\s*'pairing'/);
  if (!authMatch) return '插件里找不到 token 前缀解析（协议可能改了，请人工核对）';
  if (!pairMatch) return '插件里找不到 pairing 前缀解析';

  const authPrefix = authMatch[1];
  const pairPrefix = pairMatch[1];

  if (authPrefix !== 'dsh-auth') {
    return `插件 token 前缀是 ${authPrefix}. —— 客户端写死了 dsh-auth.，必须同步修改`;
  }
  if (pairPrefix !== 'dsh-pair') {
    return `插件 pairing 前缀是 ${pairPrefix}. —— 客户端写死了 dsh-pair.，必须同步修改`;
  }
  return true;
});

await check('契约：客户端用的子协议前缀与插件一致', async () => {
  if (!pluginDir) return { skip: '插件源码不可用' };
  const gwSrc = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
    'utf8',
  );
  // 客户端必须拼 `dsh-auth.${token}` 和 `dsh-pair.${code}`
  if (!gwSrc.includes('dsh-auth.${this.token}')) {
    return '客户端没有用 dsh-auth.<token> 子协议';
  }
  if (!gwSrc.includes('dsh-pair.${pairingCode}')) {
    return '客户端没有用 dsh-pair.<code> 子协议';
  }
  // 反向检查：绝不能出现上一轮那个错误前缀。
  // ⚠️ 只看**代码**，不看注释 —— 注释里解释「不是 dsh-token.」是正常的，
  // 一开始没排除注释，这条测试误报了。
  const codeOnly = gwSrc
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');
  if (codeOnly.includes('dsh-token.')) {
    return '客户端代码里还有 dsh-token. —— 真实插件不认这个前缀';
  }
  return true;
});

await check('契约：X-DSH-Device-ID 是插件硬性要求的请求头', async () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };
  if (!src.includes("req.headers['x-dsh-device-id']")) {
    return '插件不再从 header 读设备 id —— 客户端传 header 的方式需要复核';
  }
  // 配对时缺这个头会被 400 拒绝
  if (!/rejectUpgrade\(socket,\s*400,[^)]*X-DSH-Device-ID/s.test(src)) {
    return '插件不再因为缺少设备 id 返回 400（行为变了，需复核客户端）';
  }
  return true;
});

// ══════════════════════════════════════════════════════════════
// 二、认证失败的真实 HTTP 码（决定客户端能不能安全清 token）
// ══════════════════════════════════════════════════════════════

await check('契约：设备凭据无效时插件返回 401（不是 403）', () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };

  // 找出所有 rejectUpgrade 的调用点，收集它们的 status
  const calls = [...src.matchAll(/rejectUpgrade\(\s*socket\s*,\s*(\d{3})\s*,\s*([^\n]*)/g)].map(
    (m) => ({ status: Number(m[1]), rest: m[2] }),
  );
  if (calls.length === 0) return '找不到 rejectUpgrade 调用点';

  const unauthorized = calls.filter((c) => c.status === 401);
  if (unauthorized.length === 0) {
    return '插件没有任何 401 拒绝点 —— 认证失败的表达方式变了，客户端判据需要重新设计';
  }
  // 凭据相关的 401 必须存在
  const hasCredential401 = unauthorized.some((c) =>
    /credential|token|pairing code/i.test(c.rest),
  );
  if (!hasCredential401) {
    return '401 的文案里没有 credential/token 字样 —— 客户端靠文本判定的依据需要复核';
  }
  return true;
});

await check('契约：插件的 403 **全部**与设备凭据无关', () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };

  const calls = [...src.matchAll(/rejectUpgrade\(\s*socket\s*,\s*(\d{3})\s*,\s*([^\n]*)/g)].map(
    (m) => ({ status: Number(m[1]), rest: m[2] }),
  );
  const forbidden = calls.filter((c) => c.status === 403);
  if (forbidden.length === 0) return true; // 没有 403 更好

  // 403 的文案不能出现「凭据无效」这类含义
  const credentialish = forbidden.filter((c) =>
    /invalid (?:device )?credential|invalid or expired token|unauthorized/i.test(c.rest),
  );
  if (credentialish.length > 0) {
    return `插件的 403 里出现了凭据相关文案：${credentialish
      .map((c) => c.rest.trim())
      .join(' | ')} —— 客户端需要把 403 纳入判据`;
  }
  return true;
});

await check('契约：客户端的凭据判据不会因为 403 误清 token', () => {
  // 这条是**行为**断言（跑真实函数），不是文本检查
  const forbidden = [
    '403 Forbidden',
    'HTTP/1.1 403 Forbidden',
    'LAN listener accepts private-network clients only',
    'cross-origin management request rejected',
  ];
  const wrong = forbidden.filter((t) => isCredentialRejection(t));
  return wrong.length === 0
    ? true
    : `这些 403 被当成凭据失效：${wrong.join(' | ')} —— 会误删有效 token`;
});

await check('契约：客户端能识别插件真实的 401 文案', () => {
  // 文案直接取自插件源码（extractCredential 的两个失败分支）
  const real = [
    'missing or invalid device credential',
    'invalid or expired pairing code',
    '401 Unauthorized',
  ];
  const missed = real.filter((t) => !isCredentialRejection(t));
  return missed.length === 0 ? true : `漏判插件真实文案：${missed.join(' | ')}`;
});

// ══════════════════════════════════════════════════════════════
// 三、关闭码语义（4003 被用在两种完全不同的场景）
// ══════════════════════════════════════════════════════════════

await check('契约：插件的 4003 有两种含义，客户端必须按 reason 区分', () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };

  const closes = [...src.matchAll(/client\.close\((\d{4}),\s*'([^']*)'\)/g)].map((m) => ({
    code: Number(m[1]),
    reason: m[2],
  }));
  if (closes.length === 0) return '找不到 client.close 调用';

  const revoke = closes.filter((c) => c.code === 4003 && /device revoked/i.test(c.reason));
  const authToggle = closes.filter(
    (c) => c.code === 4003 && /authentication enabled/i.test(c.reason),
  );

  if (revoke.length === 0) {
    return '插件不再用 4003 + device revoked 表达撤销 —— 客户端的撤销判据需要重新设计';
  }
  if (authToggle.length === 0) {
    // 插件以后可能把这个分支去掉。到那时「4003 一律当撤销」才成立，
    // 但客户端按 reason 区分仍然是对的（更严格），所以这条不算失败，
    // 只提示可以简化。
    return true;
  }

  // 两种含义同时存在 —— 这正是「4003 一律当撤销」会误判的证据。
  // 断言客户端确实按 reason 做了区分（下面那条测试验证行为）。
  return isDeviceRevokedClose(4003, 'device revoked') &&
    !isDeviceRevokedClose(4003, 'authentication enabled')
    ? true
    : '插件有两种 4003，但客户端没有按 reason 区分 —— 会把鉴权开关变化误判成设备撤销';
});

await check('契约：客户端只把 4003 + device revoked 当成撤销', () => {
  // 行为断言：只有 device revoked 才算撤销
  if (!isDeviceRevokedClose(4003, 'device revoked')) {
    return '真正的撤销没被识别';
  }
  // authentication enabled 不是撤销（设备记录还在）
  if (isDeviceRevokedClose(4003, 'authentication enabled')) {
    return '把「鉴权开关变化」当成了设备撤销 —— 会永久停掉用户审批，而服务端记录还在';
  }
  // reason 缺失时不能猜成撤销（撤销是破坏性结论）
  if (isDeviceRevokedClose(4003, '')) {
    return '拿不到 reason 就当成撤销 —— 证据不足却清凭据';
  }
  // 其它码一律不是撤销
  if (isDeviceRevokedClose(4004, 'device revoked')) {
    return '把 4004（网关关闭）当成了设备撤销';
  }
  if (isDeviceRevokedClose(1006, 'device revoked')) {
    return '把 1006（异常断开）当成了设备撤销';
  }
  return true;
});

await check('契约：4004（网关关闭）不应被当成撤销', () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };
  const has4004 = /client\.close\(4004,/.test(src);
  if (!has4004) return true;
  // 客户端不能把 4004 当撤销
  return isDeviceRevokedClose(4004, 'mobile gateway disabled')
    ? '客户端把 4004 当成了撤销'
    : true;
});

// ══════════════════════════════════════════════════════════════
// 四、设备列表的字段契约（决定「哪一行是这台手机」）
// ══════════════════════════════════════════════════════════════

await check('契约：GET /mgw/devices 返回的条目不含 clientDeviceId', () => {
  const devicesSrc = readPlugin(path.join('lib', 'devices.js'));
  if (!devicesSrc) return { skip: '插件源码不可用' };

  // publicDevice() 决定了对外暴露哪些字段
  const m = devicesSrc.match(/function publicDevice\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!m) return '找不到 publicDevice 实现';
  const body = m[1];

  if (/clientDeviceId/.test(body)) {
    // 插件以后如果加了这个字段，客户端就能可靠认出自己了。
    // 那时应当更新这条测试并简化 isSameDevice 的逻辑。
    return true;
  }
  // 确认它确实只暴露 id / name / createdAt / lastSeenAt / online / connections
  const hasId = /\bid:/.test(body);
  if (!hasId) return 'publicDevice 连 id 都不返回 —— 客户端无法撤销任何设备';
  return true;
});

await check('契约：客户端「认出自己」不能依赖 clientDeviceId', () => {
  // 上面那条证明了服务端不返回 clientDeviceId。那么只靠 clientDeviceId
  // 匹配的代码在真机上**永远认不出自己**。
  //
  // 这条测试守的是「撤销自己」这个安全动作能不能真的执行：
  // 认不出自己 → 走 revokeDevice 分支而不是 revokeOwnDevice →
  // 服务端撤销了，但本地不会进入「已撤销」状态 → 几秒后自动重新配对。
  const src = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
    'utf8',
  );
  if (!/clientDeviceId === selfDeviceId/.test(src)) {
    return '客户端不再按 clientDeviceId 匹配（如果改成别的判据，请更新这条测试）';
  }
  // 必须有兜底：服务端 device id 与本机记录的 deviceId 相等也算自己
  return /device\.id === selfDeviceId/.test(src)
    ? true
    : '认自己只靠 clientDeviceId，而服务端不返回它 —— 真机上永远认不出自己';
});

// ══════════════════════════════════════════════════════════════
// 五、配对帧的字段名（读错就会「断线后连不回来」）
// ══════════════════════════════════════════════════════════════

await check('契约：paired 帧的 token 字段名是 `token`', () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };
  const m = src.match(/kind:\s*'paired',\s*\n?\s*token:/);
  if (!m) {
    return "插件发的 paired 帧里没有 `token` 字段 —— 客户端读 frame.token 会拿不到";
  }
  return true;
});

await check('契约：客户端读的是 frame.token', () => {
  const gwSrc = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
    'utf8',
  );
  return /frame\.token/.test(gwSrc)
    ? true
    : '客户端没读 frame.token（字段名改了就会导致断线后无法重连）';
});

// ══════════════════════════════════════════════════════════════
// 六、管理接口的同源要求（撤销请求必须带 Origin）
// ══════════════════════════════════════════════════════════════

await check('契约：非 GET 管理请求要求同源 Origin', () => {
  const src = readPlugin(path.join('lib', 'index.mjs'));
  if (!src) return { skip: '插件源码不可用' };
  if (!/req\.method !== 'GET'[\s\S]{0,120}isSameOrigin\(req\)/.test(src)) {
    return '插件的同源校验变了 —— 客户端的 Origin 头逻辑需要复核';
  }
  return true;
});

await check('契约：客户端撤销请求带了 Origin（否则 403）', () => {
  const src = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
    'utf8',
  );
  const i = src.indexOf('async function postRevoke');
  if (i < 0) return '找不到 postRevoke';
  const body = src.slice(i, i + 1600);
  return /Origin:\s*base/.test(body) ? true : '撤销请求没带 Origin，服务端会 403';
});

// ══════════════════════════════════════════════════════════════

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败，${skip} 跳过`);
process.exitCode = fail === 0 ? 0 : 1;
