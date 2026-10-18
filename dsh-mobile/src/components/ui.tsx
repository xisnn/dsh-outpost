/**
 * 基础视觉组件：渐变底、头像、卡片、分隔线。
 *
 * RN 没有 CSS gradient，用多层半透明 View 叠加模拟。
 * 所有颜色都来自 useTheme()，随主题切换。
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/theme';

/**
 * 折叠区展开动画：淡入 + 轻微上滑。
 *
 * 为什么不用 LayoutAnimation：RN 0.81 默认开 Fabric（New Architecture），
 * 而 `setLayoutAnimationEnabledExperimental` 在 Fabric 下是 **no-op**，
 * `LayoutAnimation.configureNext()` 不生效（还会在 LogBox 里刷警告）。
 * 所以改用 Animated —— 不测量高度，只做透明度 + 位移，稳定且不吃布局。
 */
export function Collapse({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: t.motion.enterMs,
      useNativeDriver: true,
    }).start();
  }, [anim, t.motion.enterMs]);

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [
          { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/** 多层叠加模拟线性渐变（从上到下） */
export function GradientFill({
  stops,
  style,
  borderRadius = 0,
}: {
  stops: readonly string[];
  style?: object;
  borderRadius?: number;
}) {
  if (stops.length < 2) return null;
  const layers = stops.length - 1;
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius, overflow: 'hidden' }, style]}
    >
      {stops.slice(0, layers).map((c, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: c }} />
      ))}
    </View>
  );
}

/** 圆形头像 */
export function Avatar({
  label,
  size = 44,
  emoji,
}: {
  label: string;
  size?: number;
  /** 自定义 emoji 头像（优先于首字母） */
  emoji?: string;
}) {
  const t = useTheme();
  const ch = emoji ?? ((label || '?').trim().charAt(0).toUpperCase() || '?');
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <GradientFill stops={[t.colors.iconFrom, t.colors.iconTo]} borderRadius={size / 2} />
      <Text
        style={{
          color: t.colors.iconText,
          fontSize: emoji ? size * 0.5 : size * 0.42,
          fontWeight: t.weight.semibold,
        }}
      >
        {ch}
      </Text>
    </View>
  );
}

/** 方块图标（工作区用） */
export function Tile({
  label,
  size = 46,
  emoji,
}: {
  label: string;
  size?: number;
  /** 自定义 emoji 头像（优先于首字母） */
  emoji?: string;
}) {
  const t = useTheme();
  const ch = emoji ?? ((label || '?').trim().charAt(0).toUpperCase() || '?');
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: t.radius.md,
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <GradientFill stops={[t.colors.iconFrom, t.colors.iconTo]} borderRadius={t.radius.md} />
      <Text
        style={{
          color: t.colors.iconText,
          fontSize: emoji ? size * 0.48 : size * 0.4,
          fontWeight: t.weight.semibold,
        }}
      >
        {ch}
      </Text>
    </View>
  );
}

/** 细描边卡片 */
export function Card({
  children,
  style,
  tone = 'default',
}: {
  children: React.ReactNode;
  style?: object;
  tone?: 'default' | 'accent' | 'danger' | 'success';
}) {
  const t = useTheme();
  const border =
    tone === 'accent'
      ? t.colors.accentDim
      : tone === 'danger'
        ? t.colors.danger
        : tone === 'success'
          ? t.colors.success
          : t.colors.toolBorder;
  return (
    <View
      style={[
        {
          backgroundColor: t.colors.toolBg,
          borderRadius: t.radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: border,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** 状态点 */
export function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}

/** 胶囊标签 */
export function Pill({
  text,
  color,
  bg,
}: {
  text: string;
  color?: string;
  bg?: string;
}) {
  const t = useTheme();
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: t.radius.sm,
        alignSelf: 'flex-start',
        backgroundColor: bg ?? t.colors.bgOverlay,
      }}
    >
      <Text
        style={{
          color: color ?? t.colors.textSecondary,
          fontSize: t.type.micro,
          fontWeight: t.weight.medium,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

/** 水平分隔线 */
export function Divider({ style }: { style?: object }) {
  const t = useTheme();
  return (
    <View
      style={[
        { height: StyleSheet.hairlineWidth, backgroundColor: t.colors.border },
        style,
      ]}
    />
  );
}

/** 带标题的区块分隔 */
export function SectionLabel({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: t.layout.screenPadding,
        marginTop: t.space.xl,
        marginBottom: t.space.sm,
      }}
    >
      <Text
        style={{
          color: t.colors.textTertiary,
          fontSize: t.type.micro,
          fontWeight: t.weight.semibold,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          marginRight: 10,
        }}
      >
        {text}
      </Text>
      <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: t.colors.border }} />
    </View>
  );
}
