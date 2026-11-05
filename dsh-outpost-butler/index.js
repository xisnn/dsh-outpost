import { assertButlerContracts } from './lib/contracts.js';
import { taskDomainSpec } from './lib/domain.js';
import { registerTaskApi } from './lib/task-api.js';
import { TaskManager } from './lib/task-manager.js';
import { TaskStore } from './lib/task-store.js';

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
export async function apply(ctx) {
  assertButlerContracts(ctx);

  const domain = await ctx.storageDomain.open(taskDomainSpec);
  const store = new TaskStore({ domain });
  await store.load();

  const logger = ctx.logger ?? console;
  const manager = new TaskManager({
    store,
    sessions: ctx.sessions,
    agents: ctx.agents,
    goals: ctx.goals,
    sessionController: ctx.sessionController,
    logger,
  });

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
    logger,
  });

  ctx.effect(() => {
    return async () => {
      try {
        offSession?.();
        offActivation?.();
        offStatus?.();
      } finally {
        await manager.dispose();
        await disposeApi();
        await domain.close();
      }
    };
  });

  await manager.init();
  logger.info?.('[outpost-butler] ready');
}
