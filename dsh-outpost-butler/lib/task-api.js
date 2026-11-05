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
    return json(error.status, { error: error.code, message: error.message });
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
export function registerTaskApi({ connection, manager, logger = console }) {
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
    const body = await readJson(request);
    const id = String(body.id ?? '');
    if (!id) throw new TaskError('missing-id', 'id is required');
    const task = await manager.cancel(id);
    return json(200, { task });
  });

  register('/api/outpost/butler/tasks/resume', ['POST'], async (request) => {
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
