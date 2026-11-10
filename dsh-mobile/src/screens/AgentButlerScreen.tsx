/**
 * P6 本机管家对话：像 Mika 一样直接和手机 Agent 聊天。
 *
 * 输入框发送的是一条用户消息；Agent 在手机上前台执行，工具审批/接管卡
 * 直接出现在对话里。队列中的消息等当前 Run 结束后自动开始，不共享电脑 DSH。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { ChatComposer } from '../components/ChatComposer';
import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import {
  agentClient,
  APPROVAL_BACKGROUND_LOST_TEXT,
  isApprovalAllowBlocked,
  type AgentModelSettings,
  type BackgroundDisplayStatus,
  type AgentSnapshot,
  type AgentThreadMessage,
} from '../core/agent';

const CONSENT_KEY = 'agent_consent_v1';
const MAX_DRAFT = 4000;

const PHASE_TEXT: Record<AgentSnapshot['phase'], string> = {
  idle: '等待任务',
  queued: '已排队',
  preparing: '准备中',
  running: '执行中',
  waiting_user: '等待你',
  stopping: '停止中',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

export function AgentButlerScreen({ active = true }: { active?: boolean }) {
  const tv = useTheme();
  const nav = useNav();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [settings, setSettings] = useState<AgentModelSettings | null>(null);
  const [thread, setThread] = useState<AgentThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [background, setBackground] = useState<BackgroundDisplayStatus | null>(null);
  const [backgroundFrame, setBackgroundFrame] = useState<string | null>(null);
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const autoStartRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await agentClient.snapshot());
      setError(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await agentClient.getModelSettings());
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  const refreshThread = useCallback(async () => {
    try {
      setThread(await agentClient.thread());
    } catch {
      // The live status remains usable even if the thread read fails.
    }
  }, []);

  const refreshBackground = useCallback(async () => {
    try {
      setBackground(await agentClient.backgroundStatus());
    } catch {
      // The experiment screen reports the detailed Shizuku/display error.
    }
  }, []);

  const ensureAutoStart = useCallback(async () => {
    if (autoStartRef.current) return;
    autoStartRef.current = true;
    try {
      const setting = await agentClient.getBackgroundAutoStart();
      setAutoStartEnabled(setting.enabled);
      if (!setting.enabled) return;
      // Never trigger a permission dialog just by opening the chat. Arm the
      // controller: it binds when a grant already exists, and otherwise waits
      // for a grant made through the banner or the Shizuku manager.
      setBackground(await agentClient.backgroundArm());
    } catch {
      // Auto-start is best effort; the user can retry from the experiment page.
    }
  }, []);

  useEffect(() => {
    void AsyncStorage.getItem(CONSENT_KEY)
      .then((value) => setConsent(value === '1'))
      .catch(() => setConsent(false));
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        if (stopped) return;
        void refresh().finally(() => { if (!stopped) schedule(); });
      }, 700);
    };
    void refresh();
    void refreshSettings();
    void refreshThread();
    void refreshBackground();
    void ensureAutoStart();
    schedule();
    const threadTimer = setInterval(() => { if (!stopped) void refreshThread(); }, 1200);
    const backgroundTimer = setInterval(() => { if (!stopped) void refreshBackground(); }, 1500);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(threadTimer);
      clearInterval(backgroundTimer);
      autoStartRef.current = false;
    };
  }, [active, refresh, refreshSettings, refreshThread, refreshBackground, ensureAutoStart]);

  useEffect(() => {
    if (!active) return;
  const phase = snapshot?.phase ?? 'idle';
    if (phase === 'completed' || phase === 'failed' || phase === 'interrupted') {
      void refreshThread();
    }
  }, [active, snapshot?.phase, refreshThread]);

  const agreeConsent = useCallback(() => {
    setConsent(true);
    void AsyncStorage.setItem(CONSENT_KEY, '1').catch(() => undefined);
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!consent) {
      setError('请先阅读并同意数据发送说明');
      return;
    }
    if (!settings?.hasKey || !settings.model) {
      nav.push('AgentSettings');
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        setSnapshot(await agentClient.startCloud(text));
        // Keep a draft edited while the request was in flight; clear only the
        // text that was actually sent.
        setDraft((current) => (current === text ? '' : current));
        await refreshThread();
      } catch (failure) {
        // Keep the draft on failure (for example BACKGROUND_NOT_READY) so the
        // user can re-authorize and send it again.
        setError(String((failure as Error)?.message ?? failure));
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, consent, draft, nav, refreshThread, settings?.hasKey, settings?.model]);

  const stop = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        setSnapshot(await agentClient.stop());
        await refreshThread();
      } catch (failure) {
        setError(String((failure as Error)?.message ?? failure));
      } finally {
        setBusy(false);
      }
    })();
  }, [refreshThread]);

  const decide = useCallback(async (allow: boolean) => {
    const pending = snapshot?.pendingApproval;
    if (!pending) return;
    setBusy(true);
    try {
      setSnapshot(await agentClient.decide(pending.callId, allow));
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, [snapshot]);

  const resumeHandoff = useCallback(async () => {
    setBusy(true);
    try {
      setSnapshot(await agentClient.resumeHandoff());
      await refreshThread();
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, [refreshThread]);

  const dismissRecovery = useCallback(async () => {
    setBusy(true);
    try {
      setSnapshot(await agentClient.dismissRecovery());
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const clearThread = useCallback(() => {
    Alert.alert('清空本机对话？', '任务历史记录会保留，但后续任务不再携带之前的对话上下文。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              setSnapshot(await agentClient.clearThread());
              await refreshThread();
            } catch (failure) {
              setError(String((failure as Error)?.message ?? failure));
            }
          })();
        },
      },
    ]);
  }, [refreshThread]);

  useEffect(() => {
    if (!active || !background?.connected) {
      setBackgroundFrame(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        const next = await agentClient.backgroundFrame();
        if (!stopped && next) setBackgroundFrame(next);
      } catch {
        // Status polling will surface a disconnected display.
      }
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, background?.connected]);

  const retryBackground = useCallback(async () => {
    setBackgroundBusy(true);
    try {
      setBackground(await agentClient.backgroundRetry());
      setError(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBackgroundBusy(false);
    }
  }, []);

  const openShizuku = useCallback(async () => {
    setBackgroundBusy(true);
    try {
      const result = await agentClient.backgroundOpenShizuku();
      if (!result.opened) {
        setError(result.installed ? '未能打开 Shizuku' : '未安装 Shizuku');
      }
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBackgroundBusy(false);
    }
  }, []);

  const disableAutoStart = useCallback(async () => {
    try {
      await agentClient.setBackgroundAutoStart(false);
      setAutoStartEnabled(false);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  const stopBackground = useCallback(async () => {
    setBackgroundBusy(true);
    try {
      setBackground(await agentClient.backgroundStop());
      setBackgroundFrame(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBackgroundBusy(false);
    }
  }, []);

  const phase = snapshot?.phase ?? 'idle';
  const running = phase === 'queued' || phase === 'preparing' || phase === 'running' || phase === 'waiting_user';
  const pending = snapshot?.pendingApproval ?? null;
  const allowBlocked = isApprovalAllowBlocked(pending);
  const handoff = snapshot?.pendingHandoff ?? null;
  const recovery = snapshot?.recovery ?? null;
  const queue = snapshot?.queue ?? [];
  const events = snapshot?.events ?? [];
  const streamText = snapshot?.streamText ?? '';
  const configured = Boolean(settings?.hasKey && settings.model);
  const showWorking = running && !pending && !handoff;
  const backgroundPermissionMissing = Boolean(
    background && background.shizukuRunning && !background.permissionGranted,
  );
  const backgroundNeedsAttention = Boolean(
    !snapshot?.backgroundLost &&
    autoStartEnabled &&
    background &&
    (
      !background.shizukuRunning ||
      !background.permissionGranted ||
      (
        !background.connected &&
        ['error', 'disconnected', 'retry_exhausted', 'retrying',
          'permission_revoked', 'permission_denied', 'permission_required'].includes(background.state)
      )
    ),
  );
  const backgroundIssueTitle = !background
    ? ''
    : !background.shizukuRunning
      ? (background.installed ? 'Shizuku 未运行' : '未安装 Shizuku')
      : !background.permissionGranted
        ? (background.state === 'permission_revoked' ? 'Shizuku 权限已撤销' : '需要 Shizuku 授权')
        : '后台屏不可用';
  const backgroundIssueHint = !background
    ? ''
    : !background.shizukuRunning
      ? (background.installed
          ? '后台模式已开启；启动 Shizuku 后回来重试，权限仍在时会自动恢复。'
          : '后台模式已开启，但还没有安装 Shizuku。安装并启动后再回来授权。')
      : !background.permissionGranted
        ? (background.state === 'permission_denied'
            ? '上一次授权被拒绝。重新授权后会自动创建后台屏。'
            : '后台模式已开启，但 Shizuku 授权已被撤销。重新授权后会自动恢复，任务不会切回主屏。')
        : (background.error ?? background.state);
  const backgroundIssueAction = !background
    ? '重试'
    : !background.shizukuRunning
      ? '打开 Shizuku'
      : !background.permissionGranted
        ? '重新授权'
        : '重试';

  const handleBackgroundIssue = useCallback(() => {
    if (background && !background.shizukuRunning) {
      void openShizuku();
    } else {
      void retryBackground();
    }
  }, [background, openShizuku, retryBackground]);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [active, thread.length, running, pending, handoff, queue.length]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Header
        title="本机管家"
        subtitle="手机 Agent"
        right={
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => nav.push('BackgroundDisplay')}
              accessibilityRole="button"
              accessibilityLabel="打开后台屏实验"
              hitSlop={8}
              style={styles.bgHeaderBtn}
            >
              <Text style={[styles.headerAction, background?.connected ? styles.bgHeaderActive : null]}>后台屏</Text>
              {background?.connected ? <View style={styles.bgHeaderDot} /> : null}
            </Pressable>
            <Pressable
              onPress={() => nav.push('AgentMemory')}
              accessibilityRole="button"
              accessibilityLabel="打开管家记忆"
              hitSlop={8}
            >
              <Text style={styles.headerAction}>记忆</Text>
            </Pressable>
            <Pressable
              onPress={() => nav.push('AgentSettings')}
              accessibilityRole="button"
              accessibilityLabel="打开模型与凭据设置"
              hitSlop={8}
            >
              <Text style={styles.headerAction}>模型</Text>
            </Pressable>
          </View>
        }
      />

      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        {recovery ? (
          <View style={[styles.systemCard, styles.attentionCard]}>
            <Text style={styles.systemTitle}>上次任务中断</Text>
            <Text style={styles.systemText}>{recovery.reason ?? '进程中断，任务没有恢复。'}</Text>
            <Text style={styles.systemHint}>
              旧审批已失效，不会自动复活或重放。{recovery.requiresReconciliation
                ? ' 崩溃时可能正在执行有副作用的工具，结果未知。'
                : ' 这次没有未知副作用记录。'}
            </Text>
            <Pressable onPress={() => void dismissRecovery()} style={styles.smallAction}>
              <Text style={styles.smallActionText}>知道了</Text>
            </Pressable>
          </View>
        ) : null}

        {thread.length === 0 && consent !== false ? (
          <AssistantBubble
            text="我是本机手机管家。告诉我你想做什么，我会在手机上读取屏幕、操作应用、处理文件；需要批准或接管时会在这里停下来问你。"
            styles={styles}
          />
        ) : null}

        {thread.map((message, index) => (
          message.role === 'user' ? (
            <View key={`${message.at}-${index}`} style={styles.userRow}>
              <View style={styles.userBubble}>
                <Text style={styles.userText} selectable>{message.text}</Text>
              </View>
            </View>
          ) : (
            <AssistantBubble key={`${message.at}-${index}`} text={message.text} styles={styles} />
          )
        ))}

        {consent === false ? (
          <View style={styles.assistantRow}>
            <View style={[styles.assistantBubble, styles.attentionCard]}>
              <Text style={styles.systemTitle}>数据发送说明</Text>
              <Text style={styles.systemText}>
                本机 Agent 会把任务、工作区文件内容、手机屏幕元素、应用列表和工具结果发送到你配置的云端模型服务商；
                这些内容可能包含个人信息。API Key 只保存在本机，但任务内容会离开本机。
              </Text>
              <Text style={styles.systemHint}>请确认你信任所配置的服务商及其数据政策，再开始使用。</Text>
              <Pressable
                onPress={agreeConsent}
                style={styles.primaryBtn}
                accessibilityRole="button"
                accessibilityLabel="同意数据发送说明"
              >
                <Text style={styles.primaryText}>我已了解并同意</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {!configured && consent !== false ? (
          <View style={styles.assistantRow}>
            <View style={[styles.assistantBubble, styles.setupCard]}>
              <Text style={styles.systemTitle}>先配置模型</Text>
              <Text style={styles.systemText}>本机管家需要云端模型和 API Key；Key 只保存在本机 Keystore。</Text>
              <Pressable
                onPress={() => nav.push('AgentSettings')}
                style={styles.primaryBtn}
                accessibilityRole="button"
                accessibilityLabel="打开模型与凭据设置"
              >
                <Text style={styles.primaryText}>模型与凭据</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {snapshot?.backgroundLost ? (
          <View style={styles.assistantRow}>
            <View style={[styles.assistantBubble, styles.attentionCard]}>
              <Text style={styles.systemTitle}>
                {backgroundPermissionMissing ? '后台屏权限已撤销' : '后台屏已断开'}
              </Text>
              <Text style={styles.systemText}>
                {backgroundPermissionMissing
                  ? '任务已暂停在下一步，重新授权后会自动继续；不会切回主屏操作。'
                  : '任务已暂停在下一步，不会切回主屏继续操作。重试后台屏恢复后可继续。'}
              </Text>
              <View style={styles.actions}>
                <Pressable
                  onPress={() => void retryBackground()}
                  disabled={backgroundBusy}
                  accessibilityRole="button"
                  accessibilityLabel={backgroundPermissionMissing ? '重新授权后台屏并继续任务' : '重试后台屏并继续任务'}
                  style={[styles.primaryBtn, backgroundBusy ? styles.muted : null]}
                >
                  <Text style={styles.primaryText}>
                    {backgroundBusy ? '处理中…' : backgroundPermissionMissing ? '重新授权' : '重试后台屏'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void stop()}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="停止任务"
                  style={styles.dangerBtn}
                >
                  <Text style={styles.dangerText}>停止任务</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}

        {pending ? (
          <View style={styles.assistantRow}>
            <View style={[styles.assistantBubble, styles.attentionCard]}>
              <Text style={styles.systemTitle}>需要你确认 · {pending.toolName}</Text>
              <Text style={styles.systemHint}>参数摘要 {pending.digest.slice(0, 12)}…</Text>
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
                  {APPROVAL_BACKGROUND_LOST_TEXT}先重试后台屏，或拒绝这次操作。
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
                {allowBlocked ? (
                  <Pressable
                    onPress={() => void retryBackground()}
                    disabled={backgroundBusy}
                    accessibilityRole="button"
                    accessibilityLabel="重试后台屏"
                    style={[styles.bgRecoveryAction, backgroundBusy ? styles.muted : null]}
                  >
                    <Text style={styles.bgRecoveryActionText}>
                      {backgroundBusy ? '…' : '重试后台屏'}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable onPress={() => void decide(false)} disabled={busy} style={styles.dangerBtn}>
                  <Text style={styles.dangerText}>拒绝</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}

        {handoff ? (
          <View style={styles.assistantRow}>
            <View style={[styles.assistantBubble, styles.attentionCard]}>
              <Text style={styles.systemTitle}>需要你接管手机</Text>
              <Text style={styles.systemText}>{handoff.reason}</Text>
              <Text style={styles.systemHint}>模型已暂停，不会执行后续手机动作。</Text>
              <View style={styles.actions}>
                <Pressable onPress={() => void resumeHandoff()} disabled={busy} style={styles.primaryBtn}>
                  <Text style={styles.primaryText}>已接管，继续</Text>
                </Pressable>
                <Pressable onPress={() => void stop()} disabled={busy} style={styles.dangerBtn}>
                  <Text style={styles.dangerText}>停止</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}

        {showWorking ? (
          <View style={styles.assistantRow}>
            <View style={styles.assistantBubble}>
              <View style={styles.workingRow}>
                <ActivityIndicator size="small" color={tv.colors.accent} />
                <Text style={styles.workingText}>
                  {snapshot?.backgroundLost
                    ? (backgroundPermissionMissing ? '等待 Shizuku 授权…' : '等待后台屏恢复…')
                    : phase === 'waiting_user'
                      ? '等你处理…'
                      : `${PHASE_TEXT[phase]}${snapshot?.step ? ` · 第 ${snapshot.step} 步` : ''}${snapshot?.backgroundDisplayId ? ' · 后台屏' : ''}`}
                </Text>
              </View>
              {streamText ? <Text style={styles.streamText} selectable>{streamText}</Text> : null}
            </View>
          </View>
        ) : null}

        {events.length > 0 ? (
          <View style={styles.assistantRow}>
            <View style={styles.timeline}>
              <Text style={styles.timelineTitle}>执行记录</Text>
              {events.slice(-8).map((event) => (
                <View key={`${event.seq}-${event.type}`} style={styles.timelineRow}>
                  <View style={[styles.timelineDot, event.type === 'tool_finished' ? styles.timelineDotDone : null]} />
                  <Text style={styles.timelineText} numberOfLines={2}>
                    {event.type === 'tool_started'
                      ? `调用 ${event.toolName ?? '工具'}`
                      : `${event.toolName ?? '工具'} · ${event.status === 'OK' ? '完成' : event.status === 'DENIED' ? '已拒绝' : '错误'}`}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={styles.assistantRow}>
            <View style={[styles.assistantBubble, styles.errorCard]}>
              <Text style={styles.error}>{error}</Text>
            </View>
          </View>
        ) : null}

        {queue.length > 0 ? (
          <View style={styles.assistantRow}>
            <View style={styles.queueChip}>
              <Text style={styles.queueTitle}>排队中（{queue.length}）</Text>
              {queue.map((task, index) => (
                <Text key={task.id} style={styles.queueLine} numberOfLines={1}>
                  {index + 1}. {task.goal}
                </Text>
              ))}
              <Text style={styles.queueHint}>当前回答结束后按顺序开始；点输入框旁的停止会清空队列。</Text>
              <Text style={styles.queueHint}>后台屏不可用时，下一件会暂停在开始前，不会切到主屏。</Text>
            </View>
          </View>
        ) : null}

        {thread.length > 0 ? (
          <Pressable onPress={clearThread} accessibilityRole="button" accessibilityLabel="清空本机对话" style={styles.clearRow}>
            <Text style={styles.clearText}>清空本机对话</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {backgroundNeedsAttention ? (
        <View style={styles.bgRecovery}>
          <View style={styles.bgRecoveryText}>
            <Text style={styles.bgRecoveryTitle}>{backgroundIssueTitle}</Text>
            <Text style={styles.bgRecoveryHint} numberOfLines={3}>
              {backgroundIssueHint}
            </Text>
          </View>
          <Pressable
            onPress={handleBackgroundIssue}
            disabled={backgroundBusy}
            accessibilityRole="button"
            accessibilityLabel={backgroundIssueAction}
            style={[styles.bgRecoveryAction, backgroundBusy ? styles.muted : null]}
          >
            <Text style={styles.bgRecoveryActionText}>
              {backgroundBusy ? '…' : backgroundIssueAction}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void disableAutoStart()}
            accessibilityRole="button"
            accessibilityLabel="关闭自动启动后台屏"
            style={styles.bgRecoveryAction}
          >
            <Text style={styles.bgRecoveryActionText}>关闭自动</Text>
          </Pressable>
        </View>
      ) : null}

      {background?.connected ? (
        <View style={styles.bgPipWrap}>
          <Pressable
            onPress={() => nav.push('BackgroundDisplay')}
            accessibilityRole="button"
            accessibilityLabel="查看后台屏"
            style={styles.bgPip}
          >
            {backgroundFrame ? (
              <Image
                source={{ uri: `data:image/png;base64,${backgroundFrame}` }}
                style={styles.bgPipThumb}
                resizeMode="contain"
                accessibilityLabel="后台屏预览"
              />
            ) : (
              <View style={[styles.bgPipThumb, styles.bgPipThumbEmpty]}>
                <ActivityIndicator size="small" color={tv.colors.accent} />
              </View>
            )}
            <View style={styles.bgPipText}>
              <Text style={styles.bgPipTitle}>后台屏 · displayId {background.displayId}</Text>
              <Text style={styles.bgPipHint} numberOfLines={2}>
                {snapshot?.backgroundDisplayId === background.displayId
                  ? '当前任务正在使用后台屏'
                  : 'Agent 会在副屏操作；点开查看或切换应用'}
              </Text>
            </View>
          </Pressable>
          <Pressable
            onPress={() => void stopBackground()}
            disabled={backgroundBusy}
            accessibilityRole="button"
            accessibilityLabel="停止后台屏"
            style={[styles.bgPipStop, backgroundBusy ? styles.muted : null]}
          >
            <Text style={styles.bgPipStopText}>{backgroundBusy ? '…' : '停止'}</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.composerWrap}>
        <ChatComposer
          value={draft}
          attachments={[]}
          sending={busy}
          uploading={false}
          running={running}
          maxLength={MAX_DRAFT}
          queueOnly
          attachmentsEnabled={false}
          enabled={consent === true}
          placeholder={background?.connected ? '后台屏已就绪，告诉管家做什么…' : configured ? '和手机管家说点什么…' : '先配置模型，再开始聊天'}
          onChangeText={setDraft}
          onAddAttachment={() => undefined}
          onRemoveAttachment={() => undefined}
          onSend={() => send()}
          onStop={() => void stop()}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function AssistantBubble({ text, styles }: { text: string; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.assistantRow}>
      <View style={styles.assistantBubble}>
        <Text style={styles.assistantLabel}>管家</Text>
        <Text style={styles.assistantText} selectable>{text}</Text>
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    scroll: { flex: 1 },
    messages: { paddingTop: tv.space.sm, paddingBottom: tv.space.lg },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    headerAction: { color: C.accent, fontSize: tv.type.sm, fontWeight: '600' },
    userRow: { paddingHorizontal: tv.layout.screenPadding, marginTop: tv.space.md, alignItems: 'flex-end' },
    userBubble: {
      maxWidth: '84%',
      paddingHorizontal: tv.space.lg,
      paddingVertical: tv.space.sm + 1,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bubbleUser,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.bubbleUserBorder,
    },
    userText: { color: C.text, fontSize: tv.type.base, lineHeight: tv.type.base * 1.45 },
    assistantRow: { paddingHorizontal: tv.layout.screenPadding, marginTop: tv.space.md, alignItems: 'flex-start' },
    assistantBubble: {
      maxWidth: '92%',
      paddingHorizontal: tv.space.lg,
      paddingVertical: tv.space.sm + 1,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    assistantLabel: { color: C.textTertiary, fontSize: tv.type.micro, fontWeight: '600', marginBottom: 3 },
    assistantText: { color: C.text, fontSize: tv.type.base, lineHeight: tv.type.base * 1.5 },
    systemCard: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    attentionCard: { borderColor: C.warning },
    setupCard: { borderColor: C.accent },
    errorCard: { borderColor: C.danger },
    systemTitle: { color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    systemText: { color: C.text, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.5, marginTop: tv.space.xs },
    systemHint: { color: C.textTertiary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.xs },
    approvalWarning: { color: C.warning, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.sm },
    smallAction: { alignSelf: 'flex-start', marginTop: tv.space.sm, paddingVertical: 6 },
    smallActionText: { color: C.accent, fontSize: tv.type.sm, fontWeight: '600' },
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
    argRow: {
      paddingTop: tv.space.sm,
      marginTop: tv.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    argKey: { color: C.textTertiary, fontSize: tv.type.micro, letterSpacing: 0.4 },
    argValue: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 2 },
    workingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    workingText: { color: C.textSecondary, fontSize: tv.type.sm },
    streamText: { color: C.text, fontSize: tv.type.base, lineHeight: tv.type.base * 1.5, marginTop: tv.space.sm },
    timeline: {
      width: '88%',
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    timelineTitle: { color: C.textTertiary, fontSize: tv.type.micro, fontWeight: '600', letterSpacing: 0.4 },
    timelineRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
    timelineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.warning, marginRight: 7 },
    timelineDotDone: { backgroundColor: C.success },
    timelineText: { flex: 1, color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5 },
    error: { color: C.danger, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5 },
    queueChip: {
      maxWidth: '92%',
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.accentWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.accentDim,
    },
    queueTitle: { color: C.accent, fontSize: tv.type.xs, fontWeight: '600' },
    queueLine: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 2 },
    queueHint: { color: C.textTertiary, fontSize: tv.type.micro, marginTop: 4 },
    clearRow: { alignSelf: 'center', marginTop: tv.space.lg, padding: 6 },
    clearText: { color: C.textTertiary, fontSize: tv.type.xs },
    bgHeaderBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    bgHeaderActive: { color: C.success },
    bgHeaderDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.success },
    bgRecovery: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
      padding: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.accentWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.warning,
    },
    bgRecoveryText: { flex: 1 },
    bgRecoveryTitle: { color: C.warning, fontSize: tv.type.xs, fontWeight: '600' },
    bgRecoveryHint: { color: C.textSecondary, fontSize: tv.type.micro, lineHeight: tv.type.micro * 1.4, marginTop: 2 },
    bgRecoveryAction: {
      minHeight: 34,
      paddingHorizontal: 9,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bgRecoveryActionText: { color: C.text, fontSize: tv.type.micro },
    bgPipWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
      padding: 8,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    bgPip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
    bgPipThumb: { width: 40, height: 72, borderRadius: tv.radius.sm, backgroundColor: '#000' },
    bgPipThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
    bgPipText: { flex: 1 },
    bgPipTitle: { color: C.text, fontSize: tv.type.xs, fontWeight: '600' },
    bgPipHint: { color: C.textTertiary, fontSize: tv.type.micro, lineHeight: tv.type.micro * 1.4, marginTop: 2 },
    bgPipStop: {
      minHeight: 36,
      paddingHorizontal: 10,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bgPipStopText: { color: C.textSecondary, fontSize: tv.type.xs },
    muted: { opacity: 0.5 },
    composerWrap: { paddingBottom: tv.space.sm },
  });
}
