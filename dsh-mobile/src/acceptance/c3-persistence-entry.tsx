// Rurea C3 persistence depth acceptance entry — compiled ONLY into the isolated
// verification package com.dshoutpost.p1.p6next via -PDSH_TEST_ENTRY_FILE.
// Drives 4 cold restarts (am force-stop between launches) verifying:
//   Stage 1: pre-init v1 file seeding -> Stop-the-World v1->v2 migration + backup +
//            memory v2 (pinned/kind/edit dup-key guard/budget) + multi-session + tool events
//   Stage 2: second cold restart persistence -> pendingReconciliation survives restart ->
//            acknowledgeRun clears reconciliation and persists reconciledAt
//   Stage 3: third cold restart clean recovery + inject schemaVersion=99 future manifest
//   Stage 4: fourth cold restart -> fail-closed STORAGE_DOWNGRADE_BLOCKED + zero disk mutation
import 'react-native-gesture-handler';
import React, { useEffect, useState } from 'react';
import { AppRegistry, ScrollView, Text, View } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

import { agentClient, type AgentRunEvent } from '../core/agent';
import { computeMemoryBudgetView, formatStorageNotice } from '../core/agentPersistence';
import { classifyAgentFailure, extractAgentError } from '../core/agentRecovery';

const HOST = '127.0.0.1:8787';
const TERMINAL_PHASES = new Set(['completed', 'failed', 'interrupted']);
const fs = ReactNativeBlobUtil.fs;
const DOC_DIR = fs.dirs.DocumentDir;
const STAGE_FILE = `${DOC_DIR}/c3-stage.txt`;
const SNAPSHOT_FILE = `${DOC_DIR}/c3-pre-downgrade.json`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitTerminal(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = await agentClient.snapshot();
  while (Date.now() < deadline) {
    if (TERMINAL_PHASES.has(last.phase)) return last;
    await sleep(120);
    last = await agentClient.snapshot();
  }
  return last;
}

