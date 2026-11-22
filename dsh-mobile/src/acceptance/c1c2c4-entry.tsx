// Rurea C1 + C2 + C4 real-device acceptance entry — compiled ONLY into the
// isolated verification package com.dshoutpost.p1.p6next via -PDSH_TEST_ENTRY_FILE.
// Drives real AgentService/AgentRuntime + native OutpostAccessibilityService
// against the host loopback stub server (127.0.0.1:8787) without paid APIs or
// personal user data.
import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { AppRegistry, ScrollView, Text, View } from 'react-native';

import {
  agentClient,
  isApprovalAllowBlocked,
  type AgentSnapshot,
  type AgentStreamEvent,
} from '../core/agent';
import {
  formatApprovalCountdown,
  isApprovalExpired,
} from '../core/agentApproval';
import {
  classifyAgentFailure,
  extractAgentError,
  hasRunSideEffects,
} from '../core/agentRecovery';

const HOST = '127.0.0.1:8787';
const TERMINAL_PHASES = new Set(['completed', 'failed', 'interrupted']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ScenarioResult {
  name: string;
  ok: boolean;
  details: Record<string, unknown>;
}

async function waitTerminal(timeoutMs = 45000): Promise<AgentSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = await agentClient.snapshot();
  while (Date.now() < deadline) {
    if (TERMINAL_PHASES.has(last.phase)) return last;
    await sleep(120);
    last = await agentClient.snapshot();
  }
  return last;
}

