import { foldEvents } from '../src/core/fold/index.ts';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  OK    " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? " (" + extra + ")" : "")); }
}
const ev = (type, seq, data) => ({ event: { type, seq, time: 1700000000000 + seq, data } });

// 管家 present 一张图片
const records = [
  ev('turn/start', 1, { turn: 1 }),
  ev('assistant/message', 2, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '图找到了' }] } }),
  ev('deliverables/presented', 3, { turn: 1, files: [{ path: 'E:\\\\work\\\\cover.png', description: '小说封面' }] }),
];
const turns = foldEvents(records);
const blocks = turns[0].steps.flatMap(s => s.blocks);
const files = blocks.filter(b => b.kind === "file");
check("抽出一个 file block", files.length === 1);
check("路径正确", files[0]?.path === "E:\\\\work\\\\cover.png", String(files[0]?.path));
check("保留了描述", files[0]?.description === "小说封面");

// 同一个文件重复 present 不该重复出现（follow 会重放事件）
const dup = [...records, ev('deliverables/presented', 4, { turn: 1, files: [{ path: 'E:\\\\work\\\\cover.png' }] })];
const dupFiles = foldEvents(dup)[0].steps.flatMap(s => s.blocks).filter(b => b.kind === "file");
check("重复 present 去重", dupFiles.length === 1, String(dupFiles.length));

// 多个文件都要收
const multi = [ev('turn/start',1,{turn:1}), ev('deliverables/presented',2,{turn:1,files:[{path:'E:\\\\a.png'},{path:'E:\\\\b.pdf'}]})];
const multiFiles = foldEvents(multi)[0].steps.flatMap(s => s.blocks).filter(b => b.kind === "file");
check("多个文件都保留", multiFiles.length === 2, String(multiFiles.length));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
