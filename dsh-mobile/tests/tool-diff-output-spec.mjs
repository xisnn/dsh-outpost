/**
 * F-06 剩余功能的专项测试：工具 Diff 解析 + 输出预览 / 全屏查看器接线。
 *
 * 工具入参是模型生成的，形状并不可靠 —— 这里重点钉死「解析失败必须安全回退」
 * 和「长内容不能丢」两件事；渲染层再用少量静态检查守住入口位置。
 */

import fs from 'node:fs';

const { readFileSync } = fs;

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

const td = await import('../src/core/toolDiff.ts');
const { parseToolDiff, buildOutputPreview, diffToText, PREVIEW_MAX_LINES, OUTPUT_PREVIEW_MAX_LINES } = td;

console.log('\n── edit Diff 解析 ──────────────────────────────────────');

const editInput = {
  file_path: 'src/very/long/path/to/some/deeply/nested/module/config.ts',
  old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;',
  new_string: 'const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;',
};
const editDiff = parseToolDiff('edit', editInput);

check('edit 能解析出路径', () =>
  editDiff && editDiff.path === editInput.file_path ? true : '路径丢失',
);
check('edit 统计新增/删除行数', () =>
  editDiff && editDiff.added === 2 && editDiff.removed === 1
    ? true
    : `added=${editDiff?.added} removed=${editDiff?.removed}`,
);
check('edit 的 diff 行带 +/- 语义', () => {
  if (!editDiff) return '没有解析出 diff';
  const adds = editDiff.lines.filter((l) => l.kind === 'add').map((l) => l.text);
  const dels = editDiff.lines.filter((l) => l.kind === 'del').map((l) => l.text);
  return adds.includes('const b = 20;') && dels.includes('const b = 2;')
    ? true
    : JSON.stringify({ adds, dels });
});
check('未变化的行是 context', () => {
  const ctx = editDiff?.lines.filter((l) => l.kind === 'ctx').map((l) => l.text) ?? [];
  return ctx.includes('const a = 1;') && ctx.includes('const c = 3;') ? true : JSON.stringify(ctx);
});
check('完整 diff 文本带前缀（复制全部用）', () => {
  if (!editDiff) return '没有解析出 diff';
  const text = diffToText(editDiff);
  return text.includes('+const b = 20;') && text.includes('-const b = 2;') ? true : text;
});

console.log('\n── write Diff ─────────────────────────────────────────');

const writeDiff = parseToolDiff('write', {
  path: 'C:\\work\\demo\\a.txt',
  content: 'line1\nline2\nline3',
});
check('write 全部算新增', () =>
  writeDiff && writeDiff.added === 3 && writeDiff.removed === 0 ? true : JSON.stringify(writeDiff),
);
check('write 的路径保留反斜杠', () =>
  writeDiff?.path === 'C:\\work\\demo\\a.txt' ? true : String(writeDiff?.path),
);

console.log('\n── 无法解析 → 安全回退 ─────────────────────────────────');

check('非 edit/write 工具返回 null', () =>
  parseToolDiff('read', { path: 'a' }) === null ? true : 'read 不该出 diff',
);
check('edit 缺 old_string 返回 null', () =>
  parseToolDiff('edit', { file_path: 'a', new_string: 'x' }) === null ? true : '缺字段还解析',
);
check('edit 字段类型不对返回 null', () =>
  parseToolDiff('edit', { file_path: 'a', old_string: 1, new_string: 2 }) === null
    ? true
    : '非字符串还解析',
);
check('write 缺 content 返回 null', () =>
  parseToolDiff('write', { path: 'a' }) === null ? true : '缺 content 还解析',
);
check('input 是原始字符串（JSON 解析失败）返回 null', () =>
  parseToolDiff('edit', '{"old_string": broken') === null ? true : '原始字符串被当成对象',
);
check('input 为 null 返回 null', () => (parseToolDiff('edit', null) === null ? true : 'null 解析成功？'));

console.log('\n── 极端输入 ───────────────────────────────────────────');

check('空 old/new（纯插入/纯删除）不崩', () => {
  const ins = parseToolDiff('edit', { path: 'a', old_string: '', new_string: 'x\ny' });
  const del = parseToolDiff('edit', { path: 'a', old_string: 'x\ny', new_string: '' });
  return ins && ins.added === 2 && del && del.removed === 2 ? true : '空内容处理异常';
});
check('超长单行不丢字符', () => {
  const long = 'x'.repeat(50000);
  const d = parseToolDiff('write', { path: 'a', content: long });
  return d && d.lines[0].text.length === 50000 ? true : '长行被截断';
});
check('超长路径原样保留（不在解析层截断）', () => {
  const p = 'C:\\' + 'a\\'.repeat(500) + 'file.ts';
  const d = parseToolDiff('write', { path: p, content: 'x' });
  return d?.path === p ? true : '长路径被截断';
});
check('5000 行大文件走近似 diff 且不丢总数', () => {
  const oldLines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const newLines = [...oldLines];
  newLines[2500] = 'line changed';
  const d = parseToolDiff('edit', {
    path: 'big.ts',
    old_string: oldLines.join('\n'),
    new_string: newLines.join('\n'),
  });
  return d && d.removed === 1 && d.added === 1 ? true : `added=${d?.added} removed=${d?.removed}`;
});
check('预览不超过上限且标记 truncated', () => {
  const oldLines = Array.from({ length: 40 }, (_, i) => `old ${i}`);
  const newLines = Array.from({ length: 40 }, (_, i) => `new ${i}`);
  const d = parseToolDiff('edit', { path: 'a', old_string: oldLines.join('\n'), new_string: newLines.join('\n') });
  return d && d.preview.length <= PREVIEW_MAX_LINES && d.truncated === true
    ? true
    : `preview=${d?.preview.length} truncated=${d?.truncated}`;
});

