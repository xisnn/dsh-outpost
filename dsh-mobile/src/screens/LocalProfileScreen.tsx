/**
 * 未配对时的「我的」页（P3 本机独立首启）。
 *
 * 只提供不需要电脑的能力：外观、运行位置、版本与本机入口。
 * 余额、用量、设备、审批网关、更新等依赖电脑连接的内容不在这里出现，
 * 避免未登录状态下发出无意义的远程请求或显示误导性的空数据。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Header } from '../components/Header';
import { MotionPressable as Pressable } from '../components/MotionPressable';
import { SlideSegmented } from '../components/SlideSegmented';
import { SectionLabel } from '../components/ui';
import { useApp } from '../App';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import { themeLabels, type ThemeMode } from '../design/tokens';
import { APP_VERSION_LABEL } from '../core/version';
import type { HostLocation } from '../core/hostLocation';
import { p6AgentAvailable } from '../core/localRuntimeSupport';

export function LocalProfileScreen({ onOpenButler }: { onOpenButler?: () => void }) {
  const { location, setLocation } = useApp();
  const nav = useNav();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  return (
    <View style={styles.root}>
      <Header title="我的" subtitle="仅本机使用" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.notice}>
          还没有连接电脑。本机管家可以独立执行任务；连接电脑后可同步工作区、会话与文件。
        </Text>

        <SectionLabel text="运行位置" />
        <View style={styles.card}>
          <SlideSegmented<HostLocation>
            options={[{ value: 'desktop', label: '电脑' }, { value: 'local', label: '本机' }]}
            value={location}
            onChange={setLocation}
            accessibilityLabel="管家运行位置"
          />
          <Text style={styles.hint}>
            选择「电脑」会回到配对页；当前选择「本机」只影响管家任务，不影响未来的电脑聊天。
          </Text>
        </View>

        <SectionLabel text="本机管家" />
        <View style={styles.card}>
          <Pressable
            onPress={onOpenButler}
            accessibilityRole="button"
            accessibilityLabel="打开本机管家"
            style={({ pressed }: { pressed: boolean }) => [styles.row, pressed ? { opacity: 0.7 } : null]}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>打开本机管家</Text>
              <Text style={styles.hint}>配置模型、交代任务、处理本机审批</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          <Pressable
            onPress={() => nav.push(p6AgentAvailable() ? 'AgentMemory' : 'ButlerMemory')}
            accessibilityRole="button"
            accessibilityLabel="打开管家记忆"
            style={({ pressed }: { pressed: boolean }) => [styles.row, styles.rowDivider, pressed ? { opacity: 0.7 } : null]}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>管家记忆</Text>
              <Text style={styles.hint}>偏好与项目事实；只保存在本机 Agent</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          <Pressable
            onPress={() => nav.push('AgentDemo')}
            accessibilityRole="button"
            accessibilityLabel="打开 Agent 内核自检"
            style={({ pressed }: { pressed: boolean }) => [styles.row, styles.rowDivider, pressed ? { opacity: 0.7 } : null]}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Agent 内核（自检）</Text>
              <Text style={styles.hint}>纯 Kotlin 内核竖切；P6-1 云端模型</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          <Pressable
            onPress={() => nav.push('AgentSettings')}
            accessibilityRole="button"
            accessibilityLabel="打开模型与凭据设置"
            style={({ pressed }: { pressed: boolean }) => [styles.row, styles.rowDivider, pressed ? { opacity: 0.7 } : null]}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>模型与凭据</Text>
              <Text style={styles.hint}>云端协议、模型名与 API Key；只保存在本机</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </View>

        <SectionLabel text="外观" />
        <View style={styles.card}>
          <SlideSegmented<ThemeMode>
            options={tv.modes.map((mode: ThemeMode) => ({ value: mode, label: themeLabels[mode] }))}
            value={tv.mode}
            onChange={(mode) => tv.setMode(mode)}
            accessibilityLabel="主题模式"
          />
          <Text style={styles.hint}>纯白 / 暖白 / 深色，或跟随系统自动切换</Text>
        </View>

        <SectionLabel text="关于" />
        <View style={styles.card}>
          <Text style={styles.version}>{APP_VERSION_LABEL}</Text>
          <Text style={styles.hint}>本机执行环境与电脑模式共用同一个 App；版本与更新由电脑连接页管理。</Text>
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
      marginBottom: tv.space.lg,
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
    hint: { color: C.textTertiary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.sm },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
    rowBody: { flex: 1 },
    rowTitle: { color: C.text, fontSize: tv.type.base, fontWeight: '500' },
    chevron: { color: C.textTertiary, fontSize: 24, marginLeft: tv.space.sm },
    version: { color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
  });
}
