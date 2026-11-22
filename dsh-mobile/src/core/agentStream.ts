/**
 * Rurea C1 流式 UX 纯逻辑（零原生依赖，可完整单测）：
 *
 * 1. 自适应轮询节拍（运行/停止中高频兜底，空闲低频省电），与 native `agentStream` 推送互补；
 * 2. 平滑打字机增量推进（含代理对安全切片，不把 emoji 截成乱码；尊重 reduceMotion）；
 * 3. `agentStream` 推送事件合并（不回退终态、不串老 runId、不覆盖等待审批状态）；
 * 4. 零闪烁收尾视图模型（streaming → stopping → completed 落盘前无缝衔接，直到 thread 同步完成）。
 */
import type {
  AgentPhase,
  AgentSnapshot,
  AgentStreamEvent,
  AgentThreadMessage,
} from './agent';

/** 运行/中断中的快照兜底轮询间隔（配合 native 40ms 推送） */
export const STREAM_POLL_ACTIVE_MS = 180;
/** 空闲或等待用户交互时的快照轮询间隔 */
export const STREAM_POLL_IDLE_MS = 700;
/** 打字机增量逐帧推进间隔（仅在待显示缓冲 > 0 时运行） */
export const TYPEWRITER_TICK_MS = 24;

const PHASE_LABELS: Record<AgentPhase, string> = {
  idle: '等待任务',
  queued: '已排队',
  preparing: '准备中',
  running: '执行中',
  waiting_user: '等待你',
  stopping: '正在中断…',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

export function isActiveAgentPhase(phase: AgentPhase): boolean {
  return (
    phase === 'queued' ||
    phase === 'preparing' ||
    phase === 'running' ||
    phase === 'waiting_user'
  );
}

export function isTerminalAgentPhase(phase: AgentPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'interrupted';
}

/** 运行/中断期间提高快照轮询频次，保证状态与增量文本低延迟可见 */
export function snapshotPollIntervalMs(phase: AgentPhase): number {
  return phase === 'queued' || phase === 'preparing' || phase === 'running' || phase === 'stopping'
    ? STREAM_POLL_ACTIVE_MS
    : STREAM_POLL_IDLE_MS;
}

/**
 * 代理对安全切片：若 `end` 恰好落在 UTF-16 高代理码元上，向后多取 1 码元，
 * 避免打字机逐字推进时把 emoji 截成非法半字符。
 */
export function safeSlice(text: string, end: number): string {
  if (end <= 0) return '';
  if (end >= text.length) return text;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && end < text.length) {
    return text.slice(0, end + 1);
  }
  return text.slice(0, end);
}

/**
 * 计算下一帧应展示的字符长度：
 * - `reduceMotion === true` 时直接展示全文（无障碍零动效）；
 * - 缓冲较小时以 2~4 字平稳推进（打字机观感），大块突增时按 1/6 追赶不积压；
 * - 目标文本清空或缩短（如切到下一步）时立即对齐。
 */
export function advanceRevealedLength(
  currentLen: number,
  targetLen: number,
  reduceMotion: boolean,
): number {
  if (targetLen <= 0) return 0;
  if (reduceMotion) return targetLen;
  if (currentLen >= targetLen) return targetLen;
  const backlog = targetLen - currentLen;
  const step =
    backlog <= 6 ? Math.min(backlog, 2)
    : backlog <= 24 ? Math.min(backlog, 4)
    : Math.ceil(backlog / 6);
  return Math.min(targetLen, currentLen + step);
}

/**
 * 将 native 推送的 `agentStream` 事件安全合并到现有快照：
 * - 不接受空基线（等首次权威 snapshot）；
 * - 同 runId 下绝不把已终态（completed/failed/interrupted）回退成 running；
 * - 正在等待用户审批或接管时，保留 `waiting_user` 阶段；
 * - 跨 runId 时仅在旧 run 已结束或空闲时接受新 run，防止延迟事件串写。
 */
