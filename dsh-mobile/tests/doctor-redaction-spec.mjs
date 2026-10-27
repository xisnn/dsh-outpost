/**
 * 诊断脚本脱敏回归测试。
 *
 * ## 为什么需要它
 *
 * `doctor.ps1` 的定位是「哪里不对直接告诉你怎么办」，用户会把它整段贴进
 * issue、聊天窗口、群里求助。而它原来会原样打印 `pairing.json` / `tunnel.json`
 * 里的 `url` —— 那些 url 带 `?token=<43 字符>`，等于把**这台电脑 DSH 的钥匙**
 * 直接交给对话对方。
 *
 * 这不是理论风险：一个「帮忙看看为什么连不上」的求助帖就够了。
 *
 * ## 测什么
 *
 * 1. 静态：`Redact-Url` 存在，且三处输出都过它
 * 2. 行为：用真实脚本跑一遍，输出里不得出现任何 43+ 位的 token
 *
 * 第 2 步是真的执行 PowerShell —— 因为正则改对了但漏改某一行输出，
 * 静态检查是看不出来的。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

// 这个 spec 从 dsh-mobile/ 里跑（npm test 的 cwd），但被测对象在仓库根。
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const doctorPath = path.join(repoRoot, 'doctor.ps1');
const src = readFileSync(doctorPath, 'utf8');

// ── 第一步：静态结构 ────────────────────────────────────────────

if (/function\s+Redact-Url/.test(src)) {
  ok('存在 Redact-Url 脱敏函数');
} else {
  bad('找不到 Redact-Url 函数');
}

// 三处输出点都必须过脱敏
const redactCallSites = (src.match(/Redact-Url/g) || []).length;
if (redactCallSites >= 4) {
  // 1 处定义 + 3 处调用
  ok(`脱敏函数被 3 处输出点调用（共 ${redactCallSites} 次出现）`);
} else {
  bad(`Redact-Url 只出现 ${redactCallSites} 次，期望 >= 4（定义 + 3 调用）`);
}

// 不能存在「裸打印 j.url / $j.url」的残留
const rawUrlPrints = (src.match(/\$\{?\(\$?j\.url\)?\}?/g) || []).length;
// 允许出现在 Redact-Url 之后的形式；直接扫「$($j.url)」这种
const barePrint = /\$\(\$j\.url\)(?!\s*\))/.test(src.replace(/\$\(Redact-Url \$j\.url\)/g, ''));
if (!barePrint) {
  ok('没有裸打印 $($j.url) 的残留');
} else {
  bad('仍有裸打印 $($j.url) 的代码路径');
}

// 规则本身要覆盖 token / key / secret / 长 base64url
for (const [label, re] of [
  ['token|key|secret|password 查询参数', /token\|key\|secret\|password/],
  ['43+ 位 base64url 兜底', /\{43,\}/],
]) {
  if (re.test(src)) ok('脱敏规则覆盖' + label);
  else bad('脱敏规则缺少' + label);
}

// ── 第二步：行为验证（真跑脚本）────────────────────────────────

let output = '';
try {
  output = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', doctorPath],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120000 },
  );
} catch (e) {
  // doctor.ps1 用 exit code 表示自检结论，非 0 也可能有正常输出
  output = String(e.stdout || '') + String(e.stderr || '');
}

if (output.length > 0) {
  ok('doctor.ps1 能执行并产生输出');
} else {
  bad('doctor.ps1 没有产生任何输出');
}

// 核心断言：不能出现任何 43+ 位的 base64url 串（token 的形态）
const longTokens = output.match(/\b[A-Za-z0-9_-]{43,}\b/g) || [];
if (longTokens.length === 0) {
  ok('输出中没有任何 43+ 位 token 形态字符串');
} else {
  bad(`输出中发现 ${longTokens.length} 个疑似令牌（长度 ${longTokens[0].length}）`);
}

// token= 后面只能是 ***，不能是真实值
const tokenParams = output.match(/[?&]token=([^&\s"']*)/g) || [];
const leaked = tokenParams.filter((t) => !/^[?&]token=\*\*\*$/.test(t));
if (tokenParams.length > 0 && leaked.length === 0) {
  ok(`token 参数全部已打码（${tokenParams.length} 处）`);
} else if (tokenParams.length === 0) {
  ok('输出中没有 token 参数（无需打码）');
} else {
  bad(`${leaked.length} 处 token 参数未打码`);
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
