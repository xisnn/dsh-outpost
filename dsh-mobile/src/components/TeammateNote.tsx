/**
 * 队员汇报 / subagent 完成通知的折叠卡片。
 *
 * 为什么要这个组件：DSH 把队友消息记成了 `user/message`，
 * 于是 App 原来把它们显示成「用户发言」，看起来像用户自己在说话。
 * 这里改成独立的小卡片：默认折叠成一行，点开看全文。
 *
 * 视觉：浅灰底 + 左侧竖线，明显区别于用户的蓝色气泡和助手正文。
 */
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { AssistantRichText } from './AssistantRichText';

export function TeammateNote({
  from,
  text,
  notice,
}: {
  from: string;
  text: string;
  /** true = subagent 完成通知，false = 队员主动汇报 */
  notice: boolean;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);

  // 折叠时显示一行摘要：取正文第一句
  const summary = useMemo(() => {
    const first = text.split('\n').find((l) => l.trim().length > 0) ?? '';
    return first.length > 42 ? `${first.slice(0, 42)}…` : first;
  }, [text]);

  const title = notice ? `${from} 完成` : `${from} 汇报`;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }: { pressed: boolean }) => [
          styles.head,
          pressed ? { opacity: 0.7 } : null,
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}，${open ? '收起' : '展开'}`}
      >
        <Text style={styles.badge}>{notice ? '✓' : '◈'}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {!open && summary ? (
          <Text style={styles.summary} numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.bodyWrap}>
          {/* 队员的汇报里常有文件路径，展开时也渲染成可点开的卡片 */}
          <AssistantRichText text={text} inset={false} />
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      marginHorizontal: tv.layout.screenPadding,
      marginVertical: tv.space.xs,
      backgroundColor: C.bgCard,
      borderRadius: tv.radius.md,
      borderLeftWidth: 2,
      borderLeftColor: C.borderStrong,
      overflow: 'hidden',
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
    },
    badge: { color: C.textTertiary, fontSize: tv.type.micro, marginRight: 6 },
    title: { color: C.textSecondary, fontSize: tv.type.xs, fontWeight: tv.weight.medium },
    summary: {
      flex: 1,
      color: C.textFaint,
      fontSize: tv.type.micro,
      marginLeft: tv.space.sm,
    },
    chevron: { color: C.textFaint, fontSize: tv.type.micro, marginLeft: tv.space.sm },
    bodyWrap: { paddingBottom: tv.space.sm },
    body: {
      color: C.textSecondary,
      fontSize: tv.type.sm,
      lineHeight: tv.type.sm * 1.6,
      paddingHorizontal: tv.space.md,
      paddingBottom: tv.space.md,
    },
  });
}
