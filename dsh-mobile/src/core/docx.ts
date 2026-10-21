/**
 * docx → 文本块（纯逻辑，不依赖 React Native）。
 *
 * mammoth 把 docx 转成简单 HTML，这里再切成「标题 / 段落 / 列表 / 表格」
 * 几类块。不引 HTML 解析库 —— 结构简单，正则够用。
 *
 * 覆盖不到的（浮动图片、复杂样式）会退化成纯文本。
 * 对「在手机上看一眼文档内容」够用，不是做完整 Docx 渲染引擎。
 */

export type DocxBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; rows: string[][] };

const stripTags = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(strong|b|em|i|u|span)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();

/** 把 mammoth 输出的 HTML 切成块 */
export function docxHtmlToBlocks(html: string): DocxBlock[] {
  const out: DocxBlock[] = [];
  // 表格先摘出来，避免被后面的标签清理打散
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  const tables: string[] = [];
  const src = html.replace(tableRe, (m) => {
    tables.push(m);
    return `\u0000T${tables.length - 1}\u0000`;
  });

  const chunks = src.split(/(?=<h[1-6][^>]*>|<p[^>]*>|<ul[^>]*>|<ol[^>]*>)/i);
  for (const chunk of chunks) {
    const t = chunk.trim();
    if (!t) continue;

    const tIdx = /^\u0000T(\d+)\u0000$/.exec(t);
    if (tIdx) {
      const raw = tables[Number(tIdx[1])];
      const rows: string[][] = [];
      for (const tr of raw.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
        const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map((c) =>
          stripTags(c),
        );
        if (cells.length) rows.push(cells);
      }
      if (rows.length) out.push({ kind: 'table', rows });
      continue;
    }

    const h = /^<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/i.exec(t);
    if (h) {
      const text = stripTags(h[2]);
      if (text) out.push({ kind: 'heading', level: Number(h[1]), text });
      continue;
    }

    const li = t.match(/<li[^>]*>[\s\S]*?<\/li>/gi);
    if (li) {
      const items = li.map((x) => stripTags(x)).filter(Boolean);
      if (items.length) out.push({ kind: 'list', items });
      continue;
    }

    const text = stripTags(t);
    if (text) out.push({ kind: 'para', text });
  }
  return out;
}

/** 根据文件名判断用哪种查看方式 */
export type DocKind = 'md' | 'docx' | 'sheet' | 'unsupported';

export function docKindOf(name: string): DocKind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (['md', 'markdown'].includes(ext)) return 'md';
  if (ext === 'docx') return 'docx';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'sheet';
  return 'unsupported';
}

/** 这些扩展名能内置查看 */
export function canPreviewInside(name: string): boolean {
  const k = docKindOf(name);
  return k === 'md' || k === 'docx' || k === 'sheet';
}
