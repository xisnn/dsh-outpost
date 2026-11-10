/**
 * 契约测试的「静默 skip」守卫回归测试（TEST-03）。
 *
 * ## 守什么
 *
 * `protocol-contract-spec.mjs` 与 `crosscheck-revoke-self-spec.mjs` 是**唯一**
 * 能自动防御 `tests/support/fake-dsh.mjs` 与真实 `dsh-plugin-mobile-gateway`
 * 漂移的机制。它们守的是 DSH 审批协议的硬契约：子协议前缀 `dsh-auth.` /
 * `dsh-pair.`、非 GET 管理请求的同源 Origin 校验、撤销语义、以及
 * `clientDeviceId` 缺失时的设备自识别。
 *
 * 两者都用 `process.exitCode = fail === 0 ? 0 : 1` —— **`skip` 不参与退出码**，
 * 而每条依赖插件的断言都写成 `if (!src) return { skip: … }`。于是插件一旦
 * 不可解析，整组断言静默消失而进程仍以 0 退出。
 *
 * 这**不是假设**：`.github/workflows/signing-verify.yml` 跑完整 `npm test`
 * 却不设 `DSH_GATEWAY_PLUGIN_DIR`（`android.yml` 是唯一设它的 workflow），
 * runner 是 ubuntu-latest，`USERPROFILE` 未定义、`$HOME/.dsh/…` 不存在
 * → 15 条契约断言全部 skip → 两个 spec 均 exit 0 → 该 workflow 报绿。
 *
 * 同仓库的第三个消费者 `approval-gateway-f01-spec.mjs:60-63` 是 fail-closed 的
 * （`if (!pluginDir) { console.error('FAIL: …'); process.exit(1); }`）。
 * 三个 spec 对同一前置条件给出两种相反处理 —— 这是内部不一致。
 *
 * ## 怎么测
 *
 * 用**真实子进程**跑这两个 spec，而不是读源码断言字符串：
 *   · 敌意环境（`CI=1` + 插件不可解析）→ **必须非零退出**，且输出必须含守卫
 *     自己的标记（防止"因为别的原因崩了"被误判成守卫生效）
 *   · 正常环境（插件可解析）→ **必须仍为 0 且 skip 为 0**（防止修复把正常
 *     路径弄坏，也防止守卫变成恒真）
 *
 * 另加静态断言：两个 workflow 都必须设 `DSH_GATEWAY_PLUGIN_DIR` 且值一致 ——
 * 只加守卫不补环境变量会把 `signing-verify.yml` 弄红，只补环境变量不加守卫
 * 则下次仍会静默失效。两半缺一不可。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
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
const mobileDir = path.join(repo, 'dsh-mobile');
// 不用 node_modules/.bin/tsx(.cmd)：Node 20.12+ 出于 CVE-2024-27980 拒绝在
// 没有 shell:true 的情况下 spawn .cmd/.bat，而开 shell 就要自己处理引号注入。
// 直接用 process.execPath 跑 tsx 的 JS 入口，跨平台且没有这层麻烦。
const tsxCli = path.join(mobileDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const installedPlugin = path.join(mobileDir, 'node_modules', 'dsh-plugin-mobile-gateway');

/** 这两个 spec 是本次守卫的对象；normalPass 是插件可解析时应有的通过数 */
const GUARDED = [
  { file: 'protocol-contract-spec.mjs', normalPass: 16 },
  { file: 'crosscheck-revoke-self-spec.mjs', normalPass: 5 },
];

/** 守卫触发时打印的标记 —— 断言它，才能区分"守卫生效"和"因别的原因崩了" */
const GUARD_MARKER = 'CI 必须能解析真实网关插件';

