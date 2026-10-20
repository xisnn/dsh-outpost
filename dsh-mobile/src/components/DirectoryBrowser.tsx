/**
 * 目录浏览器：在手机上点进电脑的文件夹选一个位置。
 *
 * 之前「新建工作区」只能手敲 Windows 路径，因为没找到列目录的接口；
 * 后来发现 DSH 暴露了 `directoryPicker/list`（桌面端用的就是它），
 * 于是可以做成真正的浏览体验。
 *
 * 交互：
 *   - 顶部面包屑：E:\ › work › dsBot，点任意一级跳回去
 *   - 列表：只显示子目录（文件对工作区没意义），点进去
 *   - 「..」回到上级
 *   - 「新建文件夹」在当前目录下建一个
 *   - 底部「就选这里」确认当前目录
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../design/theme';
import { space } from '../design/tokens';
import { useApp } from '../App';
import type { DirListing } from '../core/rpc/directory';

export function DirectoryBrowser({
  visible,
  initialPath,
  onPick,
  onClose,
}: {
  visible: boolean;
  /** 初始目录；不传就先用 home 或盘符列表 */
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const insets = useSafeAreaInsets();
  const { store } = useApp();

  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await store.dirs.list(path);
        setListing(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : '读取目录失败');
      } finally {
        setLoading(false);
      }
    },
    [store],
  );

  // 打开时加载初始目录：优先 initialPath，其次 home，最后列盘符
  useEffect(() => {
    if (!visible) return;
    void load(initialPath ?? '');
  }, [visible, initialPath, load]);

  /** 上级目录：从当前 path 去掉最后一段 */
  const parentOf = (p: string): string => {
    const trimmed = p.replace(/[\\/]+$/, '');
    const m = /^(.*)[\\/][^\\/]+$/.exec(trimmed);
    return m ? m[1] : '';
  };

  const doCreate = async () => {
    if (!listing || !newName.trim()) return;
    setCreating(true);
    try {
      const created = await store.dirs.createDirectory(listing.path, newName.trim());
      setNewName('');
      if (created) await load(created);
      else await load(listing.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : '新建文件夹失败');
    } finally {
      setCreating(false);
    }
  };

  const visibleEntries = useMemo(
    () => (listing?.entries ?? []).filter((e) => !e.hidden),
    [listing],
  );

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
          <View style={styles.head}>
            <Text style={styles.title}>选择目录</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.close}>取消</Text>
            </Pressable>
          </View>

          {/* 面包屑 */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.crumbs}
          >
            {(listing?.crumbs ?? []).map((c) => (
              <Pressable key={c.path} onPress={() => void load(c.path)}>
                <Text style={styles.crumb}>{c.name} ›</Text>
              </Pressable>
            ))}
            {listing?.home ? (
              <Pressable onPress={() => void load(listing.home as string)}>
                <Text style={styles.crumbHome}>⌂</Text>
              </Pressable>
            ) : null}
          </ScrollView>

          <View style={styles.listWrap}>
            {loading ? (
              <View style={styles.center}>
                <ActivityIndicator color={tv.colors.accent} />
              </View>
            ) : error ? (
              <View style={styles.center}>
                <Text style={styles.errText}>{error}</Text>
                <Pressable onPress={() => void load(listing?.path ?? '')} style={styles.retry}>
                  <Text style={styles.retryText}>重试</Text>
                </Pressable>
              </View>
            ) : (
              <ScrollView contentContainerStyle={styles.list}>
                {/* 上级 */}
                {listing?.path ? (
                  <Pressable
                    onPress={() => void load(parentOf(listing.path))}
                    style={({ pressed }: { pressed: boolean }) => [
                      styles.row,
                      pressed ? { backgroundColor: tv.colors.bgCard } : null,
                    ]}
                  >
                    <Text style={styles.rowIcon}>↰</Text>
                    <Text style={styles.rowName}>..</Text>
                  </Pressable>
                ) : null}

                {visibleEntries.length === 0 && listing?.path ? (
                  <Text style={styles.emptyHint}>这个目录下没有子文件夹</Text>
                ) : null}

                {visibleEntries.map((e) => (
                  <Pressable
                    key={e.path}
                    onPress={() => void load(e.path)}
                    style={({ pressed }: { pressed: boolean }) => [
                      styles.row,
                      pressed ? { backgroundColor: tv.colors.bgCard } : null,
                    ]}
                  >
                    <Text style={styles.rowIcon}>📁</Text>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {e.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>

          {/* 新建文件夹 */}
          {listing?.path ? (
            <View style={styles.newRow}>
              <TextInput
                style={styles.newInput}
                value={newName}
                onChangeText={setNewName}
                placeholder="新建文件夹名"
                placeholderTextColor={tv.colors.textFaint}
                editable={!creating}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={() => void doCreate()}
              />
              <Pressable
                onPress={() => void doCreate()}
                disabled={creating || !newName.trim()}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.newBtn,
                  (creating || !newName.trim()) && { opacity: 0.4 },
                  pressed ? { opacity: 0.7 } : null,
                ]}
              >
                <Text style={styles.newBtnText}>新建</Text>
              </Pressable>
            </View>
          ) : null}

          {/* 当前选中 + 确认 */}
          <View style={styles.foot}>
            <View style={styles.currentWrap}>
              <Text style={styles.currentLabel}>当前</Text>
              <Text style={styles.currentPath} numberOfLines={1}>
                {listing?.path || '（选一个盘符或目录）'}
              </Text>
            </View>
            <Pressable
              onPress={() => listing?.path && onPick(listing.path)}
              disabled={!listing?.path}
              style={({ pressed }: { pressed: boolean }) => [
                styles.pickBtn,
                !listing?.path && { opacity: 0.4 },
                pressed ? { opacity: 0.85 } : null,
              ]}
            >
              <Text style={styles.pickText}>就选这里</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: C.scrim, justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: C.bgRaised,
      borderTopLeftRadius: tv.radius.lg,
      borderTopRightRadius: tv.radius.lg,
      maxHeight: '85%',
      paddingTop: space.md,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.lg,
      paddingBottom: space.sm,
    },
    title: { color: C.text, fontSize: tv.type.lg, fontWeight: tv.weight.semibold },
    close: { color: C.accentBright, fontSize: tv.type.sm },

    crumbs: { paddingHorizontal: space.lg, paddingBottom: space.sm, alignItems: 'center' },
    crumb: { color: C.accentBright, fontSize: tv.type.xs, marginRight: 4 },
    crumbHome: { color: C.textSecondary, fontSize: tv.type.sm, marginLeft: space.xs },

    listWrap: { minHeight: 200, maxHeight: 380 },
    list: { paddingHorizontal: space.sm, paddingBottom: space.sm },
    center: { padding: space.xxl, alignItems: 'center' },
    errText: { color: C.danger, fontSize: tv.type.xs, textAlign: 'center' },
    retry: {
      marginTop: space.md,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      backgroundColor: C.bgCard,
      borderRadius: tv.radius.sm,
    },
    retryText: { color: C.accentBright, fontSize: tv.type.xs },
    emptyHint: {
      color: C.textFaint,
      fontSize: tv.type.xs,
      textAlign: 'center',
      paddingVertical: space.xl,
    },

    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.md,
      paddingVertical: 12,
      borderRadius: tv.radius.sm,
    },
    rowIcon: { width: 24, fontSize: tv.type.sm },
    rowName: { flex: 1, color: C.text, fontSize: tv.type.sm },

    newRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingTop: space.sm,
      gap: space.sm,
    },
    newInput: {
      flex: 1,
      backgroundColor: C.bgCard,
      borderRadius: tv.radius.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      color: C.text,
      fontSize: tv.type.xs,
    },
    newBtn: {
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgCard,
    },
    newBtnText: { color: C.accentBright, fontSize: tv.type.xs },

    foot: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
      marginTop: space.sm,
      gap: space.md,
    },
    currentWrap: { flex: 1 },
    currentLabel: { color: C.textFaint, fontSize: tv.type.micro },
    currentPath: { color: C.textSecondary, fontSize: tv.type.xs, marginTop: 2 },
    pickBtn: {
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.accent,
    },
    pickText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: tv.weight.semibold },
  });
}
