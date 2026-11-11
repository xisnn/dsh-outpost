/**
 * BUG-03 第四步：结果未确认语义（第二方决策 D3 设计 B）。
 *
 * 三态必须可区分：已确认完成 / 已确认失败 / 结果未确认。
 * 「结果未确认」既不等于执行失败，也不等于执行成功。
 *
 * 同时守住两条既有安全性质：
 *   · 缺失结果时不得出现「完成卡」（fold 的 completionStep 门禁）
 *   · 引用稳定化比较必须覆盖新字段，否则 UI 会复用过期对象
 */
import assert from 'node:assert/strict';
import { foldEvents, toChatItems, foldEventsIncremental } from '../src/core/fold/index.ts';
import { buildWorkGroup, workGroupSummary } from '../src/core/workGroup.ts';
import { toolStatus, TOOL_STATUS_LABEL } from '../src/core/toolStatus.ts';

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
const call = (callId, name = 'read', step = 1) =>
  ev('tool/call', { turn: 1, step, callId, name, arguments: '{}' });
const result = (callId, text, isError = false) =>
  ev('tool/result', { turn: 1, step: 1, message: { toolCallId: callId, isError, content: [{ type: 'text', text }] } });
const end = (kind = 'completed') => ev('turn/end', { turn: 1, reason: { kind } });
const toolsOf = (turns) =>
  turns.flatMap((t) => t.steps.flatMap((s) => s.blocks)).filter((b) => b.kind === 'tool');

console.log('\n=== fold：三态可区分\n');

check('U1 turn/end 后缺失结果 → resultUnconfirmed=true', () => {
  const t = toolsOf(foldEvents([call('A'), end()]))[0];
  assert.equal(t.resultUnconfirmed, true);
  assert.equal(t.output, undefined);
  assert.equal(t.isError, undefined, '不得把缺失结果标记成失败');
});

check('U2 轮次仍在进行（无 turn/end）→ 只是执行中，不是未确认', () => {
  const t = toolsOf(foldEvents([call('A')]))[0];
  assert.equal(t.pending, true);
  assert.equal(t.resultUnconfirmed, undefined);
});

check('U3 已确认完成 → 既非 pending 也非未确认', () => {
  const t = toolsOf(foldEvents([call('A'), result('A', 'ok'), end()]))[0];
  assert.equal(t.pending, false);
  assert.equal(t.resultUnconfirmed, undefined);
  assert.equal(t.isError, false);
});

check('U4 已确认失败 → isError=true，不是未确认', () => {
  const t = toolsOf(foldEvents([call('A'), result('A', 'boom', true), end()]))[0];
  assert.equal(t.isError, true);
  assert.equal(t.resultUnconfirmed, undefined);
});

check('U5 同一轮里三种状态共存且互不污染', () => {
  const ts = toolsOf(foldEvents([
    call('A'), call('B'), call('C'),
    result('A', 'ok'), result('B', 'boom', true), end(),
  ]));
  const by = Object.fromEntries(ts.map((t) => [t.callId, t]));
  assert.equal(toolStatus(by.A), 'done');
  assert.equal(toolStatus(by.B), 'failed');
  assert.equal(toolStatus(by.C), 'unconfirmed');
});

check('U6 aborted / interrupted 收尾也标记未确认（不假装成功）', () => {
  for (const kind of ['aborted', 'interrupted', 'error']) {
    const t = toolsOf(foldEvents([call('A'), end(kind)]))[0];
    assert.equal(t.resultUnconfirmed, true, `reason=${kind}`);
  }
});

console.log('\n=== 纯状态函数：ToolCard 与 WorkGroupCard 共用\n');

check('U7 toolStatus 四态映射正确', () => {
  assert.equal(toolStatus({ pending: true }), 'running');
  assert.equal(toolStatus({ pending: true, resultUnconfirmed: true }), 'unconfirmed');
  assert.equal(toolStatus({ pending: false, isError: true }), 'failed');
  assert.equal(toolStatus({ pending: false, isError: false }), 'done');
  assert.equal(toolStatus({}), 'done');
});

check('U8 未确认优先于 isError：缺失结果不得显示成失败', () => {
  assert.equal(toolStatus({ pending: true, resultUnconfirmed: true, isError: true }), 'unconfirmed');
});

check('U9 文案区分三态，未确认不复用「完成」或「失败」', () => {
  assert.equal(TOOL_STATUS_LABEL.done, '完成');
  assert.equal(TOOL_STATUS_LABEL.failed, '失败');
  assert.equal(TOOL_STATUS_LABEL.running, '执行中');
  assert.equal(TOOL_STATUS_LABEL.unconfirmed, '结果未确认');
  assert.notEqual(TOOL_STATUS_LABEL.unconfirmed, TOOL_STATUS_LABEL.done);
  assert.notEqual(TOOL_STATUS_LABEL.unconfirmed, TOOL_STATUS_LABEL.failed);
});

