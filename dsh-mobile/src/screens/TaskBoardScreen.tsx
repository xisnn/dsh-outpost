/**
 * 独立任务板。
 *
 * 数据同样是会话投影里的 `agentTeam.tasks`。按状态分三组：
 * 进行中 / 待办 / 已完成，每条显示负责人。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../App';
import { Header } from '../components/Header';
import { useTheme } from '../design/theme';
import type { AgentTeam, TeamTask } from '../core/types';

const GROUPS: Array<{ status: TeamTask['status']; label: string }> = [
  { status: 'in_progress', label: '进行中' },
  { status: 'pending', label: '待办' },
  { status: 'completed', label: '已完成' },
];

export function TaskBoardScreen({ sessionId }: { sessionId: string }) {
  const { store } = useApp();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [, force] = useState(0);

  useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    void store.refreshChatMeta(sessionId);
    return unsub;
  }, [store, sessionId]);

  // 优先用已打开会话的状态，否则退回 session/list 里的投影
  const team: AgentTeam | undefined =
    store.getChat(sessionId).agentTeam ??
    store.sessions.find((s) => s.sessionId === sessionId)?.projections?.values?.agentTeam;

  const tasks = (team?.tasks ?? []).filter((t) => t.status !== 'deleted');
  const memberName = (id?: string) => {
    const m = (team?.members ?? []).find((x) => x.id === id);
    return m?.name;
  };

  return (
    <View style={styles.root}>
      <Header title="任务板" subtitle={`${tasks.length} 项`} showBack />
      <ScrollView contentContainerStyle={styles.content}>
        {GROUPS.map((g) => {
          const list = tasks.filter((t) => t.status === g.status);
          if (list.length === 0) return null;
          return (
            <View key={g.status} style={styles.group}>
              <Text style={styles.groupLabel}>
                {g.label} · {list.length}
              </Text>
              {list.map((t) => (
                <View key={t.id} style={styles.card}>
                  <View style={styles.cardTop}>
                    <Text
                      style={[
                        styles.statusIcon,
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
                      {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
                    </Text>
                    <Text style={styles.subject} numberOfLines={3}>
                      {t.subject}
                    </Text>
                  </View>
                  <View style={styles.metaRow}>
                    {t.ownerName ? (
                      <View style={styles.ownerPill}>
                        <Text style={styles.ownerText}>{t.ownerName}</Text>
                      </View>
                    ) : (
                      <Text style={styles.unassigned}>未分配</Text>
                    )}
                    {t.blockedBy.length > 0 ? (
                      <Text style={styles.blocked}>被 {t.blockedBy.length} 项阻塞</Text>
                    ) : null}
                    {t.writeScopes.length > 0 ? (
                      <Text style={styles.scope} numberOfLines={1}>
                        {t.writeScopes.join(', ')}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          );
        })}

        {tasks.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>☰</Text>
            <Text style={styles.emptyText}>还没有任务</Text>
            <Text style={styles.emptyHint}>管家派活后，任务会出现在这里</Text>
          </View>
        ) : null}

        {team?.failure ? <Text style={styles.failure}>{team.failure}</Text> : null}
        <View style={{ height: tv.space.xxxl }} />
      </ScrollView>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    content: { paddingTop: tv.space.md },
    group: { marginBottom: tv.space.lg },
    groupLabel: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      letterSpacing: 0.6,
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
    },
    card: {
      marginHorizontal: tv.layout.screenPadding,
      marginBottom: tv.space.sm,
      padding: tv.space.md,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
    statusIcon: { width: 18, fontSize: 13, marginRight: 4, marginTop: 1 },
    subject: { flex: 1, color: C.text, fontSize: tv.type.sm, lineHeight: tv.type.sm * 1.45 },
    metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: tv.space.sm, flexWrap: 'wrap' },
    ownerPill: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: tv.radius.sm,
      backgroundColor: C.accentWash,
      marginRight: tv.space.sm,
    },
    ownerText: { color: C.accentBright, fontSize: tv.type.micro },
    unassigned: { color: C.textFaint, fontSize: tv.type.micro, marginRight: tv.space.sm },
    blocked: { color: C.warning, fontSize: tv.type.micro, marginRight: tv.space.sm },
    scope: { color: C.textFaint, fontSize: tv.type.micro, flexShrink: 1 },

    empty: { alignItems: 'center', paddingVertical: tv.space.xxxl },
    emptyIcon: { color: C.textFaint, fontSize: 36, marginBottom: tv.space.md },
    emptyText: { color: C.textSecondary, fontSize: tv.type.base },
    emptyHint: { color: C.textFaint, fontSize: tv.type.xs, marginTop: tv.space.sm },
    failure: { color: C.danger, fontSize: tv.type.xs, marginHorizontal: tv.layout.screenPadding },
  });
}
