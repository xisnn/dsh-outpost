import { randomUUID } from 'node:crypto';
import { argumentDigest } from './commands.js';
import { TaskError } from './task-manager.js';

const ALLOWED = new Set(['read', 'read_image', 'write', 'edit', 'create_goal', 'get_goal', 'update_goal']);
const MUTATING = new Set(['write', 'edit']);
const keyOf = (sessionId, callId) => JSON.stringify([sessionId, callId]);

/** Process-local capabilities. Persisted audit IDs can never recreate a resolver. */
export class LocalApprovals {
  constructor({ ctx, manager, generation, timeoutMs = 300000, now = () => Date.now() }) {
    Object.assign(this, { manager, generation, timeoutMs, now });
    this.executions = new Map();
    this.seenCalls = new Set();
    this.pending = new Map();
    this.off = [
      ctx.tools.guard(exec => {
        const taskId = this.manager.sessionToTask.get(exec.agent?.session?.id);
        const task = taskId && this.manager.store.get(taskId);
        return !ALLOWED.has(exec.name) || !task || task.recoveryRequired
          || task.localAuthorization !== this.generation || task.status !== 'running'
          ? 'local-task-capability-denied' : undefined;
      }),
      ctx.on('tools/pre-execute', (exec, next) => {
        const taskId = this.manager.sessionToTask.get(exec.agent?.session?.id);
        if (!taskId) return { kind: 'deny', reason: 'unowned-local-task' };
        // Keep only live invocations; tool/result removes them.
        const key = keyOf(exec.agent.session.id, exec.callId);
        if (this.executions.size >= 16 || this.seenCalls.size >= 4096 || this.seenCalls.has(key)
          || typeof exec.callId !== 'string' || !exec.callId || exec.callId.length > 128
          || Buffer.byteLength(JSON.stringify(exec.arguments)) > 8192) return { kind: 'deny', reason: 'local-tool-budget' };
        this.seenCalls.add(key);
        this.executions.set(key, { exec, taskId, digest: argumentDigest(exec.arguments) });
        return MUTATING.has(exec.name) ? { kind: 'ask', reason: 'local-workspace-write' } : next();
      }),
      ctx.on('tools/execute', async (exec, next) => {
        if (!MUTATING.has(exec.name)) return next();
        const taskId = this.manager.sessionToTask.get(exec.agent?.session?.id);
        if (!taskId) throw new Error('unowned-local-write');
        // This durable marker precedes the tool body, even after approval. A
        // crash between filesystem mutation and result persistence stays unknown.
        await this.manager.persist(taskId, task => ({ unsettledWrites: [
          ...(task.unsettledWrites ?? []), { callId: exec.callId, argumentDigest: argumentDigest(exec.arguments) },
        ] }));
        const result = await next();
        if (result.isError === false && !exec.signal?.aborted) {
          await this.manager.persist(taskId, task => ({ unsettledWrites:
            (task.unsettledWrites ?? []).filter(item => item.callId !== exec.callId) }));
        } else {
          await this.manager.persist(taskId, { recoveryRequired: true });
          await this.manager.stopForApproval(taskId, 'approval-write-outcome-unknown');
        }
        return result;
      }),
      ctx.on('tools/result', exec => {
        const key = keyOf(exec.agent?.session?.id, exec.callId);
        this.executions.delete(key);
        // The dedupe set has to shrink with the invocation. Left to grow it
        // reaches the cap and then denies every later call for the life of the
        // process. Dropping a finished call is safe: a replayed pre-execute is
        // treated as a new invocation and re-enters the approval chain.
        this.seenCalls.delete(key);
        for (const entry of this.pending.values()) if (entry.key === key) entry.finish('cancelled');
      }),
      ctx.on('approval/request', (req, next) => this.request(req, next)),
    ];
  }

  request(req, next) {
    const sessionId = req.agent?.session?.id;
    if (!this.manager.sessionToTask.has(sessionId)) return next();
    const key = keyOf(sessionId, req.callId);
    const execution = this.executions.get(key);
    const task = execution && this.manager.store.get(execution.taskId);
    if (!execution || execution.exec.agent !== req.agent || execution.exec.name !== req.toolName
      || !task || task.status !== 'running' || task.recoveryRequired
      || task.localAuthorization !== this.generation || req.signal?.aborted
      || this.pending.size >= 8) return 'unavailable';
    return new Promise(resolve => {
      const id = 'approval-' + randomUUID();
      const entry = { id, key, taskId: task.id, sessionId, toolCallId: req.callId,
        toolName: req.toolName, argumentDigest: execution.digest,
        arguments: structuredClone(execution.exec.arguments),
        generation: this.generation, expiresAt: this.now() + this.timeoutMs };
      let done = false;
      const abort = () => entry.finish('cancelled');
      const timer = setTimeout(() => entry.finish('rejected'), this.timeoutMs);
      timer.unref?.();
      entry.finish = outcome => {
        if (done) return;
        done = true; clearTimeout(timer); req.signal?.removeEventListener('abort', abort);
        this.pending.delete(id); resolve(outcome);
      };
      req.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, entry);
      if (req.signal?.aborted) abort();
    });
  }

  list() {
    return [...this.pending.values()].map(({ finish, key, ...entry }) => structuredClone(entry));
  }

  validate(args) {
    const entry = this.pending.get(args.approvalId);
    const task = this.manager.store.get(args.taskId);
    if (!entry || entry.generation !== this.generation || entry.taskId !== args.taskId
      || entry.toolCallId !== args.toolCallId || entry.argumentDigest !== args.argumentDigest
      || !['allowed-once', 'rejected'].includes(args.decision)
      || !task || task.status !== 'running' || task.recoveryRequired
      || task.localAuthorization !== this.generation || task.revision !== args.revision
      || this.now() >= entry.expiresAt) {
      if (entry && this.now() >= entry.expiresAt) entry.finish('rejected');
      throw new TaskError('stale-approval', 'approval is no longer valid', 409);
    }
    return entry;
  }

  decide(args) {
    // Revalidate after the durable intent append, which can outlive a deadline.
    this.validate(args).finish(args.decision);
  }
  invalidateTask(taskId) {
    for (const entry of this.pending.values()) if (entry.taskId === taskId) entry.finish('cancelled');
  }
  dispose() {
    for (const entry of this.pending.values()) entry.finish('cancelled');
    this.executions.clear();
    this.seenCalls.clear();
    for (const off of this.off) off?.();
  }
}
