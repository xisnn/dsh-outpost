/**
 * 工具调用的 Diff 解析与输出预览（纯函数，可单测）。
 *
 * ## 为什么要单独一层
 *
 * 手机上看工具执行结果有两个互相矛盾的诉求：
 *   1. 卡片里要**简洁** —— 一眼能看出「改了哪个文件、加了几行删了几行」；
 *   2. 点开后要**完整** —— 长输出 / 长 diff 一个字都不能丢。
 *
 * 所以这里只负责「解析 + 截断预览」的纯计算，渲染留给 ToolCard / ToolOutputViewer：
 *   · `parseToolDiff`：从 edit / write 的入参里还原文件路径与增删行；
 *   · `buildOutputPreview`：给卡片生成预览（超出就标记 truncated，由查看器兜底）。
 *
 * ## 防御性
 *
 * 工具入参是模型生成的，**不能假设结构正确**：
 *   · 字段缺失 / 类型不对 → 返回 null，调用方回退到原始 JSON；
 *   · 超大输入 → 放弃 O(n*m) 的 LCS，退化为「公共前缀 + 公共后缀 + 中间整块」；
 *   · 超长单行 / 超长路径 → 原样保留，由展示层横向滚动，不截断内容本身。
 */

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface ToolDiff {
  /** 文件路径（可能是相对/绝对长路径，原样保留） */
  path: string;
  /** 新增行数 */
  added: number;
  /** 删除行数 */
  removed: number;
  /** 完整 diff 行（渲染层自行决定是否加行号） */
  lines: DiffLine[];
  /** 卡片预览（最多 PREVIEW_MAX_LINES 行） */
  preview: DiffLine[];
  /** 预览是否被截断（true 时卡片给「查看完整 Diff」入口） */
  truncated: boolean;
  kind: 'edit' | 'write';
}

/** 卡片里最多展示多少行 diff */
export const PREVIEW_MAX_LINES = 8;
/** 卡片里最多展示多少行输出 */
export const OUTPUT_PREVIEW_MAX_LINES = 12;
/** 卡片里最多展示多少字符输出（超长单行也要能触发查看器） */
export const OUTPUT_PREVIEW_MAX_CHARS = 1200;
/** 单边超过这么多行就放弃 LCS，走前缀/后缀近似 */
const LCS_MAX_EDGE = 400;
/** diff 总行数上限（防止模型给出几十万行的补丁把内存打爆） */
const DIFF_MAX_LINES = 4000;

function splitLines(text: string): string[] {
  if (!text) return [];
  // 统一换行符；注意不要吃掉末尾换行之外的内容
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 从入参里找文件路径：不同工具用不同字段名，按常见顺序兜底 */
function pathOf(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'path', 'filePath', 'filename', 'file']) {
    const v = asString(input[key]);
    if (v !== undefined) return v;
  }
  return '';
}

/** 对外暴露的路径提取（查看器标题栏用；任何工具都可能有 path） */
export function toolPath(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return pathOf(input as Record<string, unknown>);
}

/**
 * LCS 行级 diff。
 *
 * 只在两边都不大时使用（LCS_MAX_EDGE），否则返回 null 让调用方走近似算法。
 */
function lcsLineDiff(oldLines: string[], newLines: string[]): DiffLine[] | null {
  const n = oldLines.length;
  const m = newLines.length;
  if (n > LCS_MAX_EDGE || m > LCS_MAX_EDGE) return null;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: 'ctx', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: oldLines[i] });
      i += 1;
    } else {
      out.push({ kind: 'add', text: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: 'add', text: newLines[j] });
    j += 1;
  }
  return out;
}

/**
 * 大输入时的近似 diff：公共前缀 + 公共后缀，中间整块视为删除/新增。
 * 结果不如 LCS 精细，但不会丢内容，也不会把内存打爆。
 */
function coarseLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) out.push({ kind: 'ctx', text: oldLines[i] });
  for (let i = prefix; i < oldLines.length - suffix; i += 1) {
    out.push({ kind: 'del', text: oldLines[i] });
  }
  for (let i = prefix; i < newLines.length - suffix; i += 1) {
    out.push({ kind: 'add', text: newLines[i] });
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i += 1) {
    out.push({ kind: 'ctx', text: oldLines[i] });
  }
  return out;
}

function capDiff(lines: DiffLine[]): DiffLine[] {
  return lines.length > DIFF_MAX_LINES ? lines.slice(0, DIFF_MAX_LINES) : lines;
}

/**
 * 解析 edit / write 工具的 diff 信息。
 *
 * @returns 无法可靠解析时返回 null（调用方必须回退到原始参数展示）
 */
export function parseToolDiff(toolName: string, input: unknown): ToolDiff | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const name = (toolName || '').toLowerCase();
  const path = pathOf(o);

  if (name === 'write') {
    const content = asString(o.content);
    if (content === undefined) return null;
    const newLines = splitLines(content);
    const lines = capDiff(newLines.map((text) => ({ kind: 'add' as const, text })));
    return {
      path,
      added: lines.length,
      removed: 0,
      lines,
      preview: lines.slice(0, PREVIEW_MAX_LINES),
      truncated: lines.length > PREVIEW_MAX_LINES,
      kind: 'write',
    };
  }

  if (name === 'edit') {
    const oldText = asString(o.old_string) ?? asString(o.old_str) ?? asString(o.oldText);
    const newText = asString(o.new_string) ?? asString(o.new_str) ?? asString(o.newText);
    // 两个字段缺一个都没法可靠还原 diff → 交给原始参数展示
    if (oldText === undefined || newText === undefined) return null;

    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    const lines = capDiff(lcsLineDiff(oldLines, newLines) ?? coarseLineDiff(oldLines, newLines));
    const added = lines.filter((l) => l.kind === 'add').length;
    const removed = lines.filter((l) => l.kind === 'del').length;
    return {
      path,
      added,
      removed,
      lines,
      preview: lines.slice(0, PREVIEW_MAX_LINES),
      truncated: lines.length > PREVIEW_MAX_LINES,
      kind: 'edit',
    };
  }

  return null;
}

/** 完整 diff 的纯文本形式（查看器复制全部用；带 +/-/空格 前缀） */
export function diffToText(diff: ToolDiff): string {
  const prefix: Record<DiffLineKind, string> = { add: '+', del: '-', ctx: ' ' };
  return diff.lines.map((l) => `${prefix[l.kind]}${l.text}`).join('\n');
}

export interface OutputPreview {
  /** 卡片里展示的预览文本（末尾可能带省略标记） */
  text: string;
  /** 是否被截断（true 时卡片给「查看完整输出」） */
  truncated: boolean;
  /** 总行数（空输出为 0） */
  totalLines: number;
}

/**
 * 生成输出预览。
 *
 * ⚠️ 这里只负责**卡片预览**：真正的完整内容永远保留在 `output` 里，
 * 由 ToolOutputViewer 全量展示，不做任何截断。
 */
export function buildOutputPreview(
  output: string | undefined,
  maxLines: number = OUTPUT_PREVIEW_MAX_LINES,
  maxChars: number = OUTPUT_PREVIEW_MAX_CHARS,
  contentLabel: '输出' | '参数' = '输出',
): OutputPreview {
  const raw = output ?? '';
  if (!raw) return { text: '', truncated: false, totalLines: 0 };

  const lines = splitLines(raw);
  const totalLines = lines.length;
  let text = lines.slice(0, maxLines).join('\n');
  let truncated = totalLines > maxLines;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    // 标记本身不参与「复制」——复制入口在查看器里，取的是原始 output
    text = `${text}\n…（已省略，查看完整${contentLabel}）`;
  }
  return { text, truncated, totalLines };
}
