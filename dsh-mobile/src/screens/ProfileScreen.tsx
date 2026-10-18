/**
 * 我的：账户余额、token 用量、外观主题、服务信息。
 *
 * 数据来源：
 *   余额  ← account/getBalance（主钱包 + 赠金钱包）
 *   用量  ← 各会话 projections.values.tokenUsage 求和（session/list 已带）
 *   主题  ← useTheme()，切换后写入 AsyncStorage，下次启动生效
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useApp } from '../App';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import { themeLabels, type ThemeMode } from '../design/tokens';
import { formatCount, formatMoney, sumWallets } from '../core/rpc/account';
import { SectionLabel } from '../components/ui';
import { ConfirmSheet } from '../components/ConfirmSheet';

/** 一个币种的余额构成 */
interface MoneyLine {
  currency: string;
  main: number;
  bonus: number;
  total: number;
}

const NET_LABELS: Record<NetState, string> = {
  checking: '检测中…',
  ok: '正常',
  fail: '连接失败',
};

type NetState = 'checking' | 'ok' | 'fail';

export function ProfileScreen({ active = true }: { active?: boolean }) {
  const { store, baseUrl, signOut, butlerMode, setButlerMode, butlerBusy } = useApp();
  const nav = useNav();
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [, force] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // store.connection 反映的是聊天流的 WS 状态，在「我的」里恒为 idle，
  // 所以这里单独 ping 一次，给用户一个真实的连通性结论。
  const [net, setNet] = useState<NetState>('checking');
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const checkNet = useCallback(async () => {
    setNet('checking');
    try {
      setNet((await store.ping()) ? 'ok' : 'fail');
    } catch {
      setNet('fail');
    }
  }, [store]);

  // 订阅 + 预取：即使还在别的 tab 上也先拉，点进来就有数
  useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    if (!store.balanceFresh() && !store.balanceLoading) void store.loadAccount();
    if (store.workspaces.length === 0) void store.loadSessions();
    return unsub;
  }, [store]);

  // 连通性只在页面真正可见时测一次，避免启动时白打一次请求
  useEffect(() => {
    if (active) void checkNet();
  }, [active, checkNet]);

  // 再次进入时如果余额过了 TTL，静默刷新（不闪 loading）
  useEffect(() => {
    if (active && !store.balanceFresh()) void store.loadAccount();
  }, [active, store]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([store.loadAccount(), store.loadSessions(), checkNet()]);
    setRefreshing(false);
  }, [store, checkNet]);

  /** 余额：按币种拆成「主余额 / 赠金 / 合计」 */
  const money = useMemo<MoneyLine[]>(() => {
    const b = store.balance;
    if (!b || b.status !== 'ready') return [];
    const main = sumWallets(b.value);
    const bonus = sumWallets(b.bonusWallets);
    const currencies = [...new Set([...Object.keys(main), ...Object.keys(bonus)])];
    return currencies
      .map((currency) => ({
        currency,
        main: main[currency] ?? 0,
        bonus: bonus[currency] ?? 0,
        total: (main[currency] ?? 0) + (bonus[currency] ?? 0),
      }))
      .sort((a, b2) => b2.total - a.total);
  }, [store.balance]);

  /** 用量：所有会话累加 */
  const usage = useMemo(() => {
    const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 };
    for (const w of store.workspaces) {
      for (const s of w.sessions) {
        acc.sessions += 1;
        const u = s.projections?.values?.tokenUsage;
        if (!u) continue;
        acc.input += u.uncachedInputTokens ?? 0;
        acc.output += u.outputTokens ?? 0;
        acc.cacheRead += u.cacheReadTokens ?? 0;
        acc.cacheWrite += u.cacheWriteTokens ?? 0;
      }
    }
    return acc;
  }, [store.workspaces]);

  const openLink = useCallback((url?: string) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    void Linking.openURL(url).catch(() => undefined);
  }, []);

  const topUpUrl = store.accountLinks.topUpUrl;
  const usageUrl = store.accountLinks.usageUrl;

  const primary = money[0];

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.headerTitle}>我的</Text>
        <Text style={styles.headerSub} numberOfLines={1}>
          {baseUrl.replace(/^https?:\/\//, '')}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={tv.colors.textTertiary}
            colors={[tv.colors.accent]}
            progressBackgroundColor={tv.colors.bgCard}
          />
        }
      >
        {/* ── 余额 ─────────────────────────────────────── */}
        <View style={styles.balanceCard}>
          <View style={styles.balanceTop}>
            <Text style={styles.balanceLabel}>账户余额</Text>
            {store.balanceLoading ? (
              <ActivityIndicator size="small" color={tv.colors.textTertiary} />
            ) : null}
          </View>

          {primary ? (
            <Text style={styles.balanceValue}>{formatMoney(primary.total, primary.currency)}</Text>
          ) : store.balanceLoading ? (
            <Text style={styles.balanceValue}>—</Text>
          ) : (
            <Text style={styles.balanceValue}>—</Text>
          )}

          {money.length > 0 ? (
            <View style={styles.moneyRows}>
              {money.map((m) => (
                <View key={m.currency} style={styles.moneyRow}>
                  <Text style={styles.moneyKey}>
                    {m.currency === 'CNY' ? '人民币' : m.currency === 'USD' ? '美元' : m.currency}
                  </Text>
                  <Text style={styles.moneyVal}>
                    主 {formatMoney(m.main, m.currency)} · 赠金 {formatMoney(m.bonus, m.currency)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {store.balanceError ? (
            <View style={styles.errorWrap}>
              <Text style={styles.errorText}>{store.balanceError}</Text>
              <Pressable
                onPress={() => void store.loadAccount()}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.retryBtn,
                  pressed && { opacity: tv.motion.pressOpacity },
                ]}
                hitSlop={8}
              >
                <Text style={styles.retryText}>重试</Text>
              </Pressable>
            </View>
          ) : null}

          {topUpUrl || usageUrl ? (
            <View style={styles.linkRow}>
              {topUpUrl ? (
                <Pressable
                  onPress={() => openLink(topUpUrl)}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.linkBtn,
                    pressed && { opacity: tv.motion.pressOpacity },
                  ]}
                >
                  <Text style={styles.linkBtnText}>去充值</Text>
                </Pressable>
              ) : null}
              {usageUrl ? (
                <Pressable
                  onPress={() => openLink(usageUrl)}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.linkGhostBtn,
                    pressed && { opacity: tv.motion.pressOpacity },
                  ]}
                >
                  <Text style={styles.linkGhostText}>用量明细</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* ── token 用量 ───────────────────────────────── */}
        <SectionLabel text="Token 用量" />
        <View style={styles.statCard}>
          <View style={styles.statRow}>
            <Stat label="输入" value={formatCount(usage.input)} styles={styles} />
            <Stat label="输出" value={formatCount(usage.output)} styles={styles} />
            <Stat label="缓存读" value={formatCount(usage.cacheRead)} styles={styles} />
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statFoot}>
            <Text style={styles.statFootText}>
              {store.workspaces.length} 个工作区 · {usage.sessions} 个会话
            </Text>
            <Text style={styles.statFootText}>
              缓存写 {formatCount(usage.cacheWrite)} · 合计{' '}
              {formatCount(usage.input + usage.output + usage.cacheRead + usage.cacheWrite)}
            </Text>
          </View>
        </View>

        {/* ── 外观 ─────────────────────────────────────── */}
        <SectionLabel text="外观" />
        <View style={styles.themeCard}>
          <View style={styles.segment}>
            {tv.modes.map((m: ThemeMode) => {
              const active = m === tv.mode;
              return (
                <Pressable
                  key={m}
                  onPress={() => tv.setMode(m)}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.segItem,
                    active ? styles.segItemActive : null,
                    pressed && !active ? { opacity: tv.motion.pressOpacity } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.segText, active ? styles.segTextActive : null]}>
                    {themeLabels[m]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>纯白 / 暖白随时切换，深色适合夜里看</Text>
        </View>

        {/* ── 管家模式 ─────────────────────────────────── */}
        <SectionLabel text="管家模式" />
        <View style={styles.themeCard}>
          <View style={styles.switchRow}>
            <View style={styles.switchBody}>
              <Text style={styles.switchLabel}>开启管家模式</Text>
              <Text style={styles.hint}>
                首页变成跟管家对话，它会拆解任务、派队员去做
              </Text>
            </View>
            {butlerBusy ? (
              <ActivityIndicator size="small" color={tv.colors.textTertiary} />
            ) : (
              <Switch
                value={butlerMode}
                onValueChange={(v: boolean) => setButlerMode(v)}
                trackColor={{ true: tv.colors.accent, false: tv.colors.bgOverlay }}
                thumbColor={tv.colors.bg}
              />
            )}
          </View>
          {butlerMode ? (
            <Pressable
              onPress={() => nav.push('Workspaces')}
              style={({ pressed }: { pressed: boolean }) => [
                styles.entryRow,
                pressed ? { opacity: tv.motion.pressOpacity } : null,
              ]}
            >
              <Text style={styles.entryLabel}>工作区</Text>
              <Text style={styles.entryMeta}>浏览全部会话</Text>
              <Text style={styles.entryChevron}>›</Text>
            </Pressable>
          ) : null}
        </View>

        {/* ── 连接 ─────────────────────────────────────── */}
        <SectionLabel text="连接" />
        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>服务地址</Text>
            <Text style={styles.infoVal} numberOfLines={1}>
              {baseUrl}
            </Text>
          </View>
          <View style={styles.infoSep} />
          <View style={styles.infoRow}>
            <Text style={styles.infoKey}>连接状态</Text>
            <Text
              style={[
                styles.infoVal,
                net === 'fail' ? { color: tv.colors.danger } : null,
              ]}
            >
              {NET_LABELS[net]}
            </Text>
          </View>
        </View>

        <Pressable
          onPress={() => setConfirmSignOut(true)}
          style={({ pressed }: { pressed: boolean }) => [
            styles.signOutBtn,
            pressed && { opacity: tv.motion.pressOpacity },
          ]}
        >
          <Text style={styles.signOutText}>退出登录</Text>
        </Pressable>

        <View style={{ height: tv.space.xxxl }} />
      </ScrollView>

      <ConfirmSheet
        visible={confirmSignOut}
        title="退出登录"
        message={'退出后要用电脑上的 token 重新配对才能再用。\n也可以稍后用「上次的配对」一键恢复。'}
        confirmText="退出"
        destructive
        onCancel={() => setConfirmSignOut(false)}
        onConfirm={() => {
          setConfirmSignOut(false);
          void signOut();
        }}
      />
    </View>
  );
}

/** 小统计块（拆出来避免每行重复样式对象） */
function Stat({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },

    header: {
      paddingHorizontal: tv.layout.screenPadding,
      paddingBottom: tv.space.md,
      backgroundColor: C.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
    },
    headerTitle: {
      color: C.text,
      fontSize: tv.type.title,
      fontWeight: tv.weight.bold,
      letterSpacing: -0.5,
    },
    headerSub: { color: C.textTertiary, fontSize: tv.type.xs, marginTop: 2 },

    content: { paddingTop: tv.space.md },

    balanceCard: {
      marginHorizontal: tv.layout.screenPadding,
      padding: tv.space.lg,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    balanceTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    balanceLabel: { color: C.textSecondary, fontSize: tv.type.xs, letterSpacing: 0.4 },
    balanceValue: {
      color: C.text,
      fontSize: tv.type.display,
      fontWeight: tv.weight.bold,
      letterSpacing: -1,
      marginTop: tv.space.xs,
    },
    moneyRows: { marginTop: tv.space.md },
    moneyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 3,
    },
    moneyKey: { color: C.textTertiary, fontSize: tv.type.xs },
    moneyVal: { color: C.textSecondary, fontSize: tv.type.xs },

    errorWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: tv.space.sm,
      flexWrap: 'wrap',
    },
    errorText: { color: C.danger, fontSize: tv.type.xs, flexShrink: 1, marginRight: tv.space.sm },
    retryBtn: {
      paddingHorizontal: tv.space.sm,
      paddingVertical: 2,
      borderRadius: tv.radius.sm,
      backgroundColor: C.dangerWash,
    },
    retryText: { color: C.danger, fontSize: tv.type.micro, fontWeight: tv.weight.medium },

    linkRow: { flexDirection: 'row', marginTop: tv.space.lg },
    linkBtn: {
      paddingHorizontal: tv.space.lg,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.accent,
      marginRight: tv.space.sm,
    },
    linkBtnText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: tv.weight.semibold },
    linkGhostBtn: {
      paddingHorizontal: tv.space.lg,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
    },
    linkGhostText: { color: C.textSecondary, fontSize: tv.type.sm, fontWeight: tv.weight.medium },

    statCard: {
      marginHorizontal: tv.layout.screenPadding,
      paddingVertical: tv.space.lg,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    statRow: { flexDirection: 'row' },
    statCell: { flex: 1, alignItems: 'center' },
    statValue: {
      color: C.text,
      fontSize: tv.type.xl,
      fontWeight: tv.weight.semibold,
      letterSpacing: -0.4,
    },
    statLabel: { color: C.textTertiary, fontSize: tv.type.micro, marginTop: 3 },
    statDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: C.border,
      marginVertical: tv.space.md,
      marginHorizontal: tv.space.lg,
    },
    statFoot: { paddingHorizontal: tv.space.lg },
    statFootText: { color: C.textTertiary, fontSize: tv.type.micro, marginTop: 2 },

    themeCard: {
      marginHorizontal: tv.layout.screenPadding,
      padding: tv.space.md,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    segment: {
      flexDirection: 'row',
      backgroundColor: C.bgOverlay,
      borderRadius: tv.radius.md,
      padding: 3,
    },
    segItem: {
      flex: 1,
      paddingVertical: 7,
      borderRadius: tv.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    segItemActive: { backgroundColor: C.accent },
    segText: { color: C.textSecondary, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    segTextActive: { color: C.onAccent, fontWeight: tv.weight.semibold },
    hint: { color: C.textFaint, fontSize: tv.type.micro, marginTop: tv.space.sm, textAlign: 'center' },

    switchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: tv.space.xs,
    },
    switchBody: { flex: 1, marginRight: tv.space.md },
    switchLabel: { color: C.text, fontSize: tv.type.base, fontWeight: tv.weight.medium },
    entryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: tv.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
      marginTop: tv.space.sm,
    },
    entryLabel: { color: C.text, fontSize: tv.type.base, flex: 1 },
    entryMeta: { color: C.textFaint, fontSize: tv.type.xs, marginRight: tv.space.sm },
    entryChevron: { color: C.textFaint, fontSize: 22, marginTop: -2 },

    infoCard: {
      marginHorizontal: tv.layout.screenPadding,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      paddingHorizontal: tv.space.lg,
    },
    infoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: tv.space.md,
    },
    infoKey: { color: C.textSecondary, fontSize: tv.type.sm },
    infoVal: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      marginLeft: tv.space.lg,
      flexShrink: 1,
      textAlign: 'right',
    },
    infoSep: { height: StyleSheet.hairlineWidth, backgroundColor: C.border },

    signOutBtn: {
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.xxl,
      paddingVertical: tv.space.md,
      borderRadius: tv.radius.md,
      alignItems: 'center',
      backgroundColor: C.dangerWash,
    },
    signOutText: { color: C.danger, fontSize: tv.type.base, fontWeight: tv.weight.medium },
  });
}
