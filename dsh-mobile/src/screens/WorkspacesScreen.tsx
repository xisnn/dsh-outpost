/**
 * 第一层：工作区列表。
 *
 * 视觉：类似 iOS 分组列表 + 渐变图标。
 * 每个工作区显示：图标、名称、最近会话预览、会话数、运行状态。
 *
 * 改名 / 换头像：长按某一行打开底部弹层（纯客户端覆盖，不改真实目录）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../App';
import { useNav } from '../nav/NavHost';
import { useTheme } from '../design/theme';
import { layout, space, type, weight } from '../design/tokens';
import type { Workspace } from '../core/types';
import { Avatar, Dot, Tile } from '../components/ui';
import { WorkspaceSheet } from '../components/WorkspaceSheet';
import { NewWorkspaceSheet } from '../components/NewWorkspaceSheet';
import { CompatBanner } from '../components/CompatBanner';

function formatAgo(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = Math.floor(hr / 24);
  if (d === 1) return '昨天';
  if (d < 7) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** 最近用过的工作区路径（本地存，只用于输入提示） */
const RECENT_WS_KEY = '@dsh/recentWorkspaces';

export function WorkspacesScreen() {
  const { store } = useApp();
  const nav = useNav();
  const insets = useSafeAreaInsets();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [, force] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // 新建工作区
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

  // 最近成功用过的工作区路径（只存本地，不是服务端数据）
  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(RECENT_WS_KEY);
        if (raw) setRecentPaths(JSON.parse(raw) as string[]);
      } catch {
        // 读不到就当没有
      }
    })();
  }, []);

  const submitWorkspace = useCallback(
    async (input: string) => {
      setCreating(true);
      setCreateError(undefined);
      const res = await store.createWorkspace(input);
      setCreating(false);
      if (!res.ok) {
        setCreateError(res.error);
        return;
      }
      // 成功后记进「最近用过」并关闭
      const next = [res.path, ...recentPaths.filter((p) => p !== res.path)].slice(0, 6);
      setRecentPaths(next);
      void AsyncStorage.setItem(RECENT_WS_KEY, JSON.stringify(next));
      setCreateOpen(false);
    },
    [recentPaths, store],
  );

  useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    if (store.workspaces.length === 0) void store.loadSessions();
    return unsub;
  }, [store]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await store.loadSessions();
    setRefreshing(false);
  }, [store]);

  const total = useMemo(
    () => store.workspaces.reduce((n, w) => n + w.sessions.length, 0),
    [store.workspaces],
  );

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          {nav.canGoBack ? (
            <Pressable
              onPress={nav.pop}
              hitSlop={12}
              style={({ pressed }: { pressed: boolean }) => [
                styles.backBtn,
                pressed ? { opacity: 0.55 } : null,
              ]}
            >
              <Text style={styles.backIcon}>‹</Text>
            </Pressable>
          ) : null}
          <Text style={styles.headerTitle}>DSH</Text>
          <Text style={styles.headerSub}>
            {store.workspaces.length} 个目录 · {total} 个会话
          </Text>
        </View>
        {/* 新建工作区 */}
        <Pressable
          onPress={() => {
            setCreateError(undefined);
            setCreateOpen(true);
          }}
          hitSlop={10}
          style={({ pressed }: { pressed: boolean }) => [
            styles.newBtn,
            pressed ? { opacity: 0.6 } : null,
          ]}
          accessibilityRole="button"
          accessibilityLabel="新建工作区"
        >
          <Text style={styles.newBtnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );

  if (store.sessionsLoading && store.workspaces.length === 0) {
    return (
      <View style={styles.root}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={tv.colors.accent} />
          <Text style={styles.loadingText}>正在读取…</Text>
        </View>
      </View>
    );
  }

  if (store.sessionsError && store.workspaces.length === 0) {
    return (
      <View style={styles.root}>
        {header}
        <View style={styles.center}>
          <Text style={styles.errorTitle}>加载失败</Text>
          <Text style={styles.errorBody}>{store.sessionsError}</Text>
          <Pressable style={styles.retry} onPress={() => void store.loadSessions()}>
            <Text style={styles.retryText}>重试</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const editingWs: Workspace | undefined = editing
    ? store.workspaces.find((w) => w.path === editing)
    : undefined;

  return (
    <View style={styles.root}>
      {header}
      {/* 连接失败时给出可操作的提示。
          之前错误只存在 store 里没人显示 —— 用户网络断了只看到空列表，
          完全不知道为什么。connectionHint 是分类过的中文提示。 */}
      {store.connection === 'error' && store.connectionHint ? (
        <View style={styles.netBar}>
          <Text style={styles.netIcon}>⚠</Text>
          <View style={styles.netBody}>
            <Text style={styles.netTitle} numberOfLines={2}>
              {store.connectionHint.split('\n')[0]}
            </Text>
            <Text style={styles.netHint} numberOfLines={3}>
              {store.connectionHint.split('\n').slice(1).join(' ')}
            </Text>
          </View>
        </View>
      ) : null}
      <CompatBanner summary={store.compatSummary} missing={store.compatMissing} />
      <FlatList
        contentContainerStyle={styles.content}
        data={store.workspaces}
        keyExtractor={(w) => w.path || '__none__'}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={tv.colors.textTertiary}
            colors={[tv.colors.accent]}
            progressBackgroundColor={tv.colors.bgCard}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyIcon}>◫</Text>
            <Text style={styles.empty}>还没有会话</Text>
            <Text style={styles.emptyHint}>在电脑上开一个 DSH 会话就会出现在这里</Text>
          </View>
        }
        ListFooterComponent={
          store.workspaces.length > 0 ? (
            <Text style={styles.footerHint}>长按工作区可改名或换头像</Text>
          ) : null
        }
        renderItem={({ item }: { item: (typeof store.workspaces)[number] }) => {
          const latest = item.sessions[0];
          const title = latest?.projections?.values?.title ?? '未命名会话';
          const custom = store.customFor(item.path);
          const displayName = custom?.name?.trim() || item.name;
          return (
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [
                styles.row,
                pressed && styles.rowPressed,
              ]}
              onPress={() =>
                nav.push('Sessions', {
                  workspacePath: item.path,
                  workspaceName: displayName,
                })
              }
              onLongPress={() => setEditing(item.path)}
              delayLongPress={350}
            >
              <Tile label={displayName} size={layout.avatarMd} emoji={custom?.emoji} />
              <View style={styles.rowBody}>
                <View style={styles.rowTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {displayName}
                  </Text>
                  <Text style={styles.time}>{formatAgo(item.updatedAt)}</Text>
                </View>
                <View style={styles.rowMid}>
                  {item.running ? (
                    <View style={styles.runningWrap}>
                      <Dot color={tv.colors.success} size={5} />
                      <Text style={styles.runningText}>运行中</Text>
                    </View>
                  ) : null}
                  <Text style={styles.preview} numberOfLines={1}>
                    {title}
                  </Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text style={styles.path} numberOfLines={1}>
                    {item.path || '未记录目录'}
                  </Text>
                  <View style={styles.countWrap}>
                    <Text style={styles.countText}>{item.sessions.length}</Text>
                  </View>
                </View>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          );
        }}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
      />

      <WorkspaceSheet
        visible={editing !== null}
        path={editing ?? ''}
        fallbackName={editingWs?.name ?? ''}
        current={editing ? store.customFor(editing) : undefined}
        onClose={() => setEditing(null)}
        onSave={(patch) => {
          if (editing) store.setWorkspaceCustom(editing, patch);
        }}
      />

      <NewWorkspaceSheet
        visible={createOpen}
        existingPaths={store.workspaces.map((w) => w.path)}
        recentPaths={recentPaths}
        busy={creating}
        error={createError}
        onSubmit={(p) => void submitWorkspace(p)}
        onClose={() => setCreateOpen(false)}
      />
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },

    // 连接错误提示条（和下面已有的 errorTitle/errorBody 区分开，
    // 那两个是「会话列表加载失败」用的，这里是「连不上服务」用的）
    netBar: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      marginHorizontal: layout.screenPadding,
      marginTop: space.xs,
      paddingVertical: 7,
      paddingHorizontal: 9,
      borderRadius: 8,
      backgroundColor: C.dangerWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
    },
    netIcon: { color: C.danger, fontSize: type.xs, lineHeight: type.xs * 1.5 },
    netBody: { flex: 1, gap: 2 },
    netTitle: {
      color: C.danger,
      fontSize: type.micro,
      lineHeight: type.xs * 1.5,
      fontWeight: weight.medium,
    },
    netHint: {
      color: C.textTertiary,
      fontSize: type.micro,
      lineHeight: type.xs * 1.4,
    },

    header: {
      paddingHorizontal: layout.screenPadding,
      paddingBottom: space.md,
      backgroundColor: C.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
    },
    headerRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
    headerLeft: { flex: 1 },
    // 从「我的」推入时才有返回；作为首页时不需要
    backBtn: { paddingBottom: 2, marginRight: 2 },
    backIcon: { color: C.textSecondary, fontSize: 30, lineHeight: 34 },
    // 品牌字标：三个拉丁大写字母的视觉高度只有 CJK 的 ~0.72，
    // 所以尺寸比原来 26 的「工作区」放大到 30，并用正字距撑开，
    // 让它和下方副标题、右侧「退出」在视觉重量上对齐。
    headerTitle: {
      color: C.text,
      fontSize: type.title + 4,
      lineHeight: type.title + 8,
      fontWeight: weight.bold,
      letterSpacing: 1.4,
    },
    headerSub: { color: C.textTertiary, fontSize: type.xs, marginTop: 2 },

    content: { paddingTop: space.sm, paddingBottom: space.xl },
    center: { alignItems: 'center', justifyContent: 'center', padding: space.xxxl },
    loadingText: { color: C.textTertiary, fontSize: type.sm, marginTop: space.md },
    emptyIcon: { color: C.textFaint, fontSize: 40, marginBottom: space.md },
    empty: { color: C.textSecondary, fontSize: type.base },
    emptyHint: {
      color: C.textFaint,
      fontSize: type.xs,
      marginTop: space.sm,
      textAlign: 'center',
    },
    errorTitle: {
      color: C.danger,
      fontSize: type.lg,
      marginBottom: space.sm,
      fontWeight: weight.semibold,
    },
    errorBody: { color: C.textSecondary, fontSize: type.sm, textAlign: 'center' },
    retry: {
      marginTop: space.xl,
      paddingHorizontal: space.xl,
      paddingVertical: space.sm,
      backgroundColor: C.bgCard,
      borderRadius: tv.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
    },
    retryText: { color: C.text, fontSize: type.sm },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: layout.screenPadding,
      paddingVertical: space.md,
      backgroundColor: C.bg,
    },
    rowPressed: { backgroundColor: C.bgRaised },
    rowBody: { flex: 1, marginLeft: space.md, minWidth: 0 },
    newBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.bgCard,
    },
    newBtnText: { color: C.accentBright, fontSize: 22, lineHeight: 26 },

    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    name: {
      color: C.text,
      fontSize: type.lg,
      fontWeight: weight.semibold,
      letterSpacing: -0.2,
      flex: 1,
      marginRight: space.sm,
    },
    time: { color: C.textFaint, fontSize: type.xs },
    rowMid: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
    runningWrap: { flexDirection: 'row', alignItems: 'center', marginRight: space.sm },
    runningText: { color: C.success, fontSize: type.xs, marginLeft: 4 },
    preview: { color: C.textSecondary, fontSize: type.sm, flex: 1 },
    rowBottom: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
    path: { color: C.textFaint, fontSize: type.micro, flex: 1, marginRight: space.sm },
    countWrap: {
      minWidth: 22,
      paddingHorizontal: 6,
      height: 18,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgOverlay,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countText: { color: C.textTertiary, fontSize: type.micro, fontWeight: weight.medium },
    chevron: { color: C.textFaint, fontSize: 22, marginLeft: space.xs, marginTop: -2 },
    sep: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: C.border,
      marginLeft: layout.screenPadding + layout.avatarMd + space.md,
    },
    footerHint: {
      color: C.textFaint,
      fontSize: type.micro,
      textAlign: 'center',
      marginTop: space.xl,
    },
  });
}
