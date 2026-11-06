/**
 * 聊天内审批卡片（管家）/ 输入框上方审批面板（普通会话）。
 *
 * 关键特性：
 *   1. 管家请求直接在主聊天流处理，提交后收起，失败或结果未知时在原位置提示；
 *   2. 多条待审批支持 `‹ 1 / N ›` 队列切换；
 *   3. 严格按 `sessionId` 隔离当前会话审批，其他会话待审批显示独立跳转入口；
 *   4. 完整展示待执行命令、目标路径、附加参数与风险说明，不隐藏关键参数；
 *   5. 高危操作启用二次确认（Arm-then-Commit，仅作为客户端额外防误触措施）；
 *   6. 提交失败 / 断线 / 401 / 403 / 超时未确认时自动恢复待审批状态并明确报错。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';
import { Collapse } from './ui';

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
import { actionStyles } from '../design/actionStyles';

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
  serverResolvedIds,
  authoritativePendingAt,
  sessions = [],
  onAnswer,
  onOpenSession,
  relatedSessionIds,
  inline = false,
}: {
  approvals: ReadonlyApproval[];
  readonlyApprovals?: ReadonlyApproval[];
  sessionId?: string;
  gatewayOnline?: boolean;
  /** 鉴权终止态：true（401 凭据失效）或 'forbidden'（403 Host 未受信任，保留现有 Cookie） */
  authInvalidated?: boolean | 'forbidden';
  /** 服务端 approval-resolved 权威确认集合（Store.onResolved 写入） */
  serverResolvedIds?: ReadonlySet<string>;
  /** 服务端最近一次权威下发/重放每条 rpcId 的时间戳 */
  authoritativePendingAt?: ReadonlyMap<string, number>;
  sessions?: readonly SessionTitleLike[];
  onAnswer?: (a: ReadonlyApproval, outcome: ApprovalDecision) => boolean | void;
  onOpenSession?: (sessionId: string, title: string) => void;
  /** Verified task/team sessions handled inside the main butler conversation. */
  relatedSessionIds?: ReadonlySet<string>;
  /** Chat-flow presentation, with no separate page or cross-session navigation. */
  inline?: boolean;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const actions = useMemo(() => actionStyles(tv), [tv]);
  const controller = useRef(new ApprovalSubmitController()).current;
  const [, bump] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [queueIndex, setQueueIndex] = useState(0);
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);
  const { height: windowHeight } = useWindowDimensions();

  // 保存最新的权威待审批列表、网关在线状态与鉴权终止态供所有超时回调使用，避免闭包捕获旧值。
  const latestStateRef = useRef({
    approvals,
    gatewayOnline,
    authInvalidated,
    serverResolvedIds,
    authoritativePendingAt,
  });
  latestStateRef.current = {
    approvals,
    gatewayOnline,
    authInvalidated,
    serverResolvedIds,
    authoritativePendingAt,
  };

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
      serverResolvedIds,
      authoritativePendingAt,
    });
    if (changed) bump((n) => n + 1);
  }, [controller, serverPendingIds, serverResolvedIds, authoritativePendingAt, gatewayOnline, authInvalidated]);

  // 严格按 sessionId 拆分当前会话与其他会话
  const partitioned = partitionApprovalsBySession(approvals, sessionId, {
    inFlightIds: controller.inFlightIds,
    sessions,
    relatedSessionIds,
  });

  const answerable = partitioned.current;
  const answerableIds = new Set(answerable.map((a) => a.id));
  // Event history uses approvalId; gateway decisions use rpcId. They are one
  // request, including while its response is in flight or authoritatively resolved.
  const aliasScope = useRef({ sessionId, aliases: new Map<string, string>() });
  if (aliasScope.current.sessionId !== sessionId) aliasScope.current = { sessionId, aliases: new Map() };
  const aliases = aliasScope.current.aliases;
  for (const a of approvals) {
    if (a.sessionId === sessionId && a.approvalId) aliases.set(a.approvalId, a.id);
  }
  while (aliases.size > 200) aliases.delete(aliases.keys().next().value!);
  const readOnly = readonlyApprovals.filter((r) => {
    const rpcId = aliases.get(r.id) ?? r.id;
    return !answerableIds.has(rpcId) && !controller.inFlightIds.has(rpcId) &&
      !serverResolvedIds?.has(rpcId) && !approvals.some(a => a.sessionId === sessionId && (a.id === r.id || a.approvalId === r.id));
  });
  const unknownApprovals = partitioned.unknown.filter((a) => !controller.inFlightIds.has(a.id));
  const unknownApprovalIds = new Set(unknownApprovals.map((a) => a.id));
  const currentList = [...answerable, ...readOnly, ...unknownApprovals];
  const total = currentList.length;
  const safeIndex = clampQueueIndex(queueIndex, total);
  const current = currentList[safeIndex];
  const detailsExpanded = !!current && expandedRequestId === current.id;
  useEffect(() => {
    setExpandedRequestId(null);
  }, [current?.id]);
  const isCurrentAnswerable = !!current && answerableIds.has(current.id);
  const canAnswer = isCurrentAnswerable && gatewayOnline && !authInvalidated && !!onAnswer;
  /** 当前条目来源不明（缺少 sessionId）时仅展示，不提供任何审批操作 */
  const unknownSession = current ? unknownApprovalIds.has(current.id) : false;
  /** 当前条目已发出响应但结果未知（超时或中途断线未收到权威确认）：禁止盲目再次提交 */
  const isCurrentUnconfirmed = current ? controller.isUnconfirmed(current.id) : false;

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

  if (total === 0 && (inline || partitioned.otherGroups.length === 0)) {
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
      // 启动超时守卫：回调始终读取 latestStateRef 中最新的权威待审批列表、网关状态与鉴权终止态，
      // 绝不使用创建回调时捕获的旧值，防止过期回滚把已恢复的待审批误清或把已断线状态误判为在线。
      setTimeout(() => {
        const latest = latestStateRef.current;
        const rolledBack = controller.reconcile({
          serverPendingIds: new Set(latest.approvals.map((a) => a.id)),
          gatewayOnline: latest.gatewayOnline && !latest.authInvalidated,
          authInvalidated: latest.authInvalidated,
          serverResolvedIds: latest.serverResolvedIds,
          authoritativePendingAt: latest.authoritativePendingAt,
        });
        if (rolledBack) bump((n) => n + 1);
      }, APPROVAL_COMMIT_TIMEOUT_MS + 50);
    }
  };

  const switchQueue = (delta: number) => {
    if (total <= 1) return;
    controller.disarm();
    setExpandedRequestId(null);
    const next = (safeIndex + delta + total) % total;
    setQueueIndex(next);
  };

  const details = current ? extractApprovalDetails(current) : null;
  const requestTarget = details?.targetPath ?? details?.extraEntries.find(entry =>
    /^(?:url|uri|host|hostname|domain|target|resource|地址|域名)$/i.test(entry.key),
  )?.value;
  const risk = current ? assessApprovalRisk(current) : null;
  const submitError = current ? controller.errorFor(current.id) : null;

  return (
    <View testID={inline ? 'chat-approval-card' : 'approval-dock'} style={styles.dockContainer}>
      {/* 管家主聊天只展示已核实归属的请求，不要求切到其他审批会话。 */}
      {(inline ? [] : partitioned.otherGroups).map((group) => (
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
            accessibilityLabel={`展开${risk.highRisk ? '高危' : ''}待审批：${current.toolName}`}
          >
            <View style={styles.collapsedRow}>
              <Text style={[styles.icon, risk.highRisk ? styles.highRiskText : null]}>{risk.highRisk ? '⛔' : '⚠'}</Text>
              <Text style={styles.collapsedTitle} numberOfLines={1}>
                {risk.highRisk ? '高危待授权' : '等待授权'} ({safeIndex + 1}/{total}) · {current.toolName}
                {details.command ? ` · ${details.command}` : details.targetPath ? ` · ${details.targetPath}` : ''}
              </Text>
              <Text style={styles.collapseToggleText}>展开 ⌃</Text>
            </View>
            <Text style={[styles.riskTitle, risk.highRisk ? styles.highRiskText : null]}>
              {risk.highRisk ? `高危风险：${risk.riskReasons.join('；')}` : '风险提示：仅授权本次请求。'}
            </Text>
            {submitError ? <Text style={styles.errorText} accessibilityRole="alert">{submitError}</Text> : null}
          </Pressable>
        ) : (
          <View style={[styles.wrap, risk.highRisk ? styles.wrapHighRisk : null]}>
            {/* 顶栏：标题 + 多审批切换器 + 收起按钮 */}
            <View style={styles.headerRow}>
              <View style={styles.headerLeft}>
                <Text style={[styles.icon, risk.highRisk ? styles.highRiskText : null]}>{risk.highRisk ? '⛔' : '⚠'}</Text>
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

            {/* 请求摘要始终展示；长上下文只在卡片内滚动，不挤走操作按钮。 */}
            <ScrollView
              style={[styles.contextScroll, { maxHeight: Math.min(220, windowHeight * 0.3) }]}
              contentContainerStyle={styles.contextBody}
              nestedScrollEnabled
              key={current.id}
            >
              {details.command ? (
                <View style={styles.specSection}>
                  <Text style={styles.specLabel}>待执行命令</Text>
                  <Text style={styles.specCode} numberOfLines={3} selectable>{details.command}</Text>
                </View>
              ) : null}
              {requestTarget ? (
                <View style={styles.specSection}>
                  <Text style={styles.specLabel}>{details.targetPath ? '目标路径' : '请求目标'}</Text>
                  <Text style={styles.detail} numberOfLines={2} ellipsizeMode="middle">{requestTarget}</Text>
                </View>
              ) : null}
              {details.reasonText ? (
                <View style={styles.specSection}>
                  <Text style={styles.specLabel}>原因说明</Text>
                  <Text style={styles.detail} numberOfLines={2}>{details.reasonText}</Text>
                </View>
              ) : null}
              {!details.command && !requestTarget && !details.reasonText ? (
                <Text style={styles.detail}>请求使用 {current.toolName}</Text>
              ) : null}
              <Pressable
                onPress={() => setExpandedRequestId(detailsExpanded ? null : current.id)}
                style={styles.detailsToggle}
                accessibilityRole="button"
                accessibilityState={{ expanded: detailsExpanded }}
                accessibilityLabel={detailsExpanded ? '收起详情' : '查看详情'}
                accessibilityHint="查看完整命令、目标路径与全部附加参数"
              >
                <Text style={styles.detailsToggleText}>{detailsExpanded ? '收起详情 ⌃' : '查看详情 ⌄'}</Text>
              </Pressable>
              <Collapse open={detailsExpanded}>
                <View style={styles.specBox}>
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
                </View>
              </Collapse>
            </ScrollView>

            {/* 风险摘要不随详情折叠，也不随长命令滚出可视区。 */}
            <View style={[styles.riskBox, risk.highRisk ? styles.riskBoxHighRisk : null]}>
              <Text style={[styles.riskTitle, risk.highRisk ? styles.highRiskText : null]}>
                {risk.highRisk
                  ? `高危风险：${risk.riskReasons.join('；')}`
                  : '风险提示：请核对操作内容，仅授权本次请求。'}
              </Text>
              {risk.highRisk ? (
                <Text style={styles.riskSub}>允许前需再次点击确认。</Text>
              ) : null}
            </View>

            {/* 来源不明（缺少 sessionId）的安全禁用提示 */}
            {unknownSession ? (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>
                  这条审批缺少会话标识（sessionId），来源不明，已禁用「允许一次」。请到电脑上核对来源后再处理。
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
            {canAnswer && !unknownSession && !isCurrentUnconfirmed ? (
              <View style={styles.actions}>
                <Pressable
                  onPress={() => press('allowed-once')}
                  style={({ pressed }: { pressed: boolean }) => [
                    actions.base,
                    risk.highRisk ? actions.danger : actions.primary,
                    pressed ? { opacity: tv.motion.pressOpacity } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={armed ? '再次点击确认允许' : '允许一次'}
                >
                  <Text style={risk.highRisk ? actions.dangerFillText : actions.primaryText}>
                    {armed ? '再次点击确认允许' : '允许一次'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => press('rejected')}
                  style={({ pressed }: { pressed: boolean }) => [
                    actions.base,
                    styles.rejectAction,
                    pressed ? { opacity: tv.motion.pressOpacity } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="拒绝"
                >
                  <Text style={actions.quietText}>拒绝</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.help}>
                {unknownSession
                  ? '来源不明，已禁用审批操作。请到电脑上核对请求来源后再处理。'
                  : isCurrentUnconfirmed
                    ? '审批响应已发出但当前结果未知。为防止重复审批或重复执行，已禁止盲目再次允许，正在等待服务端权威状态确认。'
                  : !isCurrentAnswerable
                    ? '这条请求来自会话记录，无法在手机上回答。到电脑上确认，或把权限模式调成「完全访问」。'
                    : authInvalidated === 'forbidden'
                    ? '服务地址未被允许访问（HTTP 403：Host 未受信任），当前凭据已保留。请在电脑端将 Host 加入 trustedHosts 后重试。'
                    : authInvalidated
                      ? '登录状态已失效（401），无法提交审批。请先回配对页重新连接。'
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
    ? approvals.filter((a) => !!a.sessionId && workspaceSessionIds.has(a.sessionId))
    : approvals;
  const targetList = scoped.length > 0 ? scoped : approvals;
  const firstWithSession = targetList.find((a) => !!a.sessionId) ?? targetList[0]!;
  const jumpSessionId = firstWithSession.sessionId || sessions[0]?.sessionId || '';
  const targetTitle =
    (jumpSessionId ? titleMap.get(jumpSessionId) : undefined) ?? '待处理会话';
  const isOtherWorkspace = workspaceSessionIds && scoped.length === 0;
  const highRisk = targetList.some(item => assessApprovalRisk({ ...item, id: item.rpcId }).highRisk);

  return (
    <Pressable
      onPress={() => {
        if (jumpSessionId) onOpenSession(jumpSessionId, targetTitle);
      }}
      style={({ pressed }: { pressed: boolean }) => [
        styles.reminderStrip,
        highRisk ? styles.reminderHighRisk : null,
        pressed ? { opacity: tv.motion.pressOpacity } : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${highRisk ? '含高危操作，' : ''}待审批提醒：${targetTitle}，共 ${targetList.length} 个，点击前往处理`}
    >
      <Text style={[styles.reminderIcon, highRisk ? styles.highRiskText : null]}>{highRisk ? '⛔' : '⚠'}</Text>
      <View style={styles.reminderBody}>
        <Text style={styles.reminderTitle} numberOfLines={1}>
          {isOtherWorkspace
            ? `其他工作区有 ${targetList.length} 个待审批`
            : `${targetList.length} 个操作等待审批`}{' '}
          · {targetTitle}
        </Text>
        <Text style={styles.reminderSub} numberOfLines={1}>
          {firstWithSession.toolName}
          {firstWithSession.reason ? ` · ${firstWithSession.reason}` : ''}
        </Text>
      </View>
      <Text style={[styles.reminderAction, highRisk ? styles.highRiskText : null]}>{highRisk ? '含高危 · 去处理 ›' : '去处理 ›'}</Text>
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
      minHeight: 44,
      gap: tv.space.xs,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    collapsedRow: { flexDirection: 'row', alignItems: 'center' },
    collapsedBarHighRisk: { borderColor: C.danger },
    collapsedTitle: {
      flex: 1,
      color: C.text,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.medium,
    },
    collapseBtn: {
      minHeight: 44,
      justifyContent: 'center',
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
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    wrapHighRisk: { borderColor: C.danger },
    headerRow: { gap: tv.space.xs },
    headerLeft: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      minWidth: 0,
      rowGap: tv.space.xs,
    },
    headerRight: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-end',
      gap: 6,
    },
    icon: {
      fontSize: tv.type.sm,
      marginRight: tv.space.xs,
      color: C.warning,
    },
    highRiskText: { color: C.danger },
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
      flexShrink: 1,
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
    },
    pagerBtn: {
      minWidth: 44,
      minHeight: 44,
      alignItems: 'center',
      justifyContent: 'center',
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
    contextScroll: { marginTop: tv.space.xs },
    contextBody: { gap: tv.space.sm },
    detailsToggle: {
      minHeight: 44,
      justifyContent: 'center',
      alignSelf: 'flex-start',
      paddingHorizontal: tv.space.sm,
    },
    detailsToggleText: { color: C.accent, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    specBox: {
      padding: tv.space.sm,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgCard,
      gap: tv.space.sm,
    },
    specSection: {
      gap: 1,
    },
    specLabel: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
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
    },
    riskBoxHighRisk: { backgroundColor: C.dangerWash },
    riskTitle: {
      color: C.warning,
      fontSize: tv.type.xs,
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
      backgroundColor: C.dangerWash,
      borderWidth: 1,
      borderColor: C.danger,
    },
    errorText: {
      color: C.danger,
      fontSize: tv.type.micro,
      fontWeight: tv.weight.medium,
    },
    actions: {
      alignItems: 'stretch',
      gap: tv.space.xs,
      marginTop: tv.space.sm,
    },
    rejectAction: { backgroundColor: C.bgCard },
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
    reminderHighRisk: { backgroundColor: C.dangerWash, borderColor: C.danger },
    reminderIcon: {
      color: C.warning,
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
      color: C.warning,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.semibold,
      marginLeft: tv.space.sm,
    },
  });
}
