/**
 * 复制到剪贴板的文本整形（纯函数，可单测）。
 *
 * ## 为什么要整形，而不是直接 setString
 *
 * 两个真实来源：
 *   1. **代码块**：markdown 解析出来的 `block.text` 末尾几乎总带一个换行，
 *      有时还带首尾空行。原样复制，粘到终端里会多一次回车（直接执行了），
 *      粘到编辑器里会多一行空行。
 *   2. **助手消息**：一轮回复里既有正文也有思考/工具块。整轮 toString 会把
 *      「思考过程」和工具 JSON 一起塞进剪贴板 —— 用户要的是答案，不是日志。
 *
 * 所以：只保留正文块、去掉首尾空行与行尾空白，其余（缩进、空行、换行符）
 * 一律原样保留 —— 代码的缩进和内部空行是有意义的，不能动。
 */

/**
 * 规范化待复制文本。
 *
 * - CRLF → LF（粘到跨平台终端里不会出现 `\r`）
 * - 去掉每行行尾的空白（行尾空白几乎总是编辑器/模型无意产生的）
 * - 去掉首尾的纯空行（保留正文内部的空行与首行缩进）
 */
export function normalizeCopyText(text: string): string {
  if (!text) return '';
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const noTrail = lines.map((l) => l.replace(/[ \t]+$/, ''));

  let start = 0;
  let end = noTrail.length;
  while (start < end && noTrail[start].trim() === '') start += 1;
  while (end > start && noTrail[end - 1].trim() === '') end -= 1;

  return noTrail.slice(start, end).join('\n');
}

/** 助手消息里的一块（只需要这两个字段，避免把 fold 的类型拖进纯函数） */
export interface CopyableBlock {
  kind: string;
  text?: string;
}

/**
 * 从一轮助手回复的块里拼出「复制全文」的内容。
 *
 * 只收 `kind === 'text'` 的正文块：
 *   · `reasoning`（思考）不进剪贴板 —— 用户复制的是答案
 *   · `tool`（工具调用）不进 —— 那是执行日志
 *   · `file`（交付物）不进 —— 那是文件引用，不是文本
 * 多段正文之间用空行分隔，保持段落感。
 */
export function buildAssistantCopyText(blocks: readonly CopyableBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind !== 'text') continue;
    const t = normalizeCopyText(b.text ?? '');
    if (t) parts.push(t);
  }
  return parts.join('\n\n');
}
