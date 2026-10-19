/**
 * 回归测试：确保所有生成会话列表的代码都过滤了归档会话。
 *
 * 曾经的 bug：从工作区返回后，已删除的会话又冒出来。
 * 原因是 refreshChatMeta 里直接 `groupByWorkspace(items)`，
 * 没走 visibleSessions 过滤，而这个方法在返回/轮询/切模型时都会跑。
 *
 * 这里直接扫源码，防止以后有人再加一处忘记过滤。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'core', 'store.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  OK    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}`);
  }
}

// 所有 groupByWorkspace(...) 的调用，实参必须经过 visibleSessions
const calls = [...src.matchAll(/groupByWorkspace\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)].map((m) => m[1].trim());
check(`找到 groupByWorkspace 调用（${calls.length} 处）`, calls.length > 0);

const unfiltered = calls.filter((arg) => !arg.includes('visibleSessions'));
check(
  '每处 groupByWorkspace 都经过 visibleSessions 过滤',
  unfiltered.length === 0,
);
if (unfiltered.length > 0) {
  for (const u of unfiltered) console.log(`        未过滤的实参: ${u}`);
}

// visibleSessions 必须真的按 archived 过滤
check('visibleSessions 检查了 archived', /visibleSessions[\s\S]{0,240}archived\.has/.test(src));

// 归档后要立即刷新列表
check('archiveSession 会重算 workspaces', /archiveSession[\s\S]{0,700}groupByWorkspace/.test(src));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
