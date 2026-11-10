import path from 'node:path';
import { TERMINAL_STATUSES } from './task-store.js';
import { describeDeliverable } from './deliverables.js';

export const DEFAULT_MAX_GOAL_ROUNDS = 32;
export const MAX_GOAL_ROUNDS = 256;
export const MAX_OBJECTIVE_LENGTH = 20000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export class TaskError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.status = status;
  }
}

function pendingApprovalsOf(task) {
  if (task.pendingApprovals?.length) return task.pendingApprovals;
  return task.pendingApproval ? [task.pendingApproval] : [];
}

function approvalPatch(pendingApprovals) {
  return { pendingApprovals, pendingApproval: pendingApprovals[0] ?? null };
}

function textOfContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * Host-side task state machine.
 *
 * DSH goals and the goal-round-driver do the executing. This manager owns the
 * task entity, the single serial lane, durable checkpoints, human-interjection
 * detection, approval timeouts and restart recovery.
 */
export class TaskManager {
  constructor({
    store,
    sessions,
    agents,
    goals,
    sessionController,
    logger = console,
    now = () => Date.now(),
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    defaultMaxGoalRounds = DEFAULT_MAX_GOAL_ROUNDS,
    localRuntime = null,
  }) {
    this.store = store;
    this.sessions = sessions;
    this.agents = agents;
    this.goals = goals;
    this.sessionController = sessionController;
    this.logger = logger;
    this.now = now;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.defaultMaxGoalRounds = defaultMaxGoalRounds;
    this.localRuntime = localRuntime;

    this.queue = [];
    this.queued = new Set();
    this.activeTaskId = null;
    this.approvalTimers = new Map();
    this.completionTimers = new Map();
    this.writeChains = new Map();
    this.eventChains = new Map();
    this.lastText = new Map();
    this.sessionToTask = new Map();
    this.humanPaused = new Set();
    this.approvalStops = new Map();
    this.disposed = false;
  }

  async init() {
    const restartCandidates = [];
    for (const task of this.store.list()) {
      if (TERMINAL_STATUSES.has(task.status)) continue;
      if (task.sessionId) this.sessionToTask.set(task.sessionId, task.id);
      if (this.localRuntime) {
        // A persisted queue is not a new user authorization after process loss.
        await this.persist(task.id, {
          status: task.status === 'created' ? 'created' : 'waiting_user',
          autoResume: false, localAuthorization: null,
          recoveryRequired: Boolean(task.sessionId || task.status !== 'created'),
          lastError: task.status === 'created' ? 'queue-requires-authorization' : 'execution-outcome-unverified',
          ...approvalPatch([]),
        });
        continue;
      }
      if (task.status === 'created') {
        this.enqueue(task.id);
        continue;
      }
      if (task.status === 'preparing' || task.status === 'running') {
        if (task.goalPhase === 'complete' && pendingApprovalsOf(task).length === 0 && !task.lastError?.startsWith('approval-')) {
          await this.finalizeCompleted(task.id);
          continue;
        }
        const pending = pendingApprovalsOf(task);
        const approvalInterrupted = pending.length > 0 || task.lastError?.startsWith('approval-');
        await this.persist(task.id, {
          status: 'waiting_user',
          lastError: approvalInterrupted ? (task.lastError || 'approval-interrupted') : 'host-restarted',
          ...approvalPatch([]),
        });
        if (task.autoResume && !approvalInterrupted) restartCandidates.push(task.id);
      } else if (pendingApprovalsOf(task).length > 0) {
        // Gateway requests are process-local; an old ID cannot be answered in
        // the new process, even when the task was already waiting_user.
        await this.persist(task.id, {
          status: 'waiting_user',
          lastError: task.lastError?.startsWith('approval-') ? task.lastError : 'approval-interrupted',
          ...approvalPatch([]),
        });
      }
    }

    // Auto-resume applies only to execution interrupted by this restart. A
    // previous human pause or approval refusal must stay paused across restarts.
    for (const id of restartCandidates) {
      const task = this.get(id);
      try {
        await this.resume(task.id, { automatic: true });
      } catch (error) {
        this.logger.warn?.(`[outpost-butler] auto-resume ${task.id} skipped: ${error.message}`);
      }
    }

    this.pump();
  }

