/**
 * Rurea C1 流式 UX 回归测试（归入 test:agentChain）：
 *
 * 覆盖：
 *   1. 纯逻辑（src/core/agentStream.ts）：自适应轮询节拍、平滑打字机推进（含 emoji 代理对安全与
 *      reduceMotion 零动效直出）、native agentStream 事件合并防回退/防串 run、零闪烁收尾视图模型；
 *   2. UI 组件（src/components/AgentStreamingBubble.tsx）：增量文本 + 光标渲染、可中断「停止」按钮、
 *      stopping / settling 状态边界；
 *   3. 跨层接线校验：CloudModel 4/4 协议全走 transport.stream、AgentRuntime 按步重置 liveText 与
 *      在途中断归因、AgentModule 节流推送与 invalidate 清理、AgentButlerScreen 完整接入流式 UX。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { componentHarness, loadSource } from './support/component-harness.mjs';

const agentStream = loadSource('core/agentStream.ts');
const {
  STREAM_POLL_ACTIVE_MS,
  STREAM_POLL_IDLE_MS,
  advanceRevealedLength,
  applyStreamEvent,
  resolveStreamingBubble,
  safeSlice,
  snapshotPollIntervalMs,
} = agentStream;

function makeSnapshot(overrides = {}) {
  return {
    supported: true,
    ok: true,
    runId: 'run-1',
    phase: 'running',
    step: 1,
    paused: false,
    backgroundLost: false,
    streamText: null,
    backgroundDisplayId: null,
    events: [],
    text: null,
    error: null,
    output: null,
    pendingApproval: null,
    pendingHandoff: null,
    queue: [],
    recovery: null,
    ...overrides,
  };
}

test('snapshotPollIntervalMs speeds up during active/stopping phases and relaxes when idle', () => {
  assert.equal(snapshotPollIntervalMs('queued'), STREAM_POLL_ACTIVE_MS);
  assert.equal(snapshotPollIntervalMs('preparing'), STREAM_POLL_ACTIVE_MS);
  assert.equal(snapshotPollIntervalMs('running'), STREAM_POLL_ACTIVE_MS);
  assert.equal(snapshotPollIntervalMs('stopping'), STREAM_POLL_ACTIVE_MS);
  assert.ok(STREAM_POLL_ACTIVE_MS < STREAM_POLL_IDLE_MS);

  assert.equal(snapshotPollIntervalMs('idle'), STREAM_POLL_IDLE_MS);
  assert.equal(snapshotPollIntervalMs('waiting_user'), STREAM_POLL_IDLE_MS);
  assert.equal(snapshotPollIntervalMs('completed'), STREAM_POLL_IDLE_MS);
  assert.equal(snapshotPollIntervalMs('failed'), STREAM_POLL_IDLE_MS);
  assert.equal(snapshotPollIntervalMs('interrupted'), STREAM_POLL_IDLE_MS);
});

test('advanceRevealedLength paces typewriter smoothly, catches up on bursts, and honors reduceMotion', () => {
  assert.equal(advanceRevealedLength(0, 0, false), 0);
  assert.equal(advanceRevealedLength(5, 0, false), 0);
  assert.equal(advanceRevealedLength(0, 5, false), 2);
  assert.equal(advanceRevealedLength(2, 5, false), 4);
  assert.equal(advanceRevealedLength(4, 5, false), 5);

  // Medium buffer advances steadily (4 chars/tick).
  assert.equal(advanceRevealedLength(0, 20, false), 4);
  // Large burst catches up smoothly (~1/6 backlog).
  assert.equal(advanceRevealedLength(0, 120, false), 20);
  // Clamps immediately if text shrinks on step switch.
  assert.equal(advanceRevealedLength(30, 8, false), 8);
  // Accessibility: reduceMotion jumps straight to full text.
  assert.equal(advanceRevealedLength(0, 120, true), 120);
});

test('safeSlice never splits UTF-16 surrogate pairs (emoji safety)', () => {
  const text = 'A🎉B🚀';
  // 'A' is index 0; '🎉' occupies UTF-16 indices 1 and 2.
  assert.equal(safeSlice(text, 0), '');
  assert.equal(safeSlice(text, 1), 'A');
  assert.equal(safeSlice(text, 2), 'A🎉');
  assert.equal(safeSlice(text, 3), 'A🎉');
  assert.equal(safeSlice(text, 4), 'A🎉B');
  assert.equal(safeSlice(text, 5), 'A🎉B🚀');
  assert.equal(safeSlice(text, 99), text);
});

test('applyStreamEvent updates streamText immediately and blocks stale/regressing events', () => {
  assert.equal(
    applyStreamEvent(null, { runId: 'run-1', phase: 'running', step: 1, streamText: 'hi' }),
    null,
  );

  const running = makeSnapshot({ runId: 'run-1', phase: 'running', step: 1, streamText: 'Hel' });
  const updated = applyStreamEvent(running, {
    runId: 'run-1',
    phase: 'running',
    step: 1,
    streamText: 'Hello world',
  });
  assert.equal(updated.streamText, 'Hello world');
  assert.equal(updated.phase, 'running');

  // Stale event from another run is ignored while current run is still active.
  const ignoredOther = applyStreamEvent(updated, {
    runId: 'run-old',
    phase: 'running',
    step: 1,
    streamText: 'stale',
  });
  assert.equal(ignoredOther, updated);

  // Terminal phase for the same run must never regress back to running.
  const completed = makeSnapshot({ runId: 'run-1', phase: 'completed', step: 2, text: 'Done' });
  const noRegress = applyStreamEvent(completed, {
    runId: 'run-1',
    phase: 'running',
    step: 2,
    streamText: 'late delta',
  });
  assert.equal(noRegress, completed);

  // A new run can replace a terminal snapshot.
  const nextRun = applyStreamEvent(completed, {
    runId: 'run-2',
    phase: 'running',
    step: 1,
    streamText: 'New',
  });
  assert.equal(nextRun.runId, 'run-2');
  assert.equal(nextRun.streamText, 'New');
  assert.equal(nextRun.step, 1);

  // Waiting for approval keeps waiting_user while non-terminal events arrive.
  const waiting = makeSnapshot({
    runId: 'run-1',
    phase: 'waiting_user',
    pendingApproval: {
      callId: 'c1',
      toolName: 'workspace_write',
      digest: 'abc',
      reason: 'write',
      arguments: {},
      risk: 'write',
      backgroundLost: false,
    },
  });
  const stillWaiting = applyStreamEvent(waiting, {
    runId: 'run-1',
    phase: 'running',
    step: 1,
    streamText: null,
  });
  assert.equal(stillWaiting.phase, 'waiting_user');
});

test('resolveStreamingBubble models working, streaming, stopping, settling, and hidden states', () => {
  // Working before first token arrives.
  const working = resolveStreamingBubble({
    snapshot: makeSnapshot({ phase: 'running', step: 1, streamText: null }),
    thread: [],
    backgroundPermissionMissing: false,
  });
  assert.equal(working.visible, true);
  assert.equal(working.mode, 'working');
  assert.equal(working.showCursor, false);
  assert.equal(working.canStop, true);

  // Actively streaming tokens.
  const streaming = resolveStreamingBubble({
    snapshot: makeSnapshot({ phase: 'running', step: 2, streamText: '正在输出', backgroundDisplayId: 7 }),
    thread: [],
    backgroundPermissionMissing: false,
  });
  assert.equal(streaming.visible, true);
  assert.equal(streaming.mode, 'streaming');
  assert.equal(streaming.targetText, '正在输出');
  assert.equal(streaming.showCursor, true);
  assert.equal(streaming.canStop, true);
  assert.match(streaming.statusLabel, /正在生成/);
  assert.match(streaming.statusLabel, /第 2 步/);
  assert.match(streaming.statusLabel, /后台屏/);

  // Stopping preserves partial text without cursor or stop button.
  const stopping = resolveStreamingBubble({
    snapshot: makeSnapshot({ phase: 'stopping', step: 2, streamText: '半截回答' }),
    thread: [],
    backgroundPermissionMissing: false,
  });
  assert.equal(stopping.visible, true);
  assert.equal(stopping.mode, 'stopping');
  assert.equal(stopping.targetText, '半截回答');
  assert.equal(stopping.showCursor, false);
  assert.equal(stopping.canStop, false);

  // Completed before thread refresh: settling holds text to prevent flicker.
  const settling = resolveStreamingBubble({
    snapshot: makeSnapshot({ phase: 'completed', text: '最终答复' }),
    thread: [{ role: 'user', text: '你好', at: 1 }],
    backgroundPermissionMissing: false,
  });
  assert.equal(settling.visible, true);
  assert.equal(settling.mode, 'settling');
  assert.equal(settling.targetText, '最终答复');
  assert.equal(settling.showCursor, false);
  assert.equal(settling.canStop, false);

  // Once thread catches up, bubble hides to avoid duplicate text.
  const synced = resolveStreamingBubble({
    snapshot: makeSnapshot({ phase: 'completed', text: '最终答复' }),
    thread: [
      { role: 'user', text: '你好', at: 1 },
      { role: 'assistant', text: '最终答复', at: 2 },
    ],
    backgroundPermissionMissing: false,
  });
  assert.equal(synced.visible, false);
  assert.equal(synced.mode, 'hidden');

  // Hidden when approval card is active.
  const withApproval = resolveStreamingBubble({
    snapshot: makeSnapshot({
      phase: 'waiting_user',
      streamText: '准备写入',
      pendingApproval: {
        callId: 'c1',
        toolName: 'workspace_write',
        digest: 'abc',
        reason: 'write',
        arguments: {},
        risk: 'write',
        backgroundLost: false,
      },
    }),
    thread: [],
    backgroundPermissionMissing: false,
  });
  assert.equal(withApproval.visible, false);
});

test('AgentStreamingBubble renders incremental text, cursor, and interruptible stop action', () => {
  let stopCalls = 0;
  const h = componentHarness('components/AgentStreamingBubble.tsx', 'AgentStreamingBubble', {
    mode: 'streaming',
    statusLabel: '正在生成 · 第 1 步',
    text: '你好，世界',
    showCursor: true,
    canStop: true,
    stopDisabled: false,
    reduceMotion: true,
    onStop: () => { stopCalls += 1; },
  });

  const text = h.text();
  assert.match(text, /正在生成 · 第 1 步/);
  assert.match(text, /你好，世界/);
  assert.match(text, /▍/);

  const stopBtn = h.button('停止当前回答');
  assert.ok(stopBtn, 'expected interruptible stop button');
  assert.equal(stopBtn.props.disabled, false);
  stopBtn.props.onPress();
  assert.equal(stopCalls, 1);

  // Stopping mode hides stop button and cursor while preserving partial text.
  h.render({
    mode: 'stopping',
    statusLabel: '正在中断…',
    text: '半截文本',
    showCursor: false,
    canStop: false,
  });
  assert.equal(h.button('停止当前回答'), undefined);
  assert.match(h.text(), /正在中断…/);
  assert.match(h.text(), /半截文本/);
  assert.doesNotMatch(h.text(), /▍/);

  // Settling mode renders clean assistant bubble without spinner or cursor.
  h.render({
    mode: 'settling',
    statusLabel: '管家',
    text: '最终结果',
    showCursor: false,
    canStop: false,
  });
  assert.equal(h.nodes().some((n) => n.type === 'ActivityIndicator'), false);
  assert.match(h.text(), /管家/);
  assert.match(h.text(), /最终结果/);
});

test('end-to-end streaming wiring spans CloudModel (4/4 protocols), AgentRuntime, AgentModule, and AgentButlerScreen', () => {
  const cloudModel = fs.readFileSync(
    new URL('../android/agent-core/src/main/kotlin/com/dshpocket/agent/core/CloudModel.kt', import.meta.url),
    'utf8',
  );
  const streamCalls = cloudModel.match(/transport\.stream\(/g) || [];
  assert.equal(streamCalls.length, 4, `expected all 4 cloud protocols to use transport.stream, got ${streamCalls.length}`);
  assert.match(cloudModel, /responsesTextDelta\(event\)/);

  const runtime = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentRuntime.kt', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /override fun onStepStarted\(step: Int\)/);
  assert.match(runtime, /fun setStreamListener\(/);
  assert.match(runtime, /abortedInFlight/);

  const moduleSrc = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentModule.kt', import.meta.url),
    'utf8',
  );
  assert.match(moduleSrc, /STREAM_EVENT_NAME = "agentStream"/);
  assert.match(moduleSrc, /detachStreamListener\(\)/);

  const screenSrc = fs.readFileSync(new URL('../src/screens/AgentButlerScreen.tsx', import.meta.url), 'utf8');
  assert.match(screenSrc, /agentClient\.subscribeStream\(/);
  assert.match(screenSrc, /<AgentStreamingBubble\b/);
  assert.match(screenSrc, /resolveStreamingBubble\(/);
  assert.match(screenSrc, /distanceFromBottom\(/);
});
