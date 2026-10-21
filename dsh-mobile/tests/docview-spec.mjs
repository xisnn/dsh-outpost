/**
 * Markdown 解析 / docx HTML 转块 / 文件类型判断的单测。
 *
 * 这些逻辑都抽到了 core/ 下的纯 .ts 文件，可以直接 import，
 * 不用再从 .tsx 里抠函数（那样类型标注一改测试就崩）。
 */

import { readFileSync } from 'node:fs';
import { parseMarkdown, parseInline } from '../src/core/markdown.ts';
import { docxHtmlToBlocks, docKindOf, canPreviewInside } from '../src/core/docx.ts';

let pass = 0;
let fail = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
function check(n, fn) {
  try {
    const r = fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

// ── Markdown 块级 ───────────────────────────────────────────────
check('标题', () => {
  const b = parseMarkdown('# 一级\n## 二级\n### 三级');
  return b.length === 3 && b[0].kind === 'heading' && b[0].level === 1 && b[1].level === 2
    ? true
    : JSON.stringify(b);
});

check('段落保留换行', () => {
  const b = parseMarkdown('第一行\n第二行\n\n新段落');
  return b.length === 2 && b[0].kind === 'paragraph' && b[0].text.includes('\n')
    ? true
    : JSON.stringify(b);
});

check('代码块保留内容和语言', () => {
  const b = parseMarkdown('```ts\nconst a = 1;\n```');
  return b.length === 1 && b[0].kind === 'code' && b[0].lang === 'ts' && b[0].text === 'const a = 1;'
    ? true
    : JSON.stringify(b);
});

check('代码块里的 # 不当标题', () => {
  const b = parseMarkdown('```\n# 不是标题\n```');
  return b.length === 1 && b[0].kind === 'code' ? true : JSON.stringify(b);
});

check('无序列表', () => {
  const b = parseMarkdown('- a\n- b\n- c');
  return b.length === 1 && b[0].kind === 'list' && b[0].ordered === false && b[0].items.length === 3
    ? true
    : JSON.stringify(b);
});

check('有序列表', () => {
  const b = parseMarkdown('1. a\n2. b');
  return b.length === 1 && b[0].kind === 'list' && b[0].ordered === true && b[0].items.length === 2
    ? true
    : JSON.stringify(b);
});

check('引用', () => {
  const b = parseMarkdown('> 引用内容');
  return b.length === 1 && b[0].kind === 'quote' && b[0].text === '引用内容'
    ? true
    : JSON.stringify(b);
});

check('分割线', () => {
  const b = parseMarkdown('---');
  return b.length === 1 && b[0].kind === 'hr' ? true : JSON.stringify(b);
});

check('表格', () => {
  const b = parseMarkdown('| 文件 | 内容 |\n|---|---|\n| a.jpg | 身份证 |\n| b.png | 学生证 |');
  if (b.length !== 1 || b[0].kind !== 'table') return JSON.stringify(b);
  return b[0].header.length === 2 &&
    b[0].header[0] === '文件' &&
    b[0].rows.length === 2 &&
    b[0].rows[0][1] === '身份证'
    ? true
    : JSON.stringify(b);
});

check('真实 AI 回复片段能正确分块', () => {
  const text = [
    '**小说封面（唯一的）**',
    '',
    '`D:\\img\\山脚客栈.png`：1055×1491，PNG。',
    '',
    '| 文件 | 内容 |',
    '|---|---|',
    '| a.jpg | 身份证正面 |',
  ].join('\n');
  const b = parseMarkdown(text);
  const kinds = b.map((x) => x.kind);
  return kinds.includes('paragraph') && kinds.includes('table') ? true : JSON.stringify(kinds);
});

// ── Markdown 行内 ───────────────────────────────────────────────
check('加粗', () => {
  const r = parseInline('这是**重点**内容');
  return r.length === 3 && r[1].kind === 'bold' && r[1].text === '重点' ? true : JSON.stringify(r);
});

check('斜体', () => {
  const r = parseInline('这是*斜体*');
  return r.some((x) => x.kind === 'italic' && x.text === '斜体') ? true : JSON.stringify(r);
});

check('行内代码里的星号不解析', () => {
  const r = parseInline('`**不是加粗**`');
  return r.length === 1 && r[0].kind === 'code' && r[0].text === '**不是加粗**'
    ? true
    : JSON.stringify(r);
});

check('链接', () => {
  const r = parseInline('[点我](https://x.com)');
  return r.length === 1 && r[0].kind === 'link' && r[0].href === 'https://x.com'
    ? true
    : JSON.stringify(r);
});

check('多个加粗不串位', () => {
  const r = parseInline('**A** 和 **B**');
  const bolds = r.filter((x) => x.kind === 'bold').map((x) => x.text);
  return bolds.length === 2 && bolds[0] === 'A' && bolds[1] === 'B' ? true : JSON.stringify(bolds);
});

// ── docx ────────────────────────────────────────────────────────
check('docx: 标题', () => {
  const b = docxHtmlToBlocks('<h1>文档标题</h1>');
  return b.length === 1 && b[0].kind === 'heading' && b[0].text === '文档标题' ? true : JSON.stringify(b);
});

check('docx: 段落 + 内联标签清理', () => {
  const b = docxHtmlToBlocks('<p>这是<strong>加粗</strong>文字</p>');
  return b.length === 1 && b[0].kind === 'para' && b[0].text === '这是加粗文字'
    ? true
    : JSON.stringify(b);
});

check('docx: 列表', () => {
  const b = docxHtmlToBlocks('<ul><li>项目一</li><li>项目二</li></ul>');
  return b.length === 1 && b[0].kind === 'list' && b[0].items.length === 2 ? true : JSON.stringify(b);
});

check('docx: 表格', () => {
  const b = docxHtmlToBlocks('<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>');
  if (b.length !== 1 || b[0].kind !== 'table') return JSON.stringify(b);
  return b[0].rows.length === 2 && b[0].rows[0][0] === 'A' && b[0].rows[1][1] === '2'
    ? true
    : JSON.stringify(b);
});

check('docx: HTML 实体解码', () => {
  const b = docxHtmlToBlocks('<p>a &amp; b &lt;c&gt;</p>');
  return b[0].text === 'a & b <c>' ? true : JSON.stringify(b[0]);
});

check('docx: 空文档不炸', () => {
  const b = docxHtmlToBlocks('');
  return Array.isArray(b) && b.length === 0 ? true : JSON.stringify(b);
});

// ── 文件类型判断 ────────────────────────────────────────────────
check('md 走内置', () => (docKindOf('readme.md') === 'md' && docKindOf('a.markdown') === 'md' ? true : 'md 判断错'));

check('docx / xlsx / csv 走内置', () => {
  return (
    docKindOf('a.docx') === 'docx' &&
    docKindOf('b.xlsx') === 'sheet' &&
    docKindOf('c.csv') === 'sheet' &&
    docKindOf('d.xls') === 'sheet'
  );
});

check('pdf / ppt / doc 不内置（交给系统）', () => {
  return (
    docKindOf('a.pdf') === 'unsupported' &&
    docKindOf('b.pptx') === 'unsupported' &&
    docKindOf('c.doc') === 'unsupported'
  );
});

check('canPreviewInside 与 docKindOf 一致', () => {
  return (
    canPreviewInside('a.md') === true &&
    canPreviewInside('a.docx') === true &&
    canPreviewInside('a.xlsx') === true &&
    canPreviewInside('a.pdf') === false
  );
});

// ── 接入检查 ────────────────────────────────────────────────────
const card = readFileSync('src/components/FileCard.tsx', 'utf8');
check('图片点击进查看器，不再交给系统', () => {
  const i = card.indexOf('if (image) {');
  if (i < 0) return '找不到图片分支';
  return /setViewerOpen\(true\)/.test(card.slice(i, i + 120)) ? true : '图片还是走 actionViewIntent';
});

check('文档点击进内置查看器', () => (/canPreviewInside\(f\.name\)/.test(card) ? true : '没接文档查看器'));

check('ImageViewer 全屏黑底用 Modal', () => {
  const v = readFileSync('src/components/ImageViewer.tsx', 'utf8');
  return v.includes('Modal') && v.includes("backgroundColor: '#000'") ? true : '不是全屏黑底';
});

check('ImageViewer 支持缩放和下滑关闭', () => {
  const v = readFileSync('src/components/ImageViewer.tsx', 'utf8');
  return v.includes('MAX_SCALE') && v.includes('DISMISS_DISTANCE') ? true : '缺少缩放或下滑关闭';
});

check('聊天也用 Markdown 渲染', () => {
  const a = readFileSync('src/components/AssistantRichText.tsx', 'utf8');
  return /<MarkdownView/.test(a) ? true : '聊天还是纯文本（星号会露出来）';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
