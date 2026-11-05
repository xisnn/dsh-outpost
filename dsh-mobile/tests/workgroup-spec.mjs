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
const foldMod = await import('../src/core/fold/index.ts');
const { foldEvents, toChatItems } = foldMod;
const copyMod = await import('../src/core/copyText.ts');
const { buildAssistantCopyText } = copyMod;
const diffMod = await import('../src/core/toolDiff.ts');
const { parseToolDiff } = diffMod;

// ── 构造 Turn 的小工具 ──────────────────────────────────────────────
const reasoning = (text, streaming = false) => ({ kind: 'reasoning', text, ...(streaming ? { streaming: true } : {}) });
const text = (t) => ({ kind: 'text', text: t });
const tool = (callId, name, extra = {}) => ({ kind: 'tool', callId, name, input: {}, ...extra });
const turn = (n, steps, extra = {}) => ({ turn: n, steps, ...extra });

console.log('\n── 基本分组 ───────────────────────────────────────────');

const runningTurn = turn(
  1,
  [
    { step: 1, blocks: [reasoning('先看看配置。'), tool('c1', 'read', { output: 'port=3095' })] },
    { step: 2, blocks: [reasoning('再跑一下检查。', true), tool('c2', 'pwsh', { pending: true })] },
  ],
  { running: true, startedAt: 1_000 },
);
const g1 = buildWorkGroup(runningTurn);

