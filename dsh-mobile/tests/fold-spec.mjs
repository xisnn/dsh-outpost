/**
 * 用真实会话事件验证 fold → ChatItem 的完整派生链路。
 *
 * 这是整个 app 最容易出错的一环：事件乱序、tool 回填、turn 归组。
 * 因此单独验证，不依赖 RN 运行时。
 */
import fs from 'node:fs';
import path from 'node:path';

// 默认用仓库自带的脱敏样本；需要跑真实数据时用 SAMPLES=... 覆盖
const SAMPLES = path.resolve(
  process.env.SAMPLES ?? path.join(import.meta.dirname, 'fixtures', 'event-samples.json'),
);
if (!fs.existsSync(SAMPLES)) {
  console.error('缺少 ' + SAMPLES);
  process.exit(1);
}

const samples = JSON.parse(fs.readFileSync(SAMPLES, 'utf8'));

// ── 直接复用 src/core/fold 的运行时等价实现 ──────────────────────
// TS 源码无法直接 import（无构建），这里用 Node 24 的 TS 支持尝试。
let foldEvents, toChatItems, isInjectedMessage;
try {
  const mod = await import('../src/core/fold/index.ts');
  foldEvents = mod.foldEvents;
  toChatItems = mod.toChatItems;
  isInjectedMessage = mod.isInjectedMessage;
  console.log('已加载 src/core/fold/index.ts（原生 TS 支持）\n');
} catch (e) {
  console.error('无法直接 import TS，请用 node --experimental-strip-types 运行');
  console.error(String(e).slice(0, 300));
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`); }
}

// ── 构造一个包含完整一轮的记录集 ─────────────────────────────────
// samples 里每种事件只有 1-2 个样本，且来自不同会话。
// 这里手工拼接一个「逻辑上完整」的会话流来验证归组。
function ev(type, seq, data, time = seq * 1000) {
  return { type: 'event', event: { type, seq, time, data } };
}

const records = [
  ev('turn/start', 1, { turn: 1 }),
  ev('step/start', 2, { turn: 1, step: 1 }),
  ev('user/message', 3, {
    content: [{ type: 'text', text: '帮我看下 workspace 结构' }],
    role: 'user',
    id: 'm1',
  }),
  ev('assistant/message', 4, {
    turn: 1, step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '用户想看目录结构，我先列一下。' },
        {
          type: 'tool-call',
          name: 'pwsh',
          callId: 'call-1',
          arguments: JSON.stringify({ command: 'Get-ChildItem' }),
        },
      ],
    },
  }),
  ev('tool/call', 5, {
    turn: 1, step: 1,
    callId: 'call-1',
    name: 'pwsh',
    arguments: JSON.stringify({ command: 'Get-ChildItem' }),
  }),
  ev('tool/result', 6, {
    turn: 1, step: 1,
    message: {
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'docs\nsrc\nprobes' }],
      isError: false,
    },
  }),
  ev('step/end', 7, { turn: 1, step: 1 }),
  ev('step/start', 8, { turn: 1, step: 2 }),
  ev('assistant/message', 9, {
    turn: 1, step: 2,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '目录里有 docs、src、probes 三个。' }],
    },
  }),
  ev('step/end', 10, { turn: 1, step: 2 }),
  ev('turn/end', 11, { turn: 1, reason: { kind: 'completed' } }),
  ev('turn/start', 12, { turn: 2 }),
  ev('step/start', 13, { turn: 2, step: 1 }),
  ev('user/message', 14, {
    content: [{ type: 'text', text: '第二步' }], role: 'user', id: 'm2',
  }),
  ev('turn/end', 15, { turn: 2, reason: { kind: 'aborted' } }),
];

console.log('=== fold 归组验证（11 个事件 → turn/step/block）\n');

const turns = foldEvents(records);

check('折叠出 2 个 turn', turns.length === 2, `${turns.length}`);
check('turn 按序排列', turns[0].turn === 1 && turns[1].turn === 2);

const t1 = turns[0];
check('turn 1 有用户消息', t1.user?.text === '帮我看下 workspace 结构', t1.user?.text);
check('turn 1 有 2 个 step', t1.steps.length === 2, `${t1.steps.length}`);
check('turn 1 已结束', t1.running === false);
check('turn 1 reason 是 completed', t1.reason === 'completed', String(t1.reason));

const step1 = t1.steps[0];
check('step 1 有 reasoning 块', step1.blocks.some(b => b.kind === 'reasoning'));
check('step 1 有 tool 块', step1.blocks.some(b => b.kind === 'tool'));

// 思考必须排在正文前面（界面上是「先想再说」）
const ri = step1.blocks.findIndex(b => b.kind === 'reasoning');
const ti = step1.blocks.findIndex(b => b.kind === 'text');
check(
  'reasoning 排在 text 之前',
  ri >= 0 && (ti < 0 || ri < ti),
  `reasoning@${ri} text@${ti}`,
);

const toolBlk = step1.blocks.find(b => b.kind === 'tool');
check('tool 块有 name', toolBlk?.name === 'pwsh', toolBlk?.name);
check('tool 块 callId 正确', toolBlk?.callId === 'call-1', toolBlk?.callId);
check('tool 块参数已解析为对象', toolBlk?.input?.command === 'Get-ChildItem', JSON.stringify(toolBlk?.input));
check('tool 结果已按 callId 回填', toolBlk?.output === 'docs\nsrc\nprobes', toolBlk?.output);
check('tool 不再是 pending', toolBlk?.pending === false);
check('tool 没有标记为错误', toolBlk?.isError === false);

const step2 = t1.steps[1];
check('step 2 有 text 块', step2.blocks.some(b => b.kind === 'text' && b.text.includes('docs')));
check('step 2 没有重复的 tool 块', !step2.blocks.some(b => b.kind === 'tool'));

const t2 = turns[1];
check('turn 2 有用户消息', t2.user?.text === '第二步');
check('turn 2 reason 是 aborted', t2.reason === 'aborted');
check('无缺失的 assistant 内容', t2.steps.every(s => s.blocks.length >= 0));

// 重复传入同一批事件应幂等
const again = foldEvents([...records, ...records]);
check('重复事件不产生重复 turn', again.length === 2, `${again.length}`);
check('重复事件不产生重复 step', again[0].steps.length === 2, `${again[0].steps.length}`);

// ── ChatItem 拍平 ─────────────────────────────────────────────────
console.log('\n=== ChatItem 拍平\n');
const items = toChatItems(turns);
// 2 user + 2 assistant + 1 divider（turn 2 是 aborted）
check('拍平出 5 个 item', items.length === 5, `${items.length}：${items.map(i => i.kind).join(',')}`);
check('含 2 个 user', items.filter(i => i.kind === 'user').length === 2);
check('含 2 个 assistant', items.filter(i => i.kind === 'assistant').length === 2);
check('第一个是 user', items[0].kind === 'user');
check('第二个是 assistant', items[1].kind === 'assistant');
check('key 唯一', new Set(items.map(i => i.key)).size === items.length);
check('aborted 的 turn 产生 divider', items.some(i => i.kind === 'divider'), 
  items.map(i => i.kind).join(','));
const divider = items.find(i => i.kind === 'divider');
check('divider 标记 aborted', divider?.reason === 'aborted', String(divider?.reason));

// ── 乱序事件 ──────────────────────────────────────────────────────
console.log('\n=== 乱序容错\n');
const shuffled = [...records].sort(() => Math.random() - 0.5);
const shuffledTurns = foldEvents(shuffled);
check('乱序输入仍得到 2 个 turn', shuffledTurns.length === 2, `${shuffledTurns.length}`);
check('乱序输入 turn 有序', shuffledTurns[0].turn < shuffledTurns[1].turn);

// ── 模式标记剥离 ──────────────────────────────────────────────────
console.log('\n=== 模式标记\n');
const { stripModeTag } = await import('../src/core/fold/index.ts');
check('剥掉计划标记', stripModeTag('帮我查天气〔模式:计划〕') === '帮我查天气');
check('剥掉闲聊标记', stripModeTag('你好〔模式:闲聊〕') === '你好');
check('无标记原样返回', stripModeTag('普通消息') === '普通消息');
check('用户正文里的〔模式〕不受影响',
  stripModeTag('什么是〔模式:计划〕这个标记') === '什么是〔模式:计划〕这个标记',
  stripModeTag('什么是〔模式:计划〕这个标记'));
check('标记后带空格也能剥',
  stripModeTag('查一下 〔模式:计划〕  ') === '查一下',
  JSON.stringify(stripModeTag('查一下 〔模式:计划〕  ')));

// ── 真实 DSH assistant/message tool-call.id 与 tool/call.callId 去重 ──
console.log('\n=== 真实 DSH tool-call.id 与 tool/call.callId 合并去重\n');
{
  const realRecords = [
    ev('turn/start', 1, { turn: 1 }, 1000),
    ev('step/start', 2, { turn: 1, step: 1 }, 1100),
    ev('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            id: 'call_574864__tsk16___eK0ASYdfAikZ6ze',
            name: 'read',
            arguments: JSON.stringify({ file_path: 'config.ts' }),
          },
        ],
      },
    }, 1200),
    ev('tool/call', 4, {
      turn: 1,
      step: 1,
      callId: 'call_574864__tsk16___eK0ASYdfAikZ6ze',
      name: 'read',
      arguments: JSON.stringify({ file_path: 'config.ts' }),
    }, 1205),
    ev('tool/result', 5, {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call_574864__tsk16___eK0ASYdfAikZ6ze',
        content: [{ type: 'text', text: 'export const port = 3095;' }],
      },
    }, 1500),
    ev('turn/end', 6, { turn: 1, reason: { kind: 'completed' } }, 1600),
  ];
  const folded = foldEvents(realRecords);
  const tools = folded[0]?.steps?.[0]?.blocks?.filter((b) => b.kind === 'tool') ?? [];
  check('assistant/message 的 id 与 tool/call 的 callId 合并为 1 个工具块', tools.length === 1, `tools=${tools.length}`);
  check('合并后的工具块已填入结果且 pending=false', tools[0]?.pending === false && tools[0]?.output === 'export const port = 3095;');
}

// goal-round-driver 的续轮提示是内部执行指令，不能显示成用户气泡。
check('goal_round 续轮提示被当作注入消息过滤', isInjectedMessage('<goal_round>\nObjective: "x"') === true);
check('普通用户消息不会被过滤', isInjectedMessage('请继续整理发布记录') === false);

// ── 完成卡：派活不等于完成，历史计数来自本轮通知 ─────────────────
console.log('\n=== 管家完成汇总投影\n');
{
  const { buildButlerWake } = await import('../src/core/butler.ts');
  const { foldEventsIncremental, createIncrementalFoldCache, stabilizeTurns, stabilizeChatItems } =
    await import('../src/core/fold/index.ts');
  const cards = (rows) => rows.filter((i) => i.kind === 'assistant' && i.completionTaskCount > 0);
  let seq = 0;
  const event = (type, data) => ev(type, ++seq, data);
  const message = (turn, step, text) => event('assistant/message', {
    turn, step, message: { content: [{ type: 'text', text }] },
  });
  const history = [
    event('turn/start', { turn: 1 }),
    event('user/message', { turn: 1, content: [{ type: 'text', text: '帮我检查项目' }] }),
    event('assistant/message', { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: '先安排检查' },
      { type: 'tool-call', id: 'spawn', name: 'spawn_teammate', arguments: '{}' },
    ] } }),
    event('tool/call', { turn: 1, step: 1, callId: 'spawn', name: 'spawn_teammate', arguments: '{}' }),
    event('tool/result', { turn: 1, message: { toolCallId: 'spawn', content: [{ type: 'text', text: 'started' }] } }),
    event('tool/call', { turn: 1, step: 2, callId: 'task', name: 'team_task_create', arguments: '{}' }),
    event('tool/result', { turn: 1, message: { toolCallId: 'task', content: [{ type: 'text', text: 'created' }] } }),
    message(1, 3, '已安排检查，结果回来再汇总。'),
    event('deliverables/presented', { turn: 1, step: 3, files: [{ path: '/tmp/plan.pdf' }] }),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const dispatchTurns = foldEvents(history);
  const dispatchItems = toChatItems(dispatchTurns);
  check('普通会话派活、多步工具和答复不产生完成卡',
    dispatchTurns[0].delegated === true && cards(dispatchItems).length === 0);
  check('派活工具去重且结果、正文、附件全部保留',
    dispatchItems.filter((i) => i.kind === 'assistant').flatMap((i) => i.blocks).length === 5 &&
    dispatchItems.some((i) => i.kind === 'assistant' && i.blocks.some((b) => b.kind === 'file')) &&
    dispatchItems.some((i) => i.kind === 'assistant' && i.blocks.some((b) => b.kind === 'tool' && b.output === 'started')));

  history.push(
    event('turn/start', { turn: 2 }),
    event('user/message', { turn: 2, content: [{ type: 'text', text: buildButlerWake(['检查源码', '运行测试']) }] }),
    message(2, 1, '我来整理结果。'),
    event('tool/call', { turn: 2, step: 2, callId: 'read', name: 'read', arguments: '{}' }),
    event('tool/result', { turn: 2, message: { toolCallId: 'read', content: [{ type: 'text', text: '报告内容' }] } }),
    message(2, 3, '检查和测试均完成，报告已附上。'),
    event('deliverables/presented', { turn: 2, step: 3, files: [{ path: '/tmp/report.pdf' }] }),
  );
  const cache = createIncrementalFoldCache();
  const running = foldEventsIncremental(history, cache);
  check('正在汇总时不宣告完成', cards(running.items).length === 0);
  history.push(event('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  const completed = foldEventsIncremental(history, cache);
  const summary = cards(completed.items);
  check('真实完成通知仅在最后汇总 step 产生一张卡，计数为本轮的两项',
    summary.length === 1 && summary[0].key === 'a-2-3' && summary[0].completionTaskCount === 2);
  check('隐藏完成通知本身，保留中间回复、工具和最终交付物',
    !completed.items.some((i) => i.kind === 'user' && i.turn === 2) &&
    completed.items.filter((i) => i.kind === 'assistant' && i.turn === 2).length === 3 &&
    summary[0].blocks.some((b) => b.kind === 'file' && b.path === '/tmp/report.pdf'));
  const full = toChatItems(foldEvents(history));
  check('增量流结束后的完成卡与全量历史投影一致', JSON.stringify(completed.items) === JSON.stringify(full));
  check('乱序重放不会重复完成卡', cards(toChatItems(foldEvents([...history].reverse().concat(history)))).length === 1);

  const aborted = foldEvents(history);
  aborted[1].reason = 'aborted';
  check('打断、报错或工具仍在等待时不宣告完成', cards(toChatItems(aborted)).length === 0);
  aborted[1].reason = 'error';
  check('失败汇总不显示绿色完成卡', cards(toChatItems(aborted)).length === 0);
  aborted[1].reason = 'completed';
  aborted[1].steps[1].blocks[0].pending = true;
  check('未收到工具结果不显示完成卡', cards(toChatItems(aborted)).length === 0);

  // 新的任务轮次不能改写旧汇总计数，也不能让旧派活轮次凭空变成完成卡。
  history.push(
    event('turn/start', { turn: 3 }),
    event('user/message', { turn: 3, content: [{ type: 'text', text: buildButlerWake(['新任务']) }] }),
    message(3, 1, '新任务也完成了。'),
    event('turn/end', { turn: 3, reason: { kind: 'completed' } }),
    event('turn/start', { turn: 4 }),
    event('user/message', { turn: 4, content: [{ type: 'text', text: '普通后续问题〔模式:计划〕' }] }),
    message(4, 1, '普通回复。'),
    event('turn/end', { turn: 4, reason: { kind: 'completed' } }),
  );
  const later = foldEventsIncremental(history, cache);
  check('后续轮次不更改旧卡计数，普通计划模式消息仍是普通回复',
    JSON.stringify(cards(later.items).map((i) => i.completionTaskCount)) === '[2,1]' &&
    !cards(later.items).some((i) => i.turn === 1 || i.turn === 4));
  const oldTurns = foldEvents(history);
  const changedTurns = foldEvents(history);
  changedTurns[1].completionTaskCount = 3;
  const oldItems = toChatItems(oldTurns);
  const changedItems = toChatItems(changedTurns);
  check('通知计数变化不会误复用旧 Turn 或汇总行引用',
    stabilizeTurns(oldTurns, changedTurns)[1] !== oldTurns[1] &&
    stabilizeChatItems(oldItems, changedItems).find((i) => i.key === 'a-2-3') !== oldItems.find((i) => i.key === 'a-2-3'));
  const noTasks = foldEvents([
    ev('turn/start', 1, { turn: 1 }),
    ev('user/message', 2, { turn: 1, content: [{ type: 'text', text: buildButlerWake([]) }] }),
    ev('assistant/message', 3, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '没有任务' }] } }),
    ev('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]);
  check('空完成通知不产生零任务完成卡', cards(toChatItems(noTasks)).length === 0);

  const chatSource = fs.readFileSync(new URL('../src/screens/ChatScreen.tsx', import.meta.url), 'utf8');
  const noticeSource = fs.readFileSync(new URL('../src/components/CompletionNotice.tsx', import.meta.url), 'utf8');
  check('完成卡仅接收管家会话本轮计数，不读取当前团队总数或输入模式',
    /doneTaskCount=\{butler && item.kind === 'assistant' \? item.completionTaskCount \?\? 0 : 0\}/.test(chatSource) &&
    !chatSource.includes('completedTaskCount') && /if \(doneTaskCount > 0 && !turnRunning\)/.test(chatSource));
  check('完成卡组件对零或无效计数保留原正文',
    /if \(!Number.isFinite\(taskCount\) \|\| taskCount <= 0\) return <>\{children\}<\/>/.test(noticeSource));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
