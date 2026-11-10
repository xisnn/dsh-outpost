#!/usr/bin/env node
/**
 * 测试套件聚合器 —— 跑完全部命令再汇总失败，而不是在第一个失败处截断。
 *
 * ## 为什么需要它
 *
 * `package.json` 的测试脚本原本是一条 105 个 spawn 的 `&&` 链。`&&` 的语义是
 * **失败即截断**：任何一环非零退出，其后所有命令都不再执行。后果有两个：
 *
 *   1. 一次运行只能看到**第一个**失败，其余约 100 个套件的结果完全未知，
 *      修复必须串行地"修一个、重跑、再看下一个"。提交 `9c17dbd` 的作者
 *      逐字记录过这件事：两个失败挡住了下游约 60 个套件。
 *   2. `tsc --noEmit` 是链条**最后一环**（经 `npm run typecheck`），所以
 *      前面任何测试失败都会让类型检查根本不跑 —— 红的分支同时失去类型信号。
 *
 * **注意这不是"假绿"问题**：`&&` 链失败时退出码非零，CI 是红的；一条完整
 * 跑通的链意味着全部命令都通过了。本文件解决的是**诊断完整性**，不是信号
 * 真伪。（真正的假绿通道是契约测试的静默 skip，见 `contract-skip-guard-spec.mjs`。）
 *
 * ## 设计约束（第二方复核意见 2）
 *
 *   · **必须兼容 Node 20** —— CI 四个 job 全部钉在 `node-version: 20`，
 *     `package.json` 的 `engines` 是 `>=20`。因此只用 Node 20 一定有的 API：
 *     不用 `import.meta.dirname`（20.11+ 才有），不用 `--test` 的 glob 位置
 *     参数（版本相关，未经验证），不用 `Array.prototype.toSorted` 之类。
 *   · **必须保留原有执行语义** —— 105 条命令里有 71 条 `tsx` 裸调用、
 *     8 条 `tsx --test`、12 条 `node --test`、18 条裸 `node`、3 条
 *     `node --require ./tests/support/node20-sim.cjs`、2 条 `tsx --require …`、
 *     1 条 `tsc --noEmit`。这里**不重新发明命令**：仍然从 `package.json`
 *     出发按 `&&` 与 `npm run X` 传递展开，得到与旧链**逐字相同**的命令列表，
 *     然后逐条原样执行。`--require` / `--test` 等前缀全部原样透传。
 *   · **不用 glob、不用 shell 通配** —— 命令来自 `package.json`，不来自文件
 *     系统扫描；执行用 `spawnSync(file, args, { shell: false })`，不经 shell。
 *   · **不并行** —— 现有 spec 共享 `globalThis` shim 状态（三个互不同步的
 *     cookie jar，见审计报告 TEST-04），并行会引入与本改动无关的失败。
 *     保持串行，语义与旧链一致。
 *
 * ## 为什么绕开 node_modules/.bin
 *
 * `tsx` 与 `tsc` 都通过 `process.execPath` 直接跑它们的 JS 入口，而不是
 * `.bin/tsx`：Node 20.12+ 出于 CVE-2024-27980 拒绝在没有 `shell: true` 的
 * 情况下 spawn `.cmd`/`.bat`，而开 shell 就得自己处理引号注入。走 JS 入口
 * 在 Windows 与 Linux 上行为一致，也没有这层麻烦。
 *
 * ## 失败即拒绝，绝不静默
 *
 * 遇到未知的可执行文件、含 shell 元字符的命令、缺失的 script、或循环引用，
 * 一律**抛错退出**，而不是跳过或猜测。静默改变执行语义比失败更糟。
 *
 * ## 用法
 *
 *   node tests/run-suite.mjs                     # 默认跑 test:chain
 *   node tests/run-suite.mjs test:integration:chain
 *   node tests/run-suite.mjs --dry-run           # 只打印将要执行的命令，不执行
 *   node tests/run-suite.mjs --dry-run test:chain test:integration:chain
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');

const NODE = process.execPath;
const TSX_CLI = path.join(pkgDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TSC_BIN = path.join(pkgDir, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * shell 元字符白名单的反面。
 *
 * 旧链由 shell 解释，所以理论上命令里可以带引号、管道、重定向。
 * `spawnSync(…, { shell: false })` 会把它们当**普通字符**传给程序 —— 那是
 * 静默的语义改变。当前 115 条叶子命令里一个都没有（已逐条核实），所以这里
 * 直接拒绝：将来谁加了带元字符的命令，会立刻看到明确的报错，而不是一个
 * 行为悄悄不同的测试。
 */
const SHELL_META = /["'`|;&><$*?[\](){}\\]/;

const DEFAULT_ROOT = 'test:chain';

function fail(msg) {
  process.stderr.write(`\n[X] run-suite: ${msg}\n`);
  process.exit(1);
}

function loadScripts() {
  const pkgPath = path.join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) fail(`找不到 ${pkgPath}`);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    fail(`package.json 不是合法 JSON：${e.message}`);
  }
  if (!pkg.scripts || typeof pkg.scripts !== 'object') fail('package.json 里没有 scripts 块');
  return pkg.scripts;
}

/**
 * 按 shell 的 `&&` 与 `npm run X` 语义传递展开成叶子命令列表。
 *
 * **不去重**：shell 里 `npm run a && npm run a` 就是跑两次，展开必须如实反映。
 * （当前链里恰好没有重复引用，但算法不能依赖这个巧合。）
 */
