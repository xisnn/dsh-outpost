/**
 * P6 本机 Agent 的显式用户记忆。只接受用户主动保存的 key/value，不会自动
 * 从聊天或屏幕提取；记忆会以“用户数据”附加到本机 Agent 的系统提示词。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { useTheme } from '../design/theme';
import { agentClient, type AgentMemoryEntry } from '../core/agent';

export function AgentMemoryScreen({ active = true }: { active?: boolean }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [entries, setEntries] = useState<AgentMemoryEntry[]>([]);
  const [editing, setEditing] = useState<AgentMemoryEntry | null>(null);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await agentClient.getMemory());
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
  };

  const save = useCallback(async () => {
    if (!key.trim() || !value.trim()) {
      setError('名称和内容都不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await agentClient.saveMemory(editing?.id ?? null, key.trim(), value.trim());
      reset();
      await load();
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, [editing, key, load, value]);

  const remove = useCallback((entry: AgentMemoryEntry) => {
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
  }, [load]);

  return (
    <View style={styles.root}>
      <Header title="管家记忆" subtitle="本机 Agent" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.notice}>
          只保存你主动写下的偏好和项目事实；不会从聊天、屏幕或工具结果自动提取。
          这些内容会作为用户数据附加到本机 Agent 的提示词，可能发送给你配置的模型服务商。
        </Text>

        <View style={styles.card}>
          <Text style={styles.label}>{editing ? '编辑记忆' : '新增记忆'}</Text>
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
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={editing ? '保存记忆修改' : '保存记忆'}
              style={[styles.primaryBtn, busy ? styles.muted : null]}
            >
              <Text style={styles.primaryText}>{busy ? '保存中…' : editing ? '保存修改' : '保存记忆'}</Text>
            </Pressable>
            {editing ? (
              <Pressable onPress={reset} style={styles.secondaryBtn}>
                <Text style={styles.secondaryText}>取消编辑</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <Text style={styles.label}>已保存（{entries.length}）</Text>
        <View style={styles.card}>
          {entries.length === 0 ? (
            <Text style={styles.hint}>还没有记忆。</Text>
          ) : entries.map((entry) => (
            <View key={entry.id} style={styles.row}>
              <Pressable
                onPress={() => {
                  setEditing(entry);
                  setKey(entry.key);
                  setValue(entry.value);
                }}
                accessibilityRole="button"
                accessibilityLabel={`编辑记忆 ${entry.key}`}
                style={styles.entryBody}
              >
                <Text style={styles.entryKey}>{entry.key}</Text>
                <Text style={styles.entryValue} numberOfLines={4}>{entry.value}</Text>
              </Pressable>
              <Pressable
                onPress={() => remove(entry)}
                accessibilityRole="button"
                accessibilityLabel={`删除记忆 ${entry.key}`}
                style={styles.deleteBtn}
              >
                <Text style={styles.deleteText}>删除</Text>
              </Pressable>
            </View>
          ))}
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
    label: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      fontWeight: '600',
      letterSpacing: 0.6,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.lg,
      marginBottom: tv.space.sm,
    },
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
    entryBody: { flex: 1 },
    entryKey: { color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    entryValue: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 3 },
    deleteBtn: { paddingHorizontal: 8, paddingVertical: 4, marginLeft: tv.space.sm },
    deleteText: { color: C.danger, fontSize: tv.type.xs },
  });
}
