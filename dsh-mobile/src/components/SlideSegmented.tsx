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
}: {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (v: T) => void;
  itemWidth?: number;
  compact?: boolean;
}) {
  const tv = useTheme();
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

  const tabW = itemWidth ?? (boxWidth > 0 ? (boxWidth - PADDING * 2) / count : 0);

  useEffect(() => {
    if (dragging.current) return;
    Animated.spring(slide, {
      toValue: index,
      friction: 11,
      tension: 150,
      useNativeDriver: true,
    }).start();
  }, [index, slide]);

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
    startPageX.current = e.nativeEvent.pageX;
    boxPageX.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
    moved.current = false;
    dragging.current = true;
  };

  const handleMove = (e: GestureResponderEvent) => {
    if (!tabW) return;
    if (Math.abs(e.nativeEvent.pageX - startPageX.current) > DRAG_THRESHOLD) moved.current = true;
    if (!moved.current) return;
    const innerX = e.nativeEvent.pageX - boxPageX.current;
    const pos = Math.max(0, Math.min(count - 1, (innerX - tabW / 2) / tabW));
    slide.setValue(pos);
  };

  const handleRelease = (e: GestureResponderEvent) => {
    dragging.current = false;
    if (!tabW) return;
    const innerX = e.nativeEvent.pageX - boxPageX.current;
    const target = indexAt(innerX);

    Animated.spring(slide, {
      toValue: target,
      friction: 11,
      tension: 150,
      useNativeDriver: true,
    }).start();

    const next = options[target];
    if (next && next.value !== value) onChange(next.value);
    moved.current = false;
  };

  const translateX = slide.interpolate({
    inputRange: [0, maxIndex],
    outputRange: [0, tabW * maxIndex],
  });

  return (
    <Pressable
      style={[styles.track, compact ? styles.trackCompact : null]}
      onLayout={onLayout}
      onPressIn={handlePressIn}
      onPressOut={handleRelease}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderMove={handleMove}
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