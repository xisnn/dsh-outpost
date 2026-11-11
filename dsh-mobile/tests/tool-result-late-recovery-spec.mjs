/**
 * BUG-03 第五步：turn/end 之后迟到结果的恢复、幂等与状态不倒退。
 *
 * 收尾时落「结果未确认」只是当时的诚实结论；真实结果迟到后必须能推翻它。
 * 反过来，已确认的状态不得被重复收尾、冲突结果或无 ID 结果打回未确认。
 */
import assert from 'node:assert/strict';
import { foldEvents, foldEventsIncremental, areTurnsStructurallyEqual } from '../src/core/fold/index.ts';
import { toolStatus } from '../src/core/toolStatus.ts';

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
const ev = (type, data, s) => {
  const n = s ?? ++seq;
  if (s !== undefined && s > seq) seq = s;
  return { type: 'event', event: { type, seq: n, time: 1792252500000 + n, data } };
};
const call = (callId, turn = 1, step = 1, s) =>
  ev('tool/call', { turn, step, callId, name: 'read', arguments: '{}' }, s);
const res = (callId, text, isError = false, turn = 1, s) =>
  ev('tool/result', { turn, step: 1, message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } }, s);
const end = (turn = 1, s) => ev('turn/end', { turn, reason: { kind: 'completed' } }, s);
const toolsOf = (turns) =>
  turns.flatMap((t) => t.steps.flatMap((s) => s.blocks)).filter((b) => b.kind === 'tool');
const toolIn = (turns, turnNo, callId) =>
  toolsOf(turns.filter((t) => t.turn === turnNo)).find((b) => b.callId === callId);

const newCache = () => ({
  prefixRecordCount: 0, tailStartSeq: -1, tailTurnNo: -1, lastRecordCount: 0,
  lastMaxSeq: -1, lastRecords: [], lastEvents: [], prefixTurns: [], prefixItems: [],
  lastTurns: [], lastItems: [],
});

console.log('\n=== 迟到结果必须能恢复\n');

check('L1 turn/end 后迟到成功结果 → 已确认完成', () => {
  const t = toolsOf(foldEvents([call('A'), end(), res('A', '迟到输出')]))[0];
  assert.equal(toolStatus(t), 'done');
  assert.equal(t.resultUnconfirmed, undefined);
  assert.equal(t.pending, false);
  assert.equal(t.output, '迟到输出');
});

check('L2 turn/end 后迟到失败结果 → 已确认失败（不是未确认）', () => {
  const t = toolsOf(foldEvents([call('A'), end(), res('A', 'boom', true)]))[0];
  assert.equal(toolStatus(t), 'failed');
  assert.equal(t.resultUnconfirmed, undefined);
  assert.equal(t.isError, true);
});