async function runSuite(onProgress: (line: string) => void): Promise<Record<string, unknown>> {
  const results: ScenarioResult[] = [];
  const capInitial = await agentClient.getPhoneCapabilities();

  await agentClient.setBackgroundAutoStart(false);
  await agentClient.clearThread();
  await agentClient.saveModelSettings('OPENAI_COMPAT', `http://${HOST}/v1`, 'stub-compat', 'stub-key');

  // ── 1. C1 Incremental Streaming (OPENAI_COMPAT) ────────────────────────
  try {
    onProgress('1/7 C1_STREAM_COMPAT');
    const goal = '[C1_STREAM_COMPAT]';
    const pushed: AgentStreamEvent[] = [];
    const seenLengths = new Set<number>();
    const unsub = agentClient.subscribeStream((ev) => {
      pushed.push(ev);
      if (ev.streamText) seenLengths.add(ev.streamText.length);
    });
    try {
      await agentClient.startCloud(goal);
      const snap = await waitTerminal(20000);
      const ok =
        pushed.length >= 2 &&
        seenLengths.size >= 2 &&
        snap.phase === 'completed' &&
        snap.text === '第一段，第二段，第三段，完成🎉' &&
        snap.goal === goal;
      results.push({
        name: 'C1_STREAM_COMPAT',
        ok,
        details: {
          phase: snap.phase,
          goal: snap.goal,
          text: snap.text,
          streamPushCount: pushed.length,
          distinctStreamLengths: Array.from(seenLengths).sort((a, b) => a - b),
        },
      });
    } finally {
      unsub();
    }
  } catch (e) {
    results.push({ name: 'C1_STREAM_COMPAT', ok: false, details: { error: String(e) } });
  }

  // ── 2. C1 Incremental Streaming (OPENAI_RESPONSES) ─────────────────────
  try {
    onProgress('2/7 C1_STREAM_RESPONSES');
    await agentClient.saveModelSettings('OPENAI_RESPONSES', `http://${HOST}/v1`, 'stub-resp', 'stub-key');
    const goal = '[C1_STREAM_RESPONSES]';
    const pushed: AgentStreamEvent[] = [];
    const seenLengths = new Set<number>();
    const unsub = agentClient.subscribeStream((ev) => {
      pushed.push(ev);
      if (ev.streamText) seenLengths.add(ev.streamText.length);
    });
    try {
      await agentClient.startCloud(goal);
      const snap = await waitTerminal(20000);
      const ok =
        pushed.length >= 2 &&
        seenLengths.size >= 2 &&
        snap.phase === 'completed' &&
        snap.text === 'Responses 流式增量验证成功';
      results.push({
        name: 'C1_STREAM_RESPONSES',
        ok,
        details: {
          phase: snap.phase,
          text: snap.text,
          streamPushCount: pushed.length,
          distinctStreamLengths: Array.from(seenLengths).sort((a, b) => a - b),
        },
      });
    } finally {
      unsub();
    }
  } catch (e) {
    results.push({ name: 'C1_STREAM_RESPONSES', ok: false, details: { error: String(e) } });
  } finally {
    await agentClient.saveModelSettings('OPENAI_COMPAT', `http://${HOST}/v1`, 'stub-compat', 'stub-key');
  }

  // ── 3. C1 + C2 Mid-stream Abort + INTERRUPTED RunStore Persistence ─────
  try {
    onProgress('3/7 C1_C2_MIDSTREAM_STOP');
    const goal = '[C1_MIDSTREAM_STOP]';
    let stopCalledAt: number | null = null;
    let partialSeen = '';
    const unsub = agentClient.subscribeStream((ev) => {
      if (ev.streamText && ev.streamText.includes('半截输出')) {
        partialSeen = ev.streamText;
      }
    });
    try {
      const startSnap = await agentClient.startCloud(goal);
      const waitDeadline = Date.now() + 8000;
      while (Date.now() < waitDeadline && !partialSeen.includes('半截输出')) {
        const s = await agentClient.snapshot();
        if (s.streamText && s.streamText.includes('半截输出')) {
          partialSeen = s.streamText;
          break;
        }
        await sleep(60);
      }
      stopCalledAt = Date.now();
      await agentClient.stop();
      const snap = await waitTerminal(10000);
      const stopLatencyMs = stopCalledAt ? Date.now() - stopCalledAt : -1;
      const history = await agentClient.history();
      const runRecord = history.find((h) => h.runId === (snap.runId ?? startSnap.runId)) ?? null;
      const thread = await agentClient.thread();
      const lastMsg = thread[thread.length - 1] ?? null;
      const threadPreservedPartial = Boolean(
        lastMsg?.role === 'assistant' &&
          lastMsg.text.includes('半截输出') &&
          lastMsg.text.includes('已中断'),
      );
      const ok =
        partialSeen.includes('半截输出') &&
        snap.phase === 'interrupted' &&
        snap.error === 'stopped-by-user' &&
        stopLatencyMs >= 0 &&
        stopLatencyMs < 5000 &&
        runRecord?.phase === 'interrupted' &&
        threadPreservedPartial;
      results.push({
        name: 'C1_C2_MIDSTREAM_STOP',
        ok,
        details: {
          partialSeen,
          phase: snap.phase,
          error: snap.error,
          stopLatencyMs,
          historyPhase: runRecord?.phase ?? null,
          historyReason: runRecord?.reason ?? null,
          threadLastText: lastMsg?.text ?? null,
        },
      });
    } finally {
      unsub();
    }
  } catch (e) {
    results.push({ name: 'C1_C2_MIDSTREAM_STOP', ok: false, details: { error: String(e) } });
  }

  // ── 4. C4 HTTP 401 Auth Error Classification ───────────────────────────
  try {
    onProgress('4/7 C4_MODEL_AUTH_401');
    const goal = '[C4_HTTP_401]';
    await agentClient.startCloud(goal);
    const snap = await waitTerminal(15000);
    const plan = classifyAgentFailure({
      raw: snap.error,
      source: 'run',
      goal: snap.goal ?? goal,
      hasSideEffects: hasRunSideEffects(snap.events),
    });
    const ok =
      snap.phase === 'failed' &&
      Boolean(snap.error?.startsWith('http-401')) &&
      snap.goal === goal &&
      plan.category === 'model_auth' &&
      plan.actions[0]?.id === 'open_settings';
    results.push({
      name: 'C4_MODEL_AUTH_401',
      ok,
      details: {
        phase: snap.phase,
        error: snap.error,
        goal: snap.goal,
        category: plan.category,
        title: plan.title,
        firstAction: plan.actions[0]?.id ?? null,
      },
    });
  } catch (e) {
    results.push({ name: 'C4_MODEL_AUTH_401', ok: false, details: { error: String(e) } });
  }

  // ── 5. C4 Fault-Injected Retry (HTTP 503 + Abrupt Socket Drop) ─────────
  try {
    onProgress('5/7 C4_FAULT_RETRY_503_AND_SOCKET_DROP');
    // 5a: HTTP 503 -> model_provider -> retry -> completed
    await agentClient.startCloud('[C4_HTTP_503]');
    const fail503 = await waitTerminal(15000);
    const plan503 = classifyAgentFailure({
      raw: fail503.error,
      source: 'run',
      goal: fail503.goal,
      hasSideEffects: hasRunSideEffects(fail503.events),
    });
    let pass503: AgentSnapshot | null = null;
    if (plan503.actions[0]?.id === 'retry_goal' && fail503.goal) {
      await agentClient.startCloud(fail503.goal);
      pass503 = await waitTerminal(15000);
    }

    // 5b: Abrupt socket drop -> network -> retry -> completed
    await agentClient.startCloud('[C4_SOCKET_DROP]');
    const failDrop = await waitTerminal(15000);
    const planDrop = classifyAgentFailure({
      raw: failDrop.error,
      source: 'run',
      goal: failDrop.goal,
      hasSideEffects: hasRunSideEffects(failDrop.events),
    });
    let passDrop: AgentSnapshot | null = null;
    if (planDrop.actions[0]?.id === 'retry_goal' && failDrop.goal) {
      await agentClient.startCloud(failDrop.goal);
      passDrop = await waitTerminal(15000);
    }

    const ok =
      fail503.phase === 'failed' &&
      Boolean(fail503.error?.startsWith('http-503')) &&
      plan503.category === 'model_provider' &&
      pass503?.phase === 'completed' &&
      pass503?.text === 'C4_RETRY_503_OK' &&
      failDrop.phase === 'failed' &&
      Boolean(failDrop.error?.startsWith('model-transport')) &&
      planDrop.category === 'network' &&
      passDrop?.phase === 'completed' &&
      passDrop?.text === 'C4_RETRY_NET_OK';
    results.push({
      name: 'C4_FAULT_RETRY_503_AND_SOCKET_DROP',
      ok,
      details: {
        fail503Error: fail503.error,
        fail503Category: plan503.category,
        retry503Phase: pass503?.phase ?? null,
        retry503Text: pass503?.text ?? null,
        failDropError: failDrop.error,
        failDropCategory: planDrop.category,
        retryDropPhase: passDrop?.phase ?? null,
        retryDropText: passDrop?.text ?? null,
      },
    });
  } catch (e) {
    results.push({ name: 'C4_FAULT_RETRY_503_AND_SOCKET_DROP', ok: false, details: { error: String(e) } });
  }

  // ── 6. C4 BACKGROUND_NOT_READY Reject + No-Fallback + AutoStart Escape ─
  try {
    onProgress('6/7 C4_BACKGROUND_NOT_READY');
    await agentClient.setBackgroundAutoStart(true);
    let caught: unknown = null;
    try {
      await agentClient.startCloud('[C4_BG_NOT_READY]');
    } catch (e) {
      caught = e;
    }
    const parsed = caught ? extractAgentError(caught) : { code: null, message: '' };
    const bg = await agentClient.backgroundStatus();
    const plan = classifyAgentFailure({
      raw: parsed.message,
      code: parsed.code,
      source: 'action',
      background: bg,
      autoStartEnabled: true,
    });
    await agentClient.setBackgroundAutoStart(false);
    await agentClient.startCloud('[C4_BG_RECOVERED]');
    const recovered = await waitTerminal(15000);
    const ok =
      parsed.code === 'BACKGROUND_NOT_READY' &&
      plan.category === 'background_display' &&
      plan.actions.some((a) => a.id === 'disable_auto_start') &&
      plan.actions.some((a) => a.id === 'open_background') &&
      recovered.phase === 'completed' &&
      recovered.text === 'C4_BG_RECOVERED_OK';
    results.push({
      name: 'C4_BACKGROUND_NOT_READY',
      ok,
      details: {
        rejectedCode: parsed.code,
        rejectedMessage: parsed.message,
        bgState: bg.state,
        category: plan.category,
        actionIds: plan.actions.map((a) => a.id),
        recoveredPhase: recovered.phase,
        recoveredText: recovered.text,
      },
    });
  } catch (e) {
    await agentClient.setBackgroundAutoStart(false).catch(() => undefined);
    results.push({ name: 'C4_BACKGROUND_NOT_READY', ok: false, details: { error: String(e) } });
  }

  // ── 7. C2 Three-Tier Policy + Approval TTL + Autonomous Phone Tools ───
  try {
    onProgress('7/7 C2_THREE_TIER_POLICY');
    let a11yConnected = false;
    const a11yDeadline = Date.now() + 30000;
    while (Date.now() < a11yDeadline) {
      const cap = await agentClient.getPhoneCapabilities();
      if (cap.accessibilityConnected) {
        a11yConnected = true;
        break;
      }
      await sleep(300);
    }
    if (!a11yConnected) {
      results.push({
        name: 'C2_THREE_TIER_POLICY',
        ok: false,
        details: { skippedReason: 'A11Y_NOT_CONNECTED' },
      });
    } else {
      await agentClient.startCloud('[C2_POLICY_SUITE]');
      const approvals: Array<{
        toolName: string;
        callId: string;
        reason: string;
        expiresAt: number | null;
        countdown: string | null;
        expiredAtObservation: boolean;
        decision: 'allow' | 'reject';
      }> = [];
      const decided = new Set<string>();
      const deadline = Date.now() + 60000;
      let last = await agentClient.snapshot();
      while (Date.now() < deadline) {
        const pa = last.pendingApproval;
        if (pa && !isApprovalAllowBlocked(pa) && !decided.has(pa.callId)) {
          decided.add(pa.callId);
          const now = Date.now();
          const allow = pa.toolName === 'workspace_write';
          approvals.push({
            toolName: pa.toolName,
            callId: pa.callId,
            reason: pa.reason,
            expiresAt: typeof pa.expiresAt === 'number' ? pa.expiresAt : null,
            countdown: formatApprovalCountdown(pa, now),
            expiredAtObservation: isApprovalExpired(pa, now),
            decision: allow ? 'allow' : 'reject',
          });
          try {
            await agentClient.decide(pa.callId, pa.digest, allow);
          } catch {}
        }
        if (last.pendingHandoff) {
          try {
            await agentClient.resumeHandoff();
          } catch {}
        }
        if (TERMINAL_PHASES.has(last.phase)) break;
        await sleep(150);
        last = await agentClient.snapshot();
      }

      const finishedEvents = (last.events ?? []).filter((e) => e.type === 'tool_finished');
      const findEvent = (name: string) => finishedEvents.filter((e) => e.toolName === name);
      const openEvents = findEvent('phone_open');
      const alipayEvt = openEvents.find((e) => (e.detail ?? '').includes('PAYMENT_HARD_DENIED'));
      const calcOpenEvt = openEvents.find((e) => (e.detail ?? '').includes('OPENED com.android.bbkcalculator'));
      const screenEvt = findEvent('phone_screen')[0] ?? null;
      const scrollEvt = findEvent('phone_scroll')[0] ?? null;
      const keyEvt = findEvent('phone_key')[0] ?? null;
      const writeEvt = findEvent('workspace_write')[0] ?? null;
      const tapEvt = findEvent('phone_tap')[0] ?? null;

      const approvalTools = approvals.map((a) => a.toolName);
      const allApprovalsHaveTtl =
        approvals.length === 3 &&
        approvals.every((a) => typeof a.expiresAt === 'number' && a.expiresAt > 0 && a.countdown !== null && !a.expiredAtObservation);

      const ok =
        last.phase === 'completed' &&
        last.text === 'C2_POLICY_DONE' &&
        allApprovalsHaveTtl &&
        approvalTools.includes('phone_open') &&
        approvalTools.includes('workspace_write') &&
        approvalTools.includes('phone_tap') &&
        !approvalTools.includes('phone_screen') &&
        !approvalTools.includes('phone_scroll') &&
        !approvalTools.includes('phone_key') &&
        alipayEvt?.status === 'DENIED' &&
        writeEvt?.status === 'OK' &&
        tapEvt?.status === 'DENIED' &&
        calcOpenEvt?.status === 'OK' &&
        screenEvt?.status === 'OK' &&
        Boolean(scrollEvt) &&
        keyEvt?.status === 'OK';

      results.push({
        name: 'C2_THREE_TIER_POLICY',
        ok,
        details: {
          phase: last.phase,
          text: last.text,
          approvals,
          events: finishedEvents.map((e) => ({
            toolName: e.toolName,
            status: e.status,
            detail: (e.detail ?? '').slice(0, 180),
          })),
        },
      });
    }
  } catch (e) {
    results.push({ name: 'C2_THREE_TIER_POLICY', ok: false, details: { error: String(e) } });
  }

  const capFinal = await agentClient.getPhoneCapabilities();
  return {
    generatedAt: new Date().toISOString(),
    accessibilityInitial: capInitial,
    accessibilityFinal: capFinal,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    allOk: results.length === 7 && results.every((r) => r.ok),
    scenarios: results,
  };
}

