/**
 * 管家首页顶部的团队头像条。
 *
 * 一行头像，状态用环色区分（进行中 / 待命 / 已完成 / 失败），
 * 点任意位置弹出「成员在干什么」的浮动卡片（TeamSheet）。
 */
import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { memberStates, teamSummary, type MemberState } from '../core/team';
import type { AgentTeam } from '../core/types';

function statusColor(
  status: MemberState['status'],
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
      return colors.borderStrong;
  }
}

export function TeamStrip({ team, onOpen }: { team?: AgentTeam; onOpen: () => void }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const states = memberStates(team);
  if (states.length === 0) return null;

  const { working, done } = teamSummary(states);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onOpen}
        style={({ pressed }: { pressed: boolean }) => [
          styles.inner,
          pressed ? { opacity: 0.75 } : null,
        ]}
        accessibilityRole="button"
        accessibilityLabel="查看团队"
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
          style={styles.scroll}
          pointerEvents="none"
        >
          {states.map((s) => (
            <View key={s.member.id} style={styles.item}>
              <View
                style={[
                  styles.avatar,
                  { borderColor: statusColor(s.status, tv.colors), backgroundColor: tv.colors.bgOverlay },
                ]}
              >
                <Text style={[styles.avatarText, { color: tv.colors.textSecondary }]}>
                  {(s.member.name || '?').trim().charAt(0).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.name} numberOfLines={1}>
                {s.member.name}
              </Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.tally}>
          <Text style={styles.tallyText}>
            {working > 0 ? `${working} 在干活` : '都闲着'}
            {done > 0 ? ` · ${done} 已完成` : ''}
          </Text>
          <Text style={styles.chevron}>›</Text>
        </View>
      </Pressable>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      paddingHorizontal: tv.layout.screenPadding,
      paddingBottom: tv.space.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
      backgroundColor: C.bg,
    },
    inner: { flexDirection: 'row', alignItems: 'center' },
    scroll: { flexGrow: 0, flexShrink: 1 },
    row: { alignItems: 'flex-end', paddingVertical: 4 },
    item: { width: 52, alignItems: 'center' },
    avatar: {
      width: 34,
      height: 34,
      borderRadius: 17,
      borderWidth: 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { fontSize: 14, fontWeight: tv.weight.semibold },
    name: { color: C.textTertiary, fontSize: 9, marginTop: 3, maxWidth: 50, textAlign: 'center' },
    tally: { flexDirection: 'row', alignItems: 'center', marginLeft: 'auto', paddingLeft: tv.space.sm },
    tallyText: { color: C.textFaint, fontSize: tv.type.micro },
    chevron: { color: C.textFaint, fontSize: 18, marginLeft: 2 },
  });
}
