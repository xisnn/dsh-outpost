/**
 * 第二层：某个工作区下的会话列表。
 *
 * 视觉：卡片式会话行，手机创建的会话带橙色标记。
 * 右上角「＋」新建手机专属会话（可切换模型、可发消息）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useApp } from '../App';
import { Header } from '../components/Header';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import { radius, space, type, weight } from '../design/tokens';
import { Dot, Pill } from '../components/ui';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { RenameSheet } from '../components/RenameSheet';
import { CompatBanner } from '../components/CompatBanner';
import { filterSessions } from '../core/sessionSearch';

export { filterSessions } from '../core/sessionSearch';

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
  // 长按会话：先弹操作菜单（改名 / 删除），避免长按直接删除导致误操作
  const [actionTarget, setActionTarget] = useState<{ id: string; title: string } | null>(null);
  // 删除确认
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // 搜索
  const [query, setQuery] = useState('');
  // 重命名
  const [pendingRename, setPendingRename] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    return unsub;
  }, [store]);

  const onRefresh = async () => {
    setRefreshing(true);
    await store.loadSessions();
    setRefreshing(false);
  };

  /** 长按会话：弹操作菜单（改名 / 删除） */
  const askActions = (id: string, title: string) => {
    setActionTarget({ id, title });
  };

  const doRename = async (next: string) => {
    if (!pendingRename) return;
    setRenaming(true);
    setRenameError(null);
    try {
      await store.renameSession(pendingRename.id, next);
      setPendingRename(null);
    } catch (e) {
      setRenameError(e instanceof Error ? e.message : '改名失败');
    } finally {
      setRenaming(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await store.archiveSession(pendingDelete.id);
    } catch {
      // 失败就不删，列表保持原样
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
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

  const ws = store.workspaces.find((w) => w.path === workspacePath);
  const sessions = ws?.sessions ?? [];
  const shown = useMemo(() => filterSessions(sessions, query), [sessions, query]);

  /**
   * 工作区消失时自动返回。
   *
   * 触发场景：用户停在某个临时工作区（Temp 下的 dsh-prop-xxx）的会话列表，
   * 此时 store 刷新、临时工作区被过滤掉 → 这个 path 再也找不到。
   * 不自动退出的话，用户会看到一个「这个工作区还没有会话」的空页面，
   * 而且点「新建」还会往一个已经不存在的目录里建会话。
   *
   * 给一点延迟：加载中（workspaces 还是空）时不要误退。
   */
  useEffect(() => {
    if (ws) return;
    // workspaces 还没加载出来（首次进页面），不退
    if (store.workspaces.length === 0) return;
    const timer = setTimeout(() => {
      if (nav.canGoBack) nav.pop();
    }, 1200);
    return () => clearTimeout(timer);
  }, [ws, store.workspaces.length, nav]);

  return (
    <View style={styles.root}>
      <Header
        title={workspaceName || '会话'}
        subtitle={
          query.trim()
            ? `${shown.length} / ${sessions.length} 个会话`
            : `${sessions.length} 个会话`
        }
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

      {/* 搜索框。会话多了以后靠滚动找太费劲，这是最直接的解法 */}
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索会话"
          placeholderTextColor={tv.colors.textFaint}
          style={styles.searchInput}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10} style={styles.clearBtn}>
            <Text style={styles.clearText}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      <FlatList
        contentContainerStyle={styles.content}
        data={shown}
        keyExtractor={(s) => s.sessionId}
        // 长列表性能：限制首屏渲染数量，滚动时再补
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        // ⚠️ 不要加 removeClippedSubviews。
        // Android 上它会把离屏视图从原生层级里摘掉，导致**卡片点不动**
        // （触摸事件打不到已被移除的视图）。实测踩过：整个列表点了没反应。
        keyboardShouldPersistTaps="handled"
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
          query.trim() ? null : (
            <View>
              {/* DSH 版本不匹配时贴一条提示：哪些功能在当前 DSH 上不可用。
                  比「点了才发现没反应」好得多 —— 用户能提前知道。 */}
              <CompatBanner summary={store.compatSummary} missing={store.compatMissing} />
              <View style={styles.pathBox}>
                <Text style={styles.pathText} numberOfLines={2}>
                  {workspacePath || workspaceName}
                </Text>
              </View>
            </View>
          )
        }
        ListEmptyComponent={
          query.trim() ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>⌕</Text>
              <Text style={styles.empty}>没找到匹配「{query.trim()}」的会话</Text>
              <Text style={styles.emptyHint}>试试别的关键词，或者清空搜索</Text>
            </View>
          ) : (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>◌</Text>
              <Text style={styles.empty}>这个工作区还没有会话</Text>
              <Text style={styles.emptyHint}>点右上角「新建」创建手机专属会话</Text>
            </View>
          )
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
              onLongPress={() => askActions(item.sessionId, title)}
              delayLongPress={450}
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

      {/* 长按会话后的操作菜单 */}
      {actionTarget ? (
        <View style={styles.actionBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActionTarget(null)} />
          <View style={styles.actionSheet}>
            <Text style={styles.actionTitle} numberOfLines={1}>
              {actionTarget.title}
            </Text>
            <Pressable
              onPress={() => {
                setPendingRename(actionTarget);
                setActionTarget(null);
              }}
              style={({ pressed }: { pressed: boolean }) => [
                styles.actionRow,
                pressed ? { backgroundColor: tv.colors.bgCard } : null,
              ]}
            >
              <Text style={styles.actionText}>重命名</Text>
            </Pressable>
            <View style={styles.actionSep} />
            <Pressable
              onPress={() => {
                setPendingDelete(actionTarget);
                setActionTarget(null);
              }}
              style={({ pressed }: { pressed: boolean }) => [
                styles.actionRow,
                pressed ? { backgroundColor: tv.colors.bgCard } : null,
              ]}
            >
              <Text style={[styles.actionText, { color: tv.colors.danger }]}>删除</Text>
            </Pressable>
            <View style={styles.actionSep} />
            <Pressable
              onPress={() => setActionTarget(null)}
              style={({ pressed }: { pressed: boolean }) => [
                styles.actionRow,
                pressed ? { backgroundColor: tv.colors.bgCard } : null,
              ]}
            >
              <Text style={[styles.actionText, { color: tv.colors.textTertiary }]}>
                取消
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* 重命名 */}
      <RenameSheet
        visible={!!pendingRename}
        initialValue={pendingRename?.title ?? ''}
        busy={renaming}
        onCancel={() => {
          setPendingRename(null);
          setRenameError(null);
        }}
        onConfirm={(next) => void doRename(next)}
      />

      {renameError ? (
        <View style={styles.errorBar}>
          <Text style={styles.errorText} numberOfLines={2}>
            改名失败：{renameError}
          </Text>
        </View>
      ) : null}

      {/* 删除确认。删除 = 归档，能在「最近删除」里恢复 */}
      <ConfirmSheet
        visible={!!pendingDelete}
        title="删除这个对话？"
        message={`「${pendingDelete?.title ?? ''}」会从列表里移除。\n对话内容还在电脑上，可以恢复。`}
        confirmText={deleting ? '删除中…' : '删除'}
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
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

    // 搜索框
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: space.md,
      marginBottom: space.sm,
      paddingHorizontal: space.sm,
      borderRadius: radius.md,
      backgroundColor: C.bgCard,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    searchIcon: {
      color: C.textFaint,
      fontSize: type.base,
      marginRight: 6,
    },
    searchInput: {
      flex: 1,
      color: C.text,
      fontSize: type.sm,
      paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    },
    clearBtn: { padding: 6 },
    clearText: { color: C.textFaint, fontSize: type.sm },

    // 长按操作菜单
    actionBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'flex-end',
      padding: space.md,
      paddingBottom: space.xxl,
    },
    actionSheet: {
      backgroundColor: C.bgRaised,
      borderRadius: radius.lg,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    actionTitle: {
      color: C.textFaint,
      fontSize: type.xs,
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      paddingBottom: space.sm,
    },
    actionRow: {
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
    },
    actionText: { color: C.text, fontSize: type.base },
    actionSep: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: C.border,
      marginLeft: space.lg,
    },

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
