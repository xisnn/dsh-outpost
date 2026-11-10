import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TaskError, MAX_OBJECTIVE_LENGTH, MAX_GOAL_ROUNDS } from './task-manager.js';
import { TERMINAL_STATUSES } from './task-store.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPS = ['create', 'enqueue', 'resume', 'interrupt', 'cancel', 'approval'];
const fail = (code, message = code) => { throw new TaskError(code, message, 409); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, fields) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) fail('command-arguments');
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const argumentDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

/** Butler-owned business boundary. The native layer never owns these receipts. */
export class LocalCommands {
  constructor({ manager, store, generation, workspaceRoot, approvals = null, now = () => Date.now() }) {
    if (!ID.test(generation) || !path.isAbsolute(workspaceRoot)) throw new Error('invalid local runtime configuration');
    Object.assign(this, { manager, store, generation, workspaceRoot, approvals, now });
    this.chain = Promise.resolve();
    this.disposed = false;
  }

  async init() {
    // An accepted command can have performed its effect before the process died.
    for (const receipt of this.store.unresolved()) {
      if (receipt.state === 'accepted') await this.store.writeReceipt({ ...receipt, state: 'unknown', code: 'runtime-interrupted' });
    }
    this.workspace = await fs.realpath(this.workspaceRoot);
    if (this.workspace !== path.resolve(this.workspaceRoot)) throw new Error('local workspace must be a real directory, not a symlink');
  }

  capabilities() {
    return { version: 1, enabled: true, journalFormat: 2, generation: this.generation,
      operations: OPS.filter(op => op !== 'approval' || this.approvals),
      durableReceipts: true, queue: 'fifo-explicit-authorization', autoResume: false,
      uncertainExecution: 'manual-verification-new-task', maxQueued: 128 };
  }

  receipt(commandId) {
    if (!ID.test(commandId)) fail('command-id');
    return this.store.receipt(commandId);
  }

  reconcile() {
    const tasks = this.store.list().filter(task => !TERMINAL_STATUSES.has(task.status))
      .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
    const unresolved = this.store.unresolved();
    const snapshot = { version: 1, generation: this.generation, autoResume: false,
      tasks: tasks.slice(0, 128).map(task => ({ id: task.id, revision: task.revision,
        status: task.status, queueOrder: task.queueOrder ?? null,
        authorized: task.localAuthorization === this.generation,
        recoveryRequired: task.recoveryRequired === true || Boolean(task.unsettledWrites?.length),
        unsettledWrites: task.unsettledWrites ?? [] })),
      totalTasks: tasks.length, tasksTruncated: tasks.length > 128,
      unresolved: unresolved.slice(0, 128), totalUnresolved: unresolved.length,
      unresolvedTruncated: unresolved.length > 128,
      approvals: this.approvals?.list() ?? [] };
    // The pipe has a 256 KiB encoded-frame ceiling. Never let a long-lived
    // history/uncertain queue crowd out the current live approval capabilities.
    while (Buffer.byteLength(JSON.stringify(snapshot)) > 128 * 1024) {
      if (snapshot.unresolved.length) { snapshot.unresolved.pop(); snapshot.unresolvedTruncated = true; }
      else if (snapshot.tasks.length) { snapshot.tasks.pop(); snapshot.tasksTruncated = true; }
      else throw new TaskError('snapshot-too-large', 'approval snapshot exceeds transport budget', 413);
    }
    return snapshot;
  }

  submit(envelope) {
    const request = structuredClone(envelope);
    const result = this.chain.then(() => this.execute(request));
    this.chain = result.catch(() => {});
    return result;
  }

