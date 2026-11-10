/**
 * 把 localDsh 的显式方法适配成 LocalRuntimeClient 的桥接口。
 *
 * 这里**不是**通用代理：每个 operation 都映射到 localDsh 已有的固定方法，
 * 未列出的操作直接拒绝。P2 的传输白名单仍然在原生层生效。
 */
import { localDsh, type LocalDshCommandEnvelope } from './localDsh';
import type { LocalRuntimeBridge } from './localRuntime';
import { localRuntimeAvailable } from './localRuntimeSupport';

export function createLocalRuntimeBridge(): LocalRuntimeBridge | null {
  if (!localRuntimeAvailable()) return null;
  return {
    snapshot: () => localDsh.snapshot(),
    events: after => localDsh.events(after),
    start: acknowledgedGeneration => localDsh.start(acknowledgedGeneration),
    stop: () => localDsh.stop(),
    query: (generation, operation, argsText) => {
      const args = JSON.parse(argsText) as Record<string, unknown>;
      switch (operation) {
        case 'health':
        case 'snapshot':
          return localDsh.query(generation, operation, args as { cursor?: string; limit?: number });
        case 'capabilities':
          return localDsh.capabilities(generation);
        case 'receipt':
          return localDsh.receipt(generation, String(args.commandId ?? ''));
        case 'reconcile':
          return localDsh.reconcile(generation);
        case 'tasks':
          return localDsh.tasks(generation);
        case 'task':
          return localDsh.task(generation, String(args.id ?? ''));
        case 'memory':
          return localDsh.memory(generation);
        case 'memory-history':
          return localDsh.memoryHistory(generation, typeof args.id === 'string' ? args.id : undefined);
        case 'memory-set':
          return localDsh.memorySet(generation, args);
        case 'memory-delete':
          return localDsh.memoryDelete(generation, args);
        case 'command':
          return localDsh.command(generation, args as unknown as LocalDshCommandEnvelope);
        default:
          return Promise.reject(new Error('OPERATION_NOT_ALLOWED'));
      }
    },
  };
}
