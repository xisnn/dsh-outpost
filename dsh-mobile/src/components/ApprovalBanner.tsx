/**
 * 审批横幅：工具需要授权时，直接在手机上允许或拒绝。
 *
 * 历史：早先 DSH 没暴露审批响应通道（我试了 12 个候选端点名全部 not found），
 * 所以这个组件只能显示「去电脑上确认」。
 *
 * 现在通过 `dsh-plugin-mobile-gateway` 的 WebSocket 旁路拿到审批收发能力：
 *   收 {"kind":"approval-requested", rpcId, sessionId, approvalId, toolName, reason}
 *   发 {"type":"approval-response", rpcId, sessionId, approvalId, outcome}
 *
 * 两种来源的审批都支持：
 *   1. gateway 推来的（可回答，rpcId 齐全）
 *   2. 会话事件流里 fold 出来的（只读，没有 rpcId，只能提示去电脑）
 * 卡片按「有没有 rpcId」自动切换形态，不给用户假的可点按钮。
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

/** 会话事件流里 fold 出来的只读审批 */
export interface ReadonlyApproval {
  id: string;
  toolName: string;
  reason?: string;
}

export function ApprovalBanner({
  approvals,
  readonlyApprovals = [],
  gatewayOnline = false,
  onAnswer,
}: {
  approvals: ReadonlyApproval[];
  readonlyApprovals?: ReadonlyApproval[];
  gatewayOnline?: boolean;
  onAnswer?: (a: ReadonlyApproval, outcome: 'allowed-once' | 'rejected') => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [busy, setBusy] = useState(false);

  const answerable = approvals.length > 0 ? approvals : [];
  const readOnly = readonlyApprovals.length > 0 ? readonlyApprovals : [];
  const total = answerable.length + readOnly.length;
  if (total === 0) return null;

  const first = answerable[0] ?? readOnly[0];
  const canAnswer = answerable.length > 0 && gatewayOnline && !!onAnswer;

  const press = (outcome: 'allowed-once' | 'rejected') => {
    if (!canAnswer || busy) return;
    setBusy(true);
    try {
      onAnswer?.(answerable[0], outcome);
    } finally {
      // 等父组件把这条从列表里移除；给一点视觉反馈时间
      setTimeout(() => setBusy(false), 800);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.icon}>⚠</Text>
        <View style={styles.body}>
          <Text style={styles.title}>
            需要授权{total > 1 ? `（还有 ${total - 1} 个）` : ''}
          </Text>
          <Text style={styles.detail} numberOfLines={2}>
            {first.toolName}
            {first.reason ? ` · ${first.reason}` : ''}
          </Text>
        </View>
      </View>

      {canAnswer ? (
        <View style={styles.actions}>
          <Pressable
            onPress={() => press('rejected')}
            disabled={busy}
            style={({ pressed }: { pressed: boolean }) => [
              styles.btn,
              styles.btnGhost,
              pressed ? { opacity: tv.motion.pressOpacity } : null,
            ]}
          >
            <Text style={[styles.btnText, { color: tv.colors.danger }]}>拒绝</Text>
          </Pressable>
          <Pressable
            onPress={() => press('allowed-once')}
            disabled={busy}
            style={({ pressed }: { pressed: boolean }) => [
              styles.btn,
              styles.btnPrimary,
              pressed ? { opacity: tv.motion.pressOpacity } : null,
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={tv.colors.bg} />
            ) : (
              <Text style={[styles.btnText, { color: tv.colors.bg }]}>允许一次</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <Text style={styles.help}>
          {readOnly.length > 0
            ? '这条请求来自会话记录，无法在手机上回答。到电脑上确认，或把权限模式调成「完全访问」。'
            : '审批通道还没连上。检查电脑上的移动网关是否开启。'}
        </Text>
      )}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      marginHorizontal: tv.layout.screenPadding,
      marginVertical: tv.space.xs,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.dangerWash,
      borderLeftWidth: 2,
      borderLeftColor: C.danger,
    },
    row: { flexDirection: 'row', alignItems: 'flex-start' },
    icon: { fontSize: tv.type.sm, marginRight: tv.space.sm, color: C.danger },
    body: { flex: 1 },
    title: {
      color: C.text,
      fontSize: tv.type.sm,
      fontWeight: tv.weight.medium,
    },
    detail: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      marginTop: 2,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: tv.space.sm,
      marginTop: tv.space.sm,
    },
    btn: {
      minWidth: 72,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.xs,
      borderRadius: tv.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnGhost: {
      borderWidth: 1,
      borderColor: C.danger,
    },
    btnPrimary: { backgroundColor: C.danger },
    btnText: {
      fontSize: tv.type.xs,
      fontWeight: tv.weight.medium,
    },
    help: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      lineHeight: tv.type.micro * 1.6,
      marginTop: tv.space.sm,
      paddingLeft: tv.type.sm + tv.space.sm,
    },
  });
}
