/**
 * 审批事件折叠测试。
 *
 * 场景：权限不是完全放开时，某个工具会触发 approval/asked。
 * 手机端没有响应通道，所以要把它暴露出来让 UI 显示横幅；
 * 一旦 approval/decided 到达（用户在电脑上点了允许/拒绝），横幅就该消失。
 */
import { foldEvents } from '../src/core/fold/index.ts';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  OK    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ` (${extra})` : ''}`);
  }
}

function ev(type, seq, data) {
  return { event: { type, seq, time: 1700000000000 + seq, data } };
}

// 一个正在等授权的 turn
const records = [
  ev('turn/start', 1, { turn: 1 }),
  ev('user/message', 2, { turn: 1, content: [{ type: 'text', text: '跑一下测试' }] }),
  ev('approval/asked', 3, {
    turn: 1,
    id: 'ap-1',
    toolName: 'bash',
    reason: '需要执行 npm test',
  }),
];

const turns = foldEvents(records);
const t1 = turns[0];
check('turn 里记录了待审批', !!t1?.approvals?.length);
check('记下了工具名', t1?.approvals?.[0]?.toolName === 'bash', String(t1?.approvals?.[0]?.toolName));
check('记下了原因', t1?.approvals?.[0]?.reason === '需要执行 npm test');

// 用户在电脑上点了允许 → 横幅应该消失
const decided = [...records, ev('approval/decided', 4, { turn: 1, id: 'ap-1', outcome: 'allowed-once' })];
const turns2 = foldEvents(decided);
check('已决的审批被过滤掉', !turns2[0]?.approvals, JSON.stringify(turns2[0]?.approvals));

// 两个并行审批：只决定一个，另一个还在等
const two = [
  ev('turn/start', 1, { turn: 1 }),
  ev('approval/asked', 2, { turn: 1, id: 'ap-a', toolName: 'bash' }),
  ev('approval/asked', 3, { turn: 1, id: 'ap-b', toolName: 'write' }),
  ev('approval/decided', 4, { turn: 1, id: 'ap-a', outcome: 'allowed-once' }),
];
const turns3 = foldEvents(two);
check('并行审批只留未决的', turns3[0]?.approvals?.length === 1, `${turns3[0]?.approvals?.length}`);
check('留下的是 ap-b', turns3[0]?.approvals?.[0]?.id === 'ap-b');

// 没有审批的正常对话不该出现 approvals 字段
const plain = [ev('turn/start', 1, { turn: 1 }), ev('user/message', 2, { turn: 1, content: '你好' })];
const turns4 = foldEvents(plain);
check('普通对话没有 approvals', !turns4[0]?.approvals);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
