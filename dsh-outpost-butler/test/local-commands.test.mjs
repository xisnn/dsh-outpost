import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalCommands, argumentDigest } from '../lib/commands.js';
import { TaskStore } from '../lib/task-store.js';
import { TaskManager } from '../lib/task-manager.js';
import { LocalApprovals } from '../lib/local-approvals.js';

class FakeTable {
  map = new Map();
  attempts = [];
  fault = null;
  beforePut = null;

  get(key) { return structuredClone(this.map.get(key)); }
  *entries() {
    for (const [key, value] of this.map) yield [key, structuredClone(value)];
  }
  get size() { return this.map.size; }
  async delete(key) { return this.map.delete(key); }
  failNext(when, matches = () => true) {
    this.fault = { when, matches, error: new Error(`injected ${when} write failure`) };
  }
  async put(key, value) {
    this.attempts.push({ key, value: structuredClone(value) });
    await this.beforePut?.(key, structuredClone(value));
    const fault = this.fault?.matches(value) ? this.fault : null;
    if (fault) this.fault = null;
    if (fault?.when === 'before') throw fault.error;
    this.map.set(key, structuredClone(value));
    if (fault?.when === 'after') throw fault.error;
  }
}

class FakeDomain {
  tables = { tasks: new FakeTable(), journal: new FakeTable(), idempotency: new FakeTable() };
  table(name) { return this.tables[name]; }
}

class FakeGoals {
  byAgent = new Map();
  calls = [];
  counter = 0;
  create(agent, { objective, maxGoalRounds }) {
    this.calls.push({ operation: 'create', agentId: agent.id, objective });
    const goal = { id: `goal-${++this.counter}`, revision: 1, objective,
      phase: 'active', activation: 'armed', maxGoalRounds, roundsStarted: 0 };
    this.byAgent.set(agent.id, goal);
    return goal;
  }
  get(agent) { return this.byAgent.get(agent.id); }
  pause(agent) { return this.change(agent, 'pause', 'paused', 'disarmed'); }
  resume(agent) { return this.change(agent, 'resume', 'active', 'armed'); }
  change(agent, operation, phase, activation) {
    this.calls.push({ operation, agentId: agent.id });
    const goal = this.get(agent);
    if (!goal) return undefined;
    const next = { ...goal, revision: goal.revision + 1, phase, activation };
    this.byAgent.set(agent.id, next);
    return next;
  }
}

class FakeSessions {
  byId = new Map();
  created = [];
  resolved = [];
  cancelled = [];
  async create({ cwd }) {
    const id = `session-${this.created.length + 1}`;
    this.created.push({ id, cwd });
    this.byId.set(id, { id, status: 'idle', session: { id, cwd },
      cancel: () => this.cancelled.push(id) });
    return { sessionId: id };
  }
  async resolveAgent(id) {
    this.resolved.push(id);
    const agent = this.byId.get(id);
    return agent ? { agent } : { error: { code: 'session/not-found' } };
  }
  get(id) { return this.byId.get(id); }
}

