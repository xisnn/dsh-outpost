/**
 * 管家模式切换：闲聊 / 计划。
 *
 * - 闲聊：管家直接回答，不派活，适合问问题、聊需求。
 * - 计划：管家先跟你对齐需求，给出方案，等你说「可以」才真正派队员执行。
 *
 * 视觉是一个带**滑动指示块**的分段控件：切换时底色块平滑滑到目标选项，
 * 让用户一眼看出当前在哪一档。指示块用 Animated 做位移（native driver）。
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

export type ButlerMode = 'chat' | 'plan';

const TABS: Array<{ id: ButlerMode; label: string }> = [
  { id: 'chat', label: '闲聊' },
  { id: 'plan', label: '计划' },
];

/** 每个 tab 的固定宽度，指示块靠它算位移 */
const TAB_WIDTH = 64;
const PADDING = 2;

export function ButlerModeSwitch({
  mode,
  onChange,
}: {
  mode: ButlerMode;
  onChange: (mode: ButlerMode) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const idx = Math.max(0, TABS.findIndex((t) => t.id === mode));
  const slide = useRef(new Animated.Value(idx)).current;

  useEffect(() => {
    Animated.spring(slide, {
      toValue: idx,
      friction: 11,
      tension: 150,
      useNativeDriver: true,
    }).start();
  }, [idx, slide]);

  const translateX = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, TAB_WIDTH],
  });

  return (
    <View style={styles.wrap}>
      <View style={styles.track}>
        {/* 滑动指示块：铺在当前选项下方，切换时平滑移动 */}
        <Animated.View
          style={[
            styles.thumb,
            { width: TAB_WIDTH, transform: [{ translateX }] },
          ]}
          pointerEvents="none"
        />
        {TABS.map((t) => {
          const active = t.id === mode;
          return (
            <Pressable
              key={t.id}
              onPress={() => onChange(t.id)}
              style={styles.tab}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      alignItems: 'center',
      paddingVertical: tv.space.xs,
      backgroundColor: C.bg,
    },
    track: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: PADDING,
      borderRadius: 14,
      backgroundColor: C.bgCard,
    },
    thumb: {
      position: 'absolute',
      top: PADDING,
      bottom: PADDING,
      left: PADDING,
      borderRadius: 12,
      backgroundColor: C.accent,
    },
    tab: {
      width: TAB_WIDTH,
      paddingVertical: 5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tabText: { color: C.textSecondary, fontSize: tv.type.sm },
    tabTextActive: { color: C.onAccent, fontWeight: tv.weight.semibold },
  });
}
