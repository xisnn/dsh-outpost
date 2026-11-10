import { TaskError } from './task-manager.js';

const MAX_BODY_BYTES = 64 * 1024;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorResponse(error) {
  if (error instanceof TaskError) {
    return json(error.status, { error: error.code, code: error.code, message: error.message });
  }
  return json(500, { error: 'internal', message: 'Task service could not complete the request.' });
}

async function readJson(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new TaskError('body-too-large', 'request body is too large', 413);
  }
  try {
    const parsed = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TaskError('invalid-json', 'request body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError('invalid-json', 'request body must be valid JSON');
  }
}

/**
 * Register the owner-only TaskApi on DSH's exact Fetch route registry.
 *
 * The physical carrier already applies DSH's Host/Origin and browser-cookie
 * checks; every non-owner Peer is answered with 403 before this handler runs.
 * The handler still validates methods, bodies and ids.
 */
export function registerTaskApi({ connection, manager, commands = null, memory = null, memoryError = null, logger = console }) {
  const disposers = [];

  const register = (path, methods, handler) => {
    const dispose = connection.fetch.register({
      path,
      methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(request);
        } catch (error) {
          logger.warn?.(`[outpost-butler] ${path} failed: ${error.message}`);
          return errorResponse(error);
        }
      },
    });
    disposers.push(dispose);
  };

  const requireCommands = () => {
    if (!commands) throw new TaskError('unsupported-capability', 'local commands are not enabled', 409);
    return commands;
  };
  const requireLegacy = () => {
    if (commands) throw new TaskError('command-required', 'local mutations require a versioned commandId', 409);
  };
  register('/api/outpost/butler/capabilities', ['GET'], async () => json(200,
    commands?.capabilities() ?? { version: 1, enabled: false, durableReceipts: false }));
  register('/api/outpost/butler/commands', ['POST'], async request => {
    const receipt = await requireCommands().submit(await readJson(request));
    return json(200, { receipt });
  });
  register('/api/outpost/butler/commands/get', ['GET'], async request => {
    const receipt = requireCommands().receipt(new URL(request.url).searchParams.get('commandId') ?? '');
    return json(receipt ? 200 : 404, receipt ? { receipt } : { error: 'command-not-found' });
  });
  register('/api/outpost/butler/reconcile', ['GET'], async () => json(200, requireCommands().reconcile()));

  // P4 user-managed memory. Owner-only like every route above; no model writes.
  const requireMemory = () => {
    if (!memory) throw new TaskError('memory-unavailable', 'butler memory is unavailable', 503);
    return memory;
  };
  register('/api/outpost/butler/memory', ['GET'], async () => json(200, requireMemory().snapshot()));
  register('/api/outpost/butler/memory/set', ['POST'], async request => {
    const store = requireMemory();
    const entry = await store.set(await readJson(request));
    return json(200, { entry, revision: store.revision() });
  });
  register('/api/outpost/butler/memory/delete', ['POST'], async request => {
    const store = requireMemory();
    const result = await store.delete(await readJson(request));
    return json(200, { deleted: result.id, revision: result.revision });
  });
  register('/api/outpost/butler/memory/history', ['GET'], async request => {
    const store = requireMemory();
    const id = new URL(request.url).searchParams.get('id');
    if (id !== null && !/^mem-[0-9a-f-]{36}$/.test(id)) throw new TaskError('memory-id', 'invalid memory id');
    return json(200, { changes: store.history(id) });
  });

  register('/api/outpost/butler/health', ['GET'], async () => {
    return json(200, {
      ok: true,
      service: 'dsh-outpost-butler',
      lane: manager.activeTaskId,
      queued: manager.queue.length,
    });
  });

  register('/api/outpost/butler/tasks', ['GET'], async (request) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const tasks = manager.list().filter((task) => (status ? task.status === status : true));
    return json(200, { tasks });
  });

  register('/api/outpost/butler/tasks/get', ['GET'], async (request) => {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) throw new TaskError('missing-id', 'id is required');
    const task = manager.publicTask(manager.get(id));
    return json(200, { task });
  });

  register('/api/outpost/butler/tasks/create', ['POST'], async (request) => {
    requireLegacy();
    const body = await readJson(request);
    const task = await manager.create({
      objective: body.objective,
      cwd: body.cwd,
      title: body.title,
      maxGoalRounds: body.maxGoalRounds,
      autoResume: body.autoResume,
      idempotencyKey: request.headers.get('idempotency-key') || body.idempotencyKey,
    });
    return json(201, { task });
  });

  register('/api/outpost/butler/tasks/cancel', ['POST'], async (request) => {
    requireLegacy();
    const body = await readJson(request);
    const id = String(body.id ?? '');
    if (!id) throw new TaskError('missing-id', 'id is required');
    const task = await manager.cancel(id);
    return json(200, { task });
  });

  register('/api/outpost/butler/tasks/resume', ['POST'], async (request) => {
    requireLegacy();
    const body = await readJson(request);
    const id = String(body.id ?? '');
    if (!id) throw new TaskError('missing-id', 'id is required');
    const task = await manager.resume(id);
    return json(200, { task });
  });

  return async () => {
    await Promise.all(disposers.map((dispose) => dispose()));
  };
}
