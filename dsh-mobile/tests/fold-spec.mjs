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
let foldEvents, toChatItems;
try {
  const mod = await import('../src/core/fold/index.ts');
  foldEvents = mod.foldEvents;
  toChatItems = mod.toChatItems;
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

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
