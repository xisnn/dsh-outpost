import type { ButlerTask, ButlerTaskStatus } from './butlerTasks';
import { normalizeButlerWorkspace } from './butlerApprovalScope';
import { taskBucket } from './butlerTaskList';

export interface ButlerActivity {
  running: number;
  waiting: number;
  completed: number;
  failed: number;
  cancelled: number;
}
const TERMINAL = new Set<ButlerTaskStatus>(['completed', 'failed', 'cancelled']);
const STATUSES = new Set<ButlerTaskStatus>(['created', 'preparing', 'running', 'waiting_user', 'blocked', ...TERMINAL]);

/** Only transitions seen in authoritative snapshots count as newly ended work. */
export class ButlerActivityTracker {
  private seen = new Map<string, { status: ButlerTaskStatus; revision: number }>();
  private ended: ButlerActivity | null = null;
  private endedUntil = 0;

  constructor(private readonly workspace: string) {}

  update(tasks: readonly ButlerTask[], now = Date.now()): ButlerActivity | null {
    if (!Array.isArray(tasks) || tasks.some(t => !t || typeof t.id !== 'string' || !t.id ||
        typeof t.cwd !== 'string' || !STATUSES.has(t.status) || !Number.isFinite(t.revision))) {
      throw new Error('Invalid butler task snapshot');
    }
    const incoming = new Map<string, ButlerTask>();
    for (const task of tasks) {
      if (normalizeButlerWorkspace(task.cwd) !== normalizeButlerWorkspace(this.workspace)) continue;
      const old = incoming.get(task.id);
      if (!old || old.revision < task.revision) incoming.set(task.id, task);
    }
    const result: ButlerActivity = { running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const task of incoming.values()) {
      const old = this.seen.get(task.id);
      // A stale response must not resurrect a task or invent a second end transition.
      if (old && old.revision > task.revision) {
        if (!TERMINAL.has(old.status)) result[old.status === 'waiting_user' || old.status === 'blocked' ? 'waiting' : 'running']++;
        continue;
      }
      const status = old && old.revision === task.revision ? old.status : task.status;
      if (TERMINAL.has(status)) {
        if (old && !TERMINAL.has(old.status) && task.revision > old.revision) {
          result[status as 'completed' | 'failed' | 'cancelled']++;
        }
      } else {
        result[taskBucket({ ...task, status }) === 'attention' ? 'waiting' : 'running']++;
      }
      this.seen.set(task.id, { status, revision: Math.max(task.revision, old?.revision ?? -1) });
    }
    if (result.running || result.waiting) {
      this.ended = null;
      return result;
    }
    if (result.completed || result.failed || result.cancelled) {
      this.ended = result;
      this.endedUntil = now + 30_000;
    }
    return now < this.endedUntil ? this.ended : null;
  }
}

/** Single-flight polling; stop invalidates both a late response and its next timer. */
export function watchButlerActivity(options: {
  workspace: string;
  list: () => Promise<ButlerTask[]>;
  publish: (value: ButlerActivity | null) => void;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}): () => void {
  const tracker = new ButlerActivityTracker(options.workspace);
  const schedule: NonNullable<typeof options.schedule> = options.schedule ?? setTimeout;
  const unschedule: NonNullable<typeof options.unschedule> = options.unschedule ?? clearTimeout;
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    let value: ButlerActivity | null = null;
    try {
      const tasks = await options.list();
      if (!alive) return;
      value = tracker.update(tasks);
    } catch {
      // A failed or missing snapshot is never evidence of completion.
    }
    if (!alive) return;
    options.publish(value);
    timer = schedule(() => { void poll(); }, value?.running || value?.waiting ? 3000 : 15000);
  };
  void poll();
  return () => {
    alive = false;
    if (timer !== undefined) unschedule(timer);
    options.publish(null);
  };
}

export function butlerActivityText(value: ButlerActivity): { title: string; body: string; ongoing: boolean } {
  if (value.waiting || value.running) return {
    title: value.waiting ? '管家需要你处理' : '管家正在执行',
    body: [value.running ? `${value.running} 项执行中` : '', value.waiting ? `${value.waiting} 项待处理` : '', '点击回到管家聊天'].filter(Boolean).join(' · '),
    ongoing: true,
  };
  return {
    title: '管家任务已更新',
    body: [value.completed ? `${value.completed} 项完成` : '', value.failed ? `${value.failed} 项失败` : '', value.cancelled ? `${value.cancelled} 项取消` : '', '点击查看'].filter(Boolean).join(' · '),
    ongoing: false,
  };
}
