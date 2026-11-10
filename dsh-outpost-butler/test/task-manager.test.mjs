import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TaskStore } from '../lib/task-store.js';
import { TaskManager } from '../lib/task-manager.js';

// Manager validation uses the Host platform's native absolute-path semantics.
const WORKSPACE = path.resolve('test-workspace');

class FakeTable {
  constructor() {
    this.map = new Map();
  }
  get(key) {
    return this.map.get(key);
  }
  *entries() {
    for (const [key, value] of this.map) yield [key, structuredClone(value)];
  }
  get size() {
    return this.map.size;
  }
  async put(key, value) {
    this.map.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.map.delete(key);
  }
}

class FakeDomain {
  constructor() {
    this.tables = {
      tasks: new FakeTable(),
      journal: new FakeTable(),
      idempotency: new FakeTable(),
    };
  }
  table(name) {
    return this.tables[name];
  }
}

class FakeGoals {
  constructor() {
    this.byAgent = new Map();
    this.counter = 0;
  }
  create(agent, { objective, maxGoalRounds }) {
    const goal = {
      id: `goal-${++this.counter}`,
      revision: 1,
      objective,
      phase: 'active',
      activation: 'armed',
      maxGoalRounds,
      roundsStarted: 0,
    };
    this.byAgent.set(agent.id, goal);
    return goal;
  }
  get(agent) {
    return this.byAgent.get(agent.id);
  }
  pause(agent) {
    const goal = this.byAgent.get(agent.id);
    if (!goal) return undefined;
    const next = { ...goal, phase: 'paused', activation: 'disarmed', revision: goal.revision + 1 };
    this.byAgent.set(agent.id, next);
    return next;
  }
  resume(agent) {
    const goal = this.byAgent.get(agent.id);
    if (!goal) return undefined;
    if (goal.roundsStarted >= goal.maxGoalRounds) throw new Error('GOAL_INVALID_TRANSITION');
    const next = { ...goal, phase: 'active', activation: 'armed', revision: goal.revision + 1 };
    this.byAgent.set(agent.id, next);
    return next;
  }
}

class FakeSessionController {
  constructor() {
    this.byId = new Map();
    this.counter = 0;
    this.cancelled = [];
  }
  async create({ cwd }) {
    const id = `session-${++this.counter}`;
    const agent = {
      id,
      status: 'idle',
      session: { id, cwd },
      cancel: () => this.cancelled.push(id),
    };
    this.byId.set(id, agent);
    return { sessionId: id };
  }
  async resolveAgent(id) {
    const agent = this.byId.get(id);
    return agent ? { agent } : { error: { code: 'session/not-found' } };
  }
}

class FakeAgents {
  constructor(sessions) {
    this.sessions = sessions;
  }
  get(id) {
    return this.sessions.byId.get(id);
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function setup({ approvalTimeoutMs = 10000 } = {}) {
  const domain = new FakeDomain();
  let counter = 0;
  const store = new TaskStore({ domain, idFactory: () => `task-${++counter}` });
  await store.load();
  const goals = new FakeGoals();
  const sessions = new FakeSessionController();
  const manager = new TaskManager({
    store,
    sessions,
    agents: new FakeAgents(sessions),
    goals,
    sessionController: sessions,
    approvalTimeoutMs,
    logger: { warn() {}, info() {} },
    now: () => 1000,
  });
  await manager.init();
  return { manager, store, goals, sessions };
}

test('create starts a session, resolves an agent and creates a goal', async () => {
  const { manager, store, goals } = await setup();
  const created = await manager.create({ objective: 'do the thing', cwd: WORKSPACE, maxGoalRounds: 4 });
  await waitFor(() => store.get(created.id).status === 'running');
  const task = store.get(created.id);
  assert.equal(task.sessionId, 'session-1');
  assert.ok(task.goalId);
  assert.equal(goals.byAgent.get('session-1').phase, 'active');
});

test('goal complete maps the task to completed', async () => {
  const { manager, store, goals, sessions } = await setup();
  const created = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(created.id).status === 'running');

  const agent = sessions.byId.get('session-1');
  goals.byAgent.set('session-1', {
    ...goals.get(agent),
    phase: 'complete',
    activation: 'disarmed',
    revision: 2,
  });
  await manager.handleSessionEvent(created.id, {
    type: 'goal/change',
    data: { goal: goals.get(agent) },
  });
  assert.equal(store.get(created.id).status, 'completed');
});

test('completion during a running turn waits for turn/end to capture the final text', async () => {
  const { manager, store, goals, sessions } = await setup();
  const created = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(created.id).status === 'running');

  const agent = sessions.byId.get('session-1');
  agent.status = 'running';
  goals.byAgent.set('session-1', {
    ...goals.get(agent),
    phase: 'complete',
    activation: 'disarmed',
    revision: 2,
  });
  await manager.handleSessionEvent(created.id, {
    type: 'goal/change',
    data: { goal: goals.get(agent) },
  });
  assert.equal(store.get(created.id).status, 'running');
  assert.equal(store.get(created.id).goalPhase, 'complete');

  await manager.handleSessionEvent(created.id, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'final answer' }] } },
  });
  await manager.handleSessionEvent(created.id, {
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  });
  assert.equal(store.get(created.id).status, 'completed');
  assert.equal(store.get(created.id).lastAssistantText, 'final answer');
});

