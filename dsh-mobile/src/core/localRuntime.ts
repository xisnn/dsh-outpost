/**
 * 本机运行时的 RN 侧客户端（P3）。
 *
 * 只做四件事：
 *   1. 串行化对原生桥的调用 —— 本机 host 一次只处理一个请求，并发会得到 BRIDGE_BUSY；
 *   2. 把两层错误（原生 Promise 拒绝的 CODE、业务响应 {ok:false,code}）统一成一种异常；
 *   3. 把「当前运行代次」固定进每条业务命令，避免旧代次命令被当成新授权；
 *   4. 启动前按 journal 的 requiresReconciliation 传 acknowledgedGeneration。
 *
 * 它**不**实现任务状态机、不重试业务命令、不推断执行结果。任务与回执权威
 * 始终在 guest 的 outpost-butler 里（见 P2）。
 */

export type LocalRuntimePhase =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'interrupted'
  | 'stop-unconfirmed';

export interface LocalRuntimeSnapshot {
  phase: LocalRuntimePhase;
  generation: string | null;
  reason: string;
  requiresReconciliation: boolean;
  observedAt: number;
  live?: boolean;
  lastHeartbeatElapsedMs?: number;
  verificationExpiresElapsedMs?: number;
  notificationPermission?: boolean;
  installed?: { installed: boolean; id?: string; version?: string };
}

export interface LocalRuntimeEvents {
  snapshot: LocalRuntimeSnapshot;
  events: Array<{ cursor: number; kind: string; generation: string | null; time: number; detail: unknown }>;
  cursor: number;
  gap: boolean;
}

export type LocalCommandOperation = 'create' | 'enqueue' | 'resume' | 'interrupt' | 'cancel' | 'approval';

export interface LocalCommandEnvelope {
  version: 1;
  commandId: string;
  generation: string;
  operation: LocalCommandOperation;
  args: Record<string, unknown>;
}

export interface ButlerCommandReceipt {
  version: number;
  commandId: string;
  generation: string;
  operation: string;
  digest: string;
  taskId: string | null;
  state: 'accepted' | 'completed' | 'rejected' | 'unknown';
  at: number;
  revision?: number;
  code?: string;
}

/**
 * 原生桥的 JS 形状（localDsh 已解析 JSON）。
 * 返回值故意声明为 unknown：解码前不信任任何字段。
 */
export interface LocalRuntimeBridge {
  snapshot(): Promise<unknown>;
  events(after: number): Promise<unknown>;
  start(acknowledgedGeneration: string | null): Promise<unknown>;
  stop(): Promise<void>;
  query(generation: string, operation: string, argsText: string): Promise<unknown>;
}

function parseIfText(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** 原生/业务错误统一成带机器码的异常；不携带远端文本或堆栈。 */
export class LocalRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LocalRuntimeError';
  }
}

export function normalizeRuntimeCode(error: unknown): string {
  if (error instanceof LocalRuntimeError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(message) ? message : 'LOCAL_RUNTIME_ERROR';
}

const PHASES: ReadonlySet<string> = new Set([
  'stopped', 'starting', 'running', 'stopping', 'interrupted', 'stop-unconfirmed',
]);

/** 严格解码，避免把损坏的 journal 当作可用状态。 */
export function decodeSnapshot(value: unknown): LocalRuntimeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalRuntimeError('LOCAL_RUNTIME_STATE');
  const row = value as Record<string, unknown>;
  if (typeof row.phase !== 'string' || !PHASES.has(row.phase)) throw new LocalRuntimeError('LOCAL_RUNTIME_STATE');
  const generation = typeof row.generation === 'string' && /^[a-f0-9-]{36}$/.test(row.generation)
    ? row.generation
    : null;
  const installed = row.installed && typeof row.installed === 'object' && !Array.isArray(row.installed)
    ? row.installed as LocalRuntimeSnapshot['installed']
    : undefined;
  return {
    phase: row.phase as LocalRuntimePhase,
    generation,
    reason: typeof row.reason === 'string' ? row.reason : '',
    requiresReconciliation: row.requiresReconciliation === true,
    observedAt: typeof row.observedAt === 'number' ? row.observedAt : Date.now(),
    live: row.live === true,
    lastHeartbeatElapsedMs: typeof row.lastHeartbeatElapsedMs === 'number' ? row.lastHeartbeatElapsedMs : undefined,
    verificationExpiresElapsedMs: typeof row.verificationExpiresElapsedMs === 'number'
      ? row.verificationExpiresElapsedMs : undefined,
    notificationPermission: typeof row.notificationPermission === 'boolean' ? row.notificationPermission : undefined,
    ...(installed ? { installed } : {}),
  };
}

export function buildCommandEnvelope(
  generation: string,
  operation: LocalCommandOperation,
  args: Record<string, unknown>,
  commandId: string,
): LocalCommandEnvelope {
  return { version: 1, commandId, generation, operation, args };
}

