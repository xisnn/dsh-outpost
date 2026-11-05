/**
 * 底部 tab 栏：工作区 | 我的（管家模式下是 管家 | 我的）。
 *
 * 微信式结构 —— tab 只在首页存在，进入会话列表/聊天后整屏压栈，tab 栏隐藏。
 * 纯 RN 原生控件（Pressable + Text），不引图标库，字形与全局视觉一致。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MOTION, useMotionPreference } from '../design/motion';
import { useTheme } from '../design/theme';

export type HomeTab = 'butler' | 'workspaces' | 'me';

const TAB_META: Record<HomeTab, { icon: string; label: string }> = {
  butler: { icon: '◈', label: '管家' },
  workspaces: { icon: '▦', label: '工作区' },
  me: { icon: '◉', label: '我的' },
};

export function TabBar({
  tab,
  onChange,
  items,
}: {
  tab: HomeTab;
  onChange: (t: HomeTab) => void;
  /** 当前模式下的 tab 列表（管家模式少一个工作区） */
  items: HomeTab[];
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, 6) }]}>
      {items.map((key) => {
        const active = key === tab;
        const meta = TAB_META[key];
        return (
          <TabItem
            key={key}
            active={active}
            meta={meta}
            styles={styles}
            onPress={() => onChange(key)}
          />
        );
      })}
    </View>
  );
}

function TabItem({ active, meta, styles, onPress }: {
  active: boolean;
  meta: { icon: string; label: string };
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
}) {
  const reduceMotion = useMotionPreference();
  const scale = useRef(new Animated.Value(1)).current;
  const wasActive = useRef(active);
  const animateTo = useCallback((toValue: number, duration: number) => {
    scale.stopAnimation();
    if (reduceMotion) {
      scale.setValue(1);
      return;
    }
    Animated.timing(scale, { toValue, duration, useNativeDriver: true }).start();
  }, [reduceMotion, scale]);

  useEffect(() => {
    scale.stopAnimation();
    if (active && !wasActive.current && !reduceMotion) {
      scale.setValue(0.96);
      animateTo(1, MOTION.enter);
    } else {
      scale.setValue(1);
    }
    wasActive.current = active;
    return () => scale.stopAnimation();
  }, [active, animateTo, reduceMotion, scale]);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => animateTo(0.97, MOTION.press)}
      onPressOut={() => animateTo(1, MOTION.press)}
      hitSlop={{ top: 8, bottom: 8 }}
      style={styles.item}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={meta.label}
    >
      <Animated.View style={{ alignItems: 'center', transform: [{ scale }] }} pointerEvents="none">
        <Text style={[styles.icon, active ? styles.iconActive : styles.iconIdle]}>
          {meta.icon}
        </Text>
        <Text style={[styles.label, active ? styles.labelActive : styles.labelIdle]}>
          {meta.label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingTop: 6,
      backgroundColor: C.bgRaised,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    item: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 2,
    },
    icon: { fontSize: 19, lineHeight: 22 },
    iconActive: { color: C.accent },
    iconIdle: { color: C.textTertiary },
    label: { fontSize: tv.type.micro, marginTop: 1 },
    labelActive: { color: C.accent, fontWeight: tv.weight.semibold },
    labelIdle: { color: C.textTertiary, fontWeight: tv.weight.regular },
  });
}
