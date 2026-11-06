import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Platform, StyleSheet, Text, View} from 'react-native';
import {useApp} from '../App';
import {useTheme} from '../design/theme';
import {APP_VERSION} from '../core/version';
import {isNotifyEnabled, notifyDebugState} from '../core/notify';
import {buildLocalDiagnostics} from '../core/localDiagnostics';
import {MotionPressable as Pressable} from './MotionPressable';
import {LocalExportSheet} from './LocalExportPanel';
let sequence = 0;
type Diagnostics = ReturnType<typeof buildLocalDiagnostics>;
const connectionLabels: Record<string, string> = {idle: '未连接', connecting: '连接中', connected: '已连接', error: '连接异常'};
const approvalLabels: Record<string, string> = {idle: '未连接', connecting: '连接中', online: '已连接', offline: '未连接', revoked: '授权已撤销'};
const notificationLabels: Record<string, string> = {ready: '已就绪', 'not-initialized': '未初始化', unavailable: '暂不可用', 'channel-unavailable': '通道未就绪'};

/** Only displays the same allowlisted snapshot that will be saved. */
function DiagnosticsSummary({value, text}: {value: Diagnostics; text: string}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [expanded, setExpanded] = useState(false);
  const rows = [
    ['应用版本', value.appVersion],
    ['连接状态', value.chat.accessBlocked ? '需要重新登录' : connectionLabels[value.chat.connection] ?? '未知'],
    ['审批连接', approvalLabels[value.approval.status] ?? '未知'],
    ['接口兼容', value.compatibility.missingEndpoints.length ? `${value.compatibility.missingEndpoints.length} 项不可用` : '未发现缺失接口'],
    ['通知状态', value.notifications.enabled === false ? '已关闭' : value.notifications.enabled === true ? notificationLabels[value.notifications.initialization] ?? '未知' : '未知'],
    ['管家模式', value.butlerMode === null ? '未知' : value.butlerMode ? '已开启' : '已关闭'],
  ];
  return <View>
    {rows.map(([label, detail]) => <View key={label} style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text><Text style={styles.summaryValue}>{detail}</Text>
    </View>)}
    <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起诊断明细' : '查看诊断明细'} accessibilityState={{expanded}}
      style={styles.detailsButton} onPress={() => setExpanded(value => !value)}>
      <Text style={styles.detailsLabel}>{expanded ? '收起诊断明细' : '查看诊断明细'}</Text>
      <Text style={styles.detailsLabel}>{expanded ? '−' : '＋'}</Text>
    </Pressable>
    {expanded ? <Text selectable style={styles.details}>{text}</Text> : null}
  </View>;
}

export function LocalDiagnosticsButton({active = true}: {active?: boolean}) {
  const {store, baseUrl, butlerMode} = useApp();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const owner = useMemo(() => ({}), [store, baseUrl, active]);
  const live = useRef(owner); live.current = owner;
  const mounted = useRef(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const [snapshot, setSnapshot] = useState<{owner: object; value: Diagnostics; text: string; fileName: string} | null>(null);
  const preview = () => {
    if (!mounted.current || !active || live.current !== owner) return;
    const value = buildLocalDiagnostics({
      version: APP_VERSION, platform: Platform.OS, platformVersion: Platform.Version,
      connection: store.connection, authInvalidated: store.authInvalidated,
      gatewayStatus: store.gatewayStatus, butlerMode,
      missingEndpoints: store.compatMissing,
      notifyEnabled: isNotifyEnabled(), notifyState: notifyDebugState(),
    });
    setSnapshot({owner, value, text: JSON.stringify(value, null, 2) + '\n', fileName: `outpost-diagnostics-${Date.now()}-${++sequence}.json`});
  };
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="本地诊断包" onPress={preview} style={styles.row}>
      <Text style={styles.label}>本地诊断包</Text><Text style={styles.meta}>预览后保存 ›</Text>
    </Pressable>
    <LocalExportSheet visible={active && snapshot?.owner === owner} key={snapshot?.fileName ?? 'closed'}
      title="本地诊断包" text={snapshot?.text ?? ''} fileName={snapshot?.fileName ?? 'outpost-diagnostics.json'} allowOriginal={false}
      previewContent={snapshot ? <DiagnosticsSummary value={snapshot.value} text={snapshot.text} /> : undefined}
      description="查看当前连接、接口和通知状态。保存的文件不含服务地址、凭据、聊天或附件。"
      onClose={() => {if (mounted.current) setSnapshot(previous => previous === snapshot ? null : previous);}} />
  </>;
}
function makeStyles(tv: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    row: {minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: tv.space.md, paddingHorizontal: tv.space.lg, paddingVertical: tv.space.md},
    label: {color: tv.colors.text, fontSize: tv.type.base},
    meta: {color: tv.colors.accentBright, fontSize: tv.type.sm},
    summaryRow: {minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: tv.space.md, paddingVertical: tv.space.sm},
    summaryLabel: {color: tv.colors.textSecondary, fontSize: tv.type.sm, flexShrink: 1},
    summaryValue: {color: tv.colors.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium, textAlign: 'right', flexShrink: 1},
    detailsButton: {minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: tv.space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tv.colors.border},
    detailsLabel: {color: tv.colors.accentBright, fontSize: tv.type.sm},
    details: {color: tv.colors.textSecondary, fontSize: tv.type.xs, lineHeight: 18, paddingVertical: tv.space.sm},
  });
}
