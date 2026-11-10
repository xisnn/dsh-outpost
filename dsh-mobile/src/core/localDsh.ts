import {NativeEventEmitter, NativeModules, Platform} from 'react-native';

export type LocalRuntimePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'interrupted' | 'stop-unconfirmed';
export interface LocalRuntimeSnapshot {
  phase: LocalRuntimePhase;
  generation: string | null;
  reason: string;
  requiresReconciliation: boolean;
  cursor: number;
  observedAt: number;
  live?: boolean;
  lastHeartbeatElapsedMs?: number;
  verificationExpiresElapsedMs?: number;
  notificationPermission?: boolean;
  installed?: {installed: boolean; id?: string; version?: string};
}
export interface LocalRuntimeEvents {
  snapshot: LocalRuntimeSnapshot;
  events: Array<{cursor: number; kind: string; generation: string | null; time: number; detail: unknown}>;
  cursor: number;
  gap: boolean;
}
export interface LocalDshCommandEnvelope {
  version: 1;
  commandId: string;
  generation: string;
  operation: 'create' | 'enqueue' | 'resume' | 'interrupt' | 'cancel' | 'approval';
  args: Record<string, unknown>;
}
export type LocalDshResponse = {ok: true; body: unknown} | {ok: false; code: string};
type QueryOperation = 'health' | 'snapshot' | 'tasks' | 'task' | 'capabilities' | 'command' | 'receipt' | 'reconcile' | 'memory' | 'memory-history' | 'memory-set' | 'memory-delete';
export interface BundledDistribution {
  id: string;
  version?: string;
  abi?: string;
}

interface NativeLocalDsh {
  snapshot(): Promise<string>;
  bundledDistributions(): Promise<string>;
  events(after: number): Promise<string>;
  start(acknowledgedGeneration: string | null): Promise<string>;
  stop(): Promise<void>;
  query(generation: string, operation: QueryOperation, argsText: string): Promise<string>;
  install(distributionId: string, uri: string): Promise<string>;
  rollback(): Promise<string>;
  addListener(event: string): void;
  removeListeners(count: number): void;
}
function native(): NativeLocalDsh {
  const bridge = NativeModules.OutpostLocalDsh as NativeLocalDsh | undefined;
  if (Platform.OS !== 'android' || !bridge) throw new Error('LOCAL_RUNTIME_UNSUPPORTED');
  return bridge;
}
const parse = <T>(text: string): T => JSON.parse(text) as T;
const query = async (generation: string, operation: QueryOperation, args: object = {}) =>
  parse<LocalDshResponse>(await native().query(generation, operation, JSON.stringify(args)));

/** Native owns execution. These calls never replay a business command on reconnect. */
export const localDsh = {
  snapshot: async () => parse<LocalRuntimeSnapshot>(await native().snapshot()),
  events: async (after: number) => parse<LocalRuntimeEvents>(await native().events(after)),
  start: async (acknowledgedGeneration: string | null = null) => parse<LocalRuntimeSnapshot>(await native().start(acknowledgedGeneration)),
  stop: () => native().stop(),
  query: (generation: string, operation: 'health' | 'snapshot', args: {cursor?: string; limit?: number} = {}) => query(generation, operation, args),
  capabilities: (generation: string) => query(generation, 'capabilities'),
  command: async (generation: string, envelope: LocalDshCommandEnvelope) => {
    if (envelope.generation !== generation) throw new Error('STALE_RUNTIME');
    return query(generation, 'command', envelope);
  },
  receipt: (generation: string, commandId: string) => query(generation, 'receipt', {commandId}),
  reconcile: (generation: string) => query(generation, 'reconcile'),
  /** 受限任务详情：只按 taskId 读取标题/目标/最近输出/交付物元数据。 */
  task: (generation: string, id: string) => query(generation, 'task', {id}),
  /** 有界任务历史：包含已完成/失败/取消的任务，最多 64 条摘要。 */
  tasks: (generation: string) => query(generation, 'tasks'),
  /** P4 本机管家身份与用户记忆；只由用户显式修改，不参与工具授权。 */
  memory: (generation: string) => query(generation, 'memory'),
  memoryHistory: (generation: string, id?: string) => query(generation, 'memory-history', id ? {id} : {}),
  memorySet: (generation: string, input: object) => query(generation, 'memory-set', input),
  memoryDelete: (generation: string, input: object) => query(generation, 'memory-delete', input),
  install: async (distributionId: string, contentUri: string) => parse<unknown>(await native().install(distributionId, contentUri)),
  bundledDistributions: async () => parse<BundledDistribution[]>(await native().bundledDistributions()),
  rollback: async () => parse<unknown>(await native().rollback()),
  /** Notifications are hints. Read events(cursor), and query Butler when gap is true. */
  subscribe(onChanged: () => void): () => void {
    const emitter = new NativeEventEmitter(native());
    const listener = emitter.addListener('OutpostLocalDshChanged', onChanged);
    return () => listener.remove();
  },
};
