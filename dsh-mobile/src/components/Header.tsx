/**
 * 顶栏：标题 + 可选返回 / 右侧操作。
 *
 * 视觉：背景与内容同色，靠底部细描边分隔；安全区自动适配。
 */
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../design/theme';
import { useNav } from '../nav/NavHost';

export function Header({
  title,
  subtitle,
  metadata,
  right,
  showBack,
  compact,
}: {
  title: string;
  subtitle?: string;
  metadata?: React.ReactNode;
  right?: React.ReactNode;
  showBack?: boolean;
  compact?: boolean;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNav();
  const back = showBack ?? nav.canGoBack;
  const inColumn = nav.column !== undefined;
  const [sideWidth, setSideWidth] = useState(44);
  const styles = useMemo(() => makeStyles(tv), [tv]);

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + (compact ? 4 : 8) }]}>
      <View style={styles.row}>
        <View style={[styles.left, { width: inColumn ? (back ? 44 : 8) : sideWidth }]}>
          {back ? (
            <Pressable
              onPress={nav.pop}
              accessibilityRole="button"
              accessibilityLabel="返回上一页"
              style={({ pressed }: { pressed: boolean }) => [
                styles.backBtn,
                pressed ? { opacity: 0.55 } : null,
              ]}
              hitSlop={12}
            >
              <Text style={styles.backIcon}>‹</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={[styles.center, inColumn && styles.columnCenter]}>
          <Text style={[styles.title, compact && styles.titleCompact, inColumn && styles.columnTitle]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
          {metadata}
        </View>

        <View
          style={styles.right}
          onLayout={event => setSideWidth(Math.max(44, event.nativeEvent.layout.width))}
        >
          {right}
        </View>
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const { colors, layout, radius, space, type, weight } = tv;
  return StyleSheet.create({
    wrap: {
      backgroundColor: colors.bg,
      paddingBottom: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    row: {
      minHeight: layout.headerHeight - 16,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.sm,
    },
    backBtn: {
      width: 44,
      height: 44,
      borderRadius: radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backIcon: { color: colors.accent, fontSize: 30, marginTop: -4 },
    left: { alignItems: 'flex-start', justifyContent: 'center' },
    center: { flex: 1, minWidth: 0, alignItems: 'center', paddingHorizontal: space.xs },
    title: {
      color: colors.text,
      fontSize: type.lg,
      fontWeight: weight.semibold,
      letterSpacing: -0.2,
      textAlign: 'center',
      maxWidth: '100%',
    },
    titleCompact: { fontSize: type.base },
    columnCenter: { alignItems: 'flex-start', paddingHorizontal: space.sm },
    columnTitle: { textAlign: 'left', fontSize: type.lg },
    subtitle: { color: colors.textSecondary, fontSize: type.xs, marginTop: 1 },
    // Mirror the measured action width on the left to center against the whole screen.
    right: { minWidth: 44, maxWidth: '40%', alignItems: 'flex-end', justifyContent: 'center' },
  });
}
