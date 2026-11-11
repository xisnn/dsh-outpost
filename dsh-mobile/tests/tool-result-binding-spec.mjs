/**
 * BUG-03 第三步：显式 ID 匹配与保守冲突处理。
 *
 * 第二方决策：
 *   D1 只有可靠、明确的工具调用 ID 才能自动绑定。禁止 FIFO / 到达顺序 /
 *      单一 pending 候选推断。
 *   D2 多个非空 ID 相互冲突时默认不绑定，不按字段优先级静默选择。
 *   D4 未归属结果不上 UI，只保留有界内部诊断，且不含工具输出。
 *
 * 真实 Host 的 ID 来源（tests/fixtures/event-samples.json 实测）：
 *   tool/call   data.callId
 *   tool/result data.message.toolCallId 与 data.message.source.callId（样本中两者相同）
 * 另兼容 fold 头部注释记录的旧字段 data.toolCallId。
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
const call = (callId, name = 'read', step = 1, turn = 1) =>
  ev('tool/call', { turn, step, callId, name, arguments: '{}' });
const result = (message, extra = {}, turn = 1, step = 1) =>
  ev('tool/result', { turn, step, message, ...extra });
const flat = (text) => [{ type: 'text', text }];
const end = (turn = 1) => ev('turn/end', { turn, reason: { kind: 'completed' } });

const toolsOf = (turns) =>
  turns.flatMap((t) => t.steps.flatMap((s) => s.blocks)).filter((b) => b.kind === 'tool');

console.log('\n=== D1：禁止无 ID 推断\n');

check('B1 无 ID 结果 + 两个无 ID 调用：都不得绑定', () => {
  const turns = foldEvents([
    call('', 'read'), call('', 'write'),
    result({ content: flat('某个工具的输出') }),
  ]);
  const ts = toolsOf(turns);
  assert.equal(ts.length, 2);
  for (const t of ts) {
    assert.equal(t.pending, true, `${t.name} 不应被绑定`);
    assert.equal(t.output, undefined);
  }
});

check('B2 无 ID 结果 + 只有一个无 ID 调用：仍不得绑定（禁止单一候选推断）', () => {
  const turns = foldEvents([call('', 'read'), result({ content: flat('输出') })]);
  const ts = toolsOf(turns);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].pending, true);
  assert.equal(ts[0].output, undefined);
});

check('B3 无 ID 结果不得新建工具块（不制造归属）', () => {
  const turns = foldEvents([call('A'), result({ content: flat('输出') })]);
  const ts = toolsOf(turns);
  assert.equal(ts.length, 1, '不应新增块');
  assert.equal(ts[0].callId, 'A');
  assert.equal(ts[0].pending, true);
});

check('B4 空串 / 非字符串 ID 字段一律视为无 ID', () => {
  for (const bad of ['', 0, false, null, {}, [], undefined]) {
    const turns = foldEvents([call('', 'read'), result({ toolCallId: bad, content: flat('输出') })]);
    const ts = toolsOf(turns);
    assert.equal(ts[0].pending, true, `ID=${JSON.stringify(bad)} 不应绑定`);
  }
});

console.log('\n=== D2：冲突默认不绑定\n');

check('B5 message.toolCallId 与 message.source.callId 冲突 → 不绑定', () => {
  const turns = foldEvents([
    call('A'), call('B'),
    result({ toolCallId: 'A', source: { callId: 'B' }, content: flat('冲突') }),
  ]);
  for (const t of toolsOf(turns)) {
    assert.equal(t.pending, true, `${t.callId} 不应被绑定`);
    assert.equal(t.output, undefined);
  }
});

check('B6 data.toolCallId 与 message.toolCallId 冲突 → 不绑定', () => {
  const turns = foldEvents([
    call('A'), call('B'),
    result({ toolCallId: 'A', content: flat('冲突') }, { toolCallId: 'B' }),
  ]);
  for (const t of toolsOf(turns)) assert.equal(t.pending, true);
});

check('B7 data.callId 与 message.toolCallId 冲突 → 不绑定', () => {
  const turns = foldEvents([
    call('A'), call('B'),
    result({ toolCallId: 'A', content: flat('冲突') }, { callId: 'B' }),
  ]);
  for (const t of toolsOf(turns)) assert.equal(t.pending, true);
});

check('B8 三方冲突 → 不绑定，且不新建块', () => {
  const turns = foldEvents([
    call('A'), call('B'),
    result({ toolCallId: 'A', source: { callId: 'B' }, content: flat('冲突') }, { toolCallId: 'C' }),
  ]);
  assert.equal(toolsOf(turns).length, 2, '不得新增第三个块');
  for (const t of toolsOf(turns)) assert.equal(t.pending, true);
});

check('B9 冲突结果不得覆盖已确认的块（状态不倒退）', () => {
  const turns = foldEvents([
    call('A'), call('B'),
    result({ toolCallId: 'A', content: flat('先前正确输出'), isError: false }),
    result({ toolCallId: 'A', source: { callId: 'B' }, content: flat('后来的冲突输出'), isError: true }),
  ]);
  const a = toolsOf(turns).find((t) => t.callId === 'A');
  assert.equal(a.output, '先前正确输出');
  assert.equal(a.isError, false);
  assert.equal(a.pending, false);
});

console.log('\n=== 正向：明确 ID 必须仍能绑定\n');

check('B10 所有来源一致 → 绑定', () => {
  const turns = foldEvents([
    call('A'),
    result({ toolCallId: 'A', source: { callId: 'A' }, content: flat('输出') }, { toolCallId: 'A', callId: 'A' }),
  ]);
  const t = toolsOf(turns)[0];
  assert.equal(t.pending, false);
  assert.equal(t.output, '输出');
});

check('B11 只有 message.toolCallId → 绑定（真实 Host 主路径）', () => {
  const turns = foldEvents([call('A'), result({ toolCallId: 'A', content: flat('输出') })]);
  assert.equal(toolsOf(turns)[0].pending, false);
});

check('B12 只有 message.source.callId → 绑定', () => {
  const turns = foldEvents([call('A'), result({ source: { callId: 'A' }, content: flat('输出') })]);
  assert.equal(toolsOf(turns)[0].pending, false);
});

check('B13 只有旧字段 data.toolCallId → 绑定（旧协议兼容）', () => {
  const turns = foldEvents([call('A'), result({ content: flat('输出') }, { toolCallId: 'A' })]);
  assert.equal(toolsOf(turns)[0].pending, false);
});

check('B14 只有 data.callId → 绑定', () => {
  const turns = foldEvents([call('A'), result({ content: flat('输出') }, { callId: 'A' })]);
  assert.equal(toolsOf(turns)[0].pending, false);
});

check('B15 明确 ID 但无对应调用 → 仍单独建块（保留既有行为）', () => {
  const turns = foldEvents([result({ toolCallId: 'Z', content: flat('孤立') })]);
  const ts = toolsOf(turns);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].callId, 'Z');
  assert.equal(ts[0].output, '孤立');
});

console.log('\n=== 归属边界：不得跨 turn，明确 ID 可跨 step\n');

check('B16 跨 turn 同 callId 严格隔离', () => {
  const turns = foldEvents([
    call('A', 'read', 1, 1), end(1),
    call('A', 'read', 1, 2), result({ toolCallId: 'A', content: flat('turn2') }, {}, 2, 1),
  ]);
  const t1 = toolsOf([turns.find((t) => t.turn === 1)])[0];
  const t2 = toolsOf([turns.find((t) => t.turn === 2)])[0];
  assert.equal(t1.pending, true, 'turn1 不得被 turn2 的结果绑定');
  assert.equal(t2.output, 'turn2');
});

check('B17 明确 ID 可回填到同 turn 的其它 step（调用真实所在 step）', () => {
  const turns = foldEvents([
    call('A', 'read', 1), call('B', 'write', 2),
    result({ toolCallId: 'A', content: flat('A 输出') }, {}, 1, 2),
  ]);
  const s1 = turns[0].steps.find((s) => s.step === 1);
  const a = s1.blocks.find((b) => b.kind === 'tool' && b.callId === 'A');
  assert.equal(a.output, 'A 输出', '按 ID 找到真实调用所在 step');
  const b = toolsOf(turns).find((t) => t.callId === 'B');
  assert.equal(b.pending, true, 'B 不得被误绑');
});

console.log('\n=== 去重与幂等不得破坏\n');

check('B18 assistant/message 的 tool-call.id 与 tool/call.callId 仍合并为 1 块', () => {
  const turns = foldEvents([
    ev('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'A', name: 'read', arguments: '{}' }] },
    }),
    call('A'),
    result({ toolCallId: 'A', content: flat('输出') }),
  ]);
  const ts = toolsOf(turns);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].pending, false);
});

check('B19 重复事件幂等（含冲突场景）', () => {
  // 必须是同一批事件对象重复传入：seq 相同才叫重复
  const events = [
    call('A'), call('B'),
    result({ toolCallId: 'A', source: { callId: 'B' }, content: flat('冲突') }),
  ];
  const a = foldEvents(events);
  const b = foldEvents([...events, ...events]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a[0].unattributedResults.length, 1, '重复不得累加诊断');
});

console.log('\n=== D4：有界内部诊断，不含工具输出\n');

check('B20 未归属结果记录诊断，且不含输出文本', () => {
  const secret = 'SENSITIVE-TOOL-OUTPUT-MARKER';
  const turns = foldEvents([call('', 'read'), result({ content: flat(secret) })]);
  const diag = turns[0].unattributedResults;
  assert.ok(Array.isArray(diag) && diag.length === 1, '应有 1 条诊断');
  assert.equal(diag[0].reason, 'missing-id');
  assert.equal(JSON.stringify(turns).includes(secret), false, '诊断不得携带工具输出');
});

check('B21 冲突诊断 reason=conflicting-id', () => {
  const turns = foldEvents([
    call('A'), call('B'),
    result({ toolCallId: 'A', source: { callId: 'B' }, content: flat('x') }),
  ]);
  const diag = turns[0].unattributedResults;
  assert.ok(Array.isArray(diag) && diag.length === 1);
  assert.equal(diag[0].reason, 'conflicting-id');
});

check('B22 诊断条目有上限（不无界增长）', () => {
  const events = [call('', 'read')];
  for (let i = 0; i < 40; i += 1) events.push(result({ content: flat('输出' + i) }));
  const turns = foldEvents(events);
  const diag = turns[0].unattributedResults ?? [];
  assert.ok(diag.length > 0 && diag.length <= 8, `诊断条数应有界，实际 ${diag.length}`);
});

check('B23 正常绑定时不产生诊断字段', () => {
  const turns = foldEvents([call('A'), result({ toolCallId: 'A', content: flat('输出') })]);
  assert.equal(turns[0].unattributedResults, undefined);
});

console.log('\n=== 结果先到、调用后到时的占位块回填\n');

check('B24 结果先建占位块，后到的调用回填真实工具名', () => {
  const r = ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'A', content: flat('输出') } });
  const c = ev('tool/call', { turn: 1, step: 1, callId: 'A', name: 'pwsh', arguments: '{"command":"ls"}' });
  // 结果 seq 更小，排序后先处理
  const turns = foldEvents([c, r]);
  const ts = toolsOf(turns);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].name, 'pwsh', '不应停留在占位名 tool');
  assert.equal(ts[0].pending, false);
  assert.equal(ts[0].output, '输出');
});

check('B25 占位块回填参数，且不覆盖已有结果', () => {
  const r = ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'A', content: flat('输出'), isError: true } });
  const c = ev('tool/call', { turn: 1, step: 1, callId: 'A', name: 'pwsh', arguments: '{"command":"ls"}' });
  const turns = foldEvents([c, r]);
  const t = toolsOf(turns)[0];
  assert.deepEqual(t.input, { command: 'ls' });
  assert.equal(t.output, '输出');
  assert.equal(t.isError, true);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);