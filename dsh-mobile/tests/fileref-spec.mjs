import { splitFileRefs, isImagePath } from '../src/core/filerefs.ts';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log('  OK    ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name);
  }
}

// 管家实际回复的形态：图片语法 + 行内代码路径，重复出现三次
const real =
  '找到了：**`D:\\img\\封面.png`**（1055x1491，2.4 MB）\n\n' +
  '![山脚有间客栈](D:\\img\\封面.png)\n\n' +
  '原文路径：`D:\\img\\封面.png`';
const segs = splitFileRefs(real);
const files = segs.filter((s) => s.kind === 'file');
check('抽出一个文件引用（去重）', files.length === 1);
check('路径正确', files[0]?.path === 'D:\\img\\封面.png');
check('识别为图片', files[0]?.image === true);
check('保留 alt 文本', files[0]?.alt === '山脚有间客栈');
check(
  '正文没有残留 markdown 图片语法',
  !segs.some((s) => s.kind === 'text' && (s.text ?? '').includes('![')),
);

// 非图片文件
const pdf = '报告在 `E:\\out\\周报.pdf` 里';
const pdfSegs = splitFileRefs(pdf).filter((s) => s.kind === 'file');
check('识别 PDF 为文件', pdfSegs.length === 1 && pdfSegs[0]?.image === false);

// 普通文本不该被误切
const plain = '没有文件路径的一段话';
check('纯文本只有一个片段', splitFileRefs(plain).length === 1);
check('纯文本片段是 text', splitFileRefs(plain)[0]?.kind === 'text');

// 相对路径（管家有时发 cover_out\/a.png）
const rel = splitFileRefs('![封面](cover_out\/封面.png)').filter(s => s.kind === 'file');
check('识别相对路径', rel.length === 1, String(rel.length));
check('相对路径正确', rel[0]?.path === 'cover_out\/封面.png', String(rel[0]?.path));

// 扩展名判断
check('png 是图片', isImagePath('a\\b.png') === true);
check('pdf 不是图片', isImagePath('a\\b.pdf') === false);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