console.log('\n── 输出预览 / 查看器触发条件 ───────────────────────────');

check('空输出 → 空预览、不截断', () => {
  const p = buildOutputPreview('');
  return p.text === '' && p.truncated === false && p.totalLines === 0 ? true : JSON.stringify(p);
});
check('undefined 输出同样安全', () => {
  const p = buildOutputPreview(undefined);
  return p.text === '' && p.truncated === false ? true : JSON.stringify(p);
});
check('短输出完整展示、不截断', () => {
  const p = buildOutputPreview('a\nb\nc');
  return p.text === 'a\nb\nc' && p.truncated === false ? true : JSON.stringify(p);
});
check('超过 12 行 → 截断并提示查看器', () => {
  const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const p = buildOutputPreview(out);
  return p.truncated === true && p.totalLines === 30 && p.text.includes('查看完整输出')
    ? true
    : JSON.stringify({ truncated: p.truncated, total: p.totalLines });
});
check('超长单行 → 按字符截断并标记', () => {
  const p = buildOutputPreview('y'.repeat(5000), OUTPUT_PREVIEW_MAX_LINES, 1200);
  return p.truncated === true && p.text.length < 1500 ? true : `len=${p.text.length}`;
});
check('预览文本不等于原文（证明交给查看器兜底）', () => {
  const out = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const p = buildOutputPreview(out);
  return p.text !== out ? true : '预览没有截断，查看器不会被触发';
});

// ── 静态接线检查 ─────────────────────────────────────────────────────
console.log('\n── UI 接线静态检查 ─────────────────────────────────────');

const cardSrc = readFileSync('src/components/ToolCard.tsx', 'utf8');
const viewerSrc = readFileSync('src/components/ToolOutputViewer.tsx', 'utf8');

check('ToolCard 在输出被截断时提供「查看完整输出」', () =>
  /outputPreview\.truncated[\s\S]{0,400}查看完整输出/.test(cardSrc)
    ? true
    : '缺少查看完整输出入口',
);
check('ToolCard 对 edit/write 渲染 Diff 预览', () =>
  /parseToolDiff\(block\.name, block\.input\)/.test(cardSrc) &&
  /diff\.preview\.map/.test(cardSrc) &&
  /diffRowAdd|diffRowDel/.test(cardSrc)
    ? true
    : '缺少 diff 预览渲染',
);
check('无法解析 Diff 时回退到原始参数', () =>
  /\{diff \? \([\s\S]*?: \([\s\S]*?参数[\s\S]*?\)\}/.test(cardSrc) ? true : '没有回退分支',
);
check('全屏查看器正文可选中', () =>
  /<Text style=\{styles\.code\} selectable>/.test(viewerSrc) &&
  /<Text style=\{styles\.diffText\} selectable>/.test(viewerSrc)
    ? true
    : '查看器正文不可选择',
);
check('复制全部只在查看器内部', () => {
  // ToolCard 里不能调用剪贴板、也不能有「复制全部」按钮（注释里提到可以）
  const cardHasCopy = /copyTextToClipboard\s*\(/.test(cardSrc) || /<Text[^>]*>复制全部/.test(cardSrc);
  const viewerHasCopy = /复制全部/.test(viewerSrc) && /copyTextToClipboard\(fullText\)/.test(viewerSrc);
  return !cardHasCopy && viewerHasCopy ? true : '复制入口位置不对';
});
check('工具箱卡片没有常驻复制按钮', () => {
  const thinkingSrc = readFileSync('src/components/Thinking.tsx', 'utf8');
  const bad = (s) => /<CopyTextButton/.test(s) || /copyTextToClipboard\s*\(/.test(s);
  return bad(thinkingSrc) || bad(cardSrc) ? 'Thinking/ToolCard 出现复制入口' : true;
});
check('查看器完整展示原输出（不受预览上限影响）', () => {
  // 查看器接收 content 原样、不做 slice；静态检查确认没有截断调用
  return /content=\{viewer === 'output' \? block\.output \?\? '' : undefined\}/.test(cardSrc) &&
    !/content\.slice|output\.slice/.test(viewerSrc)
    ? true
    : '查看器可能截断内容';
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
