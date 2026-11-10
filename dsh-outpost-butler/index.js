import { assertButlerContracts } from './lib/contracts.js';
import { taskDomainSpec, memoryDomainSpec } from './lib/domain.js';
import { registerTaskApi } from './lib/task-api.js';
import { MemoryStore } from './lib/memory-store.js';
import { TaskManager } from './lib/task-manager.js';
import { TaskStore } from './lib/task-store.js';
import { LocalCommands } from './lib/commands.js';
import { LocalApprovals } from './lib/local-approvals.js';

export const name = 'outpost-butler';
export const inject = [
  'sessions',
  'agents',
  'goals',
  'sessionController',
  'storageDomain',
  'connection',
];

/**
 * Host-side butler task runner.
 *
 * A task is one DSH session + one persistent goal. The goal-round-driver does
 * the automatic rounds; this plugin owns the task entity, the serial lane,
 * durable checkpoints, human-interjection pauses, approval timeouts, restart
 * recovery and the owner-only TaskApi.
 */
export async function apply(ctx, config = {}) {
  assertButlerContracts(ctx);
  const localRuntime = config.localRuntime === true ? {
    generation: process.env.OUTPOST_LAUNCH_ID,
    workspaceRoot: config.workspaceRoot,
  } : null;
  if (localRuntime && (typeof ctx.get('tools')?.guard !== 'function' || !ctx.get('approval'))) {
    throw new Error('local runtime requires DSH tools.guard and approval contracts');
  }

  const domain = await ctx.storageDomain.open(taskDomainSpec);
  const store = new TaskStore({ domain });
  await store.load();

  const logger = ctx.logger ?? console;

  // P4 identity/memory is a separate domain: a memory failure must not block
  // task execution, and memory never participates in task/approval authority.
  let memoryDomain = null;
  let memory = null;
  let memoryError = null;
  try {
    memoryDomain = await ctx.storageDomain.open(memoryDomainSpec);
    memory = new MemoryStore({ domain: memoryDomain });
    await memory.load();
  } catch (error) {
    memoryError = error;
    logger.warn?.(`[outpost-butler] memory unavailable: ${error.message}`);
    try { await memoryDomain?.close(); } catch { /* best effort */ }
    memoryDomain = null;
    memory = null;
  }
  const manager = new TaskManager({
    store,
    sessions: ctx.sessions,
    agents: ctx.agents,
    goals: ctx.goals,
    sessionController: ctx.sessionController,
    logger,
    localRuntime,
  });
  const approvals = localRuntime ? new LocalApprovals({
    ctx: { tools: ctx.get('tools'), on: ctx.on.bind(ctx) }, manager, generation: localRuntime.generation,
    timeoutMs: config.approvalTimeoutMs ?? 300000,
  }) : null;
  const commands = localRuntime ? new LocalCommands({ manager, store, ...localRuntime, approvals }) : null;
  await commands?.init();

  const offSession = ctx.on('session/event', (session, event) => {
    manager.onSessionEvent(session, event);
  });
  const offActivation = ctx.on('goal/activation-changed', (payload) => {
    manager.onActivationChanged(payload);
  });
  const offStatus = ctx.on('agent/status', (payload) => {
    manager.onAgentStatus(payload);
  });

  const disposeApi = registerTaskApi({
    connection: ctx.connection,
    manager,
    commands,
    memory,
    memoryError,
    logger,
  });

  ctx.effect(() => {
    return async () => {
      try {
        offSession?.();
        offActivation?.();
        offStatus?.();
      } finally {
        approvals?.dispose();
        await commands?.dispose();
        await manager.dispose();
        await disposeApi();
        await memoryDomain?.close();
        await domain.close();
      }
    };
  });

  await manager.init();
  logger.info?.('[outpost-butler] ready');
}
