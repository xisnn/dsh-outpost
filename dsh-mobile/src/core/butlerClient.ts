/**
 * ButlerClient（P3）：把管家业务调用收敛到一个按执行位置绑定的入口。
 *
 * 两个实现共享同一套 UI 语义：
 *   - DesktopButlerClient：现有电脑 Host 的 REST TaskApi；
 *   - LocalButlerClient：P2 的本机命令通道（command + receipt + reconcile）。
 *
 * 本模块不实现任务状态机、不复制队列、不自动重试。命令回执与任务状态
 * 的唯一权威在 outpost-butler；这里只做参数映射、代次绑定和错误归类。
 */
import type { ButlerTask, ButlerTaskStatus, NewButlerTask } from './butlerTasks';
import {
  LocalRuntimeClient,
  LocalRuntimeError,
  type ButlerCommandReceipt,
  type LocalCommandOperation,
} from './localRuntime';
import type { HostLocation } from './hostLocation';

export interface ButlerCapabilities {
  version: number;
  enabled: boolean;
  journalFormat?: number;
  generation?: string;
  operations?: string[];
  durableReceipts?: boolean;
  queue?: string;
  autoResume?: boolean;
  maxQueued?: number;
}

export interface LocalReconcileTask {
  id: string;
  revision: number;
  status: ButlerTaskStatus;
  queueOrder: number | null;
  authorized: boolean;
  recoveryRequired: boolean;
  unsettledWrites: Array<{ callId: string; argumentDigest: string }>;
}

export interface LocalApprovalEntry {
  id: string;
  taskId: string;
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  argumentDigest: string;
  arguments: Record<string, unknown>;
  generation: string;
  expiresAt: number;
}

export interface LocalUnresolvedReceipt {
  commandId: string;
  state: string;
  taskId?: string | null;
  operation?: string;
}

export interface LocalReconcile {
  version: number;
  generation: string;
  autoResume: boolean;
  tasks: LocalReconcileTask[];
  totalTasks: number;
  tasksTruncated: boolean;
  unresolved: LocalUnresolvedReceipt[];
  totalUnresolved: number;
  unresolvedTruncated: boolean;
  approvals: LocalApprovalEntry[];
}

export interface LocalTaskMeta {
  queueOrder: number | null;
  authorized: boolean;
  recoveryRequired: boolean;
  unsettledWrites: Array<{ callId: string; argumentDigest: string }>;
  pendingApprovalCount: number;
}

export interface ButlerTaskView extends ButlerTask {
  local?: LocalTaskMeta;
}

export interface ButlerTaskInput {
  objective: string;
  title?: string;
  maxGoalRounds?: number;
  /** 只有电脑模式使用；本机工作区由运行环境固定。 */
  cwd?: string;
  /** 电脑模式沿用现有设置；本机模式强制 false。 */
  autoResume?: boolean;
}

export interface ButlerApprovalDecision {
  approvalId: string;
  decision: 'allowed-once' | 'rejected';
}

export class ButlerClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ButlerClientError';
  }
}

/**
 * 命令已送达，但结果未知（accepted/unknown）。
 *
 * 调用方必须保留 commandId，先查询回执或核对文件，**不得**用新 commandId
 * 重发同一次操作，也不得把异常当作「没有执行」。
 */
export class ButlerReceiptUnknown extends ButlerClientError {
  constructor(readonly commandId: string, readonly receipt: ButlerCommandReceipt) {
    super('effect-unconfirmed');
    this.name = 'ButlerReceiptUnknown';
  }
}

export interface ButlerClient {
  readonly location: HostLocation;
  list(): Promise<ButlerTaskView[]>;
  detail(id: string): Promise<ButlerTaskView>;
  create(input: ButlerTaskInput, commandId: string): Promise<ButlerTaskView>;
  enqueue(input: ButlerTaskInput, commandId: string): Promise<ButlerTaskView>;
  cancel(id: string): Promise<ButlerTaskView>;
  resume(id: string): Promise<ButlerTaskView>;
  interrupt(id: string): Promise<ButlerTaskView>;
  capabilities(): Promise<ButlerCapabilities>;
  reconcile(): Promise<LocalReconcile>;
  approve(input: ButlerApprovalDecision): Promise<ButlerCommandReceipt>;
  receipt(commandId: string): Promise<ButlerCommandReceipt | null>;
}

