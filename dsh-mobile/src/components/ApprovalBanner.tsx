/**
 * F-01 底部停靠式审批面板（升级自 ApprovalBanner）与列表待审批提醒条。
 *
 * 关键特性：
 *   1. 停靠在聊天输入框正上方，支持收起为单行状态条、展开查看完整上下文；
 *   2. 多条待审批支持 `‹ 1 / N ›` 队列切换；
 *   3. 严格按 `sessionId` 隔离当前会话审批，其他会话待审批显示独立跳转入口；
 *   4. 完整展示待执行命令、目标路径、附加参数与风险说明，不隐藏关键参数；
 *   5. 高危操作启用二次确认（Arm-then-Commit，仅作为客户端额外防误触措施）；
 *   6. 提交失败 / 断线 / 401 / 403 / 超时未确认时自动恢复待审批状态并明确报错。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  APPROVAL_COMMIT_TIMEOUT_MS,
  ApprovalSubmitController,
  assessApprovalRisk,
  clampQueueIndex,
  extractApprovalDetails,
  HIGH_RISK_ARM_TIMEOUT_MS,
  partitionApprovalsBySession,
  type ApprovalCandidate,
  type ApprovalDecision,
  type SessionTitleLike,
} from '../core/approvalDock';
import { useTheme } from '../design/theme';

/** 会话事件流或网关推来的审批项 */
export interface ReadonlyApproval extends ApprovalCandidate {
  id: string;
  toolName: string;
  reason?: string;
}

