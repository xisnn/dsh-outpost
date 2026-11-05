import assert from 'node:assert/strict';
import {
  listButlerTasks,
  getButlerTask,
  createButlerTask,
  cancelButlerTask,
  resumeButlerTask,
} from '../src/core/butlerTasks.ts';

function fakeConn(responder) {
  const calls = [];
  return {
    calls,
    request: async (path, init = {}) => {
      calls.push({ path, init });
      return responder(path, init);
    },
  };
}

const task = {
  id: 'task-1',
  title: 'probe',
  objective: 'do the thing',
  status: 'running',
  cwd: 'C:/work',
  sessionId: 'session-1',
  goalId: 'goal-1',
  goalRevision: 1,
  goalPhase: 'active',
  maxGoalRounds: 8,
  autoResume: false,
  createdAt: 1,
  updatedAt: 2,
  revision: 3,
  lastAssistantText: null,
  deliverables: [],
  pendingApproval: null,
  lastError: null,
};

{
  const conn = fakeConn(() => ({ tasks: [task] }));
  const tasks = await listButlerTasks(conn);
  assert.equal(tasks.length, 1);
  assert.equal(conn.calls[0].path, '/api/outpost/butler/tasks');
}

{
  const conn = fakeConn(() => ({ tasks: [] }));
  await listButlerTasks(conn, 'waiting_user');
  assert.equal(conn.calls[0].path, '/api/outpost/butler/tasks?status=waiting_user');
}

{
  const conn = fakeConn(() => ({ task }));
  const got = await getButlerTask(conn, 'task 1');
  assert.equal(got.id, 'task-1');
  assert.equal(conn.calls[0].path, '/api/outpost/butler/tasks/get?id=task%201');
}

{
  const conn = fakeConn(() => ({ task }));
  const created = await createButlerTask(
    conn,
    { objective: 'do the thing', cwd: 'C:/work', maxGoalRounds: 8 },
    'idem-1',
  );
  assert.equal(created.id, 'task-1');
  assert.equal(conn.calls[0].path, '/api/outpost/butler/tasks/create');
  assert.equal(conn.calls[0].init.method, 'POST');
  assert.deepEqual(conn.calls[0].init.body, {
    objective: 'do the thing',
    cwd: 'C:/work',
    maxGoalRounds: 8,
  });
  assert.deepEqual(conn.calls[0].init.headers, { 'Idempotency-Key': 'idem-1' });
}

{
  const conn = fakeConn(() => ({ task: { ...task, status: 'cancelled' } }));
  const cancelled = await cancelButlerTask(conn, 'task-1');
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(conn.calls[0].init.body, { id: 'task-1' });
}

{
  const conn = fakeConn(() => ({ task: { ...task, status: 'running' } }));
  const resumed = await resumeButlerTask(conn, 'task-1');
  assert.equal(resumed.status, 'running');
  assert.equal(conn.calls[0].path, '/api/outpost/butler/tasks/resume');
}

console.log('butler-tasks-spec: PASS');
