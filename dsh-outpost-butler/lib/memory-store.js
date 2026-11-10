import { randomUUID } from 'node:crypto';
import { MEMORY_KINDS, MEMORY_LIMITS, MEMORY_ID_PATTERN, BUTLER_ID_PATTERN } from './memory-limits.js';
import { TaskError } from './task-manager.js';

const JOURNAL_COMPACT_AT = 256;

function validateChange(change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)
    || !Number.isSafeInteger(change.seq) || change.seq < 1 || !Number.isFinite(change.at)
    || !['set', 'delete'].includes(change.action) || typeof change.id !== 'string'
    || !MEMORY_ID_PATTERN.test(change.id)
    || (change.kind !== undefined && !MEMORY_KINDS.includes(change.kind))
    || (change.key !== undefined && (typeof change.key !== 'string' || change.key.length > MEMORY_LIMITS.key))
    || (change.revision !== undefined && (!Number.isSafeInteger(change.revision) || change.revision < 1))) {
    throw new Error('invalid memory change');
  }
  return change;
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.id !== 'string' || !MEMORY_ID_PATTERN.test(entry.id)
    || !MEMORY_KINDS.includes(entry.kind)
    || typeof entry.key !== 'string' || !entry.key || entry.key.length > MEMORY_LIMITS.key
    || typeof entry.value !== 'string' || !entry.value || entry.value.length > MEMORY_LIMITS.value
    || entry.source !== 'user' || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)
    || !Number.isSafeInteger(entry.revision) || entry.revision < 1) {
    throw new Error('invalid memory entry');
  }
  return entry;
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
    || !Number.isSafeInteger(event.seq) || event.seq < 1 || !Number.isFinite(event.at)) {
    throw new Error('invalid memory event');
  }
  if (event.kind === 'snapshot') {
    if (!Array.isArray(event.entries) || event.entries.length > MEMORY_LIMITS.entries
      || !Array.isArray(event.changes) || event.changes.length > MEMORY_LIMITS.history) {
      throw new Error('invalid memory snapshot');
    }
    for (const entry of event.entries) validateEntry(entry);
    for (const change of event.changes) validateChange(change);
  } else if (event.kind === 'set') {
    validateEntry(event.entry);
  } else if (event.kind === 'delete') {
    if (typeof event.id !== 'string' || !MEMORY_ID_PATTERN.test(event.id)) throw new Error('invalid memory event');
  } else {
    throw new Error('invalid memory event');
  }
  return event;
}

function memoryError(code, message, status = 400) {
  return new TaskError(code, message, status);
}