check('L3 迟到结果重复到达幂等', () => {
  // 显式 seq：必须是同一批事件重复传入，否则只是 seq 不同的新事件
  const c = call('A', 1, 1, 1);
  const e = end(1, 2);
  const late = res('A', '迟到输出', false, 1, 3);
  const a = foldEvents([c, e, late]);
  const b = foldEvents([c, e, late, late]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

check('L4 收尾事件 seq 大于迟到结果时按 seq 排序仍恢复', () => {
  const c = call('A', 1, 1, 1);
  const r = res('A', '输出', false, 1, 2);
  const e = end(1, 3);
  const t = toolsOf(foldEvents([e, r, c]))[0];
  assert.equal(toolStatus(t), 'done');
});

check('L5 重连补历史：先未确认，补到结果后恢复', () => {
  const c = call('A', 1, 1, 1);
  const e = end(1, 3);
  const before = toolsOf(foldEvents([c, e]))[0];
  assert.equal(toolStatus(before), 'unconfirmed');
  const after = toolsOf(foldEvents([c, res('A', '补回输出', false, 1, 2), e]))[0];
  assert.equal(toolStatus(after), 'done');
  assert.equal(after.output, '补回输出');
});

console.log('\n=== 状态不得错误倒退\n');

check('L6 重复 turn/end 不得把已确认块打回未确认', () => {
  const t = toolsOf(foldEvents([call('A'), res('A', 'ok'), end(), end(), end()]))[0];
  assert.equal(toolStatus(t), 'done');
  assert.equal(t.resultUnconfirmed, undefined);
});

check('L7 已确认失败不得被重复收尾改成未确认', () => {
  const t = toolsOf(foldEvents([call('A'), res('A', 'boom', true), end(), end()]))[0];
  assert.equal(toolStatus(t), 'failed');
});

check('L8 迟到结果恢复后再来 turn/end 仍保持已确认', () => {
  const t = toolsOf(foldEvents([call('A'), end(), res('A', 'ok'), end()]))[0];
  assert.equal(toolStatus(t), 'done');
});

check('L9 冲突的迟到结果不得清除未确认（D2）', () => {
  const turns = foldEvents([
    call('A'), call('B'), end(),
    ev('tool/result', { turn: 1, step: 1, message: { toolCallId: 'A', source: { callId: 'B' }, content: [{ type: 'text', text: '冲突' }] } }),
  ]);
  for (const t of toolsOf(turns)) assert.equal(toolStatus(t), 'unconfirmed');
});

check('L10 无 ID 的迟到结果不得清除未确认（D1）', () => {
  const turns = foldEvents([
    call('A'), end(),
    ev('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '无 ID' }] } }),
  ]);
  assert.equal(toolStatus(toolsOf(turns)[0]), 'unconfirmed');
});

check('L11 别的 turn 的迟到结果不得影响本 turn', () => {
  const turns = foldEvents([
    call('A', 1), end(1),
    call('A', 2), res('A', 'turn2 输出', false, 2), end(2),
  ]);
  assert.equal(toolStatus(toolIn(turns, 1, 'A')), 'unconfirmed');
  assert.equal(toolStatus(toolIn(turns, 2, 'A')), 'done');
});

check('L12 未确认不得倒退回「执行中」', () => {
  const turns = foldEvents([call('A'), end()]);
  const t = toolsOf(turns)[0];
  assert.equal(t.pending, true, 'pending 语义保持：确实还没收到结果');
  assert.equal(toolStatus(t), 'unconfirmed', '但展示必须是未确认，不是执行中');
  assert.equal(turns[0].running, false);
});

console.log('\n=== 增量折叠：迟到结果落在已冻结前缀里也要恢复\n');

check('L13 迟到结果追加在尾轮 → 恢复', () => {
  const cache = newCache();
  const c = call('A', 1, 1, 1);
  const e = end(1, 2);
  foldEventsIncremental([c, e], cache);
  const out = foldEventsIncremental([c, e, res('A', '迟到', false, 1, 3)], cache);
  assert.equal(toolStatus(toolsOf(out.turns)[0]), 'done');
});

check('L14 迟到结果属于已冻结的更早轮次 → 仍必须恢复', () => {
  const cache = newCache();
  const c1 = call('A', 1, 1, 1);
  const e1 = end(1, 2);
  const c2 = call('B', 2, 1, 3);
  const e2 = end(2, 4);
  const first = foldEventsIncremental([c1, e1, c2, e2], cache);
  assert.equal(toolStatus(toolIn(first.turns, 1, 'A')), 'unconfirmed');
  // 迟到结果 seq 最大，但归属 turn 1（已在前缀里）
  const late = res('A', '跨轮迟到', false, 1, 5);
  const out = foldEventsIncremental([c1, e1, c2, e2, late], cache);
  assert.equal(toolStatus(toolIn(out.turns, 1, 'A')), 'done', '前缀轮次也要被重算');
  assert.equal(toolIn(out.turns, 1, 'A').output, '跨轮迟到');
  assert.equal(toolStatus(toolIn(out.turns, 2, 'B')), 'unconfirmed', '其它轮次不受影响');
});

check('L15 增量路径下重复迟到结果幂等', () => {
  const cache = newCache();
  const c = call('A', 1, 1, 1);
  const e = end(1, 2);
  const late = res('A', '迟到', false, 1, 3);
  const a = foldEventsIncremental([c, e, late], cache);
  const b = foldEventsIncremental([c, e, late], cache);
  assert.equal(JSON.stringify(a.turns), JSON.stringify(b.turns));
});

console.log('\n=== 诊断数据的引用稳定性\n');

// 显式 seq，保证两组事件除「多一条无 ID 结果」外逐字相同，
// 否则 endedAt 会因 seq 不同而不同，测不到诊断字段本身。
const idlessLate = (s) =>
  ev('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '无 ID' }] } }, s);

check('L16 诊断变化不得复用过期 turn 对象', () => {
  const c = call('A', 1, 1, 1);
  const e = end(1, 3);
  const a = foldEvents([c, e])[0];
  const b = foldEvents([c, e, idlessLate(4)])[0];
  assert.equal(a.endedAt, b.endedAt, '前提：两组事件的收尾时间必须一致');
  assert.equal(a.unattributedResults, undefined);
  assert.equal(b.unattributedResults.length, 1);
  assert.equal(areTurnsStructurallyEqual(a, b), false, '诊断变了必须判为不等');
});

check('L17 诊断相同则仍判为相等（不破坏引用复用）', () => {
  const c = call('A', 1, 1, 1);
  const e = end(1, 3);
  const d = idlessLate(4);
  const a = foldEvents([c, e, d])[0];
  const b = foldEvents([c, e, d])[0];
  assert.equal(areTurnsStructurallyEqual(a, b), true);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);