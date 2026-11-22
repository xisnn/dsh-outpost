/**
 * Rurea C3 记忆与持久化深度回归测试（归入 test:agentChain）：
 *
 * 覆盖：
 *   1. 纯逻辑（src/core/agentPersistence.ts）：
 *      - 记忆分类归一化/置顶与更新时间排序/分类与关键词筛选；
 *      - 2400 字提示词注入预算计算（included / truncated / disabled + 零启用零注入）；
 *      - 对话气泡显式「存为记忆」草稿生成器（只生成草稿，绝不静默保存）；
 *      - 任务历史阶段徽标、短时间格式化、待核对/异常筛选、存储降级阻断与损坏隔离告警；
 *   2. 故障恢复规划（src/core/agentRecovery.ts）：STORAGE_DOWNGRADE_BLOCKED / RUN_ACTIVE；
 *   3. 跨层接线与边界检查：
 *      - StorageMigrator / FileRunStore / RunRecovery / AgentMemoryStore / AgentThreadStore /
 *        AgentRuntime / AgentModule / agent.ts / AgentMemoryScreen / AgentHistoryScreen /
 *        AgentButlerScreen / RureaApp / App（全链路闭合且 Agent* 页面保持 useApp()-free）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSource } from './support/component-harness.mjs';

const persistence = loadSource('core/agentPersistence.ts');
const recovery = loadSource('core/agentRecovery.ts');

const {
  MEMORY_PROMPT_BUDGET_DEFAULT,
  MEMORY_KINDS,
  MEMORY_KIND_LABELS,
  buildMemoryDraftFromMessage,
  computeMemoryBudgetView,
  filterHistoryItems,
  filterMemoryEntries,
  formatHistoryPhase,
  formatShortTime,
  formatStorageNotice,
  normalizeMemoryEntry,
  sortMemoryEntries,
  truncateSessionTitle,
} = persistence;

test('agentPersistence sorts by pinned then updatedAt and filters by kind and query', () => {
  assert.deepEqual(Array.from(MEMORY_KINDS), ['preference', 'project', 'fact']);
  assert.equal(MEMORY_KIND_LABELS.preference, '偏好');
  assert.equal(MEMORY_KIND_LABELS.project, '项目');
  assert.equal(MEMORY_KIND_LABELS.fact, '事实');

  const v1 = normalizeMemoryEntry({
    id: 'm1',
    key: '语言',
    value: '用中文',
    createdAt: 100,
    updatedAt: 200,
  });
  assert.equal(v1.kind, 'fact');
  assert.equal(v1.pinned, false);
  assert.equal(v1.enabled, true);
  assert.equal(v1.revision, 1);

  const entries = [
    { id: 'a', key: '旧事实', value: 'x', kind: 'fact', pinned: false, enabled: true, createdAt: 10, updatedAt: 500 },
    { id: 'b', key: '工作流偏好', value: '简洁回复', kind: 'preference', pinned: true, enabled: true, createdAt: 10, updatedAt: 100 },
    { id: 'c', key: 'Rurea 项目', value: 'dsBot-p1-polish 分支', kind: 'project', pinned: false, enabled: true, createdAt: 10, updatedAt: 900 },
  ];

  const sorted = sortMemoryEntries(entries);
  assert.deepEqual(
    sorted.map((e) => e.id),
    ['b', 'c', 'a'],
  );

  const prefOnly = filterMemoryEntries(entries, { kind: 'preference' });
  assert.deepEqual(prefOnly.map((e) => e.id), ['b']);

  const searched = filterMemoryEntries(entries, { kind: 'all', query: 'p1-polish' });
  assert.deepEqual(searched.map((e) => e.id), ['c']);
});

test('computeMemoryBudgetView tracks included, truncated, and disabled entries under 2400-char cap', () => {
  assert.equal(MEMORY_PROMPT_BUDGET_DEFAULT, 2400);

  const disabledOnly = computeMemoryBudgetView([
    { id: 'd1', key: '停用', value: '不应注入', enabled: false, createdAt: 1, updatedAt: 1 },
  ]);
  assert.equal(disabledOnly.usedChars, 0);
  assert.equal(disabledOnly.includedCount, 0);
  assert.equal(disabledOnly.disabledCount, 1);
  assert.equal(disabledOnly.statusOf('d1'), 'disabled');

  const big = 'A'.repeat(390);
  const entries = Array.from({ length: 8 }, (_, idx) => ({
    id: `m-${idx}`,
    key: `条目的名字${idx}`,
    value: big,
    kind: 'fact',
    pinned: idx === 7,
    enabled: idx !== 6,
    createdAt: 10,
    updatedAt: 100 + idx,
  }));

  const fallbackView = computeMemoryBudgetView(entries);
  assert.equal(fallbackView.statusOf('m-6'), 'disabled');
  // m-7 is pinned so it MUST be included first even with smaller/comparable timestamp
  assert.equal(fallbackView.statusOf('m-7'), 'included');
  assert.equal(fallbackView.overBudget, true);
  assert.ok(fallbackView.truncatedCount >= 1);
  assert.match(fallbackView.summaryText, /超额未注入/);

  // Explicit native budget overrides fallback counts faithfully
  const nativeView = computeMemoryBudgetView(entries, {
    maxChars: 2400,
    usedChars: 2100,
    totalEntries: 8,
    enabledEntries: 7,
    includedIds: ['m-7', 'm-5'],
    truncatedIds: ['m-4'],
    disabledIds: ['m-6'],
  });
  assert.equal(nativeView.usedChars, 2100);
  assert.equal(nativeView.statusOf('m-7'), 'included');
  assert.equal(nativeView.statusOf('m-4'), 'truncated');
  assert.equal(nativeView.statusOf('m-6'), 'disabled');
});

test('buildMemoryDraftFromMessage generates explicit editable draft without persistence side effects', () => {
  const userDraft = buildMemoryDraftFromMessage({
    role: 'user',
    text: '以后帮我整理笔记时统一使用要点列表\n不要超过三段',
  });
  assert.equal(userDraft.kind, 'preference');
  assert.equal(userDraft.key, '以后帮我整理笔记时统一使用要点列表');
  assert.match(userDraft.value, /不要超过三段/);

  const assistantDraft = buildMemoryDraftFromMessage({
    role: 'assistant',
    text: '- 已确认目标设备代号：V1981A',
  });
  assert.equal(assistantDraft.kind, 'fact');
  assert.equal(assistantDraft.key, '已确认目标设备代号：V1981A');
});

test('history formatters, filters, session titles, and storage notices cover normal, downgrade, and quarantine states', () => {
  const completed = formatHistoryPhase('completed');
  assert.equal(completed.label, '已完成');
  assert.equal(completed.tone, 'success');
  const interrupted = formatHistoryPhase('interrupted');
  assert.equal(interrupted.label, '已中断');
  assert.equal(interrupted.tone, 'warning');
  const failed = formatHistoryPhase('failed');
  assert.equal(failed.label, '失败');
  assert.equal(failed.tone, 'danger');

  assert.equal(formatShortTime(null), '');
  assert.match(formatShortTime(1_700_000_000_000), /^\d{2}-\d{2} \d{2}:\d{2}$/);

  const history = [
    { runId: 'r1', phase: 'completed', requiresReconciliation: false },
    { runId: 'r2', phase: 'interrupted', requiresReconciliation: true },
    { runId: 'r3', phase: 'failed', requiresReconciliation: false },
  ];
  assert.equal(filterHistoryItems(history, 'all').length, 3);
  assert.deepEqual(filterHistoryItems(history, 'reconciliation').map((r) => r.runId), ['r2']);
  assert.deepEqual(filterHistoryItems(history, 'issues').map((r) => r.runId), ['r2', 'r3']);

  assert.equal(truncateSessionTitle('', 16), '默认对话');
  assert.equal(truncateSessionTitle('12345678901234567', 16), '123456789012345…');

  assert.equal(
    formatStorageNotice({
      schemaVersion: 2,
      fromVersion: 2,
      toVersion: 2,
      status: 'up_to_date',
      downgradeBlocked: false,
      quarantinedFiles: [],
      warnings: [],
    }),
    null,
  );

  const downgrade = formatStorageNotice({
    schemaVersion: 2,
    fromVersion: 9,
    toVersion: 2,
    status: 'downgrade_blocked',
    downgradeBlocked: true,
    quarantinedFiles: [],
    warnings: [],
    error: 'STORAGE_DOWNGRADE_BLOCKED',
  });
  assert.equal(downgrade?.tone, 'danger');
  assert.match(downgrade?.title ?? '', /只读保护/);

  const quarantined = formatStorageNotice({
    schemaVersion: 2,
    fromVersion: 1,
    toVersion: 2,
    status: 'migrated',
    downgradeBlocked: false,
    quarantinedFiles: ['agent-memory.json.corrupt.123'],
    warnings: ['记忆迁移提醒'],
  });
  assert.equal(quarantined?.tone, 'warning');
  assert.match(quarantined?.body ?? '', /agent-memory\.json\.corrupt\.123/);
});

test('agentRecovery classifies STORAGE_DOWNGRADE_BLOCKED and RUN_ACTIVE cleanly', () => {
  const blocked = recovery.classifyAgentFailure({
    raw: 'STORAGE_DOWNGRADE_BLOCKED',
    code: 'STORAGE_DOWNGRADE_BLOCKED',
    source: 'action',
  });
  assert.equal(blocked.category, 'runtime');
  assert.equal(blocked.tone, 'danger');
  assert.match(blocked.title, /版本高于/);

  const activeErr = recovery.classifyAgentFailure({
    raw: 'RUN_ACTIVE',
    code: 'RUN_ACTIVE',
    source: 'action',
  });
  assert.equal(activeErr.category, 'runtime');
  assert.equal(activeErr.tone, 'warning');
  assert.match(activeErr.title, /仍在执行中/);
});

test('C3 wiring spans StorageMigrator, RunStore/RunRecovery, native stores/runtime/module, JS client, screens, and Rurea/App routes', () => {
  const migrator = fs.readFileSync(
    new URL('../android/agent-core/src/main/kotlin/com/dshpocket/agent/core/StorageMigrator.kt', import.meta.url),
    'utf8',
  );
  assert.match(migrator, /CURRENT_SCHEMA_VERSION = 2/);
  assert.match(migrator, /MigrationStatus\.DOWNGRADE_BLOCKED/);
  assert.match(migrator, /output\.fd\.sync\(\)/);
  assert.match(migrator, /fun quarantineCorruptFile\(/);
  assert.match(migrator, /STORAGE_DOWNGRADE_BLOCKED/);

  const runStore = fs.readFileSync(
    new URL('../android/agent-core/src/main/kotlin/com/dshpocket/agent/core/RunStore.kt', import.meta.url),
    'utf8',
  );
  assert.match(runStore, /fun recordEvent\(/);
  assert.match(runStore, /fun acknowledgeReconciliation\(/);
  assert.match(runStore, /eventsJson/);
  assert.match(runStore, /reconciledAt/);
  assert.match(runStore, /sanitizeRunEventDetail\(/);

  const runRecovery = fs.readFileSync(
    new URL('../android/agent-core/src/main/kotlin/com/dshpocket/agent/core/RunRecovery.kt', import.meta.url),
    'utf8',
  );
  assert.match(runRecovery, /fun pendingReconciliation\(/);

  const memStore = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentMemoryStore.kt', import.meta.url),
    'utf8',
  );
  assert.match(memStore, /StorageMigrator\.atomicWriteBytes\(/);
  assert.match(memStore, /StorageMigrator\.quarantineCorruptFile\(/);
  assert.match(memStore, /fun promptBudget\(/);
  assert.match(memStore, /else if \(rowKey == cleanKey\)/);

  const threadStore = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentThreadStore.kt', import.meta.url),
    'utf8',
  );
  assert.match(threadStore, /StorageMigrator\.atomicWriteBytes\(/);
  assert.match(threadStore, /SESSION_LIMIT_REACHED/);
  assert.match(threadStore, /fun switchSession\(/);

  const runtime = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentRuntime.kt', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /StorageMigrator\.migrateIfNeeded\(/);
  assert.match(runtime, /RunRecovery\.pendingReconciliation\(runs\)/);
  assert.match(runtime, /runs\.acknowledgeReconciliation\(/);
  assert.match(runtime, /runs\.recordEvent\(/);
  assert.match(runtime, /STORAGE_DOWNGRADE_BLOCKED/);
  assert.match(runtime, /RUN_ACTIVE/);

  const mod = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentModule.kt', import.meta.url),
    'utf8',
  );
  for (const method of ['storageStatus', 'sessions', 'createSession', 'switchSession', 'renameSession', 'deleteSession', 'getMemoryBudget', 'saveMemoryEntry', 'acknowledgeRun']) {
    assert.match(mod, new RegExp(`fun ${method}\\(`), `AgentModule missing ${method}`);
  }

  const agentTs = fs.readFileSync(new URL('../src/core/agent.ts', import.meta.url), 'utf8');
  for (const method of ['storageStatus:', 'sessions:', 'createSession:', 'switchSession:', 'renameSession:', 'deleteSession:', 'getMemoryBudget:', 'saveMemoryEntry:', 'acknowledgeRun:']) {
    assert.match(agentTs, new RegExp(method), `agentClient missing ${method}`);
  }

  const memScreen = fs.readFileSync(new URL('../src/screens/AgentMemoryScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(memScreen, /useApp\(/);
  assert.match(memScreen, /agentClient\.getMemoryBudget\(/);
  assert.match(memScreen, /agentClient\.saveMemoryEntry\(/);

  const histScreen = fs.readFileSync(new URL('../src/screens/AgentHistoryScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(histScreen, /useApp\(/);
  assert.match(histScreen, /agentClient\.history\(/);
  assert.match(histScreen, /agentClient\.acknowledgeRun\(/);

  const butler = fs.readFileSync(new URL('../src/screens/AgentButlerScreen.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(butler, /useApp\(/);
  assert.match(butler, /nav\.push\('AgentHistory'\)/);
  assert.match(butler, /agentClient\.sessions\(/);
  assert.match(butler, /buildMemoryDraftFromMessage\(/);
  assert.match(butler, /存为记忆/);

  const rureaApp = fs.readFileSync(new URL('../src/rurea/RureaApp.tsx', import.meta.url), 'utf8');
  assert.match(rureaApp, /case 'AgentHistory':/);
  const dshApp = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(dshApp, /case 'AgentHistory':/);
});
