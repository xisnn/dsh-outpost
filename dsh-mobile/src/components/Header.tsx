/**
 * 顶栏：标题 + 可选返回 / 右侧操作。
 *
 * 视觉：背景与内容同色，靠底部细描边分隔；安全区自动适配。
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../design/theme';
import { useNav } from '../nav/NavHost';

export function Header({
  title,
  subtitle,
  right,
  showBack,
  compact,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  showBack?: boolean;
  compact?: boolean;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNav();
  const back = showBack ?? nav.canGoBack;
  const styles = useMemo(() => makeStyles(tv), [tv]);

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + (compact ? 4 : 8) }]}>
      <View style={styles.row}>
        {back ? (
          <Pressable
            onPress={nav.pop}
            style={({ pressed }: { pressed: boolean }) => [
              styles.backBtn,
              pressed ? { opacity: 0.55 } : null,
            ]}
            hitSlop={12}
          >
            <Text style={styles.backIcon}>‹</Text>
          </Pressable>
        ) : (
          <View style={styles.backSpacer} />
        )}

        <View style={styles.center}>
          <Text style={[styles.title, compact && styles.titleCompact]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.right}>{right}</View>
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
      width: 40,
      height: 40,
      borderRadius: radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backIcon: { color: colors.accent, fontSize: 30, marginTop: -4 },
    backSpacer: { width: 40 },
    center: { flex: 1, alignItems: 'center', paddingHorizontal: space.xs },
    title: {
      color: colors.text,
      fontSize: type.lg,
      fontWeight: weight.semibold,
      letterSpacing: -0.2,
      textAlign: 'center',
    },
    titleCompact: { fontSize: type.base },
    subtitle: { color: colors.textFaint, fontSize: type.micro, marginTop: 1 },
    right: { minWidth: 40, alignItems: 'flex-end', justifyContent: 'center' },
  });
}
