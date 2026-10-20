/**
 * 从助手回复里提取本地文件引用（纯函数，不依赖 React Native，方便单测）。
 *
 * 管家做完活会用 markdown 把文件发给用户，形态例如：
 *
 *   找到了：**`D:\img\封面.png`**（1055×1491，2.4 MB）
 *   ![山脚有间客栈](D:\img\封面.png)
 *   原文路径：`D:\img\封面.png`
 *
 * 同一个文件经常出现三次（正文一次、图片语法一次、路径一次），
 * 所以要去重，只渲染一个卡片。
 */

/** markdown 图片：![alt](path) */
const IMG_RE = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
/** 行内代码里的 Windows 绝对路径：`D:\xxx` */
const CODE_PATH_RE = /`([A-Za-z]:\\[^`\n]+)`/g;

export interface FileRef {
  kind: 'file';
  /** 文件绝对路径 */
  path: string;
  /** 图片的替代文本 */
  alt?: string;
  /** 是否按图片渲染 */
  image: boolean;
}

export interface TextRef {
  kind: 'text';
  text: string;
}

export type TextSegment = TextRef | FileRef;

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(p);
}

function isLocalPath(p: string): boolean {
  // 绝对路径：盘符（E:\...）或 UNC（\\server\share）
  if (/^[A-Za-z]:\\/.test(p) || /^\\\\/.test(p)) return true;
  // 带协议前缀的（http://、file://）不是本地路径
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false;
  // 相对路径：管家有时发 cover_out/a.png 这种相对工作区的写法。
  // 只要够像一个文件名就认，交给上层用工作区路径拼成绝对路径。
  return /^[^<>|?*\\/][^<>|?*]*\.[A-Za-z0-9]{2,6}$/.test(p);
}

/** 把一段助手文本切成「普通文字」和「文件引用」片段 */
export function splitFileRefs(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  const marks: Array<{ start: number; end: number; seg: FileRef }> = [];

  // 1. markdown 图片（优先级最高，带 alt）
  for (const m of text.matchAll(IMG_RE)) {
    const path = (m[2] ?? '').trim();
    if (!isLocalPath(path)) continue;
    const start = m.index ?? 0;
    marks.push({
      start,
      end: start + m[0].length,
      seg: { kind: 'file', path, alt: m[1] || undefined, image: true },
    });
  }

  // 2. 行内代码里的路径（跳过已被图片语法覆盖的区间）
  for (const m of text.matchAll(CODE_PATH_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (marks.some((x) => start >= x.start && start < x.end)) continue;
    const path = (m[1] ?? '').trim();
    if (!isLocalPath(path)) continue;
    marks.push({ start, end, seg: { kind: 'file', path, image: isImagePath(path) } });
  }

  marks.sort((a, b) => a.start - b.start);

  // 3. 去重：同一路径只保留一个。
  //
  // 优先保留「带 alt 的 markdown 图片」—— 它信息最全。
  // 管家的回复通常长这样（同一个文件出现三次）：
  //   **`D:\img\a.png`**（尺寸…）
  //   ![标题](D:\img\a.png)
  //   原文路径：`D:\img\a.png`
  // 如果按出现顺序保留，第一条行内代码会抢占位置，图片和 alt 就丢了。
  const byPath = new Map<string, { start: number; end: number; seg: FileRef }>();
  for (const m of marks) {
    const prev = byPath.get(m.seg.path);
    if (!prev || (!prev.seg.alt && m.seg.alt)) byPath.set(m.seg.path, m);
  }
  const unique = [...byPath.values()].sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const m of unique) {
    if (m.start > cursor) {
      const chunk = text.slice(cursor, m.start);
      if (chunk.trim()) out.push({ kind: 'text', text: chunk });
    }
    out.push(m.seg);
    cursor = m.end;
  }
  if (cursor < text.length) {
    const rest = text.slice(cursor);
    if (rest.trim()) out.push({ kind: 'text', text: rest });
  }
  return out;
}