test('human interjection pauses the goal and waits for the user', async () => {
  const { manager, store, goals } = await setup();
  const created = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(created.id).status === 'running');

  await manager.handleSessionEvent(created.id, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'human-1' }, content: [{ type: 'text', text: 'stop' }] },
  });
  assert.equal(store.get(created.id).status, 'waiting_user');
  assert.equal(store.get(created.id).lastError, 'human-interjection');
  await waitFor(() => goals.byAgent.get('session-1').phase === 'paused');

  const resumed = await manager.resume(created.id);
  assert.equal(resumed.status, 'running');
  assert.equal(goals.byAgent.get('session-1').phase, 'active');
});

test('a failed goal resume releases the whole lane, not just the active task', async (t) => {
  const { manager, store, goals } = await setup();
  t.after(() => manager.dispose());
  const created = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(created.id).status === 'running');
  await manager.handleSessionEvent(created.id, {
    type: 'user/message',
    data: { source: { kind: 'user', rpcId: 'human-1' }, content: [{ type: 'text', text: 'stop' }] },
  });
  await waitFor(() => goals.byAgent.get('session-1').phase === 'paused');

  goals.resume = () => { throw new Error('resume failed'); };
  let pumps = 0;
  const pump = manager.pump.bind(manager);
  manager.pump = () => { pumps += 1; return pump(); };
  await assert.rejects(manager.resume(created.id), { code: 'resume-failed' });
  // A bare activeTaskId reset never pumps, so a task queued behind this one
  // would stall until some unrelated event happened to release the lane.
  assert.equal(manager.activeTaskId, null);
  assert.equal(pumps, 1);
});

test('approval timeout pauses the goal and releases the lane', async () => {
  const { manager, store, goals, sessions } = await setup({ approvalTimeoutMs: 20 });
  const created = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(created.id).status === 'running');

  await manager.handleSessionEvent(created.id, {
    type: 'approval/asked',
    data: { id: 'approval-1', toolName: 'pwsh' },
  });
  await waitFor(() => store.get(created.id).status === 'waiting_user' && sessions.cancelled.length === 1);
  assert.equal(store.get(created.id).lastError, 'approval-timeout');
  assert.equal(goals.byAgent.get('session-1').phase, 'paused');
  assert.deepEqual(sessions.cancelled, ['session-1']);
});

test('restart turns a running task into waiting_user, not a silent resume', async () => {
  const first = await setup();
  const created = await first.manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => first.store.get(created.id).status === 'running');

  const second = new TaskManager({
    store: first.store,
    sessions: first.sessions,
    agents: new FakeAgents(first.sessions),
    goals: first.goals,
    sessionController: first.sessions,
    logger: { warn() {}, info() {} },
    now: () => 2000,
  });
  await second.init();
  assert.equal(first.store.get(created.id).status, 'waiting_user');
  assert.equal(first.store.get(created.id).lastError, 'host-restarted');
});

test('autoResume explicitly resumes a disarmed goal after restart', async () => {
  const first = await setup();
  const created = await first.manager.create({
    objective: 'o',
    cwd: WORKSPACE,
    autoResume: true,
  });
  await waitFor(() => first.store.get(created.id).status === 'running');
  const agent = first.sessions.byId.get('session-1');
  first.goals.byAgent.set('session-1', {
    ...first.goals.get(agent),
    activation: 'disarmed',
  });

  const second = new TaskManager({
    store: first.store,
    sessions: first.sessions,
    agents: new FakeAgents(first.sessions),
    goals: first.goals,
    sessionController: first.sessions,
    logger: { warn() {}, info() {} },
    now: () => 2000,
  });
  await second.init();
  await waitFor(() => first.store.get(created.id).status === 'running');
  assert.equal(first.goals.byAgent.get('session-1').activation, 'armed');
});

test('cancel pauses the goal, cancels the agent and marks the task cancelled', async () => {
  const { manager, store, goals, sessions } = await setup();
  const created = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(created.id).status === 'running');

  const cancelled = await manager.cancel(created.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(goals.byAgent.get('session-1').phase, 'paused');
  assert.deepEqual(sessions.cancelled, ['session-1']);
});

