/**
 * F-02 执行过程组专项测试。
 *
 * 纯函数部分守住「分组边界 / 不跨轮 / 不丢块 / 摘要」；
 * 渲染层用少量静态检查守住「最终回答在组外」「组内没有复制入口」。
 */
import fs from 'node:fs';

const { readFileSync } = fs;

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

const wg = await import('../src/core/workGroup.ts');
const { buildWorkGroup, buildWorkGroupMap, workGroupSummary } = wg;

// ── 构造 Turn 的小工具 ──────────────────────────────────────────────
const reasoning = (text, streaming = false) => ({ kind: 'reasoning', text, ...(streaming ? { streaming: true } : {}) });
const text = (t) => ({ kind: 'text', text: t });
const tool = (callId, name, extra = {}) => ({ kind: 'tool', callId, name, input: {}, ...extra });
const turn = (n, steps, extra = {}) => ({ turn: n, steps, ...extra });

console.log('\n── 基本分组 ───────────────────────────────────────────');

const runningTurn = turn(
  1,
  [
    { step: 1, blocks: [reasoning('先看看配置。', true), tool('c1', 'read', { pending: true })] },
  ],
  { running: true, startedAt: 1_000 },
);
const g1 = buildWorkGroup(runningTurn);

check('执行中的轮次能建组', () => (g1 ? true : '没有建组'));
check('执行中状态正确', () => (g1.running === true ? true : 'running=false'));
check('最近工具指向最后一个 tool', () =>
  g1.latestTool && g1.latestTool.callId === 'c1' ? true : 'latestTool 不对',
);
check('执行中没有最终回答', () =>
  g1.finalBlocks.length === 0 ? true : `finalBlocks=${g1.finalBlocks.length}`,
);

const doneTurn = turn(
  2,
  [
    { step: 1, blocks: [reasoning('想法一'), tool('c1', 'read'), text('说明一')] },
    { step: 2, blocks: [reasoning('想法二'), tool('c2', 'edit'), tool('c3', 'pwsh')] },
    { step: 3, blocks: [text('最终回答第一段'), text('最终回答第二段')] },
  ],
  { startedAt: 1_000, endedAt: 26_000 },
);
const g2 = buildWorkGroup(doneTurn);

check('执行完的轮次能建组', () => (g2 ? true : '没有建组'));
check('摘要为「已执行 3 步 · 耗时 25 秒」', () =>
  workGroupSummary(g2) === '已执行 3 步 · 耗时 25 秒' ? true : workGroupSummary(g2),
);
check('最终回答只取最后一个非文本块之后的块', () =>
  g2.finalBlocks.length === 2 &&
  g2.finalBlocks[0].text === '最终回答第一段' &&
  g2.finalBlocks[1].text === '最终回答第二段'
    ? true
    : JSON.stringify(g2.finalBlocks),
);
check('组内保留原始顺序（思考/工具/中间说明）', () => {
  const kinds = g2.items.map((i) => i.block.kind + ':' + (i.block.text ?? i.block.name ?? ''));
  const expected = [
    'reasoning:想法一',
    'tool:read',
    'text:说明一',
    'reasoning:想法二',
    'tool:edit',
    'tool:pwsh',
  ];
  return JSON.stringify(kinds) === JSON.stringify(expected) ? true : JSON.stringify(kinds);
});
check('不丢块：组内 + 最终回答 = 全部块', () => {
  const total =
    doneTurn.steps.reduce((n, s) => n + s.blocks.length, 0) ===
    g2.items.length + g2.finalBlocks.length;
  return total ? true : '有块丢失';
});

console.log('\n── 不该折叠的场景 ─────────────────────────────────────');

check('单个简单工具不建组（避免多层折叠）', () =>
  buildWorkGroup(turn(3, [{ step: 1, blocks: [tool('c1', 'read')] }], { running: false })) === null
    ? true
    : '单个工具被折叠了',
);
check('单段思考不建组（ThinkingAccordion 已够用）', () =>
  buildWorkGroup(turn(4, [{ step: 1, blocks: [reasoning('想一下'), text('答')] }])) === null
    ? true
    : '单段思考被折叠了',
);
check('纯文本回答不建组', () =>
  buildWorkGroup(turn(5, [{ step: 1, blocks: [text('直接回答')] }])) === null ? true : '纯文本被折叠',
);
check('空轮次返回 null', () => (buildWorkGroup(turn(6, [])) === null ? true : '空轮次建组了'));

