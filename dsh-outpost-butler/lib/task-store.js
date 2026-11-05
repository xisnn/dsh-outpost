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
    || !Array.isArray(task.managedRpcIds)
    || !task.managedRpcIds.every((id) => typeof id === 'string')) {
    throw new Error('invalid persisted task record');
  }
}

function validateEvent(event) {
  if (!isObject(event) || !Number.isSafeInteger(event.seq) || event.seq < 1
    || !Number.isFinite(event.at) || !['created', 'updated'].includes(event.kind)) {
    throw new Error('invalid task journal entry');
  }
  validateTask(event.task);
  if (event.taskId !== event.task.id) throw new Error('task journal identity conflict');
}

function validateTransition(previous, task, kind) {
  if ((kind === 'created' && (previous || task.revision !== 1))
    || (kind === 'updated' && (task.revision < 2
      || (previous && task.revision !== previous.revision + 1)))
    || (previous && (task.createdAt !== previous.createdAt
      || task.idempotencyKey !== previous.idempotencyKey))) {
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
          validateTransition(cache.get(event.taskId), event.task, event.kind);
          registerKey(owners, event.task);
          cache.set(event.taskId, event.task);
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
      });
      await this.appendRecord(task, 'created');
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

  async appendRecord(task, kind) {
    this.assertHealthy();
    const seq = this.seq + 1;
    const event = { seq, taskId: task.id, at: this.now(), kind, task };
    validateEvent(event);
    validateTransition(this.cache.get(task.id), task, kind);
    const owners = new Map();
    for (const stored of this.cache.values()) registerKey(owners, stored);
    registerKey(owners, task);
    try {
      await this.tables.journal.put(String(seq).padStart(8, '0'), event);
    } catch (cause) {
      // A rejected write may already be durable. Never overwrite its sequence.
      this.failure = new Error('task journal write failed; reload required', { cause });
      throw this.failure;
    }
    this.seq = seq;
    this.cache.set(task.id, task);
    await putCache(this.tables.tasks, task.id, task);
  }
}