function normalizeText(value, field, max) {
  if (typeof value !== 'string') throw memoryError('memory-arguments', `${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) throw memoryError('memory-arguments', `${field} must be 1..${max} characters`);
  return text;
}

/**
 * Durable user-managed butler memory.
 *
 * The journal is authoritative; the in-memory map is a replay cache. A snapshot
 * event is appended only to compact a long journal, so a crash between the
 * snapshot append and deleting old keys is safe: load starts at the newest
 * snapshot. No task, approval or tool-policy code reads this store.
 */
export class MemoryStore {
  constructor({ domain, now = () => Date.now(), idFactory = () => `mem-${randomUUID()}` }) {
    this.tables = { meta: domain.table('meta'), journal: domain.table('journal') };
    this.now = now;
    this.idFactory = idFactory;
    this.seq = 0;
    this.butlerId = null;
    this.entries = new Map();
    this.changes = [];
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
      this.failure = new Error('memory store is loading');
      try {
        let identity = this.tables.meta.get('identity');
        if (!identity) {
          identity = { butlerId: randomUUID() };
          await this.tables.meta.put('identity', identity);
        }
        if (!identity || typeof identity.butlerId !== 'string' || !BUTLER_ID_PATTERN.test(identity.butlerId)) {
          throw new Error('invalid butler identity');
        }
        const events = [...this.tables.journal.entries()];
        for (const [key, event] of events) {
          validateEvent(event);
          if (key !== String(event.seq).padStart(8, '0')) throw new Error('memory journal sequence key conflict');
        }
        events.sort(([, a], [, b]) => a.seq - b.seq);
        let start = -1;
        for (let index = events.length - 1; index >= 0; index -= 1) {
          if (events[index][1].kind === 'snapshot') { start = index; break; }
        }
        const snapshot = start >= 0 ? events[start][1] : null;
        const entries = new Map();
        if (snapshot) {
          for (const entry of snapshot.entries) {
            validateEntry(entry);
            if (entries.has(entry.id)) throw new Error('duplicate memory entry in snapshot');
            entries.set(entry.id, { ...entry });
          }
        }
        const changes = snapshot ? snapshot.changes.map(change => ({ ...change })) : [];
        let seq = snapshot ? snapshot.seq : 0;
        for (const [, event] of snapshot ? events.slice(start + 1) : events) {
          if (event.seq <= seq) throw new Error('memory journal sequence conflict');
          seq = event.seq;
          if (event.kind === 'set') {
            validateEntry(event.entry);
            entries.set(event.entry.id, { ...event.entry });
            changes.push({ seq: event.seq, at: event.at, action: 'set', id: event.entry.id, kind: event.entry.kind, key: event.entry.key, revision: event.entry.revision });
          } else if (event.kind === 'delete') {
            entries.delete(event.id);
            changes.push({ seq: event.seq, at: event.at, action: 'delete', id: event.id });
          }
          if (entries.size > MEMORY_LIMITS.entries) throw new Error('memory entry limit exceeded');
        }
        this.butlerId = identity.butlerId;
        this.entries = entries;
        this.seq = seq;
        this.changes = changes.slice(-MEMORY_LIMITS.history);
        this.failure = null;
        if (events.length > JOURNAL_COMPACT_AT) await this.compact();
        return this;
      } catch (error) {
        this.entries = new Map();
        this.changes = [];
        this.seq = 0;
        this.butlerId = null;
        this.failure = error instanceof TaskError ? error : new Error('butler memory is corrupt', { cause: error });
        throw this.failure;
      }
    });
  }

  identity() {
    this.assertHealthy();
    return { butlerId: this.butlerId };
  }

  revision() {
    this.assertHealthy();
    return this.seq;
  }

  list() {
    this.assertHealthy();
    return [...this.entries.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
      .map(entry => ({ ...entry }));
  }

  snapshot() {
    return { butlerId: this.butlerId, revision: this.seq, entries: this.list() };
  }

  history(id = null) {
    this.assertHealthy();
    return this.changes
      .filter(change => !id || change.id === id)
      .slice(-MEMORY_LIMITS.history)
      .map(change => ({ ...change }));
  }

  async set(input = {}) {
    return this.enqueue(async () => {
      this.assertHealthy();
      const kind = input.kind;
      if (!MEMORY_KINDS.includes(kind)) throw memoryError('memory-kind', 'kind must be preference or project');
      const key = normalizeText(input.key, 'key', MEMORY_LIMITS.key);
      const value = normalizeText(input.value, 'value', MEMORY_LIMITS.value);
      if (input.id !== undefined && (typeof input.id !== 'string' || !/^mem-[0-9a-f-]{36}$/.test(input.id))) {
        throw memoryError('memory-id', 'invalid memory id');
      }
      if (input.expectedRevision !== undefined
        && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) {
        throw memoryError('memory-revision', 'invalid expectedRevision');
      }
      let prior = input.id ? this.entries.get(input.id) : [...this.entries.values()].find(entry => entry.kind === kind && entry.key === key);
      if (input.id && !prior) throw memoryError('memory-not-found', 'memory entry not found', 404);
      if (prior && input.expectedRevision !== undefined && prior.revision !== input.expectedRevision) {
        throw memoryError('memory-conflict', 'memory entry changed', 409);
      }
      const other = [...this.entries.values()].find(entry => entry.kind === kind && entry.key === key && entry.id !== prior?.id);
      if (other) throw memoryError('memory-key-conflict', 'key already exists for this kind', 409);
      const at = this.now();
      const entry = prior ? {
        ...prior, kind, key, value, updatedAt: at, revision: prior.revision + 1,
      } : {
        id: this.idFactory(), kind, key, value, source: 'user', createdAt: at, updatedAt: at, revision: 1,
      };
      if (!prior && this.entries.size >= MEMORY_LIMITS.entries) throw memoryError('memory-full', 'memory entry limit reached', 409);
      validateEntry(entry);
      const event = { seq: this.seq + 1, at, kind: 'set', entry: { ...entry } };
      await this.tables.journal.put(String(event.seq).padStart(8, '0'), event);
      this.entries.set(entry.id, entry);
      this.seq = event.seq;
      this.changes.push({ seq: event.seq, at, action: 'set', id: entry.id, kind, key, revision: entry.revision });
      this.changes = this.changes.slice(-MEMORY_LIMITS.history);
      await this.maybeCompact();
      return { ...entry };
    });
  }

  async delete(input = {}) {
    return this.enqueue(async () => {
      this.assertHealthy();
      const id = input.id;
      if (typeof id !== 'string' || !/^mem-[0-9a-f-]{36}$/.test(id)) throw memoryError('memory-id', 'invalid memory id');
      const prior = this.entries.get(id);
      if (!prior) throw memoryError('memory-not-found', 'memory entry not found', 404);
      if (input.expectedRevision !== undefined
        && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== prior.revision)) {
        throw memoryError('memory-conflict', 'memory entry changed', 409);
      }
      const at = this.now();
      const event = { seq: this.seq + 1, at, kind: 'delete', id };
      await this.tables.journal.put(String(event.seq).padStart(8, '0'), event);
      this.entries.delete(id);
      this.seq = event.seq;
      this.changes.push({ seq: event.seq, at, action: 'delete', id });
      this.changes = this.changes.slice(-MEMORY_LIMITS.history);
      await this.maybeCompact();
      return { id, revision: this.revision() };
    });
  }

  async maybeCompact() {
    if (this.tables.journal.entries().length > JOURNAL_COMPACT_AT) await this.compact();
  }

  async compact() {
    const entries = [...this.entries.values()].map(entry => ({ ...entry }));
    const event = { seq: this.seq + 1, at: this.now(), kind: 'snapshot', entries, changes: this.changes.slice(-MEMORY_LIMITS.history) };
    validateEvent(event);
    await this.tables.journal.put(String(event.seq).padStart(8, '0'), event);
    this.seq = event.seq;
    const keep = String(event.seq).padStart(8, '0');
    for (const [key] of this.tables.journal.entries()) {
      if (key !== keep) await this.tables.journal.delete(key);
    }
  }
}
