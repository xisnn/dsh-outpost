/**
 * 本机运行环境状态卡（P3/P5）。
 *
 * 只展示原生 journal 的真实状态，不伪造「已就绪」：
 *   - 未安装运行包时不提供启动按钮；
 *   - 上次未正常结束时明确要求核对，启动只表示用户看到了这一点；
 *   - stop-unconfirmed 必须先再次停止，不能直接启动下一个任务。
 *
 * 视觉上保持紧凑的状态条：一行状态 + 一行说明 + 行内操作，避免占满首屏。
 */
import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import type { LocalRuntimeView } from './useLocalRuntime';

function shortGeneration(generation: string | null): string {
  return generation ? generation.slice(0, 8) : '—';
}

export function LocalRuntimePanel({
  view,
  onStart,
  onStop,
  onRefresh,
}: {
  view: LocalRuntimeView;
  onStart: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const { supported, snapshot, error, busy } = view;

  if (!supported) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>本机运行不可用</Text>
        <Text style={styles.hint}>当前设备或安装不支持在本机运行管家；电脑模式不受影响。</Text>
      </View>
    );
  }

  if (!snapshot) {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          {error ? null : <ActivityIndicator size="small" color={tv.colors.textTertiary} />}
          <Text style={[styles.title, styles.headerTitle, error ? null : styles.spinnerTitle]}>
            {error ? '暂时读不到本机运行环境' : '正在读取本机运行环境…'}
          </Text>
        </View>
        {error ? <Text style={styles.code}>{error}</Text> : null}
        {error ? (
          <View style={styles.actions}>
            <Pressable
              onPress={onRefresh}
              disabled={busy}
              style={[styles.secondaryBtn, busy ? styles.muted : null]}
              accessibilityRole="button"
              accessibilityLabel="重试读取本机运行环境"
            >
              <Text style={styles.secondaryText}>{busy ? '重试中…' : '重试'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  const version = snapshot.installed?.version ? ` · ${snapshot.installed.version}` : '';
  const phase = snapshot.phase;
  const generation = snapshot.generation ? `${shortGeneration(snapshot.generation)}${version}` : '';

  if (phase === 'starting' || phase === 'stopping') {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <ActivityIndicator size="small" color={tv.colors.accent} />
          <Text style={[styles.title, styles.headerTitle, styles.spinnerTitle]}>
            {phase === 'starting' ? '正在启动本机运行环境…' : '正在停止本机运行环境…'}
          </Text>
          {generation ? <Text style={styles.meta}>{generation}</Text> : null}
        </View>
        <Text style={styles.hint}>启动和停止需要原生服务完成，期间不要创建任务。</Text>
        <View style={styles.actions}>
          <Pressable
            onPress={onRefresh}
            disabled={busy}
            style={styles.linkBtn}
            accessibilityRole="button"
            accessibilityLabel="刷新本机运行环境状态"
          >
            <Text style={styles.linkText}>刷新</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (phase === 'running') {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.dotOn} />
          <Text style={[styles.title, styles.headerTitle]}>本机运行中</Text>
          <Text style={styles.meta}>{generation}</Text>
        </View>
        <Text style={styles.hint}>
          {snapshot.lastHeartbeatElapsedMs !== undefined
            ? `心跳 ${Math.max(0, Math.round(snapshot.lastHeartbeatElapsedMs / 1000))} 秒前`
            : '任务在手机上执行；电脑模式仍可随时切回。'}
        </Text>
        <View style={styles.actions}>
          <Pressable
            onPress={onStop}
            disabled={busy}
            style={[styles.secondaryBtn, busy ? styles.muted : null]}
            accessibilityRole="button"
            accessibilityLabel="停止本机运行环境"
          >
            <Text style={styles.secondaryText}>{busy ? '正在停止…' : '停止运行环境'}</Text>
          </Pressable>
          <Pressable
            onPress={onRefresh}
            disabled={busy}
            style={styles.linkBtn}
            accessibilityRole="button"
            accessibilityLabel="刷新本机运行环境状态"
          >
            <Text style={styles.linkText}>刷新</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const notInstalled = snapshot.installed?.installed === false;
  const unconfirmed = phase === 'stop-unconfirmed';
  const crashed = phase === 'interrupted';
  // Every clean stop still requires an acknowledged generation on the next
  // start. That is a normal stopped state, not a crash; keep the copy distinct.
  const needsAck = !crashed && !unconfirmed && snapshot.requiresReconciliation;
  const dotColor = unconfirmed || crashed ? tv.colors.warning : tv.colors.textTertiary;
  const title = unconfirmed
    ? '上次停止尚未确认'
    : crashed
      ? '上次运行未正常结束'
      : notInstalled
        ? '本机运行包未安装'
        : needsAck
          ? '本机运行环境已停止'
          : '本机运行环境已就绪';
  const hint = unconfirmed
    ? '请先再次停止，确认没有遗留进程；确认前不能启动新任务。'
    : crashed
      ? '启动只表示你已看到上次的未核对状态；旧任务、旧审批和旧队列都不会自动恢复。'
      : notInstalled
        ? '本机运行包尚未安装；导入后才能启动，不会从网络自动下载。'
        : needsAck
          ? '上次已停止；启动需要确认未核对状态，旧任务和审批不会自动恢复。'
          : '任务会在手机上由本机 DSH 执行，电脑模式仍可随时切回。';

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={[styles.title, styles.headerTitle, unconfirmed || crashed ? styles.warnTitle : null]}>
          {title}
        </Text>
        {generation ? <Text style={styles.meta}>{generation}</Text> : null}
      </View>
      <Text style={styles.hint} numberOfLines={2}>{hint}</Text>
      {error ? <Text style={styles.code}>{error}</Text> : null}
      <View style={styles.actions}>
        {unconfirmed ? (
          <Pressable
            onPress={onStop}
            disabled={busy}
            style={[styles.primaryBtn, busy ? styles.muted : null]}
            accessibilityRole="button"
            accessibilityLabel="再次停止并确认清理"
          >
            <Text style={styles.primaryText}>{busy ? '正在确认…' : '再次停止'}</Text>
          </Pressable>
        ) : notInstalled ? (
          view.distributions.length > 0 ? (
            <Pressable
              onPress={() => void view.importPackage()}
              disabled={busy}
              style={[styles.primaryBtn, busy ? styles.muted : null]}
              accessibilityRole="button"
              accessibilityLabel="导入运行包"
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.primaryText}>
                {busy ? '正在安装…' : `导入运行包 ${view.distributions[0].version ?? ''}`.trim()}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.hint}>当前安装未包含运行包描述，无法导入。</Text>
          )
        ) : (
          <Pressable
            onPress={onStart}
            disabled={busy}
            style={[styles.primaryBtn, busy ? styles.muted : null]}
            accessibilityRole="button"
            accessibilityLabel="启动本机运行环境"
            accessibilityState={{ disabled: busy }}
          >
            <Text style={styles.primaryText}>{busy ? '正在启动…' : '启动本机运行环境'}</Text>
          </Pressable>
        )}
        <Pressable
          onPress={onRefresh}
          disabled={busy}
          style={styles.linkBtn}
          accessibilityRole="button"
          accessibilityLabel="刷新本机运行环境状态"
        >
          <Text style={styles.linkText}>刷新</Text>
        </Pressable>
      </View>
      {(crashed || unconfirmed) && snapshot.reason ? (
        <Text style={styles.metaLine}>状态原因 {snapshot.reason}</Text>
      ) : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    card: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.sm,
      marginBottom: tv.space.sm,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.itemGap,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    header: { flexDirection: 'row', alignItems: 'center' },
    headerTitle: { flexShrink: 1 },
    spinnerTitle: { marginLeft: tv.space.sm },
    dot: { width: 8, height: 8, borderRadius: 4, marginRight: tv.space.sm },
    dotOn: { width: 8, height: 8, borderRadius: 4, marginRight: tv.space.sm, backgroundColor: C.success },
    title: { color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    warnTitle: { color: C.warning },
    meta: { marginLeft: 'auto', paddingLeft: tv.space.sm, color: C.textFaint, fontSize: tv.type.micro },
    hint: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.xs },
    code: { color: C.danger, fontSize: tv.type.micro, marginTop: 4 },
    actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: tv.space.sm, marginTop: tv.space.itemGap },
    primaryBtn: {
      backgroundColor: C.accent,
      borderRadius: tv.radius.sm,
      alignSelf: 'flex-start',
      paddingHorizontal: 14,
      minHeight: 36,
      justifyContent: 'center',
    },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    secondaryBtn: {
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignSelf: 'flex-start',
      paddingHorizontal: 12,
      minHeight: 36,
      justifyContent: 'center',
    },
    secondaryText: { color: C.textSecondary, fontSize: tv.type.sm },
    linkBtn: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 4 },
    linkText: { color: C.textTertiary, fontSize: tv.type.xs },
    muted: { opacity: 0.55 },
    metaLine: { color: C.textFaint, fontSize: tv.type.micro, marginTop: tv.space.sm },
  });
}