export function ApprovalBanner({
  approvals,
  readonlyApprovals = [],
  sessionId = '',
  gatewayOnline = false,
  authInvalidated = false,
  sessions = [],
  onAnswer,
  onOpenSession,
}: {
  approvals: ReadonlyApproval[];
  readonlyApprovals?: ReadonlyApproval[];
  sessionId?: string;
  gatewayOnline?: boolean;
  authInvalidated?: boolean;
  sessions?: readonly SessionTitleLike[];
  onAnswer?: (a: ReadonlyApproval, outcome: ApprovalDecision) => boolean | void;
  onOpenSession?: (sessionId: string, title: string) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const controller = useRef(new ApprovalSubmitController()).current;
  const [, bump] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [queueIndex, setQueueIndex] = useState(0);

  const serverPendingIds = useMemo(
    () => new Set(approvals.map((a) => a.id)),
    [approvals],
  );

  // 每次网关状态、401/403 或待审批列表变化时与控制器对账（处理已确认与断线回滚）
  useEffect(() => {
    const changed = controller.reconcile({
      serverPendingIds,
      gatewayOnline: gatewayOnline && !authInvalidated,
      authInvalidated,
    });
    if (changed) bump((n) => n + 1);
  }, [controller, serverPendingIds, gatewayOnline, authInvalidated]);

  // 严格按 sessionId 拆分当前会话与其他会话
  const partitioned = partitionApprovalsBySession(approvals, sessionId, {
    inFlightIds: controller.inFlightIds,
    sessions,
  });

  const answerable = partitioned.current;
  const answerableIds = new Set(answerable.map((a) => a.id));
  const readOnly = readonlyApprovals.filter(
    (r) => !answerableIds.has(r.id) && !controller.inFlightIds.has(r.id),
  );
  const currentList = answerable.length > 0 ? answerable : readOnly;
  const total = currentList.length;
  const safeIndex = clampQueueIndex(queueIndex, total);
  const current = currentList[safeIndex];
  const isCurrentAnswerable = !!current && answerableIds.has(current.id);
  const canAnswer = isCurrentAnswerable && gatewayOnline && !authInvalidated && !!onAnswer;

  // 高危二次确认倒计时到期后自动复位按钮文案
  const armed = current ? controller.isArmed(current.id) : false;
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      controller.disarm();
      bump((n) => n + 1);
    }, HIGH_RISK_ARM_TIMEOUT_MS + 30);
    return () => clearTimeout(timer);
  }, [armed, controller]);

  if (total === 0 && partitioned.otherGroups.length === 0) {
    return null;
  }

  const press = (outcome: ApprovalDecision) => {
    if (!current || !onAnswer) return;
    const res = controller.submit({
      approval: current,
      outcome,
      gatewayOnline,
      authInvalidated,
      send: (item, dec) => {
        const r = onAnswer(item as ReadonlyApproval, dec);
        return r !== false;
      },
    });
    bump((n) => n + 1);

    if (res.status === 'sent') {
      // 启动超时守卫：若电脑端超时未回 approval-resolved，则回滚恢复待审批并报错
      setTimeout(() => {
        const rolledBack = controller.reconcile({
          serverPendingIds: new Set(approvals.map((a) => a.id)),
          gatewayOnline: gatewayOnline && !authInvalidated,
          authInvalidated,
        });
        if (rolledBack) bump((n) => n + 1);
      }, APPROVAL_COMMIT_TIMEOUT_MS + 50);
    }
  };

  const switchQueue = (delta: number) => {
    if (total <= 1) return;
    controller.disarm();
    const next = (safeIndex + delta + total) % total;
    setQueueIndex(next);
  };

  const details = current ? extractApprovalDetails(current) : null;
  const risk = current ? assessApprovalRisk(current) : null;
  const submitError = current ? controller.errorFor(current.id) : null;

  return (
    <View style={styles.dockContainer}>
      {/* 其他会话待审批跳转入口（严格按 sessionId 隔离，不混入当前会话卡片） */}
      {partitioned.otherGroups.map((group) => (
        <Pressable
          key={group.sessionId}
          onPress={() => onOpenSession?.(group.sessionId, group.title)}
          style={({ pressed }: { pressed: boolean }) => [
            styles.otherJumpBar,
            pressed ? { opacity: tv.motion.pressOpacity } : null,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`其他会话待审批：${group.title}，共 ${group.count} 个，点击前往`}
        >
          <Text style={styles.otherJumpIcon}>⚠</Text>
          <Text style={styles.otherJumpText} numberOfLines={1}>
            其他会话有 {group.count} 个待审批 · {group.title}（{group.firstToolName}）
          </Text>
          <Text style={styles.otherJumpAction}>点击前往 ›</Text>
        </Pressable>
      ))}

      {/* 当前会话审批停靠卡 */}
      {current && details && risk ? (
        collapsed ? (
          <Pressable
            onPress={() => setCollapsed(false)}
            style={({ pressed }: { pressed: boolean }) => [
              styles.collapsedBar,
              risk.highRisk ? styles.collapsedBarHighRisk : null,
              pressed ? { opacity: tv.motion.pressOpacity } : null,
            ]}
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            accessibilityLabel={`展开待审批：${current.toolName}`}
          >
            <Text style={styles.icon}>{risk.highRisk ? '⛔' : '⚠'}</Text>
            <Text style={styles.collapsedTitle} numberOfLines={1}>
              等待授权 ({safeIndex + 1}/{total}) · {current.toolName}
              {details.command ? ` · ${details.command}` : details.targetPath ? ` · ${details.targetPath}` : ''}
            </Text>
            <Text style={styles.collapseToggleText}>展开 ⌃</Text>
          </Pressable>
        ) : (
          <View style={[styles.wrap, risk.highRisk ? styles.wrapHighRisk : null]}>
            {/* 顶栏：标题 + 多审批切换器 + 收起按钮 */}
            <View style={styles.headerRow}>
              <View style={styles.headerLeft}>
                <Text style={styles.icon}>{risk.highRisk ? '⛔' : '⚠'}</Text>
                <Text style={styles.title}>
                  {risk.highRisk ? '高危操作需要授权' : '需要授权'}
                </Text>
                <View style={styles.toolBadge}>
                  <Text style={styles.toolBadgeText}>{current.toolName}</Text>
                </View>
              </View>

              <View style={styles.headerRight}>
                {total > 1 ? (
                  <View style={styles.pager}>
                    <Pressable
                      onPress={() => switchQueue(-1)}
                      hitSlop={8}
                      style={styles.pagerBtn}
                      accessibilityRole="button"
                      accessibilityLabel="上一条待审批"
                    >
                      <Text style={styles.pagerBtnText}>‹</Text>
                    </Pressable>
                    <Text style={styles.pagerCount}>
                      {safeIndex + 1} / {total}
                    </Text>
                    <Pressable
                      onPress={() => switchQueue(1)}
                      hitSlop={8}
                      style={styles.pagerBtn}
                      accessibilityRole="button"
                      accessibilityLabel="下一条待审批"
                    >
                      <Text style={styles.pagerBtnText}>›</Text>
                    </Pressable>
                  </View>
                ) : null}

                <Pressable
                  onPress={() => {
                    controller.disarm();
                    setCollapsed(true);
                  }}
                  hitSlop={8}
                  style={styles.collapseBtn}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: true }}
                  accessibilityLabel="收起审批卡片"
                >
                  <Text style={styles.collapseToggleText}>收起 ⌄</Text>
                </Pressable>
              </View>
            </View>

            {/* 完整命令、目标路径与关键参数（可滚动、可选择，绝不隐藏关键参数） */}
            <ScrollView
              style={styles.specScroll}
              contentContainerStyle={styles.specBox}
              nestedScrollEnabled
            >
              {details.command ? (
                <View style={styles.specSection}>
                  <Text style={styles.specLabel}>待执行命令</Text>
                  <Text style={styles.specCode} selectable>
                    {details.command}
                  </Text>
                </View>
              ) : null}

              {details.targetPath ? (
                <View style={styles.specSection}>
                  <Text style={styles.specLabel}>目标路径</Text>
                  <Text style={styles.specCode} selectable>
                    {details.targetPath}
                  </Text>
                </View>
              ) : null}

              {details.extraEntries.map((entry) => (
                <View key={entry.key} style={styles.specSection}>
                  <Text style={styles.specLabel}>{entry.key}</Text>
                  <Text style={styles.specCode} selectable>
                    {entry.value}
                  </Text>
                </View>
              ))}

              {details.reasonText ? (
                <View style={styles.specSection}>
                  <Text style={styles.specLabel}>原因说明</Text>
                  <Text style={styles.detail} selectable>
                    {details.reasonText}
                  </Text>
                </View>
              ) : null}

              {!details.command &&
              !details.targetPath &&
              details.extraEntries.length === 0 &&
              !details.reasonText ? (
                <Text style={styles.detail} selectable>
                  工具：{current.toolName}
                </Text>
              ) : null}
            </ScrollView>

            {/* 高危风险说明条 */}
            {risk.highRisk ? (
              <View style={styles.riskBox}>
                <Text style={styles.riskTitle}>
                  ⚠ 风险说明：{risk.riskReasons.join('；')}
                </Text>
                <Text style={styles.riskSub}>
                  已启用防误触二次确认（仅作客户端额外确认，不替代服务端安全权限校验）。
                </Text>
              </View>
            ) : null}

            {/* 提交失败 / 超时 / 断线回滚错误提示 */}
            {submitError ? (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{submitError}</Text>
              </View>
            ) : null}

            {/* 操作区 */}
            {canAnswer ? (
              <View style={styles.actions}>
                <Pressable
                  onPress={() => press('rejected')}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.btn,
                    styles.btnGhost,
                    pressed ? { opacity: tv.motion.pressOpacity } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="拒绝"
                >
                  <Text style={[styles.btnText, { color: tv.colors.danger }]}>拒绝</Text>
                </Pressable>
                <Pressable
                  onPress={() => press('allowed-once')}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.btn,
                    armed ? styles.btnArmed : styles.btnPrimary,
                    pressed ? { opacity: tv.motion.pressOpacity } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={armed ? '再次点击确认允许' : '允许一次'}
                >
                  <Text style={[styles.btnText, { color: tv.colors.bg }]}>
                    {armed ? '再次点击确认允许' : '允许一次'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.help}>
                {!isCurrentAnswerable
                  ? '这条请求来自会话记录，无法在手机上回答。到电脑上确认，或把权限模式调成「完全访问」。'
                  : authInvalidated
                    ? '登录状态已失效或权限受限（401/403），无法提交审批。请先回配对页重新连接。'
                    : '审批通道还没连上。检查电脑上的移动网关是否开启。'}
              </Text>
            )}
          </View>
        )
      ) : null}
    </View>
  );
}

