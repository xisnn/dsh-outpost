/**
 * Markdown 解析（纯逻辑，不依赖 React Native）。
 *
 * 单独放在这里是为了能直接单测 —— 从 .tsx 里抠函数出来测太脆，
 * 类型标注一改测试就崩（踩过）。
 */

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; rows: string[][] };

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

/** 把 markdown 切成块 */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;

  const isTableSep = (s: string) =>
    /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(s) && s.includes('-');

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push({ kind: 'code', lang, text: buf.join('\n') });
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // 标题
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'heading', level: h[1].length, text: h[2].trim() });
      i += 1;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const splitRow = (s: string) =>
        s
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push({ kind: 'table', header, rows });
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push({ kind: 'quote', text: buf.join('\n') });
      continue;
    }

    // 列表
    const listM = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listM) {
      const ordered = /\d/.test(listM[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(m[2].trim());
        i += 1;
      }
      out.push({ kind: 'list', ordered, items });
      continue;
    }

    // 段落
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (/^\s*```/.test(l)) break;
      if (/^\s*#{1,6}\s/.test(l)) break;
      if (/^\s*>\s?/.test(l)) break;
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) break;
      if (/^\s*([-*_])\1{2,}\s*$/.test(l)) break;
      if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
      buf.push(l);
      i += 1;
    }
    if (buf.length) out.push({ kind: 'paragraph', text: buf.join('\n') });
  }

  return out;
}

/** 解析行内样式 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let text = '';

  const flush = () => {
    if (text) {
      out.push({ kind: 'text', text });
      text = '';
    }
  };

  while (i < src.length) {
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ kind: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'bold', text: src.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    if (src[i] === '*' && src[i + 1] !== '*') {
      const end = src.indexOf('*', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: 'italic', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (src[i] === '[') {
      const close = src.indexOf(']', i + 1);
      if (close > i && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2);
        if (end > close) {
          flush();
          out.push({
            kind: 'link',
            text: src.slice(i + 1, close),
            href: src.slice(close + 2, end),
          });
          i = end + 1;
          continue;
        }
      }
    }

    text += src[i];
    i += 1;
  }
  flush();
  return out;
}
