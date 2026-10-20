/**
 * 新建工作区弹层。
 *
 * 为什么只能手输路径（而不是原生目录浏览器）：
 * DSH 的目录浏览能力（listDirectory）只在桌面端进程内暴露，
 * 没有对应的 HTTP RPC 端点；而 `GET /api/file` 明确拒绝目录
 * （返回 FS_NOT_REGULAR_FILE）。所以手机上拿不到目录列表。
 *
 * 折中做法：
 *   1. 手输路径 + **创建时校验**（目录不存在会明确提示）
 *   2. 记住最近成功用过的路径，下次一点就能填
 *   3. 顺便列出电脑上已有工作区的同级目录，方便「在同一个父目录下加一个」
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from '../design/theme';
import { space } from '../design/tokens';
import { DirectoryBrowser } from './DirectoryBrowser';

export function NewWorkspaceSheet({
  visible,
  existingPaths,
  recentPaths,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  visible: boolean;
  /** 电脑上已有工作区的路径，用来提示「同级目录」 */
  existingPaths: string[];
  /** 最近成功创建的路径 */
  recentPaths: string[];
  busy: boolean;
  /** 上一次提交的错误（目录不存在等） */
  error?: string;
  onSubmit: (path: string) => void;
  onClose: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [value, setValue] = useState('');
  const [browsing, setBrowsing] = useState(false);

  // 每次打开清空，避免上次的残留
  useEffect(() => {
    if (visible) setValue('');
  }, [visible]);

  const pick = useCallback((p: string) => setValue(p), []);

  // 已有工作区的父目录，作为「常见位置」提示
  const parents = useMemo(() => {
    const set = new Set<string>();
    for (const p of existingPaths) {
      const m = /^(.*)\\[^\\]+$/.exec(p);
      if (m && m[1]) set.add(m[1]);
    }
    return [...set].slice(0, 3);
  }, [existingPaths]);

  if (!visible) return null;

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.center}
        pointerEvents="box-none"
      >
        <View style={styles.card}>
          <Text style={styles.title}>新建工作区</Text>
          <Text style={styles.hint}>
            选一个电脑上的文件夹。也可以直接输入路径，或在这里新建文件夹。
          </Text>

          {/* 路径输入 + 浏览按钮 */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={value}
              onChangeText={setValue}
              placeholder="E:\work\my-project"
              placeholderTextColor={tv.colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              returnKeyType="done"
              onSubmitEditing={() => value.trim() && onSubmit(value)}
            />
            <Pressable
              onPress={() => setBrowsing(true)}
              disabled={busy}
              style={({ pressed }: { pressed: boolean }) => [
                styles.browseBtn,
                pressed ? { opacity: 0.7 } : null,
              ]}
              accessibilityRole="button"
              accessibilityLabel="浏览电脑目录"
            >
              <Text style={styles.browseText}>浏览</Text>
            </Pressable>
          </View>

          {/* 目录浏览器 */}
          <DirectoryBrowser
            visible={browsing}
            initialPath={value.trim() || undefined}
            onPick={(p) => {
              setValue(p);
              setBrowsing(false);
            }}
            onClose={() => setBrowsing(false)}
          />

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* 最近用过 */}
          {recentPaths.length > 0 ? (
            <View style={styles.suggestWrap}>
              <Text style={styles.suggestLabel}>最近用过</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {recentPaths.map((p) => (
                  <Pressable
                    key={p}
                    onPress={() => pick(p)}
                    style={({ pressed }: { pressed: boolean }) => [
                      styles.chip,
                      pressed ? { opacity: 0.6 } : null,
                    ]}
                  >
                    <Text style={styles.chipText} numberOfLines={1}>
                      {p}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {/* 已有工作区的父目录 */}
          {parents.length > 0 ? (
            <View style={styles.suggestWrap}>
              <Text style={styles.suggestLabel}>同级位置</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {parents.map((p) => (
                  <Pressable
                    key={p}
                    onPress={() => pick(`${p}\\`)}
                    style={({ pressed }: { pressed: boolean }) => [
                      styles.chip,
                      pressed ? { opacity: 0.6 } : null,
                    ]}
                  >
                    <Text style={styles.chipText} numberOfLines={1}>
                      {p}\
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          <View style={styles.footer}>
            <Pressable
              onPress={onClose}
              disabled={busy}
              style={({ pressed }: { pressed: boolean }) => [
                styles.btn,
                styles.btnGhost,
                pressed ? { opacity: 0.6 } : null,
              ]}
            >
              <Text style={styles.btnGhostText}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => value.trim() && onSubmit(value)}
              disabled={busy || !value.trim()}
              style={({ pressed }: { pressed: boolean }) => [
                styles.btn,
                styles.btnPrimary,
                (busy || !value.trim()) && styles.btnDisabled,
                pressed ? { opacity: 0.8 } : null,
              ]}
            >
              {busy ? (
                <ActivityIndicator size="small" color={tv.colors.onAccent} />
              ) : (
                <Text style={styles.btnPrimaryText}>创建</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: C.scrim,
      justifyContent: 'center',
      alignItems: 'center',
    },
    center: { width: '100%', alignItems: 'center', paddingHorizontal: space.lg },
    card: {
      width: '100%',
      maxWidth: 460,
      backgroundColor: C.bgRaised,
      borderRadius: tv.radius.lg,
      padding: space.lg,
    },
    title: { color: C.text, fontSize: tv.type.lg, fontWeight: tv.weight.semibold },
    hint: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      marginTop: space.xs,
      marginBottom: space.md,
    },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    browseBtn: {
      paddingHorizontal: space.md,
      paddingVertical: space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
    },
    browseText: { color: C.accentBright, fontSize: tv.type.sm },
    input: {
      backgroundColor: C.bgCard,
      borderRadius: tv.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      paddingHorizontal: space.md,
      paddingVertical: space.md,
      color: C.text,
      fontSize: tv.type.sm,
    },
    errorBox: {
      marginTop: space.sm,
      padding: space.sm,
      borderRadius: tv.radius.sm,
      backgroundColor: C.dangerWash,
    },
    errorText: { color: C.danger, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5 },
    suggestWrap: { marginTop: space.md },
    suggestLabel: { color: C.textFaint, fontSize: tv.type.micro, marginBottom: space.xs },
    chip: {
      paddingHorizontal: space.sm,
      paddingVertical: 6,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgCard,
      marginRight: space.xs,
      maxWidth: 220,
    },
    chipText: { color: C.textSecondary, fontSize: tv.type.micro },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: space.lg,
      gap: space.sm,
    },
    btn: {
      minWidth: 84,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderRadius: tv.radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnGhost: { backgroundColor: C.bgCard },
    btnGhostText: { color: C.textSecondary, fontSize: tv.type.sm },
    btnPrimary: { backgroundColor: C.accent },
    btnPrimaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: tv.weight.semibold },
    btnDisabled: { opacity: 0.45 },
  });
}
