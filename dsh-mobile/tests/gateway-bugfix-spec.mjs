/**
 * 两个真实 bug 的回归测试。
 *
 * ## Bug 1：base64 分块拼接导致图片截断
 *
 * 网关按 512 KiB 分块返回 base64。每块都是**独立编码**的，末尾可能带
 * `=` padding：
 *   块1: QUFBQUFBQUE=
 *   块2: QkJCQkJCQkI=
 * 如果把各块 base64 直接 join('') 再整体解码，解码器遇到中间的 `=`
 * 就认为数据结束 —— 只解出第一块。
 *
 * 实测症状：2.5 MB 的图，5 块拉完后文件只有 524288 字节（正好第一块），
 * PNG 头正常但整体截断，<Image> 解码失败 → 界面一个灰方块。
 *
 * 正确做法：逐块 appendFile，每块单独解码。
 *
 * ## Bug 2：审批网关从未连上
 *
 * connect() 只在「有 pairingCode」或「有已保存 token」时才建连，
 * 而首次两者都没有 —— 直接 return 了。用户看到
 * 「这条请求来自会话记录，无法在手机上回答」。
 *
 * 修法：没配对码时先 POST /mgw/pair 申请一个。
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

const files = readFileSync('src/core/gatewayFiles.ts', 'utf8');
const gw = readFileSync('src/core/approvalGateway.ts', 'utf8');

// ── 先证明 bug 真实存在 ────────────────────────────────────────────
// 这几个断言跑的是真实 JS 语义，不是看源码字符串。
check('base64 直接拼接会丢数据（bug 机理）', () => {
  const a = Buffer.from('AAAAAAAA').toString('base64'); // 8 字符 + '='
  const b = Buffer.from('BBBBBBBB').toString('base64');
  const joined = Buffer.from(a + b, 'base64');
  // 正确应是 16 字节；直接拼只得到 8
  return joined.length === 8 ? true : `预期只解出 8 字节，实际 ${joined.length}`;
});

check('逐块解码再拼是正确做法', () => {
  const a = Buffer.from('AAAAAAAA').toString('base64');
  const b = Buffer.from('BBBBBBBB').toString('base64');
  const merged = Buffer.concat([Buffer.from(a, 'base64'), Buffer.from(b, 'base64')]);
  return merged.length === 16 ? true : `预期 16 字节，实际 ${merged.length}`;
});

check('5 块模拟：拼接 vs 逐块', () => {
  // 模拟真实情况：4 块 524288 + 1 块 408903
  const sizes = [524288, 524288, 524288, 524288, 408903];
  const chunks = sizes.map((n) => Buffer.alloc(n, 0xab).toString('base64'));
  const total = sizes.reduce((a, b) => a + b, 0);

  const bad = Buffer.from(chunks.join(''), 'base64').length;
  const good = chunks.reduce((n, c) => n + Buffer.from(c, 'base64').length, 0);

  // 必须是「直接拼会少」而「逐块拼正确」
  if (!(bad < total)) return `拼接居然没丢数据（${bad} vs ${total}）—— 测试前提失效`;
  if (good !== total) return `逐块拼接得 ${good}，应为 ${total}`;
  return true;
});

// ── 源码层面：确认修法落地 ──────────────────────────────────────
check('不再用 parts.join 拼 base64', () => {
  // 允许出现在注释里，但不允许出现在代码里
  const code = files.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return /parts\.join\(/.test(code) ? '代码里还有 parts.join(' : true;
});

check('用 appendFile 逐块写', () =>
  files.includes('appendFile') ? true : '没有逐块追加',
);

check('首块用 writeFile', () =>
  /writeFile\(dest, parts\[0\], 'base64'\)/.test(files) ? true : '首块写法不对',
);

check('注释解释了 padding 机理', () =>
  files.includes('padding') && files.includes('=`') ? true : '缺少机理说明',
);

// ── Bug 2：自动配对 ────────────────────────────────────────────
check('有 requestPairingCode 方法', () =>
  gw.includes('requestPairingCode') ? true : '没有自动配对',
);

check('调 POST /mgw/pair', () =>
  /\/mgw\/pair/.test(gw) ? true : '没有调配对接口',
);

check('请求带 cookie', () =>
  /\/mgw\/pair[\s\S]{0,400}credentials: 'include'/.test(gw) ? true : '没带 cookie',
);

check('无 token 时先申请配对码', () =>
  /!pairingCode && !this\.token[\s\S]{0,400}requestPairingCode/.test(gw)
    ? true
    : '缺少自动配对分支',
);

check('申请失败给出可读原因', () =>
  gw.includes('网关未开启') ? true : '失败提示不清楚',
);

// ── 不能破坏「有 token 就复用」 ────────────────────────────────
check('仍支持 dsh-token 子协议', () =>
  gw.includes('dsh-token.${this.token}') ? true : 'token 重连被破坏',
);

check('仍支持 dsh-pair 子协议', () =>
  gw.includes('dsh-pair.${pairingCode}') ? true : '配对协议被破坏',
);

check('配对成功仍会存 token（Keystore）', () =>
  // 凭据迁到 Keychain 后，判定改成看 saveCredential
  /kind === 'paired'[\s\S]{0,400}saveCredential\(CredentialKey\.gatewayToken/.test(gw)
    ? true
    : '没存 token',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
