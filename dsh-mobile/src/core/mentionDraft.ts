/** Cursor-aware draft edits. A suggestion never sends or replaces a newer draft. */
export interface MentionRange { start: number; end: number; query: string }
export interface ComposerSelection { start: number; end: number }

export function mentionAt(text: string, selection: ComposerSelection): MentionRange | null {
  if (selection.start !== selection.end || selection.end < 0 || selection.end > text.length) return null;
  const head = text.slice(0, selection.end);
  const match = /(?:^|[\s(（])@(?:"([^"\n]*)|([^\s@"\n]*))$/u.exec(head);
  if (!match) return null;
  const marker = head.length - match[0].length + (match[0].startsWith('@') ? 0 : 1);
  const query = match[1] ?? match[2] ?? '';
  if (query.length > 500) return null;
  return {start: marker, end: selection.end, query};
}

export function insertReference(text: string, selection: ComposerSelection, mention: string, range?: MentionRange | null, maxLength = 20_000, directory = false): {text: string; selection: ComposerSelection} {
  if (!mention.startsWith('@') || /[\r\n\u0000-\u001f\u007f]/.test(mention)) throw new Error('引用格式不可用');
  const start = range?.start ?? selection.start, end = range?.end ?? selection.end;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) throw new Error('输入位置已变化，请重新选择引用');
  const separator = directory ? '' : ' ';
  const prefix = text.slice(0, start);
  const leading = !range && prefix && !/[\s(（]$/u.test(prefix) ? ' ' : '';
  const next = prefix + leading + mention + separator + text.slice(end);
  if (next.length > maxLength) throw new Error('引用后超过草稿上限，请先缩短文字');
  const caret = start + leading.length + mention.length + separator.length;
  return {text: next, selection: {start: caret, end: caret}};
}