/** 只读查询允许在这几个操作上使用；其它名字一律在 JS 侧拒绝。 */
export type LocalQueryOperation =
  | 'health'
  | 'snapshot'
  | 'capabilities'
  | 'receipt'
  | 'reconcile'
  | 'tasks'
  | 'task'
  | 'memory'
  | 'memory-history'
  | 'memory-set'
  | 'memory-delete';

interface QueryResponse<T> {
  ok: boolean;
  body?: T;
  code?: string;
}

export class LocalRuntimeClient {
  private chain: Promise<unknown> = Promise.resolve();
  private last: LocalRuntimeSnapshot | null = null;

  constructor(
    private readonly bridge: LocalRuntimeBridge | null,
    private readonly now: () => number = Date.now,
  ) {}

  get supported(): boolean {
    return this.bridge !== null;
  }

  /** 最近一次成功读取的快照；只用于展示，不用于授权判断。 */
  get lastSnapshot(): LocalRuntimeSnapshot | null {
    return this.last;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async readSnapshot(): Promise<LocalRuntimeSnapshot> {
    if (!this.bridge) throw new LocalRuntimeError('LOCAL_RUNTIME_UNSUPPORTED');
    const snapshot = decodeSnapshot(parseIfText(await this.bridge.snapshot()));
    this.last = snapshot;
    return snapshot;
  }

  async snapshot(): Promise<LocalRuntimeSnapshot> {
    return this.serialize(() => this.readSnapshot());
  }

  /**
   * 启动本机运行时。
   *
   * 上一次运行只要不是「干净的停止」，journal 都会要求核对。这里自动把
   * 当前 generation 作为 acknowledgedGeneration 传给原生层 —— 只表示
   * 「用户看到了上次未正常结束」，**不会**恢复旧任务、旧审批或旧队列。
   */
  async start(): Promise<LocalRuntimeSnapshot> {
    return this.serialize(async () => {
      if (!this.bridge) throw new LocalRuntimeError('LOCAL_RUNTIME_UNSUPPORTED');
      const current = await this.readSnapshot();
      if (current.phase === 'running' || current.phase === 'starting') return current;
      if (current.phase === 'stopping') throw new LocalRuntimeError('RUNTIME_STOPPING');
      const acknowledged = current.requiresReconciliation ? current.generation : null;
      await this.bridge.start(acknowledged);
      return this.readSnapshot();
    });
  }

  async stop(): Promise<LocalRuntimeSnapshot> {
    return this.serialize(async () => {
      if (!this.bridge) throw new LocalRuntimeError('LOCAL_RUNTIME_UNSUPPORTED');
      await this.bridge.stop();
      return this.readSnapshot();
    });
  }

  async events(after: number): Promise<LocalRuntimeEvents> {
    return this.serialize(async () => {
      if (!this.bridge) throw new LocalRuntimeError('LOCAL_RUNTIME_UNSUPPORTED');
      const parsed = parseIfText(await this.bridge.events(after)) as LocalRuntimeEvents;
      this.last = decodeSnapshot(parsed.snapshot);
      return parsed;
    });
  }

  /** 只读查询：需要运行态与当前代次。 */
  async query<T = unknown>(operation: LocalQueryOperation, args: object = {}): Promise<T> {
    return this.serialize(async () => {
      const snapshot = await this.readSnapshot();
      return this.invoke<T>(snapshot, operation, args);
    });
  }

  private async invoke<T>(
    snapshot: LocalRuntimeSnapshot,
    operation: string,
    args: object,
  ): Promise<T> {
    if (!this.bridge) throw new LocalRuntimeError('LOCAL_RUNTIME_UNSUPPORTED');
    if (snapshot.phase !== 'running' || !snapshot.generation) {
      throw new LocalRuntimeError(snapshot.phase === 'starting' ? 'RUNTIME_STARTING' : 'RUNTIME_NOT_RUNNING');
    }
    const response = parseIfText(
      await this.bridge.query(snapshot.generation, operation, JSON.stringify(args)),
    ) as QueryResponse<T>;
    if (!response.ok) throw new LocalRuntimeError(response.code ?? 'QUERY_FAILED');
    return response.body as T;
  }

  /**
   * 提交一条业务命令。
   *
   * 代次在串行区内读取并写入 envelope；调用方只提供 commandId 与参数。
   * 同一个 commandId 重传返回同一回执；`unknown` 原样返回给上层，由上层
   * 决定核对，绝不在传输层重发。
   */
  async command(
    operation: LocalCommandOperation,
    args: Record<string, unknown>,
    commandId: string,
  ): Promise<ButlerCommandReceipt> {
    return this.serialize(async () => {
      const snapshot = await this.readSnapshot();
      const body = await this.invoke<{ receipt?: ButlerCommandReceipt }>(
        snapshot,
        'command',
        buildCommandEnvelope(snapshot.generation ?? '', operation, args, commandId),
      );
      const receipt = body?.receipt;
      if (!receipt || typeof receipt !== 'object' || receipt.commandId !== commandId) {
        throw new LocalRuntimeError('COMMAND_RECEIPT_INVALID');
      }
      return receipt;
    });
  }

  dispose(): void {
    this.last = null;
  }
}
