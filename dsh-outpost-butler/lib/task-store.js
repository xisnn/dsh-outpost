import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TASK_STATUSES = new Set([
  'created', 'preparing', 'running', 'waiting_user', 'blocked', ...TERMINAL_STATUSES,
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value) => value === null || typeof value === 'string';
const isApproval = (value) => isObject(value)
  && typeof value.id === 'string' && typeof value.toolName === 'string'
  && Number.isFinite(value.askedAt);

function validateTask(task) {
  if (!isObject(task)
    || typeof task.id !== 'string' || !task.id
    || !['title', 'objective', 'cwd'].every((field) => typeof task[field] === 'string')
    || !TASK_STATUSES.has(task.status)
    || !['sessionId', 'goalId', 'goalPhase', 'lastAssistantText', 'lastError', 'idempotencyKey']
      .every((field) => nullableString(task[field]))
    || !['goalRevision', 'maxGoalRounds', 'createdAt', 'updatedAt']
      .every((field) => Number.isFinite(task[field]))
    || !Number.isSafeInteger(task.revision) || task.revision < 1
    || typeof task.autoResume !== 'boolean'
    || !Array.isArray(task.deliverables)
    || !task.deliverables.every((item) => isObject(item) && typeof item.path === 'string'
      && (item.description === undefined || typeof item.description === 'string'))
    || !(task.pendingApproval === null || isApproval(task.pendingApproval))
    // Older v019 records may omit this field; leave their representation intact.
    || !(task.pendingApprovals === undefined
      || (Array.isArray(task.pendingApprovals) && task.pendingApprovals.every(isApproval)))
    || !(task.localAuthorization === undefined || task.localAuthorization === null || typeof task.localAuthorization === 'string')
    || !(task.queueOrder === undefined || Number.isSafeInteger(task.queueOrder) && task.queueOrder > 0)
    || !(task.recoveryRequired === undefined || typeof task.recoveryRequired === 'boolean')
    || !(task.unsettledWrites === undefined || Array.isArray(task.unsettledWrites) && task.unsettledWrites.every(item => isObject(item)
      && typeof item.callId === 'string' && /^[a-f0-9]{64}$/.test(item.argumentDigest)))
    || !Array.isArray(task.managedRpcIds)
    || !task.managedRpcIds.every((id) => typeof id === 'string')) {
    throw new Error('invalid persisted task record');
  }
}

function validateReceipt(receipt) {
  if (!isObject(receipt) || receipt.version !== 1
    || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.commandId)
    || typeof receipt.generation !== 'string' || !receipt.generation
    || !['create', 'enqueue', 'resume', 'interrupt', 'cancel', 'approval'].includes(receipt.operation)
    || !/^[a-f0-9]{64}$/.test(receipt.digest)
    || !['accepted', 'completed', 'rejected', 'unknown'].includes(receipt.state)
    || !Number.isFinite(receipt.at)
    || !(receipt.taskId === null || typeof receipt.taskId === 'string')) {
    throw new Error('invalid command receipt');
  }
}

function replayReceipt(receipts, receipt) {
  if (!receipt) return;
  validateReceipt(receipt);
  const prior = receipts.get(receipt.commandId);
  if (prior && (prior.digest !== receipt.digest || prior.operation !== receipt.operation
    || prior.generation !== receipt.generation
    || prior.taskId !== receipt.taskId
    || prior.state !== 'accepted' || !['completed', 'rejected', 'unknown'].includes(receipt.state))) {
    throw new Error('command journal identity or transition conflict');
  }
  if (!prior && receipt.state !== 'accepted' && !(['create', 'enqueue'].includes(receipt.operation) && receipt.state === 'completed')) {
    throw new Error('command receipt has no accepted intent');
  }
  receipts.set(receipt.commandId, receipt);
}

function validateEvent(event) {
  if (!isObject(event) || !Number.isSafeInteger(event.seq) || event.seq < 1
    || !Number.isFinite(event.at) || !['created', 'updated', 'command'].includes(event.kind)) {
    throw new Error('invalid task journal entry');
  }
  if (event.receipt !== undefined) validateReceipt(event.receipt);
  if (event.kind === 'command') {
    if (!event.receipt || event.task !== undefined) throw new Error('invalid command journal entry');
    return;
  }
  validateTask(event.task);
  if (event.taskId !== event.task.id) throw new Error('task journal identity conflict');
  if (event.receipt && (event.kind !== 'created' || event.receipt.state !== 'completed'
    || event.receipt.taskId !== event.taskId)) throw new Error('invalid atomic create receipt');
}

