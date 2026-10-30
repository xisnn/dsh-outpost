/**
 * F-08 连接错误横幅判定（纯函数，便于测试 3 秒延迟语义）。
 *
 * 规则：
 *   · 非终止网络错误：持续 3 秒才显示，短暂抖动不打扰用户；
 *   · 401/403 等终止态（authInvalidated=true）：立即显示，不等待；
 *   · 连接已恢复 / 无提示文案：不显示。
 */

export const CONNECTION_BANNER_DELAY_MS = 3000;

export interface ConnectionBannerInput {
  connection: string;
  hint?: string;
  terminal: boolean;
  /** 本次连续错误开始的时刻（ms）；0 表示尚未开始计时 */
  errorSince: number;
  now: number;
  delayMs?: number;
}

export function shouldShowConnectionBanner(input: ConnectionBannerInput): boolean {
  if (input.connection !== 'error' || !input.hint) return false;
  if (input.terminal) return true;
  if (!input.errorSince) return false;
  return input.now - input.errorSince >= (input.delayMs ?? CONNECTION_BANNER_DELAY_MS);
}
