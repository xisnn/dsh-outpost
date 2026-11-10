import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ButlerClientError,
  ButlerReceiptUnknown,
  DesktopButlerClient,
  LocalButlerClient,
  decodeLocalTask,
  newButlerCommandId,
} from '../src/core/butlerClient.ts';

const GENERATION = '00000000-0000-4000-8000-000000000001';
const TASK = 'task-11111111-1111-4111-8111-111111111111';
const OTHER = 'task-22222222-2222-4222-8222-222222222222';
const TERMINAL = 'task-33333333-3333-4333-8333-333333333333';

const task = (over = {}) => ({
  id: TASK, title: '整理发布记录', objective: '整理本周发布记录', status: 'waiting_user',
  cwd: '/outpost-data/workspace', sessionId: null, goalId: null, goalRevision: 0, goalPhase: null,
  maxGoalRounds: 32, autoResume: false, createdAt: 1, updatedAt: 2, revision: 3,
  lastAssistantText: null, deliverables: [], pendingApproval: null, pendingApprovals: [], lastError: null,
  ...over,
});

const reconcile = (over = {}) => ({
  version: 1, generation: GENERATION, autoResume: false,
  tasks: [
    { id: TASK, revision: 3, status: 'waiting_user', queueOrder: 1, authorized: true, recoveryRequired: true, unsettledWrites: [{ callId: 'call-1', argumentDigest: 'd' }] },
    { id: OTHER, revision: 1, status: 'created', queueOrder: 2, authorized: false, recoveryRequired: false, unsettledWrites: [] },
  ],
  totalTasks: 2, tasksTruncated: false, unresolved: [], totalUnresolved: 0, unresolvedTruncated: false,
  approvals: [{
    id: 'approval-1', taskId: TASK, toolCallId: 'call-1', toolName: 'write', argumentDigest: 'a'.repeat(64),
    arguments: { file_path: '/outpost-data/workspace/out.txt', content: 'hello' }, generation: GENERATION, expiresAt: Date.now() + 60_000,
  }],
  ...over,
});

function runtime(options = {}) {
  const calls = [];
  let detailReads = 0;
  return {
    calls,
    get detailReads() { return detailReads; },
    async query(operation, args) {
      calls.push({ kind: 'query', operation, args });
      if (operation === 'reconcile') return options.reconcile ?? reconcile();
      if (operation === 'tasks') return options.history ?? { tasks: [] };
      if (operation === 'task') { detailReads += 1; return { task: options.taskDetail ?? task({ id: args.id, revision: 3 }) }; }
      if (operation === 'receipt') return { receipt: options.receipt?.(args.commandId) ?? { state: 'completed', commandId: args.commandId } };
      if (operation === 'capabilities') return { version: 1, enabled: true, durableReceipts: true, autoResume: false };
      throw new Error('unexpected query ' + operation);
    },
    async command(operation, args, commandId) {
      calls.push({ kind: 'command', operation, args, commandId });
      return options.command ? options.command(operation, args, commandId) : {
        version: 1, commandId, generation: GENERATION, operation, state: 'completed', digest: 'd', taskId: TASK, revision: 3, at: 1,
      };
    },
  };
}

test('local list projects reconcile tasks without inventing text or hiding gaps', async () => {
  const client = new LocalButlerClient(runtime());
  const views = await client.list();
  assert.equal(views.length, 2);
  assert.equal(views[0].status, 'waiting_user');
  assert.equal(views[0].local.authorized, true);
  assert.equal(views[0].local.recoveryRequired, true);
  assert.equal(views[0].local.pendingApprovalCount, 1);
  assert.deepEqual(views[0].local.unsettledWrites, [{ callId: 'call-1', argumentDigest: 'd' }]);
  assert.equal(views[1].status, 'created');
  assert.equal(views[1].local.pendingApprovalCount, 0);
  assert.equal(views[1].objective, '');
});

test('history keeps terminal tasks visible while reconcile carries active work', async () => {
  const terminal = {
    id: TERMINAL, title: '已完成的任务', objective: '整理记录', status: 'completed', revision: 5,
    updatedAt: 20, lastError: null, pendingApprovalCount: 0, queueOrder: 3, authorized: true, recoveryRequired: false,
  };
  const active = reconcile();
  const r = runtime({ reconcile: active, history: { tasks: [terminal] } });
  const client = new LocalButlerClient(r);
  const history = await client.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'completed');
  assert.equal(history[0].title, '已完成的任务');
  assert.equal(history[0].local.queueOrder, 3);
  const views = client.project(active, history);
  const done = views.find(row => row.id === TERMINAL);
  assert.ok(done); assert.equal(done.status, 'completed'); assert.equal(done.local.pendingApprovalCount, 0);
  const running = views.find(row => row.id === TASK);
  assert.equal(running.local.pendingApprovalCount, 1, 'live approvals still annotate active rows');
});

