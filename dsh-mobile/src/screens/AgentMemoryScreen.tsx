/**
 * P6 本机 Agent 的显式用户记忆。只接受用户主动保存的 key/value，不会自动
 * 从聊天或屏幕提取；支持偏好/项目/事实分类、置顶优先级、停用开关与 2400 字注入预算视图。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { useTheme } from '../design/theme';
import {
  agentClient,
  type AgentMemoryBudget,
  type AgentMemoryEntry,
  type AgentMemoryKind,
  type AgentStorageStatus,
} from '../core/agent';
import {
  computeMemoryBudgetView,
  filterMemoryEntries,
  formatStorageNotice,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
} from '../core/agentPersistence';

export function AgentMemoryScreen({ active = true }: { active?: boolean }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [entries, setEntries] = useState<AgentMemoryEntry[]>([]);
  const [budget, setBudget] = useState<AgentMemoryBudget | null>(null);
  const [storage, setStorage] = useState<AgentStorageStatus | null>(null);
  const [editing, setEditing] = useState<AgentMemoryEntry | null>(null);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<AgentMemoryKind>('fact');
  const [pinned, setPinned] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [filterKind, setFilterKind] = useState<'all' | AgentMemoryKind>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextEntries, nextBudget, nextStorage] = await Promise.all([
        agentClient.getMemory(),
        agentClient.getMemoryBudget(),
        agentClient.storageStatus().catch(() => null),
      ]);
      setEntries(nextEntries);
      setBudget(nextBudget);
      if (nextStorage) setStorage(nextStorage);
      setError(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const reset = () => {
    setEditing(null);
    setKey('');
    setValue('');
    setKind('fact');
    setPinned(false);
    setEnabled(true);
  };

  const downgradeBlocked = Boolean(storage?.downgradeBlocked);
  const storageNotice = useMemo(() => formatStorageNotice(storage), [storage]);
  const budgetView = useMemo(
    () => computeMemoryBudgetView(entries, budget),
    [entries, budget],
  );
  const visibleEntries = useMemo(
    () => filterMemoryEntries(entries, { kind: filterKind, query: searchQuery }),
    [entries, filterKind, searchQuery],
  );

  const save = useCallback(async () => {
    if (downgradeBlocked) {
      setError('本机存储处于只读保护状态，无法修改记忆');
      return;
    }
    if (!key.trim() || !value.trim()) {
      setError('名称和内容都不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await agentClient.saveMemoryEntry(
        editing?.id ?? null,
        key.trim(),
        value.trim(),
        kind,
        pinned,
        enabled,
      );
      reset();
      await load();
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, [downgradeBlocked, editing, enabled, key, kind, load, pinned, value]);

  const toggleFlag = useCallback(
    async (entry: AgentMemoryEntry, field: 'pinned' | 'enabled') => {
      if (busy || downgradeBlocked) return;
      setBusy(true);
      setError(null);
      try {
        const nextPinned = field === 'pinned' ? !entry.pinned : Boolean(entry.pinned);
        const nextEnabled = field === 'enabled' ? entry.enabled === false : entry.enabled !== false;
        await agentClient.saveMemoryEntry(
          entry.id,
          entry.key,
          entry.value,
          entry.kind ?? 'fact',
          nextPinned,
          nextEnabled,
        );
        await load();
      } catch (failure) {
        setError(String((failure as Error)?.message ?? failure));
      } finally {
        setBusy(false);
      }
    },
    [busy, downgradeBlocked, load],
  );

  const remove = useCallback((entry: AgentMemoryEntry) => {
    if (downgradeBlocked) return;
    Alert.alert('删除这条记忆？', `${entry.key} 只保存在本机。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await agentClient.deleteMemory(entry.id);
              if (editing?.id === entry.id) reset();
              await load();
            } catch (failure) {
              setError(String((failure as Error)?.message ?? failure));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }, [downgradeBlocked, editing?.id, load]);

  return (
    <View style={styles.root}>
      <Header title="管家记忆" subtitle="本机 Agent" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.notice}>
          只保存你主动写下的偏好、项目与事实；不会从聊天、屏幕或工具结果自动提取。
          已启用的条目会按置顶与时间顺序以用户数据附加到本机 Agent 的提示词，可能发送给你配置的模型服务商。
        </Text>

        {storageNotice ? (
          <View
            style={[
              styles.card,
              storageNotice.tone === 'danger' ? styles.dangerBorder : styles.warningBorder,
            ]}
          >
            <Text style={styles.storageTitle}>{storageNotice.title}</Text>
            <Text style={styles.hint}>{storageNotice.body}</Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.budgetHeader}>
            <Text style={styles.cardTitle}>提示词注入预算</Text>
            <Text style={styles.budgetMeta}>{budgetView.summaryText}</Text>
          </View>
          <View style={styles.budgetTrack}>
            <View
              style={[
                styles.budgetFill,
                { width: `${Math.round(budgetView.ratio * 100)}%` },
                budgetView.overBudget ? styles.budgetFillWarn : null,
              ]}
            />
          </View>
          <Text style={styles.budgetHint}>
            注入顺序：已启用条目中「置顶」优先，其次按最近更新时间排序；单次上限 {budgetView.maxChars} 字符。
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{editing ? '编辑记忆' : '新增记忆'}</Text>
          <View style={styles.chipRow}>
            {MEMORY_KINDS.map((option) => {
              const selected = kind === option;
              return (
                <Pressable
                  key={option}
                  onPress={() => setKind(option)}
                  accessibilityRole="button"
                  accessibilityLabel={`分类 ${MEMORY_KIND_LABELS[option]}`}
                  style={[styles.chip, selected ? styles.chipSelected : null]}
                >
                  <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                    {MEMORY_KIND_LABELS[option]}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => setPinned((prev) => !prev)}
              accessibilityRole="button"
              accessibilityLabel={pinned ? '取消置顶优先' : '设为置顶优先'}
              style={[styles.chip, pinned ? styles.chipPinned : null]}
            >
              <Text style={[styles.chipText, pinned ? styles.chipTextPinned : null]}>
                {pinned ? '★ 已置顶' : '☆ 置顶优先'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setEnabled((prev) => !prev)}
              accessibilityRole="button"
              accessibilityLabel={enabled ? '停用此条记忆注入' : '启用此条记忆注入'}
              style={[styles.chip, enabled ? styles.chipSelected : null]}
            >
              <Text style={[styles.chipText, enabled ? styles.chipTextSelected : null]}>
                {enabled ? '参与注入' : '暂不注入'}
              </Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.input}
            value={key}
            onChangeText={setKey}
            placeholder="名称，例如：回复语言"
            placeholderTextColor={tv.colors.textFaint}
            maxLength={80}
            accessibilityLabel="记忆名称"
          />
          <TextInput
            style={[styles.input, styles.valueInput]}
            value={value}
            onChangeText={setValue}
            placeholder="内容，例如：用中文回答，代码保持英文"
            placeholderTextColor={tv.colors.textFaint}
            maxLength={2000}
            multiline
            accessibilityLabel="记忆内容"
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              onPress={() => void save()}
              disabled={busy || downgradeBlocked}
              accessibilityRole="button"
              accessibilityLabel={editing ? '保存记忆修改' : '保存记忆'}
              style={[styles.primaryBtn, busy || downgradeBlocked ? styles.muted : null]}
            >
              <Text style={styles.primaryText}>
                {busy ? '保存中…' : editing ? '保存修改' : '保存记忆'}
              </Text>
            </Pressable>
            {editing ? (
              <Pressable onPress={reset} style={styles.secondaryBtn}>
                <Text style={styles.secondaryText}>取消编辑</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <Text style={styles.label}>
          已保存（{visibleEntries.length}/{entries.length}）
        </Text>
        <View style={styles.filterWrap}>
          <View style={styles.chipRow}>
            {(['all', ...MEMORY_KINDS] as const).map((option) => {
              const selected = filterKind === option;
              const text = option === 'all' ? '全部' : MEMORY_KIND_LABELS[option];
              return (
                <Pressable
                  key={option}
                  onPress={() => setFilterKind(option)}
                  accessibilityRole="button"
                  accessibilityLabel={`筛选 ${text}`}
                  style={[styles.chip, selected ? styles.chipSelected : null]}
                >
                  <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                    {text}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            style={[styles.input, styles.searchInput]}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="搜索名称或内容…"
            placeholderTextColor={tv.colors.textFaint}
            accessibilityLabel="搜索记忆"
          />
        </View>

        <View style={styles.card}>
          {visibleEntries.length === 0 ? (
            <Text style={styles.hint}>
              {entries.length === 0 ? '还没有记忆。' : '当前筛选条件下没有匹配的记忆。'}
            </Text>
          ) : visibleEntries.map((entry, idx) => {
            const status = budgetView.statusOf(entry.id);
            const entryKind = entry.kind ?? 'fact';
            const statusLabel =
              status === 'disabled'
                ? '已停用'
                : status === 'truncated'
                  ? '超额未注入'
                  : '已注入';
            return (
              <View key={entry.id} style={[styles.row, idx === 0 ? styles.rowFirst : null]}>
                <Pressable
                  onPress={() => {
                    setEditing(entry);
                    setKey(entry.key);
                    setValue(entry.value);
                    setKind(entryKind);
                    setPinned(Boolean(entry.pinned));
                    setEnabled(entry.enabled !== false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`编辑记忆 ${entry.key}`}
                  style={styles.entryBody}
                >
                  <View style={styles.badgeRow}>
                    <View style={styles.tag}>
                      <Text style={styles.tagText}>{MEMORY_KIND_LABELS[entryKind]}</Text>
                    </View>
                    {entry.pinned ? (
                      <View style={[styles.tag, styles.tagPin]}>
                        <Text style={styles.tagPinText}>置顶</Text>
                      </View>
                    ) : null}
                    <View
                      style={[
                        styles.tag,
                        status === 'included'
                          ? styles.tagOk
                          : status === 'truncated'
                            ? styles.tagWarn
                            : styles.tagMuted,
                      ]}
                    >
                      <Text
                        style={[
                          styles.tagText,
                          status === 'included'
                            ? styles.tagOkText
                            : status === 'truncated'
                              ? styles.tagWarnText
                              : null,
                        ]}
                      >
                        {statusLabel}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.entryKey}>{entry.key}</Text>
                  <Text style={styles.entryValue} numberOfLines={4}>{entry.value}</Text>
                </Pressable>
                <View style={styles.rowActions}>
                  <Pressable
                    onPress={() => void toggleFlag(entry, 'pinned')}
                    disabled={busy || downgradeBlocked}
                    accessibilityRole="button"
                    accessibilityLabel={entry.pinned ? `取消置顶 ${entry.key}` : `置顶 ${entry.key}`}
                    style={styles.smallBtn}
                  >
                    <Text style={styles.smallBtnText}>{entry.pinned ? '取消置顶' : '置顶'}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void toggleFlag(entry, 'enabled')}
                    disabled={busy || downgradeBlocked}
                    accessibilityRole="button"
                    accessibilityLabel={entry.enabled === false ? `启用 ${entry.key}` : `停用 ${entry.key}`}
                    style={styles.smallBtn}
                  >
                    <Text style={styles.smallBtnText}>
                      {entry.enabled === false ? '启用' : '停用'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => remove(entry)}
                    disabled={busy || downgradeBlocked}
                    accessibilityRole="button"
                    accessibilityLabel={`删除记忆 ${entry.key}`}
                    style={styles.deleteBtn}
                  >
                    <Text style={styles.deleteText}>删除</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    content: { paddingBottom: tv.space.xxxl },
    notice: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.accentWash,
    },
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
    storageTitle: { color: C.text, fontSize: tv.type.sm, fontWeight: '600', marginBottom: 4 },
    cardTitle: { color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    budgetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: 6,
    },
    budgetMeta: { color: C.textSecondary, fontSize: tv.type.xs },
    budgetTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: C.border,
      overflow: 'hidden',
      marginTop: tv.space.sm,
    },
    budgetFill: { height: '100%', backgroundColor: C.accent },
    budgetFillWarn: { backgroundColor: C.warning },
    budgetHint: { color: C.textTertiary, fontSize: tv.type.micro, marginTop: 6, lineHeight: tv.type.micro * 1.45 },
    label: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      fontWeight: '600',
      letterSpacing: 0.6,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.lg,
      marginBottom: tv.space.xs,
    },
    filterWrap: { marginHorizontal: tv.layout.screenPadding },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: tv.space.sm },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: tv.radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      backgroundColor: C.bg,
    },
    chipSelected: { borderColor: C.accent, backgroundColor: C.accentWash },
    chipPinned: { borderColor: C.warning, backgroundColor: C.warningWash },
    chipText: { color: C.textSecondary, fontSize: tv.type.xs },
    chipTextSelected: { color: C.accent, fontWeight: '600' },
    chipTextPinned: { color: C.warning, fontWeight: '600' },
    input: {
      backgroundColor: C.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      borderRadius: tv.radius.sm,
      color: C.text,
      fontSize: tv.type.sm,
      paddingHorizontal: tv.space.md,
      paddingVertical: 10,
      marginTop: tv.space.sm,
    },
    searchInput: { marginTop: tv.space.sm },
    valueInput: { minHeight: 90, textAlignVertical: 'top' },
    error: { color: C.danger, fontSize: tv.type.xs, marginTop: tv.space.sm },
    actions: { flexDirection: 'row', gap: 8, marginTop: tv.space.md },
    primaryBtn: {
      minHeight: 40,
      paddingHorizontal: 14,
      borderRadius: tv.radius.sm,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    secondaryBtn: {
      minHeight: 40,
      paddingHorizontal: 14,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryText: { color: C.text, fontSize: tv.type.sm },
    muted: { opacity: 0.55 },
    hint: { color: C.textTertiary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5 },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingTop: tv.space.sm,
      marginTop: tv.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    rowFirst: { paddingTop: 0, marginTop: 0, borderTopWidth: 0 },
    entryBody: { flex: 1 },
    badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
    tag: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: tv.radius.xs,
      backgroundColor: C.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    tagPin: { borderColor: C.warning, backgroundColor: C.warningWash },
    tagPinText: { color: C.warning, fontSize: tv.type.micro, fontWeight: '600' },
    tagOk: { borderColor: C.success, backgroundColor: C.successWash },
    tagOkText: { color: C.success },
    tagWarn: { borderColor: C.warning, backgroundColor: C.warningWash },
    tagWarnText: { color: C.warning },
    tagMuted: { opacity: 0.7 },
    tagText: { color: C.textSecondary, fontSize: tv.type.micro },
    entryKey: { color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    entryValue: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 3 },
    rowActions: { alignItems: 'flex-end', gap: 4, marginLeft: tv.space.sm },
    smallBtn: { paddingHorizontal: 8, paddingVertical: 4 },
    smallBtnText: { color: C.accent, fontSize: tv.type.xs },
    deleteBtn: { paddingHorizontal: 8, paddingVertical: 4 },
    deleteText: { color: C.danger, fontSize: tv.type.xs },
  });
}