function validateTransition(previous, task, kind) {
  if ((kind === 'created' && (previous || task.revision !== 1))
    || (kind === 'updated' && (task.revision < 2
      || (previous && task.revision !== previous.revision + 1)))
    || (previous && (task.createdAt !== previous.createdAt
      || task.idempotencyKey !== previous.idempotencyKey
      || task.queueOrder !== previous.queueOrder))) {
    throw new Error('task journal revision or identity conflict');
  }
}

function registerKey(owners, task) {
  if (!task.idempotencyKey) return;
  const owner = owners.get(task.idempotencyKey);
  if (owner && owner !== task.id) throw new Error('conflicting persisted idempotency ownership');
  owners.set(task.idempotencyKey, task.id);
}

function indexKey(key) {
  if (typeof key !== 'string') throw new Error('idempotency key must be a string');
  return `sha256-${createHash('sha256').update(key).digest('hex')}`;
}

async function putCache(table, key, value) {
  try {
    await table.put(key, value);
  } catch {
    // Snapshot and index writes are rebuildable; the journal already committed.
  }
}

/** Build a fresh task record with every persisted field present. */
export function newTaskRecord(input) {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    title: input.title,
    objective: input.objective,
    status: 'created',
    cwd: input.cwd,
    sessionId: null,
    goalId: null,
    goalRevision: 0,
    goalPhase: null,
    maxGoalRounds: input.maxGoalRounds,
    autoResume: input.autoResume,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    lastAssistantText: null,
    deliverables: [],
    pendingApproval: null,
    pendingApprovals: [],
    lastError: null,
    managedRpcIds: [],
    idempotencyKey: input.idempotencyKey ?? null,
    ...(input.localAuthorization !== undefined ? {
      localAuthorization: input.localAuthorization,
      queueOrder: input.queueOrder,
      recoveryRequired: false,
    } : {}),
  };
}

/**
 * Durable task store.
 *
 * The append-only journal is authoritative; the tasks table is a rebuildable
 * snapshot cache. Every write appends a full task snapshot to the journal
 * first, then updates the snapshot. A crash between the two is repaired on
 * the next load by replaying the journal.
 */
export class TaskStore {
  constructor({ domain, now = () => Date.now(), idFactory = () => `task-${randomUUID()}` }) {
    this.domain = domain;
    this.tables = {
      tasks: domain.table('tasks'),
      journal: domain.table('journal'),
      idempotency: domain.table('idempotency'),
    };
    this.now = now;
    this.idFactory = idFactory;
    this.seq = 0;
    this.cache = new Map();
    this.receipts = new Map();
    this.queue = Promise.resolve();
    this.failure = null;
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
  }

  async load() {
    return this.enqueue(async () => {
      this.cache = new Map();
      this.seq = 0;
      this.failure = new Error('task store is loading');
      try {
        const cache = new Map();
        const receipts = new Map();
        const owners = new Map();
        const events = [...this.tables.journal.entries()];
        for (const [key, event] of events) {
          validateEvent(event);
          if (key !== String(event.seq).padStart(8, '0')) {
            throw new Error('task journal sequence key conflict');
          }
        }
        events.sort(([, a], [, b]) => a.seq - b.seq);
        let seq = 0;
        for (const [, event] of events) {
          // v019 reserved numbers before writing; failed appends can leave gaps.
          if (event.seq <= seq) throw new Error('task journal sequence conflict');
          replayReceipt(receipts, event.receipt);
          if (event.kind !== 'command') {
            validateTransition(cache.get(event.taskId), event.task, event.kind);
            registerKey(owners, event.task);
            cache.set(event.taskId, event.task);
          }
          seq = event.seq;
        }
        const snapshots = new Map(this.tables.tasks.entries());
        // A snapshot written by an older build may have no journal entry yet.
        for (const [id, task] of snapshots) {
          if (cache.has(id)) continue;
          validateTask(task);
          if (id !== task.id) throw new Error('task snapshot identity conflict');
          registerKey(owners, task);
          cache.set(id, task);
        }
        // Publish only after the entire journal and legacy snapshots validate.
        this.cache = cache;
        this.receipts = receipts;
        this.seq = seq;
        this.failure = null;
        for (const [id, task] of cache) {
          // Journal wins even over a conflicting or higher-revision snapshot.
          if (!isDeepStrictEqual(snapshots.get(id), task)) {
            await putCache(this.tables.tasks, id, task);
          }
        }
        return this;
      } catch (error) {
        this.cache = new Map();
        this.receipts = new Map();
        this.seq = 0;
        this.failure = error;
        throw error;
      }
    });
  }

