/**
 * 公网隧道门禁的**行为**测试（SEC-01 复核修正 · P2.1）
 *
 * ## 为什么需要这个文件（已有的 gateway-startup-gate-spec 不够）
 *
 * 已有那份 spec 的 §8 是**源码字符串匹配**：它断言 `start-tunnel.ps1` 里出现了
 * 某些字面量。第二方复核指出的缺口恰好是字符串匹配看不见的：
 *
 *   `start-tunnel.ps1` 只写了 `if ($gate.ShouldCheck) { ... }`，
 *   而 `Test-GatewayPatchApplied` 有**四条**返回路径，其中三条 `ShouldCheck = $false`
 *   （skip / plugin-not-installed / patch-script-missing）。
 *   源码里"门禁调用"确实存在、字面量全对 —— 但那三条路径**静默放行**。
 *
 * 所以本文件**执行真实代码**，不做字符串匹配：
 *
 *   · 真实 dot-source `scripts/gateway-patch-gate.ps1`
 *   · 真实调用 `Test-GatewayPatchApplied`
 *   · 真实调用 `patches/mobile-gateway-mgmt-auth/apply.mjs`（复制进 fixture，
 *     连 `patch.mjs` 一起，所以 --check 的判定逻辑是真的）
 *   · 真实执行从 `start-tunnel.ps1` 里**原样提取**的门禁代码块
 *
 * ## 为什么是"提取代码块"而不是"跑整个 start-tunnel.ps1"
 *
 * 因为跑整个脚本**不安全**，已实测确认：
 *
 *   1. `-Stop` 分支（`start-tunnel.ps1:151`）会
 *      `Get-Process -Name cloudflared | Stop-Process -Force` ——
 *      **杀掉全机所有 cloudflared 进程**，包括用户正在用的隧道。
 *   2. 门禁之后第一个动作是 `Get-DshPath`（`:120-130`），它的候选里有硬编码的
 *      `E:\DSH\resources\runtime\cli\bin\dsh.cmd`，而**这个文件在本机真实存在**。
 *      于是 `if (-not $dshExe) { exit 1 }`（`:315`）不会触发，
 *      脚本会继续走到 `schtasks /Create` + `/Run`（`:333-335`）
 *      **真的建计划任务并启动真实 DSH**。
 *
 * 因此：门禁代码块被原样提取出来、在 fixture 环境里执行。它跑的是**真实的生产
 * 代码文本**（不是重新实现），但物理上不可能到达 schtasks / cloudflared。
 * `-Status` 是只读的，可以真实整脚本执行；`-Stop` 只做顺序断言，**永不执行**。
 *
 * ## 提取锚点
 *
 * 起止锚点都在 `start-tunnel.ps1` 里唯一出现（已核实），且锚点本身若被改名，
 * 本文件会**响亮失败**而不是静默测到一段空代码。
 */

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPowerShell, writePowerShellScript } from './support/powershell.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (n) => {
  pass += 1;
  console.log('  OK    ' + n);
};
const bad = (n, d) => {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
};
const check = (c, n, d) => (c ? ok(n) : bad(n, d));
const skipped = (n, d) => {
  skip += 1;
  console.log('  SKIP  ' + n + (d ? ' — ' + d : ''));
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const tunnelScript = path.join(repo, 'start-tunnel.ps1');
const lanScript = path.join(repo, 'start-dsh-web.ps1');
const gateModule = path.join(repo, 'scripts', 'gateway-patch-gate.ps1');
const patchDir = path.join(repo, 'patches', 'mobile-gateway-mgmt-auth');

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

console.log('');
console.log('── 1. 前置：被测对象真实存在 ──');

check(existsSync(tunnelScript), 'start-tunnel.ps1 存在');
check(existsSync(gateModule), 'scripts/gateway-patch-gate.ps1 存在');
check(existsSync(path.join(patchDir, 'apply.mjs')), 'patches/.../apply.mjs 存在');
check(existsSync(path.join(patchDir, 'patch.mjs')), 'patches/.../patch.mjs 存在（apply.mjs 依赖它）');

const ps = findPowerShell();
if (!ps.ok) {
  // 这个 spec 的全部价值在于真实执行 PowerShell。没有 PowerShell 就什么都测不到，
  // 因此在 CI 里必须失败，本地才允许跳过（且明确标注）。
  if (process.env.CI) {
    bad('CI 必须有 PowerShell 才能跑门禁行为测试', ps.reason);
  } else {
    skipped('本机无 PowerShell，全部行为断言跳过', ps.reason);
  }
  console.log('');
  console.log(`结果：${pass} 通过，${fail} 失败，${skip} 跳过`);
  process.exitCode = fail === 0 ? 0 : 1;
  process.exit(fail === 0 ? 0 : 1);
}
ok(`PowerShell 可用（${ps.exe}）`);

// ── 2. 从真实 start-tunnel.ps1 里提取门禁代码块 ─────────────────────

const BEGIN_ANCHOR = "$gatePath = Join-Path $RepoRoot 'scripts\\gateway-patch-gate.ps1'";
const END_ANCHOR = '# 先停掉旧的，避免端口/域名冲突';

function extractGateFragment() {
  const lines = readFileSync(tunnelScript, 'utf8').split(/\r?\n/);
  const begins = lines.map((l, i) => (l.includes(BEGIN_ANCHOR) ? i : -1)).filter((i) => i >= 0);
  const ends = lines.map((l, i) => (l.includes(END_ANCHOR) ? i : -1)).filter((i) => i >= 0);
  if (begins.length !== 1 || ends.length !== 1 || ends[0] <= begins[0]) {
    return { error: `锚点定位失败：begin=${JSON.stringify(begins)} end=${JSON.stringify(ends)}` };
  }
  const body = lines.slice(begins[0], ends[0]);
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  return { text: body.join('\n'), startLine: begins[0] + 1, endLine: ends[0] };
}

const frag = extractGateFragment();

console.log('');
console.log('── 2. 提取真实门禁代码块（不重新实现） ──');

check(!frag.error, '门禁代码块提取成功', frag.error);
if (frag.error) {
  console.log('');
  console.log(`结果：${pass} 通过，${fail} 失败，${skip} 跳过`);
  process.exit(1);
}
// 反空断言：提取出来的必须真的是那段门禁，不能是空串或注释
check(frag.text.length > 200, '提取到的代码块不是空的', `长度 ${frag.text.length}`);
check(
  /Test-GatewayPatchApplied/.test(frag.text),
  '代码块里确实调用了 Test-GatewayPatchApplied（提取没有跑偏）',
);
check(
  !/schtasks/.test(frag.text) && !/Start-Process/.test(frag.text) && !/cloudflared/i.test(frag.text),
  '代码块里**不含**任何危险动作（schtasks / Start-Process / cloudflared）',
);
console.log(`       （提取自 start-tunnel.ps1:${frag.startLine}-${frag.endLine}）`);

// ── 3. fixture：真实 apply.mjs + 可控的插件状态 ─────────────────────

const MARKER = 'DSH_OUTPOST_MGW_AUTH_PATCH';

function makeFixture(opts) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gw-public-'));
  // scripts/gateway-patch-gate.ps1 → 转发到**真实**模块，保证测的是生产代码
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  writePowerShellScript(
    path.join(root, 'scripts', 'gateway-patch-gate.ps1'),
    `. ${q(gateModule)}`,
  );
  // patches/...：默认复制真实的 apply.mjs + patch.mjs
  if (opts.patchScript !== 'missing') {
    const d = path.join(root, 'patches', 'mobile-gateway-mgmt-auth');
    mkdirSync(d, { recursive: true });
    if (opts.applyStub) {
      // 桩：用来模拟"检查器自己异常退出"，真实 apply.mjs 做不到这件事
      writeFileSync(path.join(d, 'apply.mjs'), opts.applyStub);
      writeFileSync(path.join(d, 'patch.mjs'), 'export function patchManagementAuth() {}\n');
    } else {
      cpSync(path.join(patchDir, 'apply.mjs'), path.join(d, 'apply.mjs'));
      cpSync(path.join(patchDir, 'patch.mjs'), path.join(d, 'patch.mjs'));
    }
  }
  // 插件目录
  const dshHome = path.join(root, 'dsh-home');
  const gdir = path.join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-plugin-mobile-gateway');
  if (opts.plugin !== 'absent') {
    mkdirSync(path.join(gdir, 'lib'), { recursive: true });
    writeFileSync(
      path.join(gdir, 'package.json'),
      JSON.stringify({ name: 'dsh-plugin-mobile-gateway', version: '0.10.3' }),
    );
    if (opts.plugin !== 'incomplete') {
      writeFileSync(
        path.join(gdir, 'lib', 'index.mjs'),
        opts.patched
          ? `// ${MARKER}\nexport default function handler(req, res) { res.statusCode = 401; res.end(); }\n`
          : 'export default function handler(req, res) { res.statusCode = 200; res.end(); }\n',
      );
    }
  }
  return { root, dshHome, gdir };
}