  list() {
    return this.store.list().map((task) => this.publicTask(task));
  }

  get(id) {
    const task = this.store.get(id);
    if (!task) throw new TaskError('not-found', `task not found: ${id}`, 404);
    return task;
  }

  async create(input, { commandReceipt, deferExecution = false } = {}) {
    const objective = String(input?.objective ?? '').trim();
    if (!objective) throw new TaskError('invalid-objective', 'objective is required');
    if (objective.length > MAX_OBJECTIVE_LENGTH) {
      throw new TaskError('invalid-objective', `objective exceeds ${MAX_OBJECTIVE_LENGTH} characters`);
    }

    const cwd = String(input?.cwd ?? '').trim();
    if (!cwd || !path.isAbsolute(cwd)) {
      throw new TaskError('invalid-cwd', 'cwd must be an absolute path');
    }

    const maxGoalRounds = input?.maxGoalRounds ?? this.defaultMaxGoalRounds;
    if (!Number.isInteger(maxGoalRounds) || maxGoalRounds < 1 || maxGoalRounds > MAX_GOAL_ROUNDS) {
      throw new TaskError('invalid-max-goal-rounds', `maxGoalRounds must be 1..${MAX_GOAL_ROUNDS}`);
    }

    const title = String(input?.title ?? '').trim().slice(0, 120) || objective.slice(0, 60);
    const idempotencyKey = input?.idempotencyKey ? String(input.idempotencyKey) : null;

    const task = await this.store.create({
      objective,
      cwd,
      maxGoalRounds,
      autoResume: !this.localRuntime && input?.autoResume === true,
      title,
      idempotencyKey,
      ...(this.localRuntime ? { localAuthorization: this.localRuntime.generation } : {}),
      commandReceipt,
    });
    if (!deferExecution) {
      this.enqueue(task.id);
      this.pump();
    }
    return this.publicTask(this.store.get(task.id) ?? task);
  }

  async interrupt(id) {
    const task = this.get(id);
    if (TERMINAL_STATUSES.has(task.status)) throw new TaskError('invalid-state', 'task is terminal', 409);
    this.queue = this.queue.filter(queued => queued !== id);
    this.queued.delete(id);
    // Fence deferred preparation before touching the agent. Unknown tool writes
    // are never made safe merely by a successful cancellation request.
    const updated = await this.persist(id, {
      status: 'waiting_user', lastError: 'interrupted', ...approvalPatch([]),
      ...(this.localRuntime ? { localAuthorization: null, recoveryRequired: Boolean(task.sessionId) } : {}),
    });
    const agent = task.sessionId ? this.agents.get(task.sessionId) : undefined;
    if (agent) {
      try {
        const goal = this.goals.get(agent);
        if (goal?.phase === 'active') this.goals.pause(agent, { id: goal.id, revision: goal.revision });
      } finally { agent.cancel({ kind: 'user' }); }
    }
    this.finishLane(id);
    return this.publicTask(updated);
  }

  async cancel(id) {
    let task = this.get(id);
    if (TERMINAL_STATUSES.has(task.status)) return this.publicTask(task);

    this.queue = this.queue.filter((queued) => queued !== id);
    this.queued.delete(id);

    const agent = task.sessionId ? this.agents.get(task.sessionId) : undefined;
    if (agent && task.goalId) {
      const goal = this.goals.get(agent);
      if (goal && goal.phase === 'active') {
        try {
          this.goals.pause(agent, { id: goal.id, revision: goal.revision });
        } catch (error) {
          this.logger.warn?.(`[outpost-butler] pause before cancel failed: ${error.message}`);
        }
      }
      try {
        agent.cancel({ kind: 'user' });
      } catch {
        // A cold/idle agent has nothing to cancel.
      }
    }

    this.clearApprovalTimer(id);
    this.humanPaused.delete(id);
    task = await this.persist(id, { status: 'cancelled', ...approvalPatch([]), lastError: null });
    this.finishLane(id);
    return this.publicTask(task);
  }

