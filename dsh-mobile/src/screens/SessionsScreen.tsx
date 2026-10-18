/**
 * 第二层：某个工作区下的会话列表。
 *
 * 视觉：卡片式会话行，手机创建的会话带橙色标记。
 * 右上角「＋」新建手机专属会话（可切换模型、可发消息）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useApp } from '../App';
import { Header } from '../components/Header';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import { radius, space, type, weight } from '../design/tokens';
import { Dot, Pill } from '../components/ui';

function formatAgo(ts: number): string {
  if (!ts) return '';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function SessionsScreen({
  workspacePath,
  workspaceName,
}: {
  workspacePath: string;
  workspaceName: string;
}) {
  const { store } = useApp();
  const nav = useNav();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [, force] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    return unsub;
  }, [store]);

  const onRefresh = async () => {
    setRefreshing(true);
    await store.loadSessions();
    setRefreshing(false);
  };

  const createNew = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const sessionId = await store.createSession(workspacePath);
      nav.push('Chat', { sessionId, title: '新会话' });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const sessions = store.workspaces.find((w) => w.path === workspacePath)?.sessions ?? [];

  return (
    <View style={styles.root}>
      <Header
        title={workspaceName || '会话'}
        subtitle={`${sessions.length} 个会话`}
        compact
        right={
          <Pressable
            onPress={() => void createNew()}
            disabled={creating}
            hitSlop={12}
            style={({ pressed }: { pressed: boolean }) => [
              styles.newBtn,
              pressed ? { opacity: 0.6 } : null,
              creating ? { opacity: 0.4 } : null,
            ]}
          >
            {creating ? (
              <ActivityIndicator size="small" color={tv.colors.accent} />
            ) : (
              <Text style={styles.newBtnText}>新建</Text>
            )}
          </Pressable>
        }
      />

      {createError ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText} numberOfLines={3}>
            {createError}
          </Text>
        </View>
      ) : null}

      <FlatList
        contentContainerStyle={styles.content}
        data={sessions}
        keyExtractor={(s) => s.sessionId}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={tv.colors.textTertiary}
            colors={[tv.colors.accent]}
            progressBackgroundColor={tv.colors.bgCard}
          />
        }
        ListHeaderComponent={
          <View style={styles.pathBox}>
            <Text style={styles.pathText} numberOfLines={2}>
              {workspacePath || workspaceName}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            <Text style={styles.emptyIcon}>◌</Text>
            <Text style={styles.empty}>这个工作区还没有会话</Text>
            <Text style={styles.emptyHint}>点右上角「新建」创建手机专属会话</Text>
          </View>
        }
        renderItem={({ item }: { item: (typeof sessions)[number] }) => {
          const v = item.projections?.values;
          const title = v?.title ?? '未命名会话';
          const pressure = v?.contextPressure;
          const ratio =
            pressure && pressure.contextWindow
              ? (pressure.pressureTokens ?? 0) / pressure.contextWindow
              : 0;
          const owned = store.isOwned(item.sessionId);
          const modelName = v?.model?.model ? String(v.model.model).split('/').pop() : null;

          return (
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [
                styles.card,
                pressed && styles.cardPressed,
              ]}
              onPress={() => nav.push('Chat', { sessionId: item.sessionId, title })}
            >
              <View style={styles.cardTop}>
                <Text style={styles.title} numberOfLines={2}>
                  {title}
                </Text>
                {item.running ? (
                  <View style={styles.runningBadge}>
                    <Dot color={tv.colors.success} size={5} />
                    <Text style={styles.runningText}>运行中</Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.tagRow}>
                {owned ? (
                  <View style={styles.ownedTag}>
                    <Text style={styles.ownedText}>手机</Text>
                  </View>
                ) : null}
                {item.blank ? <Pill text="空白" /> : null}
                {modelName ? <Pill text={modelName} /> : null}
                {ratio > 0 ? (
                  <Pill
                    text={`${Math.round(ratio * 100)}%`}
                    color={
                      ratio > 0.85
                        ? tv.colors.danger
                        : ratio > 0.7
                          ? tv.colors.warning
                          : tv.colors.textTertiary
                    }
                    bg={
                      ratio > 0.85
                        ? tv.colors.dangerWash
                        : ratio > 0.7
                          ? tv.colors.warningWash
                          : tv.colors.bgOverlay
                    }
                  />
                ) : null}
              </View>

              <View style={styles.cardBottom}>
                <Text style={styles.time}>{formatAgo(item.updatedAt)}</Text>
                <Text style={styles.sid} numberOfLines={1}>
                  {item.sessionId}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    content: { paddingBottom: space.xxxl },
    newBtn: {
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: C.accentWash,
      minWidth: 52,
      alignItems: 'center',
    },
    newBtnText: { color: C.accentBright, fontSize: type.sm, fontWeight: weight.semibold },
    errorBar: {
      backgroundColor: C.dangerWash,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
    },
    errorText: { color: C.danger, fontSize: type.xs },

    pathBox: {
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      paddingBottom: space.sm,
    },
    pathText: {
      color: C.textFaint,
      fontSize: type.xs,
      fontFamily: 'monospace',
    },

    emptyBox: { padding: space.xxxl, alignItems: 'center' },
    emptyIcon: { color: C.textFaint, fontSize: 36, marginBottom: space.md },
    empty: { color: C.textSecondary, fontSize: type.base },
    emptyHint: { color: C.textFaint, fontSize: type.xs, marginTop: space.sm },

    card: {
      marginHorizontal: space.md,
      marginBottom: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.md,
      backgroundColor: C.bgRaised,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    cardPressed: { backgroundColor: C.bgCard, borderColor: C.borderStrong },
    cardTop: { flexDirection: 'row', alignItems: 'flex-start' },
    title: {
      color: C.text,
      fontSize: type.base,
      fontWeight: weight.medium,
      lineHeight: type.base * type.lineTight,
      flex: 1,
    },
    runningBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: space.sm,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.sm,
      backgroundColor: C.successWash,
    },
    runningText: {
      color: C.success,
      fontSize: type.micro,
      marginLeft: 4,
      fontWeight: weight.medium,
    },
    tagRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: space.sm,
      flexWrap: 'wrap',
      gap: 6,
    },
    ownedTag: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: radius.sm,
      backgroundColor: C.accentWash,
    },
    ownedText: { color: C.accentBright, fontSize: type.micro, fontWeight: weight.semibold },
    cardBottom: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: space.sm,
      justifyContent: 'space-between',
    },
    time: { color: C.textFaint, fontSize: type.micro },
    sid: {
      color: C.textFaint,
      fontSize: type.micro,
      flex: 1,
      textAlign: 'right',
      marginLeft: space.md,
    },
  });
}