test('local create sends only Butler-owned arguments and returns the detailed task', async () => {
  const r = runtime();
  const client = new LocalButlerClient(r);
  const created = await client.create({
    objective: '整理本周发布记录', title: '发布摘要', maxGoalRounds: 4,
    cwd: '/must/not/be/sent', autoResume: true,
  }, 'business_create-1');
  assert.equal(created.id, TASK);
  const command = r.calls.find(call => call.kind === 'command');
  assert.equal(command.operation, 'create');
  assert.equal(command.commandId, 'business_create-1');
  assert.deepEqual(command.args, { objective: '整理本周发布记录', title: '发布摘要', maxGoalRounds: 4 });
  assert.equal('cwd' in command.args, false);
  assert.equal('autoResume' in command.args, false);
  assert.equal(r.detailReads, 1);
});

test('local create failure after an unknown receipt is never retried', async () => {
  const r = runtime({ command: (operation, args, commandId) => ({ version: 1, commandId, generation: GENERATION, operation, state: 'unknown', digest: 'd', taskId: TASK, at: 1 }) });
  const client = new LocalButlerClient(r);
  await assert.rejects(
    () => client.create({ objective: 'x' }, 'business_unknown-1'),
    error => error instanceof ButlerReceiptUnknown && error.commandId === 'business_unknown-1',
  );
  assert.equal(r.calls.filter(call => call.kind === 'command').length, 1);
});

test('local rejected receipts surface the Butler machine code', async () => {
  const r = runtime({ command: (operation, args, commandId) => ({ version: 1, commandId, generation: GENERATION, operation, state: 'rejected', code: 'reconciliation-required', digest: 'd', taskId: TASK, at: 1 }) });
  const client = new LocalButlerClient(r);
  await assert.rejects(
    () => client.resume(TASK),
    error => error instanceof ButlerClientError && error.code === 'reconciliation-required',
  );
});

test('approval answers bind the live approval identity and current revision', async () => {
  const r = runtime();
  const client = new LocalButlerClient(r);
  const receipt = await client.approve({ approvalId: 'approval-1', decision: 'allowed-once' });
  assert.equal(receipt.state, 'completed');
  const command = r.calls.find(call => call.kind === 'command');
  assert.equal(command.operation, 'approval');
  assert.deepEqual(command.args, {
    taskId: TASK, revision: 3, approvalId: 'approval-1', toolCallId: 'call-1',
    argumentDigest: 'a'.repeat(64), decision: 'allowed-once',
  });
  assert.match(command.commandId, /^local-approval-/);
});

test('a revision-conflict approval retries once with the refreshed revision', async () => {
  let reconciles = 0;
  const commands = [];
  const base = reconcile();
  const r = {
    async query(operation) {
      if (operation === 'reconcile') {
        reconciles += 1;
        // The first attempt reads the same revision twice; after the first
        // command's conflict the second attempt sees the advanced revision.
        const revision = reconciles <= 2 ? 3 : 4;
        return { ...base, tasks: base.tasks.map(row => row.id === TASK ? { ...row, revision } : row) };
      }
      throw new Error('unexpected query ' + operation);
    },
    async command(operation, args, commandId) {
      commands.push({ operation, args, commandId });
      if (commands.length === 1) {
        return { version: 1, commandId, generation: GENERATION, operation, state: 'rejected', code: 'revision-conflict', digest: 'd', taskId: TASK, at: 1 };
      }
      return { version: 1, commandId, generation: GENERATION, operation, state: 'completed', digest: 'd', taskId: TASK, revision: 4, at: 2 };
    },
  };
  const client = new LocalButlerClient(r);
  const receipt = await client.approve({ approvalId: 'approval-1', decision: 'allowed-once' });
  assert.equal(receipt.state, 'completed');
  assert.equal(commands.length, 2);
  assert.equal(commands[0].args.revision, 3);
  assert.equal(commands[1].args.revision, 4);
  assert.equal(commands[0].args.approvalId, commands[1].args.approvalId);
  assert.notEqual(commands[0].commandId, commands[1].commandId);
});

