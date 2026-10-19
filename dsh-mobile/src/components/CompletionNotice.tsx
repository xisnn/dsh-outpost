/**
 * 管家完成提醒：派活跑完之后，先把结果折叠起来，
 * 提示用户「管家已完成 · 点开查看」，而不是一股脑显示一大段。
 *
 * 只用于「这一轮里确实派过活」的情况 —— 闲聊模式的普通回复直接显示，
 * 不做这个拦截（否则每句话都要点一下，很烦）。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

export function CompletionNotice({
  /** 完成的任务数，用于文案 */
  taskCount,
  children,
}: {
  taskCount: number;
  /** 折叠起来的内容（管家的汇总回复） */
  children: React.ReactNode;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }: { pressed: boolean }) => [
          styles.head,
          !open && styles.headPending,
          pressed ? { opacity: 0.75 } : null,
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? '收起结果' : '查看结果'}
      >
        <Text style={[styles.icon, !open && styles.iconPending]}>✓</Text>
        <View style={styles.textWrap}>
          <Text style={[styles.title, !open && styles.titlePending]}>
            {open ? '管家的汇总' : '管家已完成'}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {open ? '点这里收起' : `${taskCount} 项任务完成 · 点开查看结果`}
          </Text>
        </View>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>

      {open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      marginHorizontal: tv.layout.screenPadding,
      marginVertical: tv.space.xs,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
      overflow: 'hidden',
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.md,
    },
    // 未展开时用淡绿色底，暗示「有结果待你查看」
    headPending: { backgroundColor: C.successWash },
    icon: {
      fontSize: tv.type.sm,
      color: C.success,
      marginRight: tv.space.sm,
    },
    iconPending: { fontWeight: tv.weight.semibold },
    textWrap: { flex: 1 },
    title: { color: C.textSecondary, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    titlePending: { color: C.success },
    sub: { color: C.textFaint, fontSize: tv.type.micro, marginTop: 2 },
    chevron: { color: C.textTertiary, fontSize: tv.type.sm, marginLeft: tv.space.sm },
    body: { paddingBottom: tv.space.sm },
  });
}
