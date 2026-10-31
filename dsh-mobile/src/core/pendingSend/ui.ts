/**
 * PendingSendBubble 的纯 UI 规则（F-05）：
 *   · preparing / sending 的转圈延迟 600ms，避免局域网快速发送时闪烁；
 *   · 仅“确定尚未调用 prompt”或“明确未发出”的记录允许用户放弃；
 *   · unknown / accepted / sending 等结果不确定状态禁止移除，避免误导为未执行。
 */
import type { PendingSendRecord } from './types';

export const PENDING_SEND_SPINNER_DELAY_MS = 600;

/** 返回还需等待多少毫秒才显示转圈；非 preparing/sending 返回 null。 */
export function pendingSendSpinnerDelayMs(
  record: Pick<PendingSendRecord, 'state' | 'updatedAt'>,
  now: number = Date.now(),
): number | null {
  if (record.state !== 'preparing' && record.state !== 'sending') return null;
  return Math.max(0, PENDING_SEND_SPINNER_DELAY_MS - (now - record.updatedAt));
}
