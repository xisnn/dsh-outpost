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
  AppState,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { AgentRecoveryCard } from '../components/AgentRecoveryCard';
import { ChatComposer } from '../components/ChatComposer';
import { AgentScreenOffNotice } from '../components/AgentScreenOffNotice';
import { AgentStreamingBubble } from '../components/AgentStreamingBubble';
import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import { useReduceMotion } from '../design/useReduceMotion';
import {
  agentClient,
  APPROVAL_BACKGROUND_LOST_TEXT,
  isApprovalAllowBlocked,
  type AgentMemoryKind,
  type AgentModelSettings,
  type AgentSessionsState,
  type AgentSessionSummary,
  type AgentStorageStatus,
  type BackgroundDisplayStatus,
  type AgentSnapshot,
  type AgentThreadMessage,
} from '../core/agent';
import {
  buildMemoryDraftFromMessage,
  formatShortTime,
  formatStorageNotice,
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  truncateSessionTitle,
} from '../core/agentPersistence';
import {
  formatApprovalCountdown,
  isApprovalAllowDisabled,
  isApprovalExpired,
} from '../core/agentApproval';
import {
  classifyAgentFailure,
  extractAgentError,
  formatCrashRecoveryReason,
  formatTimelineEvent,
  hasAccessibilityToolError,
  hasRunSideEffects,
  isBackgroundFailureState,
  isRecoverableInterruptedReason,
  type AgentRecoveryActionId,
} from '../core/agentRecovery';
import {
  advanceRevealedLength,
  applyStreamEvent,
  isActiveAgentPhase,
  isTerminalAgentPhase,
  resolveStreamingBubble,
  safeSlice,
  snapshotPollIntervalMs,
  TYPEWRITER_TICK_MS,
} from '../core/agentStream';
import { distanceFromBottom, NEAR_BOTTOM_PX } from '../core/scrollFollow';

const CONSENT_KEY = 'agent_consent_v1';
const MAX_DRAFT = 4000;

interface ButlerActionError {
  code: string | null;
  message: string;
  source: 'read' | 'action';
}