  async execute(envelope) {
    if (this.disposed) fail('runtime-stopped');
    exact(envelope, ['version', 'commandId', 'generation', 'operation', 'args']);
    if (envelope.version !== 1 || !ID.test(envelope.commandId) || !OPS.includes(envelope.operation)) fail('command-envelope');
    if (envelope.generation !== this.generation) fail('stale-generation');
    if (Buffer.byteLength(JSON.stringify(envelope)) > 48 * 1024) fail('command-too-large');
    const digest = argumentDigest(envelope);
    const prior = this.store.receipt(envelope.commandId);
    if (prior) {
      if (prior.digest !== digest) fail('command-conflict');
      return prior; // Includes unknown: never dispatch it again.
    }
    const { operation, args } = envelope;
    let task;
    if (operation === 'create' || operation === 'enqueue') {
      exact(args, ['objective', 'title', 'maxGoalRounds']);
      if (typeof args.objective !== 'string' || !args.objective.trim() || args.objective.length > MAX_OBJECTIVE_LENGTH
        || (args.title !== undefined && typeof args.title !== 'string')
        || (args.maxGoalRounds !== undefined && (!Number.isInteger(args.maxGoalRounds) || args.maxGoalRounds < 1 || args.maxGoalRounds > MAX_GOAL_ROUNDS))) fail('command-arguments');
      const queued = this.store.list().filter(t => t.status === 'created');
      if (queued.length >= 128) fail('queue-full');
      if (operation === 'create' && (this.manager.activeTaskId || this.manager.queue.length)) fail('busy-use-enqueue');
      // Revalidate after any filesystem wait, before the authoritative append.
      if (await fs.realpath(this.workspaceRoot) !== this.workspace) fail('workspace-changed');
      const receipt = { version: 1, commandId: envelope.commandId, generation: this.generation,
        operation, digest, taskId: null };
      task = await this.manager.create({ ...args, cwd: this.workspace, autoResume: false },
        { commandReceipt: receipt, deferExecution: true });
      // The creation and receipt already committed atomically. This authorization
      // is valid only in this generation; init never auto-pumps a recovered queue.
      this.manager.enqueue(task.id);
      this.manager.pump();
      return this.store.receipt(envelope.commandId);
    }
    exact(args, operation === 'approval'
      ? ['taskId', 'revision', 'approvalId', 'toolCallId', 'argumentDigest', 'decision']
      : ['taskId', 'revision']);
    if (!ID.test(args.taskId) || !Number.isSafeInteger(args.revision) || args.revision < 1) fail('command-arguments');
    task = this.manager.get(args.taskId);
    if (task.revision !== args.revision) fail('revision-conflict');
    if (operation === 'resume') {
      if (task.cwd !== this.workspace || await fs.realpath(this.workspaceRoot) !== this.workspace) fail('workspace-conflict');
      if (task.recoveryRequired || task.unsettledWrites?.length || this.store.unresolved().some(r => r.taskId === task.id)) fail('reconciliation-required');
      if (this.manager.activeTaskId && this.manager.activeTaskId !== task.id) fail('busy');
      if (task.status === 'running' || task.status === 'preparing' || TERMINAL_STATUSES.has(task.status)) fail('invalid-state');
    }
    if (operation === 'approval') {
      if (!this.approvals) fail('approval-unavailable');
      this.approvals.validate(args);
    }
    const intent = { version: 1, commandId: envelope.commandId, generation: this.generation,
      operation, digest, taskId: task.id, state: 'accepted', at: this.now() };
    await this.store.writeReceipt(intent, () => {
      if (this.manager.get(task.id).revision !== args.revision) fail('revision-conflict');
      if (operation === 'approval') this.approvals.validate(args);
    });
    try {
      if (operation === 'resume') {
        await this.manager.persist(task.id, { localAuthorization: this.generation });
        await this.manager.resume(task.id);
      } else if (operation === 'interrupt') {
        this.approvals?.invalidateTask(task.id);
        await this.manager.interrupt(task.id);
      } else if (operation === 'cancel') {
        this.approvals?.invalidateTask(task.id);
        await this.manager.cancel(task.id);
      } else {
        this.approvals.decide(args);
      }
      return await this.store.writeReceipt({ ...intent, state: 'completed', revision: this.manager.get(task.id).revision });
    } catch (error) {
      // Even an exception from a DSH call can occur after an effect. Never infer
      // that retrying is safe from the error type or from a missing response.
      await this.store.writeReceipt({ ...intent, state: 'unknown', code: 'effect-unconfirmed' });
      throw error;
    }
  }

  async dispose() { this.disposed = true; await this.chain; this.approvals?.dispose(); }
}
