/**
 * 配对页底部的本机入口（P3）。
 *
 * 只在本机运行环境可用时出现；它不伪造登录，也不创建电脑会话，
 * 只是把用户带到「本机位置 + 管家模式」的本地面板。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import { useApp } from '../App';
import { Divider } from './ui';
import { localRuntimeAvailable } from '../core/localRuntimeSupport';

export function LocalOnlyEntry() {
  const { enterLocalOnly } = useApp();
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  if (!localRuntimeAvailable()) return null;
  return (
    <View style={styles.wrap}>
      <Divider style={styles.divider} />
      <Text style={styles.title}>没有电脑？也可以先在本机使用管家</Text>
      <Text style={styles.hint}>
        任务在手机上执行，需要先在管家页配置云端模型；手机控制权限按需开启。普通聊天与电脑模式仍可随时连接。
      </Text>
      <Pressable
        onPress={enterLocalOnly}
        accessibilityRole="button"
        accessibilityLabel="先在本机使用管家"
        style={({ pressed }: { pressed: boolean }) => [styles.button, pressed ? { opacity: 0.85 } : null]}
      >
        <Text style={styles.buttonText}>先在本机使用管家</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    wrap: { marginTop: tv.space.xxxl, alignItems: 'center' },
    divider: { alignSelf: 'stretch', marginBottom: tv.space.xl },
    title: { color: C.text, fontSize: tv.type.sm, fontWeight: '600', textAlign: 'center' },
    hint: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      textAlign: 'center',
      marginTop: tv.space.sm,
      paddingHorizontal: tv.space.lg,
    },
    button: {
      marginTop: tv.space.md,
      minHeight: 44,
      paddingHorizontal: tv.space.xl,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonText: { color: C.accent, fontSize: tv.type.sm, fontWeight: '600' },
  });
}
