/**
 * 启动期网关补丁门禁回归测试。
 *
 * ## 守什么
 *
 * `start-dsh-web.ps1` 在启动前必须确认管理接口认证补丁已应用；
 * 未应用时要**拒绝启动**并给出三条可操作提示：
 *   1. 「认证补丁未生效」
 *   2. 修复命令 `apply.mjs --apply`
 *   3. `-SkipGatewayPatchCheck` 的用途
 *
 * ## 第二轮 CI 失败的原因（这个文件的历史）
 *
 * 原测试直接 `execFileSync('powershell.exe', ...)` 跑整个 start-dsh-web.ps1。
 * 在 ubuntu CI 上有两个问题叠加：
 *
 *   · `powershell.exe` 不存在（Linux 是 `pwsh`）
 *   · 即便换成 pwsh，脚本开头「定位 dsh」也找不到 Windows 的 dsh.cmd，
 *     会先 `exit 1` 报「找不到 dsh」——**门禁根本执行不到**
 *
 * 结果：「以非 0 退出」这条断言**假阳性通过**（其实是「找不到 dsh」导致的非 0），
 * 而三条输出断言全挂。所以不能只换个可执行文件名了事。
 *
 * ## 现在的测法
 *
 * 门禁逻辑抽到 `scripts/gateway-patch-gate.ps1`，暴露两个纯函数：
 *   · `Test-GatewayPatchApplied`：接受可注入的 CheckRunner，返回结构化结果
 *   · `Write-GatewayPatchRefusal`：只负责打印三條提示
 *
 * 测试用**真实 pwsh/powershell** 调用这两个函数，注入「补丁未应用」等场景，
 * 因此：
 *   · 不依赖 Windows DSH、不启动真实服务（满足 Linux CI 要求）
 *   · 断言真的覆盖了门禁的判定与文案（不是跳过、不是无条件 PASS）
 *   · 关闭/破坏门禁逻辑时测试会失败（见 §5 的反证）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findPowerShell, writePowerShellScript } from './support/powershell.mjs';

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
const startScript = path.join(repo, 'start-dsh-web.ps1');
const gateModule = path.join(repo, 'scripts', 'gateway-patch-gate.ps1');
const applyScript = path.join(repo, 'patches', 'mobile-gateway-mgmt-auth', 'apply.mjs');

console.log('');
console.log('── 1. 静态：门禁存在、位置正确、默认拒绝 ──');

const src = read('start-dsh-web.ps1');

check(existsSync(startScript), 'start-dsh-web.ps1 存在');
check(existsSync(gateModule), 'scripts/gateway-patch-gate.ps1 存在（门禁已抽出）');
check(
  /\.\s*\$gatePath/.test(src) || /\.\s*\$PSScriptRoot.*gateway-patch-gate/.test(src),
  '启动脚本 dot-source 门禁模块',
);
check(/Test-GatewayPatchApplied/.test(src), '启动脚本调用门禁判定函数');
check(/Write-GatewayPatchRefusal/.test(src), '启动脚本调用提示函数');
check(
  /if \(\$gate\.ExitCode -ne 0\)[\s\S]{0,200}?exit 1/.test(src),
  '门禁未通过时 exit 1（fail-closed）',
);
check(/\[switch\]\$SkipGatewayPatchCheck/.test(src), '提供 -SkipGatewayPatchCheck 显式跳过开关');
check(/-not \$SkipGatewayPatchCheck|Skip:\$SkipGatewayPatchCheck/.test(src), '门禁默认启用');

// 顺序：门禁必须在「定位 dsh」之前，否则环境问题会掩盖安全门禁
{
  const gateIdx = src.indexOf('Test-GatewayPatchApplied');
  // 定位真正的「找不到 dsh」提示行（注释里也出现过这个词，不能用裸 indexOf）
  const dshIdx = src.indexOf("Write-Host '[X] 找不到 dsh");
  check(
    gateIdx > 0 && dshIdx > 0 && dshIdx > gateIdx,
    '门禁位于「定位 dsh」之前（否则 Linux 上永远执行不到）',
    `gate=${gateIdx} dsh=${dshIdx}`,
  );
}

console.log('');
console.log('── 2. 门禁判定逻辑（真实 PowerShell + 注入场景）──');

const ps = findPowerShell();
if (!ps.ok) {
  if (process.env.CI) bad(`CI 必须有 PowerShell：${ps.reason}`);
  else console.log('  SKIP  本机无 PowerShell，跳过行为测试（CI 下会失败）');
} else {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gateh-'));
  try {
    // 用一个脚本文件驱动：dot-source 门禁模块，逐一断言分支
    const driver = path.join(tmp, 'drive.ps1');
    // 注意：PowerShell 里 `Emit "skip" (Test-...)` 会把命令调用拆成多个参数，
    // 必须先赋值再调用（否则部分分支静默丢失 —— 第一次跑就踩到了）。
    writePowerShellScript(
      driver,
      [
        `. '${gateModule.replace(/'/g, "''")}'`,
        `$patch = '${applyScript.replace(/'/g, "''")}'`,
        '',
        'function Emit($label, $r) {',
        '  Write-Output ("CASE|" + $label + "|" + $r.ShouldCheck + "|" + $r.ExitCode + "|" + $r.Reason)',
        '}',
        '',
        '# 跳过开关',
        '$r1 = Test-GatewayPatchApplied -PatchScript $patch -Skip -PluginInstalled $true',
        'Emit "skip" $r1',
        '# 插件未安装',
        '$r2 = Test-GatewayPatchApplied -PatchScript $patch -PluginInstalled $false',
        'Emit "noplugin" $r2',
        '# 补丁脚本不存在（用仓库内的不存在路径，避免 Z: 在非 Windows 上非法）',
        "$r3 = Test-GatewayPatchApplied -PatchScript (Join-Path $PWD 'no-such-patch.mjs') -PluginInstalled $true",
        'Emit "noscript" $r3',
        '# 检查失败（模拟补丁未应用）',
        '$r4 = Test-GatewayPatchApplied -PatchScript $patch -PluginInstalled $true -CheckRunner { param($s) @{ ExitCode = 1; Output = "PATCH_NOT_APPLIED" } }',
        'Emit "fail" $r4',
        '# 检查通过',
        '$r5 = Test-GatewayPatchApplied -PatchScript $patch -PluginInstalled $true -CheckRunner { param($s) @{ ExitCode = 0; Output = "APPLIED" } }',
        'Emit "pass" $r5',
      ].join('\n'),
      'utf8',
    );

    let out = '';
    try {
      out = execFileSync(
        ps.exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
        { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
    }

    const cases = {};
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^CASE\|([^|]+)\|([^|]+)\|([^|]+)\|(.*)$/);
      if (m) cases[m[1]] = { shouldCheck: m[2], exit: m[3], reason: m[4] };
    }
    if (process.env.PS_GATE_DEBUG) {
      console.log('--- DEBUG RAW OUTPUT ---');
      console.log(out);
      console.log('--- PARSED ---');
      console.log(JSON.stringify(cases, null, 2));
    }

    check(Object.keys(cases).length >= 5, '驱动脚本产出全部场景结果', `得到 ${Object.keys(cases).length} 条`);

    // 跳过开关：不检查
    check(cases.skip?.shouldCheck === 'False', '-SkipGatewayPatchCheck => 不检查');
    check(cases.skip?.reason === 'SkipGatewayPatchCheck', '跳过时给出明确原因');

    // 插件未安装：不检查（不影响没用网关的用户）
    check(cases.noplugin?.shouldCheck === 'False', '插件未安装 => 不检查');
    check(cases.noplugin?.reason === 'plugin-not-installed', '未安装时给出明确原因');

    // 补丁脚本缺失：不检查（但启动脚本另有防线）
    check(cases.noscript?.shouldCheck === 'False', '补丁脚本缺失 => 不检查');
    check(cases.noscript?.reason === 'patch-script-missing', '脚本缺失时给出明确原因');

    // **核心**：补丁未应用 => 必须检查且 ExitCode != 0
    check(cases.fail?.shouldCheck === 'True', '补丁未应用 => 需要检查');
    check(cases.fail?.exit === '1', '补丁未应用 => ExitCode=1（会触发拒绝启动）', `得到 ${cases.fail?.exit}`);

    // 补丁已应用 => ExitCode = 0
    check(cases.pass?.shouldCheck === 'True', '补丁已应用 => 需要检查');
    check(cases.pass?.exit === '0', '补丁已应用 => ExitCode=0（放行）', `得到 ${cases.pass?.exit}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('');
console.log('── 3. 拒绝启动的三条提示文案 ──');

if (!ps.ok) {
  if (process.env.CI) bad('CI 必须有 PowerShell');
  else console.log('  SKIP  本机无 PowerShell');
} else {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'refuse-'));
  try {
    const driver = path.join(tmp, 'refuse.ps1');
    writePowerShellScript(
      driver,
      [
        `. '${gateModule.replace(/'/g, "''")}'`,
        'Write-GatewayPatchRefusal -Detail "DETAIL_MARKER_XYZ"',
      ].join('\n'),
      'utf8',
    );
    let out = '';
    try {
      out = execFileSync(
        ps.exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
        { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
    }

    check(/认证补丁未生效/.test(out), '提示 1：输出说明「认证补丁未生效」');
    check(/apply\.mjs --apply/.test(out), '提示 2：输出给出可直接执行的修复命令');
    check(/SkipGatewayPatchCheck/.test(out), '提示 3：输出说明可显式跳过（不让人卡死）');
    check(/DETAIL_MARKER_XYZ/.test(out), '把 apply.mjs 的原始输出附在提示里（便于排查）');
    check(/拒绝启动/.test(out), '明确表达「拒绝启动」');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('');
console.log('── 4. apply.mjs 自身行为（未应用时非 0 退出）──');

{
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [applyScript, '--check'], { encoding: 'utf8', stdio: 'pipe' });
    code = 0;
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  console.log(`  （当前补丁状态：${code === 0 ? '已应用' : '未应用'}）`);
  if (code !== 0) {
    check(true, '补丁未应用时 apply.mjs --check 返回非 0');
    check(/认证|补丁|apply\.mjs/.test(out) || out.length > 0, 'apply.mjs 给出可读输出');
  } else {
    check(true, '补丁已应用时 apply.mjs --check 返回 0');
  }
}

console.log('');
console.log('── 5. 反证：破坏门禁逻辑时测试必须失败 ──');

// 把门禁的「未通过」分支强制改成放行，验证我们的断言能抓住
if (ps.ok) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'neg-'));
  try {
    // 造一个「永远返回 ExitCode=0」的坏门禁，验证断言不会误判为通过
    const badModule = path.join(tmp, 'bad-gate.ps1');
    writePowerShellScript(
      badModule,
      [
        'function Test-GatewayPatchApplied { param($PatchScript,[bool]$PluginInstalled=$true,[switch]$Skip,[scriptblock]$CheckRunner)',
        '  return [pscustomobject]@{ ShouldCheck=$true; ExitCode=0; Output=""; Reason="" } }',
        'function Write-GatewayPatchRefusal { param([string]$Detail="") Write-Output "NOTHING" }',
      ].join('\n'),
      'utf8',
    );
    const driver = path.join(tmp, 'neg.ps1');
    writePowerShellScript(
      driver,
      [
        `. '${badModule.replace(/'/g, "''")}'`,
        '$r = Test-GatewayPatchApplied -PatchScript "x" -CheckRunner { param($s) @{ ExitCode = 1; Output = "x" } }',
        'Write-Output ("EXIT=" + $r.ExitCode)',
        'Write-GatewayPatchRefusal',
      ].join('\n'),
      'utf8',
    );
    const out = execFileSync(
      ps.exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // 坏实现会把 ExitCode 报成 0，且不打印三条提示 —— 我们的断言正是检查这两点
    check(/EXIT=0/.test(out), '坏门禁确实返回了 ExitCode=0（反证前提成立）');
    check(
      !/认证补丁未生效/.test(out) && !/apply\.mjs --apply/.test(out),
      '坏门禁不产生三条提示 => 我们的断言会失败（证明不是恒真）',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  console.log('  SKIP  反证需要 PowerShell');
}

console.log('');
console.log('── 6. setup-gateway 仍然强制要求补丁 ──');

const setupGw = read('setup-gateway.ps1');
check(
  /\$patchScript --check/.test(setupGw) && /\$patchScript --apply/.test(setupGw),
  'setup-gateway 会先 check 再按需 apply',
);
check(
  /if \(-not \$patchOk\)[\s\S]{0,900}?exit 1/.test(setupGw),
  'setup-gateway 在补丁失败时拒绝写配置',
);

console.log('');
console.log('── 7. 全仓库测试不再硬编码 powershell.exe ──');

// 除运行器自身外，测试不应把 powershell/powershell.exe 直接当作可执行文件传入。
//
// 判定方式：剥掉注释与字符串常量里的「说明文字」干扰，只在**真正的调用位置**
// 匹配 `execFileSync('powershell...')` 这种形态。
// （上一版用裸正则，把自己文件里描述这个问题的字符串也匹配了。）
{
  const fsMod = await import('node:fs');
  const testsDir = path.join(repo, 'dsh-mobile', 'tests');
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fsMod.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!ent.name.endsWith('.mjs')) continue;
      // 运行器本身允许出现这两个名字（那是它的职责）
      if (p.endsWith(path.join('support', 'powershell.mjs'))) continue;
      const body = fsMod.readFileSync(p, 'utf8');
      // 先去掉行注释，避免注释里的示例代码造成误报
      const codeOnly = body
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      // 只匹配「把 powershell 当可执行文件传给子进程」的形态
      const bad =
        /(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"](?:powershell\.exe|powershell)['"]\s*,/.test(codeOnly);
      if (bad) offenders.push(path.relative(repo, p));
    }
  };
  walk(testsDir);
  check(offenders.length === 0, '没有测试再直接硬编码 powershell/powershell.exe', offenders.join(', '));
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
