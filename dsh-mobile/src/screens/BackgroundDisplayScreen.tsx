/**
 * 实验：Shizuku 后台虚拟屏。
 *
 * 只负责展示/控制“副屏”这一层：Shizuku 权限、UserService 连接、displayId、
 * 打开设置/联系人、缩略帧。它不改变 P6 的主屏 Agent 路径；后台屏不可用时
 * 仍然可以使用前台聊天和审批。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { SectionLabel } from '../components/ui';
import { useTheme } from '../design/theme';
import {
  agentClient,
  type BackgroundDisplayStatus,
} from '../core/agent';

const EMPTY: BackgroundDisplayStatus = {
  supported: false,
  installed: false,
  shizukuRunning: false,
  permissionGranted: false,
  connected: false,
  displayId: -1,
  frameAvailable: false,
  state: 'idle',
  error: null,
};

const failureText = (failure: unknown): string => String((failure as Error)?.message ?? failure);

export function BackgroundDisplayScreen() {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [status, setStatus] = useState<BackgroundDisplayStatus>(EMPTY);
  const [frame, setFrame] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The 1s status poll carries its own error field; without a source tag it
  // also wipes whatever an action just reported.
  const errorSource = useRef<'read' | 'action' | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await agentClient.backgroundStatus();
      setStatus(next);
      if (errorSource.current !== 'action') {
        errorSource.current = next.error ? 'read' : null;
        setError(next.error ?? null);
      }
    } catch (failure) {
      errorSource.current = 'read';
      setError(failureText(failure));
    }
  }, []);

  useEffect(() => {
    void agentClient.getBackgroundAutoStart()
      .then((value) => setAutoStart(value.enabled))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      await refresh();
      if (!stopped) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!status.connected) {
      setFrame(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        const next = await agentClient.backgroundFrame();
        if (!stopped && next) setFrame(next);
      } catch {
        // The status poll reports connection errors; a dropped frame is harmless.
      }
      if (!stopped) timer = setTimeout(tick, 700);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [status.connected]);

  const start = useCallback(async () => {
    setBusy(true);
    errorSource.current = null;
    setError(null);
    try {
      setStatus(await agentClient.backgroundStart());
    } catch (failure) {
      errorSource.current = 'action';
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const launch = useCallback(async (packageName: string) => {
    setBusy(true);
    errorSource.current = null;
    setError(null);
    try {
      setStatus(await agentClient.backgroundLaunch(packageName));
    } catch (failure) {
      errorSource.current = 'action';
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleAutoStart = useCallback(async (next: boolean) => {
    setAutoStart(next);
    errorSource.current = null;
    setError(null);
    try {
      await agentClient.setBackgroundAutoStart(next);
      if (next) {
        setBusy(true);
        setStatus(await agentClient.backgroundStart());
      }
    } catch (failure) {
      // Roll the switch back: leaving it on while the store rejected the write
      // tells the user auto-start is armed when it is not.
      setAutoStart(!next);
      errorSource.current = 'action';
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    errorSource.current = null;
    setError(null);
    try {
      setStatus(await agentClient.backgroundStop());
      setFrame(null);
    } catch (failure) {
      errorSource.current = 'action';
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const openShizuku = useCallback(async () => {
    setBusy(true);
    errorSource.current = null;
    setError(null);
    try {
      const result = await agentClient.backgroundOpenShizuku();
      if (!result.opened) {
        errorSource.current = 'action';
        setError(result.installed ? '未能打开 Shizuku' : '未安装 Shizuku');
      }
    } catch (failure) {
      errorSource.current = 'action';
      setError(failureText(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const connected = status.connected && status.displayId > 0;
  const usable = connected && status.permissionGranted;
  const needsAuthorize = status.shizukuRunning && !status.permissionGranted;
  const startLabel = needsAuthorize ? '重新授权后台屏' : '启动后台屏';

  return (
    <View style={styles.root}>
      <Header title="后台屏（实验）" subtitle="Shizuku 虚拟屏" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.notice}>
          实验功能。后台屏通过 Shizuku 的 shell 身份创建，目标 App 运行在独立虚拟屏上；
          你的主屏仍可继续使用。需要先安装并启动 Shizuku，再授权本应用。
          它不会改变当前前台 Agent 的聊天、审批和记忆。
        </Text>

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>自动启动</Text>
            <Switch
              value={autoStart}
              onValueChange={(value) => void toggleAutoStart(value)}
              trackColor={{ false: tv.colors.borderStrong, true: tv.colors.accentDim }}
              thumbColor={autoStart ? tv.colors.accent : tv.colors.textTertiary}
              accessibilityLabel="自动启动后台屏"
            />
          </View>
          <Text style={styles.hint}>
            开启后，进入聊天或开始任务时自动连接/创建副屏；Run 队列结束后自动释放，也可以在这里或 PiP 手动停止。
          </Text>
        </View>

        <SectionLabel text="状态" />
        <View style={styles.card}>
          <Row styles={styles} label="Android" value={status.supported ? '支持' : '需要 Android 12+'} />
          <Row
            styles={styles}
            label="Shizuku"
            value={!status.installed ? '未安装' : status.shizukuRunning ? '运行中' : '未运行'}
            good={status.shizukuRunning}
          />
          <Row styles={styles} label="权限" value={status.permissionGranted ? '已授权' : '未授权'} good={status.permissionGranted} />
          <Row styles={styles} label="UserService" value={status.connected ? '已连接' : '未连接'} good={status.connected} />
          <Row styles={styles} label="displayId" value={status.displayId > 0 ? String(status.displayId) : '—'} />
          <Row styles={styles} label="画面" value={status.frameAvailable ? '有帧' : '暂无'} good={status.frameAvailable} />
          <Text style={styles.state}>状态：{status.state}</Text>
          {needsAuthorize ? (
            <Text style={styles.error}>
              {status.state === 'permission_revoked'
                ? 'Shizuku 授权已被撤销。重新授权后会自动重建后台屏，不会切回主屏。'
                : '还没有 Shizuku 授权。点「重新授权后台屏」继续。'}
            </Text>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        <SectionLabel text="控制" />
        <View style={styles.actions}>
          <Pressable
            onPress={() => void start()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={startLabel}
            style={[styles.primaryBtn, busy ? styles.muted : null]}
          >
            <Text style={styles.primaryText}>{busy ? '处理中…' : startLabel}</Text>
          </Pressable>
          {status.installed && !status.shizukuRunning ? (
            <Pressable
              onPress={() => void openShizuku()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="打开 Shizuku"
              style={[styles.secondaryBtn, busy ? styles.muted : null]}
            >
              <Text style={styles.secondaryText}>打开 Shizuku</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => void launch('com.android.settings')}
            disabled={busy || !usable}
            accessibilityRole="button"
            accessibilityLabel="在后台屏打开设置"
            style={[styles.secondaryBtn, busy || !usable ? styles.muted : null]}
          >
            <Text style={styles.secondaryText}>打开设置</Text>
          </Pressable>
          <Pressable
            onPress={() => void launch('com.android.contacts')}
            disabled={busy || !usable}
            accessibilityRole="button"
            accessibilityLabel="在后台屏打开联系人"
            style={[styles.secondaryBtn, busy || !usable ? styles.muted : null]}
          >
            <Text style={styles.secondaryText}>打开联系人</Text>
          </Pressable>
          <Pressable
            onPress={() => void stop()}
            disabled={busy || !status.connected}
            accessibilityRole="button"
            accessibilityLabel="停止并释放后台屏"
            style={[styles.dangerBtn, busy || !status.connected ? styles.muted : null]}
          >
            <Text style={styles.dangerText}>停止并释放</Text>
          </Pressable>
        </View>

        <SectionLabel text="副屏预览" />
        <View style={styles.previewCard}>
          {frame ? (
            <Image
              source={{ uri: `data:image/png;base64,${frame}` }}
              style={styles.preview}
              resizeMode="contain"
              accessibilityLabel="后台屏实时预览"
            />
          ) : (
            <View style={styles.previewEmpty}>
              {status.connected ? (
                <ActivityIndicator color={tv.colors.accent} />
              ) : (
                <Text style={styles.previewEmptyText}>启动后显示副屏画面</Text>
              )}
            </View>
          )}
        </View>

        <SectionLabel text="准备" />
        <View style={styles.card}>
          <Text style={styles.hint}>1. 安装 Shizuku，并按它的向导用无线调试/ADB 启动服务。</Text>
          <Text style={styles.hint}>2. 回到这里点「启动后台屏」，在系统弹窗里允许 Shizuku 权限。</Text>
          <Text style={styles.hint}>3. 首次只支持设置/联系人；后续再把读屏、点击、输入接进 Agent。</Text>
          <Text style={styles.hint}>
            注意：Shizuku 未运行、被系统杀掉或权限被撤销时，这里会显示失败；前台管家照常可用。
          </Text>
          <Text style={styles.hint}>
            权限被撤销后不会继续自动重试；重新授权（这里或系统里的 Shizuku 管理页）后会自动重建后台屏。
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Row({
  styles,
  label,
  value,
  good,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, good ? styles.good : null]}>{value}</Text>
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
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, gap: 12 },
    label: { color: C.textTertiary, fontSize: tv.type.xs },
    value: { color: C.textSecondary, fontSize: tv.type.xs, textAlign: 'right', flexShrink: 1 },
    good: { color: C.success },
    state: { color: C.textFaint, fontSize: tv.type.micro, marginTop: tv.space.sm },
    error: { color: C.danger, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.sm },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginHorizontal: tv.layout.screenPadding },
    primaryBtn: {
      minHeight: 44,
      paddingHorizontal: 16,
      borderRadius: tv.radius.sm,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    secondaryBtn: {
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryText: { color: C.text, fontSize: tv.type.sm },
    dangerBtn: {
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dangerText: { color: C.danger, fontSize: tv.type.sm },
    muted: { opacity: 0.5 },
    previewCard: {
      marginHorizontal: tv.layout.screenPadding,
      borderRadius: tv.radius.md,
      backgroundColor: '#000',
      overflow: 'hidden',
    },
    preview: { width: '100%', height: 360 },
    previewEmpty: { height: 220, alignItems: 'center', justifyContent: 'center' },
    previewEmptyText: { color: '#777', fontSize: tv.type.xs },
    hint: { color: C.textTertiary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.6, marginTop: 4 },
  });
}