export function applyStreamEvent(
  prev: AgentSnapshot | null,
  event: AgentStreamEvent,
): AgentSnapshot | null {
  if (!prev) return prev;
  const sameRun = prev.runId !== null && event.runId !== null && prev.runId === event.runId;
  if (prev.runId && event.runId && !sameRun) {
    if (!isTerminalAgentPhase(prev.phase) && prev.phase !== 'idle') {
      return prev;
    }
    return {
      ...prev,
      runId: event.runId,
      phase: event.phase,
      step: event.step,
      streamText: event.streamText,
    };
  }
  if (sameRun && isTerminalAgentPhase(prev.phase) && !isTerminalAgentPhase(event.phase)) {
    return prev;
  }
  const keepWaiting = Boolean(prev.pendingApproval || prev.pendingHandoff);
  const nextPhase: AgentPhase = keepWaiting && !isTerminalAgentPhase(event.phase)
    ? 'waiting_user'
    : event.phase;
  return {
    ...prev,
    runId: event.runId ?? prev.runId,
    phase: nextPhase,
    step: sameRun ? Math.max(prev.step, event.step) : event.step,
    streamText: event.streamText,
  };
}

export type StreamingBubbleMode =
  | 'hidden'
  | 'working'
  | 'streaming'
  | 'stopping'
  | 'settling';

export interface StreamingBubbleState {
  visible: boolean;
  mode: StreamingBubbleMode;
  statusLabel: string;
  targetText: string;
  showCursor: boolean;
  canStop: boolean;
}

export interface ResolveStreamingBubbleInput {
  snapshot: AgentSnapshot | null;
  thread: readonly AgentThreadMessage[];
  backgroundPermissionMissing: boolean;
}

/**
 * 推导当前流式气泡的渲染态：
 * - 有审批卡/接管卡时不重复占用主注意力；
 * - `queued`/`preparing`/`running`/`waiting_user` → 实时增量展示（可随时中断）；
 * - `stopping` → 保留已生成的半截文本并明确显示「正在中断…」，不突兀消失；
 * - `completed` 且 `thread` 尚未刷新出对应回复 → 进入 `settling` 无缝承接，消除完成瞬间闪烁。
 */
export function resolveStreamingBubble({
  snapshot,
  thread,
  backgroundPermissionMissing,
}: ResolveStreamingBubbleInput): StreamingBubbleState {
  const hidden: StreamingBubbleState = {
    visible: false,
    mode: 'hidden',
    statusLabel: '',
    targetText: '',
    showCursor: false,
    canStop: false,
  };
  if (!snapshot) return hidden;
  if (snapshot.pendingApproval || snapshot.pendingHandoff) return hidden;

  const phase = snapshot.phase;
  const streamText = snapshot.streamText ?? '';

  if (isActiveAgentPhase(phase)) {
    const stepSuffix = snapshot.step ? ` · 第 ${snapshot.step} 步` : '';
    const bgSuffix = snapshot.backgroundDisplayId ? ' · 后台屏' : '';
    let statusLabel: string;
    if (snapshot.backgroundLost) {
      statusLabel = backgroundPermissionMissing ? '等待 Shizuku 授权…' : '等待后台屏恢复…';
    } else if (phase === 'waiting_user') {
      statusLabel = '等你处理…';
    } else if (streamText.length > 0) {
      statusLabel = `正在生成${stepSuffix}${bgSuffix}`;
    } else {
      statusLabel = `${PHASE_LABELS[phase]}${stepSuffix}${bgSuffix}`;
    }
    return {
      visible: true,
      mode: streamText.length > 0 ? 'streaming' : 'working',
      statusLabel,
      targetText: streamText,
      showCursor: streamText.length > 0,
      canStop: true,
    };
  }

  if (phase === 'stopping') {
    return {
      visible: true,
      mode: 'stopping',
      statusLabel: PHASE_LABELS.stopping,
      targetText: streamText,
      showCursor: false,
      canStop: false,
    };
  }

  if (phase === 'completed' && snapshot.text && snapshot.text.trim().length > 0) {
    const last = thread.length > 0 ? thread[thread.length - 1] : null;
    const synced = last !== null && last.role === 'assistant' && last.text === snapshot.text;
    if (!synced) {
      return {
        visible: true,
        mode: 'settling',
        statusLabel: '管家',
        targetText: snapshot.text,
        showCursor: false,
        canStop: false,
      };
    }
  }

  return hidden;
}
