import crypto from 'node:crypto';

const LIMIT = 262144;
const COMMAND_LIMIT = 48 * 1024;
const OPS = new Set(['health', 'snapshot', 'tasks', 'task', 'capabilities', 'command', 'receipt', 'reconcile', 'memory', 'memory-history', 'memory-set', 'memory-delete', 'shutdown']);
const TASK_ID = /^task-[a-f0-9-]{36}$/;
const TASK_STATUSES = new Set(['created','preparing','running','waiting_user','blocked','completed','failed','cancelled']);
const MEMORY_ID = /^mem-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMORY_KINDS = new Set(['preference','project']);

/** An authenticated, inherited-pipe bridge around the real DSH context.
 * No listener, shell dispatcher or generic URL proxy. Business writes remain Butler's API.
 */
export function serveDshRuntime(ctx, { input = process.stdin, output = process.stdout, exit = code => process.exit(code), heartbeatMs = 2000 } = {}) {
  const generation = process.env.OUTPOST_LAUNCH_ID;
  const encodedKey = process.env.OUTPOST_PIPE_TOKEN;
  delete process.env.OUTPOST_PIPE_TOKEN;
  delete process.env.OUTPOST_LAUNCH_ID;
  if (!/^[a-f0-9-]{36}$/.test(generation ?? '') || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey ?? '')) throw Error('RUNTIME_IDENTITY');
  const key = Buffer.from(encodedKey, 'base64');
  const handler = ctx.connection.createSharedFetchHandler('/api');
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } });
  let sent = 0, received = 0, buffer = Buffer.alloc(0), closed = false, busy = false;
  const auth = (n, kind, id, payload) => crypto.createHmac('sha256', key).update(`1\n${generation}\n${n}\n${kind}\n${id}\n${payload}`).digest();
  function send(kind, id, body) {
    if (closed) return;
    const payload = Buffer.from(JSON.stringify(body)).toString('base64');
    const n = sent + 1;
    const text = JSON.stringify({ v: 1, generation, n, kind, id, payload, mac: auth(n, kind, id, payload).toString('base64') }) + '\n';
    if (Buffer.byteLength(text) > LIMIT) throw Error('WIRE_SIZE');
    if ((output.writableLength ?? 0) + Buffer.byteLength(text) > LIMIT * 2) throw Error('WIRE_BACKPRESSURE');
    sent = n;
    output.write(text);
  }
  async function shutdown(code) {
    if (closed) return;
    closed = true; clearInterval(heartbeat); input.off('data', onData);
    // Losing the owning native process never resumes a task or retries a write.
    const timer = setTimeout(() => exit(code || 1), 1000); timer.unref();
    try { await ctx.fiber.dispose(); } finally { key.fill(0); exit(code); }
  }
  class ButlerFailure extends Error {
    constructor(code) {
      super('BUTLER_QUERY');
      // Only a bounded machine code crosses the pipe, never error text or stacks.
      this.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(code) ? code : 'QUERY_FAILED';
    }
  }
  async function api(path, init) {
    const response = await handler.fetch(new Request(`http://127.0.0.1/api/outpost/butler/${path}`, init), peer);
    const body = await response.json();
    if (!response.ok || body?.ok === false) throw new ButlerFailure(body?.code);
    return body;
  }
  function objectArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('QUERY_ARGUMENTS');
    return args;
  }
  async function query(op, args) {
    switch (op) {
      case 'health': return api('health');
      case 'snapshot': return taskPage(await api('tasks'), args);
      case 'capabilities':
      case 'reconcile':
        if (Object.keys(objectArgs(args)).length) throw Error('QUERY_ARGUMENTS');
        return api(op);
      case 'receipt':
        if (Object.keys(objectArgs(args)).length !== 1 || typeof args.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.commandId)) throw Error('QUERY_ARGUMENTS');
        return api(`commands/get?commandId=${encodeURIComponent(args.commandId)}`);
      case 'tasks': {
        // Bounded task history for the local UI. Reconcile intentionally carries
        // only non-terminal work; completed/failed tasks must still be visible.
        if (Object.keys(objectArgs(args)).length) throw Error('QUERY_ARGUMENTS');
        const body = await api('tasks');
        return taskHistory(body.tasks);
      }
      case 'memory': {
        if (Object.keys(objectArgs(args)).length) throw Error('QUERY_ARGUMENTS');
        return api('memory');
      }
      case 'memory-history': {
        objectArgs(args);
        if (Object.keys(args).some(key => key !== 'id') || (args.id !== undefined && (typeof args.id !== 'string' || !MEMORY_ID.test(args.id)))) throw Error('QUERY_ARGUMENTS');
        return api('memory/history' + (args.id ? `?id=${encodeURIComponent(args.id)}` : ''));
      }
      case 'memory-set': {
        objectArgs(args);
        if (Object.keys(args).some(key => !['id','kind','key','value','expectedRevision'].includes(key))
          || (args.id !== undefined && (typeof args.id !== 'string' || !MEMORY_ID.test(args.id)))
          || typeof args.kind !== 'string' || !MEMORY_KINDS.has(args.kind)
          || typeof args.key !== 'string' || !args.key.trim() || args.key.length > 64
          || typeof args.value !== 'string' || !args.value.trim() || args.value.length > 2048
          || (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0))) throw Error('QUERY_ARGUMENTS');
        const body = JSON.stringify(args);
        if (Buffer.byteLength(body) > 16 * 1024) throw Error('QUERY_ARGUMENTS');
        return api('memory/set', {method:'POST', headers:{'Content-Type':'application/json'}, body});
      }
      case 'memory-delete': {
        objectArgs(args);
        if (Object.keys(args).some(key => !['id','expectedRevision'].includes(key))
          || typeof args.id !== 'string' || !MEMORY_ID.test(args.id)
          || (args.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0))) throw Error('QUERY_ARGUMENTS');
        return api('memory/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(args)});
      }
      case 'task': {
        // One bounded, read-only task-detail projection. No path, text search,
        // file contents or generic /api proxy: P3 needs the objective, latest
        // summary and deliverable metadata that the status page legitimately
        // omits, nothing more.
        if (Object.keys(objectArgs(args)).length !== 1 || typeof args.id !== 'string' || !TASK_ID.test(args.id)) throw Error('QUERY_ARGUMENTS');
        const body = await api(`tasks/get?id=${encodeURIComponent(args.id)}`);
        return taskDetail(body.task);
      }
      case 'command': {
        objectArgs(args);
        const body = JSON.stringify(args);
        if (Buffer.byteLength(body) > COMMAND_LIMIT) throw Error('QUERY_ARGUMENTS');
        if (args.generation !== generation) throw Error('STALE_RUNTIME');
        // Butler alone validates the typed envelope and executes business operations.
        return api('commands', {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
      }
    }
  }
  function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : null;
  }
  function count(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function taskDetail(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !TASK_ID.test(task.id)) throw Error('BUTLER_QUERY');
    if (!TASK_STATUSES.has(task.status)) throw Error('BUTLER_QUERY');
    const deliverables = (Array.isArray(task.deliverables) ? task.deliverables : []).slice(0, 32).map(file => {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string') throw Error('BUTLER_QUERY');
      return {
        path: file.path.slice(0, 1024),
        ...(typeof file.relativePath === 'string' ? { relativePath: file.relativePath.slice(0, 1024) } : {}),
        ...(typeof file.description === 'string' ? { description: file.description.slice(0, 512) } : {}),
        ...(Number.isSafeInteger(file.size) && file.size >= 0 ? { size: file.size } : {}),
        ...(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256) ? { sha256: file.sha256 } : {}),
        ...(typeof file.unavailableReason === 'string' ? { unavailableReason: file.unavailableReason.slice(0, 512) } : {}),
      };
    });
    const pending = (Array.isArray(task.pendingApprovals) ? task.pendingApprovals
      : task.pendingApproval ? [task.pendingApproval] : []).slice(0, 8).map(entry => ({
        id: text(entry?.id, 128) ?? '',
        toolName: text(entry?.toolName, 128) ?? '',
        askedAt: count(entry?.askedAt),
      })).filter(entry => entry.id);
    const detail = {
      id: task.id,
      title: text(task.title, 512) ?? '',
      objective: text(task.objective, 8192) ?? '',
      status: task.status,
      cwd: text(task.cwd, 1024) ?? '',
      sessionId: text(task.sessionId, 128),
      goalId: text(task.goalId, 128),
      goalRevision: count(task.goalRevision),
      goalPhase: text(task.goalPhase, 64),
      maxGoalRounds: count(task.maxGoalRounds),
      autoResume: task.autoResume === true,
      createdAt: count(task.createdAt),
      updatedAt: count(task.updatedAt),
      revision: count(task.revision),
      lastAssistantText: text(task.lastAssistantText, 16384),
      deliverables,
      pendingApprovals: pending,
      lastError: text(task.lastError, 512),
      ...(Number.isSafeInteger(task.queueOrder) && task.queueOrder >= 0 ? { queueOrder: task.queueOrder } : {}),
      ...(typeof task.authorized === 'boolean' ? { authorized: task.authorized } : {}),
      ...(typeof task.recoveryRequired === 'boolean' ? { recoveryRequired: task.recoveryRequired } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(detail)) > 128 * 1024) throw Error('BUTLER_QUERY');
    return { scope: 'task-detail', task: detail };
  }
  function taskHistory(list) {
    if (!Array.isArray(list)) throw Error('BUTLER_QUERY');
    const rows = list.map(task => {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string' || !TASK_ID.test(task.id) || !TASK_STATUSES.has(task.status)) throw Error('BUTLER_QUERY');
      const pendingApprovalCount = Array.isArray(task.pendingApprovals) && task.pendingApprovals.length ? task.pendingApprovals.length : task.pendingApproval ? 1 : 0;
      return {
        id: task.id,
        title: text(task.title, 256) ?? '',
        objective: text(task.objective, 512) ?? '',
        status: task.status,
        revision: count(task.revision),
        updatedAt: count(task.updatedAt),
        lastError: text(task.lastError, 256),
        pendingApprovalCount,
        ...(Number.isSafeInteger(task.queueOrder) && task.queueOrder >= 0 ? { queueOrder: task.queueOrder } : {}),
        ...(typeof task.authorized === 'boolean' ? { authorized: task.authorized } : {}),
        ...(typeof task.recoveryRequired === 'boolean' ? { recoveryRequired: task.recoveryRequired } : {}),
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 64);
    const result = { scope: 'task-history', tasks: rows, total: list.length, truncated: list.length > 64 };
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw Error('BUTLER_QUERY');
    return result;
  }
  // Preserve the P1 status projection; full text and files are never exposed here.
  // Stateless continuation is bound to this launch and to the exact projected revision.
  function taskPage(snapshot, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['cursor', 'limit'].includes(k))) throw Error('QUERY_ARGUMENTS');
    const limit = args.limit ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw Error('QUERY_ARGUMENTS');
    if (!Array.isArray(snapshot.tasks)) throw Error('BUTLER_QUERY');
    const tasks = snapshot.tasks.map(task => {
      const {id, status} = task, revision = task.revision ?? 0;
      if (typeof id !== 'string' || !id.length || Buffer.byteLength(id) > 128 || !['created','preparing','running','waiting_user','blocked','completed','failed','cancelled'].includes(status) || !Number.isSafeInteger(revision) || revision < 0) throw Error('BUTLER_QUERY');
      const pendingApprovalCount = Array.isArray(task.pendingApprovals) && task.pendingApprovals.length ? task.pendingApprovals.length : task.pendingApproval ? 1 : 0;
      return {id, status, revision, pendingApprovalCount};
    }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const snapshotId = crypto.createHash('sha256').update(generation).update(JSON.stringify(tasks)).digest('hex');
    let offset = 0;
    if (args.cursor !== undefined) {
      if (typeof args.cursor !== 'string' || !/^[a-f0-9]{64}:[0-9]{1,10}$/.test(args.cursor)) throw Error('QUERY_ARGUMENTS');
      const [identity, position] = args.cursor.split(':');
      if (identity !== snapshotId) throw Error('SNAPSHOT_CHANGED');
      offset = Number(position);
      if (offset > tasks.length) throw Error('QUERY_ARGUMENTS');
    }
    const page = [], budget = 128 * 1024;
    let end = offset, bytes = 0;
    while (end < tasks.length && page.length < limit) {
      const row = tasks[end], size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes + size > budget) break;
      page.push(row);bytes += size;end++;
    }
    return {scope:'task-status', snapshotId, tasks:page, total:tasks.length, nextCursor:end < tasks.length ? snapshotId+':'+end : null};
  }
  async function dispatch(frame) {
    const { n, kind, id, payload, mac } = frame;
    if (frame.v !== 1 || frame.generation !== generation || n !== received + 1 || kind !== 'request' || !/^[a-zA-Z0-9-]{1,64}$/.test(id ?? '') || typeof payload !== 'string' || typeof mac !== 'string') throw Error('WIRE_IDENTITY');
    const expected = auth(n, kind, id, payload), actual = Buffer.from(mac, 'base64');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) throw Error('WIRE_AUTH');
    received = n;
    const request = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (!OPS.has(request.op)) throw Error('OPERATION_NOT_ALLOWED');
    if (request.op === 'shutdown') return shutdown(0);
    if (busy) { send('response', id, { ok: false, code: 'BRIDGE_BUSY' }); return; }
    busy = true;
    try {
      const body = await query(request.op, request.args);
      send('response', id, { ok: true, body });
    } catch (error) { send('response', id, { ok: false, code: error instanceof ButlerFailure ? error.code : ['QUERY_ARGUMENTS','SNAPSHOT_CHANGED','STALE_RUNTIME','BUTLER_QUERY'].includes(error?.message) ? error.message : 'QUERY_FAILED' }); }
    finally { busy = false; }
  }
  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (!closed) {
      const newline = buffer.indexOf(10);
      if (newline === -1) { if (buffer.length > LIMIT) void shutdown(1); return; }
      if (newline > LIMIT) { void shutdown(1); return; }
      const line = buffer.subarray(0, newline).toString('utf8'); buffer = buffer.subarray(newline + 1);
      try { void dispatch(JSON.parse(line)).catch(() => shutdown(1)); } catch { void shutdown(1); }
    }
  }
  input.on('data', onData);
  input.once('end', () => void shutdown(1));
  input.once('error', () => void shutdown(1));
  output.once('error', () => void shutdown(1));
  let probing = false;
  const heartbeat = setInterval(async () => {
    if (probing || closed) return;
    probing = true;
    try {
      const snapshot = await api('tasks');
      const tasks = snapshot.tasks ?? [];
      const awaitingUser = task => task.status === 'waiting_user' || task.pendingApproval || task.pendingApprovals?.length;
      const activity = tasks.some(task => ['running', 'preparing'].includes(task.status) && !awaitingUser(task)) ? 'busy'
        : tasks.some(awaitingUser) ? 'waiting' : 'idle';
      // Sent on every tick even when activity is unchanged. RuntimeSupervisor
      // treats 15s without a frame as a dead runtime, so this is a liveness
      // signal, not a change notification; suppressing repeats would kill an
      // idle host.
      send('heartbeat', '', {activity});
    } catch {
      // A jammed pipe (WIRE_BACKPRESSURE) or a momentarily busy butler is
      // transient. Terminating here would dispose the fiber and abandon every
      // in-flight task for one missed tick. Skipping costs nothing: the
      // supervisor owns liveness and stops the runtime after 15s with its state
      // intact, and its own 20s scheduler guard covers a wedged watcher, so a
      // permanently failing probe is still bounded.
    } finally { probing = false; }
  }, heartbeatMs);
  send('ready', '', { protocol: 1, implementation: 'dsh-outpost' });
  return { changed() { send('changed', '', {}); }, close: () => shutdown(0) };
}