test('allowed approval clears only the matching item and keeps executing', async (t) => {
  const { manager, store } = await setup();
  t.after(() => manager.dispose());
  const created = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(created.id).status === 'running');
  for (const id of ['a1', 'a2', 'a1']) {
    await manager.handleSessionEvent(created.id, { type: 'approval/asked', data: { id, toolName: 'safe-probe' } });
  }
  assert.equal(store.get(created.id).pendingApprovals.length, 2);
  await manager.handleSessionEvent(created.id, { type: 'approval/decided', data: { id: 'other', outcome: 'rejected' } });
  assert.equal(store.get(created.id).status, 'running');
  await manager.handleSessionEvent(created.id, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } });
  assert.equal(store.get(created.id).pendingApproval.id, 'a2');
  assert.equal(manager.approvalTimers.get(created.id).approvalId, 'a2');
  await manager.handleSessionEvent(created.id, { type: 'approval/decided', data: { id: 'a2', outcome: 'allowed-once' } });
  assert.equal(store.get(created.id).pendingApproval, null);
  assert.equal(manager.approvalTimers.has(created.id), false);
  assert.equal(store.get(created.id).status, 'running');
});

for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
  test(`approval ${outcome} pauses until explicit resume and survives turn/end`, async (t) => {
    const { manager, store, goals, sessions } = await setup();
    t.after(() => manager.dispose());
    const created = await manager.create({ objective: 'o', cwd: WORKSPACE, autoResume: true });
    await waitFor(() => store.get(created.id).status === 'running');
    await manager.handleSessionEvent(created.id, { type: 'approval/asked', data: { id: 'a1', toolName: 'safe-probe' } });
    await manager.handleSessionEvent(created.id, { type: 'approval/decided', data: { id: 'a1', outcome } });
    await waitFor(() => sessions.cancelled.length === 1);
    assert.equal(store.get(created.id).status, 'waiting_user');
    assert.equal(goals.byAgent.get('session-1').phase, 'paused');
    await manager.handleSessionEvent(created.id, { type: 'goal/change', data: { goal: goals.byAgent.get('session-1') } });
    await manager.handleSessionEvent(created.id, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    assert.equal(store.get(created.id).lastError, `approval-${outcome}`);
    assert.equal(store.get(created.id).pendingApproval, null);

    const restarted = new TaskManager({ store, sessions, agents: new FakeAgents(sessions), goals, sessionController: sessions });
    t.after(() => restarted.dispose());
    await restarted.init();
    assert.equal(store.get(created.id).status, 'waiting_user');
    const resumed = await restarted.resume(created.id);
    assert.equal(resumed.status, 'running');
  });
}

test('timeout keeps the lane until cancellation settles; late approval cannot resume', async (t) => {
  const { manager, store, goals, sessions } = await setup();
  t.after(() => manager.dispose());
  const first = await manager.create({ objective: 'first', cwd: WORKSPACE });
  await waitFor(() => store.get(first.id).status === 'running');
  const agent = sessions.byId.get('session-1');
  agent.status = 'running';
  const second = await manager.create({ objective: 'second', cwd: WORKSPACE });
  await manager.handleSessionEvent(first.id, { type: 'approval/asked', data: { id: 'a1', toolName: 'safe-probe' } });
  await manager.onApprovalTimeout(first.id, 'a1');
  await waitFor(() => sessions.cancelled.length === 1);
  assert.equal(store.get(first.id).status, 'waiting_user');
  assert.equal(store.get(second.id).status, 'created');
  await assert.rejects(manager.resume(first.id), { code: 'approval-pending' });
  await manager.handleSessionEvent(first.id, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } });
  await manager.handleSessionEvent(first.id, { type: 'goal/change', data: { goal: { ...goals.get(agent), phase: 'active' } } });
  assert.equal(store.get(first.id).status, 'waiting_user');
  assert.equal(store.get(first.id).lastError, 'approval-timeout');
  await assert.rejects(manager.resume(first.id), { code: 'agent-busy' });
  await manager.handleSessionEvent(first.id, { type: 'turn/end', data: { reason: { kind: 'aborted' } } });
  assert.equal(store.get(second.id).status, 'created');
  agent.status = 'idle';
  manager.onAgentStatus({ agent, status: 'idle' });
  await waitFor(() => store.get(second.id).status === 'running');
  assert.equal(store.get(first.id).lastError, 'approval-timeout');
});

