import type { ButlerTask } from './butlerTasks';

export type TaskFilter = 'all' | 'attention' | 'running' | 'ended';
export const TASK_FILTERS: ReadonlyArray<{ value: TaskFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'attention', label: '待处理' },
  { value: 'running', label: '进行中' },
  { value: 'ended', label: '已结束' },
];

export const APPROVAL_STATUS_TEXT: Record<string, string> = Object.assign(Object.create(null), {
  'approval-rejected': '你已拒绝这次操作，任务已暂停。确认调整后可继续执行。',
  'approval-cancelled': '审批已取消，任务已暂停。',
  'approval-unavailable': '审批通道未能提供有效答复，任务已暂停。',
  'approval-timeout': '审批等待超过 5 分钟，当前执行已停止。确认后可继续执行。',
  'approval-interrupted': '宿主重启打断了审批，旧请求已失效。确认后可继续执行。',
});
const ERROR_SUMMARIES: Record<string, string> = Object.assign(Object.create(null), {
  'approval-rejected': '操作已拒绝，任务已暂停',
  'approval-cancelled': '审批已取消，任务已暂停',
  'approval-unavailable': '审批暂不可用，请查看详情',
  'approval-timeout': '审批已超时，任务已暂停',
  'approval-interrupted': '审批被重启打断，请查看详情',
});

export function hasTaskApproval(task: ButlerTask): boolean {
  return !!task.pendingApproval || !!task.pendingApprovals?.length;
}

export function taskBucket(task: ButlerTask): Exclude<TaskFilter, 'all'> {
  if (hasTaskApproval(task) || task.status === 'waiting_user' || task.status === 'blocked') return 'attention';
  if (task.status === 'created' || task.status === 'preparing' || task.status === 'running') return 'running';
  return 'ended';
}

export function taskFilterCounts(tasks: readonly ButlerTask[]): Record<TaskFilter, number> {
  const counts = { all: tasks.length, attention: 0, running: 0, ended: 0 };
  for (const task of tasks) counts[taskBucket(task)] += 1;
  return counts;
}

export function filterTasks(tasks: ButlerTask[], filter: TaskFilter): ButlerTask[] {
  return filter === 'all' ? tasks : tasks.filter(task => taskBucket(task) === filter);
}

/** Host revisions are monotonic: reuse unchanged rows and reject older snapshots. */
export function reconcileTasks(previous: ButlerTask[], incoming: ButlerTask[]): ButlerTask[] {
  const known = new Map(previous.map(task => [task.id, task]));
  const next = incoming.map(task => {
    const old = known.get(task.id);
    return old && old.revision >= task.revision ? old : task;
  });
  return next.length === previous.length && next.every((task, index) => task === previous[index]) ? previous : next;
}

/** Match the Host list order (newest created first), including immediate action results. */
export function upsertTask(tasks: ButlerTask[], task: ButlerTask): ButlerTask[] {
  const old = tasks.find(item => item.id === task.id);
  if (old && old.revision >= task.revision) return tasks;
  return [...tasks.filter(item => item.id !== task.id), task].sort((a, b) => b.createdAt - a.createdAt);
}

export function taskPollDelay(tasks: readonly ButlerTask[]): number {
  return tasks.some(task => taskBucket(task) === 'running' || hasTaskApproval(task)) ? 3000 : 15000;
}

export function taskListSummary(task: ButlerTask): string | null {
  const approval = task.pendingApproval ?? task.pendingApprovals?.[0];
  if (approval) return `待审批：${approval.toolName}`;
  if (task.lastError) return ERROR_SUMMARIES[task.lastError] ?? '任务遇到问题，打开详情查看原因';
  if (task.status === 'waiting_user') return '任务已暂停，等待你确认后继续';
  if (task.status === 'blocked') return '任务暂时无法继续，请查看详情';
  if (task.status === 'failed') return '执行失败，请打开会话查看原因';
  if (task.status === 'cancelled') return '任务已取消，已完成的步骤仍保留';
  return null;
}
