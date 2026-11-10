/**
 * 本机审批卡（P3）。
 *
 * 与电脑审批卡共用视觉语言，但不复用 ApprovalBanner 的网关状态机：
 * 本机审批没有 WebSocket 权威帧，只有 reconcile 里的活审批与命令回执。
 * 因此这里的规则是：
 *   - 只在 reconcile 仍列出该审批时显示，审批消失卡片随之消失；
 *   - 参数摘要来自执行快照，提交时由 ButlerClient 重新绑定当前 revision；
 *   - 结果未知时锁定「允许一次」，等待回执核对，绝不自动重发。
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import type { LocalApprovalEntry } from '../core/butlerClient';
import type { LocalApprovalDecision } from '../core/localAudit';

function summarize(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function remainingText(expiresAt: number, now: number): string {
  const seconds = Math.ceil((expiresAt - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return '已过期';
  if (seconds < 60) return `剩余 ${seconds} 秒`;
  return `剩余 ${Math.ceil(seconds / 60)} 分钟`;
}

export function LocalApprovalCard({
  approval,
  busy,
  locked,
  error,
  now,
  onDecide,
}: {
  approval: LocalApprovalEntry;
  busy: boolean;
  /** 结果未知：允许按钮必须保持锁定，直到核对回执。 */
  locked: boolean;
  error?: string;
  now: number;
  onDecide: (decision: LocalApprovalDecision) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [expanded, setExpanded] = useState(false);
  const expired = now >= approval.expiresAt;
  const disabled = busy || locked || expired;
  const entries = Object.entries(approval.arguments ?? {});

  return (
    <View style={[styles.card, locked || error || expired ? styles.cardAttention : null]} accessibilityLabel="本机待审批">
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>本机审批 · {approval.toolName}</Text>
        <Text style={styles.expiry}>{remainingText(approval.expiresAt, now)}</Text>
      </View>
      <Text style={styles.meta}>
        任务 {approval.taskId.slice(0, 13)} · 调用 {approval.toolCallId}
      </Text>
      {entries.slice(0, expanded ? entries.length : 3).map(([key, value]) => {
        const text = summarize(value);
        return (
          <View key={key} style={styles.argRow}>
            <Text style={styles.argKey}>{key}</Text>
            <Text style={styles.argValue} numberOfLines={expanded ? undefined : 2} selectable={expanded}>
              {text}
            </Text>
          </View>
        );
      })}
      {entries.length > 3 ? (
        <Pressable
          onPress={() => setExpanded(value => !value)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? '收起审批参数' : '查看全部审批参数'}
          accessibilityState={{ expanded }}
          hitSlop={8}
          style={styles.detailsBtn}
        >
          <Text style={styles.detailsText}>{expanded ? '收起参数' : `查看全部 ${entries.length} 项参数`}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.meta}>参数摘要 {approval.argumentDigest.slice(0, 12)}…</Text>
      {locked ? (
        <Text style={styles.locked}>已提交但结果未知：正在核对回执，不会自动重发，也不会再次放行。</Text>
      ) : expired ? (
        <Text style={styles.locked}>审批已过期；任务会重新请求，旧卡片不能复用。</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          onPress={() => onDecide('allowed-once')}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="允许一次本机审批"
          accessibilityState={{ disabled }}
          style={[styles.allow, disabled ? styles.muted : null]}
        >
          <Text style={styles.allowText}>{busy ? '提交中…' : '允许一次'}</Text>
        </Pressable>
        <Pressable
          onPress={() => onDecide('rejected')}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel="拒绝本机审批"
          accessibilityState={{ disabled }}
          style={[styles.reject, disabled ? styles.muted : null]}
        >
          <Text style={styles.rejectText}>拒绝</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    card: {
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    cardAttention: { borderColor: C.warning },
    head: { flexDirection: 'row', alignItems: 'center' },
    title: { flex: 1, color: C.text, fontSize: tv.type.sm, fontWeight: '600' },
    expiry: { color: C.warning, fontSize: tv.type.micro, marginLeft: tv.space.sm },
    meta: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 4 },
    argRow: {
      paddingTop: tv.space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    argKey: { color: C.textTertiary, fontSize: tv.type.micro, letterSpacing: 0.4 },
    argValue: { color: C.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: 2 },
    detailsBtn: { minHeight: 36, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: tv.space.md },
    detailsText: { color: C.accent, fontSize: tv.type.xs },
    locked: { color: C.warning, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5, marginTop: tv.space.sm },
    error: { color: C.danger, fontSize: tv.type.xs, marginTop: tv.space.sm },
    actions: { flexDirection: 'row', gap: 8, marginTop: tv.space.md },
    allow: {
      flex: 1,
      minHeight: 44,
      borderRadius: tv.radius.sm,
      backgroundColor: C.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    allowText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: '600' },
    reject: {
      flex: 1,
      minHeight: 44,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rejectText: { color: C.danger, fontSize: tv.type.sm },
    muted: { opacity: 0.55 },
  });
}
