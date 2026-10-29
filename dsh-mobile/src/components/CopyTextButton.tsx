/**
 * 轻量「复制」按钮：代码块右上角 / 消息下方的同一个控件。
 *
 * ## 视觉取舍
 *
 * 复制是一个**次要动作**，不该和正文抢注意力：
 *   · 常态：极小号字 + 最弱的文字色（textFaint），不描边不填充；
 *   · 点击后：文案换成「已复制」+ 强调色，1.5 秒后回到常态。
 * 不放图标库（本项目不引图标依赖），用纯文本 + 字形，和 Pill / 折叠头一致。
 *
 * ## 两个变体
 *
 * - `inline`：贴在代码块标题栏右侧，10px，几乎隐形；
 * - `bar`：贴在消息正文下方，右对齐，给消息级「复制全文」用。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '../design/theme';
import { copyTextToClipboard } from './clipboard';

/** 反馈停留时长：太短看不到，太长会一直占着「已复制」 */
const COPIED_FEEDBACK_MS = 1500;

export function CopyTextButton({
  text,
  label = '复制',
  variant = 'inline',
  accessibilityLabel,
}: {
  text: string;
  label?: string;
  variant?: 'inline' | 'bar';
  /** 读屏用的语义（例如「复制代码」「复制消息全文」） */
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
      // 可见字形很小，热区补到 44 左右
      hitSlop={12}
      style={({ pressed }: { pressed: boolean }) => [
        variant === 'bar' ? styles.bar : styles.inline,
        pressed ? { opacity: tv.motion.pressOpacity } : null,
        disabled ? { opacity: 0.35 } : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
    >
      <Text
        style={[
          variant === 'bar' ? styles.barText : styles.inlineText,
          copied ? styles.copiedText : null,
        ]}
      >
        {copied ? '✓ 已复制' : label}
      </Text>
    </Pressable>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    inline: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: tv.radius.xs,
    },
    inlineText: {
      color: C.textFaint,
      fontSize: tv.type.micro,
      lineHeight: tv.type.micro * 1.6,
    },
    bar: {
      alignSelf: 'flex-end',
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginTop: 2,
      borderRadius: tv.radius.sm,
    },
    barText: {
      color: C.textFaint,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
    },
    copiedText: {
      color: C.accentBright,
    },
  });
}
