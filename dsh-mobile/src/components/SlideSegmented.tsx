/**
 * 可滑动的分段控件（segmented control）。
 *
 * 交互：
 *   - 点击某项 → 指示块滑过去
 *   - 按住横向拖动 → 指示块跟手，松手吸附到最近一项
 *
 * 为什么不用 PanResponder：它和子元素的 Pressable 抢手势，
 * Fabric 下实测收不到事件。这里整个控件就是一个 Pressable，
 * 用 onPressIn/onPressOut 拿坐标，onResponderMove 做跟手。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { MOTION, useMotionPreference } from '../design/motion';
import { useTheme } from '../design/theme';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

const PADDING = 3;
const DRAG_THRESHOLD = 8;

export function SlideSegmented<T extends string>({
  options,
  value,
  onChange,
  itemWidth,
  compact,
  accessibilityLabel,
}: {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (v: T) => void;
  itemWidth?: number;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const tv = useTheme();
  const reduceMotion = useMotionPreference();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  const count = options.length;
  const maxIndex = Math.max(1, count - 1);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  const [boxWidth, setBoxWidth] = useState(0);
  const slide = useRef(new Animated.Value(index)).current;
  const dragging = useRef(false);
  const startPageX = useRef(0);
  const boxPageX = useRef(0);
  const moved = useRef(false);

  const tabW = itemWidth ?? (boxWidth > 0 && count > 0 ? (boxWidth - PADDING * 2) / count : 0);

  const settle = useCallback((target: number) => {
    slide.stopAnimation();
    if (reduceMotion) {
      slide.setValue(target);
      return;
    }
    Animated.timing(slide, {
      toValue: target,
      duration: MOTION.layout,
      useNativeDriver: true,
    }).start();
  }, [reduceMotion, slide]);

  // 只在选中项或系统动态偏好改变时过渡，流式内容重渲染不会重启动画。
  const previousIndex = useRef(index);
  useEffect(() => {
    dragging.current = false;
    moved.current = false;
    if (previousIndex.current === index) {
      slide.stopAnimation();
      slide.setValue(index);
    } else {
      settle(index);
    }
    previousIndex.current = index;
    return () => slide.stopAnimation();
  }, [index, settle, slide]);

  const indexAt = useCallback(
    (innerX: number) => {
      if (!tabW) return 0;
      const i = Math.round((innerX - tabW / 2) / tabW);
      return Math.max(0, Math.min(count - 1, i));
    },
    [count, tabW],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    setBoxWidth(e.nativeEvent.layout.width);
  };

  const handlePressIn = (e: GestureResponderEvent) => {
    slide.stopAnimation();
    startPageX.current = e.nativeEvent.pageX;
    boxPageX.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
    moved.current = false;
    dragging.current = true;
  };

  const handleMove = (e: GestureResponderEvent) => {
    if (!dragging.current || !tabW) return;
    if (Math.abs(e.nativeEvent.pageX - startPageX.current) > DRAG_THRESHOLD) moved.current = true;
    if (!moved.current) return;
    const innerX = e.nativeEvent.pageX - boxPageX.current;
    const pos = Math.max(0, Math.min(count - 1, (innerX - tabW / 2) / tabW));
    slide.setValue(pos);
  };

  const handleCancel = () => {
    if (!dragging.current) return;
    dragging.current = false;
    moved.current = false;
    settle(index);
  };

  const handleRelease = (e: GestureResponderEvent) => {
    dragging.current = false;
    moved.current = false;
    if (!tabW) {
      settle(index);
      return;
    }
    const innerX = e.nativeEvent.pageX - boxPageX.current;
    const target = indexAt(innerX);
    settle(target);

    const next = options[target];
    if (next && next.value !== value) onChange(next.value);
  };

  const translateX = slide.interpolate({
    inputRange: [0, maxIndex],
    outputRange: [0, tabW * maxIndex],
  });
  const activeLabel = options[index]?.label ?? '';

  return (
    <Pressable
      style={[styles.track, compact ? styles.trackCompact : null]}
      onLayout={onLayout}
      onPressIn={handlePressIn}
      onPressOut={handleCancel}
      onPress={handleRelease}
      onTouchCancel={handleCancel}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderMove={handleMove}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel ?? '选项'}
      accessibilityValue={{ text: activeLabel }}
      accessibilityActions={[
        { name: 'increment', label: '下一个' },
        { name: 'decrement', label: '上一个' },
      ]}
      onAccessibilityAction={(e) => {
        const name = e.nativeEvent.actionName;
        const delta = name === 'increment' ? 1 : name === 'decrement' ? -1 : 0;
        if (!delta) return;
        const next = Math.max(0, Math.min(count - 1, index + delta));
        const opt = options[next];
        if (opt && opt.value !== value) onChange(opt.value);
      }}
    >
      {tabW > 0 ? (
        <Animated.View
          style={[styles.thumb, { width: tabW, transform: [{ translateX }] }]}
          pointerEvents="none"
        />
      ) : null}

      {options.map((o) => {
        const active = o.value === value;
        return (
          <View
            key={o.value}
            style={[styles.tab, itemWidth ? { width: itemWidth } : { flex: 1 }]}
            pointerEvents="none"
            accessible={false}
          >
            <Text
              style={[
                styles.label,
                compact ? styles.labelCompact : null,
                active && styles.labelActive,
              ]}
              numberOfLines={1}
            >
              {o.label}
            </Text>
          </View>
        );
      })}
    </Pressable>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    track: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: PADDING,
      borderRadius: 14,
      backgroundColor: C.bgCard,
    },
    trackCompact: { borderRadius: 12, padding: 2 },
    thumb: {
      position: 'absolute',
      top: PADDING,
      bottom: PADDING,
      left: PADDING,
      borderRadius: 11,
      backgroundColor: C.accent,
    },
    tab: {
      paddingVertical: 7,
      alignItems: 'center',
      justifyContent: 'center',
    },
    label: { color: C.textSecondary, fontSize: tv.type.sm },
    labelCompact: { fontSize: tv.type.xs, paddingVertical: 1 },
    labelActive: { color: C.onAccent, fontWeight: tv.weight.semibold },
  });
}