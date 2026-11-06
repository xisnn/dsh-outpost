/**
 * 管家任务 API（v0.19 宿主侧 TaskApi）。
 *
 * 走 DSH 的 `/api/outpost/butler/*` Fetch 路由，不是 typed RPC；
 * 因此复用 DshConnection.request 的 Cookie/超时/轮换逻辑。
 */

import type { DshConnection } from './transport';

export type ButlerTaskStatus =
  | 'created'
  | 'preparing'
  | 'running'
  | 'waiting_user'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ButlerDeliverable {
  path: string;
  description?: string;
  relativePath?: string;
  size?: number;
  sha256?: string;
  unavailableReason?: string;
}

export interface ButlerPendingApproval {
  id: string;
  toolName: string;
  askedAt: number;
}

export interface ButlerTask {
  id: string;
  title: string;
  objective: string;
  status: ButlerTaskStatus;
  cwd: string;
  sessionId: string | null;
  goalId: string | null;
  goalRevision: number;
  goalPhase: string | null;
  maxGoalRounds: number;
  autoResume: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
  lastAssistantText: string | null;
  deliverables: ButlerDeliverable[];
  pendingApproval: ButlerPendingApproval | null;
  pendingApprovals?: ButlerPendingApproval[];
  lastError: string | null;
}

export interface NewButlerTask {
  objective: string;
  cwd: string;
  title?: string;
  maxGoalRounds?: number;
  autoResume?: boolean;
}

const BASE = '/api/outpost/butler';

export async function listButlerTasks(
  conn: DshConnection,
  status?: ButlerTaskStatus,
): Promise<ButlerTask[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await conn.request<{ tasks: ButlerTask[] }>(`${BASE}/tasks${query}`);
  if (!Array.isArray(res?.tasks)) throw new Error('Invalid butler task snapshot');
  return res.tasks;
}

export async function getButlerTask(conn: DshConnection, id: string): Promise<ButlerTask> {
  const res = await conn.request<{ task: ButlerTask }>(
    `${BASE}/tasks/get?id=${encodeURIComponent(id)}`,
  );
  return res.task;
}

export async function createButlerTask(
  conn: DshConnection,
  input: NewButlerTask,
  idempotencyKey?: string,
): Promise<ButlerTask> {
  const res = await conn.request<{ task: ButlerTask }>(`${BASE}/tasks/create`, {
    method: 'POST',
    body: input,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  });
  return res.task;
}

export async function cancelButlerTask(conn: DshConnection, id: string): Promise<ButlerTask> {
  const res = await conn.request<{ task: ButlerTask }>(`${BASE}/tasks/cancel`, {
    method: 'POST',
    body: { id },
  });
  return res.task;
}

export async function resumeButlerTask(conn: DshConnection, id: string): Promise<ButlerTask> {
  const res = await conn.request<{ task: ButlerTask }>(`${BASE}/tasks/resume`, {
    method: 'POST',
    body: { id },
  });
  return res.task;
}