// Exercise the actual registered guard and event handlers, including unsubscription.
class FakeContext {
  handlers = new Map();
  guards = new Set();
  tools = { guard: handler => {
    this.guards.add(handler);
    return () => this.guards.delete(handler);
  } };
  on(name, handler) {
    assert.equal(this.handlers.has(name), false);
    this.handlers.set(name, handler);
    return () => this.handlers.delete(name);
  }
  emit(name, ...args) {
    const handler = this.handlers.get(name);
    assert.ok(handler, `missing event handler for ${name}`);
    return handler(...args);
  }
  guard(exec) {
    for (const handler of this.guards) {
      const denial = handler(exec);
      if (denial !== undefined) return denial;
    }
    return undefined;
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

async function fixture(t, { now = () => 1000, timeoutMs = 60_000 } = {}) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'butler-local-')));
  const domain = new FakeDomain();
  const sessions = new FakeSessions();
  const goals = new FakeGoals();
  const runtimes = [];
  let nextId = 0;
  async function open(generation = 'generation-1') {
    const store = new TaskStore({ domain, now, idFactory: () => `task-${++nextId}` });
    await store.load();
    const manager = new TaskManager({ store, sessions, agents: sessions, goals,
      sessionController: sessions, now, logger: { warn() {}, info() {} },
      localRuntime: { generation } });
    const ctx = new FakeContext();
    const approvals = new LocalApprovals({ ctx, manager, generation, timeoutMs, now });
    const commands = new LocalCommands({ manager, store, generation, workspaceRoot: workspace, approvals, now });
    const runtime = { manager, store, ctx, approvals, commands, generation,
      envelope: (commandId, operation, args) => ({ version: 1, commandId, generation, operation, args }),
      async close() {
        await commands.dispose();
        await manager.dispose();
      } };
    runtimes.push(runtime);
    await manager.init();
    await commands.init();
    return runtime;
  }
  t.after(async () => {
    try {
      for (const runtime of runtimes.toReversed()) await runtime.close();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
  return { workspace, domain, sessions, goals, open, runtime: await open() };
}

async function create(runtime, commandId = 'create-1', objective = commandId, operation = 'create') {
  return runtime.commands.submit(runtime.envelope(commandId, operation, { objective }));
}
async function running(runtime, taskId) {
  await waitFor(() => runtime.store.get(taskId)?.status === 'running');
  return runtime.store.get(taskId);
}
function taskCommand(runtime, commandId, operation, taskId, extra = {}) {
  return runtime.envelope(commandId, operation, { taskId, revision: runtime.store.get(taskId).revision, ...extra });
}
async function complete(runtime, goals, sessions, taskId) {
  const task = runtime.store.get(taskId);
  const agent = sessions.get(task.sessionId);
  const goal = { ...goals.get(agent), revision: goals.get(agent).revision + 1,
    phase: 'complete', activation: 'disarmed' };
  goals.byAgent.set(agent.id, goal);
  await runtime.manager.handleSessionEvent(taskId, { type: 'goal/change', data: { goal } });
}
function beginApproval(runtime, taskId, { callId = 'write-1', name = 'write',
  args = { path: 'report.txt', content: 'approved contents' } } = {}) {
  const task = runtime.store.get(taskId);
  const agent = runtime.manager.agents.get(task.sessionId);
  const abort = new AbortController();
  const exec = { agent, name, callId, arguments: args, signal: abort.signal };
  assert.equal(runtime.ctx.guard(exec), undefined);
  assert.equal(runtime.ctx.emit('tools/pre-execute', exec, () => ({ kind: 'allow' })).kind, 'ask');
  const req = { agent, toolName: name, callId, signal: abort.signal };
  const outcome = runtime.ctx.emit('approval/request', req, () => 'fallback');
  assert.ok(outcome instanceof Promise);
  const entry = runtime.approvals.list().find(item => item.toolCallId === callId);
  assert.ok(entry);
  return { exec, req, abort, outcome, entry, args: { taskId, revision: task.revision,
    approvalId: entry.id, toolCallId: callId, argumentDigest: entry.argumentDigest, decision: 'allowed-once' } };
}

test('reconciliation stays within pipe budget while preserving live approval capabilities', () => {
  const writes = Array.from({ length: 16 }, (_, i) => ({ callId: 'call-' + i, argumentDigest: 'a'.repeat(64) }));
  const tasks = Array.from({ length: 200 }, (_, i) => ({ id: 'task-' + i, revision: 2,
    status: 'waiting_user', queueOrder: i + 1, localAuthorization: null, recoveryRequired: true, unsettledWrites: writes }));
  const pending = Array.from({ length: 8 }, (_, i) => ({ id: 'approval-' + i, arguments: { content: '中'.repeat(2000) } }));
  const unresolved = Array.from({ length: 200 }, (_, i) => ({ commandId: 'command-' + i, state: 'unknown', detail: 'x'.repeat(400) }));
  const commands = new LocalCommands({ manager: {}, store: { list: () => tasks, unresolved: () => unresolved },
    generation: 'generation-budget', workspaceRoot: path.resolve('workspace'), approvals: { list: () => pending } });
  const result = commands.reconcile();
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 128 * 1024);
  assert.equal(result.totalTasks, 200); assert.equal(result.totalUnresolved, 200);
  assert.equal(result.tasksTruncated, true); assert.equal(result.unresolvedTruncated, true);
  assert.deepEqual(result.approvals, pending);
  assert.ok(result.tasks.every(task => task.recoveryRequired));
});

test('resume cannot authorize a task belonging to another workspace', async t => {
  const { runtime: r, sessions } = await fixture(t);
  const created = await create(r); await running(r, created.taskId);
  await r.manager.waitUser(created.taskId, 'goal-paused');
  await r.store.update(created.taskId, { cwd: path.dirname(r.commands.workspace) });
  const before = sessions.resolved.length;
  await assert.rejects(r.commands.submit(taskCommand(r, 'foreign-resume', 'resume', created.taskId)), error => error.code === 'workspace-conflict');
  assert.equal(sessions.resolved.length, before);
  assert.equal(r.commands.receipt('foreign-resume'), null);
});

test('revision is rechecked inside the durable intent queue before dispatch', async t => {
  const { runtime: r, domain, sessions } = await fixture(t);
  const created = await create(r); await running(r, created.taskId);
  let entered, release;
  const held = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  domain.tables.journal.beforePut = async (_key, event) => {
    if (event.task?.lastError === 'concurrent-event') { entered(); await gate; }
  };
  const command = taskCommand(r, 'stale-queued-cancel', 'cancel', created.taskId);
  const event = r.store.update(created.taskId, { lastError: 'concurrent-event' });
  await held;
  const submitted = r.commands.submit(command);
  const rejected = assert.rejects(submitted, error => error.code === 'revision-conflict');
  await new Promise(setImmediate); release(); await event; await rejected;
  assert.equal(sessions.cancelled.length, 0);
  assert.equal(r.commands.receipt(command.commandId), null);
});

// Receipt identity and atomic creation are asserted against durable events and
// actual DSH dispatch counts, rather than messages or private helper source text.
test('concurrent identical create IDs commit exactly one task and atomic receipt', async t => {
  const { runtime: r, domain, sessions, goals, workspace } = await fixture(t);
  const envelope = r.envelope('concurrent-create', 'create', { objective: 'one durable task', maxGoalRounds: 4 });
  const receipts = await Promise.all(Array.from({ length: 24 }, () => r.commands.submit(envelope)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  const receipt = receipts[0];
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.digest, argumentDigest(envelope));
  await running(r, receipt.taskId);
  assert.equal(r.store.list().length, 1);
  assert.equal(sessions.created.length, 1);
  assert.equal(goals.calls.filter(call => call.operation === 'create').length, 1);
  assert.equal(r.store.get(receipt.taskId).cwd, workspace);
  assert.equal(r.store.get(receipt.taskId).autoResume, false);
  assert.equal(r.store.get(receipt.taskId).maxGoalRounds, 4);
  const events = [...domain.tables.journal.entries()].map(([, event]) => event);
  const creations = events.filter(event => event.kind === 'created');
  assert.equal(creations.length, 1);
  assert.deepEqual(creations[0].receipt, receipt);
  assert.equal(creations[0].task.id, receipt.taskId);
  assert.equal(events.filter(event => event.receipt?.commandId === envelope.commandId).length, 1);
  const queried = r.commands.receipt(envelope.commandId);
  queried.state = 'unknown';
  assert.deepEqual(r.commands.receipt(envelope.commandId), receipt);
});

test('same command ID with conflicting arguments or operation never creates a second task', async t => {
  const { runtime: r, domain, sessions } = await fixture(t);
  const envelope = r.envelope('conflict', 'create', { objective: 'original', title: 'Original' });
  const attempts = await Promise.allSettled([
    r.commands.submit(envelope),
    r.commands.submit({ ...envelope, args: { objective: 'changed', title: 'Original' } }),
    r.commands.submit({ ...envelope, operation: 'enqueue' }),
  ]);
  assert.equal(attempts[0].status, 'fulfilled');
  for (const attempt of attempts.slice(1)) {
    assert.equal(attempt.status, 'rejected');
    assert.equal(attempt.reason.code, 'command-conflict');
  }
  await running(r, attempts[0].value.taskId);
  const writes = domain.tables.journal.attempts.length;
  // Object property order is not a conflicting argument.
  assert.deepEqual(await r.commands.submit({ ...envelope, args: { title: 'Original', objective: 'original' } }), attempts[0].value);
  assert.equal(domain.tables.journal.attempts.length, writes);
  assert.equal(r.store.list().length, 1);
  assert.equal(sessions.created.length, 1);
});

test('journal restores tasks and receipts after snapshot and index cache loss', async t => {
  const f = await fixture(t);
  const r = f.runtime;
  f.domain.tables.tasks.failNext('before');
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const queued = await create(r, 'queued', 'second', 'enqueue');
  const originals = new Map(r.store.list().map(task => [task.id, structuredClone(task)]));
  await r.close();
  f.domain.tables.tasks.map.clear();
  f.domain.tables.idempotency.map.clear();
  const reopened = new TaskStore({ domain: f.domain });
  await reopened.load();
  assert.deepEqual(new Map(reopened.list().map(task => [task.id, task])), originals);
  assert.deepEqual(reopened.receipt('create-1'), receipt);
  assert.deepEqual(reopened.receipt('queued'), queued);
  assert.equal(f.domain.tables.tasks.size, 2);
  assert.equal(f.sessions.created.length, 1);
});

test('only explicit enqueue accepts work behind the active task and it runs FIFO', async t => {
  const { runtime: r, domain, sessions, goals } = await fixture(t);
  const first = await create(r, 'first');
  await running(r, first.taskId);
  const writes = domain.tables.journal.attempts.length;
  await assert.rejects(create(r, 'implicit'), { code: 'busy-use-enqueue' });
  assert.equal(r.commands.receipt('implicit'), null);
  assert.equal(domain.tables.journal.attempts.length, writes);
  const second = await create(r, 'second', 'second objective', 'enqueue');
  const third = await create(r, 'third', 'third objective', 'enqueue');
  assert.equal(r.store.get(second.taskId).status, 'created');
  assert.equal(r.store.get(third.taskId).status, 'created');
  assert.ok(r.store.get(second.taskId).queueOrder < r.store.get(third.taskId).queueOrder);
  assert.equal(sessions.created.length, 1);
  await complete(r, goals, sessions, first.taskId);
  await running(r, second.taskId);
  assert.equal(r.store.get(third.taskId).status, 'created');
  await complete(r, goals, sessions, second.taskId);
  await running(r, third.taskId);
  assert.deepEqual(goals.calls.filter(call => call.operation === 'create').map(call => call.objective),
    ['first', 'second objective', 'third objective']);
  assert.equal(r.store.get(first.taskId).status, 'completed');
  assert.equal(r.store.get(second.taskId).status, 'completed');
});

test('local restart disables persisted autoResume and leaves the created queue unexecuted', async t => {
  const f = await fixture(t);
  const r = f.runtime;
  const first = await create(r, 'active');
  const task = await running(r, first.taskId);
  const second = await create(r, 'queued', 'queued objective', 'enqueue');
  await r.manager.persist(first.taskId, { autoResume: true });
  await r.manager.persist(second.taskId, { autoResume: true });
  f.goals.pause(f.sessions.get(task.sessionId));
  await r.close();
  const before = { creates: f.sessions.created.length, resolves: f.sessions.resolved.length, goals: f.goals.calls.length };
  const next = await f.open('generation-2');
  const recovered = next.store.get(first.taskId);
  const queued = next.store.get(second.taskId);
  assert.equal(recovered.status, 'waiting_user');
  assert.equal(recovered.recoveryRequired, true);
  assert.equal(queued.status, 'created');
  for (const record of [recovered, queued]) {
    assert.equal(record.autoResume, false);
    assert.equal(record.localAuthorization, null);
  }
  next.manager.pump();
  await next.store.queue;
  assert.equal(next.manager.activeTaskId, null);
  assert.deepEqual(next.manager.queue, []);
  assert.deepEqual({ creates: f.sessions.created.length, resolves: f.sessions.resolved.length, goals: f.goals.calls.length }, before);
  const state = next.commands.reconcile();
  assert.equal(state.generation, 'generation-2');
  assert.equal(state.autoResume, false);
  assert.ok(state.tasks.every(item => item.authorized === false));
  await assert.rejects(next.commands.submit(taskCommand(next, 'unsafe-resume', 'resume', first.taskId)), { code: 'reconciliation-required' });
  // A never-started queued task can be explicitly authorized in the new process.
  await next.commands.submit(taskCommand(next, 'authorize-queued', 'resume', second.taskId));
  await running(next, second.taskId);
  assert.equal(next.store.get(first.taskId).status, 'waiting_user');
  assert.equal(f.sessions.created.length, before.creates + 1);
});

test('stale generation and revision reject before journal writes or dispatch', async t => {
  const { runtime: r, domain, sessions } = await fixture(t);
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const envelope = taskCommand(r, 'stale-revision', 'cancel', receipt.taskId);
  await r.manager.persist(receipt.taskId, { title: 'new revision' });
  const writes = domain.tables.journal.attempts.length;
  await assert.rejects(r.commands.submit(envelope), { code: 'revision-conflict' });
  await assert.rejects(r.commands.submit({ ...taskCommand(r, 'stale-generation', 'cancel', receipt.taskId), generation: 'old' }), { code: 'stale-generation' });
  assert.equal(domain.tables.journal.attempts.length, writes);
  assert.equal(sessions.cancelled.length, 0);
  assert.equal(r.store.get(receipt.taskId).status, 'running');
  assert.equal(r.commands.receipt('stale-revision'), null);
  assert.equal(r.commands.receipt('stale-generation'), null);
});

test('accepted intent becomes queryable unknown on restart and neither old nor rebased retry dispatches', async t => {
  const f = await fixture(t);
  const r = f.runtime;
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const envelope = taskCommand(r, 'lost-response', 'cancel', receipt.taskId);
  await r.store.writeReceipt({ version: 1, commandId: envelope.commandId, generation: r.generation,
    operation: envelope.operation, digest: argumentDigest(envelope), taskId: receipt.taskId, state: 'accepted', at: 1000 });
  await r.close();
  const next = await f.open('generation-2');
  const unknown = next.commands.receipt(envelope.commandId);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.taskId, receipt.taskId);
  assert.equal(next.commands.reconcile().unresolved.some(item => item.commandId === envelope.commandId), true);
  const writes = f.domain.tables.journal.attempts.length;
  const goalCalls = f.goals.calls.length;
  await assert.rejects(next.commands.submit(envelope), { code: 'stale-generation' });
  await assert.rejects(next.commands.submit({ ...envelope, generation: next.generation }), { code: 'command-conflict' });
  await assert.rejects(next.commands.submit(taskCommand(next, 'different-resume', 'resume', receipt.taskId)), { code: 'reconciliation-required' });
  assert.equal(f.domain.tables.journal.attempts.length, writes);
  assert.equal(f.sessions.cancelled.length, 0);
  assert.equal(f.goals.calls.length, goalCalls);
  // Even if the caller retains its old generation, receipt replay cannot dispatch.
  const oldGenerationView = new LocalCommands({ manager: next.manager, store: next.store,
    generation: r.generation, workspaceRoot: f.workspace });
  await oldGenerationView.init();
  assert.deepEqual(await oldGenerationView.submit(envelope), unknown);
  await oldGenerationView.dispose();
  assert.equal(f.sessions.cancelled.length, 0);
});

for (const when of ['before', 'after']) {
  test(`atomic create journal ${when}-commit exception poisons writes and never dispatches`, async t => {
    const f = await fixture(t);
    const r = f.runtime;
    const envelope = r.envelope('uncertain-create', 'create', { objective: 'must not dispatch on failed append' });
    f.domain.tables.journal.failNext(when, event => event.kind === 'created');
    await assert.rejects(r.commands.submit(envelope));
    const attempts = f.domain.tables.journal.attempts.length;
    for (const read of [() => r.store.list(), () => r.commands.receipt(envelope.commandId), () => r.commands.reconcile()]) assert.throws(read);
    await assert.rejects(r.commands.submit(envelope));
    await assert.rejects(r.store.create({ title: 'later', objective: 'later', cwd: f.workspace, maxGoalRounds: 2, autoResume: false }));
    assert.equal(f.domain.tables.journal.attempts.length, attempts);
    assert.equal(f.sessions.created.length, 0);
    assert.equal(f.goals.calls.length, 0);
    assert.equal(f.domain.tables.tasks.size, 0);
    await r.close();
    // Reopen using the same generation deliberately to exercise receipt replay,
    // independently of the separate stale-generation protection.
    const next = await f.open(r.generation);
    if (when === 'before') {
      assert.equal(next.store.list().length, 0);
      assert.equal(next.commands.receipt(envelope.commandId), null);
    } else {
      const receipt = next.commands.receipt(envelope.commandId);
      assert.equal(receipt.state, 'completed');
      assert.equal(next.store.list().length, 1);
      assert.equal(next.store.get(receipt.taskId).status, 'created');
      assert.deepEqual(await next.commands.submit(envelope), receipt);
    }
    next.manager.pump();
    assert.equal(f.sessions.created.length, 0);
  });
}

for (const phase of ['accepted', 'task', 'completed']) {
  for (const when of ['before', 'after']) {
    test(`cancel ${phase} journal ${when}-commit exception poisons store and cannot replay its effect`, async t => {
      const f = await fixture(t);
      const r = f.runtime;
      const created = await create(r);
      await running(r, created.taskId);
      const envelope = taskCommand(r, 'uncertain-cancel', 'cancel', created.taskId);
      f.domain.tables.journal.failNext(when, event => phase === 'task'
        ? event.kind === 'updated' && event.task.id === created.taskId && event.task.status === 'cancelled'
        : event.receipt?.commandId === envelope.commandId && event.receipt.state === phase);
      await assert.rejects(r.commands.submit(envelope));
      const attempts = f.domain.tables.journal.attempts.length;
      const effects = phase === 'accepted' ? 0 : 1;
      assert.equal(f.sessions.cancelled.length, effects);
      assert.throws(() => r.commands.receipt(envelope.commandId));
      await assert.rejects(r.commands.submit(envelope));
      await assert.rejects(r.store.update(created.taskId, { title: 'must not write' }));
      assert.equal(f.domain.tables.journal.attempts.length, attempts);
      assert.equal(f.sessions.cancelled.length, effects);
      await r.close();
      const next = await f.open(r.generation);
      const receipt = next.commands.receipt(envelope.commandId);
      if (phase === 'accepted' && when === 'before') {
        assert.equal(receipt, null);
      } else {
        assert.equal(receipt.state, phase === 'completed' && when === 'after' ? 'completed' : 'unknown');
        assert.deepEqual(await next.commands.submit(envelope), receipt);
      }
      assert.equal(f.sessions.cancelled.length, effects);
      assert.equal(f.sessions.created.length, 1);
    });
  }
}

test('an exception after cancellation yields unknown; retry returns it without another DSH call', async t => {
  const { runtime: r, sessions } = await fixture(t);
  const receipt = await create(r);
  const task = await running(r, receipt.taskId);
  const agent = sessions.get(task.sessionId);
  agent.cancel = () => { sessions.cancelled.push(agent.id); throw new Error('response lost after effect'); };
  const envelope = taskCommand(r, 'uncertain-interrupt', 'interrupt', task.id);
  await assert.rejects(r.commands.submit(envelope));
  const unknown = r.commands.receipt(envelope.commandId);
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(await r.commands.submit(envelope), unknown);
  assert.equal(sessions.cancelled.length, 1);
  await assert.rejects(r.commands.submit(taskCommand(r, 'resume-unknown', 'resume', task.id)), { code: 'reconciliation-required' });
});

test('queued interrupt can resume explicitly, running interrupt requires recovery, and cancel is terminal', async t => {
  const { runtime: r, sessions, goals } = await fixture(t);
  const first = await create(r, 'first');
  await running(r, first.taskId);
  const queued = await create(r, 'second', 'second', 'enqueue');
  const paused = await r.commands.submit(taskCommand(r, 'interrupt-queued', 'interrupt', queued.taskId));
  assert.equal(paused.state, 'completed');
  assert.equal(r.store.get(queued.taskId).status, 'waiting_user');
  assert.equal(r.store.get(queued.taskId).recoveryRequired, false);
  assert.equal(r.store.get(queued.taskId).sessionId, null);
  const cancelFirst = taskCommand(r, 'cancel-first', 'cancel', first.taskId);
  const cancelled = await r.commands.submit(cancelFirst);
  assert.equal(r.store.get(first.taskId).status, 'cancelled');
  assert.deepEqual(await r.commands.submit(cancelFirst), cancelled);
  assert.equal(sessions.cancelled.length, 1);
  assert.equal(sessions.created.length, 1);
  await r.commands.submit(taskCommand(r, 'resume-second', 'resume', queued.taskId));
  const second = await running(r, queued.taskId);
  assert.equal(second.localAuthorization, r.generation);
  await r.commands.submit(taskCommand(r, 'interrupt-running', 'interrupt', queued.taskId));
  assert.equal(r.store.get(queued.taskId).status, 'waiting_user');
  assert.equal(r.store.get(queued.taskId).recoveryRequired, true);
  assert.equal(r.store.get(queued.taskId).localAuthorization, null);
  assert.equal(goals.get(sessions.get(second.sessionId)).phase, 'paused');
  await assert.rejects(r.commands.submit(taskCommand(r, 'unsafe-resume', 'resume', queued.taskId)), { code: 'reconciliation-required' });
  await r.commands.submit(taskCommand(r, 'cancel-second', 'cancel', queued.taskId));
  assert.equal(r.store.get(queued.taskId).status, 'cancelled');
  await assert.rejects(r.commands.submit(taskCommand(r, 'resume-terminal', 'resume', first.taskId)), { code: 'invalid-state' });
  await assert.rejects(r.commands.submit(taskCommand(r, 'interrupt-terminal', 'interrupt', first.taskId)), { code: 'invalid-state' });
  assert.equal(sessions.created.length, 2);
});

test('explicit resume reuses a safely paused session and rearms its goal exactly once', async t => {
  const { runtime: r, sessions, goals } = await fixture(t);
  const created = await create(r);
  const task = await running(r, created.taskId);
  const agent = sessions.get(task.sessionId);
  const paused = goals.pause(agent);
  await r.manager.handleSessionEvent(task.id, { type: 'goal/change', data: { goal: paused } });
  assert.equal(r.store.get(task.id).status, 'waiting_user');
  assert.equal(r.store.get(task.id).recoveryRequired, false);
  const envelope = taskCommand(r, 'resume-paused-goal', 'resume', task.id);
  const receipt = await r.commands.submit(envelope);
  assert.equal(receipt.state, 'completed');
  assert.equal(r.store.get(task.id).status, 'running');
  assert.equal(r.store.get(task.id).sessionId, task.sessionId);
  assert.equal(goals.get(agent).phase, 'active');
  assert.equal(goals.get(agent).activation, 'armed');
  assert.equal(r.store.get(task.id).goalRevision, goals.get(agent).revision);
  assert.deepEqual(await r.commands.submit(envelope), receipt);
  assert.equal(goals.calls.filter(call => call.operation === 'resume').length, 1);
  assert.equal(sessions.created.length, 1);
});

test('approval guard requires an owned running task, current authorization, and an allowed tool', async t => {
  const { runtime: r, sessions } = await fixture(t);
  const receipt = await create(r);
  const task = await running(r, receipt.taskId);
  const exec = { agent: sessions.get(task.sessionId), name: 'read', callId: 'read-1', arguments: { path: 'report.txt' } };
  assert.equal(r.ctx.guard(exec), undefined);
  let nextCalls = 0;
  assert.equal(r.ctx.emit('tools/pre-execute', exec, () => { nextCalls++; return 'continued'; }), 'continued');
  assert.equal(nextCalls, 1);
  for (const name of ['read_image', 'write', 'edit', 'create_goal', 'get_goal', 'update_goal']) assert.equal(r.ctx.guard({ ...exec, name }), undefined);
  assert.notEqual(r.ctx.guard({ ...exec, name: 'shell' }), undefined);
  assert.notEqual(r.ctx.guard({ ...exec, agent: { session: { id: 'unowned' } } }), undefined);
  for (const patch of [{ status: 'waiting_user' }, { status: 'running', recoveryRequired: true },
    { recoveryRequired: false, localAuthorization: 'old-generation' }]) {
    await r.manager.persist(task.id, patch);
    assert.notEqual(r.ctx.guard(exec), undefined);
  }
  assert.equal(r.approvals.list().length, 0);
});

test('approval request requires the live agent identity, tool name, and a tracked invocation', async t => {
  const { runtime: r, sessions } = await fixture(t);
  const receipt = await create(r);
  const task = await running(r, receipt.taskId);
  const agent = sessions.get(task.sessionId);
  const exec = { agent, name: 'write', callId: 'identity-call', arguments: { path: 'a.txt', content: 'x' } };
  assert.equal(r.ctx.emit('tools/pre-execute', exec, () => 'continued').kind, 'ask');
  const req = { agent, toolName: exec.name, callId: exec.callId };
  for (const changed of [{ ...req, agent: { ...agent } }, { ...req, toolName: 'edit' }, { ...req, callId: 'missing' },
    { ...req, signal: AbortSignal.abort() }]) {
    assert.equal(r.ctx.emit('approval/request', changed, () => 'fallback'), 'unavailable');
  }
  assert.equal(r.ctx.emit('approval/request', { ...req, agent: { session: { id: 'unowned' } } }, () => 'fallback'), 'fallback');
  const outcome = r.ctx.emit('approval/request', req, () => 'fallback');
  assert.ok(outcome instanceof Promise);
  assert.equal(r.approvals.list().length, 1);
  r.ctx.emit('tools/result', exec);
  assert.equal(await outcome, 'cancelled');
  assert.equal(r.ctx.emit('approval/request', req, () => 'fallback'), 'unavailable');
});

test('approval command binds task, revision, call, argument digest and decision to a single live resolver', async t => {
  const { runtime: r, domain } = await fixture(t);
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const pending = beginApproval(r, receipt.taskId);
  assert.equal(pending.entry.argumentDigest, argumentDigest(pending.exec.arguments));
  assert.deepEqual(pending.entry.arguments, pending.exec.arguments);
  const listed = r.approvals.list();
  listed[0].arguments.content = 'tampered in UI';
  assert.equal(r.approvals.list()[0].arguments.content, 'approved contents');
  const writes = domain.tables.journal.attempts.length;
  const changes = [{ taskId: 'different-task' }, { toolCallId: 'different-call' },
    { argumentDigest: argumentDigest({ ...pending.exec.arguments, content: 'unapproved' }) },
    { revision: pending.args.revision - 1 }, { decision: 'always-allow' }, { approvalId: 'unknown-approval' }];
  for (const change of changes) assert.throws(() => r.approvals.validate({ ...pending.args, ...change }), { code: 'stale-approval' });
  // The command boundary must also reject a correctly shaped, incorrectly bound decision.
  await assert.rejects(r.commands.submit(r.envelope('wrong-digest', 'approval', { ...pending.args, argumentDigest: '0'.repeat(64) })), { code: 'stale-approval' });
  assert.equal(domain.tables.journal.attempts.length, writes);
  assert.equal(r.approvals.list().length, 1);
  const envelope = r.envelope('allow-once', 'approval', pending.args);
  const decision = await r.commands.submit(envelope);
  assert.equal(decision.state, 'completed');
  assert.equal(await pending.outcome, 'allowed-once');
  assert.equal(r.approvals.list().length, 0);
  assert.deepEqual(await r.commands.submit(envelope), decision);
  await assert.rejects(r.commands.submit(r.envelope('allow-again', 'approval', pending.args)), { code: 'stale-approval' });
});

test('rejection resolves only the matching approval and a late allow cannot change the outcome', async t => {
  const { runtime: r } = await fixture(t);
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const first = beginApproval(r, receipt.taskId, { callId: 'write-a' });
  const second = beginApproval(r, receipt.taskId, { callId: 'write-b', name: 'edit' });
  await r.commands.submit(r.envelope('reject-a', 'approval', { ...first.args, decision: 'rejected' }));
  assert.equal(await first.outcome, 'rejected');
  assert.deepEqual(r.approvals.list().map(entry => entry.id), [second.entry.id]);
  await assert.rejects(r.commands.submit(r.envelope('late-a', 'approval', first.args)), { code: 'stale-approval' });
  await r.commands.submit(r.envelope('allow-b', 'approval', second.args));
  assert.equal(await second.outcome, 'allowed-once');
  assert.equal(await first.outcome, 'rejected');
});

test('deadline rejects an expired approval even before its timer runs', async t => {
  let clock = 1000;
  const { runtime: r, domain } = await fixture(t, { now: () => clock, timeoutMs: 10_000 });
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const pending = beginApproval(r, receipt.taskId);
  clock = pending.entry.expiresAt;
  const writes = domain.tables.journal.attempts.length;
  await assert.rejects(r.commands.submit(r.envelope('expired-allow', 'approval', pending.args)), { code: 'stale-approval' });
  assert.equal(await pending.outcome, 'rejected');
  assert.equal(domain.tables.journal.attempts.length, writes);
  assert.equal(r.commands.receipt('expired-allow'), null);
  assert.equal(r.approvals.list().length, 0);
});

test('approval deadline is revalidated after a slow durable intent append', async t => {
  let clock = 1000;
  const { runtime: r, domain } = await fixture(t, { now: () => clock, timeoutMs: 10_000 });
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const pending = beginApproval(r, receipt.taskId);
  const envelope = r.envelope('slow-allow', 'approval', pending.args);
  domain.tables.journal.beforePut = async (_key, event) => {
    if (event.receipt?.commandId === envelope.commandId && event.receipt.state === 'accepted') clock = pending.entry.expiresAt;
  };
  await assert.rejects(r.commands.submit(envelope), { code: 'stale-approval' });
  assert.equal(await pending.outcome, 'rejected');
  const unknown = r.commands.receipt(envelope.commandId);
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(await r.commands.submit(envelope), unknown);
  assert.equal(r.approvals.list().length, 0);
});

test('approval timer rejects without any decision and refuses a late allow', async t => {
  const { runtime: r } = await fixture(t, { timeoutMs: 20 });
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const pending = beginApproval(r, receipt.taskId);
  // waitFor keeps the event loop alive while the production timer is unref'ed.
  await waitFor(() => r.approvals.list().length === 0);
  assert.equal(await pending.outcome, 'rejected');
  await assert.rejects(r.commands.submit(r.envelope('too-late', 'approval', pending.args)), { code: 'stale-approval' });
});

for (const cancellation of ['abort', 'tool-result', 'interrupt', 'cancel', 'dispose']) {
  test(`approval ${cancellation} cancellation consumes the resolver and prevents late allow`, async t => {
    const { runtime: r } = await fixture(t);
    const receipt = await create(r);
    await running(r, receipt.taskId);
    const pending = beginApproval(r, receipt.taskId);
    if (cancellation === 'abort') pending.abort.abort();
    else if (cancellation === 'tool-result') r.ctx.emit('tools/result', pending.exec);
    else if (cancellation === 'dispose') r.approvals.dispose();
    else await r.commands.submit(taskCommand(r, `task-${cancellation}`, cancellation, receipt.taskId));
    assert.equal(await pending.outcome, 'cancelled');
    assert.equal(r.approvals.list().length, 0);
    assert.throws(() => r.approvals.decide({ ...pending.args, revision: r.store.get(receipt.taskId).revision }), { code: 'stale-approval' });
    if (cancellation === 'dispose') {
      assert.equal(r.ctx.handlers.size, 0);
      assert.equal(r.ctx.guards.size, 0);
    }
  });
}

test('authorization generation changes revoke live approvals and cannot grant a stale allow', async t => {
  const { runtime: r } = await fixture(t);
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const pending = beginApproval(r, receipt.taskId);
  await r.manager.persist(receipt.taskId, { localAuthorization: 'generation-2' });
  assert.notEqual(r.ctx.guard(pending.exec), undefined);
  const args = { ...pending.args, revision: r.store.get(receipt.taskId).revision };
  await assert.rejects(r.commands.submit(r.envelope('stale-authorization', 'approval', args)), { code: 'stale-approval' });
  r.approvals.invalidateTask(receipt.taskId);
  assert.equal(await pending.outcome, 'cancelled');
});

test('restart cancels live approvals and persisted audit IDs cannot recreate a resolver', async t => {
  const f = await fixture(t);
  const r = f.runtime;
  const receipt = await create(r);
  await running(r, receipt.taskId);
  const pending = beginApproval(r, receipt.taskId);
  await r.manager.handleSessionEvent(receipt.taskId, { type: 'approval/asked', data: { id: pending.entry.id, toolName: 'write' } });
  await r.close();
  assert.equal(await pending.outcome, 'cancelled');
  const next = await f.open('generation-2');
  assert.deepEqual(next.approvals.list(), []);
  assert.deepEqual(next.store.get(receipt.taskId).pendingApprovals, []);
  assert.equal(next.store.get(receipt.taskId).pendingApproval, null);
  assert.notEqual(next.ctx.guard(pending.exec), undefined);
  assert.equal(next.ctx.emit('approval/request', pending.req, () => 'fallback'), 'unavailable');
  await assert.rejects(next.commands.submit(next.envelope('old-approval', 'approval', {
    ...pending.args, revision: next.store.get(receipt.taskId).revision,
  })), { code: 'stale-approval' });
  assert.equal(f.sessions.created.length, 1);
});

test('successful approved write journals its marker before the body and clears it only after success', async t => {
  const { runtime: r, domain, workspace } = await fixture(t);
  const created = await create(r);
  await running(r, created.taskId);
  const pending = beginApproval(r, created.taskId);
  await r.commands.submit(r.envelope('allow-write', 'approval', pending.args));
  assert.equal(await pending.outcome, 'allowed-once');
  const marker = { callId: pending.exec.callId, argumentDigest: pending.entry.argumentDigest };
  const result = { isError: false, content: 'written' };
  let bodyCalls = 0;
  const returned = await r.ctx.emit('tools/execute', pending.exec, async () => {
    bodyCalls++;
    assert.deepEqual(r.store.get(created.taskId).unsettledWrites, [marker]);
    const durable = [...domain.tables.journal.entries()].at(-1)[1];
    assert.deepEqual(durable.task.unsettledWrites, [marker]);
    assert.equal(durable.task.id, created.taskId);
    await fs.writeFile(path.join(workspace, pending.exec.arguments.path), pending.exec.arguments.content);
    return result;
  });
  assert.equal(bodyCalls, 1);
  assert.equal(returned, result);
  assert.deepEqual(r.store.get(created.taskId).unsettledWrites, []);
  assert.deepEqual([...domain.tables.journal.entries()].at(-1)[1].task.unsettledWrites, []);
  assert.equal(r.store.get(created.taskId).recoveryRequired, false);
  assert.equal(r.store.get(created.taskId).status, 'running');
  assert.equal(await fs.readFile(path.join(workspace, pending.exec.arguments.path), 'utf8'), pending.exec.arguments.content);
  r.ctx.emit('tools/result', pending.exec);
});

for (const outcome of ['returned-error', 'aborted-success']) {
  test(`approved write ${outcome} retains the marker and blocks resume`, async t => {
    const { runtime: r, workspace, sessions } = await fixture(t);
    const created = await create(r);
    await running(r, created.taskId);
    const pending = beginApproval(r, created.taskId);
    await r.commands.submit(r.envelope('allow-write', 'approval', pending.args));
    assert.equal(await pending.outcome, 'allowed-once');
    const result = { isError: outcome === 'returned-error', content: 'possibly written' };
    assert.equal(await r.ctx.emit('tools/execute', pending.exec, async () => {
      await fs.writeFile(path.join(workspace, pending.exec.arguments.path), 'partial external effect');
      if (outcome === 'aborted-success') pending.abort.abort();
      return result;
    }), result);
    r.ctx.emit('tools/result', pending.exec);
    const task = r.store.get(created.taskId);
    assert.deepEqual(task.unsettledWrites, [{ callId: pending.exec.callId, argumentDigest: pending.entry.argumentDigest }]);
    assert.equal(task.recoveryRequired, true);
    assert.equal(task.status, 'waiting_user');
    assert.notEqual(r.ctx.guard(pending.exec), undefined);
    await assert.rejects(r.commands.submit(taskCommand(r, 'unsafe-resume', 'resume', task.id)), { code: 'reconciliation-required' });
    await waitFor(() => sessions.cancelled.length === 1);
    assert.equal(await fs.readFile(path.join(workspace, pending.exec.arguments.path), 'utf8'), 'partial external effect');
  });
}

test('throwing write retains its durable marker across reopen and blocks same-process resume', async t => {
  const f = await fixture(t);
  const r = f.runtime;
  const created = await create(r);
  const task = await running(r, created.taskId);
  const pending = beginApproval(r, created.taskId);
  await r.commands.submit(r.envelope('allow-write', 'approval', pending.args));
  assert.equal(await pending.outcome, 'allowed-once');
  const fault = new Error('write body stopped before a result');
  await assert.rejects(r.ctx.emit('tools/execute', pending.exec, async () => {
    await fs.writeFile(path.join(f.workspace, pending.exec.arguments.path), 'write before throw');
    throw fault;
  }), error => error === fault);
  const marker = { callId: pending.exec.callId, argumentDigest: pending.entry.argumentDigest };
  assert.deepEqual(r.store.get(task.id).unsettledWrites, [marker]);
  // Pausing the goal is a normal event, not a verification of filesystem effects.
  const paused = f.goals.pause(f.sessions.get(task.sessionId));
  await r.manager.handleSessionEvent(task.id, { type: 'goal/change', data: { goal: paused } });
  const [liveResume] = await Promise.allSettled([
    r.commands.submit(taskCommand(r, 'resume-with-unsettled-write', 'resume', task.id)),
  ]);
  await r.close();
  f.domain.tables.tasks.map.clear();
  const next = await f.open('generation-2');
  assert.deepEqual(next.store.get(task.id).unsettledWrites, [marker]);
  assert.equal(next.store.get(task.id).recoveryRequired, true);
  await assert.rejects(next.commands.submit(taskCommand(next, 'resume-after-reopen', 'resume', task.id)), { code: 'reconciliation-required' });
  assert.equal(f.sessions.created.length, 1);
  assert.equal(await fs.readFile(path.join(f.workspace, pending.exec.arguments.path), 'utf8'), 'write before throw');
  assert.equal(liveResume.status, 'rejected', 'an unsettled write must fence resume before restart too');
  assert.equal(liveResume.reason.code, 'reconciliation-required');
});

test('conflicting duplicate call IDs cannot replace the arguments presented for a live request', async t => {
  const { runtime: r, sessions } = await fixture(t);
  const created = await create(r);
  const task = await running(r, created.taskId);
  const agent = sessions.get(task.sessionId);
  const original = { agent, name: 'write', callId: 'same-call', arguments: { path: 'original.txt', content: 'original' } };
  assert.equal(r.ctx.emit('tools/pre-execute', original, () => 'continued').kind, 'ask');
  const conflicting = { ...original, arguments: { path: 'conflicting.txt', content: 'different effect' } };
  const duplicate = r.ctx.emit('tools/pre-execute', conflicting, () => 'continued');
  const outcome = r.ctx.emit('approval/request', { agent, toolName: original.name, callId: original.callId }, () => 'fallback');
  assert.ok(outcome instanceof Promise);
  const entry = r.approvals.list()[0];
  r.approvals.invalidateTask(task.id);
  assert.equal(await outcome, 'cancelled');
  assert.deepEqual({ duplicateDecision: duplicate.kind, presentedDigest: entry.argumentDigest, presentedArguments: entry.arguments },
    { duplicateDecision: 'deny', presentedDigest: argumentDigest(original.arguments), presentedArguments: original.arguments },
    'a conflicting invocation must not overwrite the original live capability');
});

test('the call dedupe set is bounded by live invocations, not by process lifetime', async t => {
  const { runtime: r, sessions } = await fixture(t);
  const created = await create(r);
  const task = await running(r, created.taskId);
  const agent = sessions.get(task.sessionId);
  let denied = 0;
  // Past the 4096 budget a set that never shrank denies every later call for
  // the life of the process, which silently disables all local tools.
  for (let index = 0; index < 4100; index += 1) {
    const exec = { agent, name: 'read', callId: `call-${index}`, arguments: { path: 'report.txt' } };
    if (r.ctx.emit('tools/pre-execute', exec, () => 'continued') !== 'continued') denied += 1;
    r.ctx.emit('tools/result', exec);
  }
  assert.equal(denied, 0, 'a finished call must free its dedupe slot');
  assert.equal(r.approvals.seenCalls.size, 0);
});

for (const cancellation of ['abort', 'tool-result']) {
  test(`${cancellation} while an approval intent is appending cannot grant a late allow`, async t => {
    const { runtime: r, domain } = await fixture(t);
    const created = await create(r);
    await running(r, created.taskId);
    const pending = beginApproval(r, created.taskId);
    const envelope = r.envelope('allow-during-cancellation', 'approval', pending.args);
    let enteredAppend;
    const appendEntered = new Promise(resolve => { enteredAppend = resolve; });
    let releaseAppend;
    const appendReleased = new Promise(resolve => { releaseAppend = resolve; });
    domain.tables.journal.beforePut = async (_key, event) => {
      if (event.receipt?.commandId === envelope.commandId && event.receipt.state === 'accepted') {
        enteredAppend();
        await appendReleased;
      }
    };
    // Attach the rejection handler before releasing the append to avoid an
    // unhandled rejection if cancellation wins immediately.
    const submitted = r.commands.submit(envelope);
    const rejected = assert.rejects(submitted, { code: 'stale-approval' });
    try {
      await appendEntered;
      if (cancellation === 'abort') pending.abort.abort();
      else r.ctx.emit('tools/result', pending.exec);
      assert.equal(await pending.outcome, 'cancelled');
    } finally {
      releaseAppend();
    }
    await rejected;
    const receipt = r.commands.receipt(envelope.commandId);
    assert.equal(receipt.state, 'unknown');
    const writes = domain.tables.journal.attempts.length;
    assert.deepEqual(await r.commands.submit(envelope), receipt);
    assert.equal(domain.tables.journal.attempts.length, writes);
    const events = [...domain.tables.journal.entries()].map(([, event]) => event)
      .filter(event => event.receipt?.commandId === envelope.commandId);
    assert.deepEqual(events.map(event => event.receipt.state), ['accepted', 'unknown']);
    assert.equal(await pending.outcome, 'cancelled');
    assert.equal(r.approvals.list().length, 0);
    assert.deepEqual(r.store.get(created.taskId).unsettledWrites ?? [], []);
  });
}
