/**
 * 管家任务页（v0.19）。
 *
 * 数据来自宿主侧 TaskApi，而不是会话投影：
 *   GET  /api/outpost/butler/tasks
 *   POST /api/outpost/butler/tasks/create
 *   POST /api/outpost/butler/tasks/cancel
 *   POST /api/outpost/butler/tasks/resume
 *
 * 任务 = 一个 DSH 会话 + 一个持久 goal；执行由宿主的 goal-round-driver
 * 完成，所以手机锁屏/退出后任务仍会继续。这里只负责交代目标、看状态、
 * 取消和恢复。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Alert,
  RefreshControl,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useApp } from '../App';
import { Header } from '../components/Header';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { FileCard } from '../components/FileCard';
import { TaskDetailSheet } from '../components/TaskDetailSheet';
import { TaskDisclosure, TaskPressable, TaskSection, TaskStatus, taskEnter, taskExit, taskLayout } from '../components/TaskMotion';
import { useTheme } from '../design/theme';
import { useNav } from '../nav/NavHost';
import type { ButlerTask, ButlerTaskStatus } from '../core/butlerTasks';
import {
  APPROVAL_STATUS_TEXT, TASK_FILTERS, filterTasks, reconcileTasks, taskFilterCounts,
  taskListSummary, taskPollDelay, upsertTask, type TaskFilter,
} from '../core/butlerTaskList';

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

function newIdempotencyKey(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeText(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}

const taskKey = (task: ButlerTask) => task.id;

const TaskListCard = React.memo(function TaskListCard({ task, styles, color, onOpen }: {
  task: ButlerTask;
  styles: ReturnType<typeof makeStyles>;
  color: string;
  onOpen: (task: ButlerTask) => void;
}) {
  const summary = taskListSummary(task);
  return (
    <TaskPressable
      testID={`butler-task-${task.id}`}
      accessibilityRole="button"
      accessibilityHint="打开任务详情"
      onPress={() => onOpen(task)}
      style={({ pressed }: { pressed: boolean }) => [styles.card, pressed ? { opacity: 0.75 } : null]}
    >
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle} numberOfLines={2}>{task.title}</Text>
        <TaskStatus label={STATUS_TEXT[task.status]} color={color} style={styles.statusPill} textStyle={styles.statusText} />
      </View>
      <Text style={styles.cardObjective} numberOfLines={2}>{task.objective}</Text>
      <Text style={styles.cardMeta} numberOfLines={2}>
        {summary ?? `${task.deliverables.length} 个交付 · ${timeText(task.updatedAt)}`}
      </Text>
    </TaskPressable>
  );
});

export function ButlerTasksScreen({ cwd: cwdProp }: { cwd?: string }) {
  const { store, butlerWorkspace } = useApp();
  const nav = useNav();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  const [tasks, setTasks] = useState<ButlerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ButlerTask | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [objective, setObjective] = useState('');
  const [cwd, setCwd] = useState(cwdProp || butlerWorkspace || '');
  const [maxRounds, setMaxRounds] = useState('32');
  const [autoResume, setAutoResume] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [detailActive, setDetailActive] = useState(false);
  const openDetails = useCallback((task: ButlerTask) => {
    setDetailActive(true);
    setSelected(task);
  }, []);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const tasksRef = useRef<ButlerTask[]>([]);
  const scheduleNextPoll = useRef<() => void>(() => {});
  const applyTasks = useCallback((incoming: ButlerTask[]) => {
    const next = reconcileTasks(tasksRef.current, incoming);
    tasksRef.current = next;
    setTasks(next);
    setSelected(prev => {
      if (!prev) return prev;
      const updated = next.find(task => task.id === prev.id);
      return updated && updated.revision > prev.revision ? updated : prev;
    });
  }, []);
  const applyActionTask = useCallback((task: ButlerTask) => {
    applyTasks(upsertTask(tasksRef.current, task));
  }, [applyTasks]);
  const idemRef = useRef<{ key: string; input: string } | null>(null);
  const loadGeneration = useRef(0);
  const initialLoadSettled = useRef(false);
  const pendingChat = useRef<{ sessionId: string; title: string } | null>(null);
  const closeDetails = useCallback(() => setSelected(null), []);
  const afterDetailClose = useCallback(() => {
    setDetailActive(false);
    const chat = pendingChat.current;
    pendingChat.current = null;
    if (chat) nav.push('Chat', chat);
  }, [nav]);

  useEffect(() => {
    if (!cwd && store.workspaces[0]?.path) setCwd(store.workspaces[0].path);
  }, [cwd, store.workspaces]);

  const duplicateWorkspaceNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const workspace of store.workspaces) {
      counts.set(workspace.name, (counts.get(workspace.name) ?? 0) + 1);
    }
    const duplicates = new Set<string>();
    for (const [name, count] of counts) {
      if (count > 1) duplicates.add(name);
    }
    return duplicates;
  }, [store.workspaces]);

  const load = useCallback(
    async (soft = false) => {
      const generation = ++loadGeneration.current;
      if (!soft) setLoading(true);
      try {
        const list = await store.listButlerTasks();
        if (generation !== loadGeneration.current) return;
        applyTasks(list);
        setError(null);
      } catch (e) {
        if (generation === loadGeneration.current) setError(messageOf(e));
      } finally {
        if (generation === loadGeneration.current) {
          initialLoadSettled.current = true;
          setLoading(false);
          setRefreshing(false);
          scheduleNextPoll.current();
        }
      }
    },
    [store, applyTasks],
  );

  const isVisible = nav.stack[nav.stack.length - 1]?.name === 'ButlerTasks';
  useEffect(() => {
    if (!isVisible) return;
    if (store.workspaces.length === 0) void store.loadSessions();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const schedule = () => {
      clear();
      if (!active) return;
      const generation = loadGeneration.current;
      timer = setTimeout(() => {
        if (active && generation === loadGeneration.current) void load(true);
      }, taskPollDelay(tasksRef.current));
    };
    scheduleNextPoll.current = schedule;
    const onState = (state: string | null) => {
      const nextActive = state === 'active';
      if (nextActive === active) return;
      clear();
      active = nextActive;
      loadGeneration.current += 1;
      if (active) void load(false);
    };
    const subscription = AppState.addEventListener('change', onState);
    onState(AppState.currentState);
    return () => {
      active = false;
      clear();
      if (scheduleNextPoll.current === schedule) scheduleNextPoll.current = () => {};
      subscription.remove();
      loadGeneration.current += 1;
    };
  }, [isVisible, load, store]);

  const submit = useCallback(async () => {
    const text = objective.trim();
    if (!text) {
      setError('请先写下你想让管家完成的目标。');
      return;
    }
    if (!cwd.trim()) {
      setError('请选择一个工作区，任务会在这个目录里执行。');
      return;
    }
    const rounds = Number(maxRounds);
    const input = {
      objective: text,
      cwd: cwd.trim(),
      maxGoalRounds: Number.isFinite(rounds) && rounds > 0 ? Math.floor(rounds) : undefined,
      autoResume,
    };
    const fingerprint = JSON.stringify(input);
    if (idemRef.current?.input !== fingerprint) idemRef.current = { key: newIdempotencyKey(), input: fingerprint };
    setSubmitting(true);
    setError(null);
    try {
      const task = await store.createButlerTask(
        input,
        idemRef.current!.key,
      );
      idemRef.current = null;
      setObjective('');
      setDetailError(null);
      applyActionTask(task);
      openDetails(task);
      await load(true);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSubmitting(false);
    }
  }, [autoResume, cwd, load, maxRounds, objective, openDetails, store, applyActionTask]);

  const doCancel = useCallback(
    async (task: ButlerTask) => {
      setActionBusy(true);
      try {
        const next = await store.cancelButlerTask(task.id);
        setDetailError(null);
        applyActionTask(next);
        setSelected((prev) => prev?.id === task.id && next.revision > prev.revision ? next : prev);
        await load(true);
      } catch (e) {
        setDetailError(messageOf(e));
      } finally {
        setActionBusy(false);
      }
    },
    [load, store, applyActionTask],
  );

  const cancel = useCallback(
    (task: ButlerTask) => {
      Alert.alert('取消任务？', '当前执行会停止，已经完成的步骤会保留在会话里。', [
        { text: '再想想', style: 'cancel' },
        { text: '取消任务', style: 'destructive', onPress: () => void doCancel(task) },
      ]);
    },
    [doCancel],
  );

  const resume = useCallback(
    async (task: ButlerTask) => {
      setActionBusy(true);
      try {
        const next = await store.resumeButlerTask(task.id);
        setDetailError(null);
        applyActionTask(next);
        setSelected((prev) => prev?.id === task.id && next.revision > prev.revision ? next : prev);
        await load(true);
      } catch (e) {
        setDetailError(messageOf(e));
      } finally {
        setActionBusy(false);
      }
    },
    [load, store, applyActionTask],
  );

  const statusColor = useCallback((status: ButlerTaskStatus): string => {
    if (status === 'completed') return tv.colors.success;
    if (status === 'failed' || status === 'cancelled') return tv.colors.danger;
    if (status === 'waiting_user' || status === 'blocked') return tv.colors.warning;
    if (status === 'running' || status === 'preparing') return tv.colors.accent;
    return tv.colors.textTertiary;
  }, [tv.colors]);

  const filteredTasks = useMemo(() => filterTasks(tasks, filter), [tasks, filter]);
  const counts = useMemo(() => taskFilterCounts(tasks), [tasks]);
  const renderTask = useCallback(({ item }: { item: ButlerTask }) => (
    <TaskListCard task={item} styles={styles} color={statusColor(item.status)} onOpen={openDetails} />
  ), [styles, statusColor, openDetails]);

  return (
    <View style={styles.root}>
      <View style={{ flex: 1 }} importantForAccessibility={detailActive ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={detailActive}>
      <Header title="管家任务" subtitle={`${tasks.length} 个`} showBack />

      <FlatList
        data={filteredTasks}
        renderItem={renderTask}
        keyExtractor={taskKey}
        initialNumToRender={6}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load(true);
            }}
            tintColor={tv.colors.textTertiary}
          />
        }
        ListHeaderComponent={
        <View>
        {error ? (
          <TaskPressable onPress={() => setError(null)}>
            <Text style={styles.error}>{error}</Text>
          </TaskPressable>
        ) : null}

        <View style={styles.formCard}>
          <Text style={styles.formTitle}>交代一个新目标</Text>
          <TextInput
            value={objective}
            onChangeText={setObjective}
            placeholder="例如：整理本周的发布记录，生成一份 markdown 摘要"
            placeholderTextColor={tv.colors.textFaint}
            style={styles.objectiveInput}
            multiline
            textAlignVertical="top"
          />

          <Text style={styles.fieldLabel}>工作区</Text>
          {store.workspaces.length > 0 ? (
            <View style={styles.chips}>
              {store.workspaces.map((workspace) => {
                const on = workspace.path === cwd;
                const label = duplicateWorkspaceNames.has(workspace.name)
                  ? `${workspace.name} · ${workspace.path}`
                  : workspace.name;
                return (
                  <TaskPressable
                    key={workspace.path || workspace.name}
                    onPress={() => setCwd(workspace.path)}
                    style={[styles.chip, on ? styles.chipOn : null]}
                  >
                    <Text style={[styles.chipText, on ? styles.chipTextOn : null]} numberOfLines={1}>
                      {label}
                    </Text>
                  </TaskPressable>
                );
              })}
            </View>
          ) : (
            <TextInput
              value={cwd}
              onChangeText={setCwd}
              placeholder="工作区绝对路径，例如 E:/work/example"
              placeholderTextColor={tv.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          )}
          {cwd ? (
            <Text style={styles.cwdText} numberOfLines={2}>
              {cwd}
            </Text>
          ) : null}

          <TaskDisclosure summary={`最多 ${maxRounds || '32'} 轮`}>
            <View style={styles.rowBetween}>
              <Text style={styles.fieldLabel}>最大轮数</Text>
              <TextInput
                value={maxRounds}
                onChangeText={setMaxRounds}
                keyboardType="number-pad"
                style={[styles.input, styles.roundsInput]}
              />
            </View>
            <TaskPressable onPress={() => setAutoResume((value) => !value)} style={styles.checkRow}>
              <Text style={styles.checkbox}>{autoResume ? '☑' : '☐'}</Text>
              <Text style={styles.checkText}>宿主重启后自动继续（默认停下来等你）</Text>
            </TaskPressable>
          </TaskDisclosure>

          <TaskPressable
            onPress={() => void submit()}
            disabled={submitting}
            style={({ pressed }: { pressed: boolean }) => [
              styles.primaryBtn,
              pressed ? { opacity: 0.8 } : null,
              submitting ? { opacity: 0.6 } : null,
            ]}
          >
            <Text style={styles.primaryText}>{submitting ? '创建中…' : '创建任务'}</Text>
          </TaskPressable>
        </View>

        <Text style={styles.sectionLabel}>任务</Text>
        <View style={styles.filters} accessibilityRole="tablist">
          {TASK_FILTERS.map(option => (
            <TaskPressable
              key={option.value}
              accessibilityRole="tab"
              accessibilityLabel={option.label + '，' + counts[option.value] + ' 个任务'}
              accessibilityState={{ selected: filter === option.value }}
              onPress={() => setFilter(option.value)}
              style={[styles.filter, filter === option.value ? styles.filterOn : null]}
            >
              <Text style={[styles.filterText, filter === option.value ? styles.filterTextOn : null]}>
                {option.label} {counts[option.value]}
              </Text>
            </TaskPressable>
          ))}
        </View>
        </View>
        }
        ListEmptyComponent={
          loading && !initialLoadSettled.current && tasks.length === 0 && !error ? (
            <LoadingSkeleton label="正在加载管家任务" />
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>◎</Text>
              <Text style={styles.emptyText}>
                {error && tasks.length === 0 ? '暂时无法读取任务' : tasks.length === 0 ? '还没有任务' : '当前没有' + TASK_FILTERS.find(option => option.value === filter)?.label + '的任务'}
              </Text>
              {error && tasks.length === 0 ? (
                <TaskPressable accessibilityRole="button" disabled={loading || refreshing} onPress={() => void load(false)} style={styles.retryBtn}>
                  <Text style={styles.secondaryText}>{loading || refreshing ? '重新加载中…' : '重新加载'}</Text>
                </TaskPressable>
              ) : <Text style={styles.emptyHint}>{tasks.length === 0 ? '写下目标后，管家会在电脑上持续执行' : '切换筛选可查看其他任务'}</Text>}
            </View>
          )
        }
        ListFooterComponent={<View style={{ height: tv.space.xxxl }} />}
      />
      </View>

      <TaskDetailSheet visible={isVisible && selected !== null} onClose={closeDetails} onAfterClose={afterDetailClose}>
          {selected ? (
            <>
              <Text style={styles.detailTitle}>{selected.title}</Text>
              <Text style={styles.detailObjective}>{selected.objective}</Text>

              <View style={styles.detailMetaRow}>
                <TaskStatus label={STATUS_TEXT[selected.status]} color={statusColor(selected.status)} textStyle={styles.detailStatus} />
                {selected.goalPhase ? <Text style={styles.detailMeta}>goal: {selected.goalPhase}</Text> : null}
                <Text style={styles.detailMeta}>轮次 {selected.maxGoalRounds}</Text>
              </View>

              {detailError ? <Text style={styles.detailError}>{detailError}</Text> : null}

              <Text style={styles.detailLabel}>工作区</Text>
              <Text style={styles.detailValue}>{selected.cwd}</Text>

              {selected.lastError ? (
                <TaskSection key="explanation" layout={taskLayout} entering={taskEnter} exiting={taskExit}>
                  <Text style={styles.detailLabel}>状态说明</Text>
                  <Text style={[styles.detailValue, { color: tv.colors.warning }]}>
                    {APPROVAL_STATUS_TEXT[selected.lastError] ?? selected.lastError}
                  </Text>
                </TaskSection>
              ) : null}

              {selected.pendingApproval ? (
                <TaskSection key="approval" layout={taskLayout} entering={taskEnter} exiting={taskExit}>
                  <Text style={styles.detailLabel}>待审批</Text>
                  <Text style={[styles.detailValue, { color: tv.colors.warning }]}>
                    {selected.pendingApproval.toolName} · {selected.pendingApprovals?.length || 1} 条待审批，请打开会话处理。发送成功后仍需等待网关确认；拒绝或超时会暂停任务。
                  </Text>
                </TaskSection>
              ) : null}

              {selected.lastAssistantText ? (
                <TaskSection key="output" layout={taskLayout} entering={taskEnter}>
                  <Text style={styles.detailLabel}>最近输出</Text>
                  <Text style={styles.detailValue}>{selected.lastAssistantText}</Text>
                </TaskSection>
              ) : null}

              <TaskSection layout={taskLayout}>
              <Text style={styles.detailLabel}>交付物</Text>
              {selected.deliverables.length === 0 ? (
                <Text style={styles.detailEmpty}>还没有交付物</Text>
              ) : (
                selected.deliverables.map((file) => (
                  <View key={`${file.path}:${file.sha256 ?? ''}:${file.size ?? ''}`} style={styles.deliverable}>
                    {file.unavailableReason ? (
                      <Text style={styles.deliverablePath}>{file.path} · 文件不可用，请让管家重新交付</Text>
                    ) : (
                      <FileCard
                        path={file.relativePath ?? file.path}
                        sessionId={selected.sessionId ?? undefined}
                        workspacePath={selected.cwd}
                        expectedSha256={file.sha256}
                        expectedSize={file.size}
                      />
                    )}
                    {file.size !== undefined ? <Text style={styles.deliverableDesc}>{file.size} 字节 · SHA-256 {file.sha256?.slice(0, 12)}…</Text> : null}
                    {file.description ? (
                      <Text style={styles.deliverableDesc}>{file.description}</Text>
                    ) : null}
                  </View>
                ))
              )}

              <Text style={styles.detailLabel}>操作</Text>
              <View style={styles.actions}>
                {selected.sessionId ? (
                  <TaskPressable
                    onPress={() => {
                      pendingChat.current = { sessionId: selected.sessionId!, title: selected.title };
                      setSelected(null);
                    }}
                    style={styles.secondaryBtn}
                  >
                    <Text style={styles.secondaryText}>{selected.pendingApproval ? '打开会话处理审批' : '打开会话'}</Text>
                  </TaskPressable>
                ) : null}

                {!selected.pendingApproval && (selected.status === 'waiting_user' || selected.status === 'blocked') ? (
                  <TaskPressable
                    onPress={() => void resume(selected)}
                    disabled={actionBusy}
                    style={[styles.primaryBtn, styles.actionBtn]}
                  >
                    <Text style={styles.primaryText}>{actionBusy ? '处理中…' : '继续执行'}</Text>
                  </TaskPressable>
                ) : null}

                {ACTIVE_STATUSES.includes(selected.status) ? (
                  <TaskPressable
                    onPress={() => cancel(selected)}
                    disabled={actionBusy}
                    style={[styles.dangerBtn, styles.actionBtn]}
                  >
                    <Text style={styles.dangerText}>取消任务</Text>
                  </TaskPressable>
                ) : null}
              </View>

              <Text style={styles.detailMeta}>创建于 {timeText(selected.createdAt)}</Text>
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
    content: { paddingTop: tv.space.md },
    error: {
      color: C.danger,
      fontSize: tv.type.xs,
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
    },
    formCard: {
      marginHorizontal: tv.layout.screenPadding,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      marginBottom: tv.space.lg,
    },
    formTitle: { color: C.text, fontSize: tv.type.base, fontWeight: '600', marginBottom: tv.space.sm },
    objectiveInput: {
      minHeight: 86,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      backgroundColor: C.bg,
      color: C.text,
      paddingHorizontal: tv.space.sm,
      paddingVertical: tv.space.sm,
      fontSize: tv.type.sm,
      lineHeight: tv.type.sm * 1.5,
    },
    input: {
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      backgroundColor: C.bg,
      color: C.text,
      paddingHorizontal: tv.space.sm,
      paddingVertical: 8,
      fontSize: tv.type.sm,
    },
    fieldLabel: { color: C.textSecondary, fontSize: tv.type.xs, marginTop: tv.space.md, marginBottom: tv.space.xs },
    cwdText: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 4 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      maxWidth: '100%',
    },
    chipOn: { borderColor: C.accent, backgroundColor: C.accentWash },
    chipText: { color: C.textSecondary, fontSize: tv.type.xs },
    chipTextOn: { color: C.accentBright },
    rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    roundsInput: { width: 72, textAlign: 'center', marginTop: tv.space.md },
    checkRow: { flexDirection: 'row', alignItems: 'center', marginTop: tv.space.md },
    checkbox: { color: C.accent, fontSize: 16, marginRight: 8 },
    checkText: { color: C.textSecondary, fontSize: tv.type.xs, flex: 1 },
    primaryBtn: {
      marginTop: tv.space.md,
      backgroundColor: C.accent,
      borderRadius: tv.radius.sm,
      paddingVertical: 11,
      paddingHorizontal: 14,
      alignItems: 'center',
    },
    primaryText: { color: '#fff', fontSize: tv.type.sm, fontWeight: '600' },
    sectionLabel: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      letterSpacing: 0.6,
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
    },
    filters: { flexDirection: 'row', gap: 6, marginHorizontal: tv.layout.screenPadding, marginBottom: tv.space.md },
    filter: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderRadius: tv.radius.sm, backgroundColor: C.bgRaised, paddingHorizontal: 2 },
    filterOn: { backgroundColor: C.accentWash },
    filterText: { color: C.textSecondary, fontSize: tv.type.xs },
    filterTextOn: { color: C.accentBright, fontWeight: '600' },
    retryBtn: { marginTop: tv.space.md, padding: tv.space.sm, minHeight: 44, minWidth: 64, justifyContent: 'center', alignItems: 'center' },
    card: {
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
    cardTitle: { flex: 1, color: C.text, fontSize: tv.type.sm, fontWeight: '600', lineHeight: tv.type.sm * 1.4 },
    statusPill: {
      marginLeft: tv.space.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    statusText: { fontSize: tv.type.micro },
    cardObjective: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 6 },
    cardMeta: { color: C.textFaint, fontSize: tv.type.micro, marginTop: tv.space.sm },
    empty: { alignItems: 'center', paddingVertical: tv.space.xxxl },
    emptyIcon: { color: C.textFaint, fontSize: 34, marginBottom: tv.space.md },
    emptyText: { color: C.textSecondary, fontSize: tv.type.base },
    emptyHint: { color: C.textFaint, fontSize: tv.type.xs, marginTop: tv.space.sm },
    detailTitle: { color: C.text, fontSize: tv.type.lg, fontWeight: '600' },
    detailObjective: { color: C.textSecondary, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.55, marginTop: tv.space.sm },
    detailMetaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: tv.space.md },
    detailStatus: { fontSize: tv.type.xs, fontWeight: '600' },
    detailMeta: { color: C.textFaint, fontSize: tv.type.micro },
    detailError: { color: C.danger, fontSize: tv.type.xs, marginTop: tv.space.sm },
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
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    actionBtn: { marginTop: 0 },
    secondaryBtn: {
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    secondaryText: { color: C.text, fontSize: tv.type.sm },
    dangerBtn: {
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    dangerText: { color: C.danger, fontSize: tv.type.sm },
  });
}
