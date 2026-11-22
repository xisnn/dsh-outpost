/**
 * Rurea C4 可恢复错误提示卡：
 * - 按失败类别渲染醒目中文标题与人话恢复建议（warning / danger 区分）；
 * - 已有副作用时突出警示「从头重试会重新执行」，避免二次盲目重放；
 * - 原始错误码 / 异常栈默认折叠在「查看详情」后，不直接糊用户一脸；
 * - 「知道了（dismiss）」在忙碌态下仍可随时点按，避免卡死状态提示。
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import type { AgentRecoveryActionId, AgentRecoveryPlan } from '../core/agentRecovery';

export function AgentRecoveryCard({
  plan,
  busy = false,
  compact = false,
  onAction,
}: {
  plan: AgentRecoveryPlan;
  busy?: boolean;
  compact?: boolean;
  onAction: (actionId: AgentRecoveryActionId) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [expanded, setExpanded] = useState(false);

  const isWarning = plan.tone === 'warning';

  return (
    <View style={[styles.wrap, compact ? styles.wrapCompact : null]}>
      <View
        style={[
          styles.card,
          compact ? styles.cardCompact : null,
          isWarning ? styles.warningCard : styles.dangerCard,
        ]}
      >
        <View style={styles.headerRow}>
          <Text
            style={[styles.title, isWarning ? styles.warningTitle : styles.dangerTitle]}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {plan.title}
          </Text>
          {plan.detail ? (
            <Pressable
              onPress={() => setExpanded((prev) => !prev)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={expanded ? '收起技术详情' : '查看技术详情'}
              style={styles.detailToggle}
            >
              <Text style={styles.detailToggleText}>{expanded ? '收起详情' : '查看详情'}</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.hint}>{plan.hint}</Text>

        {plan.sideEffectWarning ? (
          <Text style={styles.sideEffectWarning}>{plan.sideEffectWarning}</Text>
        ) : null}

        {expanded && plan.detail ? (
          <View style={styles.detailBox}>
            <Text style={styles.detailText} selectable>
              {plan.detail}
            </Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          {plan.actions.map((action) => {
            const disabled = busy && action.id !== 'dismiss';
            const isPrimary = action.emphasis === 'primary';
            const isDismiss = action.id === 'dismiss';
            return (
              <Pressable
                key={action.id}
                onPress={() => onAction(action.id)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                accessibilityState={{ disabled }}
                style={[
                  styles.btn,
                  isPrimary
                    ? styles.primaryBtn
                    : isDismiss
                      ? styles.dismissBtn
                      : styles.secondaryBtn,
                  disabled ? styles.muted : null,
                ]}
              >
                <Text
                  style={
                    isPrimary
                      ? styles.primaryText
                      : isDismiss
                        ? styles.dismissText
                        : styles.secondaryText
                  }
                >
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: { paddingHorizontal: tv.layout.screenPadding, marginTop: tv.space.md, alignItems: 'flex-start' },
    wrapCompact: { paddingHorizontal: 0, marginTop: tv.space.sm, alignItems: 'stretch' },
    card: {
      maxWidth: '94%',
      paddingHorizontal: tv.space.lg,
      paddingVertical: tv.space.md,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
    },
    cardCompact: { maxWidth: '100%' },
    warningCard: { borderColor: C.warning },
    dangerCard: { borderColor: C.danger },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    title: { flex: 1, fontSize: tv.type.sm, fontWeight: '600' },
    warningTitle: { color: C.warning },
    dangerTitle: { color: C.danger },
    detailToggle: { paddingVertical: 2, paddingHorizontal: 4 },
    detailToggleText: { color: C.textTertiary, fontSize: tv.type.xs },
    hint: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.55,
      marginTop: tv.space.xs,
    },
    sideEffectWarning: {
      color: C.warning,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      marginTop: tv.space.xs,
    },
    detailBox: {
      marginTop: tv.space.sm,
      padding: tv.space.sm,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    detailText: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      lineHeight: tv.type.micro * 1.45,
    },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: tv.space.md,
    },
    btn: {
      minHeight: 36,
      paddingHorizontal: 12,
      borderRadius: tv.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryBtn: { backgroundColor: C.accent },
    primaryText: { color: C.onAccent, fontSize: tv.type.xs, fontWeight: '600' },
    secondaryBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
    },
    secondaryText: { color: C.text, fontSize: tv.type.xs },
    dismissBtn: { paddingHorizontal: 8 },
    dismissText: { color: C.textTertiary, fontSize: tv.type.xs },
    muted: { opacity: 0.5 },
  });
}
