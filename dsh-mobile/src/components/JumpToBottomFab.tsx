/**
 * 「回到底部」悬浮按钮。
 *
 * ## 为什么需要
 *
 * 聊天页只有在「本来就在底部」时才自动跟随新内容（见 ChatScreen 的
 * nearBottom 逻辑）—— 这是对的：用户往上翻历史时不该被拽回底部。
 * 但反过来，**用户想回到底部时也没有任何入口**：只能一直往下划，
 * 长会话里要划几十屏。代理正在流式输出时尤其难受。
 *
 * ## 交互契约（纯逻辑在 core/scrollFollow.ts，这里只管画）
 *
 * - 离底超过 160px 才浮出；回到底部附近（<96px）才收起（迟滞，防闪）
 * - 离开底部期间如果末尾真的增长了，右上角亮一个强调色小圆点
 *   —— 「有新内容」而不是「有新消息」：流式输出也算
 * - 点击：滚到底 + 清掉圆点
 *
 * ## 视觉
 *
 * 圆形、细描边、无阴影（与全局「层次靠描边」一致）；只在需要时出现，
 * 出现/消失用透明度 + 轻微位移，不改变列表布局（绝对定位）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';

import { useTheme } from '../design/theme';
import { MOTION, useMotionPreference } from '../design/motion';

export function JumpToBottomFab({
  visible,
  hasNewContent,
  onPress,
  bottomOffset = 0,
}: {
  visible: boolean;
  hasNewContent: boolean;
  onPress: () => void;
  /** 输入区高度：按钮浮在输入区正上方（由聊天页测量后传入） */
  bottomOffset?: number;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const anim = useRef(new Animated.Value(0)).current;
  const reduced = useMotionPreference();
  // 淡出结束后才真正卸载：否则消失动画会被打断，按钮「啪」地不见
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: reduced ? 0 : visible ? MOTION.enter : MOTION.exit,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, anim, reduced]);

  if (!mounted) return null;

  const label = hasNewContent ? '回到最新，有新内容' : '回到最新';

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.host,
        {
          bottom: bottomOffset + tv.space.sm,
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
      ]}
    >
      <Pressable
        onPress={onPress}
        disabled={!visible}
        hitSlop={8}
        style={({ pressed }: { pressed: boolean }) => [
          styles.btn,
          pressed ? { opacity: tv.motion.pressOpacity } : null,
        ]}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Text style={styles.arrow}>↓</Text>
        {hasNewContent ? <View style={styles.dot} /> : null}
      </Pressable>
    </Animated.View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    host: {
      position: 'absolute',
      right: tv.layout.screenPadding,
      bottom: tv.space.sm,
      zIndex: 10,
    },    btn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
    },
    arrow: {
      color: C.textSecondary,
      fontSize: 17,
      lineHeight: 20,
      marginTop: -1,
    },
    dot: {
      position: 'absolute',
      top: 5,
      right: 6,
      width: 7,
      height: 7,
      borderRadius: 3.5,
      backgroundColor: C.accent,
    },
  });
}
