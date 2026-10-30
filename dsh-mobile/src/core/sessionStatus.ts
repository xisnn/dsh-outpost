/**
 * F-07 列表状态徽标的纯派生逻辑。
 *
 * 只从真实现有数据计算：待审批来自 ApprovalGateway 的 PendingApproval；
 * 待重试复用 PendingSend 状态机的 canUserRetry，绝不按标题/运行态猜测。
 */
import { canUserRetry } from './pendingSend/state';
import type { PendingSendRecord } from './pendingSend/types';

export function approvalSessionIds(
  approvals: readonly { sessionId: string }[],
): ReadonlySet<string> {
  return new Set(approvals.map((a) => a.sessionId).filter(Boolean));
}

export function retrySessionIds(records: readonly PendingSendRecord[]): ReadonlySet<string> {
  return new Set(records.filter(canUserRetry).map((r) => r.sessionId).filter(Boolean));
}

export function anySessionInSet(
  sessions: readonly { sessionId: string }[],
  ids: ReadonlySet<string>,
): boolean {
  return sessions.some((s) => ids.has(s.sessionId));
}
