/**
 * Rurea C2 审批 TTL 倒计时与过期判定（纯 TS，无原生依赖，可完整单测）。
 *
 * 与原生端 ApprovalTtl 保持同一边界：`now >= expiresAt` 即判定过期，允许按钮立即禁用。
 */
import type { AgentApproval } from './agent';

export function approvalRemainingMs(
  approval: Pick<AgentApproval, 'expiresAt'> | null | undefined,
  now: number,
): number | null {
  const expiresAt = approval?.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    return null;
  }
  const remaining = expiresAt - now;
  return remaining > 0 ? remaining : 0;
}

export function isApprovalExpired(
  approval: Pick<AgentApproval, 'expiresAt'> | null | undefined,
  now: number,
): boolean {
  const remaining = approvalRemainingMs(approval, now);
  return remaining !== null && remaining <= 0;
}

export function isApprovalAllowDisabled(
  approval: Pick<AgentApproval, 'backgroundLost' | 'expiresAt'> | null | undefined,
  now: number,
): boolean {
  if (!approval) return false;
  return approval.backgroundLost === true || isApprovalExpired(approval, now);
}

export function formatApprovalCountdown(
  approval: Pick<AgentApproval, 'expiresAt'> | null | undefined,
  now: number,
): string | null {
  const remaining = approvalRemainingMs(approval, now);
  if (remaining === null) return null;
  if (remaining <= 0) return '审批已超时失效';
  const totalSec = Math.ceil(remaining / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `剩余 ${mins}:${String(secs).padStart(2, '0')} 后自动拒绝`;
}
