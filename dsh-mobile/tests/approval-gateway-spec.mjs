/**
 * 审批网关的协议约定测试。
 *
 * 这里不连真网关（那要起 DSH + 插件，不适合放进单测），
 * 而是把协议里最容易写错的几处钉死：
 *   - 帧格式（approval-requested / approval-response / approval-resolved）
 *   - outcome 只能两个值（cancelled/unavailable 是宿主态，客户端不能发）
 *   - 去重（重连时服务端会重放，必须按 rpcId 去重）
 *   - 地址推导（baseUrl → ws://host:3081/ws/mobile）
 *
 * 协议来源：dsh-plugin-mobile-gateway 自带的 PROTOCOL.md。
 */

import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;

function ok(name) {
  pass += 1;
  console.log('  OK    ' + name);
}
function bad(name, detail) {
  fail += 1;
  console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''));
}
function check(name, fn) {
  try {
    const r = fn();
    if (r === true) ok(name);
    else bad(name, String(r));
  } catch (e) {
    bad(name, e && e.message ? e.message : String(e));
  }
}

const src = readFileSync('src/core/approvalGateway.ts', 'utf8');
const storeSrc = readFileSync('src/core/store.ts', 'utf8');
const bannerSrc = readFileSync('src/components/ApprovalBanner.tsx', 'utf8');

// ── 地址推导 ──────────────────────────────────────────────────────
check('网关端口是 3081', () => (src.includes('GATEWAY_PORT = 3081') ? true : '端口不对'));
check('地址格式 ws://host:3081/ws/mobile', () =>
  src.includes('/ws/mobile') ? true : '路径不对',
);
check('从 baseUrl 推出网关地址', () =>
  src.includes('gatewayUrlFrom') ? true : '缺少推导函数',
);

// ── 配对 ──────────────────────────────────────────────────────────
check('子协议 dsh-mobile-v1', () => (src.includes("'dsh-mobile-v1'") ? true : '缺少'));
check('配对子协议 dsh-pair.<code>', () =>
  src.includes('dsh-pair.${pairingCode}') ? true : '缺少配对子协议',
);
check('长期 token 子协议 dsh-token.<token>', () =>
  src.includes('dsh-token.${this.token}') ? true : '缺少 token 子协议',
);
check('设备 id 持久化', () => (src.includes('DEVICE_ID_KEY') ? true : '缺少设备 id'));
check('配对成功后存 token（Keystore）', () =>
  // 凭据已迁到 Keychain，不再是 AsyncStorage.setItem(DEVICE_TOKEN_KEY)
  /kind === 'paired'[\s\S]{0,400}saveCredential\(CredentialKey\.gatewayToken/.test(src)
    ? true
    : '没存 token',
);

// ── 帧处理 ────────────────────────────────────────────────────────
check('处理 approval-requested', () =>
  src.includes("'approval-requested'") ? true : '缺少',
);
check('处理 approval-resolved', () =>
  src.includes("'approval-resolved'") ? true : '缺少',
);
check('发 approval-response', () => (src.includes("'approval-response'") ? true : '缺少'));
check('response 带 rpcId/sessionId/approvalId/outcome', () => {
  const has = (k) => src.includes(`${k}: a.${k}`) || src.includes(`${k}:`);
  return has('rpcId') && has('sessionId') && has('approvalId') && has('outcome')
    ? true
    : '字段不全';
});

// ── outcome 取值 ──────────────────────────────────────────────────
check('outcome 类型只允许两个值', () => {
  const m = /export type ApprovalOutcome = ([^;]+);/.exec(src);
  if (!m) return '找不到类型定义';
  const s = m[1];
  return s.includes("'allowed-once'") && s.includes("'rejected'") ? true : '取值不对';
});
check('不发送 cancelled', () =>
  /outcome.*cancelled/.test(src) ? '出现了 cancelled' : true,
);
check('不发送 unavailable', () =>
  /outcome.*unavailable/.test(src) ? '出现了 unavailable' : true,
);

// ── store 侧 ──────────────────────────────────────────────────────
check('store 有待审批列表', () =>
  storeSrc.includes('pendingApprovals') ? true : '缺少',
);
check('按 rpcId 去重', () =>
  /pendingApprovals\.some\(\(p\) => p\.rpcId === a\.rpcId\)/.test(storeSrc)
    ? true
    : '没有去重',
);
check('已决时从列表移除', () =>
  /filter\(\(p\) => p\.rpcId !== rpcId\)/.test(storeSrc) ? true : '没有移除',
);
check('store 暴露连接状态', () =>
  storeSrc.includes('gatewayStatus') ? true : '缺少状态',
);
check('审批到达时震一下', () =>
  /onApproval[\s\S]{0,400}notifyDone/.test(storeSrc) ? true : '没有提醒',
);
check('断线重连有退避', () =>
  src.includes('scheduleRetry') && src.includes('Math.min(30_000') ? true : '没有退避',
);

// ── UI 侧 ─────────────────────────────────────────────────────────
check('横幅有允许/拒绝按钮', () =>
  bannerSrc.includes('允许一次') && bannerSrc.includes('拒绝') ? true : '缺少按钮',
);
check('网关离线时不给假按钮', () =>
  bannerSrc.includes('canAnswer') && bannerSrc.includes('gatewayOnline')
    ? true
    : '缺少可用性判断',
);
check('只读审批说明去哪处理', () =>
  bannerSrc.includes('无法在手机上回答') ? true : '缺少说明',
);

// ── 不影响现有传输层 ──────────────────────────────────────────────
check('没有改动 transport 层', () => {
  const t = readFileSync('src/core/transport/index.ts', 'utf8');
  return t.includes('DshConnection') ? true : 'transport 被破坏';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
