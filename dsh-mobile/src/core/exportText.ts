import {maskCredentials} from './credentialDisplay';

export const MAX_LOCAL_EXPORT_CHARS = 2 * 1024 * 1024;
/** Operates only on the chosen body snapshot, never on a conversation or Store. */
export function prepareTextExport(text: string, includeOriginal = false) {
  if (text.length > MAX_LOCAL_EXPORT_CHARS) throw new Error('正文过长，请选择较短的消息导出');
  if (!text.trim()) throw new Error('没有可导出的正文');
  const masked = maskCredentials(text);
  return {text: includeOriginal ? text : masked, hasCredentials: masked !== text};
}
