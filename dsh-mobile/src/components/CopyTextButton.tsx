/**
 * 轻量「复制」按钮 —— **只给 Markdown 代码块用**。
 *
 * ## 只有这一处常驻复制
 *
 * 消息级复制已经改成「长按消息 → 复制全文」面板（见 MessageActionSheet），
 * 所以这个组件不再提供「贴在消息正文下方」的变体。它只出现在代码块标题栏右侧，
 * 与消息正文、思考卡、工具卡都没有关系。
 *
 * ## 视觉取舍
 *
 * 复制是一个**次要动作**，不该和正文抢注意力：
 *   · 常态：次要文字色、无描边填充，标题栏内保留 44dp 触摸高度；
 *   · 点击后：文案换成「已复制」+ 强调色，1.5 秒后回到常态。
 * 不放图标库（本项目不引图标依赖），用纯文本 + 字形，和 Pill / 折叠头一致。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';

import { useTheme } from '../design/theme';
import { copyTextToClipboard } from './clipboard';

/** 反馈停留时长：太短看不到，太长会一直占着「已复制」 */
const COPIED_FEEDBACK_MS = 1500;

export function CopyTextButton({
  text,
  label = '复制',
  accessibilityLabel,
}: {
  text: string;
  label?: string;
  /** 读屏用的语义（例如「复制代码」） */
  accessibilityLabel?: string;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉定时器：否则页面切走后 setState 会报警告
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const onPress = useCallback(() => {
    const ok = copyTextToClipboard(text);
    if (!ok) return; // 复制失败就不给「已复制」的假反馈
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  }, [text]);

  const disabled = !text || !text.trim();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      // Keep a full touch target within the code header.
      hitSlop={{ top: 0, bottom: 0, left: 4, right: 4 }}
      style={({ pressed }: { pressed: boolean }) => [
        styles.inline,
        pressed ? { backgroundColor: tv.colors.border, opacity: tv.motion.pressOpacity } : null,
        disabled ? { opacity: 0.35 } : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
    >
      <Text style={[styles.inlineText, copied ? styles.copiedText : null]}>
        {copied ? '✓ 已复制' : label}
      </Text>
    </Pressable>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    inline: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      minHeight: 44,
      minWidth: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: tv.radius.xs,
      backgroundColor: 'transparent',
    },
    inlineText: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.medium,
      lineHeight: tv.type.xs * 1.4,
    },
    copiedText: {
      color: C.accentBright,
    },
  });
}