test('a disappeared approval is stale and never reaches Butler', async () => {
  const r = runtime({ reconcile: reconcile({ approvals: [] }) });
  const client = new LocalButlerClient(r);
  await assert.rejects(
    () => client.approve({ approvalId: 'approval-1', decision: 'allowed-once' }),
    error => error instanceof ButlerClientError && error.code === 'stale-approval',
  );
  assert.equal(r.calls.some(call => call.kind === 'command'), false);
});

test('resume sends the latest reconcile revision and refreshes once', async () => {
  const r = runtime();
  const client = new LocalButlerClient(r);
  await client.resume(TASK);
  const command = r.calls.find(call => call.kind === 'command');
  assert.equal(command.operation, 'resume');
  assert.deepEqual(command.args, { taskId: TASK, revision: 3 });
  assert.match(command.commandId, /^local-resume-/);
  assert.ok(r.calls.filter(call => call.kind === 'query' && call.operation === 'reconcile').length >= 1);
});

test('detail reads are cached per revision', async () => {
  const r = runtime();
  const client = new LocalButlerClient(r);
  await client.reconcile();
  const first = await client.detail(TASK);
  const second = await client.detail(TASK);
  assert.equal(first.id, second.id);
  assert.equal(r.detailReads, 1);
});

test('capabilities and receipts pass through without translation', async () => {
  const r = runtime();
  const client = new LocalButlerClient(r);
  const caps = await client.capabilities();
  assert.equal(caps.durableReceipts, true);
  const receipt = await client.receipt('business_create-1');
  assert.equal(receipt.commandId, 'business_create-1');
});

test('desktop adapter keeps the existing REST and idempotency behavior', async () => {
  const calls = [];
  const store = {
    async listButlerTasks() { return [task()]; },
    async getButlerTask(id) { return task({ id }); },
    async createButlerTask(input, key) { calls.push({ input, key }); return task({ id: TASK }); },
    async cancelButlerTask(id) { calls.push({ cancel: id }); return task({ id }); },
    async resumeButlerTask(id) { calls.push({ resume: id }); return task({ id }); },
  };
  const client = new DesktopButlerClient(store);
  assert.equal((await client.list())[0].id, TASK);
  await client.create({ objective: 'o', cwd: '/work/project', maxGoalRounds: 3, autoResume: true, title: 'T' }, 'idem-1');
  assert.deepEqual(calls[0], {
    input: { objective: 'o', cwd: '/work/project', title: 'T', maxGoalRounds: 3, autoResume: true },
    key: 'idem-1',
  });
  await client.enqueue({ objective: 'o', cwd: '/work/project' }, 'idem-2');
  assert.equal(calls.length, 2);
  await client.cancel(TASK); await client.resume(TASK);
  assert.deepEqual(calls.slice(2), [{ cancel: TASK }, { resume: TASK }]);
  await assert.rejects(() => client.interrupt(TASK), error => error.code === 'unsupported-on-desktop');
  await assert.rejects(() => client.create({ objective: 'o' }, 'idem-3'), error => error.code === 'workspace-required');
});

test('task decoding rejects unknown statuses and keeps local metadata explicit', () => {
  assert.throws(() => decodeLocalTask({ id: TASK, status: 'mystery' }), /invalid-task/);
  assert.throws(() => decodeLocalTask({ id: 'evil', status: 'running' }), /invalid-task/);
  const decoded = decodeLocalTask({
    id: TASK, title: 't', objective: 'o', status: 'running', revision: 2,
    queueOrder: 5, authorized: true, recoveryRequired: true,
    unsettledWrites: [{ callId: 'c', argumentDigest: 'd' }, { callId: 7 }],
    deliverables: [{ path: 'a.txt', size: 1 }],
  }, 2);
  assert.equal(decoded.local.queueOrder, 5);
  assert.equal(decoded.local.pendingApprovalCount, 2);
  assert.deepEqual(decoded.local.unsettledWrites, [{ callId: 'c', argumentDigest: 'd' }]);
  assert.equal(decoded.deliverables.length, 1);
});

test('command ids stay within Butler constraints', () => {
  for (let index = 0; index < 50; index += 1) {
    const id = newButlerCommandId('create');
    assert.match(id, /^[A-Za-z0-9_-]{1,128}$/);
  }
});