  list() {
    this.assertHealthy();
    return [...this.cache.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    this.assertHealthy();
    return this.cache.get(id);
  }

  async findByIdempotency(key) {
    this.assertHealthy();
    if (!key) return undefined;
    const storageKey = indexKey(key);
    try {
      const hit = this.tables.idempotency.get(storageKey);
      const task = hit && this.cache.get(hit.taskId);
      if (task && task.idempotencyKey === key) return task;
    } catch {
      // An unreadable index is also rebuildable from the original task key.
    }
    for (const task of this.cache.values()) {
      if (task.idempotencyKey === key) {
        await putCache(this.tables.idempotency, storageKey, { taskId: task.id });
        return task;
      }
    }
    return undefined;
  }

  async create(input) {
    return this.enqueue(async () => {
      this.assertHealthy();
      if (input.idempotencyKey) {
        const existing = await this.findByIdempotency(input.idempotencyKey);
        if (existing) return existing;
      }
      const task = newTaskRecord({
        id: this.idFactory(),
        title: input.title,
        objective: input.objective,
        cwd: input.cwd,
        maxGoalRounds: input.maxGoalRounds,
        autoResume: input.autoResume,
        idempotencyKey: input.idempotencyKey,
        now: this.now(),
        localAuthorization: input.localAuthorization,
        queueOrder: this.seq + 1,
      });
      const receipt = input.commandReceipt ? {
        ...input.commandReceipt, taskId: task.id, state: 'completed', at: this.now(),
        revision: task.revision,
      } : undefined;
      await this.appendRecord(task, 'created', receipt);
      if (input.idempotencyKey) {
        await putCache(this.tables.idempotency, indexKey(input.idempotencyKey), { taskId: task.id });
      }
      return task;
    });
  }

  async update(id, patch) {
    return this.enqueue(async () => {
      this.assertHealthy();
      const current = this.cache.get(id);
      if (!current) throw new Error(`task not found: ${id}`);
      const resolved = typeof patch === 'function' ? patch(current) : patch;
      const next = {
        ...current,
        ...resolved,
        updatedAt: this.now(),
        revision: current.revision + 1,
      };
      if (next.id !== id) throw new Error('task identity cannot change');
      await this.appendRecord(next, 'updated');
      return next;
    });
  }

  async append(task, kind) {
    return this.enqueue(() => this.appendRecord(task, kind));
  }

  receipt(commandId) {
    this.assertHealthy();
    const receipt = this.receipts.get(commandId);
    return receipt ? structuredClone(receipt) : null;
  }

  unresolved() {
    this.assertHealthy();
    return [...this.receipts.values()].filter(r => ['accepted', 'unknown'].includes(r.state)).map(r => structuredClone(r));
  }

  async writeReceipt(receipt, validate = () => {}) {
    return this.enqueue(async () => {
      this.assertHealthy();
      validate();
      const next = { ...receipt, at: this.now() };
      await this.commitEvent({ seq: this.seq + 1, at: this.now(), kind: 'command', receipt: next });
      return structuredClone(next);
    });
  }

  async appendRecord(task, kind, receipt) {
    this.assertHealthy();
    const event = { seq: this.seq + 1, taskId: task.id, at: this.now(), kind, task,
      ...(receipt ? { receipt } : {}) };
    validateTransition(this.cache.get(task.id), task, kind);
    const owners = new Map();
    for (const stored of this.cache.values()) registerKey(owners, stored);
    registerKey(owners, task);
    await this.commitEvent(event);
    await putCache(this.tables.tasks, task.id, task);
  }

  async commitEvent(event) {
    validateEvent(event);
    const receipts = new Map(this.receipts);
    replayReceipt(receipts, event.receipt);
    try {
      await this.tables.journal.put(String(event.seq).padStart(8, '0'), event);
    } catch (cause) {
      // A rejected write may already be durable. Never overwrite its sequence.
      this.failure = new Error('task journal write failed; reload required', { cause });
      throw this.failure;
    }
    this.seq = event.seq;
    this.receipts = receipts;
    if (event.task) this.cache.set(event.taskId, event.task);
  }
}
