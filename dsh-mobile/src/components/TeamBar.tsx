/**
 * 团队状态条：显示当前会话的 Agent Teams 名册与任务进度。
 *
 * 数据来自会话投影 `projections.values.agentTeam`（DSH 自带，不需要额外 RPC）：
 *   members[]: { id, name, role: 'lead'|'teammate', phase: 'active'|'provisioning'|'failed' }
 *   tasks[]:   { id, subject, status: 'pending'|'in_progress'|'completed', ownerName }
 *
 * 收起时只有一行（队员头像 + 进度），点开是任务清单。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import type { AgentTeam, TeamMember, TeamTask } from '../core/types';

function phaseColor(m: TeamMember, colors: ReturnType<typeof useTheme>['colors']): string {
  if (m.phase === 'failed') return colors.danger;
  if (m.phase === 'provisioning') return colors.warning;
  return colors.success;
}

function MiniAvatar({
  member,
  colors,
  styles,
}: {
  member: TeamMember;
  colors: ReturnType<typeof useTheme>['colors'];
  styles: ReturnType<typeof makeStyles>;
}) {
  const ch = (member.name || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={styles.avatarWrap}>
      <View style={[styles.avatar, { backgroundColor: colors.bgOverlay }]}>
        <Text style={[styles.avatarText, { color: colors.textSecondary }]}>{ch}</Text>
      </View>
      <View style={[styles.phaseDot, { backgroundColor: phaseColor(member, colors) }]} />
    </View>
  );
}

const TASK_ICON: Record<TeamTask['status'], string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
  deleted: '×',
};

export function TeamBar({ team }: { team?: AgentTeam }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);

  if (!team) return null;
  const members = (team.members ?? []).filter((m) => m.role === 'teammate');
  const tasks = (team.tasks ?? []).filter((t) => t.status !== 'deleted');
  if (members.length === 0 && tasks.length === 0) return null;

  const running = tasks.filter((t) => t.status === 'in_progress').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const parts: string[] = [];
  if (running) parts.push(`${running} 进行中`);
  if (pending) parts.push(`${pending} 待办`);
  if (done) parts.push(`${done} 完成`);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={{ top: 8, bottom: 8 }}
        style={({ pressed }: { pressed: boolean }) => [
          styles.bar,
          pressed ? { backgroundColor: tv.colors.bgCard } : null,
        ]}
        accessibilityRole="button"
        accessibilityLabel="团队状态"
      >
        <Text style={styles.label}>团队</Text>
        <View style={styles.avatars}>
          {members.slice(0, 5).map((m) => (
            <MiniAvatar key={m.id} member={m} colors={tv.colors} styles={styles} />
          ))}
          {members.length > 5 ? <Text style={styles.more}>+{members.length - 5}</Text> : null}
        </View>
        <Text style={styles.summary} numberOfLines={1}>
          {parts.length ? parts.join(' · ') : '暂无任务'}
        </Text>
        <Text style={styles.chevron}>{open ? '⌃' : '⌄'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.panel}>
          {members.map((m) => (
            <View key={m.id} style={styles.row}>
              <View style={[styles.dot, { backgroundColor: phaseColor(m, tv.colors) }]} />
              <Text style={styles.rowMain} numberOfLines={1}>
                {m.name}
              </Text>
              <Text style={styles.rowMeta}>
                {m.phase === 'failed' ? '失败' : m.phase === 'provisioning' ? '创建中' : '就绪'}
              </Text>
            </View>
          ))}
          {members.length > 0 && tasks.length > 0 ? <View style={styles.divider} /> : null}
          {tasks.map((t) => (
            <View key={t.id} style={styles.row}>
              <Text
                style={[
                  styles.taskIcon,
                  {
                    color:
                      t.status === 'completed'
                        ? tv.colors.success
                        : t.status === 'in_progress'
                          ? tv.colors.accent
                          : tv.colors.textTertiary,
                  },
                ]}
              >
                {TASK_ICON[t.status]}
              </Text>
              <Text style={styles.rowMain} numberOfLines={1}>
                {t.subject}
              </Text>
              {t.ownerName ? <Text style={styles.rowMeta}>{t.ownerName}</Text> : null}
            </View>
          ))}
          {team.failure ? <Text style={styles.failure}>{team.failure}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: { marginHorizontal: tv.layout.screenPadding, marginBottom: tv.space.xs },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tv.space.sm,
      paddingVertical: 8,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    label: { color: C.textTertiary, fontSize: tv.type.micro, marginRight: tv.space.sm },
    avatars: { flexDirection: 'row', alignItems: 'center' },
    avatarWrap: { marginRight: 3 },
    avatar: {
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { fontSize: 10, fontWeight: tv.weight.semibold },
    phaseDot: {
      position: 'absolute',
      right: -1,
      bottom: -1,
      width: 7,
      height: 7,
      borderRadius: 3.5,
      borderWidth: 1,
      borderColor: C.bgRaised,
    },
    more: { color: C.textTertiary, fontSize: tv.type.micro, marginLeft: 2 },
    summary: { flex: 1, color: C.textSecondary, fontSize: tv.type.micro, marginLeft: tv.space.sm },
    chevron: { color: C.textFaint, fontSize: tv.type.sm, marginLeft: tv.space.xs },

    panel: {
      marginTop: 4,
      paddingVertical: tv.space.xs,
      paddingHorizontal: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
    dot: { width: 6, height: 6, borderRadius: 3, marginRight: tv.space.sm },
    taskIcon: { width: 14, fontSize: 12, marginRight: tv.space.sm, textAlign: 'center' },
    rowMain: { flex: 1, color: C.textSecondary, fontSize: tv.type.xs },
    rowMeta: { color: C.textFaint, fontSize: tv.type.micro, marginLeft: tv.space.sm },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: C.border,
      marginVertical: 4,
    },
    failure: { color: C.danger, fontSize: tv.type.micro, marginTop: 4 },
  });
}
