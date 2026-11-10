/**
 * 管家身份与用户记忆（P4）。
 *
 * 位置绑定：电脑记忆来自已配对 Host；本机记忆来自本机运行包里的 butler。
 * 两边不合并、不缓存到另一边。只允许用户显式新增/修改/删除；不自动提取，
 * 不参与审批或工具权限（记忆页没有任何授权开关）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useApp } from '../App';
import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { LocalRuntimePanel } from '../components/LocalRuntimePanel';
import { SlideSegmented } from '../components/SlideSegmented';
import { SectionLabel } from '../components/ui';
import { useLocalRuntime } from '../components/useLocalRuntime';
import { useTheme } from '../design/theme';
import {
  DesktopMemoryClient,
  LocalMemoryClient,
  type ButlerMemoryChange,
  type ButlerMemoryClient,
  type ButlerMemoryEntry,
  type ButlerMemorySnapshot,
  type MemoryKind,
} from '../core/butlerMemory';

const KIND_LABEL: Record<MemoryKind, string> = { preference: '偏好', project: '项目事实' };

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/memory-unavailable/i.test(text)) return '这次运行的管家版本还不支持记忆。';
  if (/memory-conflict/i.test(text)) return '这条记忆刚被修改，请刷新后再试。';
  if (/memory-full/i.test(text)) return '记忆数量已达上限，请先删除一些。';
  if (/memory-key-conflict/i.test(text)) return '同一类别里已经有这个名称。';
  if (/RUNTIME_NOT_RUNNING|RUNTIME_STARTING/i.test(text)) return '本机运行环境没有启动。';
  if (/401|403|forbidden/i.test(text)) return '没有权限读取这个位置的记忆。';
  return text || '暂时无法完成这个操作。';
}

function timeText(ms: number): string {
  try { return new Date(ms).toLocaleString(); } catch { return ''; }
}

interface EditState {
  id?: string;
  kind: MemoryKind;
  key: string;
  value: string;
  expectedRevision?: number;
}

function EntryRow({
  entry,
  styles,
  onEdit,
  onDelete,
  last = false,
}: {
  entry: ButlerMemoryEntry;
  styles: ReturnType<typeof makeStyles>;
  onEdit: (entry: ButlerMemoryEntry) => void;
  onDelete: (entry: ButlerMemoryEntry) => void;
  last?: boolean;
}) {
  return (
    <View style={[styles.entryRow, last ? styles.entryRowLast : null]}>
      <Pressable
        onPress={() => onEdit(entry)}
        accessibilityRole="button"
        accessibilityLabel={`编辑记忆 ${entry.key}`}
        style={styles.entryBody}
      >
        <Text style={styles.entryKey}>{entry.key}</Text>
        <Text style={styles.entryValue} numberOfLines={4}>{entry.value}</Text>
        <Text style={styles.entryMeta}>更新于 {timeText(entry.updatedAt)} · revision {entry.revision}</Text>
      </Pressable>
      <Pressable
        onPress={() => onDelete(entry)}
        accessibilityRole="button"
        accessibilityLabel={`删除记忆 ${entry.key}`}
        style={styles.deleteBtn}
      >
        <Text style={styles.deleteText}>删除</Text>
      </Pressable>
    </View>
  );
}

export function ButlerMemoryScreen({ active = true }: { active?: boolean }) {
  const { store, location } = useApp();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const runtime = useLocalRuntime(active && location === 'local');
  const client = useMemo<ButlerMemoryClient>(
    () => location === 'local' ? new LocalMemoryClient(runtime.client) : new DesktopMemoryClient(store),
    [location, runtime.client, store],
  );
  const ready = location === 'desktop' || runtime.snapshot?.phase === 'running';
  const [snapshot, setSnapshot] = useState<ButlerMemorySnapshot | null>(null);
  const [history, setHistory] = useState<ButlerMemoryChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);

  const load = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      const [next, changes] = await Promise.all([client.load(), client.history()]);
      if (location === client.location) {
        setSnapshot(next);
        setHistory(changes);
        setError(null);
      }
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setLoading(false);
    }
  }, [client, location, ready]);

  useEffect(() => {
    if (!active || !ready) return;
    void load();
  }, [active, load, ready]);

  // A location switch must never show the other host's memory while loading.
  useEffect(() => {
    setSnapshot(null);
    setHistory([]);
    setEditing(null);
    setError(null);
  }, [location]);

  const beginAdd = useCallback(() => {
    setEditing({ kind: 'preference', key: '', value: '' });
  }, []);

  const beginEdit = useCallback((entry: ButlerMemoryEntry) => {
    setEditing({ id: entry.id, kind: entry.kind, key: entry.key, value: entry.value, expectedRevision: entry.revision });
  }, []);

  const save = useCallback(async () => {
    if (!editing || busy) return;
    const key = editing.key.trim();
    const value = editing.value.trim();
    if (!key || !value) { setError('名称和内容都不能为空。'); return; }
    setBusy(true);
    setError(null);
    try {
      await client.set({
        ...(editing.id ? { id: editing.id } : {}),
        kind: editing.kind,
        key,
        value,
        ...(editing.expectedRevision === undefined ? {} : { expectedRevision: editing.expectedRevision }),
      });
      setEditing(null);
      await load();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  }, [busy, client, editing, load]);

  const remove = useCallback((entry: ButlerMemoryEntry) => {
    Alert.alert('删除这条记忆？', `「${entry.key}」会从${location === 'local' ? '本机' : '电脑'}管家的记忆中删除。`, [
      { text: '再想想', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          setError(null);
          void client.remove(entry.id, entry.revision)
            .then(() => load())
            .catch(failure => setError(messageOf(failure)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  }, [client, load, location]);

  const target = location === 'local' ? '本机' : '电脑';
  const preferences = snapshot?.entries.filter(entry => entry.kind === 'preference') ?? [];
  const projects = snapshot?.entries.filter(entry => entry.kind === 'project') ?? [];

  return (
    <View style={styles.root}>
      <Header title="管家记忆" subtitle={`${target}管家`} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {location === 'local' && !ready ? (
          <>
            <Text style={styles.notice}>
              本机记忆保存在本机管家自己的存储里。启动本机运行环境后才能读取或修改；电脑记忆不会出现在这里。
            </Text>
            <LocalRuntimePanel
              view={runtime}
              onStart={() => void runtime.start()}
              onStop={() => void runtime.stop()}
              onRefresh={() => void runtime.refresh()}
            />
          </>
        ) : (
          <>
            <View style={styles.identityCard}>
              <Text style={styles.identityLabel}>执行位置</Text>
              <Text style={styles.identityValue}>{target}管家</Text>
              <Text style={styles.identityLabel}>butlerId</Text>
              <Text style={styles.identityValue} selectable>{snapshot?.butlerId ?? '读取中…'}</Text>
              <Text style={styles.hint}>
                记忆只记录你明确保存的偏好与项目事实，不会改变任务状态、审批要求或授予任何工具权限。
              </Text>
            </View>

            {error ? (
              <Pressable onPress={() => setError(null)} accessibilityRole="button" accessibilityLabel="关闭记忆错误">
                <Text style={styles.error}>{error}</Text>
              </Pressable>
            ) : null}

            {editing ? (
              <View style={styles.editCard}>
                <Text style={styles.editTitle}>{editing.id ? '修改记忆' : '新增记忆'}</Text>
                <SlideSegmented<MemoryKind>
                  options={[{ value: 'preference', label: '偏好' }, { value: 'project', label: '项目事实' }]}
                  value={editing.kind}
                  onChange={kind => setEditing(current => current ? { ...current, kind } : current)}
                  accessibilityLabel="记忆类别"
                />
                <Text style={styles.fieldLabel}>名称</Text>
                <TextInput
                  value={editing.key}
                  onChangeText={key => setEditing(current => current ? { ...current, key } : current)}
                  maxLength={64}
                  placeholder="例如：回答风格 / 仓库约定"
                  placeholderTextColor={tv.colors.textFaint}
                  style={styles.input}
                />
                <Text style={styles.fieldLabel}>内容</Text>
                <TextInput
                  value={editing.value}
                  onChangeText={value => setEditing(current => current ? { ...current, value } : current)}
                  maxLength={2048}
                  multiline
                  textAlignVertical="top"
                  placeholder="只写你希望管家长期记住的内容"
                  placeholderTextColor={tv.colors.textFaint}
                  style={[styles.input, styles.valueInput]}
                />
                <View style={styles.formActions}>
                  <Pressable
                    onPress={() => void save()}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="保存记忆"
                    style={[styles.primaryBtn, busy ? styles.muted : null]}
                  >
                    <Text style={styles.primaryText}>{busy ? '保存中…' : '保存'}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setEditing(null)}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel="取消编辑记忆"
                    style={styles.secondaryBtn}
                  >
                    <Text style={styles.secondaryText}>取消</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={beginAdd}
                accessibilityRole="button"
                accessibilityLabel="新增记忆"
                style={styles.addBtn}
              >
                <Text style={styles.addText}>＋ 新增记忆</Text>
              </Pressable>
            )}

            <SectionLabel text="偏好" />
            <View style={styles.card}>
              {preferences.length === 0 ? <Text style={styles.empty}>还没有保存的偏好</Text> : preferences.map((entry, index) => (
                <EntryRow key={entry.id} entry={entry} styles={styles} onEdit={beginEdit} onDelete={remove} last={index === preferences.length - 1} />
              ))}
            </View>

            <SectionLabel text="项目事实" />
            <View style={styles.card}>
              {projects.length === 0 ? <Text style={styles.empty}>还没有保存的项目事实</Text> : projects.map((entry, index) => (
                <EntryRow key={entry.id} entry={entry} styles={styles} onEdit={beginEdit} onDelete={remove} last={index === projects.length - 1} />
              ))}
            </View>

            <SectionLabel text="变更记录" />
            <View style={styles.card}>
              {history.length === 0 ? <Text style={styles.empty}>还没有变更</Text> : history.slice(-12).reverse().map(change => (
                <Text key={change.seq} style={styles.historyRow}>
                  {change.action === 'set' ? '保存' : '删除'} · {change.key ?? change.id.slice(0, 12)} · {timeText(change.at)}
                </Text>
              ))}
            </View>

            <Pressable
              onPress={() => void load()}
              disabled={loading || busy}
              accessibilityRole="button"
              accessibilityLabel="刷新管家记忆"
              style={styles.refreshBtn}
            >
              <Text style={styles.secondaryText}>{loading ? '刷新中…' : '刷新'}</Text>
            </Pressable>
          </>
        )}
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
    },
    identityCard: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    identityLabel: { color: C.textTertiary, fontSize: tv.type.micro, letterSpacing: 0.5, marginTop: tv.space.sm },
    identityValue: { color: C.text, fontSize: tv.type.sm, marginTop: 2 },
    hint: { color: C.textTertiary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.md },
    error: { color: C.danger, fontSize: tv.type.xs, marginHorizontal: tv.layout.screenPadding, marginTop: tv.space.sm },
    addBtn: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
      minHeight: 44,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addText: { color: C.accent, fontSize: tv.type.sm, fontWeight: '600' },
    editCard: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.accentDim,
    },
    editTitle: { color: C.text, fontSize: tv.type.base, fontWeight: '600', marginBottom: tv.space.sm },
    fieldLabel: { color: C.textTertiary, fontSize: tv.type.micro, marginTop: tv.space.md, marginBottom: 4 },
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
    valueInput: { minHeight: 96 },
    formActions: { flexDirection: 'row', gap: 8, marginTop: tv.space.md },
    primaryBtn: {
      minHeight: 44, paddingHorizontal: 16, borderRadius: tv.radius.sm,
      backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center',
    },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    secondaryBtn: {
      minHeight: 44, paddingHorizontal: 16, borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth, borderColor: C.border,
      alignItems: 'center', justifyContent: 'center',
    },
    secondaryText: { color: C.text, fontSize: tv.type.sm },
    muted: { opacity: 0.55 },
    card: {
      marginHorizontal: tv.layout.screenPadding,
      paddingHorizontal: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    entryRow: { flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
    entryRowLast: { borderBottomWidth: 0 },
    entryBody: { flex: 1, paddingVertical: tv.space.sm },
    entryKey: { color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    entryValue: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 2 },
    entryMeta: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 4 },
    deleteBtn: { minHeight: 44, minWidth: 52, alignItems: 'center', justifyContent: 'center' },
    deleteText: { color: C.danger, fontSize: tv.type.xs },
    empty: { color: C.textFaint, fontSize: tv.type.xs, paddingVertical: tv.space.md },
    historyRow: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.8 },
    refreshBtn: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.lg,
      minHeight: 44,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