console.log('\n── 失败 / 多轮 / 历史 ─────────────────────────────────');

const failedTurn = turn(
  7,
  [
    { step: 1, blocks: [reasoning('试一下'), tool('c1', 'pwsh', { isError: true, output: 'boom' })] },
    { step: 2, blocks: [text('工具失败了，换个方式。')] },
  ],
  { startedAt: 1_000, endedAt: 7_000 },
);
const g7 = buildWorkGroup(failedTurn);
check('工具失败标记正确', () => (g7.failed === true ? true : 'failed=false'));
check('失败摘要带「执行失败」', () =>
  workGroupSummary(g7).startsWith('执行失败') ? true : workGroupSummary(g7),
);

const t1 = turn(10, [
  { step: 1, blocks: [reasoning('A'), tool('a1', 'read'), tool('a2', 'edit')] },
  { step: 2, blocks: [text('第一轮答案')] },
]);
const t2 = turn(11, [
  { step: 1, blocks: [reasoning('B'), tool('b1', 'read'), tool('b2', 'pwsh')] },
  { step: 2, blocks: [text('第二轮答案')] },
]);
const map = buildWorkGroupMap([t1, t2]);
check('多轮各自成组，不跨轮合并', () => {
  const a = map.get(10);
  const b = map.get(11);
  const aIds = a ? a.items.filter((i) => i.block.kind === 'tool').map((i) => i.block.callId) : [];
  const bIds = b ? b.items.filter((i) => i.block.kind === 'tool').map((i) => i.block.callId) : [];
  return JSON.stringify(aIds) === '["a1","a2"]' && JSON.stringify(bIds) === '["b1","b2"]'
    ? true
    : JSON.stringify({ aIds, bIds });
});
check('断线恢复：同一轮重复构建结果一致（纯函数）', () => {
  const a = buildWorkGroup(t2);
  const b = buildWorkGroup(JSON.parse(JSON.stringify(t2)));
  return JSON.stringify(a) === JSON.stringify(b) ? true : '两次构建结果不同';
});
check('历史（已完成）轮次仍可展开（组数据完整）', () => {
  const g = buildWorkGroup(t2);
  return g && g.items.length === 3 && g.finalBlocks.length === 1 ? true : '历史组数据不完整';
});

// ── 静态接线 ─────────────────────────────────────────────────────
console.log('\n── UI 接线静态检查 ─────────────────────────────────────');

const chatSrc = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const cardSrc = readFileSync('src/components/WorkGroupCard.tsx', 'utf8');

check('ChatScreen 接入 WorkGroupCard', () =>
  /<WorkGroupCard[\s\S]{0,200}group=\{group\}/.test(chatSrc) ? true : '没有接入 WorkGroupCard',
);
check('最终回答渲染在组外', () =>
  /<WorkGroupCard[\s\S]{0,300}?\/>[\s\S]{0,500}renderBlocks\(group\.finalBlocks/.test(chatSrc)
    ? true
    : '最终回答没有单独渲染',
);
check('同轮非首个 assistant item 被跳过', () =>
  /firstAssistantKey\.get\(item\.turn\) !== item\.key\) return null/.test(chatSrc)
    ? true
    : '同轮 item 没有去重',
);
check('管家模式 / 派活轮不启用分组', () =>
  /!butler && !item\.delegated \? workGroups\.get/.test(chatSrc) ? true : '分组没有排除管家/派活',
);
check('执行过程组内没有复制按钮', () =>
  /CopyTextButton|复制全部|复制全文/.test(cardSrc) ? false : true,
);
check('组内思考用 ThinkingAccordion（保持无复制入口）', () =>
  /ThinkingAccordion/.test(cardSrc) ? true : '没有复用思考组件',
);
check('执行中显示最近工具动态', () =>
  /最近：/.test(cardSrc) && /group\.running/.test(cardSrc) ? true : '缺少运行中动态',
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
