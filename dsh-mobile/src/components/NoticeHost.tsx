/**
 * 应用内通知横幅。
 *
 * 为什么先做应用内而不是系统通知：
 *   系统通知要引入原生模块（Notifee / expo-notifications），
 *   重新构建 + 权限申请 + 各家 ROM 白名单，链路长且难验证。
 *   应用内横幅零依赖、立刻能跑通，逻辑验证完再升级到系统通知时，
 *   只是把「展示」这一层换掉，判定逻辑不用动。
 *
 * 设计：
 *   - 从顶部滑入，3.5 秒后自动滑出（可点掉）
 *   - 同时最多堆 3 条，新的覆盖旧的
 *   - 点击跳转到对应会话（如果给了 sessionId）
 *   - 不挡状态栏，避让安全区
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../design/theme';

export type NoticeKind = 'done' | 'fail' | 'ask' | 'approval';

export interface NoticeItem {
  id: string;
  kind: NoticeKind;
  /** 主文案，例如「coder 完成了：修登录 bug」 */
  text: string;
  /** 次要说明，例如会话标题 */
  detail?: string;
  /** 点了跳去哪个会话 */
  sessionId?: string;
  time: number;
}

const KIND_ICON: Record<NoticeKind, string> = {
  done: '✓',
  fail: '✕',
  ask: '?',
  approval: '⚠',
};

/** 自动消失时长 */
const AUTO_DISMISS_MS = 3500;

function Banner({
  item,
  onPress,
  onDismiss,
}: {
  item: NoticeItem;
  onPress: (item: NoticeItem) => void;
  onDismiss: (id: string) => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  // 0 = 在屏幕上方外，1 = 就位
  const slide = useRef(new Animated.Value(0)).current;
  const leaving = useRef(false);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    Animated.timing(slide, {
      toValue: 0,
      duration: 160,
      useNativeDriver: true,
    }).start(() => onDismiss(item.id));
  }, [slide, item.id, onDismiss]);

  useEffect(() => {
    Animated.spring(slide, {
      toValue: 1,
      useNativeDriver: true,
      bounciness: 6,
      speed: 18,
    }).start();
    const t = setTimeout(leave, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [slide, leave]);

  const translateY = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-80, 0],
  });

  const color =
    item.kind === 'fail'
      ? tv.colors.danger
      : item.kind === 'approval' || item.kind === 'ask'
        ? tv.colors.accent
        : tv.colors.accent;

  return (
    <Animated.View style={[styles.banner, { transform: [{ translateY }] }]}>
      <Pressable
        onPress={() => {
          onPress(item);
          leave();
        }}
        style={({ pressed }: { pressed: boolean }) => [
          styles.inner,
          pressed ? { opacity: tv.motion.pressOpacity } : null,
        ]}
        accessibilityRole="button"
        accessibilityLabel={item.text}
      >
        <Text style={[styles.icon, { color }]}>{KIND_ICON[item.kind]}</Text>
        <View style={styles.body}>
          <Text style={styles.text} numberOfLines={2}>
            {item.text}
          </Text>
          {item.detail ? (
            <Text style={styles.detail} numberOfLines={1}>
              {item.detail}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={leave}
          hitSlop={8}
          style={styles.close}
          accessibilityRole="button"
          accessibilityLabel="关闭通知"
        >
          <Text style={styles.closeText}>×</Text>
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

export function NoticeHost({
  items,
  onPress,
  onDismiss,
}: {
  items: NoticeItem[];
  onPress: (item: NoticeItem) => void;
  onDismiss: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);

  if (items.length === 0) return null;

  return (
    <View
      style={[styles.host, { paddingTop: insets.top + 6 }]}
      pointerEvents="box-none"
    >
      {items.slice(0, 3).map((item) => (
        <Banner
          key={item.id}
          item={item}
          onPress={onPress}
          onDismiss={onDismiss}
        />
      ))}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    host: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      paddingHorizontal: tv.layout.screenPadding,
      gap: tv.space.xs,
      zIndex: 9999,
      elevation: 20,
    },
    banner: {
      borderRadius: tv.radius.md,
      backgroundColor: C.bg,
      borderWidth: 1,
      borderColor: C.border,
      overflow: 'hidden',
      // 轻微阴影，和页面区分开
      shadowColor: '#000',
      shadowOpacity: 0.12,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    inner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      gap: tv.space.sm,
    },
    icon: {
      fontSize: tv.type.sm,
      fontWeight: tv.weight.medium,
      lineHeight: tv.type.sm * 1.5,
    },
    body: { flex: 1 },
    text: {
      color: C.text,
      fontSize: tv.type.sm,
      lineHeight: tv.type.sm * 1.45,
    },
    detail: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      marginTop: 1,
    },
    close: {
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    closeText: {
      color: C.textTertiary,
      fontSize: tv.type.lg,
      lineHeight: tv.type.lg * 1.1,
    },
  });
}