function runFragment(fixture) {
  const harness = path.join(fixture.root, 'harness.ps1');
  writePowerShellScript(
    harness,
    [
      "$ErrorActionPreference = 'Stop'",
      `$RepoRoot = ${q(fixture.root)}`,
      'function Write-Step($msg)  { Write-Output ("STEP|" + $msg) }',
      'function Write-Ok($msg)    { Write-Output ("OK|" + $msg) }',
      'function Write-Warn2($msg) { Write-Output ("WARN|" + $msg) }',
      'function Write-Err($msg)   { Write-Output ("ERR|" + $msg) }',
      "Write-Output '---FRAGMENT-BEGIN---'",
      frag.text,
      "Write-Output 'GATE_PASSED'",
      "Write-Output '---FRAGMENT-END---'",
    ].join('\n'),
  );
  const env = Object.assign({}, process.env, {
    DSH_HOME: fixture.dshHome,
    // 双保险：即使提取逻辑哪天跑偏、真的往下走，也找不到 cloudflared
    DSH_CLOUDFLARED: path.join(fixture.root, 'no-such-cloudflared'),
  });
  let code = 0;
  let out = '';
  try {
    out = execFileSync(
      ps.exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
      { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], env },
    );
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : -1;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  return { code, out, passed: /GATE_PASSED/.test(out) };
}

// 拒绝必须是**门禁造成的**，不能是别的崩溃伪装成非零退出。
// 这个教训来自本项目：`.bin/tsx.cmd` 让子进程全返回 -1，而"非零退出"断言假通过。
function expectRefuse(label, res) {
  check(res.code !== 0, `${label} → 拒绝启动（非零退出）`, `实际 exit=${res.code}`);
  check(!res.passed, `${label} → 门禁之后的代码没有执行（无 GATE_PASSED）`);
  check(
    /拒绝启动/.test(res.out),
    `${label} → 退出原因确实是门禁拒绝（输出含「拒绝启动」）`,
    res.out.split('\n').slice(-6).join(' / ').slice(0, 300),
  );
}
function expectAllow(label, res) {
  check(res.code === 0, `${label} → 允许启动（exit 0）`, `实际 exit=${res.code}\n${res.out.slice(-500)}`);
  check(res.passed, `${label} → 门禁之后的代码被执行（GATE_PASSED）`);
  check(/网关认证补丁/.test(res.out), `${label} → 打印了补丁状态`, res.out.slice(-300));
}

