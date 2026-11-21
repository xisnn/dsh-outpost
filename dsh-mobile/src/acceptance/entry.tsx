// Rurea B1 acceptance entry — bundled ONLY into the isolated verification app
// via -PDSH_TEST_ENTRY_FILE (compile-time isolation; never the production entry).
// Drives a REAL agent Run against a loopback reactive stub model on the Shizuku
// secondary display, auto-approves non-blocked phone actions, and reports the
// per-tool execution results so gesture EXECUTION (not just decision logic) is
// verified in a normal process where the accessibility service is bound.
import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { AppRegistry, Text, View } from 'react-native';
import { agentClient, isApprovalAllowBlocked } from '../core/agent';

const HOST = '127.0.0.1:8787'; // loopback (agent allows HTTP only here); use `adb reverse tcp:8787 tcp:8787` to forward to the host stub
const GOAL = 'Rurea acceptance: open contacts, read screen, type, tap, scroll, home';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitDisplay(timeoutMs = 20000): Promise<number> {
  await agentClient.setBackgroundAutoStart(true);
  await agentClient.backgroundStart();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await agentClient.backgroundStatus();
    if (st.connected && st.permissionGranted && st.displayId > 0) return st.displayId;
    await sleep(400);
  }
  return -1;
}

async function runAcceptance(): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = { goal: GOAL };
  try {
    await agentClient.saveModelSettings(
      'OPENAI_COMPAT',
      `http://${HOST}/v1`,
      'rurea-acceptance-stub',
      'stub-key',
    );
    const displayId = await waitDisplay();
    summary.displayId = displayId;
    if (displayId <= 0) {
      summary.phase = 'failed';
      summary.error = 'BACKGROUND_DISPLAY_NOT_READY';
      return summary;
    }
    // Phone tools register only when PhoneBridge.isConnected() (a11y service
    // instance bound). Wait for the async bind before starting the Run, else
    // the registry omits phone_* and every call returns "unknown tool".
    let connected = false;
    const a11yDeadline = Date.now() + 90000;
    while (Date.now() < a11yDeadline) {
      const cap = await agentClient.getPhoneCapabilities();
      if (cap.accessibilityConnected) {
        connected = true;
        break;
      }
      await sleep(300);
    }
    summary.accessibilityConnected = connected;
    if (!connected) {
      summary.phase = 'failed';
      summary.error = 'A11Y_NOT_CONNECTED';
      return summary;
    }
    await agentClient.startCloud(GOAL);
    const deadline = Date.now() + 90000;
    let last: any = null;
    const decided = new Set<string>();
    while (Date.now() < deadline) {
      const snap = await agentClient.snapshot();
      last = snap;
      const pa = snap.pendingApproval;
      if (pa && !isApprovalAllowBlocked(pa) && !decided.has(pa.callId)) {
        decided.add(pa.callId);
        try {
          await agentClient.decide(pa.callId, pa.digest, true);
        } catch {
          // NO_PENDING_APPROVAL / digest race: already decided or moved on; keep polling.
        }
        continue;
      }
      if (snap.pendingHandoff) {
        // Non-sensitive acceptance targets; resume to keep the run moving.
        try {
          await agentClient.resumeHandoff();
        } catch {}
        continue;
      }
      if (['completed', 'failed', 'interrupted'].includes(snap.phase)) break;
      await sleep(300);
    }
    summary.phase = last?.phase ?? 'timeout';
    summary.error = last?.error ?? null;
    summary.text = last?.text ?? null;
    summary.displayIdLive = last?.backgroundDisplayId ?? null;
    summary.events = (last?.events ?? []).map((e: any) => ({
      tool: e.toolName,
      status: e.status,
      detail: (e.detail ?? '').slice(0, 200),
    }));
  } catch (e: any) {
    summary.phase = 'failed';
    summary.error = String(e?.message ?? e);
  }
  return summary;
}

function AcceptanceApp() {
  const [status, setStatus] = useState('starting');
  useEffect(() => {
    let done = false;
    (async () => {
      const summary = await runAcceptance();
      const line = `RUREA_ACCEPTANCE ${JSON.stringify(summary)}`;
      console.log(line);
      try {
        await fetch(`http://${HOST}/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(summary),
        });
      } catch {}
      if (!done) setStatus(`${summary.phase} · display ${summary.displayId}`);
    })();
    return () => {
      done = true;
    };
  }, []);
  return (
    <View style={{ flex: 1, padding: 24, backgroundColor: '#0b1f3a' }}>
      <Text style={{ color: '#d4af37', fontSize: 18 }}>Rurea acceptance</Text>
      <Text style={{ color: '#fff', marginTop: 12 }}>{status}</Text>
    </View>
  );
}

AppRegistry.registerComponent('DshPocket', () => AcceptanceApp);