  async resume(id, { automatic = false } = {}) {
    let task = this.get(id);
    if (this.localRuntime && (automatic || task.recoveryRequired || task.unsettledWrites?.length)) {
      throw new TaskError('reconciliation-required', 'verify external effects before starting a new task; uncertain sessions cannot be replayed', 409);
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new TaskError('invalid-state', `cannot resume a ${task.status} task`, 409);
    }
    if (task.status === 'running' || task.status === 'preparing') return this.publicTask(task);
    if (task.status === 'created') {
      this.enqueue(id);
      this.pump();
      return this.publicTask(this.store.get(id) ?? task);
    }
    if (task.status !== 'waiting_user' && task.status !== 'blocked') {
      throw new TaskError('invalid-state', `cannot resume a ${task.status} task`, 409);
    }
    if (this.activeTaskId && this.activeTaskId !== id) {
      throw new TaskError('busy', 'another task is running', 409);
    }

    if (!task.sessionId) {
      task = await this.persist(id, { status: 'created', lastError: null, ...approvalPatch([]) });
      this.enqueue(id);
      this.pump();
      return this.publicTask(task);
    }

    if (pendingApprovalsOf(task).length > 0 || this.approvalStops.has(id)) {
      throw new TaskError('approval-pending', 'wait for approval cancellation to settle before resuming', 409);
    }
    const liveAgent = this.agents.get(task.sessionId);
    if (liveAgent?.status === 'running') {
      throw new TaskError('agent-busy', 'the previous turn is still stopping', 409);
    }

    this.activeTaskId = id;
    this.humanPaused.delete(id);
    this.sessionToTask.set(task.sessionId, id);
    let agent;
    try {
      agent = await this.resolveAgentCold(task);
    } catch (error) {
      // finishLane, not a bare activeTaskId reset: the lane also owns the
      // approval/completion timers and the pump that starts the next task.
      this.finishLane(id);
      throw new TaskError('agent-unavailable', error.message, 409);
    }

    // Cold resolution yields to cancellation, interruption and disposal.
    task = this.get(id);
    if (this.disposed || !['waiting_user', 'blocked'].includes(task.status)
      || (this.localRuntime && (task.recoveryRequired || task.localAuthorization !== this.localRuntime.generation))) {
      this.finishLane(id);
      throw new TaskError('state-changed', 'task changed during agent resolution', 409);
    }
    let goal = this.goals.get(agent);
    if (!goal) {
      goal = this.goals.create(agent, {
        objective: task.objective,
        maxGoalRounds: task.maxGoalRounds,
      });
      task = await this.persist(id, {
        goalId: goal.id,
        goalRevision: goal.revision,
        goalPhase: goal.phase,
        status: 'running',
        lastError: null,
        ...approvalPatch([]),
      });
      return this.publicTask(task);
    }

    if (goal.phase === 'complete') {
      task = await this.persist(id, {
        goalId: goal.id,
        goalRevision: goal.revision,
        goalPhase: goal.phase,
        status: 'completed',
        lastError: null,
        ...approvalPatch([]),
      });
      this.finishLane(id);
      return this.publicTask(task);
    }

    if (goal.activation === 'disarmed' || goal.phase !== 'active') {
      try {
        goal = this.goals.resume(agent, { id: goal.id, revision: goal.revision });
      } catch (error) {
        this.finishLane(id);
        throw new TaskError('resume-failed', error.message, 409);
      }
    }

    task = await this.persist(id, {
      goalId: goal.id,
      goalRevision: goal.revision,
      goalPhase: goal.phase,
      status: 'running',
      lastError: null,
      ...approvalPatch([]),
    });
    return this.publicTask(task);
  }

  onSessionEvent(session, event) {
    const id = this.sessionToTask.get(session?.id);
    if (!id) return;
    this.enqueueEvent(id, () => this.handleSessionEvent(id, event));
  }

  onAgentStatus({ agent, status }) {
    const id = this.sessionToTask.get(agent?.id);
    if (!id || status === 'running') return;
    this.enqueueEvent(id, () => {
      const task = this.store.get(id);
      if (task?.status === 'running' && task.goalPhase === 'complete') return this.finalizeCompleted(id);
      if (task && task.status !== 'running' && task.status !== 'preparing') this.finishLane(id);
    });
  }

  onActivationChanged(payload) {
    const id = this.sessionToTask.get(payload?.sessionId);
    if (!id) return;
    this.enqueueEvent(id, () => this.handleActivationChanged(id, payload));
  }

