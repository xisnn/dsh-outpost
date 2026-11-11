import type { ToolBlock } from './fold';

/**
 * 工具卡状态。ToolCard 与 WorkGroupCard 共用，避免两处 ternary 走偏。
 *
 * unconfirmed 必须排在 failed 之前：轮次收尾时缺失结果的工具可能同时
 * 带着上一轮的 isError，此时诚实的说法是「结果未确认」，不是「失败」。
 */
export type ToolStatus = 'running' | 'unconfirmed' | 'failed' | 'done';

export const TOOL_STATUS_LABEL: Record<ToolStatus, string> = {
  running: '执行中',
  unconfirmed: '结果未确认',
  failed: '失败',
  done: '完成',
};

export function toolStatus(
  block: Pick<ToolBlock, 'pending' | 'isError' | 'resultUnconfirmed'>,
): ToolStatus {
  if (block.resultUnconfirmed) return 'unconfirmed';
  if (block.pending) return 'running';
  return block.isError ? 'failed' : 'done';
}