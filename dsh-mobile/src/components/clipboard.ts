/**
 * 剪贴板写入（唯一一处调用原生 Clipboard 的地方）。
 *
 * ## 为什么单独一层
 *
 * 1. **可替换**：RN 的 `Clipboard` 已从 core 标记为废弃（运行时会打
 *    deprecation warning），将来换 `@react-native-clipboard/clipboard`
 *    只改这一个文件。
 * 2. **失败可见**：`setString` 在极少数机型上会抛（剪贴板被策略禁用）。
 *    调用方需要知道「到底复制成功没有」，否则会骗用户「已复制」。
 * 3. **整形集中**：真正写进剪贴板的一定是 `normalizeCopyText` 处理过的文本，
 *    避免各调用点各写一遍「要不要去尾部换行」。
 */
import { Clipboard } from 'react-native';

import { normalizeCopyText } from '../core/copyText';

/**
 * 把文本写进系统剪贴板。
 *
 * @returns 是否真的写成功（空文本 / 原生异常都返回 false）
 */
export function copyTextToClipboard(text: string): boolean {
  const payload = normalizeCopyText(text);
  if (!payload) return false;
  try {
    Clipboard.setString(payload);
    return true;
  } catch {
    return false;
  }
}
