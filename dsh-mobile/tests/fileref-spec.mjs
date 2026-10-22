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

// ── 尖括号包裹的路径（v0.8.1 回归）──────────────────────────────
//
// 踩过的坑：我们在 README 里给 AI 的示例是
//   ![Description](<path/to/image.png>)
// （带尖括号，因为路径可能含空格），模型照做时也带上了尖括号，
// 而原来的正则只认不带尖括号的写法 → 整段退化成纯文本，
// 手机上显示成「!标题」，图片根本不出来。

const bracket = splitFileRefs('![山脚有间客栈](<D:\\img\\山脚客栈：雾岭茶香.png>)');
const bracketFiles = bracket.filter((s) => s.kind === 'file');
check('尖括号路径能识别', bracketFiles.length === 1, String(bracketFiles.length));
check(
  '尖括号里的路径被剥掉尖括号',
  bracketFiles[0]?.path === 'D:\\img\\山脚客栈：雾岭茶香.png',
  String(bracketFiles[0]?.path),
);
check('尖括号图片仍标记为 image', bracketFiles[0]?.image === true);
check('尖括号图片保留 alt', bracketFiles[0]?.alt === '山脚有间客栈');

const bracketSpace = splitFileRefs('![封面](<E:\\my files\\a b.png>)').filter(
  (s) => s.kind === 'file',
);
check(
  '尖括号能处理带空格的路径',
  bracketSpace.length === 1 && bracketSpace[0]?.path === 'E:\\my files\\a b.png',
  String(bracketSpace[0]?.path),
);

check(
  '尖括号图片不留 markdown 残渣',
  !bracket.some((s) => s.kind === 'text' && (s.text ?? '').includes('![')),
);

// 外链图片不该被当本地文件
const httpImg = splitFileRefs('![alt](https://example.com/a.png)');
check('http 图片不当本地文件', !httpImg.some((s) => s.kind === 'file'));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
