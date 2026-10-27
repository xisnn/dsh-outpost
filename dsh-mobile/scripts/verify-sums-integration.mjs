/**
 * 验证「发布侧生成的 SHA256SUMS.txt」能被**产品代码**正确解析与比对。
 *
 * ## 为什么单独做成文件而不是 workflow 里的内联 -e
 *
 * 内联脚本有两个问题：
 *   1. 需要 `--experimental-strip-types`（Node 22.6+），而本项目统一在 Node 20 上跑；
 *   2. 内联的 shell 引号转义很容易出错，且本地无法直接复现。
 *
 * 做成文件后：
 *   · 用仓库标准方式跑 TS —— `tsx`（见 package.json 里 45 个 test:* 脚本）
 *   · 本地和 CI 跑的是**同一份**代码
 *   · 能作为普通回归测试长期存在
 *
 * ## 用法
 *
 *   tsx scripts/verify-sums-integration.mjs <SHA256SUMS.txt> <apk 文件名>
 *
 * 退出码 0 = 通过；1 = 失败（并打印原因）
 */

import { readFileSync } from 'node:fs';

import {
  parseSumsFile,
  resolveExpectedHash,
  hashMatches,
} from '../src/core/update-integrity.ts';

const sumsPath = process.argv[2];
const apkName = process.argv[3] || 'dsh-outpost-verify.apk';

if (!sumsPath) {
  console.error('用法: tsx scripts/verify-sums-integration.mjs <SHA256SUMS.txt> [apk文件名]');
  process.exit(1);
}

let sums;
try {
  sums = readFileSync(sumsPath, 'utf8');
} catch (e) {
  console.error(`读不到 ${sumsPath}: ${e.message}`);
  process.exit(1);
}

let failed = 0;
const ok = (m) => console.log('  OK    ' + m);
const bad = (m) => {
  failed += 1;
  console.error('  FAIL  ' + m);
};

// ── 1. 产品解析器能读懂自己生成的 sums ──
const parsed = parseSumsFile(sums, apkName);
if (parsed) ok(`parseSumsFile 解析到哈希：${parsed.slice(0, 16)}…`);
else bad('parseSumsFile 无法解析自己生成的 SHA256SUMS.txt');

// ── 2. 来源优先级必须选中 sums（而不是退到 body 哈希）──
const resolved = resolveExpectedHash({ sumsText: sums, apkFileName: apkName });
if (resolved && resolved.source === 'sums') ok('resolveExpectedHash 选中 sums 来源');
else if (resolved) bad(`resolveExpectedHash 选中了 ${resolved.source}，应为 sums`);
else bad('resolveExpectedHash 返回 undefined');

// ── 3. 相等必须通过 ──
if (parsed && hashMatches(parsed, parsed)) ok('hashMatches：相等时通过');
else bad('hashMatches：相等时返回了 false');

// ── 4. 不等必须拒绝（否则比对毫无意义）──
if (parsed && !hashMatches('a'.repeat(64), parsed)) ok('hashMatches：不等时拒绝');
else bad('hashMatches：对错误哈希返回了 true');

// ── 5. 文件名不匹配时必须返回 undefined（不能误用别人的哈希）──
if (parseSumsFile(sums, 'some-other-file.apk') === undefined) {
  ok('文件名不匹配时返回 undefined（不会误用其它文件的哈希）');
} else {
  bad('文件名不匹配却返回了哈希');
}

console.log('');
if (failed === 0) {
  console.log('结果：更新完整性链路验证通过');
  process.exit(0);
}
console.error(`结果：${failed} 项失败`);
process.exit(1);
