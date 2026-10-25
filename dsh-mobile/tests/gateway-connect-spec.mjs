/**
 * 审批网关连接的回归测试。
 *
 * ## 这一版修了三个连环 bug，每一个都会让审批永久显示「到电脑上确认」
 *
 * 1. **WebSocket 没带 X-DSH-Device-ID 头**
 *    网关源码里是硬性要求：
 *      if (!clientDeviceId) rejectUpgrade(socket, 400, 'pairing requires X-DSH-Device-ID')
 *    只认 header —— 把 deviceId 塞查询串没用（服务端根本不读）。
 *    RN 的 WebSocket 构造函数第三个参数可以传 headers（非标准但 RN 支持），
 *    Android 端会逐条 addHeader。这是唯一不改原生代码的办法。
 *
 * 2. **端点硬编码 3081**
 *    /mgw/pair 返回的 endpoints 里有好几条，其中 3081 常被防火墙拦，
 *    还有 VMware 虚拟网卡的地址（手机根本连不到）。
 *    必须挑「和 baseUrl 同源」的那条（走 DSH Web 端口，已验证可达）。
 *
 * 3. **失效 token 没有自愈**
 *    服务端 claimPairing 是一次性的（`pairings.delete(codeHash)`，
 *    即使后续握手失败也算用掉），devices 注册表也可能随网关重启重置。
 *    本地存着失效 token 时，connect() 因为「有 token 就不配对」而永远
 *    拿它重试 → 永远 401。必须在 401 时清 token 并重新配对。
 */

import { readFileSync } from 'node:fs';

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

const gw = readFileSync('src/core/approvalGateway.ts', 'utf8');
const app = readFileSync('src/App.tsx', 'utf8');
const chat = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const store = readFileSync('src/core/store.ts', 'utf8');

// ── 1. WebSocket 必须带 X-DSH-Device-ID header ────────────────────
check('WebSocket 传了 headers（第三个参数）', () =>
  /new\s+TypeCtor\(\s*url\s*,\s*protocols\s*,\s*\{[\s\S]{0,200}headers/.test(gw)
    ? true
    : '没有给 WebSocket 传 headers —— 网关会 400',
);

check('headers 里有 X-DSH-Device-ID', () =>
  /'X-DSH-Device-ID'\s*:\s*this\.deviceId/.test(gw)
    ? true
    : '缺少 X-DSH-Device-ID header',
);

check('不再把 deviceId 塞进查询串', () => {
  // 允许注释里提到，但不能有实际的 `?deviceId=` 拼接
  const code = gw
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  return /\?deviceId=/.test(code) ? '还在用查询串传 deviceId（服务端不认）' : true;
});

check('注释说明了 header 是硬性要求', () =>
  gw.includes('X-DSH-Device-ID') && /400|硬性要求|rejectUpgrade/.test(gw)
    ? true
    : '缺少踩坑说明',
);

// ── 2. 端点选择：优先同源，不硬编码 ───────────────────────────────
check('有 pickUrl 逻辑', () =>
  /pickUrl\s*\(/.test(gw) ? true : '没有端点选择逻辑',
);

check('pickUrl 优先同 host + 同 port', () => {
  const i = gw.indexOf('private pickUrl');
  if (i < 0) return '找不到 pickUrl';
  const body = gw.slice(i, i + 1600);
  return /wantHost/.test(body) && /wantPort/.test(body)
    ? true
    : '没有按 host+port 匹配同源端点';
});

check('保存了 endpoints / publicUrl', () =>
  /this\.endpoints\s*=/.test(gw) && /this\.publicUrl\s*=/.test(gw)
    ? true
    : '没保存 /mgw/pair 返回的地址列表',
);

check('注释提醒 3081 会被防火墙拦', () =>
  /3081/.test(gw) && /防火墙/.test(gw) ? true : '缺少端口踩坑说明',
);

// ── 3. 401 自愈：清 token 重新配对 ───────────────────────────────
check('onclose 里识别 401', () => {
  const i = gw.indexOf('ws.onclose');
  if (i < 0) return '找不到 onclose';
  const body = gw.slice(i, i + 1800);
  return /401|unauthorized/i.test(body) ? true : 'onclose 没处理 401';
});

check('401 时清掉内存 token', () =>
  /this\.token\s*=\s*''/.test(gw) ? true : '没有清内存 token',
);

check('401 时清掉持久化 token（Keystore）', () =>
  /clearCredential\(CredentialKey\.gatewayToken\)/.test(gw)
    ? true
    : '没有清 Keystore 里的 token',
);

check('401 后不再复用旧配对码', () => {
  // 重构后判据从「失败次数」换成了 isCredentialRejection（明确的鉴权拒绝），
  // 语义没变：认定凭据失效时都必须 scheduleRetry() 且不带旧配对码。
  const i = gw.indexOf('isCredentialRejection(combined)');
  if (i < 0) return '找不到「明确鉴权拒绝」的分支';
  const body = gw.slice(i, i + 700);
  if (/scheduleRetry\(\s*pairingCode\s*\)/.test(body)) {
    return '还在拿旧配对码重试（一次性码，必然 401）';
  }
  return /scheduleRetry\(\s*\)/.test(body) ? true : '没有安排重试';
});

// ── 4. 网关生命周期上移到 App 级 ─────────────────────────────────
check('App 级调用 connectApprovals', () =>
  /GlobalNotices[\s\S]{0,3000}connectApprovals/.test(app)
    ? true
    : '网关不在 App 级连接',
);

check('ChatScreen 不再自己 connect/disconnect', () => {
  const code = chat
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  return /store\.connectApprovals\(/.test(code) || /store\.disconnectApprovals\(/.test(code)
    ? 'ChatScreen 还在管网关生命周期（会和 App 级冲突）'
    : true;
});

// ── 5. 状态可见 ──────────────────────────────────────────────────
check('store 暴露 gatewayStatus', () =>
  /gatewayStatus/.test(store) ? true : '没有网关状态',
);

check('「我的」页显示审批通道状态', () => {
  const profile = readFileSync('src/screens/ProfileScreen.tsx', 'utf8');
  return /审批通道/.test(profile) ? true : '界面看不到网关状态，没法排查';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
