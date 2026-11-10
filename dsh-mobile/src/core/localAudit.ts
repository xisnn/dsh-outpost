/**
 * 本机审批的简短审计记录（P3）。
 *
 * 审批卡在结论后从界面撤下，历史只保留「哪个任务、哪个工具、什么结论、何时」。
 * 不保存工具参数原文 —— 可能的敏感内容已经显示在审批卡上，没有再次持久化的必要。
 *
 * 与电脑审批网关的 `approvalGateway` 完全独立：那条链路有服务端权威帧，
 * 这条只是本机 UI 的可见记录，不具备任何执行效力。
 */
import type { HostLocationStorage } from './hostLocation';

export type LocalApprovalDecision = 'allowed-once' | 'rejected';

export interface LocalApprovalAuditEntry {
  taskId: string;
  toolName: string;
  decision: LocalApprovalDecision;
  at: number;
}

export const LOCAL_APPROVAL_AUDIT_KEY = '@dsh/localApprovalAudit';
export const MAX_LOCAL_AUDIT = 64;

function isEntry(value: unknown): value is LocalApprovalAuditEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.taskId === 'string' && row.taskId.startsWith('task-')
    && typeof row.toolName === 'string' && row.toolName.length > 0 && row.toolName.length <= 128
    && (row.decision === 'allowed-once' || row.decision === 'rejected')
    && typeof row.at === 'number' && Number.isFinite(row.at);
}

export function parseLocalAudit(raw: string | null): LocalApprovalAuditEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, MAX_LOCAL_AUDIT);
  } catch {
    return [];
  }
}

export async function loadLocalAudit(storage: HostLocationStorage): Promise<LocalApprovalAuditEntry[]> {
  try {
    return parseLocalAudit(await storage.getItem(LOCAL_APPROVAL_AUDIT_KEY));
  } catch {
    return [];
  }
}

export async function recordLocalAudit(
  storage: HostLocationStorage,
  entry: LocalApprovalAuditEntry,
): Promise<LocalApprovalAuditEntry[]> {
  const entries = [entry, ...await loadLocalAudit(storage)].slice(0, MAX_LOCAL_AUDIT);
  try {
    await storage.setItem(LOCAL_APPROVAL_AUDIT_KEY, JSON.stringify(entries));
  } catch {
    // The card already left the screen; a failed audit write must not block
    // the user or pretend the decision failed. Next load simply shows less.
  }
  return entries;
}

export async function clearLocalAudit(storage: HostLocationStorage): Promise<void> {
  try {
    await storage.setItem(LOCAL_APPROVAL_AUDIT_KEY, '[]');
  } catch {
    // Best effort, same as the other local derived state.
  }
}