function scenario(label, opts, expect) {
  const fx = makeFixture(opts);
  try {
    const res = runFragment(fx);
    if (expect === 'refuse') expectRefuse(label, res);
    else expectAllow(label, res);
    return res;
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

console.log('');
console.log('── 3. 门禁行为：真实执行提取出的生产代码块 ──');

// 这一对是自校验的：如果断言恒真（例如 harness 总是 exit 1），
// 那么 patched:true 的放行用例就会失败。
scenario('补丁已应用（真实 apply.mjs --check 退出 0）', { patched: true }, 'allow');
scenario('补丁未生效（index.mjs 无补丁标记）', { patched: false }, 'refuse');
scenario('插件文件不完整（有 package.json，缺 lib/index.mjs）', { plugin: 'incomplete' }, 'refuse');
// ↓↓ 这两条是复核指出的缺口：修前会静默放行 → 本 spec 修前必红 ↓↓
scenario('**补丁检查脚本缺失**（无法验证）', { patched: true, patchScript: 'missing' }, 'refuse');
scenario('**插件探测不到**（无法验证）', { plugin: 'absent' }, 'refuse');

// 检查器自己异常退出（真实 apply.mjs 做不到这件事，用桩）
scenario(
  '检查器以非零码异常退出（exit 7）',
  { patched: true, applyStub: "process.stderr.write('boom\\n');\nprocess.exit(7);\n" },
  'refuse',
);
scenario(
  '检查器抛出未捕获异常',
  { patched: true, applyStub: "throw new Error('CHECKER_CRASH');\n" },
  'refuse',
);
// 反向对照：只往 stderr 写东西、但退出 0，**不应该**被拒绝。
// 这一条守的是 gateway-patch-gate.ps1:102-114 记载的坑 —— 调用方是
// $ErrorActionPreference='Stop'，若 runner 没把 EAP 临时改回 Continue，
// stderr 会变成终止错误，把"通过"误判成"异常"。
scenario(
  '检查器写 stderr 但退出 0 → 仍应放行（不被 EAP=Stop 误伤）',
  { patched: true, applyStub: "process.stderr.write('warning only\\n');\nprocess.exit(0);\n" },
  'allow',
);

// 插件目录存在但探测路径指向别处：这是"探测假阴性"的真实形态。
// start-tunnel.ps1 用 $env:DSH_HOME ?? USERPROFILE 探测，
// 而 setup-gateway.ps1:35,58 硬编码 USERPROFILE、apply.mjs:57-67 用 os.homedir()，
// 三者来源不一致 → DSH_HOME 被设置时探测可能落空，而插件其实装着。
{
  const fx = makeFixture({ patched: true });
  try {
    // 把 DSH_HOME 指向一个空目录，模拟"探测落空但插件实际存在于别处"
    const wrongHome = path.join(fx.root, 'wrong-home');
    mkdirSync(wrongHome, { recursive: true });
    const harness = path.join(fx.root, 'harness2.ps1');
    writePowerShellScript(
      harness,
      [
        "$ErrorActionPreference = 'Stop'",
        `$RepoRoot = ${q(fx.root)}`,
        'function Write-Step($msg)  { Write-Output ("STEP|" + $msg) }',
        'function Write-Ok($msg)    { Write-Output ("OK|" + $msg) }',
        'function Write-Warn2($msg) { Write-Output ("WARN|" + $msg) }',
        'function Write-Err($msg)   { Write-Output ("ERR|" + $msg) }',
        frag.text,
        "Write-Output 'GATE_PASSED'",
      ].join('\n'),
    );
    let code = 0;
    let out = '';
    try {
      out = execFileSync(
        ps.exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
        {
          encoding: 'utf8',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: Object.assign({}, process.env, { DSH_HOME: wrongHome }),
        },
      );
    } catch (e) {
      code = typeof e.status === 'number' ? e.status : -1;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    expectRefuse('探测路径落空（插件其实在别处，属"无法确认"）', {
      code,
      out,
      passed: /GATE_PASSED/.test(out),
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

// ── 4. Test-GatewayPatchApplied 的四条返回分支（契约锁定） ──────────

console.log('');
console.log('── 4. 门禁模块四条返回分支的真实语义（契约锁定） ──');

/**
 * 真实调用 Test-GatewayPatchApplied，返回结构化结果。
 * 用注入的 CheckRunner 覆盖"检查器返回什么"，用 fixture 路径覆盖前三个分支。
 */
function callGate(opts) {
  const fx = makeFixture(opts.fixture || { patched: true });
  const driver = path.join(fx.root, 'gate.ps1');
  // 必须显式传 --path 指向 fixture 里的 index.mjs。
  // 不传的话 apply.mjs 会去查它自己的默认路径（os.homedir()/.dsh/...），
  // 也就是**本机真实装好的插件** —— 于是"补丁未应用"的 fixture 反而返回 0。
  // 这个坑是本 spec 第一次运行时被 §4 的断言抓出来的。
  //
  // 还必须临时把 $ErrorActionPreference 改回 Continue：apply.mjs 把 ✗ 结论
  // 写到 stderr，调用方脚本是 'Stop'，`2>&1` 会把它变成终止错误直接抛出，
  // 于是"补丁未应用"被误报成"检查器抛异常"。这正是门禁模块默认 runner
  // （gateway-patch-gate.ps1:102-114）注释里记载的同一个坑 —— 本 spec
  // 第一次运行时独立地又踩了一遍，可见那段注释不是多余的。
  const indexPath = path.join(fx.gdir, 'lib', 'index.mjs');
  const runner = opts.runner
    ? opts.runner
    : `{ param($s) $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { $global:LASTEXITCODE = $null; $o = (& node $s --check "--path=${indexPath}" 2>&1 | Out-String); $c = $global:LASTEXITCODE; if ($null -eq $c) { $c = 1 }; return @{ ExitCode = $c; Output = $o } } finally { $ErrorActionPreference = $prev } }`;
  writePowerShellScript(
    driver,
    [
      "$ErrorActionPreference = 'Stop'",
      `. ${q(gateModule)}`,
      `$patchScript = ${q(opts.patchScriptMissing ? path.join(fx.root, 'nope.mjs') : path.join(fx.root, 'patches', 'mobile-gateway-mgmt-auth', 'apply.mjs'))}`,
      `$pluginInstalled = ${opts.pluginInstalled ? '$true' : '$false'}`,
      `$skip = ${opts.skip ? '$true' : '$false'}`,
      '$caught = ""',
      '$gate = $null',
      'try {',
      `  $gate = Test-GatewayPatchApplied -PatchScript $patchScript -Skip:$skip -PluginInstalled:$pluginInstalled -CheckRunner ${runner}`,
      '} catch {',
      '  $caught = $_.Exception.Message',
      '}',
      'if ($caught) {',
      '  Write-Output ("THREW|" + $caught)',
      '} elseif ($null -eq $gate) {',
      "  Write-Output 'NULLGATE|'",
      '} else {',
      '  Write-Output ("GATE|" + $gate.ShouldCheck + "|" + $gate.ExitCode + "|" + $gate.Reason)',
      // 单独一行报告"检查器是否真的给了退出码"这个附加字段。
      // 分成 hasField 与 value 两段，才能区分「字段根本不存在」和「字段存在但为 false」——
      // 前者是修复前的状态，后者是修复后检查器没给码的状态。
      '  $hasProv = @($gate.PSObject.Properties.Name) -contains "ExitCodeProvided"',
      '  Write-Output ("PROVIDED|" + $hasProv + "|" + $gate.ExitCodeProvided)',
      '}',
    ].join('\n'),
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
  rmSync(fx.root, { recursive: true, force: true });
  const lines = out
    .split(/\r?\n/)
    .map((s) => s.trim());
  const gateLine = lines.find((s) => /^(GATE\||THREW\||NULLGATE\|)/.test(s));
  const provLine = lines.find((s) => /^PROVIDED\|/.test(s));
  return {
    gate: gateLine || 'NO_OUTPUT|' + out.slice(0, 200).replace(/\s+/g, ' '),
    // PROVIDED|<字段是否存在>|<字段值>
    hasField: /^PROVIDED\|True\|/.test(provLine || ''),
    providedValue: (provLine || '').split('|')[2] ?? '',
    providedLine: provLine || 'NO_PROVIDED_LINE',
    raw: out,
  };
}

// 分支 1：Skip
{
  const r = callGate({ skip: true, pluginInstalled: true });
  check(
    /^GATE\|False\|0\|SkipGatewayPatchCheck$/.test(r.gate),
    '分支1 $Skip → ShouldCheck=False / Reason=SkipGatewayPatchCheck',
    r.gate,
  );
  check(r.hasField, '分支1 也带 ExitCodeProvided 字段（对象形状统一）', r.providedLine);
}
// 分支 2：插件未安装
{
  const r = callGate({ pluginInstalled: false });
  check(
    /^GATE\|False\|0\|plugin-not-installed$/.test(r.gate),
    '分支2 插件未安装 → ShouldCheck=False / Reason=plugin-not-installed',
    r.gate,
  );
  check(r.hasField, '分支2 也带 ExitCodeProvided 字段（对象形状统一）', r.providedLine);
}
// 分支 3：补丁脚本缺失
{
  const r = callGate({ pluginInstalled: true, patchScriptMissing: true });
  check(
    /^GATE\|False\|0\|patch-script-missing$/.test(r.gate),
    '分支3 补丁脚本缺失 → ShouldCheck=False / Reason=patch-script-missing',
    r.gate,
  );
  check(r.hasField, '分支3 也带 ExitCodeProvided 字段（对象形状统一）', r.providedLine);
}
// 分支 4：真正执行检查
{
  const r = callGate({ pluginInstalled: true, fixture: { patched: true } });
  check(/^GATE\|True\|0\|$/.test(r.gate), '分支4 补丁已应用 → ShouldCheck=True / ExitCode=0', r.gate);
  check(
    r.hasField && r.providedValue === 'True',
    '分支4 补丁已应用 → ExitCodeProvided=True（检查器确实给了整数退出码）',
    r.providedLine,
  );
}
{
  const r = callGate({ pluginInstalled: true, fixture: { patched: false } });
  check(/^GATE\|True\|1\|$/.test(r.gate), '分支4 补丁未应用 → ShouldCheck=True / ExitCode=1', r.gate);
  check(
    r.hasField && r.providedValue === 'True',
    '分支4 补丁未应用 → ExitCodeProvided=True（非零码也是"给了码"）',
    r.providedLine,
  );
}
// 检查器抛异常
{
  const r = callGate({
    pluginInstalled: true,
    runner: "{ param($s) throw 'CHECKER_BOOM' }",
  });
  check(
    /^THREW\|/.test(r.gate) && /CHECKER_BOOM/.test(r.gate),
    '检查器抛异常 → 异常向上传播（不返回 gate）',
    r.gate,
  );
}

console.log('');
console.log('── 4b. 检查器没给退出码：[int]$null 折叠成 0 的信息必须在模块层保住 ──');

// 这是本轮（P2.2）要修的点。修复前：模块返回 ExitCode=0 且**没有**任何字段
// 能区分"检查器说通过"和"检查器什么都没说"，决策函数因此无从判断。
const NO_CODE_RUNNERS = [
  { label: '返回的哈希表缺 ExitCode 键', runner: "{ param($s) return @{ Output = 'no-exit-code' } }" },
  { label: '返回 ExitCode = $null', runner: "{ param($s) return @{ ExitCode = $null; Output = 'x' } }" },
  { label: '返回 ExitCode = 空字符串', runner: "{ param($s) return @{ ExitCode = ''; Output = 'x' } }" },
  { label: '返回一个字符串而不是哈希表', runner: "{ param($s) return 'just-a-string' }" },
  { label: '什么都不返回（$null）', runner: '{ param($s) }' },
  // 布尔能被 [int] 转换（$true→1、$false→0），所以**不抛异常**，
  // 但同样不是"检查器给了一个退出码"。$false 那条尤其危险：
  // [int]$false = 0，局域网会当成通过 —— 公网侧靠 ExitCodeProvided 拦住。
  { label: '返回 ExitCode = 布尔 $true', runner: "{ param($s) return @{ ExitCode = $true; Output = 'x' } }" },
  { label: '返回 ExitCode = 布尔 $false（[int]$false=0，最危险的一条）', runner: "{ param($s) return @{ ExitCode = $false; Output = 'x' } }" },
];

// 这一类**不会**被折叠成 0，而是让 `[int]$result.ExitCode` 直接抛转换异常。
// 实测确认过：模块输出 THREW|Cannot convert value "not-a-number" to type "System.Int32"。
//
// 抛异常在这里是**可接受**的：公网路径有 try/catch → gate=$null → 拒绝；
// 局域网路径没有 catch → 未捕获错误 → 脚本非零退出 → 同样不会启动。
// 两边都是 fail-closed。
//
// ⚠️ 因此修复**必须保留**这行的抛异常行为。若把它改成"安全地返回 0"，
// 局域网就会从"崩溃即拒绝"变成"ExitCode=0 即放行" —— 那是把 LAN 改坏了。
const THROWING_RUNNERS = [
  { label: '返回 ExitCode = 非数值字符串', runner: "{ param($s) return @{ ExitCode = 'not-a-number'; Output = 'x' } }" },
];

for (const c of THROWING_RUNNERS) {
  const r = callGate({ pluginInstalled: true, runner: c.runner });
  console.log(`       [诊断] ${c.label} → ${r.gate.slice(0, 110)}`);
  check(
    /^THREW\|/.test(r.gate),
    `${c.label} → 模块抛转换异常（**刻意保留**：改成返回 0 会让局域网从"崩溃即拒绝"变成"放行"）`,
    r.gate,
  );
}

for (const c of NO_CODE_RUNNERS) {
  const r = callGate({ pluginInstalled: true, runner: c.runner });
  console.log(`       [诊断] ${c.label} → 模块返回 ${r.gate} / ${r.providedLine}`);
  check(
    r.hasField,
    `${c.label} → gate 带 ExitCodeProvided 字段`,
    r.providedLine,
  );
  check(
    r.hasField && r.providedValue === 'False',
    `${c.label} → **ExitCodeProvided=False**（折叠成 0 的事实被记录下来，而不是丢失）`,
    r.providedLine,
  );
}

// 对照：给了合法整数码（含 0 与非 0）时必须标记为 True，
// 否则"收紧"会退化成"永远拒绝"，把正常启动也挡掉。
const CODE_RUNNERS = [
  { label: 'ExitCode = 0', runner: "{ param($s) return @{ ExitCode = 0; Output = 'ok' } }" },
  { label: 'ExitCode = 1', runner: "{ param($s) return @{ ExitCode = 1; Output = 'bad' } }" },
  { label: "ExitCode = '0'（数值字符串）", runner: "{ param($s) return @{ ExitCode = '0'; Output = 'ok' } }" },
  { label: 'ExitCode = -1', runner: '{ param($s) return @{ ExitCode = -1; Output = "sig" } }' },
];
for (const c of CODE_RUNNERS) {
  const r = callGate({ pluginInstalled: true, runner: c.runner });
  check(
    r.hasField && r.providedValue === 'True',
    `${c.label} → ExitCodeProvided=True（正常路径不被误伤）`,
    r.providedLine,
  );
}

console.log('');
console.log('── 4c. 真实组合：真 Test-GatewayPatchApplied → 真 Resolve-PublicTunnelGatewayGate ──');

/**
 * 在**同一个** PowerShell 进程里串起两个真实函数：
 * 注入各种形态的检查器 → 拿到真实 gate → 交给真实决策函数。
 * 这是最强的一层证据：不重新实现任何一端，也不靠字符串匹配。
 */
function composeGateThenDecide(runner) {
  const fx = makeFixture({ patched: true });
  const driver = path.join(fx.root, 'compose.ps1');
  writePowerShellScript(
    driver,
    [
      "$ErrorActionPreference = 'Stop'",
      `. ${q(gateModule)}`,
      'if (-not (Get-Command Resolve-PublicTunnelGatewayGate -ErrorAction SilentlyContinue)) {',
      "  Write-Output 'COMP|NO_FUNCTION|'",
      '  exit 0',
      '}',
      `$patchScript = ${q(path.join(fx.root, 'patches', 'mobile-gateway-mgmt-auth', 'apply.mjs'))}`,
      '$gate = $null',
      '$caught = ""',
      'try {',
      `  $gate = Test-GatewayPatchApplied -PatchScript $patchScript -Skip:$false -PluginInstalled:$true -CheckRunner ${runner}`,
      '} catch { $caught = $_.Exception.Message; $gate = $null }',
      '$d = Resolve-PublicTunnelGatewayGate -Gate $gate',
      'Write-Output ("COMP|" + $d.Allow + "|" + $d.Reason)',
    ].join('\n'),
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
  rmSync(fx.root, { recursive: true, force: true });
  const line = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /^COMP\|/.test(s));
  return line || 'NO_OUTPUT|' + out.slice(0, 200).replace(/\s+/g, ' ');
}

for (const c of NO_CODE_RUNNERS) {
  const r = composeGateThenDecide(c.runner);
  check(
    /^COMP\|False\|/.test(r),
    `组合验证：${c.label} → 公网**必定拒绝**（不得放行）`,
    r,
  );
}
{
  const r = composeGateThenDecide("{ param($s) throw 'CHECKER_BOOM' }");
  check(/^COMP\|False\|/.test(r), '组合验证：检查器抛异常 → 公网必定拒绝', r);
}
for (const c of THROWING_RUNNERS) {
  const r = composeGateThenDecide(c.runner);
  check(
    /^COMP\|False\|/.test(r),
    `组合验证：${c.label}（模块抛异常）→ 公网必定拒绝`,
    r,
  );
}
{
  // 反向对照：检查器给了 0 → 必须放行。少了这条，"全部拒绝"也能让上面全绿。
  const r = composeGateThenDecide("{ param($s) return @{ ExitCode = 0; Output = 'ok' } }");
  check(/^COMP\|True\|/.test(r), '组合验证（反向对照）：检查器给了 ExitCode=0 → 放行', r);
}
{
  const r = composeGateThenDecide("{ param($s) return @{ ExitCode = 1; Output = 'bad' } }");
  check(/^COMP\|False\|/.test(r), '组合验证：检查器给了 ExitCode=1 → 拒绝', r);
}

// ── 5. 公网决策函数：只有一条放行路径 ───────────────────────────────

console.log('');
console.log('── 5. 公网决策函数 Resolve-PublicTunnelGatewayGate（全分支） ──');

function decide(gateExpr) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gw-decide-'));
  const driver = path.join(tmp, 'decide.ps1');
  writePowerShellScript(
    driver,
    [
      "$ErrorActionPreference = 'Continue'",
      `. ${q(gateModule)}`,
      'if (-not (Get-Command Resolve-PublicTunnelGatewayGate -ErrorAction SilentlyContinue)) {',
      "  Write-Output 'NO_FUNCTION|'",
      '  exit 0',
      '}',
      `$gate = ${gateExpr}`,
      '$d = Resolve-PublicTunnelGatewayGate -Gate $gate',
      'Write-Output ("DEC|" + $d.Allow + "|" + $d.Reason)',
    ].join('\n'),
  );
  let out = '';
  try {
    out = execFileSync(
      ps.exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  rmSync(tmp, { recursive: true, force: true });
  const line = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /^(DEC\||NO_FUNCTION\|)/.test(s));
  return line || 'NO_OUTPUT|' + out.slice(0, 200).replace(/\s+/g, ' ');
}

// 构造一个合成 gate。provided 的三种取值：
//   undefined → 带 ExitCodeProvided = $true（模拟修复后真实模块的输出）
//   false     → 带 ExitCodeProvided = $false（检查器没给退出码）
//   'omit'    → 完全不带这个字段（旧形态 / 畸形结果）
const G = (o) => {
  const parts = [
    `ShouldCheck = ${o.sc}`,
    `ExitCode = ${o.code}`,
    `Output = ${q(o.out || '')}`,
    `Reason = ${q(o.reason || '')}`,
  ];
  if (o.provided !== 'omit') {
    parts.push(`ExitCodeProvided = ${o.provided === false ? '$false' : '$true'}`);
  }
  return `[pscustomobject]@{ ${parts.join('; ')} }`;
};

const decisionCases = [
  { label: 'ShouldCheck=True / ExitCode=0 / ExitCodeProvided=True → **放行**（唯一放行路径）', expr: G({ sc: '$true', code: 0 }), want: 'True' },
  { label: 'ShouldCheck=True / ExitCode=1 → 拒绝', expr: G({ sc: '$true', code: 1 }), want: 'False' },
  { label: 'ShouldCheck=True / ExitCode=3 → 拒绝', expr: G({ sc: '$true', code: 3 }), want: 'False' },
  { label: 'ShouldCheck=True / ExitCode=-1 → 拒绝', expr: G({ sc: '$true', code: -1 }), want: 'False' },
  { label: 'ShouldCheck=False / Reason=SkipGatewayPatchCheck → 拒绝（公网无跳过）', expr: G({ sc: '$false', code: 0, reason: 'SkipGatewayPatchCheck' }), want: 'False' },
  { label: 'ShouldCheck=False / Reason=plugin-not-installed → 拒绝', expr: G({ sc: '$false', code: 0, reason: 'plugin-not-installed' }), want: 'False' },
  { label: 'ShouldCheck=False / Reason=patch-script-missing → 拒绝', expr: G({ sc: '$false', code: 0, reason: 'patch-script-missing' }), want: 'False' },
  { label: 'ShouldCheck=False / Reason=空 → 拒绝（状态未知）', expr: G({ sc: '$false', code: 0, reason: '' }), want: 'False' },
  { label: 'ShouldCheck=False / Reason=未识别值 → 拒绝（状态未知）', expr: G({ sc: '$false', code: 0, reason: 'something-new' }), want: 'False' },
  { label: 'gate 缺 Reason 字段 → 拒绝（结果畸形）', expr: "[pscustomobject]@{ ShouldCheck = $true; ExitCode = 0; Output = '' }", want: 'False' },
  { label: 'gate 缺 ExitCode 字段 → 拒绝（结果畸形）', expr: "[pscustomobject]@{ ShouldCheck = $true; Reason = ''; Output = '' }", want: 'False' },
  { label: 'gate 缺 ShouldCheck 字段 → 拒绝（结果畸形）', expr: "[pscustomobject]@{ ExitCode = 0; Reason = ''; Output = '' }", want: 'False' },
  { label: 'gate 是空对象 → 拒绝', expr: '[pscustomobject]@{ }', want: 'False' },

  // ── 本轮（P2.2）新增：检查器没给退出码 ──
  // 修复前这两条会**放行**：模块把 $null 折叠成 0，决策函数看到的与"检查通过"无异。
  { label: '**ExitCodeProvided=False** 而 ExitCode=0 → 拒绝（折叠成 0 的假通过）', expr: G({ sc: '$true', code: 0, provided: false }), want: 'False' },
  { label: '**缺 ExitCodeProvided 字段** 而 ExitCode=0 → 拒绝（旧形态/畸形，不得默认放行）', expr: G({ sc: '$true', code: 0, provided: 'omit' }), want: 'False' },
  { label: 'ExitCodeProvided 不是布尔（字符串 "true"）→ 拒绝', expr: "[pscustomobject]@{ ShouldCheck = $true; ExitCode = 0; Output = ''; Reason = ''; ExitCodeProvided = 'true' }", want: 'False' },

  // ── 本轮新增：ExitCode 为 $null / 非整数 ──
  { label: '**ExitCode = $null**（字段存在但值为空）→ 拒绝', expr: G({ sc: '$true', code: '$null' }), want: 'False' },
  { label: "ExitCode = 'abc'（非数值字符串）→ 拒绝", expr: G({ sc: '$true', code: "'abc'" }), want: 'False' },
  { label: "ExitCode = ''（空字符串）→ 拒绝", expr: G({ sc: '$true', code: "''" }), want: 'False' },
  { label: 'ExitCode = $true（布尔，PS 里 [int]$true=1）→ 拒绝', expr: G({ sc: '$true', code: '$true' }), want: 'False' },
  { label: 'ExitCode = 0.0（浮点，不是整数）→ 拒绝', expr: G({ sc: '$true', code: '0.0' }), want: 'False' },

  // ── 本轮新增：ShouldCheck 非布尔 ──
  // PowerShell 里 if ('false') 为真 —— 非空字符串一律 truthy，
  // 所以不做严格类型检查的话，ShouldCheck='false' 会被当成"需要检查"，
  // 再配上 ExitCode=0 就**放行**了。
  { label: "**ShouldCheck = 'false'**（字符串，PS 里 truthy）+ ExitCode=0 → 拒绝", expr: G({ sc: "'false'", code: 0 }), want: 'False' },
  { label: "**ShouldCheck = 'true'**（字符串而非布尔）+ ExitCode=0 → 拒绝", expr: G({ sc: "'true'", code: 0 }), want: 'False' },
  { label: '**ShouldCheck = $null** + ExitCode=0 → 拒绝', expr: G({ sc: '$null', code: 0 }), want: 'False' },
  { label: '**ShouldCheck = 1**（整数而非布尔）+ ExitCode=0 → 拒绝', expr: G({ sc: '1', code: 0 }), want: 'False' },
  { label: '**ShouldCheck = 0**（整数而非布尔）→ 拒绝（不得当成 False 走 Reason 分支）', expr: G({ sc: '0', code: 0, reason: 'plugin-not-installed' }), want: 'False' },
];

let sawNoFunction = false;
for (const c of decisionCases) {
  const r = decide(c.expr);
  if (/^NO_FUNCTION\|/.test(r)) sawNoFunction = true;
  check(
    new RegExp('^DEC\\|' + c.want + '\\|').test(r),
    c.label,
    r,
  );
}
if (sawNoFunction) {
  console.log('       [诊断] Resolve-PublicTunnelGatewayGate 不存在 —— 公网决策函数尚未实现');
}
// gate 为 $null：Mandatory + AllowNull 才能显式传 null
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gw-null-'));
  const driver = path.join(tmp, 'null.ps1');
  writePowerShellScript(
    driver,
    [
      "$ErrorActionPreference = 'Continue'",
      `. ${q(gateModule)}`,
      'if (-not (Get-Command Resolve-PublicTunnelGatewayGate -ErrorAction SilentlyContinue)) {',
      "  Write-Output 'NO_FUNCTION|'",
      '  exit 0',
      '}',
      '$d = Resolve-PublicTunnelGatewayGate -Gate $null',
      'Write-Output ("DEC|" + $d.Allow + "|" + $d.Reason)',
    ].join('\n'),
  );
  let out = '';
  try {
    out = execFileSync(
      ps.exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  rmSync(tmp, { recursive: true, force: true });
  const line = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => /^(DEC\||NO_FUNCTION\|)/.test(s));
  check(/^DEC\|False\|/.test(line || ''), 'gate 为 $null（检查器抛异常时的形态）→ 拒绝', line || out.slice(0, 200));
}

// ── 6. 拒绝文案：公网不广告跳过开关，局域网 opt-out 不被削弱 ─────────

console.log('');
console.log('── 6. 拒绝文案（真实执行 Write-GatewayPatchRefusal） ──');

function refusal(args) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gw-msg-'));
  const driver = path.join(tmp, 'msg.ps1');
  writePowerShellScript(
    driver,
    [
      "$ErrorActionPreference = 'Continue'",
      `. ${q(gateModule)}`,
      "Write-Output '---BEGIN---'",
      `Write-GatewayPatchRefusal ${args}`,
      "Write-Output '---END---'",
    ].join('\n'),
  );
  let out = '';
  try {
    out = execFileSync(
      ps.exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  rmSync(tmp, { recursive: true, force: true });
  const i = out.indexOf('---BEGIN---');
  const j = out.indexOf('---END---');
  return i >= 0 && j > i ? out.slice(i + 11, j) : '';
}

{
  const pub = refusal('-Public -Detail "DETAIL_QQ"');
  check(pub.length > 0, '公网文案被捕获');
  check(/拒绝启动/.test(pub), '公网文案：明确拒绝启动');
  check(/DETAIL_QQ/.test(pub), '公网文案：附带检查器原始输出');
  check(!/SkipGatewayPatchCheck/.test(pub), '公网文案不含 SkipGatewayPatchCheck（不教用户绕过）');

  const lan = refusal('-Detail "LAN_QQ"');
  check(/SkipGatewayPatchCheck/.test(lan), '局域网文案仍保留 opt-out 提示（未被这次收紧削弱）');
  check(/LAN_QQ/.test(lan), '局域网文案：附带检查器原始输出');
}
{
  // 无法验证类原因：文案必须说"无法确认"，不能谎称"补丁未生效"，
  // 也不能给出一个不存在的修复命令（apply.mjs 本身就缺失时）。
  const miss = refusal('-Public -Reason "patch-script-missing" -Detail "X"');
  // 不能只用 length > 0：参数不存在时 PowerShell 的报错文本也会被捕获，
  // 那样断言就假通过了（本 spec 第一次运行时就发生了）。
  check(
    miss.length > 0 && !/ParameterBindingException|找不到与参数名称|AmbiguousParameter/.test(miss),
    '带 -Reason 的公网文案被捕获，且不是参数绑定报错（参数已实现）',
    miss.slice(0, 200),
  );
  check(/拒绝启动/.test(miss), 'patch-script-missing：明确拒绝启动');
  check(!/SkipGatewayPatchCheck/.test(miss), 'patch-script-missing：仍不含跳过开关');
  check(
    /无法确认|无法校验|未能确认/.test(miss),
    'patch-script-missing：文案说的是「无法确认」而不是断言「补丁未生效」',
    miss.slice(0, 300),
  );

  const plug = refusal('-Public -Reason "plugin-not-installed" -Detail "X"');
  check(/拒绝启动/.test(plug), 'plugin-not-installed：明确拒绝启动');
  check(!/SkipGatewayPatchCheck/.test(plug), 'plugin-not-installed：仍不含跳过开关');

  const unk = refusal('-Public -Reason "unknown-state" -Detail "X"');
  check(/拒绝启动/.test(unk), 'unknown-state：明确拒绝启动');
  check(!/SkipGatewayPatchCheck/.test(unk), 'unknown-state：仍不含跳过开关');

  // patch-not-applied 应沿用既有文案（"补丁未生效" + apply.mjs --apply）
  const np = refusal('-Public -Reason "patch-not-applied" -Detail "X"');
  check(/认证补丁未生效/.test(np), 'patch-not-applied：沿用「认证补丁未生效」文案');
  check(/apply\.mjs --apply/.test(np), 'patch-not-applied：给出可执行的修复命令');
}

// ── 7. -Stop / -Status 不受门禁影响 ─────────────────────────────────

console.log('');
console.log('── 7. -Stop / -Status：原有行为不受门禁影响 ──');

{
  // -Status 是只读的（只 Get-Content 一个 json），可以真实整脚本执行。
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'gw-status-'));
  const stateDir = path.join(tmp, 'state');
  mkdirSync(stateDir, { recursive: true });
  let code = 0;
  let out = '';
  try {
    out = execFileSync(
      ps.exe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        tunnelScript,
        '-Status',
      ],
      {
        encoding: 'utf8',
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
          DSH_STATE_DIR: stateDir,
          DSH_POCKET_ROOT: tmp,
          // start-tunnel.ps1 是 Windows 脚本：cloudflared 探测的回退分支会
          // Join-Path $env:LOCALAPPDATA / $env:ProgramFiles（:74-75）。这两个
          // 变量在 ubuntu runner 上不存在，Join-Path 收到 $null 会直接抛
          // ParameterArgumentValidationErrorNullNotAllowed，脚本在走到 -Status
          // 自己的逻辑之前就 exit 1 —— 看起来像门禁拦了它，其实不是。
          // 只在缺失时补临时目录，Windows 上沿用原值，行为不变。
          LOCALAPPDATA: process.env.LOCALAPPDATA || tmp,
          ProgramFiles: process.env.ProgramFiles || tmp,
        }),
      },
    );
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : -1;
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  rmSync(tmp, { recursive: true, force: true });
  check(code === 0, '-Status 真实执行：exit 0（未被门禁拦住）', `exit=${code} ${out.slice(-300)}`);
  check(/当前没有隧道/.test(out), '-Status 真实执行：输出原有文案');
  check(!/拒绝启动/.test(out), '-Status 真实执行：没有触发门禁拒绝');
}

{
  // -Stop **永不执行**：start-tunnel.ps1:151 会 Stop-Process 全机所有 cloudflared。
  // 改为顺序断言 —— 两个早退都必须在门禁代码块之前。
  const src = readFileSync(tunnelScript, 'utf8');
  const stopIdx = src.indexOf('if ($Stop) {');
  const statusIdx = src.indexOf('if ($Status) {');
  const gateIdx = src.indexOf(BEGIN_ANCHOR);
  check(stopIdx > 0, '定位到 -Stop 分支');
  check(statusIdx > 0, '定位到 -Status 分支');
  check(gateIdx > 0, '定位到门禁代码块起点');
  check(
    stopIdx < gateIdx && statusIdx < gateIdx,
    '-Stop 与 -Status 的分支都在门禁**之前**（只读/停止操作不被门禁拦截）',
    `stop=${stopIdx} status=${statusIdx} gate=${gateIdx}`,
  );
  const stopExit = src.indexOf('exit 0', stopIdx);
  check(
    stopExit > stopIdx && stopExit < gateIdx,
    '-Stop 分支在门禁之前就 exit 0 了',
    `stopExit=${stopExit} gate=${gateIdx}`,
  );
  ok('-Stop 刻意**不做真实执行**：它会 Stop-Process 全机所有 cloudflared 进程');
}

// ── 8. 局域网路径的兼容行为未被改动 ─────────────────────────────────

console.log('');
console.log('── 8. 局域网 start-dsh-web.ps1 兼容行为未变 ──');

{
  const lan = readFileSync(lanScript, 'utf8');
  check(/-Skip:\$SkipGatewayPatchCheck/.test(lan), '局域网仍把自己的开关传给门禁（行为不变）');
  check(
    /if \(\$gate\.ShouldCheck\)/.test(lan),
    '局域网仍是原有的 ShouldCheck 判定（**刻意不改**，保持兼容）',
  );
  check(
    !/Resolve-PublicTunnelGatewayGate/.test(lan),
    '局域网没有引入公网决策函数（收紧只作用于公网路径）',
  );
  check(/\[switch\]\$SkipGatewayPatchCheck/.test(lan), '局域网的 opt-out 参数仍然存在');
}

// ── 9. 公网路径没有跳过参数 ─────────────────────────────────────────

console.log('');
console.log('── 9. 公网路径不得有任何跳过出口 ──');

{
  const src = readFileSync(tunnelScript, 'utf8');
  // 只看代码，不看注释：注释里为了说明"为什么没有跳过开关"必然会提到这个词，
  // 这是 gateway-startup-gate-spec §7 已经踩过的同一个坑。
  const codeOnly = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  check(
    !/SkipGatewayPatchCheck/.test(codeOnly),
    'start-tunnel.ps1 的**代码**里没有 SkipGatewayPatchCheck（注释里可以有）',
  );
  check(!/\[switch\]\$Skip/.test(codeOnly), 'start-tunnel.ps1 没有声明任何 skip 类开关参数');
  check(/-Skip:\$false/.test(codeOnly), '调用门禁时显式传 -Skip:$false（不依赖默认值）');
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败，${skip} 跳过`);
process.exitCode = fail === 0 ? 0 : 1;
