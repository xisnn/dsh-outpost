/**
 * 配对屏：输入服务地址 + token。
 *
 * 视觉：居中品牌区 + 两个输入框 + 主按钮。
 * 首次成功后 cookie 存 AsyncStorage（30 天有效）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Clipboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApp } from '../App';
import { useTheme } from '../design/theme';
import { radius, space, type, weight } from '../design/tokens';
import { GradientFill } from '../components/ui';
import { ScanSheet } from '../components/ScanSheet';
import { PairingHelpSheet } from '../components/PairingHelpSheet';

import { parsePairingText } from '../core/pairing';
import { checkBaseUrlSecurity } from '../core/net-security';


export function PairScreen() {
  const { baseUrl, setBaseUrl, saveCookie, hasLastPairing, resumePairing } = useApp();
  const insets = useSafeAreaInsets();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [url, setUrl] = useState(baseUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<{ baseUrl?: string; token: string } | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [resuming, setResuming] = useState(false);

  // 打开配对页时看一眼剪贴板：有配对链接就直接给个「一键使用」。
  // 注意：Android 10+ 在应用不在前台时读剪贴板会返回空，冷启动可能读不到，
  // 所以下面还会在回到前台时再读一次。
  const readClip = async () => {
    try {
      const raw = await Clipboard.getString();
      if (!raw) return;
      const parsed = parsePairingText(raw);
      if (parsed) setClip(parsed);
    } catch {
      // 读不到剪贴板就算了
    }
  };

  useEffect(() => {
    void readClip();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void readClip();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const useClip = () => {
    if (!clip) return;
    if (clip.baseUrl) setUrl(clip.baseUrl);
    setToken(clip.token);
    setClip(null);
  };

  const doResume = async () => {
    setResuming(true);
    setError(null);
    const ok = await resumePairing();
    setResuming(false);
    if (!ok) setError('上次的配对已失效，请用电脑上的 token 重新配对');
  };

  const connect = async (override?: { url?: string; token?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const raw = (override?.token ?? token).trim();
      if (!raw) throw new Error('请填 token');

      // token 框里黏进来的可能是完整 URL —— 那就连地址一起认出来，
      // 用户就不用再单独填服务地址了。
      const parsed = parsePairingText(raw);
      const trimmedUrl = (parsed?.baseUrl ?? override?.url ?? url).trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(trimmedUrl)) {
        throw new Error('地址要以 http:// 或 https:// 开头');
      }

      // 地址安全校验：明文 HTTP 只能连私有地址。
      // 放在这里是为了给出更友好的提示 —— loginWithToken 里也会校验，
      // 但那时报错已经埋在「连接失败」里，用户不容易看懂。
      const insecure = checkBaseUrlSecurity(trimmedUrl);
      if (insecure) throw new Error(insecure);

      const extracted = parsed?.token ?? raw;

      // 容错：token 只用 URL-safe base64 字符（A-Z a-z 0-9 - _）。
      // 有些输入法/复制路径会把下划线变成连字符（或反之），
      // 而两者在 base64url 里含义不同 —— 这里对两种变体都试一次。
      const candidates = new Set<string>([extracted]);
      if (extracted.includes('-')) candidates.add(extracted.replace(/-/g, '_'));
      if (extracted.includes('_')) candidates.add(extracted.replace(/_/g, '-'));

      setBaseUrl(trimmedUrl);

      const { DshConnection } = await import('../core/transport');
      const { Store } = await import('../core/store');

      let cookie: string | undefined;
      let lastErr: unknown;
      for (const candidate of candidates) {
        const conn = new DshConnection({ baseUrl: trimmedUrl });
        const store = new Store(conn);
        try {
          cookie = await store.loginWithToken(candidate);
          const ok = await store.ping();
          if (!ok) throw new Error('cookie 已拿到但验证失败，请检查服务是否正常');
          store.close();
          break;
        } catch (e) {
          lastErr = e;
          store.close();
          cookie = undefined;
        }
      }
      if (!cookie) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));

      await saveCookie(cookie);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };


  const canSubmit = !!url.trim() && !!token.trim() && !busy;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* 右上角：连接帮助入口 */}
      <Pressable
        onPress={() => setHelpOpen(true)}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="怎么连接电脑"
        style={({ pressed }: { pressed: boolean }) => [
          styles.helpTop,
          { top: insets.top + 8 },
          pressed ? { opacity: 0.55 } : null,
        ]}
      >
        <Text style={styles.helpTopIcon}>?</Text>
        <Text style={styles.helpTopText}>怎么连接电脑</Text>
      </Pressable>

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 72, paddingBottom: insets.bottom + space.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* 品牌区 */}
        <View style={styles.brand}>
          <View style={styles.logo}>
            <GradientFill
              stops={[tv.colors.iconFrom, tv.colors.iconTo]}
              borderRadius={22}
            />
            <Text style={styles.logoText}>DS</Text>
          </View>
          <Text style={styles.h1}>连接 DSH</Text>
          <Text style={styles.hint}>
            扫电脑上的二维码，或粘贴那行带 token 的链接{'\n'}配对一次，30 天内免登录
          </Text>
        </View>

        {/* 上次配对还在：一键恢复（误触退出后不用再找 token） */}
        {hasLastPairing ? (
          <Pressable
            onPress={() => void doResume()}
            disabled={resuming}
            style={({ pressed }: { pressed: boolean }) => [
              styles.resumeCard,
              pressed ? { opacity: 0.8 } : null,
            ]}
          >
            <View style={styles.resumeBody}>
              <Text style={styles.resumeTitle}>上次的配对还在</Text>
              <Text style={styles.resumeSub} numberOfLines={1}>
                {baseUrl}
              </Text>
            </View>
            {resuming ? (
              <ActivityIndicator color={tv.colors.accent} size="small" />
            ) : (
              <Text style={styles.resumeAction}>直接继续</Text>
            )}
          </Pressable>
        ) : null}

        {/* 剪贴板里有配对链接：一键使用 */}
        {clip ? (
          <Pressable
            onPress={useClip}
            style={({ pressed }: { pressed: boolean }) => [
              styles.clipCard,
              pressed ? { opacity: 0.8 } : null,
            ]}
          >
            <View style={styles.clipBody}>
              <Text style={styles.clipTitle}>检测到剪贴板里的配对信息</Text>
              <Text style={styles.clipSub} numberOfLines={1}>
                {clip.baseUrl ? `${clip.baseUrl} · ` : ''}
                {clip.token.slice(0, 12)}…
              </Text>
            </View>
            <Text style={styles.clipAction}>一键使用</Text>
          </Pressable>
        ) : null}

        {/* 表单 */}
        <View style={styles.form}>
          <Text style={styles.label}>服务地址</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="http://192.168.1.10:3095"
            placeholderTextColor={tv.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <View style={styles.labelRow}>
            <Text style={styles.label}>Token</Text>
            <View style={styles.labelActions}>
              <Pressable onPress={() => setScanOpen(true)} hitSlop={10}>
                <Text style={styles.pasteBtn}>扫码</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  void (async () => {
                    try {
                      const raw = await Clipboard.getString();
                      const parsed = raw ? parsePairingText(raw) : null;
                      if (parsed) {
                        if (parsed.baseUrl) setUrl(parsed.baseUrl);
                        setToken(parsed.token);
                        setClip(null);
                      } else {
                        setError('剪贴板里没有认出 token');
                      }
                    } catch {
                      setError('读不到剪贴板');
                    }
                  })();
                }}
                hitSlop={10}
              >
                <Text style={styles.pasteBtn}>粘贴</Text>
              </Pressable>
            </View>
          </View>
          <TextInput
            style={[styles.input, styles.inputArea]}
            value={token}
            onChangeText={setToken}
            placeholder="粘贴完整链接，或只粘贴 token"
            placeholderTextColor={tv.colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }: { pressed: boolean }) => [
              styles.button,
              !canSubmit ? styles.buttonDisabled : null,
              pressed && canSubmit ? { opacity: 0.85 } : null,
            ]}
            onPress={() => void connect()}
            disabled={!canSubmit}
          >
            {busy ? (
              <ActivityIndicator color={tv.colors.onAccent} />
            ) : (
              <Text style={styles.buttonText}>连接</Text>
            )}
          </Pressable>

          <Text style={styles.footnote}>
            token 只在本次服务进程内有效，服务重启后需要重新获取。
          </Text>
        </View>
      </ScrollView>

      <PairingHelpSheet visible={helpOpen} onClose={() => setHelpOpen(false)} />

      <ScanSheet
        visible={scanOpen}
        onClose={() => setScanOpen(false)}
        onScanned={(text) => {
          setScanOpen(false);
          const parsed = parsePairingText(text);
          if (!parsed) {
            setError('这个二维码不是 DSH 的配对链接');
            return;
          }
          if (parsed.baseUrl) setUrl(parsed.baseUrl);
          setToken(parsed.token);
          void connect({ url: parsed.baseUrl ?? url, token: parsed.token });
        }}
      />
    </KeyboardAvoidingView>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    content: { paddingHorizontal: space.xl },

    // 上次配对 / 剪贴板提示卡片
    resumeCard: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: space.xs,
      marginBottom: space.md,
      padding: space.md,
      borderRadius: radius.md,
      backgroundColor: C.accentWash,
    },
    resumeBody: { flex: 1, marginRight: space.sm },
    resumeTitle: { color: C.accentBright, fontSize: type.sm, fontWeight: weight.semibold },
    resumeSub: { color: C.textTertiary, fontSize: type.micro, marginTop: 2 },
    resumeAction: { color: C.accentBright, fontSize: type.sm, fontWeight: weight.medium },

    clipCard: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: space.xs,
      marginBottom: space.md,
      padding: space.md,
      borderRadius: radius.md,
      backgroundColor: C.bgCard,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
    },
    clipBody: { flex: 1, marginRight: space.sm },
    clipTitle: { color: C.text, fontSize: type.sm, fontWeight: weight.medium },
    clipSub: { color: C.textTertiary, fontSize: type.micro, marginTop: 2 },
    clipAction: { color: C.accentBright, fontSize: type.sm, fontWeight: weight.medium },

    labelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: space.lg,
    },
    pasteBtn: { color: C.accentBright, fontSize: type.sm, fontWeight: weight.medium },
    helpTop: {
      position: 'absolute',
      right: space.lg,
      zIndex: 3,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 6,
      paddingHorizontal: 10,
    },
    helpTopIcon: {
      color: C.accentBright,
      fontSize: type.sm,
      fontWeight: weight.semibold,
      marginRight: 4,
    },
    helpTopText: { color: C.accentBright, fontSize: type.sm },
    labelActions: { flexDirection: 'row', alignItems: 'center', gap: space.md },

    brand: { alignItems: 'center', marginBottom: space.xxxl },
    logo: {
      width: 76,
      height: 76,
      borderRadius: 22,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: space.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.accentDim,
    },
    logoText: {
      color: C.accentBright,
      fontSize: 27,
      fontWeight: weight.bold,
      letterSpacing: 1,
    },
    h1: {
      color: C.text,
      fontSize: type.title,
      fontWeight: weight.bold,
      letterSpacing: -0.6,
      marginBottom: space.sm,
    },
    hint: {
      color: C.textTertiary,
      fontSize: type.sm,
      lineHeight: type.sm * 1.65,
      textAlign: 'center',
    },

    form: { width: '100%' },
    label: {
      color: C.textTertiary,
      fontSize: type.micro,
      fontWeight: weight.semibold,
      letterSpacing: 0.7,
      textTransform: 'uppercase',
      marginBottom: space.sm,
    },
    input: {
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      borderRadius: radius.md,
      color: C.text,
      fontSize: type.base,
      paddingHorizontal: space.lg,
      paddingVertical: Platform.OS === 'ios' ? 14 : 12,
    },
    inputArea: { minHeight: 76, textAlignVertical: 'top' },

    button: {
      backgroundColor: C.accent,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 15,
      marginTop: space.xxl,
    },
    buttonDisabled: { backgroundColor: C.bgOverlay },
    buttonText: { color: C.onAccent, fontSize: type.base, fontWeight: weight.bold },

    errorBox: {
      backgroundColor: C.dangerWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
      borderRadius: radius.sm,
      padding: space.md,
      marginTop: space.lg,
    },
    errorText: { color: C.danger, fontSize: type.xs, lineHeight: type.xs * 1.5 },

    footnote: {
      color: C.textFaint,
      fontSize: type.micro,
      marginTop: space.xl,
      lineHeight: type.micro * 1.6,
      textAlign: 'center',
    },
  });
}
