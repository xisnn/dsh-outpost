/**
 * BUG-03 第二步：tool/result 字段解析。
 *
 * 真实 Host 的 tool/result content 有两种形状：
 *   扁平   [{ type:'text', text }]
 *   嵌套   [{ type:'tool-result', isError, content:[{ type:'text', text }] }]
 * 嵌套形状的依据是网关 v0.10.3 自己的遍历逻辑
 * （lib/session-event-details.mjs toolResultDetails、lib/index.mjs buildWireEvent 的 preview/isError）。
 *
 * 这里用真实 fold 运行时验证，不做源码静态断言。
 */
import assert from 'node:assert/strict';
import { foldEvents } from '../src/core/fold/index.ts';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  OK    ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL  ' + name + ' — ' + (e?.message ?? String(e)));
  }
}

let seq = 0;
const ev = (type, data) => ({
  type: 'event',
  event: { type, seq: ++seq, time: 1792252500000 + seq, data },
});
const call = (callId, name = 'read') =>
  ev('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' });
const result = (message, extra = {}) =>
  ev('tool/result', { turn: 1, step: 1, message, ...extra });

const nested = (text, isError) => [
  { type: 'tool-result', toolCallId: 'placeholder', ...(isError === undefined ? {} : { isError }), content: [{ type: 'text', text }] },
];
const flat = (text) => [{ type: 'text', text }];

function onlyTool(events) {
  const turns = foldEvents(events);
  const blocks = turns.flatMap((t) => t.steps.flatMap((s) => s.blocks)).filter((b) => b.kind === 'tool');
  assert.equal(blocks.length, 1, '应只有 1 个工具块');
  return blocks[0];
}

console.log('\n=== 嵌套 tool-result content 的输出提取\n');

check('F1 嵌套 content 提取为纯文本，不是 JSON 脚手架', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: nested('真实工具输出') })]);
  assert.equal(b.output, '真实工具输出');
});

check('F2 嵌套多个 text 块按顺序拼接', () => {
  const content = [{ type: 'tool-result', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] }];
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content })]);
  assert.equal(b.output, '第一段第二段');
});

check('F3 嵌套多个 tool-result 块全部收集', () => {
  const content = [
    { type: 'tool-result', content: [{ type: 'text', text: '甲' }] },
    { type: 'tool-result', content: [{ type: 'text', text: '乙' }] },
  ];
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content })]);
  assert.equal(b.output, '甲乙');
});

check('F4 深层嵌套也能取到文本', () => {
  const content = [{ type: 'tool-result', content: [{ type: 'tool-result', content: [{ type: 'text', text: '深层' }] }] }];
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content })]);
  assert.equal(b.output, '深层');
});

console.log('\n=== 旧协议兼容（不得回归）\n');

check('F5 扁平 text 块行为逐字不变', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', isError: false, content: flat('docs\nsrc\nprobes') })]);
  assert.equal(b.output, 'docs\nsrc\nprobes');
  assert.equal(b.isError, false);
  assert.equal(b.pending, false);
});

check('F6 扁平多段 text 拼接不变', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })]);
  assert.equal(b.output, 'ab');
});

check('F7 非文本未知形状仍回退 asText（保持旧行为）', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: ['纯字符串数组'] })]);
  assert.equal(b.output, JSON.stringify(['纯字符串数组'], null, 2));
});

check('F8 content 缺失时不抛异常', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A' })]);
  assert.equal(b.pending, false);
  assert.equal(typeof b.output, 'string');
});

check('F9 空 content 数组不抛异常', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: [] })]);
  assert.equal(b.pending, false);
});

check('F10 嵌套里没有 text 块时回退，不产生 undefined', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: [{ type: 'tool-result', content: [] }] })]);
  assert.equal(typeof b.output, 'string');
});

console.log('\n=== isError 判定\n');

check('F11 嵌套块 isError=true 必须判为失败（message.isError 缺失）', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: nested('命令失败', true) })]);
  assert.equal(b.isError, true);
});

check('F12 嵌套块 isError=false 判为成功', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: nested('ok', false) })]);
  assert.equal(b.isError, false);
});

check('F13 message.isError=true 优先，即使嵌套块说 false', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', isError: true, content: nested('x', false) })]);
  assert.equal(b.isError, true);
});

check('F14 多个嵌套块只要有一个 isError=true 就是失败', () => {
  const content = [
    { type: 'tool-result', isError: false, content: [{ type: 'text', text: 'a' }] },
    { type: 'tool-result', isError: true, content: [{ type: 'text', text: 'b' }] },
  ];
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content })]);
  assert.equal(b.isError, true);
});

check('F15 data.error 存在时判为失败（与网关 isError 逻辑一致）', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', content: flat('x') }, { error: { message: 'boom' } })]);
  assert.equal(b.isError, true);
});

check('F16 isError 非布尔真值不得误判为失败', () => {
  const b = onlyTool([call('A'), result({ toolCallId: 'A', isError: 'false', content: flat('x') })]);
  assert.equal(b.isError, false);
});

check('F17 无调用记录时单独建块，也用同一套解析', () => {
  const turns = foldEvents([result({ toolCallId: 'Z', content: nested('孤立结果', true) })]);
  const blocks = turns.flatMap((t) => t.steps.flatMap((s) => s.blocks)).filter((b) => b.kind === 'tool');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].output, '孤立结果');
  assert.equal(blocks[0].isError, true);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);