test('restart with pending approval never auto-resumes or keeps a stale approval', async (t) => {
  const { manager, store, goals, sessions } = await setup();
  t.after(() => manager.dispose());
  const task = await manager.create({ objective: 'o', cwd: WORKSPACE, autoResume: true });
  await waitFor(() => store.get(task.id).status === 'running');
  await manager.handleSessionEvent(task.id, { type: 'approval/asked', data: { id: 'a1', toolName: 'safe-probe' } });
  manager.dispose();
  const restarted = new TaskManager({ store, sessions, agents: new FakeAgents(sessions), goals, sessionController: sessions });
  t.after(() => restarted.dispose());
  await restarted.init();
  assert.equal(store.get(task.id).status, 'waiting_user');
  assert.equal(store.get(task.id).lastError, 'approval-interrupted');
  assert.equal(store.get(task.id).pendingApproval, null);
  assert.deepEqual(store.get(task.id).pendingApprovals, []);
});

test('restart clears stale approval IDs when shutdown happened during timeout cancellation', async (t) => {
  const { manager, store, goals, sessions } = await setup();
  t.after(() => manager.dispose());
  const task = await manager.create({ objective: 'o', cwd: WORKSPACE, autoResume: true });
  await waitFor(() => store.get(task.id).status === 'running');
  await manager.handleSessionEvent(task.id, { type: 'approval/asked', data: { id: 'old-process', toolName: 'safe-probe' } });
  await manager.persist(task.id, { status: 'waiting_user', lastError: 'approval-timeout' });
  manager.dispose();
  const restarted = new TaskManager({ store, sessions, agents: new FakeAgents(sessions), goals, sessionController: sessions });
  t.after(() => restarted.dispose());
  await restarted.init();
  assert.equal(store.get(task.id).status, 'waiting_user');
  assert.equal(store.get(task.id).lastError, 'approval-timeout');
  assert.deepEqual(store.get(task.id).pendingApprovals, []);
  assert.equal(store.get(task.id).pendingApproval, null);
  assert.equal((await restarted.resume(task.id)).status, 'running');
});

test('a goal completion event cannot overwrite an approval refusal', async (t) => {
  const { manager, store, goals, sessions } = await setup();
  t.after(() => manager.dispose());
  const task = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(task.id).status === 'running');
  await manager.handleSessionEvent(task.id, { type: 'approval/asked', data: { id: 'a1', toolName: 'safe-probe' } });
  await manager.handleSessionEvent(task.id, { type: 'approval/decided', data: { id: 'a1', outcome: 'rejected' } });
  const agent = sessions.byId.get('session-1');
  await manager.handleSessionEvent(task.id, { type: 'goal/change', data: { goal: { ...goals.get(agent), phase: 'complete' } } });
  await manager.finalizeCompleted(task.id);
  assert.equal(store.get(task.id).status, 'waiting_user');
  assert.equal(store.get(task.id).lastError, 'approval-rejected');
});

test('pausing failure still aborts the pending tool', async (t) => {
  const { manager, store, goals, sessions } = await setup();
  t.after(() => manager.dispose());
  const task = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(task.id).status === 'running');
  goals.pause = () => { throw new Error('pause failed'); };
  await manager.handleSessionEvent(task.id, { type: 'approval/asked', data: { id: 'a1', toolName: 'safe-probe' } });
  await manager.onApprovalTimeout(task.id, 'a1');
  await waitFor(() => sessions.cancelled.length === 1);
  assert.equal(store.get(task.id).status, 'waiting_user');
  assert.equal(store.get(task.id).lastError, 'approval-timeout');
});

test('completion fallback waits while the final turn is still running', async (t) => {
  const { manager, store, sessions } = await setup();
  t.after(() => manager.dispose());
  const task = await manager.create({ objective: 'o', cwd: WORKSPACE });
  await waitFor(() => store.get(task.id).status === 'running');
  const agent = sessions.byId.get('session-1');
  agent.status = 'running';
  await manager.persist(task.id, { goalPhase: 'complete' });
  await manager.onCompletionFallback(task.id);
  assert.equal(store.get(task.id).status, 'running');
  assert.equal(manager.activeTaskId, task.id);
  assert.ok(manager.completionTimers.has(task.id));
  agent.status = 'idle';
  manager.onAgentStatus({ agent, status: 'idle' });
  await waitFor(() => store.get(task.id).status === 'completed');
  assert.equal(manager.activeTaskId, null);
});

test('idempotent create returns the existing task', async () => {
  const { manager, store } = await setup();
  const first = await manager.create({ objective: 'o', cwd: WORKSPACE, idempotencyKey: 'k-1' });
  const second = await manager.create({ objective: 'o', cwd: WORKSPACE, idempotencyKey: 'k-1' });
  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
});