function expand(root, scripts) {
  const leaves = [];
  const stack = [];

  const walk = (key) => {
    if (stack.includes(key)) {
      fail(`npm script 循环引用：${stack.concat(key).join(' → ')}`);
    }
    const value = scripts[key];
    if (typeof value !== 'string') {
      fail(`package.json 里没有 script "${key}"（由 ${stack[stack.length - 1] ?? '<命令行>'} 引用）`);
    }
    stack.push(key);
    for (const part of value.split('&&').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^npm run ([\w:.-]+)$/);
      if (m) walk(m[1]);
      else leaves.push(part);
    }
    stack.pop();
  };

  walk(root);
  return leaves;
}

/** 把一条命令文本解析成 spawnSync 的 (file, args)。不认识就抛错。 */
function resolve(cmd) {
  if (SHELL_META.test(cmd)) {
    fail(
      `命令含 shell 元字符，拒绝执行（spawnSync 不经 shell，语义会与旧链不同）：\n      ${cmd}\n` +
        '    如果确实需要 shell 特性，请把它拆成不含元字符的独立 script。',
    );
  }
  const tokens = cmd.split(/\s+/);
  const [exe, ...args] = tokens;
  switch (exe) {
    case 'node':
      return { file: NODE, args };
    case 'tsx':
      if (!existsSync(TSX_CLI)) fail(`tsx 未安装：${TSX_CLI}（先在 dsh-mobile 里跑 npm ci）`);
      return { file: NODE, args: [TSX_CLI, ...args] };
    case 'tsc':
      if (!existsSync(TSC_BIN)) fail(`typescript 未安装：${TSC_BIN}（先在 dsh-mobile 里跑 npm ci）`);
      return { file: NODE, args: [TSC_BIN, ...args] };
    default:
      fail(
        `未知的可执行文件 "${exe}"，拒绝猜测如何执行：\n      ${cmd}\n` +
          '    本聚合器只认 node / tsx / tsc —— 这正是当前测试链用到的全部三种。',
      );
  }
}

// ── 命令行 ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const roots = argv.filter((a) => !a.startsWith('--'));
if (roots.length === 0) roots.push(DEFAULT_ROOT);

const unknownFlags = argv.filter((a) => a.startsWith('--') && a !== '--dry-run');
if (unknownFlags.length > 0) fail(`不认识的参数：${unknownFlags.join(' ')}`);

const scripts = loadScripts();

// 展开阶段就把全部命令解析一遍 —— 任何一条不认识的命令都应该在**执行之前**
// 报错，而不是跑了一半才炸。
const plan = [];
for (const root of roots) {
  for (const cmd of expand(root, scripts)) {
    plan.push({ cmd, root, ...resolve(cmd) });
  }
}

if (plan.length === 0) fail(`展开结果为空（roots = ${roots.join(', ')}），没有可执行的命令`);

if (dryRun) {
  for (let i = 0; i < plan.length; i += 1) {
    process.stdout.write(`${i + 1}\t${plan[i].cmd}\n`);
  }
  process.exit(0);
}

process.stdout.write(
  `\nrun-suite: ${roots.join(', ')} → ${plan.length} 条命令（串行，收集全部失败）\n`,
);

const results = [];
const suiteStart = Date.now();

for (let i = 0; i < plan.length; i += 1) {
  const p = plan[i];
  process.stdout.write(`\n── [${i + 1}/${plan.length}] ${p.cmd} ──\n`);
  const t0 = Date.now();
  const r = spawnSync(p.file, p.args, { cwd: pkgDir, stdio: 'inherit' });
  const ms = Date.now() - t0;

  let code;
  if (r.error) {
    code = -1;
    process.stderr.write(`  [X] 无法启动：${r.error.message}\n`);
  } else if (typeof r.status === 'number') {
    code = r.status;
  } else {
    // 被信号杀死（例如段错误）：没有退出码。按 shell 惯例记成 128+信号无法
    // 精确还原，这里用 -1 并单独报告信号名，避免伪装成一个普通失败码。
    code = -1;
    process.stderr.write(`  [X] 被信号终止：${r.signal}\n`);
  }
  results.push({ cmd: p.cmd, code, ms, signal: r.signal ?? null });
}

const failed = results.filter((r) => r.code !== 0);
const totalMs = Date.now() - suiteStart;
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

process.stdout.write(`\n${'═'.repeat(72)}\n`);
process.stdout.write(
  `套件汇总：${results.length} 条命令，${results.length - failed.length} 通过，${failed.length} 失败，耗时 ${secs(totalMs)}\n`,
);

if (failed.length > 0) {
  process.stdout.write(`\n失败清单（全部，不只是第一个）：\n`);
  for (const f of failed) {
    const why = f.signal ? `信号 ${f.signal}` : `退出码 ${f.code}`;
    process.stdout.write(`  FAIL  ${f.cmd}\n          ${why}，耗时 ${secs(f.ms)}\n`);
  }
  process.stdout.write(
    `\n注：旧链是 && 串联，遇到上面第一个失败就会截断，其后 ` +
      `${results.length - results.indexOf(failed[0]) - 1} 条命令的结果永远看不到。\n`,
  );
} else {
  process.stdout.write('\n全部通过。\n');
}

const typecheck = results.find((r) => /tsc\b/.test(r.cmd));
if (typecheck) {
  process.stdout.write(
    `类型检查（${typecheck.cmd}）：${typecheck.code === 0 ? '已执行且通过' : `已执行，退出码 ${typecheck.code}`}\n`,
  );
}

process.exitCode = failed.length === 0 ? 0 : 1;
