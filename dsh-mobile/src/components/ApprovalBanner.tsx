/**
 * 审批横幅：工具需要授权、但手机端无法响应时，给用户一个明确说明。
 *
 * 背景：DSH 的审批（approval）目前没有暴露 RPC 响应通道。
 * 我试了 12 个候选端点名（approval/decide、session/approval 等）全部 not found，
 * `permissionPresets` 命名空间下也只有 `catalog` 一个方法。
 * 所以手机上点了「拒绝」也没法真正回给服务端。
 *
 * 那就不装作能操作 —— 直接告诉用户三件事：
 *   1. 现在卡在哪一步（哪个工具要授权）
 *   2. 为什么手机上处理不了
 *   3. 怎么办（去电脑确认，或调高权限模式）
 *
 * 这样至少不会让人对着转圈猜。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

export interface PendingApproval {
  id: string;
  toolName: string;
  reason?: string;
}

export function ApprovalBanner({ approvals }: { approvals: PendingApproval[] }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  if (approvals.length === 0) return null;
  const first = approvals[0];

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.icon}>⚠</Text>
        <View style={styles.body}>
          <Text style={styles.title}>
            管家在等授权{approvals.length > 1 ? `（还有 ${approvals.length - 1} 个）` : ''}
          </Text>
          <Text style={styles.detail} numberOfLines={2}>
            {first.toolName}
            {first.reason ? ` · ${first.reason}` : ''}
          </Text>
        </View>
      </View>
      <Text style={styles.help}>
        手机端目前不能确认这类请求。可以到电脑上点允许，或把权限模式调成「完全访问」。
      </Text>
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
    help: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      lineHeight: tv.type.micro * 1.6,
      marginTop: tv.space.sm,
      paddingLeft: tv.type.sm + tv.space.sm,
    },
  });
}