async function postReport(payload: Record<string, unknown>): Promise<void> {
  const json = JSON.stringify(payload);
  console.log(`RUREA_C3_STAGE_REPORT ${json}`);
  for (let i = 0; i < 4; i++) {
    try {
      const resp = await fetch(`http://${HOST}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      if (resp.ok) return;
    } catch {}
    await sleep(400);
  }
}

async function seedLegacyV1DiskState(): Promise<void> {
  // Ensure clean manifest before seeding legacy v1 fixtures.
  const manifestPath = `${DOC_DIR}/storage-manifest.json`;
  if (await fs.exists(manifestPath)) {
    await fs.unlink(manifestPath);
  }
  const runsDir = `${DOC_DIR}/agent-runs`;
  if (!(await fs.exists(runsDir))) {
    await fs.mkdir(runsDir);
  }

  // Legacy v1 memory with duplicate keys left by historical edit bug.
  const memV1 = {
    version: 1,
    entries: [
      { id: 'v1-city-old', key: '城市', value: '北京', createdAt: 100, updatedAt: 100 },
      { id: 'v1-lang', key: '语言', value: '用中文回答', createdAt: 150, updatedAt: 200 },
      { id: 'v1-city-new', key: '城市', value: '上海', createdAt: 100, updatedAt: 500 },
    ],
  };
  await fs.writeFile(`${DOC_DIR}/agent-memory.json`, JSON.stringify(memV1), 'utf8');

  // Legacy flat thread.
  const threadV1 = {
    messages: [
      { role: 'user', text: '旧版首条问题', at: 300 },
      { role: 'assistant', text: '旧版回答', at: 400 },
    ],
  };
  await fs.writeFile(`${DOC_DIR}/agent-thread.json`, JSON.stringify(threadV1), 'utf8');

  // Legacy v1 terminal run + active side-effect run simulating mid-tool crash.
  await fs.writeFile(
    `${runsDir}/run-v1-done.properties`,
    'id=run-v1-done\nphase=COMPLETED\nstep=1\nrequiresReconciliation=false\nupdatedAt=550\ngoal=Legacy Done\n',
    'utf8',
  );
  await fs.writeFile(
    `${runsDir}/run-v1-crash.properties`,
    [
      'id=run-v1-crash',
      'phase=RUNNING',
      'step=2',
      'requiresReconciliation=false',
      'updatedAt=600',
      'goal=模拟崩溃写文件',
      'lastToolCallId=crash-call-1',
      'lastToolName=workspace_write',
      'lastToolDigest=abc123',
      'lastToolMayHaveSideEffect=true',
      'lastToolStatus=STARTED',
    ].join('\n') + '\n',
    'utf8',
  );
}

async function runStage1(): Promise<Record<string, unknown>> {
  // MUST seed legacy v1 files BEFORE calling any agentClient.* method so the very first
  // AgentRuntime.get(react) executes Stop-the-World StorageMigrator + RunRecovery on them.
  await seedLegacyV1DiskState();

  const st = await agentClient.storageStatus();
  await agentClient.setBackgroundAutoStart(false);
  const initialSnap = await agentClient.snapshot();
  const initialMem = await agentClient.getMemory();
  const initialSessions = await agentClient.sessions();

  const backupMemExists = Boolean(st.backupPath) && (await fs.exists(`${DOC_DIR}/${st.backupPath}/agent-memory.json`));
  const backupThrExists = Boolean(st.backupPath) && (await fs.exists(`${DOC_DIR}/${st.backupPath}/agent-thread.json`));

  // Test memory v2: pin a preference entry + verify edit duplicate key rejection + budget ordering.
  const added = await agentClient.saveMemoryEntry(null, '代码风格', '保持简洁', 'preference', true, true);
  let dupRejected = false;
  const langEntry = initialMem.find((m) => m.key === '语言');
  if (langEntry) {
    try {
      await agentClient.saveMemoryEntry(langEntry.id, '城市', '冲突修改', 'fact', false, true);
    } catch {
      dupRejected = true;
    }
  }
  const updatedMem = await agentClient.getMemory();
  const budget = await agentClient.getMemoryBudget();
  const budgetView = computeMemoryBudgetView(updatedMem, budget);

  // Test multi-session: create new session + run cloud task with read-only tool event persisted.
  const afterCreate = await agentClient.createSession();
  await agentClient.saveModelSettings('OPENAI_COMPAT', `http://${HOST}/v1`, 'stub-c3', 'stub-key');
  await agentClient.startCloud('[C3_PERSIST_RUN]');
  const doneSnap = await waitTerminal(30000);
  const sessionsAfterRun = await agentClient.sessions();
  const activeSession = sessionsAfterRun.sessions.find((s) => s.id === sessionsAfterRun.activeSessionId) ?? null;
  const historyRows = await agentClient.history();
  const runRow = historyRows.find((r) => r.runId === doneSnap.runId) ?? null;
  const events: AgentRunEvent[] = runRow?.events ?? [];

  const migratedOk =
    st.status === 'migrated' &&
    st.fromVersion === 1 &&
    st.toVersion === 2 &&
    !st.downgradeBlocked &&
    backupMemExists &&
    backupThrExists &&
    st.warnings.some((w) => w.includes('重名记忆'));

  const crashDetected =
    initialSnap.recovery?.runId === 'run-v1-crash' &&
    initialSnap.recovery.phase === 'interrupted' &&
    initialSnap.recovery.requiresReconciliation === true;

  const cityEntry = initialMem.find((m) => m.key === '城市');
  const memoryOk =
    initialMem.length === 2 &&
    cityEntry?.value === '上海' &&
    cityEntry?.kind === 'fact' &&
    dupRejected &&
    added.pinned === true &&
    updatedMem.length === 3 &&
    updatedMem[0]?.id === added.id &&
    budgetView.usedChars > 0 &&
    budgetView.includedCount === 3;

  const sessionAndHistoryOk =
    initialSessions.sessions.some((s) => s.title === '默认对话' && s.messageCount === 2) &&
    afterCreate.sessions.length === 2 &&
    doneSnap.phase === 'completed' &&
    doneSnap.text === 'C3_PERSIST_OK' &&
    Boolean(activeSession && activeSession.title.includes('[C3_PERSIST_RUN]') && activeSession.messageCount === 2) &&
    Boolean(runRow && typeof runRow.createdAt === 'number' && runRow.createdAt > 0 && events.length >= 2);

  const ok = migratedOk && crashDetected && memoryOk && sessionAndHistoryOk;
  if (ok) {
    await fs.writeFile(STAGE_FILE, '2', 'utf8');
  }
  return {
    stage: 1,
    ok,
    details: {
      migratedOk,
      crashDetected,
      memoryOk,
      sessionAndHistoryOk,
      storageStatus: st,
      backupMemExists,
      backupThrExists,
      initialRecoveryRunId: initialSnap.recovery?.runId ?? null,
      dupRejected,
      budgetUsedChars: budgetView.usedChars,
      activeSessionTitle: activeSession?.title ?? null,
      runPhase: doneSnap.phase,
      runText: doneSnap.text,
      persistedEventCount: events.length,
    },
  };
}

async function runStage2(): Promise<Record<string, unknown>> {
  const st = await agentClient.storageStatus();
  const snapBefore = await agentClient.snapshot();
  const sessions = await agentClient.sessions();
  const thread = await agentClient.thread();
  const mem = await agentClient.getMemory();
  const historyBefore = await agentClient.history();
  const backups = await fs.ls(`${DOC_DIR}/agent-backups`);

  const idempotentOk = st.status === 'up_to_date' && backups.length === 1;
  // Critical C3 check: unacknowledged crash from Stage 1 MUST still surface on second cold restart!
  const crashSurvivedSecondRestart =
    snapBefore.recovery?.runId === 'run-v1-crash' &&
    snapBefore.recovery.requiresReconciliation === true;
  const runC3History = historyBefore.find((h) => h.goal === '[C3_PERSIST_RUN]') ?? null;
  const dataSurvivedRestart =
    sessions.sessions.length === 2 &&
    thread.some((m) => m.text.includes('C3_PERSIST_OK')) &&
    mem.length === 3 &&
    mem[0]?.key === '代码风格' &&
    mem[0]?.pinned === true &&
    Boolean(runC3History && (runC3History.events?.length ?? 0) >= 2);

  // Now explicitly acknowledge reconciliation.
  const snapAfterAck = await agentClient.acknowledgeRun('run-v1-crash');
  const historyAfter = await agentClient.history();
  const ackedRow = historyAfter.find((h) => h.runId === 'run-v1-crash') ?? null;
  const ackOk =
    snapAfterAck.recovery === null &&
    ackedRow?.requiresReconciliation === false &&
    typeof ackedRow?.reconciledAt === 'number' &&
    ackedRow.reconciledAt > 0;

  const ok = idempotentOk && crashSurvivedSecondRestart && dataSurvivedRestart && ackOk;
  if (ok) {
    await fs.writeFile(STAGE_FILE, '3', 'utf8');
  }
  return {
    stage: 2,
    ok,
    details: {
      idempotentOk,
      backupCount: backups.length,
      crashSurvivedSecondRestart,
      dataSurvivedRestart,
      ackOk,
      recoveryBeforeAck: snapBefore.recovery?.runId ?? null,
      recoveryAfterAck: snapAfterAck.recovery,
      reconciledAt: ackedRow?.reconciledAt ?? null,
    },
  };
}

async function runStage3(): Promise<Record<string, unknown>> {
  const snap = await agentClient.snapshot();
  const recoveryClearedOnRestart = snap.recovery === null;

  // Capture verbatim file contents before injecting a higher future schemaVersion.
  const memRaw = await fs.readFile(`${DOC_DIR}/agent-memory.json`, 'utf8');
  const threadRaw = await fs.readFile(`${DOC_DIR}/agent-thread.json`, 'utf8');
  await fs.writeFile(SNAPSHOT_FILE, JSON.stringify({ memRaw, threadRaw }), 'utf8');

  // Inject v99 future manifest so the next cold restart simulates an app downgrade.
  await fs.writeFile(
    `${DOC_DIR}/storage-manifest.json`,
    JSON.stringify({ schemaVersion: 99, migratedAt: 9_999_999 }),
    'utf8',
  );
  await fs.writeFile(STAGE_FILE, '4', 'utf8');

  return {
    stage: 3,
    ok: recoveryClearedOnRestart,
    details: {
      recoveryClearedOnRestart,
      memBytes: memRaw.length,
      threadBytes: threadRaw.length,
    },
  };
}

async function runStage4(): Promise<Record<string, unknown>> {
  const st = await agentClient.storageStatus();
  const notice = formatStorageNotice(st);

  const expectBlockedCode = async (op: () => Promise<unknown>): Promise<string | null> => {
    try {
      await op();
      return null;
    } catch (e) {
      return extractAgentError(e).code;
    }
  };

  const startCode = await expectBlockedCode(() => agentClient.startCloud('[C3_SHOULD_BLOCK]'));
  const sessionCode = await expectBlockedCode(() => agentClient.createSession('blocked'));
  const memoryCode = await expectBlockedCode(() =>
    agentClient.saveMemoryEntry(null, 'blocked', 'val', 'fact', false, true),
  );
  const recoveryPlan = classifyAgentFailure({
    raw: startCode ?? '',
    code: startCode,
    source: 'action',
  });

  // Confirm zero disk mutation occurred during downgrade lock.
  const snapRaw = JSON.parse(await fs.readFile(SNAPSHOT_FILE, 'utf8')) as {
    memRaw: string;
    threadRaw: string;
  };
  const memAfter = await fs.readFile(`${DOC_DIR}/agent-memory.json`, 'utf8');
  const threadAfter = await fs.readFile(`${DOC_DIR}/agent-thread.json`, 'utf8');
  const filesUntouched = memAfter === snapRaw.memRaw && threadAfter === snapRaw.threadRaw;

  const downgradeOk =
    st.downgradeBlocked === true &&
    st.status === 'downgrade_blocked' &&
    st.fromVersion === 99 &&
    notice?.tone === 'danger' &&
    startCode === 'STORAGE_DOWNGRADE_BLOCKED' &&
    sessionCode === 'STORAGE_DOWNGRADE_BLOCKED' &&
    memoryCode === 'STORAGE_DOWNGRADE_BLOCKED' &&
    recoveryPlan.tone === 'danger' &&
    filesUntouched;

  return {
    stage: 4,
    ok: downgradeOk,
    details: {
      status: st.status,
      downgradeBlocked: st.downgradeBlocked,
      fromVersion: st.fromVersion,
      noticeTone: notice?.tone ?? null,
      startCode,
      sessionCode,
      memoryCode,
      recoveryTitle: recoveryPlan.title,
      filesUntouched,
    },
  };
}

function C3PersistenceAcceptanceApp() {
  const [status, setStatus] = useState('initializing');
  const [summaryText, setSummaryText] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let stage = 1;
      let report: Record<string, unknown>;
      try {
        if (await fs.exists(STAGE_FILE)) {
          const raw = (await fs.readFile(STAGE_FILE, 'utf8')).trim();
          const parsed = Number(raw);
          if (parsed >= 1 && parsed <= 4) stage = parsed;
        }
        if (!cancelled) setStatus(`running stage ${stage}/4`);
        if (stage === 1) report = await runStage1();
        else if (stage === 2) report = await runStage2();
        else if (stage === 3) report = await runStage3();
        else report = await runStage4();
      } catch (e) {
        report = { stage, ok: false, error: String((e as Error)?.stack ?? e) };
      }
      await postReport(report);
      if (!cancelled) {
        setStatus(`stage ${stage}/4 ok=${String(report.ok)}`);
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
        Rurea C3 Persistence Acceptance
      </Text>
      <Text style={{ color: '#fff', marginTop: 10, fontSize: 14 }}>{status}</Text>
      <ScrollView style={{ marginTop: 12, flex: 1 }}>
        <Text style={{ color: '#cbd5e1', fontSize: 11 }}>{summaryText}</Text>
      </ScrollView>
    </View>
  );
}

AppRegistry.registerComponent('DshPocket', () => C3PersistenceAcceptanceApp);
