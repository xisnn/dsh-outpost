/**
 * 选择管家工作区。
 *
 * 为什么需要这一步：队员是会话级的（TeamMemberSnapshot 挂在 parentSessionId 上），
 * 所以「按项目复用队员」等价于「一个项目一个管家会话」。
 * 开启管家模式时先让用户选定项目，之后这个管家就固定在这个项目里干活，
 * 队员也只属于这里 —— 上下文不串味，也不用重复读项目。
 *
 * 只在「还没绑过工作区」时弹，绑过之后直接复用，不会每次打扰。
 */
import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { space } from '../design/tokens';
import type { groupByWorkspace } from '../core/rpc/session';

/** groupByWorkspace 产出的单个工作区块 */
type WorkspaceGroup = ReturnType<typeof groupByWorkspace>[number];

export function ButlerWorkspacePicker({
  visible,
  workspaces,
  onPick,
  onCancel,
  /** 是否允许取消（首次开启时不让取消，否则无处可去） */
  allowCancel = false,
}: {
  visible: boolean;
  workspaces: WorkspaceGroup[];
  onPick: (path: string) => void;
  onCancel: () => void;
  allowCancel?: boolean;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [busy] = useState(false);

  // 只保留有路径的工作区（没路径的没法当 cwd）
  const items = useMemo(
    () => workspaces.filter((w) => !!w.path),
    [workspaces],
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>选择管家工作区</Text>
          <Text style={styles.hint}>
            管家会在这个项目里干活，队员也归属这里。
            {'\n'}
            想换项目时，到「我的」里关闭再开启管家模式即可。
          </Text>

          {items.length === 0 ? (
            <Text style={styles.empty}>
              还没有工作区。先在「工作区」里新建一个，或到「我的」里添加。
            </Text>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(w) => w.path}
              style={styles.list}
              renderItem={({ item }) => (
                <Pressable
                  disabled={busy}
                  onPress={() => onPick(item.path)}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.row,
                    pressed ? { backgroundColor: tv.colors.bgCard } : null,
                  ]}
                >
                  <View style={styles.rowIcon}>
                    <Text style={styles.rowIconText}>📁</Text>
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {item.name || item.path}
                    </Text>
                    <Text style={styles.rowPath} numberOfLines={1}>
                      {item.path}
                    </Text>
                  </View>
                  <Text style={styles.rowCount}>{item.sessions.length}</Text>
                </Pressable>
              )}
            />
          )}

          {allowCancel ? (
            <Pressable
              onPress={onCancel}
              style={({ pressed }: { pressed: boolean }) => [
                styles.cancel,
                pressed ? { opacity: 0.6 } : null,
              ]}
            >
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          ) : null}
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
      backgroundColor: C.scrim,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: space.lg,
    },
    card: {
      width: '100%',
      maxWidth: 460,
      maxHeight: '80%',
      backgroundColor: C.bgRaised,
      borderRadius: tv.radius.lg,
      padding: space.lg,
    },
    title: { color: C.text, fontSize: tv.type.lg, fontWeight: tv.weight.semibold },
    hint: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      marginTop: space.xs,
      marginBottom: space.md,
    },
    empty: {
      color: C.textFaint,
      fontSize: tv.type.xs,
      textAlign: 'center',
      paddingVertical: space.xl,
      lineHeight: tv.type.xs * 1.6,
    },
    list: { maxHeight: 360 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.sm,
      paddingVertical: space.md,
      borderRadius: tv.radius.sm,
    },
    rowIcon: { width: 32, alignItems: 'center' },
    rowIconText: { fontSize: tv.type.base },
    rowBody: { flex: 1 },
    rowName: { color: C.text, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    rowPath: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 2 },
    rowCount: { color: C.textTertiary, fontSize: tv.type.xs, marginLeft: space.sm },
    cancel: { alignSelf: 'center', paddingVertical: space.md, marginTop: space.xs },
    cancelText: { color: C.textSecondary, fontSize: tv.type.sm },
  });
}
