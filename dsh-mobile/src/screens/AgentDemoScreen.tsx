/**
 * P6-0 内核自检页：验证 native AgentService 拥有 Run、RN 只读状态、
 * 审批在执行入口阻塞、RunStore 持久化。模型是固定演示模型。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import {
  agentClient,
  APPROVAL_BACKGROUND_LOST_TEXT,
  isApprovalAllowBlocked,
  PROTOCOL_LABELS,
  type AgentModelSettings,
  type AgentSnapshot,
  type PhoneCapabilities,
} from '../core/agent';

const PHASE_TEXT: Record<AgentSnapshot['phase'], string> = {
  idle: '未运行',
  queued: '已排队',
  preparing: '准备中',
  running: '运行中',
  waiting_user: '等待审批',
  stopping: '停止中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

export function AgentDemoScreen({ active = true }: { active?: boolean }) {
  const tv = useTheme();
  const nav = useNav();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [settings, setSettings] = useState<AgentModelSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [phone, setPhone] = useState<PhoneCapabilities | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [goal, setGoal] = useState('读取 input.txt，然后告诉我里面有什么。');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await agentClient.snapshot();
      setSnapshot(next);
      setError(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await agentClient.getModelSettings());
      setSettingsError(null);
    } catch (failure) {
      setSettingsError(String((failure as Error)?.message ?? failure));
    }
    try {
      setPhone(await agentClient.getPhoneCapabilities());
      setPhoneError(null);
    } catch (failure) {
      setPhoneError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshSettings();
  }, [active, refreshSettings]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        if (stopped) return;
        void refresh().finally(() => { if (!stopped) schedule(); });
      }, 500);
    };
    void refresh().finally(() => { if (!stopped) schedule(); });
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, refresh]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await agentClient.startDemo());
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const runCloud = useCallback(async () => {
    setCloudBusy(true);
    setError(null);
    try {
      setSnapshot(await agentClient.startCloud(goal));
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setCloudBusy(false);
    }
  }, [goal]);

  const confirmCloud = useCallback(() => {
    if (!settings?.hasKey || !settings.model) return;
    if (!goal.trim()) {
      setError('请先填写云端任务');
      return;
    }
    Alert.alert(
      '运行云端任务？',
      `将把任务、工作区工具结果发送给 ${PROTOCOL_LABELS[settings.protocol]}（${settings.model}），可能产生费用。\nAPI Key 仍只保存在本机。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '继续', onPress: () => void runCloud() },
      ],
    );
  }, [goal, runCloud, settings]);

  const togglePause = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(snapshot?.paused ? await agentClient.resume() : await agentClient.pause());
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, [snapshot?.paused]);

  const stopRun = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await agentClient.stop());
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const dismissRecovery = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await agentClient.dismissRecovery());
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const resumeHandoff = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await agentClient.resumeHandoff());
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const decide = useCallback(async (allow: boolean) => {
    const pending = snapshot?.pendingApproval;
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await agentClient.decide(pending.callId, allow));
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, [snapshot]);

  const phase = snapshot?.phase ?? 'idle';
  const running = phase === 'queued' || phase === 'preparing' || phase === 'running' || phase === 'waiting_user';
  const pending = snapshot?.pendingApproval ?? null;
  const allowBlocked = isApprovalAllowBlocked(pending);
  const pendingHandoff = snapshot?.pendingHandoff ?? null;
  const recovery = snapshot?.recovery ?? null;
  const paused = snapshot?.paused ?? false;

  return (
    <View style={styles.root}>
      <Header
        title="Agent 内核"
        subtitle="P6-1 云端模型"
        right={
          <Pressable
            onPress={() => nav.push('AgentSettings')}
            accessibilityRole="button"
            accessibilityLabel="打开模型与凭据设置"
            hitSlop={10}
          >
            <Text style={styles.headerAction}>模型</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.notice}>
          纯 Kotlin Agent 内核竖切：读取 input.txt → 请求写入审批 → 写入 p6-demo-output.txt。
          演示使用固定模型；云端模型在「模型」里配置，运行前会再次确认。
        </Text>

        {recovery ? (
          <View style={[styles.card, styles.recoveryCard]}>
            <Text style={styles.title}>上次任务中断</Text>
            <Text style={styles.body}>{recovery.reason ?? '进程中断，任务没有恢复。'}</Text>
            <Text style={styles.hint}>
              旧审批已失效，不会自动复活或重放。{recovery.requiresReconciliation
                ? ' 崩溃时可能正在执行有副作用的工具，结果未知；请先确认手机/文件状态。'
                : ' 这次没有未知副作用记录。'}
            </Text>
            <Text style={styles.meta}>
              {recovery.runId.slice(0, 8)}{recovery.lastToolName ? ` · ${recovery.lastToolName}` : ''}
            </Text>
            <View style={styles.actions}>
              <Pressable
                onPress={() => void dismissRecovery()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="知道了"
                style={[styles.secondaryBtn, busy ? styles.muted : null]}
              >
                <Text style={styles.secondaryText}>知道了</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.dot, { backgroundColor: running ? tv.colors.warning : tv.colors.textTertiary }]} />
            <Text style={styles.title}>{PHASE_TEXT[phase]}</Text>
            {snapshot?.runId ? <Text style={styles.meta}>{snapshot.runId.slice(0, 8)}</Text> : null}
          </View>
          <Text style={styles.hint}>step {snapshot?.step ?? 0}{snapshot?.error ? ` · ${snapshot.error}` : ''}</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              onPress={() => void start()}
              disabled={busy || running}
              accessibilityRole="button"
              accessibilityLabel="运行 P6 演示"
              accessibilityState={{ disabled: busy || running }}
              style={[styles.primaryBtn, busy || running ? styles.muted : null]}
            >
              <Text style={styles.primaryText}>{busy ? '处理中…' : running ? '运行中…' : '运行 P6 演示'}</Text>
            </Pressable>
            {running ? (
              <Pressable
                onPress={() => void togglePause()}
                disabled={busy || pending !== null || pendingHandoff !== null}
                accessibilityRole="button"
                accessibilityLabel={paused ? '继续运行' : '暂停运行'}
                style={[styles.secondaryBtn, busy ? styles.muted : null]}
              >
                <Text style={styles.secondaryText}>{paused ? '继续' : '暂停'}</Text>
              </Pressable>
            ) : null}
            {running ? (
              <Pressable
                onPress={() => void stopRun()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="停止任务"
                style={[styles.dangerBtn, busy ? styles.muted : null]}
              >
                <Text style={styles.dangerText}>停止</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <View
              style={[
                styles.dot,
                { backgroundColor: settings?.hasKey && settings.model ? tv.colors.success : tv.colors.textTertiary },
              ]}
            />
            <Text style={styles.title}>云端模型</Text>
            <Text style={styles.meta}>
              {settings ? PROTOCOL_LABELS[settings.protocol] : '读取中'}
            </Text>
          </View>
          <Text style={styles.hint}>
            {settings?.model
              ? `${settings.model} · ${settings.baseUrl}`
              : '尚未配置模型；API Key 保存在本机 Android Keystore。'}
          </Text>
          <Text style={styles.hint}>
            手机能力：
            {phone
              ? phone.supported
                ? `${phone.accessibilityConnected ? '无障碍已连接' : '无障碍未连接'} · ${phone.overlayAllowed ? '悬浮条已授权' : '悬浮条未授权'}`
                : '当前系统版本不支持手机控制'
              : '检测中'}
          </Text>
          {phoneError ? <Text style={styles.error}>{phoneError}</Text> : null}
          {settingsError ? <Text style={styles.error}>{settingsError}</Text> : null}
          {settings?.hasKey && settings.model ? (
            <>
              <Text style={styles.label}>云端任务</Text>
              <TextInput
                style={styles.goalInput}
                value={goal}
                onChangeText={setGoal}
                placeholder="例如：读取 input.txt，然后总结内容"
                placeholderTextColor={tv.colors.textFaint}
                multiline
                accessibilityLabel="云端任务"
              />
            </>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              onPress={() => nav.push('AgentSettings')}
              accessibilityRole="button"
              accessibilityLabel="模型设置"
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryText}>模型设置</Text>
            </Pressable>
            {settings?.hasKey && settings.model ? (
              <Pressable
                onPress={confirmCloud}
                disabled={running || busy || cloudBusy}
                accessibilityRole="button"
                accessibilityLabel="运行云端任务"
                accessibilityState={{ disabled: running || busy || cloudBusy }}
                style={[styles.primaryBtn, running || busy || cloudBusy ? styles.muted : null]}
              >
                <Text style={styles.primaryText}>
                  {cloudBusy ? '提交中…' : running ? '运行中…' : '运行云端任务'}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {pendingHandoff ? (
          <View style={[styles.card, styles.approvalCard]}>
            <Text style={styles.title}>需要你接管手机</Text>
            <Text style={styles.body}>{pendingHandoff.reason}</Text>
            <Text style={styles.hint}>
              模型已暂停，不会执行后续手机动作。你处理完当前页面后点「已接管，继续」。
            </Text>
            <View style={styles.actions}>
              <Pressable
                onPress={() => void resumeHandoff()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="已接管继续"
                style={[styles.primaryBtn, busy ? styles.muted : null]}
              >
                <Text style={styles.primaryText}>已接管，继续</Text>
              </Pressable>
              <Pressable
                onPress={() => void stopRun()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="停止任务"
                style={[styles.dangerBtn, busy ? styles.muted : null]}
              >
                <Text style={styles.dangerText}>停止</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {pending ? (
          <View style={[styles.card, styles.approvalCard]}>
            <Text style={styles.title}>本机审批 · {pending.toolName}</Text>
            <Text style={styles.meta}>参数摘要 {pending.digest.slice(0, 12)}…</Text>
            {Object.entries(pending.arguments).map(([key, value]) => (
              <View key={key} style={styles.argRow}>
                <Text style={styles.argKey}>{key}</Text>
                <Text style={styles.argValue} numberOfLines={3} selectable>
                  {typeof value === 'string' ? value : JSON.stringify(value)}
                </Text>
              </View>
            ))}
            {allowBlocked ? (
              <Text
                style={styles.approvalWarning}
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                {APPROVAL_BACKGROUND_LOST_TEXT}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Pressable
                onPress={() => void decide(true)}
                disabled={busy || allowBlocked}
                accessibilityRole="button"
                accessibilityLabel={allowBlocked ? '允许一次（后台屏已断开）' : '允许一次'}
                style={[styles.primaryBtn, busy || allowBlocked ? styles.muted : null]}
              >
                <Text style={styles.primaryText}>允许一次</Text>
              </Pressable>
              <Pressable
                onPress={() => void decide(false)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="拒绝"
                style={[styles.dangerBtn, busy ? styles.muted : null]}
              >
                <Text style={styles.dangerText}>拒绝</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {snapshot?.text ? (
          <View style={styles.card}>
            <Text style={styles.label}>结果</Text>
            <Text style={styles.body} selectable>{snapshot.text}</Text>
          </View>
        ) : null}

        {snapshot?.output ? (
          <View style={styles.card}>
            <Text style={styles.label}>p6-demo-output.txt</Text>
            <Text style={styles.output} selectable>{snapshot.output}</Text>
          </View>
        ) : null}
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
    notice: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
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
    approvalCard: { borderColor: C.warning },
    recoveryCard: { borderColor: C.warning },
    row: { flexDirection: 'row', alignItems: 'center' },
    dot: { width: 8, height: 8, borderRadius: 4, marginRight: tv.space.sm },
    title: { flexShrink: 1, color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    meta: { marginLeft: 'auto', paddingLeft: tv.space.sm, color: C.textFaint, fontSize: tv.type.micro },
    approvalWarning: { color: C.warning, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.sm },
    hint: { color: C.textTertiary, fontSize: tv.type.xs, marginTop: 4 },
    error: { color: C.danger, fontSize: tv.type.xs, marginTop: 4 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: tv.space.md },
    primaryBtn: {
      alignSelf: 'flex-start',
      minHeight: 40,
      paddingHorizontal: 14,
      borderRadius: tv.radius.sm,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    secondaryBtn: {
      alignSelf: 'flex-start',
      minHeight: 40,
      paddingHorizontal: 14,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryText: { color: C.text, fontSize: tv.type.sm },
    dangerBtn: {
      alignSelf: 'flex-start',
      minHeight: 40,
      paddingHorizontal: 14,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dangerText: { color: C.danger, fontSize: tv.type.sm },
    muted: { opacity: 0.55 },
    label: { color: C.textTertiary, fontSize: tv.type.micro, letterSpacing: 0.4 },
    goalInput: {
      marginTop: tv.space.sm,
      minHeight: 64,
      textAlignVertical: 'top',
      backgroundColor: C.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      borderRadius: tv.radius.sm,
      color: C.text,
      fontSize: tv.type.sm,
      paddingHorizontal: tv.space.md,
      paddingVertical: 10,
    },
    body: { color: C.text, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.5, marginTop: tv.space.xs },
    output: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.xs },
    argRow: {
      paddingTop: tv.space.sm,
      marginTop: tv.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    argKey: { color: C.textTertiary, fontSize: tv.type.micro, letterSpacing: 0.4 },
    argValue: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 2 },
  });
}