check('执行中的轮次能建组', () => (g1 ? true : '没有建组'));
check('执行中状态正确', () => (g1.running === true ? true : 'running=false'));
check('最近工具指向最后一个 tool', () =>
  g1.latestTool && g1.latestTool.callId === 'c2' ? true : 'latestTool 不对',
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
check('单个简单工具带思考也不建组（避免「已执行 1 步」冗余外框）', () =>
  buildWorkGroup(
    turn(
      31,
      [
        { step: 1, blocks: [reasoning('先读一下配置'), text('我先读配置。'), tool('c1', 'read')] },
        { step: 2, blocks: [reasoning('拿到端口了'), text('端口是 3095。')] },
      ],
      { running: false, startedAt: 1_000, endedAt: 3_000 },
    ),
  ) === null
    ? true
    : '单工具带思考仍被折叠成「已执行 1 步」',
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
    { step: 1, blocks: [reasoning('先读配置'), tool('c0', 'read', { output: 'ok' })] },
    { step: 2, blocks: [reasoning('试一下命令'), tool('c1', 'pwsh', { isError: true, output: 'boom' })] },
    { step: 3, blocks: [text('工具失败了，换个方式。')] },
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
check('展开后所有子块（思考、工具参数/输出/Diff、中间说明）均保留原生 selectable', () => {
  const thinkingSrc = readFileSync('src/components/Thinking.tsx', 'utf8');
  const toolSrc = readFileSync('src/components/ToolCard.tsx', 'utf8');
  const mdSrc = readFileSync('src/components/MarkdownView.tsx', 'utf8');
  const thinkingOk = /<Text style=\{styles\.bodyText\} selectable>/.test(thinkingSrc);
  const toolOk =
    /<Text style=\{styles\.code\} selectable>/.test(toolSrc) &&
    /<Text style=\{styles\.diffText\} numberOfLines=\{2\} selectable>/.test(toolSrc) &&
    /<Text style=\{styles\.diffPath\} numberOfLines=\{1\}[^>]*\bselectable>/.test(toolSrc);
  const mdOk = /selectable: true/.test(mdSrc);
  return thinkingOk && toolOk && mdOk ? true : '展开后存在不可选择的可见文本';
});

console.log('\n── 端到端事件流集成（单工具/多步/失败/断线恢复/复制边界） ──');

{
  let seq = 0;
  const ev = (type, data, time) => {
    seq += 1;
    return { type: 'event', event: { type, seq, time: time ?? seq * 1000, data } };
  };

  // 第 1 轮：单个简单工具调用（含思考） -> 不应折叠进 WorkGroupCard
  const turn1Events = [
    ev('turn/start', { turn: 1 }, 1_000),
    ev('user/message', { turn: 1, id: 'u1', content: [{ type: 'text', text: '看一下端口配置' }] }, 1_100),
    ev('step/start', { turn: 1, step: 1 }, 1_200),
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '先读 config.ts。' },
          { type: 'tool-call', callId: 't1-read', name: 'read', arguments: JSON.stringify({ path: 'src/config.ts' }) },
        ],
      },
    }, 1_300),
    ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 't1-read', content: [{ type: 'text', text: 'export const port = 3095;' }] } }, 1_600),
    ev('step/start', { turn: 1, step: 2 }, 1_700),
    ev('assistant/message', {
      turn: 1,
      step: 2,
      message: {
        content: [
          { type: 'reasoning', text: '已经读到端口。' },
          { type: 'text', text: '当前配置的端口是 3095。' },
        ],
      },
    }, 1_900),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2_000),
  ];

  // 第 2 轮：多步执行（read + edit + pwsh，耗时 8s） -> 折叠为「已执行 3 步 · 耗时 8 秒」
  const turn2Events = [
    ev('turn/start', { turn: 2 }, 10_000),
    ev('user/message', { turn: 2, id: 'u2', content: [{ type: 'text', text: '把端口改成 8080 并验证' }] }, 10_100),
    ev('step/start', { turn: 2, step: 1 }, 10_200),
    ev('assistant/message', {
      turn: 2,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '先读取文件确认原内容。' },
          { type: 'text', text: '我先读取并修改配置。' },
          { type: 'tool-call', callId: 't2-read', name: 'read', arguments: JSON.stringify({ path: 'src/config.ts' }) },
          {
            type: 'tool-call',
            callId: 't2-edit',
            name: 'edit',
            arguments: JSON.stringify({
              file_path: 'src/config.ts',
              old_string: 'export const port = 3095;',
              new_string: 'export const port = 8080;',
            }),
          },
        ],
      },
    }, 10_500),
    ev('tool/result', { turn: 2, step: 1, message: { toolCallId: 't2-read', content: [{ type: 'text', text: 'export const port = 3095;' }] } }, 12_000),
    ev('tool/result', { turn: 2, step: 1, message: { toolCallId: 't2-edit', content: [{ type: 'text', text: 'Edited 1 file' }] } }, 14_000),
    ev('step/start', { turn: 2, step: 2 }, 14_500),
    ev('assistant/message', {
      turn: 2,
      step: 2,
      message: {
        content: [
          { type: 'reasoning', text: '再跑一次检查脚本。' },
          { type: 'tool-call', callId: 't2-pwsh', name: 'pwsh', arguments: JSON.stringify({ command: 'npm run typecheck' }) },
        ],
      },
    }, 15_000),
    ev('tool/result', { turn: 2, step: 2, message: { toolCallId: 't2-pwsh', content: [{ type: 'text', text: 'tsc --noEmit: OK' }] } }, 17_000),
    ev('step/start', { turn: 2, step: 3 }, 17_200),
    ev('assistant/message', {
      turn: 2,
      step: 3,
      message: {
        content: [
          { type: 'reasoning', text: '全部通过，输出最终结论。' },
          { type: 'text', text: '端口已改为 8080 并通过类型检查。\n\n```ts\nexport const port = 8080;\n```' },
        ],
      },
    }, 17_800),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 18_000),
  ];

  // 第 3 轮：多步执行含工具失败（read 成功 + pwsh 失败）
  const turn3Events = [
    ev('turn/start', { turn: 3 }, 30_000),
    ev('user/message', { turn: 3, id: 'u3', content: [{ type: 'text', text: '跑一下部署脚本' }] }, 30_100),
    ev('step/start', { turn: 3, step: 1 }, 30_200),
    ev('assistant/message', {
      turn: 3,
      step: 1,
      message: {
        content: [
          { type: 'reasoning', text: '先检查脚本是否存在，再执行。' },
          { type: 'tool-call', callId: 't3-read', name: 'read', arguments: JSON.stringify({ path: 'deploy.ps1' }) },
          { type: 'tool-call', callId: 't3-pwsh', name: 'pwsh', arguments: JSON.stringify({ command: './deploy.ps1' }) },
        ],
      },
    }, 30_500),
    ev('tool/result', { turn: 3, step: 1, message: { toolCallId: 't3-read', content: [{ type: 'text', text: 'exit 1' }] } }, 32_000),
    ev('tool/result', { turn: 3, step: 1, message: { toolCallId: 't3-pwsh', content: [{ type: 'text', text: 'Error: permission denied' }], isError: true } }, 34_500),
    ev('step/start', { turn: 3, step: 2 }, 34_600),
    ev('assistant/message', {
      turn: 3,
      step: 2,
      message: { content: [{ type: 'text', text: '部署脚本因权限不足失败，请检查凭据。' }] },
    }, 34_900),
    ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, 35_000),
  ];

  const allRecords = [...turn1Events, ...turn2Events, ...turn3Events];

  // 模拟断线恢复：先拿到前一半 snapshot，断线期间漏掉中间帧，重连后通过 session/page 补齐并含乱序重复帧
  const beforeDisconnect = allRecords.slice(0, 10);
  const missedAndResent = [...allRecords.slice(8), allRecords[3], allRecords[11]];
  const recoveredTurns = foldEvents([...beforeDisconnect, ...missedAndResent]);
  const directTurns = foldEvents(allRecords);
  const wgMap = buildWorkGroupMap(recoveredTurns);

  check('集成：断线重连补齐后 fold 与分组结果和全量直连完全一致', () =>
    JSON.stringify(recoveredTurns) === JSON.stringify(directTurns) &&
    JSON.stringify([...wgMap.entries()]) === JSON.stringify([...buildWorkGroupMap(directTurns).entries()])
      ? true
      : '断线重连后状态不一致',
  );
  check('集成：第 1 轮（单工具+思考）不建组，直接展示单卡', () =>
    wgMap.has(1) === false ? true : '单工具轮次被错误建组',
  );
  check('集成：第 2 轮（3 步工具）建组且摘要为「已执行 3 步 · 耗时 8 秒」', () => {
    const g = wgMap.get(2);
    return g && workGroupSummary(g) === '已执行 3 步 · 耗时 8 秒' ? true : String(g && workGroupSummary(g));
  });
  check('集成：第 2 轮组内 edit 工具可解析出 +1/-1 Diff 预览', () => {
    const g = wgMap.get(2);
    const editItem = g?.items.find((i) => i.block.kind === 'tool' && i.block.name === 'edit');
    const diff = editItem && editItem.block.kind === 'tool' ? parseToolDiff(editItem.block.name, editItem.block.input) : null;
    return diff && diff.added === 1 && diff.removed === 1 ? true : JSON.stringify(diff);
  });
  check('集成：第 2 轮「复制全文」只复制最终回答正文（不含组内中间说明/思考/工具输出）', () => {
    const g = wgMap.get(2);
    const copied = g ? buildAssistantCopyText(g.finalBlocks) : '';
    return copied.startsWith('端口已改为 8080') && !copied.includes('我先读取并修改配置') && !copied.includes('Edited 1 file')
      ? true
      : copied;
  });
  check('集成：第 3 轮（含失败工具）摘要为「执行失败 · 已执行 2 步 · 耗时 5 秒」且最终回答独立', () => {
    const g = wgMap.get(3);
    const finalCopy = g ? buildAssistantCopyText(g.finalBlocks) : '';
    return g && g.failed && workGroupSummary(g) === '执行失败 · 已执行 2 步 · 耗时 5 秒' && finalCopy === '部署脚本因权限不足失败，请检查凭据。'
      ? true
      : JSON.stringify({ summary: g && workGroupSummary(g), finalCopy });
  });
  check('集成：toChatItems 生成的列表项与分组键对齐', () => {
    const items = toChatItems(recoveredTurns);
    const a2 = items.filter((i) => i.kind === 'assistant' && i.turn === 2);
    return a2.length === 3 && wgMap.has(2) ? true : `a2.length=${a2.length}`;
  });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
