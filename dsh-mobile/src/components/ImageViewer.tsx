/**
 * 图片全屏查看器。
 *
 * 为什么需要：原来点图片走 `actionViewIntent`，会弹「用什么应用打开」
 * 的系统选择器。看图是最常见的操作，每次都让用户选一遍应用完全不符合
 * 手机的使用习惯 —— 相册类 App 都是点开就全屏看。
 *
 * 实现要点：
 *   - 全黑背景，沉浸式
 *   - 双指缩放（1x ~ 4x）、双击在 1x / 2.5x 之间切换
 *   - 放大后可拖动，拖到边界会跟手回弹
 *   - 单指下滑关闭（超过阈值）
 *   - 多图时左右滑动切换
 *   - 顶部显示「3 / 8」进度
 *
 * 全部用 RN 内置能力（Modal + PanResponder + Animated），零新依赖。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const SCREEN = Dimensions.get('window');

/** 缩放范围 */
const MIN_SCALE = 1;
const MAX_SCALE = 4;
/** 双击放大到的倍数 */
const DOUBLE_TAP_SCALE = 2.5;
/** 下滑超过这个距离就关闭 */
const DISMISS_DISTANCE = 120;

export interface ViewerImage {
  /** 可直接给 <Image> 的 uri（file:// 或 data:） */
  uri: string;
  /** 显示在底部的说明 */
  caption?: string;
}

export function ImageViewer({
  visible,
  images,
  initialIndex = 0,
  onClose,
}: {
  visible: boolean;
  images: ViewerImage[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(initialIndex);
  /** 当前缩放的基准值（松手后保留） */
  const scale = useRef(new Animated.Value(1)).current;
  const scaleValue = useRef(1);
  /** 拖动位移 */
  const pan = useRef(new Animated.ValueXY()).current;
  const panValue = useRef({ x: 0, y: 0 });
  /** 正在双指缩放时的临时倍数 */
  const pinchStart = useRef(1);

  // 每次打开重置到初始图
  useEffect(() => {
    if (visible) {
      setIndex(Math.min(initialIndex, Math.max(0, images.length - 1)));
      scale.setValue(1);
      scaleValue.current = 1;
      pan.setValue({ x: 0, y: 0 });
      panValue.current = { x: 0, y: 0 };
    }
  }, [visible, initialIndex, images.length, scale, pan]);

  const reset = useCallback(() => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }),
      Animated.spring(pan, {
        toValue: { x: 0, y: 0 },
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }),
    ]).start();
    scaleValue.current = 1;
    panValue.current = { x: 0, y: 0 };
  }, [scale, pan]);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= images.length) return;
      setIndex(next);
      reset();
    },
    [images.length, reset],
  );

  /**
   * 手势。
   *
   * 单指：放大时拖动，未放大时下滑关闭 / 左右切换。
   * 双指：缩放。
   *
   * 这里不用 Animated.event 配 native driver —— PanResponder 的事件在
   * JS 线程，强制 native 会在 Fabric 下丢帧。手动 setValue 反而稳。
   */
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          pan.setOffset({ x: panValue.current.x, y: panValue.current.y });
          pan.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: (evt, g) => {
          const touches = evt.nativeEvent.touches;
          if (touches.length >= 2) {
            // 双指缩放
            const [a, b] = touches;
            const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
            if (!pinchStart.current || pinchStart.current === 1) {
              pinchStart.current = scaleValue.current;
            }
            const next = Math.min(
              MAX_SCALE,
              Math.max(MIN_SCALE, (pinchStart.current * dist) / 200),
            );
            scale.setValue(next);
            scaleValue.current = next;
            return;
          }
          // 单指
          if (scaleValue.current > 1.02) {
            pan.setValue({ x: g.dx, y: g.dy });
          } else {
            // 未放大：允许下滑（关闭）和横滑（切图）
            pan.setValue({ x: g.dx, y: g.dy });
          }
        },
        onPanResponderRelease: (_evt, g) => {
          pan.flattenOffset();
          pinchStart.current = 1;

          // 放大状态：只处理拖动边界回弹
          if (scaleValue.current > 1.02) {
            panValue.current = {
              x: panValue.current.x + g.dx,
              y: panValue.current.y + g.dy,
            };
            pan.setValue(panValue.current);
            return;
          }

          // 未放大：下滑关闭
          if (g.dy > DISMISS_DISTANCE && Math.abs(g.dy) > Math.abs(g.dx)) {
            onClose();
            return;
          }

          // 未放大：横滑切图
          if (Math.abs(g.dx) > SCREEN.width * 0.25) {
            if (g.dx < 0) goTo(index + 1);
            else goTo(index - 1);
            return;
          }

          reset();
        },
        onPanResponderTerminate: () => {
          pan.flattenOffset();
          reset();
        },
      }),
    [pan, scale, onClose, goTo, index, reset],
  );

  /** 双击：1x ↔ 2.5x */
  const lastTap = useRef(0);
  const onTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      const next = scaleValue.current > 1.05 ? 1 : DOUBLE_TAP_SCALE;
      Animated.spring(scale, {
        toValue: next,
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }).start();
      scaleValue.current = next;
      if (next === 1) {
        pan.setValue({ x: 0, y: 0 });
        panValue.current = { x: 0, y: 0 };
      }
      lastTap.current = 0;
    } else {
      lastTap.current = now;
    }
  }, [scale, pan]);

  const current = images[index];

  if (!visible || !current) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        {/* 顶部：进度 + 关闭 */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Text style={styles.counter}>
            {images.length > 1 ? `${index + 1} / ${images.length}` : ''}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={styles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel="关闭"
          >
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        {/* 图片本体 */}
        <View style={styles.stage} {...responder.panHandlers}>
          <Animated.View
            style={{
              transform: [
                { translateX: pan.x },
                { translateY: pan.y },
                { scale },
              ],
            }}
          >
            <Pressable onPress={onTap}>
              <Image
                source={{ uri: current.uri }}
                style={styles.img}
                resizeMode="contain"
              />
            </Pressable>
          </Animated.View>
        </View>

        {/* 底部说明 */}
        {current.caption ? (
          <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
            <Text style={styles.caption} numberOfLines={3}>
              {current.caption}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 8,
  },
  counter: { color: 'rgba(255,255,255,0.85)', fontSize: 14 },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: '#fff', fontSize: 16 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  img: { width: SCREEN.width, height: SCREEN.height * 0.78 },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 18,
  },
  caption: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});