export interface DesktopTaskStore {
  listButlerTasks(): Promise<ButlerTask[]>;
  getButlerTask(id: string): Promise<ButlerTask>;
  createButlerTask(input: NewButlerTask, idempotencyKey?: string): Promise<ButlerTask>;
  cancelButlerTask(id: string): Promise<ButlerTask>;
  resumeButlerTask(id: string): Promise<ButlerTask>;
}

const STATUSES: ReadonlySet<string> = new Set([
  'created', 'preparing', 'running', 'waiting_user', 'blocked', 'completed', 'failed', 'cancelled',
]);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function newButlerCommandId(prefix: string): string {
  const value = `local-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}

function taskStatus(value: unknown): ButlerTaskStatus {
  if (typeof value !== 'string' || !STATUSES.has(value)) throw new ButlerClientError('invalid-task');
  return value as ButlerTaskStatus;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function localMeta(
  value: Record<string, unknown>,
  pendingApprovalCount: number,
): LocalTaskMeta {
  return {
    queueOrder: typeof value.queueOrder === 'number' ? value.queueOrder : null,
    authorized: value.authorized === true,
    recoveryRequired: value.recoveryRequired === true,
    unsettledWrites: Array.isArray(value.unsettledWrites)
      ? (value.unsettledWrites as Array<{ callId: string; argumentDigest: string }>)
        .filter(row => row && typeof row.callId === 'string' && typeof row.argumentDigest === 'string')
        .slice(0, 32)
      : [],
    pendingApprovalCount,
  };
}

/** 把本机 `tasks/get` 的公开投影解码为 UI 统一模型。 */
export function decodeLocalTask(value: unknown, pendingApprovalCount = 0): ButlerTaskView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ButlerClientError('invalid-task');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.startsWith('task-')) throw new ButlerClientError('invalid-task');
  return {
    id: row.id,
    title: text(row.title, row.id.slice(0, 12)),
    objective: text(row.objective),
    status: taskStatus(row.status),
    cwd: text(row.cwd),
    sessionId: typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : null,
    goalId: typeof row.goalId === 'string' && row.goalId ? row.goalId : null,
    goalRevision: stamp(row.goalRevision),
    goalPhase: typeof row.goalPhase === 'string' ? row.goalPhase : null,
    maxGoalRounds: stamp(row.maxGoalRounds),
    autoResume: row.autoResume === true,
    createdAt: stamp(row.createdAt),
    updatedAt: stamp(row.updatedAt),
    revision: stamp(row.revision),
    lastAssistantText: typeof row.lastAssistantText === 'string' ? row.lastAssistantText : null,
    deliverables: Array.isArray(row.deliverables)
      ? (row.deliverables as ButlerTask['deliverables']).filter(file => file && typeof file.path === 'string').slice(0, 32)
      : [],
    pendingApproval: null,
    pendingApprovals: [],
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
    local: localMeta(row, pendingApprovalCount),
  };
}

/** 已完成/失败/取消的任务不在 reconcile 里，历史摘要仍要让它们在列表可见。 */
export function decodeHistoryTask(value: unknown): ButlerTaskView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ButlerClientError('invalid-history');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.startsWith('task-')) throw new ButlerClientError('invalid-history');
  const status = taskStatus(row.status);
  const view = placeholder(row.id, stamp(row.revision), undefined, status);
  view.title = text(row.title, row.id.slice(0, 12));
  view.objective = text(row.objective);
  view.updatedAt = stamp(row.updatedAt);
  view.lastError = typeof row.lastError === 'string' ? row.lastError : null;
  view.local = localMeta(row, typeof row.pendingApprovalCount === 'number' ? row.pendingApprovalCount : 0);
  return view;
}

function placeholder(id: string, revision: number, input?: ButlerTaskInput, status: ButlerTaskStatus = 'created'): ButlerTaskView {
  return {
    id,
    title: input?.title || input?.objective?.slice(0, 60) || id.slice(0, 12),
    objective: input?.objective ?? '',
    status,
    cwd: '',
    sessionId: null,
    goalId: null,
    goalRevision: 0,
    goalPhase: null,
    maxGoalRounds: input?.maxGoalRounds ?? 0,
    autoResume: false,
    createdAt: 0,
    updatedAt: 0,
    revision,
    lastAssistantText: null,
    deliverables: [],
    pendingApproval: null,
    pendingApprovals: [],
    lastError: null,
    local: { queueOrder: null, authorized: false, recoveryRequired: false, unsettledWrites: [], pendingApprovalCount: 0 },
  };
}

function decodeReconcile(value: unknown): LocalReconcile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ButlerClientError('invalid-reconcile');
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.tasks) || !Array.isArray(row.approvals)) throw new ButlerClientError('invalid-reconcile');
  return {
    version: stamp(row.version),
    generation: text(row.generation),
    autoResume: row.autoResume === true,
    tasks: row.tasks.filter((item): item is LocalReconcileTask => Boolean(item)
      && typeof (item as LocalReconcileTask).id === 'string'
      && typeof (item as LocalReconcileTask).revision === 'number'
      && STATUSES.has(String((item as LocalReconcileTask).status))),
    totalTasks: stamp(row.totalTasks),
    tasksTruncated: row.tasksTruncated === true,
    unresolved: Array.isArray(row.unresolved) ? row.unresolved as LocalUnresolvedReceipt[] : [],
    totalUnresolved: stamp(row.totalUnresolved),
    unresolvedTruncated: row.unresolvedTruncated === true,
    approvals: row.approvals.filter((item): item is LocalApprovalEntry => Boolean(item)
      && typeof (item as LocalApprovalEntry).id === 'string'
      && typeof (item as LocalApprovalEntry).taskId === 'string'
      && typeof (item as LocalApprovalEntry).argumentDigest === 'string'
      && typeof (item as LocalApprovalEntry).toolCallId === 'string'),
  };
}

export class LocalButlerClient implements ButlerClient {
  readonly location = 'local' as const;
  private readonly details = new Map<string, { revision: number; task: ButlerTaskView }>();
  private lastReconcile: LocalReconcile | null = null;

  constructor(private readonly runtime: LocalRuntimeClient) {}

  async capabilities(): Promise<ButlerCapabilities> {
    return this.runtime.query<ButlerCapabilities>('capabilities');
  }

  async reconcile(): Promise<LocalReconcile> {
    const reconcile = decodeReconcile(await this.runtime.query('reconcile'));
    this.lastReconcile = reconcile;
    return reconcile;
  }

  /** 有界历史摘要；包含 reconcile 不返回的已完成/失败/取消任务。 */
  async history(): Promise<ButlerTaskView[]> {
    const body = await this.runtime.query<{ tasks?: unknown[] }>('tasks');
    if (!Array.isArray(body?.tasks)) throw new ButlerClientError('invalid-history');
    return body.tasks.map(decodeHistoryTask);
  }

  /**
   * 把 reconcile（活任务/审批）与历史摘要合并成列表。
   * 历史缺失时退回 reconcile，保证旧运行包也能显示进行中的任务。
   */
  project(reconcile: LocalReconcile, history: ButlerTaskView[] | null = null): ButlerTaskView[] {
    this.lastReconcile = reconcile;
    const pendingFor = (id: string) => reconcile.approvals.filter(entry => entry.taskId === id).length;
    const fromReconcile = (row: LocalReconcileTask): ButlerTaskView => ({
      ...placeholder(row.id, row.revision, undefined, row.status),
      local: localMeta(row as unknown as Record<string, unknown>, pendingFor(row.id)),
    });
    const source: ButlerTaskView[] = history && history.length
      // The host history normally contains everything; merge reconciles that
      // are missing (partial history or an older runtime package) so active
      // work is never hidden.
      ? [...history, ...reconcile.tasks.filter(row => !history.some(view => view.id === row.id)).map(fromReconcile)]
      : reconcile.tasks.map(fromReconcile);
    const views = source.map(view => {
      const row = reconcile.tasks.find(task => task.id === view.id);
      const pending = pendingFor(view.id);
      const local = row
        ? localMeta(row as unknown as Record<string, unknown>, pending)
        : {
          ...(view.local ?? {
            queueOrder: null, authorized: false, recoveryRequired: false, unsettledWrites: [], pendingApprovalCount: 0,
          }),
          pendingApprovalCount: pending,
        };
      const cached = this.details.get(view.id);
      if (cached && cached.revision === view.revision) return { ...cached.task, local };
      return { ...view, local };
    });
    return views.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  }

  async list(): Promise<ButlerTaskView[]> {
    return this.project(await this.reconcile());
  }

  async detail(id: string): Promise<ButlerTaskView> {
    const row = this.lastReconcile?.tasks.find(task => task.id === id);
    const pending = this.lastReconcile?.approvals.filter(entry => entry.taskId === id).length ?? 0;
    const cached = this.details.get(id);
    if (cached && row && cached.revision === row.revision) return cached.task;
    const body = await this.runtime.query<{ task?: unknown }>('task', { id });
    const task = decodeLocalTask(body?.task, pending);
    if (row) task.local = localMeta(row as unknown as Record<string, unknown>, pending);
    this.details.set(id, { revision: task.revision, task });
    return task;
  }

  private args(input: ButlerTaskInput): Record<string, unknown> {
    const args: Record<string, unknown> = { objective: input.objective };
    if (input.title) args.title = input.title;
    if (input.maxGoalRounds !== undefined) args.maxGoalRounds = input.maxGoalRounds;
    return args;
  }

  private async send(
    operation: LocalCommandOperation,
    args: Record<string, unknown>,
    commandId: string,
  ): Promise<ButlerCommandReceipt> {
    let receipt: ButlerCommandReceipt;
    try {
      receipt = await this.runtime.command(operation, args, commandId);
    } catch (error) {
      if (error instanceof LocalRuntimeError) throw new ButlerClientError(error.code);
      throw error;
    }
    if (receipt.state === 'unknown') throw new ButlerReceiptUnknown(commandId, receipt);
    if (receipt.state === 'rejected') throw new ButlerClientError(receipt.code ?? 'command-rejected');
    return receipt;
  }

  private async createdBy(
    operation: 'create' | 'enqueue',
    input: ButlerTaskInput,
    commandId: string,
  ): Promise<ButlerTaskView> {
    const receipt = await this.send(operation, this.args(input), commandId);
    if (!receipt.taskId) throw new ButlerClientError('invalid-receipt');
    try {
      return await this.detail(receipt.taskId);
    } catch {
      // Creation is already authoritative; a detail read failure must not be
      // presented as "creation failed". The next reconcile/detail will fill it.
      this.details.delete(receipt.taskId);
      return placeholder(receipt.taskId, receipt.revision ?? 1, input);
    }
  }

  create(input: ButlerTaskInput, commandId: string): Promise<ButlerTaskView> {
    return this.createdBy('create', input, commandId);
  }

  enqueue(input: ButlerTaskInput, commandId: string): Promise<ButlerTaskView> {
    return this.createdBy('enqueue', input, commandId);
  }

  private async liveRevision(id: string): Promise<number> {
    const reconcile = this.lastReconcile ?? await this.reconcile();
    const row = reconcile.tasks.find(task => task.id === id);
    if (!row) throw new ButlerClientError('task-not-found');
    return row.revision;
  }

  private async mutate(
    operation: 'cancel' | 'resume' | 'interrupt',
    id: string,
    commandId: string,
  ): Promise<ButlerTaskView> {
    const revision = await this.liveRevision(id);
    await this.send(operation, { taskId: id, revision }, commandId);
    this.details.delete(id);
    // The mutation already succeeded; a failed refresh must not turn it into
    // an action error. The next poll fills in the authoritative revision.
    try {
      await this.reconcile();
      return await this.detail(id);
    } catch {
      return placeholder(id, revision + 1);
    }
  }

  cancel(id: string): Promise<ButlerTaskView> {
    return this.mutate('cancel', id, newButlerCommandId('cancel'));
  }

  resume(id: string): Promise<ButlerTaskView> {
    return this.mutate('resume', id, newButlerCommandId('resume'));
  }

  interrupt(id: string): Promise<ButlerTaskView> {
    return this.mutate('interrupt', id, newButlerCommandId('interrupt'));
  }

  /**
   * 审批答复永远使用**当前** reconcile 里的 approval 身份与 task revision。
   * 这样即使用户看到的是稍早的卡片，只要审批仍活着，提交的就是同一条
   * 工具调用与参数摘要；审批已消失则直接按 stale-approval 拒绝。
   */
  async approve(input: ButlerApprovalDecision): Promise<ButlerCommandReceipt> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const first = await this.reconcile();
      const approval = first.approvals.find(entry => entry.id === input.approvalId);
      if (!approval) throw new ButlerClientError('stale-approval');
      const task = first.tasks.find(entry => entry.id === approval.taskId);
      if (!task) throw new ButlerClientError('task-not-found');
      // The turn driver can advance the task revision while the card is shown.
      // Require a short unchanged window before binding the answer.
      await sleep(400);
      const second = await this.reconcile();
      const currentApproval = second.approvals.find(entry => entry.id === input.approvalId);
      if (!currentApproval) throw new ButlerClientError('stale-approval');
      const currentTask = second.tasks.find(entry => entry.id === approval.taskId);
      if (!currentTask || currentTask.revision !== task.revision) continue;
      try {
        return await this.send('approval', {
          taskId: currentTask.id,
          revision: currentTask.revision,
          approvalId: currentApproval.id,
          toolCallId: currentApproval.toolCallId,
          argumentDigest: currentApproval.argumentDigest,
          decision: input.decision,
        }, newButlerCommandId('approval'));
      } catch (error) {
        // Butler validates the revision before writing any intent, so a
        // revision-conflict had no effect. Re-read once and retry with the
        // current revision; unknown outcomes and stale approvals never retry.
        if (attempt === 0 && error instanceof ButlerClientError && error.code === 'revision-conflict') continue;
        throw error;
      }
    }
    throw new ButlerClientError('revision-conflict');
  }

  async receipt(commandId: string): Promise<ButlerCommandReceipt | null> {
    try {
      const body = await this.runtime.query<{ receipt?: ButlerCommandReceipt }>('receipt', { commandId });
      return body?.receipt ?? null;
    } catch (error) {
      if (error instanceof LocalRuntimeError && ['QUERY_FAILED', 'command-not-found'].includes(error.code)) return null;
      throw error;
    }
  }
}

export class DesktopButlerClient implements ButlerClient {
  readonly location = 'desktop' as const;

  constructor(private readonly store: DesktopTaskStore) {}

  list(): Promise<ButlerTaskView[]> {
    return this.store.listButlerTasks();
  }

  detail(id: string): Promise<ButlerTaskView> {
    return this.store.getButlerTask(id);
  }

  private input(input: ButlerTaskInput): NewButlerTask {
    if (!input.cwd || !input.cwd.trim()) throw new ButlerClientError('workspace-required');
    return {
      objective: input.objective,
      cwd: input.cwd,
      title: input.title,
      maxGoalRounds: input.maxGoalRounds,
      autoResume: input.autoResume === true,
    };
  }

  create(input: ButlerTaskInput, commandId: string): Promise<ButlerTaskView> {
    try {
      return this.store.createButlerTask(this.input(input), commandId);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  enqueue(input: ButlerTaskInput, commandId: string): Promise<ButlerTaskView> {
    // 电脑 Host 的队列是会话 prompt 队列；任务页没有独立 enqueue 路由。
    return this.create(input, commandId);
  }

  cancel(id: string): Promise<ButlerTaskView> {
    return this.store.cancelButlerTask(id);
  }

  resume(id: string): Promise<ButlerTaskView> {
    return this.store.resumeButlerTask(id);
  }

  interrupt(): Promise<ButlerTaskView> {
    return Promise.reject(new ButlerClientError('unsupported-on-desktop'));
  }

  capabilities(): Promise<ButlerCapabilities> {
    return Promise.reject(new ButlerClientError('unsupported-on-desktop'));
  }

  reconcile(): Promise<LocalReconcile> {
    return Promise.reject(new ButlerClientError('unsupported-on-desktop'));
  }

  approve(): Promise<ButlerCommandReceipt> {
    return Promise.reject(new ButlerClientError('unsupported-on-desktop'));
  }

  receipt(): Promise<ButlerCommandReceipt | null> {
    return Promise.reject(new ButlerClientError('unsupported-on-desktop'));
  }
}

export function createButlerClient(options: {
  location: HostLocation;
  store: DesktopTaskStore;
  runtime: LocalRuntimeClient;
}): ButlerClient {
  return options.location === 'local'
    ? new LocalButlerClient(options.runtime)
    : new DesktopButlerClient(options.store);
}
