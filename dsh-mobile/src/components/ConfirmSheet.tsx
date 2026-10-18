/**
 * 自定义确认弹窗（替代系统 Alert）。
 *
 * 系统 Alert 是 Material 样式，和我们的暖白/纯白视觉不搭，
 * 这里用 Modal 自绘：圆角卡片 + 细分隔线 + 危险色文字。
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';

export function ConfirmSheet({
  visible,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  destructive,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 确认按钮用危险色（删除/退出这类） */
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const tv = useTheme();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);
  const scale = useRef(new Animated.Value(0.96)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    scale.setValue(0.96);
    opacity.setValue(0);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 9, tension: 140, useNativeDriver: true }),
    ]).start();
  }, [visible, opacity, scale]);

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Animated.View style={[styles.card, { opacity, transform: [{ scale }] }]}>
          {/* 挡住背景点击，避免点卡片也关掉 */}
          <Pressable onPress={() => {}}>
            <Text style={styles.title}>{title}</Text>
            {message ? <Text style={styles.message}>{message}</Text> : null}

            <View style={styles.actions}>
              <Pressable
                onPress={onCancel}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.action,
                  styles.actionLeft,
                  pressed ? { backgroundColor: tv.colors.bgCard } : null,
                ]}
              >
                <Text style={styles.cancelText}>{cancelText}</Text>
              </Pressable>
              <Pressable
                onPress={onConfirm}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.action,
                  pressed ? { backgroundColor: tv.colors.bgCard } : null,
                ]}
              >
                <Text style={[styles.confirmText, destructive ? { color: tv.colors.danger } : null]}>
                  {confirmText}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(20,24,32,0.38)',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 36,
    },
    card: {
      width: '100%',
      maxWidth: 340,
      borderRadius: 18,
      backgroundColor: C.bgRaised,
      overflow: 'hidden',
    },
    title: {
      color: C.text,
      fontSize: tv.type.lg,
      fontWeight: tv.weight.semibold,
      paddingHorizontal: 20,
      paddingTop: 20,
    },
    message: {
      color: C.textSecondary,
      fontSize: tv.type.sm,
      lineHeight: tv.type.sm * 1.55,
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 18,
    },
    actions: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.border,
    },
    action: { flex: 1, alignItems: 'center', paddingVertical: 14 },
    actionLeft: {
      borderRightWidth: StyleSheet.hairlineWidth,
      borderRightColor: C.border,
    },
    cancelText: { color: C.textSecondary, fontSize: tv.type.base },
    confirmText: {
      color: C.accentBright,
      fontSize: tv.type.base,
      fontWeight: tv.weight.medium,
    },
  });
}
