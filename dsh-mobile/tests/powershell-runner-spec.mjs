/**
 * 跨平台 PowerShell 运行器测试。
 *
 * ## 背景：这是一个真实的 CI 阻断
 *
 * 首次 `Signing Verification (no publish)` 在 `Unit tests` 失败，3 项报
 * 「语法解析失败」。根因有两层：
 *
 *   1. `security-remediation-spec.mjs` 硬编码 `execFileSync('powershell', ...)`。
 *      GitHub Actions 跑在 ubuntu-latest 上，Linux 的 PowerShell 叫 `pwsh`，
 *      **没有 `powershell`** → 直接 ENOENT。
 *   2. 外层用了无差别 `catch { bad('语法解析失败') }`，把「可执行文件不存在」
 *      伪装成「脚本有语法错误」—— 排查方向被带偏。
 *
 * 更严重的是同一文件里还有个 `catch { check(true, ...) }`：**无条件 PASS**。
 * 那意味着 doctor.ps1 的两个脱敏断言在 CI 上从来没真正跑过。
 *
 * ## 本测试守什么
 *
 * 1. 运行器能按平台挑到可执行文件（Linux 用 pwsh，Windows 用 powershell.exe）
 * 2. 三态区分正确：missing / parse / error 不混淆
 * 3. 真的能解析合法 .ps1（不跳过、不伪造）
 * 4. 故意写坏的 .ps1 必须被判为 parse 失败（证明检查有效）
 * 5. 源码里不允许再出现「catch 后无条件 PASS」
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findPowerShell,
  parsePowerShellFile,
  runPowerShellFile,
} from './support/powershell.mjs';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass += 1;
  console.log('  OK    ' + n);
};
const bad = (n, d) => {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
};
const check = (c, n, d) => (c ? ok(n) : bad(n, d));

const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

console.log('');
console.log('── 1. 可执行文件选择（跨平台）──');

const ps = findPowerShell();
check(ps.ok === true, `找到可用 PowerShell：${ps.ok ? ps.exe : ps.reason}`);

if (ps.ok) {
  // 平台与可执行文件的对应关系
  if (process.platform === 'win32') {
    check(
      /^(powershell|powershell\.exe|pwsh|pwsh\.exe)$/i.test(ps.exe),
      `Windows 上选到 ${ps.exe}（可用）`,
    );
  } else {
    check(ps.exe === 'pwsh', `非 Windows 平台必须用 pwsh（实际 ${ps.exe}）`);
  }

  // 报告版本，便于排查 CI 环境差异
  try {
    const v = execFileSync(ps.exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
    ok(`PowerShell 主版本可读：${v}`);
  } catch (e) {
    bad('无法读取 PowerShell 版本', e.message);
  }
}

console.log('');
console.log('── 2. 合法 .ps1 必须真的被解析（不得跳过）──');

for (const f of ['start-tunnel.ps1', 'doctor.ps1', 'setup-gateway.ps1']) {
  const r = parsePowerShellFile(path.join(repo, f));
  if (r.status === 'ok') {
    ok(`${f} 解析通过`);
  } else if (r.status === 'missing') {
    // 环境问题：CI 必须有，本地明确标 SKIP
    if (process.env.CI) bad(`${f} 无法验证（CI 缺 PowerShell）：${r.detail}`);
    else console.log(`  SKIP  ${f}（本机无 PowerShell）`);
  } else {
    bad(`${f} 解析${r.status === 'parse' ? '失败' : '异常'}`, r.detail);
  }
}

console.log('');
console.log('── 3. 故意损坏的 .ps1 必须被判为 parse 失败（证明检查有效）──');

if (ps.ok) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'psbad-'));
  try {
    // 未闭合的字符串 —— PowerShell 会报 parse error
    const broken = path.join(tmp, 'broken.ps1');
    writeFileSync(broken, 'Write-Host "unterminated\n', 'utf8');
    const r = parsePowerShellFile(broken);
    check(r.status === 'parse', '损坏脚本被判为 parse 失败（不是 ok/missing）', `得到 ${r.status}`);
    check(typeof r.detail === 'string' && r.detail.length > 0, '失败时带可读的错误详情');

    // 对照：同一个临时目录里的正常脚本必须通过
    const good = path.join(tmp, 'good.ps1');
    writeFileSync(good, 'Write-Host "ok"\n', 'utf8');
    check(parsePowerShellFile(good).status === 'ok', '正常脚本仍然判为 ok（对照）');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.log('  SKIP  无 PowerShell，跳过损坏脚本用例');
}

console.log('');
console.log('── 4. ENOENT 必须归类为 missing，不能冒充 parse ──');

{
  // 直接验证我们的分类假设：spawn 不存在的可执行文件，错误码是 ENOENT
  let code;
  try {
    execFileSync('powershell-definitely-not-a-real-binary-xyz', ['-Command', '1'], {
      stdio: 'pipe',
    });
    code = 'NO_ERROR';
  } catch (e) {
    code = e.code;
  }
  check(code === 'ENOENT', 'spawn 缺失可执行文件时错误码为 ENOENT', `得到 ${code}`);
}

console.log('');
console.log('── 5. 源码里不允许「catch 后无条件 PASS」──');

const secSpec = read('dsh-mobile/tests/security-remediation-spec.mjs');
const docSpec = read('dsh-mobile/tests/doctor-redaction-spec.mjs');

// 只看**可执行代码**：剥掉注释行，避免把「说明以前是 check(true)」的注释误判
const stripComments = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

const secCode = stripComments(secSpec);
const docCode = stripComments(docSpec);

check(
  !/catch\s*(\([^)]*\))?\s*\{\s*check\(true/.test(secCode),
  'security spec 没有 catch 后无条件 check(true)',
);
check(
  !/execFileSync\(\s*'powershell'/.test(secSpec),
  'security spec 不再硬编码 powershell（改用跨平台运行器）',
);
check(
  !/execFileSync\(\s*'powershell'/.test(docSpec),
  'doctor spec 不再硬编码 powershell',
);
check(
  /parsePowerShellFile/.test(secSpec),
  'security spec 使用跨平台解析函数',
);
check(
  /runPowerShellFile/.test(docSpec),
  'doctor spec 使用跨平台执行函数',
);

console.log('');
console.log('── 6. 行为：doctor.ps1 真跑并检查脱敏 ──');

{
  const r = runPowerShellFile(path.join(repo, 'doctor.ps1'), { cwd: repo });
  if (r.status === 'missing') {
    if (process.env.CI) bad('doctor.ps1 无法执行（CI 缺 PowerShell）');
    else console.log('  SKIP  doctor.ps1 执行（本机无 PowerShell）');
  } else if (r.status === 'error') {
    bad('doctor.ps1 执行异常', r.detail);
  } else {
    ok(`doctor.ps1 执行并产生输出（${r.output.length} 字节）`);
    // 非零退出码是 doctor 的自检结论，属正常；只要有输出就能做脱敏断言
    const longTokens = r.output.match(/\b[A-Za-z0-9_-]{43,}\b/g) || [];
    check(longTokens.length === 0, '输出不含 43+ 位 token 形态字符串');
    // 不打印任何疑似令牌内容，只报数量
    const tokenParams = r.output.match(/[?&](?:token|key|secret)=([^&\s"']*)/g) || [];
    const leaked = tokenParams.filter((t) => !/\*{3}/.test(t));
    check(leaked.length === 0, `查询参数中的凭据已打码（检查了 ${tokenParams.length} 处）`);
  }
}

console.log('');
console.log('── 7. CI workflow 显式校验 pwsh ──');

const wf = read('.github/workflows/signing-verify.yml');
check(/command -v pwsh/.test(wf), 'workflow 显式检查 pwsh 存在');
check(
  /找不到 pwsh/.test(wf),
  'pwsh 缺失时给出明确错误信息（不是含糊的「语法解析失败」）',
);
// 该检查必须在 Unit tests 之前，否则测试先挂了才提示就晚了
{
  const pwshIdx = wf.indexOf('Verify PowerShell availability');
  const unitIdx = wf.indexOf('name: Unit tests');
  check(pwshIdx > 0 && unitIdx > pwshIdx, 'pwsh 检查位于 Unit tests 之前');
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
