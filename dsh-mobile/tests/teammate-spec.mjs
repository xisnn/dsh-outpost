import { parseTeammateMessage } from '../src/core/fold/index.ts';

const cases = [
  ['Team message from weather-scout: 大连今天多云', { from: 'weather-scout', notice: false }],
  ['Team message from ui-theme-a:完成了吗', { from: 'ui-theme-a', notice: false }],
];

let pass = 0;
let fail = 0;

for (const [input, exp] of cases) {
  const got = parseTeammateMessage(input);
  const ok = got && got.from === exp.from && got.notice === exp.notice;
  if (ok) { pass += 1; console.log(`  OK    ${exp.from}`); }
  else { fail += 1; console.log(`  FAIL  ${JSON.stringify(got)}`); }
}

// subagent 完成通知
const bg = 'Background subagent 87e6f420-4b7c-4626-9cbb-1e6d18520902 finished and will do no further work unless you send it more.Its closing message:task-1 已完成';
const gotBg = parseTeammateMessage(bg);
if (gotBg && gotBg.notice === true && gotBg.from === "87e6f420") { pass += 1; console.log("  OK    subagent 完成通知"); }
else { fail += 1; console.log(`  FAIL  subagent: ${JSON.stringify(gotBg)}`); }

// 普通用户消息不该被误判
for (const plain of ['你好', '查一下天气', 'Team 是什么']) {
  if (parseTeammateMessage(plain) === null) { pass += 1; console.log(`  OK    不误判: ${plain}`); }
  else { fail += 1; console.log(`  FAIL  误判成队员消息: ${plain}`); }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
