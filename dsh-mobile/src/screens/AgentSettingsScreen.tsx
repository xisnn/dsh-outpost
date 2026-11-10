/**
 * P6-1 云端模型配置：协议、Base URL、模型名和 API Key。
 *
 * Key 只以 Android Keystore 加密后的形式落盘；保存后 bridge 不再把原文
 * 返回给 JS。这里不发起任何模型请求，连接是否可用由后续云端任务验证。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { SectionLabel } from '../components/ui';
import { SlideSegmented } from '../components/SlideSegmented';
import { useTheme } from '../design/theme';
import { useNav } from '../nav/NavHost';
import {
  agentClient,
  PROTOCOL_DEFAULT_BASE,
  PROTOCOL_LABELS,
  type AgentModelSettings,
  type AgentProtocol,
  type PhoneCapabilities,
} from '../core/agent';

const PROTOCOLS: AgentProtocol[] = [
  'OPENAI_COMPAT',
  'OPENAI_RESPONSES',
  'ANTHROPIC',
  'GEMINI',
];

function cloudBaseUrlAllowed(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

const SHORT_LABEL: Record<AgentProtocol, string> = {
  OPENAI_COMPAT: '兼容',
  OPENAI_RESPONSES: 'Responses',
  ANTHROPIC: 'Claude',
  GEMINI: 'Gemini',
};

export function AgentSettingsScreen() {
  const tv = useTheme();
  const nav = useNav();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [protocol, setProtocol] = useState<AgentProtocol>('OPENAI_COMPAT');
  const [baseUrl, setBaseUrl] = useState(PROTOCOL_DEFAULT_BASE.OPENAI_COMPAT);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [phone, setPhone] = useState<PhoneCapabilities | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const settings = await agentClient.getModelSettings();
      setProtocol(settings.protocol);
      setBaseUrl(settings.baseUrl || PROTOCOL_DEFAULT_BASE[settings.protocol]);
      setModel(settings.model);
      setHasKey(settings.hasKey);
      setError(null);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  const loadPhone = useCallback(async () => {
    try {
      setPhone(await agentClient.getPhoneCapabilities());
      setPhoneError(null);
    } catch (failure) {
      setPhoneError(String((failure as Error)?.message ?? failure));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadPhone();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void loadPhone();
    });
    return () => sub.remove();
  }, [load, loadPhone]);

  const openAccessibility = useCallback(() => {
    void agentClient.openAccessibilitySettings().catch((failure) => {
      setPhoneError(String((failure as Error)?.message ?? failure));
    });
  }, []);

  const openOverlay = useCallback(() => {
    void agentClient.openOverlaySettings().catch((failure) => {
      setPhoneError(String((failure as Error)?.message ?? failure));
    });
  }, []);

  const chooseProtocol = useCallback(
    (next: AgentProtocol) => {
      if (baseUrl.trim() === '' || baseUrl === PROTOCOL_DEFAULT_BASE[protocol]) {
        setBaseUrl(PROTOCOL_DEFAULT_BASE[next]);
      }
      setProtocol(next);
      setSaved(false);
    },
    [baseUrl, protocol],
  );

  const save = useCallback(async () => {
    const url = baseUrl.trim();
    const name = model.trim();
    if (!cloudBaseUrlAllowed(url)) {
      setError('Base URL 必须使用 HTTPS；只有 localhost / 127.0.0.1 可用 HTTP 做本地测试');
      return;
    }
    if (!name) {
      setError('请填写模型名');
      return;
    }
    if (!hasKey && !apiKey.trim()) {
      setError('请填写 API Key');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const settings: AgentModelSettings = await agentClient.saveModelSettings(
        protocol,
        url,
        name,
        apiKey.trim() || null,
      );
      setHasKey(settings.hasKey);
      setApiKey('');
      if (hasKey && !apiKey.trim() && !settings.hasKey) {
        // The native store drops the saved credential when the endpoint identity
        // changes, so the previous provider's key can never be sent to the new one.
        setError('服务商地址已变更，原 API Key 已清除；请重新填写后再运行云端任务');
        setSaved(false);
      } else {
        setSaved(true);
      }
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, [apiKey, baseUrl, hasKey, model, protocol]);

  const clear = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await agentClient.clearModelSettings();
      setProtocol('OPENAI_COMPAT');
      setBaseUrl(PROTOCOL_DEFAULT_BASE.OPENAI_COMPAT);
      setModel('');
      setApiKey('');
      setHasKey(false);
      setSaved(false);
    } catch (failure) {
      setError(String((failure as Error)?.message ?? failure));
    } finally {
      setBusy(false);
    }
  }, []);

  const confirmClear = useCallback(() => {
    Alert.alert(
      '清除模型设置？',
      '本机保存的 API Key 也会删除；下次运行云端任务前需要重新填写。',
      [
        { text: '取消', style: 'cancel' },
        { text: '清除', style: 'destructive', onPress: () => void clear() },
      ],
    );
  }, [clear]);

  const configured = hasKey && model.trim().length > 0;

  return (
    <View style={styles.root}>
      <Header title="模型与凭据" subtitle="P6-1 云端模型" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.notice}>
          API Key 只保存在本机 Android Keystore 加密区；保存后不会回显。任务内容会发送到你配置的服务商，
          可能产生费用。这里不会自动发起模型请求。
        </Text>

        <SectionLabel text="接口协议" />
        <View style={styles.card}>
          <SlideSegmented<AgentProtocol>
            compact
            options={PROTOCOLS.map((value) => ({ value, label: SHORT_LABEL[value] }))}
            value={protocol}
            onChange={chooseProtocol}
            accessibilityLabel="云端模型接口协议"
          />
          <Text style={styles.hint}>{PROTOCOL_LABELS[protocol]}</Text>
        </View>

        <SectionLabel text="服务地址" />
        <View style={styles.card}>
          <Text style={styles.label}>Base URL</Text>
          <TextInput
            style={styles.input}
            value={baseUrl}
            onChangeText={(value) => { setBaseUrl(value); setSaved(false); }}
            placeholder={PROTOCOL_DEFAULT_BASE[protocol]}
            placeholderTextColor={tv.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="模型服务地址"
          />
          <Text style={styles.label}>模型名</Text>
          <TextInput
            style={styles.input}
            value={model}
            onChangeText={(value) => { setModel(value); setSaved(false); }}
            placeholder="例如 deepseek-chat"
            placeholderTextColor={tv.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="模型名"
          />
        </View>

        <SectionLabel text="凭据" />
        <View style={styles.card}>
          <View style={styles.keyRow}>
            <Text style={styles.label}>API Key</Text>
            <Text style={[styles.keyState, hasKey ? styles.keySaved : null]}>
              {hasKey ? '已保存' : '未保存'}
            </Text>
          </View>
          <TextInput
            style={styles.input}
            value={apiKey}
            onChangeText={(value) => { setApiKey(value); setSaved(false); }}
            placeholder={hasKey ? '已保存；留空不修改' : '输入 API Key'}
            placeholderTextColor={tv.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="模型 API Key"
          />
          <Text style={styles.hint}>
            仅用于本机 Agent 的云端模型请求；不会写入日志、Run 记录或导出文件。
          </Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {saved ? <Text style={styles.saved}>已保存。返回 Agent 页可运行云端任务。</Text> : null}

        <View style={styles.actions}>
          <Pressable
            onPress={() => void save()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="保存模型设置"
            accessibilityState={{ disabled: busy }}
            style={[styles.primaryBtn, busy ? styles.muted : null]}
          >
            <Text style={styles.primaryText}>{busy ? '保存中…' : '保存设置'}</Text>
          </Pressable>
          <Pressable
            onPress={confirmClear}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="清除模型设置"
            style={[styles.dangerBtn, busy ? styles.muted : null]}
          >
            <Text style={styles.dangerText}>清除</Text>
          </Pressable>
        </View>

        <SectionLabel text="手机能力" />
        <View style={styles.card}>
          <View style={styles.keyRow}>
            <Text style={styles.label}>无障碍服务</Text>
            <Text
              style={[
                styles.keyState,
                phone?.accessibilityConnected ? styles.keySaved : null,
              ]}
            >
              {phone
                ? !phone.supported
                  ? '系统不支持'
                  : phone.accessibilityConnected
                    ? '已连接'
                    : phone.accessibilityEnabled
                      ? '等待连接'
                      : '未开启'
                : '检测中'}
            </Text>
          </View>
          <Text style={styles.hint}>
            开启后 Agent 可读取当前屏幕元素，并使用点击、输入、滚动、返回/Home、打开应用等工具。
            每个有副作用的动作仍需一次性确认；密码、支付和系统设置页面会自动交还给你。
          </Text>
          <Text style={styles.hint}>
            悬浮条：{phone?.overlayAllowed ? '已授权，运行中可从其他应用暂停/停止/确认' : '未授权，仅能在 App 内控制'}
            {phone?.screenLocked ? ' · 屏幕已锁定' : ''}
          </Text>
          {phoneError ? <Text style={styles.error}>{phoneError}</Text> : null}
          <View style={styles.phoneActions}>
            <Pressable
              onPress={openAccessibility}
              accessibilityRole="button"
              accessibilityLabel="打开无障碍设置"
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryText}>无障碍设置</Text>
            </Pressable>
            <Pressable
              onPress={openOverlay}
              accessibilityRole="button"
              accessibilityLabel="打开悬浮条设置"
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryText}>悬浮条设置</Text>
            </Pressable>
            <Pressable
              onPress={() => void loadPhone()}
              accessibilityRole="button"
              accessibilityLabel="刷新手机能力"
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryText}>刷新</Text>
            </Pressable>
          </View>
        </View>

        <SectionLabel text="实验" />
        <View style={styles.card}>
          <Text style={styles.label}>后台虚拟屏（Shizuku）</Text>
          <Text style={styles.hint}>
            让目标 App 在独立副屏上运行，主屏仍可继续使用。需要安装并启动 Shizuku；
            这一页只控制副屏，不改变当前前台 Agent 的聊天和审批。
          </Text>
          <View style={styles.phoneActions}>
            <Pressable
              onPress={() => nav.push('BackgroundDisplay')}
              accessibilityRole="button"
              accessibilityLabel="打开后台屏实验"
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryText}>打开后台屏实验</Text>
            </Pressable>
          </View>
        </View>

        <Text style={styles.footnote}>
          当前状态：{configured ? '已配置，可运行云端任务' : '未配置完整，云端任务不可用'}。
        </Text>
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
      marginTop: tv.space.sm,
      marginBottom: 6,
    },
    input: {
      backgroundColor: C.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      borderRadius: tv.radius.sm,
      color: C.text,
      fontSize: tv.type.sm,
      paddingHorizontal: tv.space.md,
      paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    },
    keyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    keyState: { color: C.textTertiary, fontSize: tv.type.micro },
    keySaved: { color: C.success },
    hint: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      marginTop: tv.space.sm,
    },
    error: {
      color: C.danger,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
    },
    saved: {
      color: C.success,
      fontSize: tv.type.xs,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.md,
    },
    actions: {
      flexDirection: 'row',
      gap: 8,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.lg,
    },
    primaryBtn: {
      minHeight: 44,
      paddingHorizontal: 18,
      borderRadius: tv.radius.sm,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    dangerBtn: {
      minHeight: 44,
      paddingHorizontal: 18,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dangerText: { color: C.danger, fontSize: tv.type.sm },
    phoneActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: tv.space.md },
    secondaryBtn: {
      minHeight: 40,
      paddingHorizontal: 12,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryText: { color: C.text, fontSize: tv.type.sm },
    muted: { opacity: 0.55 },
    footnote: {
      color: C.textFaint,
      fontSize: tv.type.xs,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.lg,
    },
  });
}
