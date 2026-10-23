/**
 * 协议兼容性提示条。
 *
 * ## 显示什么
 *
 * 当 DSH 版本和 App 不匹配时，用户看到的不是「功能莫名其妙没了」，
 * 而是明确的「这几个功能在你当前的 DSH 上不可用」。
 *
 * ## 为什么不弹窗
 *
 * 这是**持续的降级状态**，不是一次性错误。弹窗会打断用户，
 * 而且关掉之后用户就忘了。贴在内容顶部的小条更合适：
 * 想看就看，不想看也不挡路。
 *
 * ## 为什么可以关掉
 *
 * 部分功能不可用通常不影响主流程（比如 updateQueue 没了，
 * 只是排队功能用不了）。用户可以主动收起，别一直占地方。
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

export function CompatBanner({
  summary,
  missing,
}: {
  /** 一句话说明 */
  summary: string;
  /** 哪些接口不可用 */
  missing: string[];
}) {
  const tv = useTheme();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !summary) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>⚠</Text>
      <View style={styles.body}>
        <Text style={styles.text} numberOfLines={3}>
          {summary}
        </Text>
        {missing.length > 0 ? (
          <Text style={styles.detail} numberOfLines={1}>
            {missing.join('、')}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={() => setDismissed(true)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="忽略兼容性提示"
      >
        <Text style={styles.close}>✕</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      marginHorizontal: tv.layout.screenPadding,
      marginTop: tv.space.xs,
      marginBottom: tv.space.xs,
      paddingVertical: 6,
      paddingHorizontal: 9,
      borderRadius: tv.radius.sm,
      backgroundColor: C.warningWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.warning,
    },
    icon: { color: C.warning, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5 },
    body: { flex: 1, gap: 2 },
    text: {
      color: C.warning,
      fontSize: tv.type.micro,
      lineHeight: tv.type.xs * 1.5,
    },
    detail: {
      color: C.textTertiary,
      fontSize: tv.type.micro,
      lineHeight: tv.type.xs * 1.4,
    },
    close: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      paddingHorizontal: 2,
    },
  });
}