/**
 * 首页与会话列表顶部的常驻待审批提醒条（Requirement 6）。
 */
export function ApprovalReminderStrip({
  approvals,
  sessions = [],
  workspaceSessionIds,
  onOpenSession,
}: {
  approvals: readonly { rpcId: string; sessionId: string; toolName: string; reason?: string }[];
  sessions?: readonly SessionTitleLike[];
  /** 若传入则优先展示该工作区内的待审批，并汇总其他工作区数量 */
  workspaceSessionIds?: ReadonlySet<string>;
  onOpenSession: (sessionId: string, title: string) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  if (!approvals || approvals.length === 0) return null;

  const titleMap = new Map<string, string>();
  for (const s of sessions) {
    const raw = s.projections?.values?.title;
    if (typeof raw === 'string' && raw.trim()) {
      titleMap.set(s.sessionId, raw.trim());
    }
  }

  const scoped = workspaceSessionIds
    ? approvals.filter((a) => workspaceSessionIds.has(a.sessionId))
    : approvals;
  const targetList = scoped.length > 0 ? scoped : approvals;
  const first = targetList[0]!;
  const targetTitle = titleMap.get(first.sessionId) ?? '未命名会话';
  const isOtherWorkspace = workspaceSessionIds && scoped.length === 0;

  return (
    <Pressable
      onPress={() => onOpenSession(first.sessionId, targetTitle)}
      style={({ pressed }: { pressed: boolean }) => [
        styles.reminderStrip,
        pressed ? { opacity: tv.motion.pressOpacity } : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`待审批提醒：${targetTitle}，共 ${targetList.length} 个，点击前往处理`}
    >
      <Text style={styles.reminderIcon}>⚠</Text>
      <View style={styles.reminderBody}>
        <Text style={styles.reminderTitle} numberOfLines={1}>
          {isOtherWorkspace
            ? `其他工作区有 ${targetList.length} 个待审批`
            : `${targetList.length} 个操作等待审批`}{' '}
          · {targetTitle}
        </Text>
        <Text style={styles.reminderSub} numberOfLines={1}>
          {first.toolName}
          {first.reason ? ` · ${first.reason}` : ''}
        </Text>
      </View>
      <Text style={styles.reminderAction}>去处理 ›</Text>
    </Pressable>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
  return StyleSheet.create({
    dockContainer: {
      paddingHorizontal: tv.layout.screenPadding,
      paddingTop: tv.space.xs,
      paddingBottom: tv.space.xs,
      gap: tv.space.xs,
    },
    otherJumpBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tv.space.md,
      paddingVertical: 8,
      borderRadius: tv.radius.md,
      backgroundColor: C.warningWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.warning,
    },
    otherJumpIcon: {
      color: C.warning,
      fontSize: tv.type.sm,
      marginRight: tv.space.xs,
    },
    otherJumpText: {
      flex: 1,
      color: C.text,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.medium,
    },
    otherJumpAction: {
      color: C.warning,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.semibold,
      marginLeft: tv.space.sm,
    },
    collapsedBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tv.space.md,
      paddingVertical: 9,
      borderRadius: tv.radius.md,
      backgroundColor: C.dangerWash,
      borderLeftWidth: 3,
      borderLeftColor: C.danger,
    },
    collapsedBarHighRisk: {
      borderWidth: 1,
      borderColor: C.danger,
    },
    collapsedTitle: {
      flex: 1,
      color: C.text,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.medium,
    },
    collapseBtn: {
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    collapseToggleText: {
      color: C.textSecondary,
      fontSize: tv.type.micro,
      fontWeight: tv.weight.medium,
    },
    wrap: {
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.dangerWash,
      borderLeftWidth: 3,
      borderLeftColor: C.danger,
    },
    wrapHighRisk: {
      borderWidth: 1,
      borderColor: C.danger,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    headerLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      minWidth: 0,
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    icon: {
      fontSize: tv.type.sm,
      marginRight: tv.space.xs,
      color: C.danger,
    },
    title: {
      color: C.text,
      fontSize: tv.type.sm,
      fontWeight: tv.weight.semibold,
    },
    toolBadge: {
      marginLeft: tv.space.xs,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    toolBadgeText: {
      color: C.textSecondary,
      fontSize: tv.type.micro,
      fontFamily: monoFont,
    },
    pager: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: C.bgRaised,
      borderRadius: tv.radius.sm,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    pagerBtn: {
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    pagerBtnText: {
      color: C.text,
      fontSize: tv.type.sm,
      fontWeight: tv.weight.semibold,
    },
    pagerCount: {
      color: C.textSecondary,
      fontSize: tv.type.micro,
      marginHorizontal: 2,
    },
    specScroll: {
      maxHeight: 132,
      marginTop: tv.space.xs,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    specBox: {
      paddingHorizontal: tv.space.sm,
      paddingVertical: 6,
      gap: 4,
    },
    specSection: {
      gap: 1,
    },
    specLabel: {
      color: C.textFaint,
      fontSize: tv.type.micro,
    },
    specCode: {
      color: C.text,
      fontSize: tv.type.xs,
      fontFamily: monoFont,
      lineHeight: tv.type.xs * 1.45,
    },
    detail: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.45,
    },
    riskBox: {
      marginTop: tv.space.xs,
      paddingHorizontal: tv.space.sm,
      paddingVertical: 6,
      borderRadius: tv.radius.sm,
      backgroundColor: C.warningWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.warning,
    },
    riskTitle: {
      color: C.danger,
      fontSize: tv.type.micro,
      fontWeight: tv.weight.semibold,
    },
    riskSub: {
      color: C.textSecondary,
      fontSize: tv.type.micro,
      marginTop: 1,
    },
    errorBox: {
      marginTop: tv.space.xs,
      paddingHorizontal: tv.space.sm,
      paddingVertical: 6,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgRaised,
      borderWidth: 1,
      borderColor: C.danger,
    },
    errorText: {
      color: C.danger,
      fontSize: tv.type.micro,
      fontWeight: tv.weight.medium,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: tv.space.sm,
      marginTop: tv.space.sm,
    },
    btn: {
      minWidth: 76,
      paddingHorizontal: tv.space.md,
      paddingVertical: 6,
      borderRadius: tv.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnGhost: {
      borderWidth: 1,
      borderColor: C.danger,
      backgroundColor: C.bgRaised,
    },
    btnPrimary: {
      backgroundColor: C.danger,
    },
    btnArmed: {
      backgroundColor: C.warning,
    },
    btnText: {
      fontSize: tv.type.xs,
      fontWeight: tv.weight.semibold,
    },
    help: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      lineHeight: tv.type.micro * 1.6,
      marginTop: tv.space.sm,
    },
    reminderStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.xs,
      marginBottom: tv.space.xs,
      paddingHorizontal: tv.space.md,
      paddingVertical: 9,
      borderRadius: tv.radius.md,
      backgroundColor: C.warningWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.warning,
    },
    reminderIcon: {
      color: C.danger,
      fontSize: tv.type.base,
      marginRight: tv.space.sm,
    },
    reminderBody: {
      flex: 1,
      minWidth: 0,
    },
    reminderTitle: {
      color: C.text,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.semibold,
    },
    reminderSub: {
      color: C.textSecondary,
      fontSize: tv.type.micro,
      marginTop: 1,
    },
    reminderAction: {
      color: C.danger,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.semibold,
      marginLeft: tv.space.sm,
    },
  });
}
