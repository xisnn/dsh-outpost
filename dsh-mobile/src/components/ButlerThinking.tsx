/**
 * 管家思考过程。
 *
 * 产品意图：管家派活/思考时界面别干等着，给一点「它在想什么」的反馈；
 * 但回复出来后这个信息就没用了，必须自动退场，不能占着聊天记录。
 *
 * 行为：
 *   live（正在生成）→ 展开显示最近几行思考内容 + 跳动点
 *   done（已跑完）  → 收成一行「已思考」，点开才看完整过程
 *
 * 风格和页面统一：浅灰卡、左侧竖线、小字号，不抢正文的注意力。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { ThinkingDots } from './Thinking';

/** 生成中最多显示几行，避免长思考把屏幕撑满 */
const LIVE_LINES = 3;

export function ButlerThinking({ text, live }: { text: string; live: boolean }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);

  // 从「生成中」切到「已完成」时，自动把展开状态重置，
  // 否则用户在生成中点开过，跑完还一直展开着。
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  // 生成中：只取最后几行（最新的思考），并做长度裁剪
  const livePreview = useMemo(() => {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-LIVE_LINES);
    return tail.map((l) => (l.length > 60 ? `${l.slice(0, 60)}…` : l)).join('\n');
  }, [text]);

  if (live) {
    return (
      <View style={styles.liveWrap}>
        <View style={styles.liveHead}>
          <ThinkingDots color={tv.colors.accent} />
          <Text style={styles.liveLabel}>管家在想</Text>
        </View>
        {livePreview ? (
          <Text style={styles.liveText} numberOfLines={LIVE_LINES}>
            {livePreview}
          </Text>
        ) : null}
      </View>
    );
  }

  // 已跑完：收成一行，可点开
  const charCount = text.trim().length;
  if (charCount === 0) return null;

  return (
    <View style={styles.doneWrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }: { pressed: boolean }) => [
          styles.doneHead,
          pressed ? { opacity: 0.7 } : null,
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.doneMark}>◇</Text>
        <Text style={styles.doneLabel}>已思考</Text>
        <Text style={styles.doneCount}>{charCount} 字</Text>
        <Text style={styles.chevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? <Text style={styles.doneText}>{text.trim()}</Text> : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    // 生成中：带一点强调色，让人注意到「它活着」
    liveWrap: {
      marginHorizontal: tv.layout.screenPadding,
      marginVertical: tv.space.xs,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.md,
      backgroundColor: C.bgCard,
      borderLeftWidth: 2,
      borderLeftColor: C.accent,
    },
    liveHead: { flexDirection: 'row', alignItems: 'center' },
    liveLabel: {
      color: C.accentBright,
      fontSize: tv.type.xs,
      marginLeft: 6,
      fontWeight: tv.weight.medium,
    },
    liveText: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      marginTop: tv.space.xs,
    },

    // 已完成：收成一行
    doneWrap: {
      marginHorizontal: tv.layout.screenPadding,
      marginVertical: 2,
    },
    doneHead: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
    doneMark: { color: C.textFaint, fontSize: tv.type.micro, marginRight: 5 },
    doneLabel: { color: C.textFaint, fontSize: tv.type.xs },
    doneCount: { color: C.textFaint, fontSize: tv.type.micro, marginLeft: 6, flex: 1 },
    chevron: { color: C.textFaint, fontSize: tv.type.micro },
    doneText: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.65,
      paddingLeft: tv.space.md,
      paddingVertical: tv.space.xs,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: C.border,
      marginLeft: 4,
    },
  });
}