  /**
   * Serialize one task's events. Without this, an async goal/change handler
   * can still be persisting while turn/end reads the old goal phase, which
   * produces a brief wrong waiting_user before the completion lands.
   */
  enqueueEvent(id, operation) {
    const previous = this.eventChains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.disposed ? undefined : operation());
    this.eventChains.set(id, next.catch(() => undefined));
    next.catch((error) => {
      this.logger.warn?.(`[outpost-butler] event handling failed for ${id}: ${error.message}`);
    });
  }

  async handleActivationChanged(id, payload) {
    const task = this.store.get(id);
    if (!task || task.status !== 'running') return;
    if (payload?.goal?.activation !== 'disarmed') return;

    const agent = task.sessionId ? this.agents.get(task.sessionId) : undefined;
    let phase = task.goalPhase;
    if (agent) {
      try {
        const goal = this.goals.get(agent);
        if (goal) phase = goal.phase;
      } catch {
        // Keep the persisted phase when the live goal cannot be read.
      }
    }
    if (phase === 'active') {
      await this.waitUser(id, 'goal-disarmed');
    }
  }

  async handleSessionEvent(id, event) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    switch (event.type) {
      case 'goal/change':
        return this.onGoalChange(id, event.data);
      case 'deliverables/presented':
        return this.onDeliverables(id, event.data);
      case 'approval/asked':
        return this.onApprovalAsked(id, event.data);
      case 'approval/decided':
        return this.onApprovalDecided(id, event.data);
      case 'user/message':
        return this.onUserMessage(id, event.data);
      case 'assistant/message':
        return this.onAssistantMessage(id, event.data);
      case 'turn/end':
        return this.onTurnEnd(id, event.data);
      default:
        return undefined;
    }
  }

  async onGoalChange(id, data) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    const goal = data?.goal;
    if (!goal) {
      await this.waitUser(id, 'goal-cleared');
      return;
    }

    const base = {
      goalId: goal.id,
      goalRevision: goal.revision,
      goalPhase: goal.phase,
    };

    if ((this.localRuntime && (task.recoveryRequired || task.localAuthorization !== this.localRuntime.generation))
      || (task.status === 'waiting_user' && task.lastError?.startsWith('approval-'))) {
      await this.persist(id, base);
      return;
    }

    if (goal.phase === 'complete') {
      const agent = task.sessionId ? this.agents.get(task.sessionId) : undefined;
      const running = agent?.status === 'running';
      await this.persist(id, {
        ...base,
        goalPhase: 'complete',
        lastError: null,
      });
      if (running) {
        // The model usually completes the goal from a tool call and still
        // produces a final assistant message in the same turn. Keep the task
        // running until turn/end so that message becomes the summary.
        this.scheduleCompletionFallback(id);
      } else {
        await this.finalizeCompleted(id);
      }
      return;
    }

    if (goal.phase === 'blocked') {
      const reason = goal.blockedReason
        ? `${goal.blockedReason.code}: ${goal.blockedReason.message}`
        : 'goal-blocked';
      await this.persist(id, {
        ...base,
        status: 'blocked',
        lastError: reason,
        lastAssistantText: this.lastText.get(id) ?? task.lastAssistantText,
        ...approvalPatch([]),
      });
      this.finishLane(id);
      return;
    }

    if (goal.phase === 'paused') {
      const lastError = this.humanPaused.has(id)
        ? 'human-interjection'
        : task.status === 'waiting_user' && task.lastError
          ? task.lastError
          : 'goal-paused';
      await this.persist(id, { ...base, status: 'waiting_user', lastError });
      this.finishLane(id);
      return;
    }

    // active
    this.humanPaused.delete(id);
    const next = { ...base };
    if (task.status === 'preparing' || task.status === 'waiting_user' || task.status === 'blocked') {
      next.status = 'running';
      next.lastError = null;
    }
    await this.persist(id, next);
  }

  async onDeliverables(id, data) {
    const files = Array.isArray(data?.files) ? data.files.filter((file) => typeof file?.path === 'string' && file.path) : [];
    if (files.length === 0) return;
    const task = this.get(id);
    const described = [];
    for (const file of files) described.push(await describeDeliverable(task.cwd, file));
    await this.persist(id, (current) => {
      const byPath = new Map(current.deliverables.map((file) => [file.path, file]));
      for (const file of described) byPath.set(file.path, file);
      return { deliverables: [...byPath.values()] };
    });
  }

  async onApprovalAsked(id, data) {
    const approvalId = typeof data?.id === 'string' ? data.id : '';
    if (!approvalId) return;
    const updated = await this.persist(id, (task) => {
      const pending = pendingApprovalsOf(task);
      if (pending.some((item) => item.id === approvalId)) return {};
      return approvalPatch([...pending, {
        id: approvalId,
        toolName: String(data?.toolName ?? 'unknown'),
        askedAt: this.now(),
      }]);
    });
    this.setApprovalTimer(id, updated.pendingApproval);
  }

  async onApprovalDecided(id, data) {
    const task = this.store.get(id);
    const pending = task ? pendingApprovalsOf(task) : [];
    if (!pending.some((item) => item.id === data?.id)) return;
    const outcome = String(data?.outcome ?? 'unavailable');
    const updated = await this.persist(id, approvalPatch(pending.filter((item) => item.id !== data.id)));
    this.setApprovalTimer(id, updated.pendingApproval);
    if (outcome !== 'allowed-once') {
      await this.stopForApproval(id, `approval-${outcome}`);
    }
  }

  async stopForApproval(id, reason) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    const previousReason = task.status === 'waiting_user' && task.lastError?.startsWith('approval-')
      ? task.lastError : reason;
    await this.persist(id, {
      status: 'waiting_user',
      lastError: previousReason,
      lastAssistantText: this.lastText.get(id) ?? task.lastAssistantText,
    });
    this.clearApprovalTimer(id);
    if (this.approvalStops.has(id)) return;
    // Pausing appends a session event. Defer it beyond the original
    // approval/decided publication, where DSH forbids re-entrant appends.
    const timer = setTimeout(() => {
      if (this.disposed) return;
      this.enqueueEvent(id, async () => {
        try {
          const current = this.store.get(id);
          if (!current || TERMINAL_STATUSES.has(current.status)) return;
          const agent = current.sessionId ? this.agents.get(current.sessionId) : undefined;
          if (agent) {
            try {
              const goal = this.goals.get(agent);
              if (goal?.phase === 'active') {
                this.goals.pause(agent, { id: goal.id, revision: goal.revision });
              }
            } finally {
              // Even if pausing fails, the pending tool must be aborted.
              agent.cancel({ kind: 'user' });
            }
          }
        } finally {
          this.approvalStops.delete(id);
          this.finishLane(id);
        }
      });
    }, 0);
    this.approvalStops.set(id, timer);
  }

  async onUserMessage(id, data) {
    if (data?.source?.kind !== 'user') return;
    const task = this.store.get(id);
    if (!task || task.status !== 'running') return;
    const rpcId = data.source.rpcId;
    if (rpcId && task.managedRpcIds.includes(rpcId)) return;

    // This handler runs inside session/event publication. A synchronous
    // goals.pause() would append another session event re-entrantly and DSH
    // rejects that ("session append cannot reenter"). Defer it until the
    // current publication has settled.
    this.humanPaused.add(id);
    this.deferGoalPause(task);
    await this.waitUser(id, 'human-interjection');
  }

  deferGoalPause(task) {
    setTimeout(() => {
      if (this.disposed) return;
      const agent = task.sessionId ? this.agents.get(task.sessionId) : undefined;
      if (!agent || !task.goalId) return;
      let goal;
      try {
        goal = this.goals.get(agent);
      } catch {
        return;
      }
      if (!goal || goal.phase !== 'active') return;
      try {
        this.goals.pause(agent, { id: goal.id, revision: goal.revision });
      } catch (error) {
        this.logger.warn?.(`[outpost-butler] deferred goal pause failed: ${error.message}`);
      }
    }, 0);
  }

  onAssistantMessage(id, data) {
    const text = textOfContent(data?.message?.content);
    if (text) this.lastText.set(id, text);
  }

  async onTurnEnd(id, data) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    if (task.status === 'waiting_user' && task.lastError?.startsWith('approval-')) {
      await this.persist(id, approvalPatch([]));
      this.finishLane(id);
      return;
    }
    if (task.goalPhase === 'complete') {
      return this.finalizeCompleted(id);
    }
    const kind = data?.reason?.kind;
    if (kind === 'max-tokens') return this.waitUser(id, 'max-tokens');
    if (kind === 'error') return this.waitUser(id, 'turn-error');
    if (kind === 'interrupted') return this.waitUser(id, 'interrupted');
    if (kind === 'aborted' && task.status === 'running') return this.waitUser(id, 'aborted');
    return undefined;
  }

  async onApprovalTimeout(id, approvalId) {
    const task = this.store.get(id);
    if (!task || task.status !== 'running') return;
    if (!pendingApprovalsOf(task).some((item) => item.id === approvalId)) return;
    await this.stopForApproval(id, 'approval-timeout');
  }

  setApprovalTimer(id, pending) {
    this.clearApprovalTimer(id);
    const task = this.store.get(id);
    if (!pending || task?.status !== 'running') return;
    const timer = setTimeout(() => {
      this.approvalTimers.delete(id);
      this.enqueueEvent(id, () => this.onApprovalTimeout(id, pending.id));
    }, Math.max(0, pending.askedAt + this.approvalTimeoutMs - this.now()));
    timer.unref?.();
    this.approvalTimers.set(id, { timer, approvalId: pending.id });
  }

  clearApprovalTimer(id) {
    const entry = this.approvalTimers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.approvalTimers.delete(id);
  }

  enqueue(id) {
    if (this.queued.has(id)) return;
    const task = this.store.get(id);
    if (!task || task.status !== 'created') return;
    if (this.localRuntime && (task.localAuthorization !== this.localRuntime.generation || task.recoveryRequired)) return;
    this.queue.push(id);
    if (this.localRuntime) this.queue.sort((a, b) => this.get(a).queueOrder - this.get(b).queueOrder);
    this.queued.add(id);
  }

  pump() {
    if (this.disposed || this.activeTaskId) return;
    while (this.queue.length > 0) {
      const id = this.queue.shift();
      this.queued.delete(id);
      const task = this.store.get(id);
      if (!task || task.status !== 'created') continue;
      this.activeTaskId = id;
      this.execute(id).catch((error) => this.fail(id, error));
      return;
    }
  }

  async execute(id) {
    let task = this.get(id);
    task = await this.persist(id, { status: 'preparing', lastError: null });
    if (this.disposed || this.store.get(id)?.status !== 'preparing') return;

    const created = await this.sessionController.create({ cwd: task.cwd });
    const sessionId = created.sessionId;
    // Record the session before yielding to cancellation. sessionController's
    // contract has no close/delete, so a session that exists in the host but is
    // referenced by nothing here can never be adopted, resumed or attributed an
    // event again: it leaks for the life of the host process.
    //
    // The patch deliberately carries no status. persist() drops an entire patch
    // that would move a terminal task backwards, so pairing sessionId with
    // 'preparing' would lose the session id on exactly the cancelled task that
    // needs it recorded.
    this.sessionToTask.set(sessionId, id);
    task = await this.persist(id, { sessionId });
    if (this.disposed || this.store.get(id)?.status !== 'preparing') return;

    const agent = await this.resolveAgentCold(task);
    if (this.disposed || this.store.get(id)?.status !== 'preparing') return;

    const goal = this.goals.create(agent, {
      objective: task.objective,
      maxGoalRounds: task.maxGoalRounds,
    });
    await this.persist(id, {
      goalId: goal.id,
      goalRevision: goal.revision,
      goalPhase: goal.phase,
      status: 'running',
      lastError: null,
    });
  }

  async resolveAgentCold(task) {
    if (!task.sessionId) throw new TaskError('no-session', 'task has no session', 409);
    const result = await this.sessionController.resolveAgent(task.sessionId);
    if (result?.error) {
      throw new Error(`agent unavailable: ${JSON.stringify(result.error)}`);
    }
    return result.agent;
  }

  async waitUser(id, reason) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status)) return task;
    if (task.status === 'waiting_user' && task.lastError === reason) return task;
    const updated = await this.persist(id, {
      status: 'waiting_user',
      lastError: reason,
      lastAssistantText: this.lastText.get(id) ?? task.lastAssistantText,
    });
    this.finishLane(id);
    return updated;
  }

  async finalizeCompleted(id) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status)) return task;
    if (task.recoveryRequired || task.lastError?.startsWith('approval-') || pendingApprovalsOf(task).length > 0) return task;
    const updated = await this.persist(id, {
      status: 'completed',
      goalPhase: 'complete',
      lastAssistantText: this.lastText.get(id) ?? task.lastAssistantText,
      ...approvalPatch([]),
      lastError: null,
    });
    this.clearCompletionTimer(id);
    this.finishLane(id);
    return updated;
  }

  scheduleCompletionFallback(id) {
    this.clearCompletionTimer(id);
    const timer = setTimeout(() => {
      this.completionTimers.delete(id);
      this.enqueueEvent(id, () => this.onCompletionFallback(id));
    }, 60_000);
    timer.unref?.();
    this.completionTimers.set(id, timer);
  }

  async onCompletionFallback(id) {
    const task = this.store.get(id);
    if (!task || TERMINAL_STATUSES.has(task.status) || task.goalPhase !== 'complete') return;
    const agent = task.sessionId ? this.agents.get(task.sessionId) : undefined;
    if (agent?.status === 'running') {
      this.scheduleCompletionFallback(id);
      return;
    }
    await this.finalizeCompleted(id);
  }

  clearCompletionTimer(id) {
    const timer = this.completionTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.completionTimers.delete(id);
  }

  async fail(id, error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.persist(id, { status: 'failed', lastError: message, ...approvalPatch([]) });
    } catch (persistError) {
      this.logger.warn?.(`[outpost-butler] could not persist failure for ${id}: ${persistError.message}`);
    }
    this.logger.warn?.(`[outpost-butler] task ${id} failed: ${message}`);
    this.finishLane(id);
  }

  finishLane(id) {
    this.clearApprovalTimer(id);
    this.clearCompletionTimer(id);
    const task = this.store.get(id);
    const agent = task?.sessionId ? this.agents.get(task.sessionId) : undefined;
    // A refused/timed-out approval cancels asynchronously. Do not start another
    // task until that turn has actually stopped.
    if (agent?.status === 'running' && this.activeTaskId === id) return;
    if (this.activeTaskId === id) this.activeTaskId = null;
    this.pump();
  }

  persist(id, patch) {
    const previous = this.writeChains.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.store.get(id);
        if (!current) throw new TaskError('not-found', `task not found: ${id}`, 404);
        const resolved = typeof patch === 'function' ? patch(current) : patch;
        if (!resolved || Object.keys(resolved).length === 0) return current;
        // A terminal task never moves back to a live state.
        if (TERMINAL_STATUSES.has(current.status) && resolved.status && resolved.status !== current.status) {
          return current;
        }
        return this.store.update(id, resolved);
      });
    this.writeChains.set(id, next.catch(() => undefined));
    return next;
  }

  publicTask(task) {
    if (!task) return undefined;
    return {
      id: task.id,
      title: task.title,
      objective: task.objective,
      status: task.status,
      cwd: task.cwd,
      sessionId: task.sessionId,
      goalId: task.goalId,
      goalRevision: task.goalRevision,
      goalPhase: task.goalPhase,
      maxGoalRounds: task.maxGoalRounds,
      autoResume: task.autoResume,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      revision: task.revision,
      lastAssistantText: task.lastAssistantText,
      deliverables: task.deliverables,
      ...approvalPatch(pendingApprovalsOf(task)),
      lastError: task.lastError,
      ...(this.localRuntime ? {
        queueOrder: task.queueOrder ?? null,
        authorized: task.localAuthorization === this.localRuntime.generation,
        recoveryRequired: task.recoveryRequired === true,
      } : {}),
    };
  }

  async dispose() {
    this.disposed = true;
    for (const entry of this.approvalTimers.values()) clearTimeout(entry.timer);
    this.approvalTimers.clear();
    for (const timer of this.completionTimers.values()) clearTimeout(timer);
    this.completionTimers.clear();
    for (const timer of this.approvalStops.values()) clearTimeout(timer);
    this.approvalStops.clear();
    await Promise.all(this.eventChains.values());
    await Promise.all(this.writeChains.values());
  }
}