function C1C2C4AcceptanceApp() {
  const [status, setStatus] = useState('initializing');
  const [summaryText, setSummaryText] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const report = await runSuite((line) => {
        if (!cancelled) setStatus(line);
      });
      const json = JSON.stringify(report);
      console.log(`RUREA_C1C2C4_REPORT ${json}`);
      for (let i = 0; i < 3; i++) {
        try {
          const resp = await fetch(`http://${HOST}/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: json,
          });
          if (resp.ok) break;
        } catch {}
        await sleep(500);
      }
      if (!cancelled) {
        setStatus(`done: ${String(report.passed)}/${String(report.total)} allOk=${String(report.allOk)}`);
        setSummaryText(JSON.stringify(report, null, 2));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={{ flex: 1, padding: 20, backgroundColor: '#0b1f3a' }}>
      <Text style={{ color: '#d4af37', fontSize: 18, fontWeight: '700' }}>
        Rurea C1+C2+C4 Vivo Acceptance
      </Text>
      <Text style={{ color: '#fff', marginTop: 10, fontSize: 14 }}>{status}</Text>
      <ScrollView style={{ marginTop: 12, flex: 1 }}>
        <Text style={{ color: '#cbd5e1', fontSize: 11 }}>{summaryText}</Text>
      </ScrollView>
    </View>
  );
}

AppRegistry.registerComponent('DshPocket', () => C1C2C4AcceptanceApp);
