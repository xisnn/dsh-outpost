/**
 * Rurea C3 本机任务执行历史与核对页（独立外壳页面，不耦合 dsh App 上下文）：
 * - 展示持久化 FileRunStore 历史任务、阶段状态、步数与创建/更新时间；
 * - 突出展示未核对崩溃/未知副作用（requiresReconciliation）并提供「确认已核对」持久化动作；
 * - 可折叠查看持久化的精简工具执行时间线。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { useTheme } from '../design/theme';
import {
  agentClient,
  type AgentHistoryItem,
  type AgentStorageStatus,
} from '../core/agent';
import {
  formatCrashRecoveryReason,
  formatTimelineEvent,
} from '../core/agentRecovery';
import {
  filterHistoryItems,
  formatHistoryPhase,
  formatShortTime,
  formatStorageNotice,
  type HistoryFilter,
} from '../core/agentPersistence';

export function AgentHistoryScreen({ active = true }: { active?: boolean }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [items, setItems] = useState<AgentHistoryItem[]>([]);
  const [storage, setStorage] = useState<AgentStorageStatus | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({});
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [historyRows, nextStorage] = await Promise.all([
        agentClient.history(),
        agentClient.storageStatus().catch(() => null),
      ]);
      setItems(historyRows);
      if (nextStorage) setStorage(nextStorage);
      setError(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const acknowledge = useCallback(async (runId: string) => {
    if (busyRunId) return;
    setBusyRunId(runId);
    setError(null);
    try {
      await agentClient.acknowledgeRun(runId);
      await load();
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusyRunId(null);
    }
  }, [busyRunId, load]);

  const toggleExpanded = useCallback((runId: string) => {
    setExpandedRunIds((prev) => ({ ...prev, [runId]: !prev[runId] }));
  }, []);

  const storageNotice = useMemo(() => formatStorageNotice(storage), [storage]);
  const downgradeBlocked = Boolean(storage?.downgradeBlocked);
  const visibleItems = useMemo(() => filterHistoryItems(items, filter), [items, filter]);

  return (
    <View style={styles.root}>
      <Header
        title="任务历史"
        subtitle="本机 Agent"
        right={
          <Pressable
            onPress={() => void load()}
            accessibilityRole="button"
            accessibilityLabel="刷新任务历史"
            hitSlop={8}
          >
            <Text style={styles.headerAction}>刷新</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        {storageNotice ? (
          <View
            style={[
              styles.card,
              storageNotice.tone === 'danger' ? styles.dangerBorder : styles.warningBorder,
            ]}
          >
            <Text style={styles.cardTitle}>{storageNotice.title}</Text>
            <Text style={styles.hint}>{storageNotice.body}</Text>
          </View>
        ) : null}

        <View style={styles.filterRow}>
          {([
            ['all', '全部'],
            ['reconciliation', '待核对'],
            ['issues', '失败与中断'],
          ] as const).map(([key, label]) => {
            const selected = filter === key;
            return (
              <Pressable
                key={key}
                onPress={() => setFilter(key)}
                accessibilityRole="button"
                accessibilityLabel={`筛选 ${label}`}
                style={[styles.chip, selected ? styles.chipSelected : null]}
              >
                <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {error ? (
          <View style={[styles.card, styles.dangerBorder]}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {visibleItems.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.hint}>
              {items.length === 0 ? '还没有保存过的任务执行记录。' : '当前筛选条件下没有记录。'}
            </Text>
          </View>
        ) : visibleItems.map((item) => {
          const phaseInfo = formatHistoryPhase(item.phase);
          const events = item.events ?? [];
          const expanded = Boolean(expandedRunIds[item.runId]);
          const startedText = formatShortTime(item.createdAt ?? item.updatedAt);
          const updatedText = formatShortTime(item.updatedAt);
          const reconciledText = formatShortTime(item.reconciledAt);
          const reasonCopy =
            item.phase === 'interrupted' || item.requiresReconciliation
              ? formatCrashRecoveryReason({
                  reason: item.reason,
                  requiresReconciliation: item.requiresReconciliation,
                })
              : item.reason;

          return (
            <View
              key={item.runId}
              style={[
                styles.card,
                item.requiresReconciliation ? styles.warningBorder : null,
              ]}
            >
              <View style={styles.topRow}>
                <Text style={styles.goalText} numberOfLines={3}>
                  {item.goal || '无任务目标'}
                </Text>
                <View
                  style={[
                    styles.phaseTag,
                    phaseInfo.tone === 'success'
                      ? styles.tagSuccess
                      : phaseInfo.tone === 'danger'
                        ? styles.tagDanger
                        : phaseInfo.tone === 'warning'
                          ? styles.tagWarning
                          : styles.tagNeutral,
                  ]}
                >
                  <Text
                    style={[
                      styles.phaseText,
                      phaseInfo.tone === 'success'
                        ? styles.textSuccess
                        : phaseInfo.tone === 'danger'
                          ? styles.textDanger
                          : phaseInfo.tone === 'warning'
                            ? styles.textWarning
                            : null,
                    ]}
                  >
                    {phaseInfo.label}
                  </Text>
                </View>
              </View>

              <Text style={styles.metaText}>
                {startedText ? `开始 ${startedText}` : `Run ${item.runId.slice(0, 8)}`}
                {updatedText && updatedText !== startedText ? ` · 更新 ${updatedText}` : ''}
                {typeof item.step === 'number' && item.step > 0 ? ` · ${item.step} 步` : ''}
                {item.lastToolName ? ` · 最后工具 ${item.lastToolName}` : ''}
              </Text>

              {reasonCopy ? <Text style={styles.reasonText}>{reasonCopy}</Text> : null}

              {item.resultText ? (
                <Text style={styles.resultText} numberOfLines={4}>
                  {item.resultText}
                </Text>
              ) : null}

              {item.requiresReconciliation ? (
                <View style={styles.reconcileBox}>
                  <Text style={styles.reconcileTitle}>待核对未知副作用</Text>
                  <Text style={styles.hint}>
                    进程中断时工具结果未知；请核对实际状态后点击确认。
                  </Text>
                  <Pressable
                    onPress={() => void acknowledge(item.runId)}
                    disabled={busyRunId !== null || downgradeBlocked}
                    accessibilityRole="button"
                    accessibilityLabel={`确认已核对 ${item.runId}`}
                    style={[
                      styles.ackBtn,
                      busyRunId !== null || downgradeBlocked ? styles.muted : null,
                    ]}
                  >
                    <Text style={styles.ackText}>
                      {busyRunId === item.runId ? '核对中…' : '确认已核对'}
                    </Text>
                  </Pressable>
                </View>
              ) : reconciledText ? (
                <Text style={styles.reconciledBadge}>已核对 · {reconciledText}</Text>
              ) : null}

              {events.length > 0 ? (
                <View style={styles.eventsWrap}>
                  <Pressable
                    onPress={() => toggleExpanded(item.runId)}
                    accessibilityRole="button"
                    accessibilityLabel={
                      expanded
                        ? `收起执行记录 ${item.runId}`
                        : `查看执行记录 ${item.runId}`
                    }
                    style={styles.eventsToggle}
                  >
                    <Text style={styles.eventsToggleText}>
                      {expanded ? `收起执行记录（${events.length}）` : `查看执行记录（${events.length}）`}
                    </Text>
                  </Pressable>
                  {expanded ? (
                    <View style={styles.eventsList}>
                      {events.map((evt) => {
                        const formatted = formatTimelineEvent(evt);
                        return (
                          <Text
                            key={`${item.runId}-${evt.seq}-${evt.type}`}
                            style={styles.eventLine}
                          >
                            • {formatted.label}
                          </Text>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    content: { paddingBottom: tv.space.xxxl },
    headerAction: { color: C.accent, fontSize: tv.type.sm, fontWeight: '600' },
    filterRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
    },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: tv.radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      backgroundColor: C.bgRaised,
    },
    chipSelected: { borderColor: C.accent, backgroundColor: C.accentWash },
    chipText: { color: C.textSecondary, fontSize: tv.type.xs },
    chipTextSelected: { color: C.accent, fontWeight: '600' },
    card: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    warningBorder: { borderColor: C.warning },
    dangerBorder: { borderColor: C.danger },
    cardTitle: { color: C.text, fontSize: tv.type.sm, fontWeight: '600', marginBottom: 4 },
    topRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 10,
    },
    goalText: { flex: 1, color: C.text, fontSize: tv.type.sm, fontWeight: '600', lineHeight: tv.type.sm * 1.45 },
    phaseTag: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: tv.radius.xs,
      borderWidth: StyleSheet.hairlineWidth,
    },
    tagSuccess: { borderColor: C.success, backgroundColor: C.successWash },
    tagDanger: { borderColor: C.danger, backgroundColor: C.dangerWash },
    tagWarning: { borderColor: C.warning, backgroundColor: C.warningWash },
    tagNeutral: { borderColor: C.border, backgroundColor: C.bg },
    phaseText: { color: C.textSecondary, fontSize: tv.type.micro, fontWeight: '600' },
    textSuccess: { color: C.success },
    textDanger: { color: C.danger },
    textWarning: { color: C.warning },
    metaText: { color: C.textTertiary, fontSize: tv.type.micro, marginTop: 6 },
    reasonText: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 6 },
    resultText: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      marginTop: 6,
      padding: tv.space.sm,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bg,
    },
    hint: { color: C.textTertiary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5 },
    errorText: { color: C.danger, fontSize: tv.type.xs },
    reconcileBox: {
      marginTop: tv.space.sm,
      padding: tv.space.sm,
      borderRadius: tv.radius.sm,
      backgroundColor: C.warningWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.warning,
    },
    reconcileTitle: { color: C.warning, fontSize: tv.type.xs, fontWeight: '600', marginBottom: 4 },
    ackBtn: {
      alignSelf: 'flex-start',
      marginTop: tv.space.sm,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: tv.radius.sm,
      backgroundColor: C.accent,
    },
    ackText: { color: C.onAccent, fontSize: tv.type.xs, fontWeight: '600' },
    reconciledBadge: { color: C.success, fontSize: tv.type.micro, marginTop: 6 },
    eventsWrap: { marginTop: tv.space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, paddingTop: 6 },
    eventsToggle: { alignSelf: 'flex-start', paddingVertical: 4 },
    eventsToggleText: { color: C.accent, fontSize: tv.type.xs, fontWeight: '600' },
    eventsList: { marginTop: 4, gap: 3 },
    eventLine: { color: C.textSecondary, fontSize: tv.type.micro, lineHeight: tv.type.micro * 1.45 },
    muted: { opacity: 0.55 },
  });
}
