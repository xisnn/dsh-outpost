/**
 * 本机管家主界面（P3）。
 *
 * 只在本机执行位置下替换管家聊天面板，电脑聊天、工作区与配对完全不动。
 * 数据来源严格分开：
 *   - 任务/审批/队列：本机 outpost-butler 的 reconcile（唯一权威）；
 *   - 任务详情：本机 host 的受限 `task` 投影（标题、目标、最近输出、交付物元数据）；
 *   - 草稿与审批审计：本机自己的 AsyncStorage key，不碰电脑会话草稿。
 *
 * 这里不维护任务状态机，也不自动重试命令。结果未知时只核对回执。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';

import { ChatComposer } from '../components/ChatComposer';
import { Header } from '../components/Header';
import { LocalApprovalCard } from '../components/LocalApprovalCard';
import { LocalRuntimePanel } from '../components/LocalRuntimePanel';
import { TaskDetailSheet } from '../components/TaskDetailSheet';
import { TaskPressable, TaskSection, TaskStatus, taskEnter, taskExit, taskLayout } from '../components/TaskMotion';
import { useLocalRuntime } from '../components/useLocalRuntime';
import { useTheme } from '../design/theme';
import {
  ButlerClientError,
  ButlerReceiptUnknown,
  LocalButlerClient,
  newButlerCommandId,
  type ButlerTaskView,
  type LocalApprovalEntry,
  type LocalReconcile,
} from '../core/butlerClient';
import { MAX_DRAFT_CHARS } from '../core/draftStore';
import {
  loadLocalAudit,
  recordLocalAudit,
  type LocalApprovalAuditEntry,
  type LocalApprovalDecision,
} from '../core/localAudit';
import { loadLocalButlerDraft, saveLocalButlerDraft } from '../core/localButlerDraft';
import type { ButlerTaskStatus } from '../core/butlerTasks';

const STATUS_TEXT: Record<ButlerTaskStatus, string> = {
  created: '排队中',
  preparing: '准备中',
  running: '执行中',
  waiting_user: '等待你',
  blocked: '已阻塞',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const ACTIVE_STATUSES: ButlerTaskStatus[] = ['created', 'preparing', 'running', 'waiting_user', 'blocked'];
const RUNNING_STATUSES: ButlerTaskStatus[] = ['preparing', 'running'];

function messageOf(error: unknown): string {
  if (error instanceof ButlerClientError) {
    switch (error.code) {
      case 'busy-use-enqueue': return '已有任务在执行或排队，这条需要排队。';
      case 'revision-conflict': return '任务状态刚发生变化，请刷新后再试。';
      case 'stale-approval': return '这条审批已失效（可能已处理、超时或中断）。';
      case 'reconciliation-required': return '该任务有未核对的结果，不能直接继续；请核对后再新建任务。';
      case 'workspace-conflict': return '任务工作区与本机运行环境不一致，不能恢复。';
      case 'task-not-found': return '任务不存在或已被移除。';
      case 'RUNTIME_NOT_RUNNING': return '本机运行环境没有启动。';
      case 'RUNTIME_STARTING': return '本机运行环境正在启动，请稍候。';
      case 'STALE_RUNTIME': return '本机运行代次已变化，请刷新后重试。';
      case 'BRIDGE_BUSY': return '本机通道正忙，请稍后重试。';
      case 'LOCAL_RUNTIME_UNSUPPORTED': return '当前设备不支持在本机运行。';
      case 'command-rejected': return '本机管家拒绝了这条命令。';
      default: return `本机管家暂时无法完成这个操作（${error.code}）。`;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function statusHint(task: ButlerTaskView): string {
  switch (task.status) {
    case 'created': return '已排队，前面的任务结束后开始执行。';
    case 'preparing': return '正在准备本机执行环境…';
    case 'running': return '正在本机执行…完成后这里会显示最近输出。';
    case 'waiting_user': return task.local?.recoveryRequired
      ? '执行被停止或结果未核对，需要新建任务继续。'
      : '等待你处理审批或选择继续。';
    case 'blocked': return '任务已阻塞，请查看状态说明。';
    case 'completed': return '任务已完成。';
    case 'failed': return '任务失败，详情里保留了状态说明。';
    case 'cancelled': return '任务已取消。';
    default: return '';
  }
}

function upsertTask(rows: ButlerTaskView[], next: ButlerTaskView): ButlerTaskView[] {
  const index = rows.findIndex(row => row.id === next.id);
  if (index < 0) return [...rows, next];
  const copy = [...rows];
  copy[index] = next.revision >= rows[index].revision ? next : rows[index];
  return copy;
}

function TaskTurn({
  task,
  color,
  styles,
  onOpen,
  onResume,
  onStop,
  busy,
}: {
  task: ButlerTaskView;
  color: string;
  styles: ReturnType<typeof makeStyles>;
  onOpen: (task: ButlerTaskView) => void;
  onResume: (task: ButlerTaskView) => void;
  onStop: (task: ButlerTaskView) => void;
  busy: boolean;
}) {
  const resumable = (task.status === 'waiting_user' || task.status === 'blocked')
    && !task.local?.recoveryRequired;
  return (
    <View style={styles.turn}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{task.objective || task.title}</Text>
      </View>
      <View style={styles.assistantCard}>
        <View style={styles.taskHead}>
          <TaskStatus label={STATUS_TEXT[task.status]} color={color} style={styles.statusPill} textStyle={styles.statusText} />
          <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
        </View>
        {task.lastAssistantText ? (
          <Text style={styles.assistantText} selectable>{task.lastAssistantText}</Text>
        ) : (
          <Text style={styles.assistantHint}>{statusHint(task)}</Text>
        )}
        {task.local?.recoveryRequired ? (
          <Text style={styles.warnText}>结果未核对：不能直接继续，请核对文件或新建任务。</Text>
        ) : null}
        {task.local?.pendingApprovalCount ? (
          <Text style={styles.warnText}>有 {task.local.pendingApprovalCount} 条审批待处理，见下方卡片。</Text>
        ) : null}
        {task.deliverables.length > 0 ? (
          <View style={styles.deliverables}>
            {task.deliverables.slice(0, 6).map(file => (
              <Text key={file.path} style={styles.deliverableText} numberOfLines={2}>
                {file.relativePath ?? file.path}{file.size !== undefined ? ` · ${file.size} 字节` : ''}
              </Text>
            ))}
            <Text style={styles.deliverableNote}>本机交付物暂不支持在手机上直接打开。</Text>
          </View>
        ) : null}
        <View style={styles.turnActions}>
          <TaskPressable onPress={() => onOpen(task)} style={styles.turnBtn} accessibilityRole="button" accessibilityLabel={`查看任务详情 ${task.title}`}>
            <Text style={styles.turnBtnText}>详情</Text>
          </TaskPressable>
          {resumable ? (
            <TaskPressable onPress={() => onResume(task)} disabled={busy} style={styles.turnBtn} accessibilityRole="button" accessibilityLabel="继续本机任务">
              <Text style={styles.turnBtnText}>{busy ? '处理中…' : '继续'}</Text>
            </TaskPressable>
          ) : null}
          {task.status === 'running' || task.status === 'preparing' ? (
            <TaskPressable onPress={() => onStop(task)} disabled={busy} style={styles.turnBtn} accessibilityRole="button" accessibilityLabel="停止本机任务">
              <Text style={styles.turnDangerText}>停止</Text>
            </TaskPressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function LocalButlerScreen({ active = true }: { active?: boolean }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const runtime = useLocalRuntime(active);
  const butler = useMemo(() => new LocalButlerClient(runtime.client), [runtime.client]);

  const [tasks, setTasks] = useState<ButlerTaskView[]>([]);
  const [reconcile, setReconcile] = useState<LocalReconcile | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ButlerTaskView | null>(null);
  const [detailActive, setDetailActive] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<{ id: string; message: string } | null>(null);
  const [lockedApprovals, setLockedApprovals] = useState<ReadonlySet<string>>(new Set());
  const [audit, setAudit] = useState<LocalApprovalAuditEntry[]>([]);
  const [unknown, setUnknown] = useState<{ commandId: string; fingerprint: string; objective: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const mounted = useRef(true);
  const commandRef = useRef<{ fingerprint: string; commandId: string; operation: 'create' | 'enqueue' } | null>(null);
  const detailsRequested = useRef(new Map<string, number>());
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    void loadLocalButlerDraft(AsyncStorage).then(saved => { if (alive && saved) setDraft(saved.text); });
    void loadLocalAudit(AsyncStorage).then(rows => { if (alive) setAudit(rows); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => { void saveLocalButlerDraft(AsyncStorage, draft); }, 300);
    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [draft]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const runningPhase = runtime.snapshot?.phase === 'running';
  useEffect(() => {
    if (runningPhase) return;
    setTasks([]);
    setReconcile(null);
    setSelected(null);
    setDetailActive(false);
  }, [runningPhase]);

  const refreshNow = useCallback(async () => {
    const next = await butler.reconcile();
    if (!mounted.current) return;
    setReconcile(next);
    setTasks(butler.project(next));
    setError(null);
  }, [butler]);

  const loadDetails = useCallback(async (views: ButlerTaskView[], stopped: () => boolean) => {
    const pending = views.filter(view => detailsRequested.current.get(view.id) !== view.revision).slice(0, 4);
    for (const view of pending) {
      detailsRequested.current.set(view.id, view.revision);
      try {
        const detail = await butler.detail(view.id);
        if (stopped() || !mounted.current) return;
        setTasks(rows => rows.map(row => row.id === detail.id ? { ...detail, local: row.local ?? detail.local } : row));
      } catch {
        // Keep the status row visible and retry next cycle. Creation is never
        // inferred from a failed detail read.
        detailsRequested.current.delete(view.id);
      }
    }
  }, [butler]);

  useEffect(() => {
    if (!active || !runningPhase) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await butler.reconcile();
        // Reconcile omits terminal tasks; history keeps completed results visible.
        let history: ButlerTaskView[] | null = null;
        try { history = await butler.history(); } catch { history = null; }
        if (stopped || !mounted.current) return;
        setReconcile(next);
        const views = butler.project(next, history);
        setTasks(views);
        setError(null);
        void loadDetails(views, () => stopped);
      } catch (failure) {
        if (!stopped && mounted.current) setError(messageOf(failure));
      } finally {
        if (!stopped) timer = setTimeout(tick, 2500);
      }
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [active, butler, runningPhase, loadDetails]);

  const updateDraft = useCallback((text: string) => setDraft(text), []);

  const checkReceipt = useCallback(async (commandId: string) => {
    try {
      const receipt = await butler.receipt(commandId);
      if (!mounted.current) return;
      if (receipt?.state === 'completed') {
        setUnknown(null);
        commandRef.current = null;
        setDraft('');
        void saveLocalButlerDraft(AsyncStorage, '');
        setError(null);
        await refreshNow();
        return;
      }
      if (receipt?.state === 'rejected') {
        setUnknown(null);
        commandRef.current = null;
        setError(messageOf(new ButlerClientError(receipt.code ?? 'command-rejected')));
        await refreshNow();
        return;
      }
      setUnknown(current => current ? { ...current, commandId } : current);
      setError('回执仍未确认：命令可能已执行，不会自动重发。请稍后再核对。');
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [butler, refreshNow]);

  const send = useCallback(async () => {
    const objective = draft.trim();
    if (!objective || sending) return;
    // Only the exact same objective is forbidden after an unknown outcome:
    // a different goal is a new business command, not a retransmission.
    if (unknown && objective === unknown.objective) {
      setError('这条目标的上一次命令结果未知，不能重发；请先核对回执，或修改目标后再发。');
      return;
    }
    const operation: 'create' | 'enqueue' =
      tasks.some(task => RUNNING_STATUSES.includes(task.status) || task.status === 'created')
        ? 'enqueue' : 'create';
    const fingerprint = `${operation}\n${objective}`;
    const commandId = commandRef.current?.fingerprint === fingerprint
      ? commandRef.current.commandId
      : newButlerCommandId(operation);
    commandRef.current = { fingerprint, commandId, operation };
    setSending(true);
    setError(null);
    let created = false;
    try {
      const task = operation === 'create'
        ? await butler.create({ objective }, commandId)
        : await butler.enqueue({ objective }, commandId);
      if (!mounted.current) return;
      commandRef.current = null;
      setDraft('');
      void saveLocalButlerDraft(AsyncStorage, '');
      setTasks(rows => upsertTask(rows, task));
      created = true;
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ButlerReceiptUnknown) {
        setUnknown({ commandId: failure.commandId, fingerprint, objective });
        setError('命令已送达但结果未知；已保留回执编号，正在核对，不会重发。');
        void checkReceipt(failure.commandId);
      } else {
        commandRef.current = null;
        setError(messageOf(failure));
        try { await refreshNow(); } catch { /* keep the first error */ }
      }
    } finally {
      if (mounted.current) setSending(false);
    }
    if (created && mounted.current) {
      // The command already succeeded. A failed refresh only costs an error
      // line; it must not be reported as "creation failed".
      try { await refreshNow(); } catch (failure) { if (mounted.current) setError(messageOf(failure)); }
    }
  }, [butler, checkReceipt, draft, refreshNow, sending, tasks, unknown]);

  const stopTask = useCallback((task: ButlerTaskView) => {
    Alert.alert(
      '停止本机任务？',
      '停止后该任务不会自动恢复；需要继续时请核对结果后新建任务。',
      [
        { text: '再想想', style: 'cancel' },
        {
          text: '停止',
          style: 'destructive',
          onPress: () => {
            setActionBusy(true);
            void butler.interrupt(task.id)
              .then(() => refreshNow())
              .catch(failure => setError(messageOf(failure)))
              .finally(() => { if (mounted.current) setActionBusy(false); });
          },
        },
      ],
    );
  }, [butler, refreshNow]);

  const resumeTask = useCallback((task: ButlerTaskView) => {
    setActionBusy(true);
    void butler.resume(task.id)
      .then(next => { setSelected(current => current?.id === next.id ? next : current); return refreshNow(); })
      .catch(failure => { setError(messageOf(failure)); return refreshNow().catch(() => undefined); })
      .finally(() => { if (mounted.current) setActionBusy(false); });
  }, [butler, refreshNow]);

  const cancelTask = useCallback((task: ButlerTaskView) => {
    Alert.alert('取消本机任务？', '已完成的步骤会保留在任务记录里。', [
      { text: '再想想', style: 'cancel' },
      {
        text: '取消任务',
        style: 'destructive',
        onPress: () => {
          setActionBusy(true);
          void butler.cancel(task.id)
            .then(() => refreshNow())
            .catch(failure => setError(messageOf(failure)))
            .finally(() => { if (mounted.current) setActionBusy(false); });
        },
      },
    ]);
  }, [butler, refreshNow]);

  const decide = useCallback(async (approval: LocalApprovalEntry, decision: LocalApprovalDecision) => {
    setApprovalBusy(approval.id);
    setApprovalError(null);
    let decided = false;
    try {
      const receipt = await butler.approve({ approvalId: approval.id, decision });
      if (receipt.state === 'completed') {
        const rows = await recordLocalAudit(AsyncStorage, {
          taskId: approval.taskId,
          toolName: approval.toolName,
          decision,
          at: Date.now(),
        });
        if (mounted.current) setAudit(rows);
        decided = true;
      }
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ButlerReceiptUnknown) {
        setLockedApprovals(current => new Set(current).add(approval.id));
        setApprovalError({ id: approval.id, message: '审批答复已送出但结果未知；已锁定，不会重复放行。' });
        void checkReceipt(failure.commandId);
      } else {
        setApprovalError({ id: approval.id, message: messageOf(failure) });
        try { await refreshNow(); } catch { /* keep the actionable error */ }
      }
    } finally {
      if (mounted.current) setApprovalBusy(null);
    }
    if (decided && mounted.current) {
      try { await refreshNow(); } catch (failure) { setError(messageOf(failure)); }
    }
  }, [butler, checkReceipt, refreshNow]);

  const openTask = useCallback((task: ButlerTaskView) => {
    setDetailActive(true);
    setSelected(task);
    void butler.detail(task.id)
      .then(detail => setSelected(current => current?.id === detail.id ? { ...detail, local: current.local ?? detail.local } : current))
      .catch(() => undefined);
  }, [butler]);

  const closeDetails = useCallback(() => setSelected(null), []);
  const afterDetailClose = useCallback(() => setDetailActive(false), []);

  const statusColor = useCallback((status: ButlerTaskStatus): string => {
    if (status === 'completed') return tv.colors.success;
    if (status === 'failed' || status === 'cancelled') return tv.colors.danger;
    if (status === 'waiting_user' || status === 'blocked') return tv.colors.warning;
    if (status === 'running' || status === 'preparing') return tv.colors.accent;
    return tv.colors.textTertiary;
  }, [tv.colors]);

  const feed = useMemo(() => [...tasks].reverse(), [tasks]);
  const approvals = reconcile?.approvals ?? [];
  const activeTask = tasks.find(task => RUNNING_STATUSES.includes(task.status)) ?? null;
  const queued = tasks.some(task => task.status === 'created');
  const unresolved = reconcile?.unresolved ?? [];
  const lastAudit = selected ? audit.find(entry => entry.taskId === selected.id) : undefined;

  return (
    <View style={styles.root}>
      <View style={{ flex: 1 }} importantForAccessibility={detailActive ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={detailActive}>
        <Header title="DSH" subtitle="本机管家" right={<Text style={styles.locationChip}>本机</Text>} />

        <LocalRuntimePanel view={runtime} onStart={() => void runtime.start()} onStop={() => void runtime.stop()} onRefresh={() => void runtime.refresh()} />

        {runningPhase ? (
          <>
            {error ? (
              <TaskPressable onPress={() => setError(null)} accessibilityRole="button" accessibilityLabel="关闭错误提示">
                <Text style={styles.errorText}>{error}</Text>
              </TaskPressable>
            ) : null}
            {unresolved.length > 0 ? (
              <Text style={styles.unknownText}>
                有 {unresolved.length} 条历史命令结果未确认；相关任务不能直接继续，核对后再新建任务。
              </Text>
            ) : null}
            <FlatList
              inverted
              data={feed}
              keyExtractor={task => task.id}
              renderItem={({ item }) => (
                <TaskTurn
                  task={item}
                  color={statusColor(item.status)}
                  styles={styles}
                  onOpen={openTask}
                  onResume={resumeTask}
                  onStop={stopTask}
                  busy={actionBusy}
                />
              )}
              contentContainerStyle={styles.feedContent}
              ListEmptyComponent={(
                <View style={styles.emptyFlip}>
                  <View style={styles.empty}>
                    <Text style={styles.emptyTitle}>还没有本机任务</Text>
                    <Text style={styles.emptyHint}>写下目标后，任务会在手机上执行；审批会出现在这里。</Text>
                  </View>
                </View>
              )}
              keyboardShouldPersistTaps="handled"
            />

            {approvals.map(approval => (
              <LocalApprovalCard
                key={approval.id}
                approval={approval}
                busy={approvalBusy === approval.id}
                locked={lockedApprovals.has(approval.id)}
                error={approvalError?.id === approval.id ? approvalError.message : undefined}
                now={now}
                onDecide={decision => void decide(approval, decision)}
              />
            ))}

            {unknown ? (
              <View style={styles.unknownBar}>
                <Text style={styles.unknownText}>上一条命令结果未知，未重发。</Text>
                <TaskPressable
                  onPress={() => void checkReceipt(unknown.commandId)}
                  accessibilityRole="button"
                  accessibilityLabel="核对命令回执"
                  style={styles.unknownBtn}
                >
                  <Text style={styles.unknownBtnText}>核对回执</Text>
                </TaskPressable>
              </View>
            ) : null}

            <View style={styles.composerWrap}>
              <ChatComposer
                value={draft}
                attachments={[]}
                sending={sending}
                uploading={false}
                running={Boolean(activeTask)}
                queueOnly
                attachmentsEnabled={false}
                placeholder={queued || activeTask ? '再交代一个目标，结束后执行…' : '交代一个本机目标…'}
                maxLength={MAX_DRAFT_CHARS}
                onChangeText={updateDraft}
                onAddAttachment={() => setError('本机管家暂不支持附件；请先把文件放进本机工作区。')}
                onRemoveAttachment={() => undefined}
                onSend={() => void send()}
                onStop={activeTask ? () => stopTask(activeTask) : () => undefined}
              />
              <Text style={styles.composerHint}>
                {activeTask ? '当前任务执行中；新目标会排队，不会插话或抢占。' : queued ? '已有排队任务；新目标会排在它们后面。' : '本机执行位置：只影响管家任务，不影响电脑聊天。'}
              </Text>
            </View>
          </>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>启动本机运行环境后查看任务</Text>
            <Text style={styles.emptyHint}>任务历史保存在本机管家；启动后可继续核对或新建任务。</Text>
          </View>
        )}
      </View>

      <TaskDetailSheet visible={detailActive && selected !== null} onClose={closeDetails} onAfterClose={afterDetailClose}>
        {selected ? (
          <>
            <Text style={styles.detailTitle}>{selected.title}</Text>
            <Text style={styles.detailObjective}>{selected.objective}</Text>
            <View style={styles.detailMetaRow}>
              <TaskStatus label={STATUS_TEXT[selected.status]} color={statusColor(selected.status)} textStyle={styles.detailStatus} />
              <Text style={styles.detailMeta}>revision {selected.revision}</Text>
              {selected.local?.queueOrder !== null && selected.local?.queueOrder !== undefined ? (
                <Text style={styles.detailMeta}>队列 #{selected.local.queueOrder}</Text>
              ) : null}
              {selected.local ? (
                <Text style={styles.detailMeta}>{selected.local.authorized ? '当前代次已授权' : '未授权'}</Text>
              ) : null}
            </View>

            {selected.lastError ? (
              <TaskSection key="explanation" layout={taskLayout} entering={taskEnter} exiting={taskExit}>
                <Text style={styles.detailLabel}>状态说明</Text>
                <Text style={[styles.detailValue, { color: tv.colors.warning }]}>{selected.lastError}</Text>
              </TaskSection>
            ) : null}

            {selected.local?.recoveryRequired || (selected.local?.unsettledWrites.length ?? 0) > 0 ? (
              <TaskSection key="recovery" layout={taskLayout} entering={taskEnter} exiting={taskExit}>
                <Text style={styles.detailLabel}>恢复状态</Text>
                <Text style={[styles.detailValue, { color: tv.colors.warning }]}>
                  执行结果未核对。已写入但未保存结果的工具调用不会被重发；请核对文件后新建任务。
                </Text>
              </TaskSection>
            ) : null}

            {selected.lastAssistantText ? (
              <TaskSection key="output" layout={taskLayout} entering={taskEnter}>
                <Text style={styles.detailLabel}>最近输出</Text>
                <Text style={styles.detailValue} selectable>{selected.lastAssistantText}</Text>
              </TaskSection>
            ) : null}

            <TaskSection layout={taskLayout}>
              <Text style={styles.detailLabel}>交付物</Text>
              {selected.deliverables.length === 0 ? (
                <Text style={styles.detailEmpty}>还没有交付物</Text>
              ) : selected.deliverables.map(file => (
                <View key={file.path} style={styles.deliverable}>
                  <Text style={styles.deliverablePath}>{file.relativePath ?? file.path}</Text>
                  {file.size !== undefined ? (
                    <Text style={styles.deliverableDesc}>{file.size} 字节{file.sha256 ? ` · SHA-256 ${file.sha256.slice(0, 12)}…` : ''}</Text>
                  ) : null}
                  {file.description ? <Text style={styles.deliverableDesc}>{file.description}</Text> : null}
                </View>
              ))}
              <Text style={styles.deliverableNote}>本机交付物暂不支持在手机上直接打开。</Text>

              {lastAudit ? (
                <>
                  <Text style={styles.detailLabel}>最近审批</Text>
                  <Text style={styles.detailValue}>
                    {lastAudit.toolName} · {lastAudit.decision === 'allowed-once' ? '允许一次' : '拒绝'} · {new Date(lastAudit.at).toLocaleString()}
                  </Text>
                </>
              ) : null}

              <Text style={styles.detailLabel}>操作</Text>
              <View style={styles.detailActions}>
                {(selected.status === 'waiting_user' || selected.status === 'blocked') && !selected.local?.recoveryRequired ? (
                  <TaskPressable
                    onPress={() => resumeTask(selected)}
                    disabled={actionBusy}
                    style={styles.primaryBtn}
                    accessibilityRole="button"
                    accessibilityLabel="继续本机任务"
                  >
                    <Text style={styles.primaryText}>{actionBusy ? '处理中…' : '继续执行'}</Text>
                  </TaskPressable>
                ) : null}
                {ACTIVE_STATUSES.includes(selected.status) ? (
                  <TaskPressable
                    onPress={() => cancelTask(selected)}
                    disabled={actionBusy}
                    style={styles.dangerBtn}
                    accessibilityRole="button"
                    accessibilityLabel="取消本机任务"
                  >
                    <Text style={styles.dangerText}>取消任务</Text>
                  </TaskPressable>
                ) : null}
              </View>
            </TaskSection>
          </>
        ) : null}
      </TaskDetailSheet>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    locationChip: {
      color: C.accent,
      fontSize: tv.type.xs,
      fontWeight: '600',
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: C.accentWash,
      overflow: 'hidden',
    },
    feedContent: { paddingHorizontal: tv.layout.screenPadding, paddingTop: tv.space.md, paddingBottom: tv.space.md },
    turn: { marginBottom: tv.space.lg },
    userBubble: {
      alignSelf: 'flex-end',
      maxWidth: '86%',
      backgroundColor: C.accentWash,
      borderRadius: tv.radius.lg,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      marginBottom: tv.space.sm,
    },
    userText: { color: C.text, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.5 },
    assistantCard: {
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      padding: tv.space.md,
    },
    taskHead: { flexDirection: 'row', alignItems: 'center' },
    statusPill: {
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    statusText: { fontSize: tv.type.micro },
    taskTitle: { flex: 1, color: C.text, fontSize: tv.type.sm, fontWeight: '600', marginLeft: tv.space.sm },
    assistantText: { color: C.textSecondary, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.55, marginTop: tv.space.sm },
    assistantHint: { color: C.textTertiary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.sm },
    warnText: { color: C.warning, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.sm },
    deliverables: { marginTop: tv.space.sm },
    deliverableText: { color: C.textSecondary, fontSize: tv.type.xs, marginTop: 2 },
    deliverableNote: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 4 },
    turnActions: { flexDirection: 'row', gap: 8, marginTop: tv.space.md },
    turnBtn: {
      minHeight: 44,
      minWidth: 56,
      paddingHorizontal: tv.space.md,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    turnBtnText: { color: C.text, fontSize: tv.type.xs },
    turnDangerText: { color: C.danger, fontSize: tv.type.xs },
    // The feed is inverted so the newest task sits at the bottom; undo the
    // flip for the empty state, otherwise its text renders upside down.
    emptyFlip: { transform: [{ scaleY: -1 }] },
    empty: { alignItems: 'center', paddingVertical: tv.space.xl, paddingHorizontal: tv.layout.screenPadding },
    emptyTitle: { color: C.textSecondary, fontSize: tv.type.base },
    emptyHint: { color: C.textFaint, fontSize: tv.type.xs, marginTop: tv.space.sm, textAlign: 'center' },
    errorText: {
      color: C.danger,
      fontSize: tv.type.xs,
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
    },
    unknownText: {
      color: C.warning,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
    },
    unknownBar: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
    },
    unknownBtn: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: tv.space.md,
    },
    unknownBtnText: { color: C.accent, fontSize: tv.type.xs },
    composerWrap: { paddingBottom: tv.space.sm },
    composerHint: {
      color: C.textFaint,
      fontSize: tv.type.micro,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.xs,
    },
    detailTitle: { color: C.text, fontSize: tv.type.lg, fontWeight: '600' },
    detailObjective: { color: C.textSecondary, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.55, marginTop: tv.space.sm },
    detailMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: tv.space.md },
    detailStatus: { fontSize: tv.type.xs, fontWeight: '600' },
    detailMeta: { color: C.textFaint, fontSize: tv.type.micro },
    detailLabel: { color: C.textTertiary, fontSize: tv.type.micro, letterSpacing: 0.5, marginTop: tv.space.lg, marginBottom: 4 },
    detailValue: { color: C.textSecondary, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.5 },
    detailEmpty: { color: C.textFaint, fontSize: tv.type.xs },
    deliverable: {
      paddingVertical: tv.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
    },
    deliverablePath: { color: C.text, fontSize: tv.type.xs },
    deliverableDesc: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 2 },
    detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    primaryBtn: {
      backgroundColor: C.accent,
      borderRadius: tv.radius.sm,
      paddingHorizontal: 14,
      paddingVertical: 10,
      minHeight: 44,
      justifyContent: 'center',
    },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    dangerBtn: {
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
      paddingHorizontal: 14,
      paddingVertical: 10,
      minHeight: 44,
      justifyContent: 'center',
    },
    dangerText: { color: C.danger, fontSize: tv.type.sm },
  });
}
