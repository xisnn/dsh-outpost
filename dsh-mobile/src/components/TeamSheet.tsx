/**
 * 团队浮层：点顶部头像条弹出，卡片式列出每个队员「在干什么」。
 * 再点某一张卡片才进入那个队员的事件流（他的会话）。
 */
import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../design/theme';
import { memberStates, teamSummary, STATUS_LABEL, type MemberStatus } from '../core/team';
import type { AgentTeam, TeamMember } from '../core/types';

function statusColor(
  status: MemberStatus,
  colors: ReturnType<typeof useTheme>['colors'],
): string {
  switch (status) {
    case 'working':
      return colors.accent;
    case 'done':
      return colors.success;
    case 'failed':
      return colors.danger;
    default:
      return colors.textTertiary;
  }
}

export function TeamSheet({
  visible,
  team,
  onClose,
  onSelect,
  onOpenTasks,
}: {
  visible: boolean;
  team?: AgentTeam;
  onClose: () => void;
  onSelect: (member: TeamMember) => void;
  /** 打开独立任务板 */
  onOpenTasks?: () => void;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const states = memberStates(team);
  const { working } = teamSummary(states);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.card, { marginBottom: Math.max(insets.bottom, tv.space.lg) + 24 }]}>
          <View style={styles.header}>
            <Text style={styles.title}>团队</Text>
            <Text style={styles.sub}>
              {states.length} 名队员{working > 0 ? ` · ${working} 人在干活` : ' · 都闲着'}
            </Text>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {states.map((s) => (
              <Pressable
                key={s.member.id}
                onPress={() => onSelect(s.member)}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.row,
                  pressed ? { backgroundColor: tv.colors.bgCard } : null,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`查看 ${s.member.name}`}
              >
                <View
                  style={[
                    styles.avatar,
                    {
                      borderColor: statusColor(s.status, tv.colors),
                      backgroundColor: tv.colors.bgOverlay,
                    },
                  ]}
                >
                  <Text style={styles.avatarText}>
                    {(s.member.name || '?').trim().charAt(0).toUpperCase()}
                  </Text>
                </View>

                <View style={styles.body}>
                  <View style={styles.nameLine}>
                    <Text style={styles.name} numberOfLines={1}>
                      {s.member.name}
                    </Text>
                    <View
                      style={[styles.pill, { backgroundColor: statusColor(s.status, tv.colors) + '1f' }]}
                    >
                      <Text style={[styles.pillText, { color: statusColor(s.status, tv.colors) }]}>
                        {STATUS_LABEL[s.status]}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.desc} numberOfLines={2}>
                    {s.desc}
                  </Text>
                </View>

                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </ScrollView>

          {onOpenTasks && states.length > 0 ? (
            <Pressable
              onPress={onOpenTasks}
              style={({ pressed }: { pressed: boolean }) => [
                styles.tasksBtn,
                pressed ? { backgroundColor: tv.colors.bgCard } : null,
              ]}
            >
              <Text style={styles.tasksBtnText}>查看全部任务</Text>
              <Text style={styles.tasksBtnChevron}>›</Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={onClose}
            style={({ pressed }: { pressed: boolean }) => [
              styles.close,
              pressed ? { opacity: 0.7 } : null,
            ]}
          >
            <Text style={styles.closeText}>关闭</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: C.scrim,
      paddingHorizontal: tv.space.lg,
    },
    card: {
      maxHeight: '68%',
      borderRadius: tv.radius.xl,
      backgroundColor: C.bg,
      paddingTop: tv.space.lg,
      paddingHorizontal: tv.space.lg,
      // 浮起来
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    },
    header: { marginBottom: tv.space.md },
    title: { color: C.text, fontSize: tv.type.lg, fontWeight: tv.weight.semibold },
    sub: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 3 },

    list: { flexGrow: 0 },
    listContent: { paddingBottom: tv.space.xs },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: tv.space.sm,
      paddingHorizontal: tv.space.xs,
      borderRadius: tv.radius.md,
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: tv.space.md,
    },
    avatarText: { color: C.textSecondary, fontSize: 15, fontWeight: tv.weight.semibold },
    body: { flex: 1 },
    nameLine: { flexDirection: 'row', alignItems: 'center' },
    name: { color: C.text, fontSize: tv.type.base, fontWeight: tv.weight.medium, flexShrink: 1 },
    pill: {
      marginLeft: tv.space.sm,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: tv.radius.sm,
    },
    pillText: { fontSize: tv.type.micro, fontWeight: tv.weight.medium },
    desc: { color: C.textTertiary, fontSize: tv.type.xs, marginTop: 3 },
    chevron: { color: C.textFaint, fontSize: 20, marginLeft: tv.space.sm },

    close: {
      marginTop: tv.space.sm,
      paddingVertical: tv.space.md,
      alignItems: 'center',
    },
    closeText: { color: C.textSecondary, fontSize: tv.type.base },

    tasksBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: tv.space.xs,
      paddingVertical: tv.space.md,
      paddingHorizontal: tv.space.sm,
      borderRadius: tv.radius.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    tasksBtnText: { color: C.accentBright, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    tasksBtnChevron: { color: C.textFaint, fontSize: 20 },
  });
}