function runSpec(file, env) {
  try {
    const out = execFileSync(process.execPath, [tsxCli, path.join('tests', file)], {
      cwd: mobileDir,
      encoding: 'utf8',
      env,
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      out: String(e.stdout || '') + String(e.stderr || ''),
    };
  }
}

console.log('');
console.log('── 1. 静态：两个 workflow 都必须设 DSH_GATEWAY_PLUGIN_DIR ──');

const androidWf = readFileSync(path.join(repo, '.github', 'workflows', 'android.yml'), 'utf8');
const signingWf = readFileSync(path.join(repo, '.github', 'workflows', 'signing-verify.yml'), 'utf8');

const envValue = (src) => {
  const m = src.match(/DSH_GATEWAY_PLUGIN_DIR:\s*(.+?)\s*$/m);
  return m ? m[1].trim() : null;
};
const androidVal = envValue(androidWf);
const signingVal = envValue(signingWf);

check(androidVal !== null, 'android.yml 设了 DSH_GATEWAY_PLUGIN_DIR（基线，本就该有）');
check(
  signingVal !== null,
  'signing-verify.yml 也设了 DSH_GATEWAY_PLUGIN_DIR（否则它跑 npm test 时契约断言全 skip）',
  signingVal === null ? '缺失 —— 该 workflow 的契约交叉检查是报告成功的空操作' : '',
);
check(
  androidVal !== null && signingVal !== null && androidVal === signingVal,
  '两个 workflow 的值逐字一致（防止其中一处指向错路径）',
  `android=${androidVal} signing=${signingVal}`,
);
// signing-verify.yml 确实跑完整 npm test —— 这是"缺口真实存在"的前提
check(
  /run:\s*npm test\b/.test(signingWf),
  'signing-verify.yml 确实运行完整 npm test（前提成立，缺口才有意义）',
);

console.log('');
console.log('── 2. 静态：两个 spec 的退出码必须把 CI 下的 skip 计入失败 ──');

for (const { file } of GUARDED) {
  const src = readFileSync(path.join(mobileDir, 'tests', file), 'utf8');
  check(
    /process\.env\.CI/.test(src),
    `${file}：引用 process.env.CI（否则无法区分本地与 CI）`,
  );
  check(
    src.includes(GUARD_MARKER),
    `${file}：含插件不可解析时的 fail-closed 守卫`,
  );
  check(
    /process\.env\.CI[\s\S]{0,200}?skip\s*>/.test(src) || /skip\s*>[\s\S]{0,200}?process\.env\.CI/.test(src),
    `${file}：CI 下 skip > 0 计入失败（覆盖"目录解析成功但单个文件缺失"的残余漏洞）`,
  );
}

// 对照：第三个消费者本来就是 fail-closed 的，不能被这次改动弄坏
{
  const f01 = readFileSync(path.join(mobileDir, 'tests', 'approval-gateway-f01-spec.mjs'), 'utf8');
  check(
    /if \(!pluginDir\) \{[\s\S]{0,200}?process\.exit\(1\)/.test(f01),
    'approval-gateway-f01-spec.mjs 的 fail-closed 范式仍在（本次改动的参照物）',
  );
}

// server-identity-binding-spec.mjs 的 skip 来自端口复用竞态，刻意**不**纳入守卫
{
  const sib = readFileSync(path.join(mobileDir, 'tests', 'server-identity-binding-spec.mjs'), 'utf8');
  check(
    !sib.includes(GUARD_MARKER),
    'server-identity-binding-spec.mjs 未被纳入守卫（其 skip 是端口竞态，强行失败会引入 CI 抖动）',
  );
}

console.log('');
console.log('── 3. 行为：敌意环境（CI=1 + 插件不可解析）必须非零退出 ──');

if (!existsSync(tsxCli)) {
  if (process.env.CI) bad(`CI 必须有 tsx：${tsxCli}`);
  else console.log('  SKIP  本机没有 node_modules/tsx/dist/cli.mjs，跳过行为测试');
} else {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'noplug-'));
  try {
    // CANDIDATES 的三项全部指向这个空目录 → 保证解析不到插件。
    //
    // 注意**不能**用 delete env.USERPROFILE 来隐藏它：Windows 上 Node 交给
    // 子进程的环境块仍会带上真实的 USERPROFILE（实测子进程读到 C:\Users\…，
    // 于是插件被解析、守卫根本没被触发，而"非零退出"这条断言会因为别的原因
    // 假通过）。显式赋值到空目录在 Windows 与 Linux 上行为一致。
    const hostile = {
      ...process.env,
      CI: '1',
      DSH_GATEWAY_PLUGIN_DIR: path.join(empty, 'nope'),
      HOME: empty,
      USERPROFILE: empty,
    };

    for (const { file } of GUARDED) {
      const r = runSpec(file, hostile);
      check(
        r.code !== 0,
        `${file}：插件不可解析 + CI=1 → 非零退出（修复前是 0）`,
        `实际退出码 ${r.code}`,
      );
      check(
        r.out.includes(GUARD_MARKER),
        `${file}：退出是因为守卫，不是因为别的崩溃`,
        r.out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 3).join(' | ').slice(0, 240),
      );
      check(
        /SKIP/.test(r.out),
        `${file}：仍然如实打印 SKIP（不掩盖"哪些断言没跑"）`,
      );
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

console.log('');
console.log('── 4. 行为：插件可解析时必须仍为 0 且 skip 为 0（防止修复弄坏正常路径）──');

if (!existsSync(tsxCli)) {
  console.log('  SKIP  本机没有 tsx');
} else if (!existsSync(path.join(installedPlugin, 'lib', 'index.mjs'))) {
  if (process.env.CI) bad(`CI 必须已安装网关插件：${installedPlugin}`);
  else console.log(`  SKIP  本机未安装 ${installedPlugin}`);
} else {
  const normal = { ...process.env, DSH_GATEWAY_PLUGIN_DIR: installedPlugin };
  delete normal.CI;
  for (const { file, normalPass } of GUARDED) {
    const r = runSpec(file, normal);
    const m = r.out.match(/结果：(\d+) 通过，(\d+) 失败，(\d+) 跳过/);
    check(r.code === 0, `${file}：插件可解析 → 退出码 0`, `实际 ${r.code}`);
    check(m !== null, `${file}：输出了结果汇总行`, m === null ? r.out.slice(-200) : '');
    if (m) {
      check(
        Number(m[3]) === 0,
        `${file}：skip 为 0（断言真的跑了，不是被跳过）`,
        `跳过 ${m[3]} 条`,
      );
      check(
        Number(m[1]) >= normalPass,
        `${file}：通过数不少于 ${normalPass}（守卫没有吃掉断言）`,
        `实际 ${m[1]} 通过`,
      );
    }
  }

  // CI=1 但插件可解析 —— 这是 CI 的真实情形，必须仍然全绿
  const ci = { ...normal, CI: '1' };
  for (const { file } of GUARDED) {
    const r = runSpec(file, ci);
    check(
      r.code === 0,
      `${file}：CI=1 且插件可解析 → 仍为 0（这正是 CI 的真实情形）`,
      `实际 ${r.code}`,
    );
  }
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