export function AgentButlerScreen({ active = true }: { active?: boolean }) {
  const tv = useTheme();
  const nav = useNav();
  const reduceMotion = useReduceMotion();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [settings, setSettings] = useState<AgentModelSettings | null>(null);
  const [thread, setThread] = useState<AgentThreadMessage[]>([]);
  const [sessionsState, setSessionsState] = useState<AgentSessionsState | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [storageStatus, setStorageStatus] = useState<AgentStorageStatus | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<{
    key: string;
    value: string;
    kind: AgentMemoryKind;
    pinned: boolean;
  } | null>(null);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryToast, setMemoryToast] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<ButlerActionError | null>(null);
  const [dismissedRunKey, setDismissedRunKey] = useState<string | null>(null);
  const [dismissedBgState, setDismissedBgState] = useState<string | null>(null);
  const [background, setBackground] = useState<BackgroundDisplayStatus | null>(null);
  const [backgroundFrame, setBackgroundFrame] = useState<string | null>(null);
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [revealedLen, setRevealedLen] = useState(0);
  const [approvalNow, setApprovalNow] = useState(() => Date.now());
  const scroll = useRef<ScrollView>(null);
  const nearBottomRef = useRef(true);
  const phaseRef = useRef<AgentSnapshot['phase']>('idle');
  const streamScopeRef = useRef('');
  const autoStartRef = useRef(false);
  // A snapshot read error clears on the next successful read; an action error
  // has to survive the 700ms poll, or the user sees it flash and vanish.
  const errorSource = useRef<'read' | 'action' | null>(null);
  // `busy` only disables the buttons after a re-render; this blocks the second
  // tap of a double-press synchronously.
  const deciding = useRef(false);

  const reportError = useCallback((source: 'read' | 'action', failure: unknown) => {
    const parsed = extractAgentError(failure);
    errorSource.current = source;
    setActionError({ code: parsed.code, message: parsed.message, source });
  }, []);

  const clearError = useCallback(() => {
    errorSource.current = null;
    setActionError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await agentClient.snapshot());
      if (errorSource.current === 'read') {
        clearError();
      }
    } catch (failure) {
      reportError('read', failure);
    }
  }, [clearError, reportError]);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await agentClient.getModelSettings());
    } catch (failure) {
      reportError('read', failure);
    }
  }, [reportError]);

  const refreshThread = useCallback(async () => {
    try {
      setThread(await agentClient.thread());
    } catch {
      // The live status remains usable even if the thread read fails.
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessionsState(await agentClient.sessions());
    } catch {
      // Session list stays optional when native bridge is unavailable.
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    try {
      setStorageStatus(await agentClient.storageStatus());
    } catch {
      // Optional storage migration status.
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
    phaseRef.current = snapshot?.phase ?? 'idle';
  }, [snapshot?.phase]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        if (stopped) return;
        void refresh().finally(() => { if (!stopped) schedule(); });
      }, snapshotPollIntervalMs(phaseRef.current));
    };
    const unsubscribeStream = agentClient.subscribeStream((event) => {
      if (stopped) return;
      setSnapshot((prev) => applyStreamEvent(prev, event));
      if (isTerminalAgentPhase(event.phase)) {
        void refresh();
        void refreshThread();
        void refreshSessions();
      }
    });
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (!stopped && nextState === 'active') {
        void refresh();
        void refreshSettings();
        void refreshBackground();
        void refreshSessions();
      }
    });
    void refresh();
    void refreshSettings();
    void refreshThread();
    void refreshSessions();
    void refreshStorage();
    void refreshBackground();
    void ensureAutoStart();
    schedule();
    const threadTimer = setInterval(() => { if (!stopped) void refreshThread(); }, 1200);
    const backgroundTimer = setInterval(() => { if (!stopped) void refreshBackground(); }, 1500);
    return () => {
      stopped = true;
      unsubscribeStream();
      appStateSub.remove();
      if (timer !== undefined) clearTimeout(timer);
      clearInterval(threadTimer);
      clearInterval(backgroundTimer);
      autoStartRef.current = false;
    };
  }, [active, refresh, refreshSettings, refreshThread, refreshSessions, refreshStorage, refreshBackground, ensureAutoStart]);

  useEffect(() => {
    if (!active) return;
    const phase = snapshot?.phase ?? 'idle';
    if (phase === 'completed' || phase === 'failed' || phase === 'interrupted') {
      void refreshThread();
      void refreshSessions();
    }
  }, [active, snapshot?.phase, refreshThread, refreshSessions]);

  const agreeConsent = useCallback(() => {
    setConsent(true);
    void AsyncStorage.setItem(CONSENT_KEY, '1').catch(() => undefined);
  }, []);

  const submitGoal = useCallback((rawGoal: string, clearMatchingDraft: boolean) => {
    const text = rawGoal.trim();
    if (!text || busy) return;
    if (storageStatus?.downgradeBlocked) {
      reportError('action', new Error('STORAGE_DOWNGRADE_BLOCKED'));
      return;
    }
    if (!consent) {
      reportError('action', new Error('请先阅读并同意数据发送说明'));
      return;
    }
    if (!settings?.hasKey || !settings.model) {
      nav.push('AgentSettings');
      return;
    }
    nearBottomRef.current = true;
    setBusy(true);
    clearError();
    void (async () => {
      try {
        setSnapshot(await agentClient.startCloud(text));
        if (clearMatchingDraft) {
          // Keep a draft edited while the request was in flight; clear only the
          // text that was actually sent.
          setDraft((current) => (current === text ? '' : current));
        }
        await refreshThread();
        await refreshSessions();
      } catch (failure) {
        // Keep the draft on failure (for example BACKGROUND_NOT_READY) so the
        // user can re-authorize and send it again.
        reportError('action', failure);
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, clearError, consent, nav, refreshSessions, refreshThread, reportError, settings?.hasKey, settings?.model, storageStatus?.downgradeBlocked]);

  const send = useCallback(() => {
    submitGoal(draft, true);
  }, [draft, submitGoal]);

  const stop = useCallback(() => {
    if (busy || phaseRef.current === 'stopping') return;
    setBusy(true);
    clearError();
    void (async () => {
      try {
        setSnapshot(await agentClient.stop());
        await refreshThread();
      } catch (failure) {
        reportError('action', failure);
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, clearError, refreshThread, reportError]);

  const decide = useCallback(async (allow: boolean) => {
    const pending = snapshot?.pendingApproval;
    if (!pending || deciding.current) return;
    deciding.current = true;
    setBusy(true);
    clearError();
    try {
      // The digest the card rendered travels with the decision: native rejects
      // it if the pending call changed, which a callId alone cannot detect.
      setSnapshot(await agentClient.decide(pending.callId, pending.digest, allow));
    } catch (failure) {
      reportError('action', failure);
    } finally {
      deciding.current = false;
      setBusy(false);
    }
  }, [clearError, reportError, snapshot]);

  const resumeHandoff = useCallback(async () => {
    setBusy(true);
    clearError();
    try {
      setSnapshot(await agentClient.resumeHandoff());
      await refreshThread();
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setBusy(false);
    }
  }, [clearError, refreshThread, reportError]);

  const dismissRecovery = useCallback(async () => {
    setBusy(true);
    clearError();
    try {
      setSnapshot(await agentClient.dismissRecovery());
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setBusy(false);
    }
  }, [clearError, reportError]);

  const clearThread = useCallback(() => {
    Alert.alert('清空当前对话？', '当前会话消息与后续模型上下文会清空，任务历史与其它会话会保留。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            clearError();
            try {
              setSnapshot(await agentClient.clearThread());
              await refreshThread();
              await refreshSessions();
            } catch (failure) {
              reportError('action', failure);
            }
          })();
        },
      },
    ]);
  }, [clearError, refreshSessions, refreshThread, reportError]);

  const createNewSession = useCallback(async () => {
    if (sessionBusy) return;
    setSessionBusy(true);
    clearError();
    try {
      setSessionsState(await agentClient.createSession());
      setSessionsOpen(false);
      setRenamingSessionId(null);
      await refreshThread();
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setSessionBusy(false);
    }
  }, [clearError, refreshThread, reportError, sessionBusy]);

  const selectSession = useCallback(async (sessionId: string) => {
    if (sessionBusy) return;
    setSessionBusy(true);
    clearError();
    try {
      setSessionsState(await agentClient.switchSession(sessionId));
      setSessionsOpen(false);
      setRenamingSessionId(null);
      await refreshThread();
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setSessionBusy(false);
    }
  }, [clearError, refreshThread, reportError, sessionBusy]);

  const commitRenameSession = useCallback(async () => {
    if (!renamingSessionId || sessionBusy) return;
    const clean = renameTitle.trim();
    if (!clean) {
      reportError('action', new Error('会话名称不能为空'));
      return;
    }
    setSessionBusy(true);
    clearError();
    try {
      setSessionsState(await agentClient.renameSession(renamingSessionId, clean));
      setRenamingSessionId(null);
      setRenameTitle('');
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setSessionBusy(false);
    }
  }, [clearError, renameTitle, renamingSessionId, reportError, sessionBusy]);

  const confirmDeleteSession = useCallback((session: AgentSessionSummary) => {
    Alert.alert('删除这段对话？', `「${session.title}」的上下文将被移除，任务执行历史会保留。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setSessionBusy(true);
            clearError();
            try {
              setSessionsState(await agentClient.deleteSession(session.id));
              if (renamingSessionId === session.id) setRenamingSessionId(null);
              await refreshThread();
            } catch (failure) {
              reportError('action', failure);
            } finally {
              setSessionBusy(false);
            }
          })();
        },
      },
    ]);
  }, [clearError, refreshThread, renamingSessionId, reportError]);

  const openSaveToMemory = useCallback((message: AgentThreadMessage) => {
    setMemoryToast(null);
    setMemoryDraft({ ...buildMemoryDraftFromMessage(message), pinned: false });
  }, []);

  const submitMemoryDraft = useCallback(async () => {
    if (!memoryDraft || memorySaving) return;
    const cleanKey = memoryDraft.key.trim();
    const cleanValue = memoryDraft.value.trim();
    if (!cleanKey || !cleanValue) {
      reportError('action', new Error('记忆名称和内容都不能为空'));
      return;
    }
    setMemorySaving(true);
    clearError();
    try {
      await agentClient.saveMemoryEntry(
        null,
        cleanKey,
        cleanValue,
        memoryDraft.kind,
        memoryDraft.pinned,
        true,
      );
      setMemoryDraft(null);
      setMemoryToast(`已保存到管家记忆：${cleanKey}`);
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setMemorySaving(false);
    }
  }, [clearError, memoryDraft, memorySaving, reportError]);

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
    clearError();
    setDismissedBgState(null);
    try {
      setBackground(await agentClient.backgroundRetry());
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setBackgroundBusy(false);
    }
  }, [clearError, reportError]);

  const openShizuku = useCallback(async () => {
    setBackgroundBusy(true);
    clearError();
    try {
      const result = await agentClient.backgroundOpenShizuku();
      if (!result.opened) {
        reportError('action', new Error(result.installed ? '未能打开 Shizuku' : '未安装 Shizuku'));
      }
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setBackgroundBusy(false);
    }
  }, [clearError, reportError]);

  const openAccessibility = useCallback(async () => {
    clearError();
    try {
      await agentClient.openAccessibilitySettings();
    } catch (failure) {
      reportError('action', failure);
    }
  }, [clearError, reportError]);

  const disableAutoStart = useCallback(async () => {
    clearError();
    try {
      await agentClient.setBackgroundAutoStart(false);
      setAutoStartEnabled(false);
    } catch (failure) {
      reportError('action', failure);
    }
  }, [clearError, reportError]);

  const stopBackground = useCallback(async () => {
    setBackgroundBusy(true);
    clearError();
    try {
      setBackground(await agentClient.backgroundStop());
      setBackgroundFrame(null);
    } catch (failure) {
      reportError('action', failure);
    } finally {
      setBackgroundBusy(false);
    }
  }, [clearError, reportError]);

  const phase = snapshot?.phase ?? 'idle';
  const running = isActiveAgentPhase(phase);
  const downgradeBlocked = Boolean(storageStatus?.downgradeBlocked);
  const storageNotice = useMemo(() => formatStorageNotice(storageStatus), [storageStatus]);
  const sessions = sessionsState?.sessions ?? [];
  const activeSession = useMemo(
    () =>
      sessions.find((s) => s.id === sessionsState?.activeSessionId) ?? sessions[0] ?? null,
    [sessions, sessionsState?.activeSessionId],
  );
  const sessionControlsLocked = running || busy || sessionBusy || downgradeBlocked;
  const pending = snapshot?.pendingApproval ?? null;
  const allowBlocked = isApprovalAllowBlocked(pending);
  const approvalExpired = isApprovalExpired(pending, approvalNow);
  const allowDisabled = isApprovalAllowDisabled(pending, approvalNow);
  const approvalCountdown = formatApprovalCountdown(pending, approvalNow);

  useEffect(() => {
    if (!active || !pending?.expiresAt) return;
    setApprovalNow(Date.now());
    const timer = setInterval(() => setApprovalNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, pending?.callId, pending?.digest, pending?.expiresAt]);
  const handoff = snapshot?.pendingHandoff ?? null;
  const recovery = snapshot?.recovery ?? null;
  const queue = snapshot?.queue ?? [];
  const events = snapshot?.events ?? [];
  const configured = Boolean(settings?.hasKey && settings.model);
  const sideEffects = hasRunSideEffects(events);
  const runFailureKey = snapshot &&
    (phase === 'failed' || (phase === 'interrupted' && isRecoverableInterruptedReason(snapshot.error)))
    ? `${snapshot.runId ?? ''}:${phase}:${snapshot.error ?? ''}`
    : null;
  const runFailurePlan = useMemo(() => {
    if (!snapshot || !runFailureKey || runFailureKey === dismissedRunKey) return null;
    return classifyAgentFailure({
      raw: snapshot.error ?? (phase === 'failed' ? '任务失败' : null),
      source: phase === 'interrupted' ? 'interrupted' : 'run',
      goal: snapshot.goal ?? null,
      hasSideEffects: sideEffects,
      background,
      autoStartEnabled,
    });
  }, [autoStartEnabled, background, dismissedRunKey, phase, runFailureKey, sideEffects, snapshot]);
  const actionErrorPlan = useMemo(() => {
    if (!actionError) return null;
    return classifyAgentFailure({
      raw: actionError.message,
      code: actionError.code,
      source: actionError.source,
      goal: draft.trim() || snapshot?.goal || null,
      hasSideEffects: false,
      background,
      autoStartEnabled,
    });
  }, [actionError, autoStartEnabled, background, draft, snapshot?.goal]);

  const handleRecoveryAction = useCallback(
    async (actionId: AgentRecoveryActionId, targetGoal: string | null, kind: 'run' | 'action') => {
      const clearSource = () => {
        if (kind === 'run' && runFailureKey) setDismissedRunKey(runFailureKey);
        if (kind === 'action') clearError();
      };
      switch (actionId) {
        case 'dismiss':
          clearSource();
          break;
        case 'refresh_snapshot':
          if (kind === 'action') clearError();
          await Promise.all([refresh(), refreshSettings(), refreshBackground()]);
          break;
        case 'edit_goal':
          if (targetGoal) setDraft(targetGoal);
          clearSource();
          break;
        case 'retry_goal':
          clearSource();
          if (targetGoal) submitGoal(targetGoal, false);
          break;
        case 'open_settings':
          nav.push('AgentSettings');
          break;
        case 'open_background':
          nav.push('BackgroundDisplay');
          break;
        case 'open_accessibility':
          await openAccessibility();
          break;
        case 'open_shizuku':
          await openShizuku();
          break;
        case 'retry_background':
          await retryBackground();
          break;
        case 'disable_auto_start':
          await disableAutoStart();
          break;
      }
    },
    [
      clearError,
      disableAutoStart,
      nav,
      openAccessibility,
      openShizuku,
      refresh,
      refreshBackground,
      refreshSettings,
      retryBackground,
      runFailureKey,
      submitGoal,
    ],
  );
  const backgroundPermissionMissing = Boolean(
    background && background.shizukuRunning && !background.permissionGranted,
  );
  const streamingBubble = useMemo(
    () => resolveStreamingBubble({ snapshot, thread, backgroundPermissionMissing }),
    [snapshot, thread, backgroundPermissionMissing],
  );
  const streamScope = `${snapshot?.runId ?? ''}:${snapshot?.step ?? 0}`;
  const instantReveal =
    reduceMotion || streamingBubble.mode === 'settling' || streamingBubble.mode === 'stopping';

  useEffect(() => {
    const targetLen = streamingBubble.targetText.length;
    if (!streamingBubble.visible || targetLen === 0) {
      streamScopeRef.current = streamScope;
      setRevealedLen(0);
      return;
    }
    if (instantReveal) {
      streamScopeRef.current = streamScope;
      setRevealedLen(targetLen);
      return;
    }
    if (streamScopeRef.current !== streamScope) {
      streamScopeRef.current = streamScope;
      setRevealedLen(advanceRevealedLength(0, targetLen, false));
      return;
    }
    if (revealedLen > targetLen) {
      setRevealedLen(targetLen);
      return;
    }
    if (revealedLen >= targetLen) return;
    const timer = setTimeout(() => {
      setRevealedLen((current) => advanceRevealedLength(current, targetLen, false));
    }, TYPEWRITER_TICK_MS);
    return () => clearTimeout(timer);
  }, [instantReveal, revealedLen, streamScope, streamingBubble.targetText.length, streamingBubble.visible]);

  const visibleStreamText = instantReveal
    ? streamingBubble.targetText
    : safeSlice(streamingBubble.targetText, revealedLen);
  useEffect(() => {
    if (background?.connected) setDismissedBgState(null);
  }, [background?.connected]);

  const bgFailureNeedsAttention = Boolean(
    background &&
      (autoStartEnabled
        ? !background.shizukuRunning ||
          !background.permissionGranted ||
          (!background.connected && isBackgroundFailureState(background.state))
        : !background.connected &&
          isBackgroundFailureState(background.state) &&
          background.state !== dismissedBgState),
  );
  const backgroundNeedsAttention = Boolean(!snapshot?.backgroundLost && bgFailureNeedsAttention);
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
          ? '启动 Shizuku 后回来重试，权限仍在时会自动恢复。'
          : '还没有安装 Shizuku。安装并启动后再回来授权。')
      : !background.permissionGranted
        ? (background.state === 'permission_denied'
            ? '上一次授权被拒绝。重新授权后会自动创建后台屏。'
            : 'Shizuku 授权已被撤销。重新授权后会自动恢复，任务不会切回主屏。')
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
    if (!active || !nearBottomRef.current) return;
    const timer = setTimeout(() => {
      if (nearBottomRef.current) scroll.current?.scrollToEnd({ animated: true });
    }, 60);
    return () => clearTimeout(timer);
  }, [active, thread.length, running, pending, handoff, queue.length, runFailurePlan, actionErrorPlan]);

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
              onPress={() => nav.push('AgentHistory')}
              accessibilityRole="button"
              accessibilityLabel="打开任务历史"
              hitSlop={8}
            >
              <Text style={styles.headerAction}>历史</Text>
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

      <View style={styles.sessionBar}>
        <Pressable
          onPress={() => setSessionsOpen((prev) => !prev)}
          accessibilityRole="button"
          accessibilityLabel={sessionsOpen ? '收起会话列表' : '切换会话'}
          style={styles.sessionToggle}
        >
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {truncateSessionTitle(activeSession?.title ?? '默认对话')}
          </Text>
          <Text style={styles.sessionMeta}>
            {sessions.length > 0 ? `会话 ${sessions.length}` : ''} · {thread.length} 条 {sessionsOpen ? '▴' : '▾'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void createNewSession()}
          disabled={sessionControlsLocked}
          accessibilityRole="button"
          accessibilityLabel="新建对话"
          style={[styles.newSessionBtn, sessionControlsLocked ? styles.muted : null]}
        >
          <Text style={styles.newSessionText}>+ 新会话</Text>
        </Pressable>
      </View>

      {sessionsOpen ? (
        <View style={styles.sessionDrawer}>
          {sessions.map((session) => {
            const isActive = session.id === (sessionsState?.activeSessionId ?? 'default');
            const isRenaming = renamingSessionId === session.id;
            return (
              <View key={session.id} style={[styles.sessionRow, isActive ? styles.sessionRowActive : null]}>
                {isRenaming ? (
                  <View style={styles.renameRow}>
                    <TextInput
                      style={styles.renameInput}
                      value={renameTitle}
                      onChangeText={setRenameTitle}
                      placeholder="输入会话名称"
                      placeholderTextColor={tv.colors.textFaint}
                      maxLength={40}
                      accessibilityLabel="会话新名称"
                    />
                    <Pressable onPress={() => void commitRenameSession()} style={styles.smallActionInline}>
                      <Text style={styles.smallActionText}>保存</Text>
                    </Pressable>
                    <Pressable onPress={() => setRenamingSessionId(null)} style={styles.smallActionInline}>
                      <Text style={styles.sessionMeta}>取消</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.sessionItemRow}>
                    <Pressable
                      onPress={() => {
                        if (!isActive && !sessionControlsLocked) void selectSession(session.id);
                      }}
                      disabled={sessionControlsLocked}
                      accessibilityRole="button"
                      accessibilityLabel={`切换到会话 ${session.title}`}
                      style={styles.sessionItemMain}
                    >
                      <Text style={[styles.sessionItemTitle, isActive ? styles.sessionItemTitleActive : null]} numberOfLines={1}>
                        {isActive ? '● ' : ''}{session.title}
                      </Text>
                      <Text style={styles.sessionMeta} numberOfLines={1}>
                        {session.messageCount} 条 · {formatShortTime(session.updatedAt) || '新建'}
                        {session.preview ? ` · ${session.preview}` : ''}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setRenamingSessionId(session.id);
                        setRenameTitle(session.title);
                      }}
                      disabled={sessionBusy || downgradeBlocked}
                      accessibilityRole="button"
                      accessibilityLabel={`重命名会话 ${session.title}`}
                      style={styles.smallActionInline}
                    >
                      <Text style={styles.smallActionText}>重命名</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => confirmDeleteSession(session)}
                      disabled={sessionControlsLocked}
                      accessibilityRole="button"
                      accessibilityLabel={`删除会话 ${session.title}`}
                      style={[styles.smallActionInline, sessionControlsLocked ? styles.muted : null]}
                    >
                      <Text style={styles.deleteSessionText}>删除</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ) : null}

      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.messages}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={64}
        onScroll={(event) => {
          const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent;
          nearBottomRef.current =
            distanceFromBottom({
              contentHeight: contentSize.height,
              offsetY: contentOffset.y,
              viewportHeight: layoutMeasurement.height,
            }) <= NEAR_BOTTOM_PX;
        }}
        onContentSizeChange={() => {
          if (nearBottomRef.current) scroll.current?.scrollToEnd({ animated: false });
        }}
      >
        {storageNotice ? (
          <View style={[styles.systemCard, storageNotice.tone === 'danger' ? styles.errorCard : styles.attentionCard]}>
            <Text style={styles.systemTitle}>{storageNotice.title}</Text>
            <Text style={styles.systemText}>{storageNotice.body}</Text>
          </View>
        ) : null}

        {recovery ? (
          <View style={[styles.systemCard, styles.attentionCard]}>
            <Text style={styles.systemTitle}>上次任务中断</Text>
            <Text style={styles.systemText}>{formatCrashRecoveryReason(recovery)}</Text>
            <Text style={styles.systemHint}>
              旧审批已失效，不会自动复活或重放。{recovery.requiresReconciliation
                ? ' 崩溃时可能正在执行有副作用的工具，结果未知。'
                : ' 这次没有未知副作用记录。'}
            </Text>
            <View style={styles.actions}>
              {recovery.goal ? (
                <Pressable
                  onPress={() => {
                    setDraft(recovery.goal!);
                    void dismissRecovery();
                  }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="填入上次任务到输入框"
                  style={[styles.secondaryBtn, busy ? styles.muted : null]}
                >
                  <Text style={styles.secondaryText}>填入输入框</Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => void dismissRecovery()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="知道了"
                style={styles.smallAction}
              >
                <Text style={styles.smallActionText}>知道了</Text>
              </Pressable>
            </View>
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
              {!downgradeBlocked ? (
                <Pressable
                  onPress={() => openSaveToMemory(message)}
                  accessibilityRole="button"
                  accessibilityLabel="将我的消息存为记忆"
                  hitSlop={6}
                  style={styles.bubbleSaveBtn}
                >
                  <Text style={styles.bubbleSaveText}>存为记忆</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <AssistantBubble
              key={`${message.at}-${index}`}
              text={message.text}
              styles={styles}
              onSaveToMemory={downgradeBlocked ? undefined : () => openSaveToMemory(message)}
            />
          )
        ))}

        {memoryToast ? (
          <View style={styles.systemCard}>
            <View style={styles.memoryToastRow}>
              <Text style={styles.systemHint}>{memoryToast}</Text>
              <Pressable onPress={() => nav.push('AgentMemory')} hitSlop={6}>
                <Text style={styles.smallActionText}>去查看</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {memoryDraft ? (
          <View style={[styles.systemCard, styles.setupCard]}>
            <Text style={styles.systemTitle}>显式存为本机记忆</Text>
            <Text style={styles.systemHint}>只在你确认保存后写入本机记忆；不会自动提取对话。</Text>
            <View style={styles.draftKindRow}>
              {MEMORY_KINDS.map((option) => {
                const selected = memoryDraft.kind === option;
                return (
                  <Pressable
                    key={option}
                    onPress={() => setMemoryDraft((prev) => (prev ? { ...prev, kind: option } : null))}
                    style={[styles.draftChip, selected ? styles.draftChipActive : null]}
                  >
                    <Text style={[styles.draftChipText, selected ? styles.draftChipTextActive : null]}>
                      {MEMORY_KIND_LABELS[option]}
                    </Text>
                  </Pressable>
                );
              })}
              <Pressable
                onPress={() => setMemoryDraft((prev) => (prev ? { ...prev, pinned: !prev.pinned } : null))}
                style={[styles.draftChip, memoryDraft.pinned ? styles.draftChipActive : null]}
              >
                <Text style={[styles.draftChipText, memoryDraft.pinned ? styles.draftChipTextActive : null]}>
                  {memoryDraft.pinned ? '★ 置顶' : '☆ 置顶'}
                </Text>
              </Pressable>
            </View>
            <TextInput
              style={styles.draftInput}
              value={memoryDraft.key}
              onChangeText={(nextKey) => setMemoryDraft((prev) => (prev ? { ...prev, key: nextKey } : null))}
              placeholder="记忆名称"
              placeholderTextColor={tv.colors.textFaint}
              maxLength={80}
              accessibilityLabel="快捷存记忆名称"
            />
            <TextInput
              style={[styles.draftInput, styles.draftValueInput]}
              value={memoryDraft.value}
              onChangeText={(nextValue) => setMemoryDraft((prev) => (prev ? { ...prev, value: nextValue } : null))}
              placeholder="记忆内容"
              placeholderTextColor={tv.colors.textFaint}
              maxLength={2000}
              multiline
              accessibilityLabel="快捷存记忆内容"
            />
            <View style={styles.actions}>
              <Pressable
                onPress={() => void submitMemoryDraft()}
                disabled={memorySaving}
                accessibilityRole="button"
                accessibilityLabel="确认保存到记忆"
                style={[styles.primaryBtn, memorySaving ? styles.muted : null]}
              >
                <Text style={styles.primaryText}>{memorySaving ? '保存中…' : '保存到记忆'}</Text>
              </Pressable>
              <Pressable
                onPress={() => setMemoryDraft(null)}
                disabled={memorySaving}
                accessibilityRole="button"
                accessibilityLabel="取消存为记忆"
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryText}>取消</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

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
              {background?.error ? (
                <Text style={styles.systemHint}>{background.error}</Text>
              ) : null}
              <View style={styles.actions}>
                {background && !background.shizukuRunning && background.installed ? (
                  <>
                    <Pressable
                      onPress={() => void openShizuku()}
                      disabled={backgroundBusy}
                      accessibilityRole="button"
                      accessibilityLabel="打开 Shizuku"
                      style={[styles.primaryBtn, backgroundBusy ? styles.muted : null]}
                    >
                      <Text style={styles.primaryText}>{backgroundBusy ? '处理中…' : '打开 Shizuku'}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void retryBackground()}
                      disabled={backgroundBusy}
                      accessibilityRole="button"
                      accessibilityLabel="重试后台屏并继续任务"
                      style={[styles.secondaryBtn, backgroundBusy ? styles.muted : null]}
                    >
                      <Text style={styles.secondaryText}>重试后台屏</Text>
                    </Pressable>
                  </>
                ) : (
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
                )}
                <Pressable
                  onPress={() => nav.push('BackgroundDisplay')}
                  accessibilityRole="button"
                  accessibilityLabel="打开后台屏设置"
                  style={styles.secondaryBtn}
                >
                  <Text style={styles.secondaryText}>后台屏设置</Text>
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
              <Text style={styles.systemHint}>
                参数摘要 {pending.digest.slice(0, 12)}…{approvalCountdown ? ` · ${approvalCountdown}` : ''}
              </Text>
              {pending.reason ? <Text style={styles.systemHint}>{pending.reason}</Text> : null}
              {Object.entries(pending.arguments).map(([key, value]) => (
                <View key={key} style={styles.argRow}>
                  <Text style={styles.argKey}>{key}</Text>
                  <Text style={styles.argValue} numberOfLines={3} selectable>
                    {typeof value === 'string' ? value : JSON.stringify(value)}
                  </Text>
                </View>
              ))}
              {approvalExpired ? (
                <Text
                  style={styles.approvalWarning}
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                >
                  审批已超时失效，本次操作不会执行。
                </Text>
              ) : null}
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
                  disabled={busy || allowDisabled}
                  accessibilityRole="button"
                  accessibilityLabel={
                    approvalExpired
                      ? '允许一次（已超时失效）'
                      : allowBlocked
                        ? '允许一次（后台屏已断开）'
                        : '允许一次'
                  }
                  style={[styles.primaryBtn, busy || allowDisabled ? styles.muted : null]}
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

        {streamingBubble.visible && streamingBubble.mode !== 'hidden' ? (
          <AgentStreamingBubble
            mode={streamingBubble.mode}
            statusLabel={streamingBubble.statusLabel}
            text={visibleStreamText}
            showCursor={streamingBubble.showCursor}
            canStop={streamingBubble.canStop}
            stopDisabled={busy || phase === 'stopping'}
            reduceMotion={reduceMotion}
            onStop={() => void stop()}
          />
        ) : null}

        {events.length > 0 ? (
          <View style={styles.assistantRow}>
            <View style={styles.timeline}>
              <Text style={styles.timelineTitle}>执行记录</Text>
              {events.slice(-8).map((event) => {
                const formatted = formatTimelineEvent(event);
                return (
                  <View key={`${event.seq}-${event.type}`} style={styles.timelineRow}>
                    <View
                      style={[
                        styles.timelineDot,
                        formatted.tone === 'ok'
                          ? styles.timelineDotDone
                          : formatted.tone === 'warning'
                            ? styles.timelineDotWarning
                            : formatted.tone === 'error'
                              ? styles.timelineDotError
                              : null,
                      ]}
                    />
                    <Text style={styles.timelineText} numberOfLines={2}>
                      {formatted.label}
                    </Text>
                  </View>
                );
              })}
              {!running && hasAccessibilityToolError(events) ? (
                <Pressable
                  onPress={() => void openAccessibility()}
                  accessibilityRole="button"
                  accessibilityLabel="打开无障碍设置"
                  style={styles.smallAction}
                >
                  <Text style={styles.smallActionText}>打开无障碍设置</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}

        {runFailurePlan ? (
          <AgentRecoveryCard
            plan={runFailurePlan}
            busy={busy || backgroundBusy}
            onAction={(actionId) => void handleRecoveryAction(actionId, snapshot?.goal ?? null, 'run')}
          />
        ) : null}

        {actionErrorPlan ? (
          <AgentRecoveryCard
            plan={actionErrorPlan}
            busy={busy || backgroundBusy}
            onAction={(actionId) => void handleRecoveryAction(actionId, draft.trim() || snapshot?.goal || null, 'action')}
          />
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
          {autoStartEnabled ? (
            <Pressable
              onPress={() => void disableAutoStart()}
              accessibilityRole="button"
              accessibilityLabel="关闭自动启动后台屏"
              style={styles.bgRecoveryAction}
            >
              <Text style={styles.bgRecoveryActionText}>关闭自动</Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                onPress={() => nav.push('BackgroundDisplay')}
                accessibilityRole="button"
                accessibilityLabel="打开后台屏设置"
                style={styles.bgRecoveryAction}
              >
                <Text style={styles.bgRecoveryActionText}>后台屏设置</Text>
              </Pressable>
              <Pressable
                onPress={() => setDismissedBgState(background?.state ?? null)}
                accessibilityRole="button"
                accessibilityLabel="忽略后台屏提示"
                style={styles.bgRecoveryAction}
              >
                <Text style={styles.bgRecoveryActionText}>忽略</Text>
              </Pressable>
            </>
          )}
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

      <AgentScreenOffNotice />

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

function AssistantBubble({
  text,
  styles,
  onSaveToMemory,
}: {
  text: string;
  styles: ReturnType<typeof makeStyles>;
  onSaveToMemory?: () => void;
}) {
  return (
    <View style={styles.assistantRow}>
      <View style={styles.assistantBubble}>
        <Text style={styles.assistantLabel}>管家</Text>
        <Text style={styles.assistantText} selectable>{text}</Text>
      </View>
      {onSaveToMemory ? (
        <Pressable
          onPress={onSaveToMemory}
          accessibilityRole="button"
          accessibilityLabel="将管家回复存为记忆"
          hitSlop={6}
          style={styles.bubbleSaveBtn}
        >
          <Text style={styles.bubbleSaveText}>存为记忆</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    scroll: { flex: 1 },
    messages: { paddingTop: tv.space.sm, paddingBottom: tv.space.lg },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headerAction: { color: C.accent, fontSize: tv.type.xs, fontWeight: '600' },
    sessionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: tv.layout.screenPadding,
      paddingVertical: 7,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
      backgroundColor: C.bgRaised,
      gap: 8,
    },
    sessionToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
    sessionTitle: { color: C.text, fontSize: tv.type.xs, fontWeight: '600', maxWidth: '58%' },
    sessionMeta: { color: C.textTertiary, fontSize: tv.type.micro },
    newSessionBtn: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: tv.radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.accent,
      backgroundColor: C.accentWash,
    },
    newSessionText: { color: C.accent, fontSize: tv.type.micro, fontWeight: '600' },
    sessionDrawer: {
      paddingHorizontal: tv.layout.screenPadding,
      paddingVertical: tv.space.sm,
      backgroundColor: C.bgRaised,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
      gap: 6,
    },
    sessionRow: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    sessionRowActive: { borderColor: C.accent, backgroundColor: C.accentWash },
    sessionItemRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    sessionItemMain: { flex: 1 },
    sessionItemTitle: { color: C.text, fontSize: tv.type.xs, fontWeight: '600' },
    sessionItemTitleActive: { color: C.accent },
    smallActionInline: { paddingHorizontal: 6, paddingVertical: 4 },
    deleteSessionText: { color: C.danger, fontSize: tv.type.micro },
    renameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    renameInput: {
      flex: 1,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      borderRadius: tv.radius.xs,
      color: C.text,
      fontSize: tv.type.xs,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    bubbleSaveBtn: { marginTop: 4, paddingHorizontal: 6, paddingVertical: 2 },
    bubbleSaveText: { color: C.textTertiary, fontSize: tv.type.micro },
    memoryToastRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    draftKindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: tv.space.sm },
    draftChip: {
      paddingHorizontal: 9,
      paddingVertical: 4,
      borderRadius: tv.radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      backgroundColor: C.bg,
    },
    draftChipActive: { borderColor: C.accent, backgroundColor: C.accentWash },
    draftChipText: { color: C.textSecondary, fontSize: tv.type.micro },
    draftChipTextActive: { color: C.accent, fontWeight: '600' },
    draftInput: {
      backgroundColor: C.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      borderRadius: tv.radius.sm,
      color: C.text,
      fontSize: tv.type.xs,
      paddingHorizontal: tv.space.sm,
      paddingVertical: 8,
      marginTop: tv.space.sm,
    },
    draftValueInput: { minHeight: 68, textAlignVertical: 'top' },
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
    timelineDotWarning: { backgroundColor: C.warning },
    timelineDotError: { backgroundColor: C.danger },
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