console.log('\n=== WorkGroup 汇总\n');

check('U10 轮次结束后未确认不再让整组永远「进行中」', () => {
  const turns = foldEvents([call('A'), call('B'), result('A', 'ok'), end()]);
  const g = buildWorkGroup(turns[0]);
  assert.equal(g.hasUnconfirmedTool, true);
  assert.equal(g.hasPendingTool, false, '未确认不算仍在执行');
  assert.equal(g.running, false);
});

check('U11 汇总区分已执行与未确认，不把缺失算作已执行', () => {
  const turns = foldEvents([call('A'), call('B'), call('C'), result('A', 'ok'), end()]);
  const s = workGroupSummary(buildWorkGroup(turns[0]));
  assert.match(s, /已执行 1 步/);
  assert.match(s, /2 步结果未确认/);
  assert.doesNotMatch(s, /已执行 3 步/);
});

check('U12 只有缺失结果时不得出现「执行失败」', () => {
  const turns = foldEvents([call('A'), call('B'), end()]);
  const g = buildWorkGroup(turns[0]);
  assert.equal(g.failed, false);
  assert.doesNotMatch(workGroupSummary(g), /执行失败/);
});

check('U13 真实失败仍报「执行失败」', () => {
  const turns = foldEvents([call('A'), call('B'), result('A', 'ok'), result('B', 'boom', true), end()]);
  const g = buildWorkGroup(turns[0]);
  assert.equal(g.failed, true);
  assert.match(workGroupSummary(g), /执行失败/);
});

check('U14 失败与未确认并存时两者都体现', () => {
  const turns = foldEvents([call('A'), call('B'), call('C'), result('A', 'boom', true), end()]);
  const s = workGroupSummary(buildWorkGroup(turns[0]));
  assert.match(s, /执行失败/);
  assert.match(s, /2 步结果未确认/);
});

check('U15 全部确认时汇总与旧行为一致（无未确认字样）', () => {
  const turns = foldEvents([call('A'), call('B'), result('A', 'ok'), result('B', 'ok'), end()]);
  const s = workGroupSummary(buildWorkGroup(turns[0]));
  assert.match(s, /已执行 2 步/);
  assert.doesNotMatch(s, /未确认/);
});

console.log('\n=== 既有安全性质不得破坏\n');

check('U16 缺失结果时不得出现完成卡', () => {
  const turns = foldEvents([
    ev('user/message', { role: 'user', content: [{ type: 'text', text: '〔管家初始化〕go' }] }),
    call('A'), call('B'), result('A', 'ok'),
    ev('user/message', { role: 'user', content: [{ type: 'text', text: '〔系统通知〕队员已经做完，请向用户汇总结果：2 个任务' }] }),
    ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '都做完了' }] } }),
    end(),
  ]);
  const items = toChatItems(turns);
  const withCompletion = items.filter((i) => (i.completionTaskCount ?? 0) > 0);
  assert.equal(withCompletion.length, 0, '存在未确认工具时不得给完成卡');
});

check('U17 引用稳定化能识别未确认状态变化（不复用过期对象）', () => {
  const cache = {
    prefixRecordCount: 0, tailStartSeq: -1, tailTurnNo: -1, lastRecordCount: 0,
    lastMaxSeq: -1, lastRecords: [], lastEvents: [], prefixTurns: [], prefixItems: [],
    lastTurns: [], lastItems: [],
  };
  const c = call('A');
  const r1 = foldEventsIncremental([c], cache);
  const r2 = foldEventsIncremental([c, end()], cache);
  const b1 = toolsOf(r1.turns)[0];
  const b2 = toolsOf(r2.turns)[0];
  assert.equal(b1.resultUnconfirmed, undefined);
  assert.equal(b2.resultUnconfirmed, true);
  assert.notEqual(b1, b2, '状态变了必须换对象，否则 UI 不刷新');
});

check('U18 状态未变时仍复用同一对象（引用稳定性不回归）', () => {
  const cache = {
    prefixRecordCount: 0, tailStartSeq: -1, tailTurnNo: -1, lastRecordCount: 0,
    lastMaxSeq: -1, lastRecords: [], lastEvents: [], prefixTurns: [], prefixItems: [],
    lastTurns: [], lastItems: [],
  };
  const events = [call('A'), result('A', 'ok'), end()];
  const r1 = foldEventsIncremental(events, cache);
  const r2 = foldEventsIncremental(events, cache);
  assert.equal(toolsOf(r1.turns)[0], toolsOf(r2.turns)[0]);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);