/**
 * 启动路径的网关认证补丁门禁回归测试。
 *
 * ## 守什么
 *
 * `/mgw/*` 管理接口（含能铸造配对码的 `POST /mgw/pair`）靠
 * `patches/mobile-gateway-mgmt-auth/` 这个补丁来鉴权。补丁打在
 * `~/.dsh/profiles/web/node_modules/.../lib/index.mjs` 上，
 * **一次插件升级或 npm install 就会把它抹掉**。
 *
 * 之前只有 `setup-gateway.ps1` 检查补丁。那就意味着：
 *
 *   用户装好一切 → 上游插件更新 → 用户只是正常重启 DSH
 *   → 补丁已丢失，但 adminLoopbackOnly 仍是 false
 *   → **管理接口无认证地暴露在局域网上**，没人会察觉。
 *
 * 所以 `start-dsh-web.ps1`（日常启动路径）也必须查，且必须 fail-closed。
 *
 * ## 测什么
 *
 * 1. 静态：门禁代码存在、位置正确、默认拒绝、有显式跳过开关
 * 2. 行为：`apply.mjs --check` 返回非 0 时，脚本真的以非 0 退出
 * 3. 反向：`-SkipGatewayPatchCheck` 能跳过（且不误伤未装插件的用户）
 *
 * 行为测试用 `-WhatIf` 式的做法：只让脚本跑到门禁就结束 ——
 * 通过给一个必然失败的端口参数不值当，所以改成直接**执行那段逻辑**并
 * 另跑一次真实脚本（用不会启动成功的参数）来确认退出码。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
const applyScript = path.join(repo, 'patches', 'mobile-gateway-mgmt-auth', 'apply.mjs');

console.log('');
console.log('── 1. 静态：门禁存在且默认拒绝 ──');

const src = read('start-dsh-web.ps1');

check(existsSync(startScript), 'start-dsh-web.ps1 存在');
check(
  /mobile-gateway-mgmt-auth\\apply\.mjs|mobile-gateway-mgmt-auth\/apply\.mjs/.test(src),
  '启动脚本引用了补丁检查脚本',
);
check(/\$patchScript --check/.test(src), '启动时调用 apply.mjs --check');
check(
  /if \(\$patchExit -ne 0\) \{[\s\S]{0,1200}?exit 1/.test(src),
  '检查失败时 exit 1（fail-closed）',
);
check(
  /\[switch\]\$SkipGatewayPatchCheck/.test(src),
  '提供 -SkipGatewayPatchCheck 显式跳过开关',
);
check(
  /-not \$SkipGatewayPatchCheck/.test(src),
  '门禁默认启用（需显式跳过才不查）',
);
check(
  /\$gatewayInstalled/.test(src),
  '只在插件已安装时才检查（不影响没用网关的用户）',
);

// 关键坑：全局 ErrorActionPreference='Stop' 会把 node 的 stderr 变成终止错误
check(
  /\$ErrorActionPreference = 'Continue'/.test(src),
  '调用 node 时临时改回 Continue（否则 stderr 会直接终止脚本）',
);
check(/finally \{[\s\S]{0,120}?\$prevEap/.test(src), '执行完恢复原 ErrorActionPreference');

// 门禁必须在端口检查之前（否则端口占用会先退出，门禁永远跑不到）
{
  const gateIdx = src.indexOf('$patchScript --check');
  const portIdx = src.indexOf('已被占用');
  check(
    gateIdx > 0 && portIdx > gateIdx,
    '门禁位于端口占用检查之前（否则会被提前退出绕过）',
    `gate=${gateIdx} port=${portIdx}`,
  );
}

console.log('');
console.log('── 2. 行为：补丁未应用时脚本必须拒绝启动 ──');

{
  // 先确认当前系统状态下 apply --check 的真实退出码
  let checkExit = 0;
  try {
    execFileSync(process.execPath, [applyScript, '--check'], { stdio: 'pipe' });
    checkExit = 0;
  } catch (e) {
    checkExit = typeof e.status === 'number' ? e.status : 1;
  }
  const patchApplied = checkExit === 0;
  console.log(`  （当前补丁状态：${patchApplied ? '已应用' : '未应用'}）`);

  if (!patchApplied) {
    // 补丁未应用 → 脚本必须拒绝启动（非 0 退出）
    let out = '';
    let code = 0;
    try {
      out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
        { encoding: 'utf8', stdio: 'pipe', timeout: 120000 },
      );
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      code = typeof e.status === 'number' ? e.status : 1;
    }
    check(code !== 0, '补丁未应用时启动脚本以非 0 退出', `exit=${code}`);
    check(/认证补丁未生效/.test(out), '输出说明「认证补丁未生效」');
    check(/apply\.mjs --apply/.test(out), '输出给出可直接执行的修复命令');
    check(/SkipGatewayPatchCheck/.test(out), '输出说明可显式跳过（不让人卡死）');
  } else {
    console.log('  SKIP  补丁当前已应用，跳过「拒绝启动」行为测试');
  }
}

console.log('');
console.log('── 3. setup-gateway 仍然强制要求补丁 ──');

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
console.log('── 4. DSH 重启不会让补丁「悄悄失效」──');

// 补丁状态记录文件应存在（apply 成功后写 state.json）
check(
  /state\.json/.test(read('patches/mobile-gateway-mgmt-auth/apply.mjs')),
  'apply.mjs 记录补丁指纹到 state.json（可审计）',
);
// README 里必须写明升级后的处理流程
const readme = read('patches/mobile-gateway-mgmt-auth/README.md');
check(/插件升级/.test(readme), 'README 说明了插件升级后的处理流程');
check(/--check/.test(readme), 'README 给出 --check 用法');

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
