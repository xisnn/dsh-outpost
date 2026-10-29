/**
 * 消息长按操作面板（参考 ChatGPT 移动端的简洁样式）。
 *
 * ## 为什么是底部面板
 *
 * 长按一条消息后拇指就在屏幕下半区；面板从底部弹出比气泡更好点，
 * 也不会挡住消息本身（用户往往要先看一眼再决定复制什么）。
 *
 * ## 只做一件事：复制全文
 *
 * 正文本身是 `selectable` 的（见 MarkdownView 的 bodyTextProps），
 * 需要选一部分时用系统原生的选词/选择手柄即可；这里只补一个
 * 「整段复制」的入口，不重复造选择模式。
 *
 * 与长按手势的分工：长按由正文外层 Pressable 接管（系统选择不会在
 * 同一手势里抢触发），面板关闭后正文的双击选词、拖手柄选择都是原生的。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../design/theme';
import { copyTextToClipboard } from './clipboard';

/** 复制成功后的反馈时长：够看到，又不至于让面板卡在那里 */
const COPIED_MS = 700;

export function MessageActionSheet({
  visible,
  text,
  onClose,
}: {
  visible: boolean;
  /** 要复制的消息正文（不含思考/工具日志） */
  text: string;
  onClose: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    setCopied(false);
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 140, useNativeDriver: true }).start();
  }, [visible, opacity]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  /** 预览：压成一行、截断，避免长消息把面板撑高 */
  const preview = useMemo(() => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
  }, [text]);

  const doCopy = () => {
    if (!copyTextToClipboard(text)) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onClose, COPIED_MS);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      {/*
        ⚠️ 背景遮罩和面板是**兄弟**，不是父子 Pressable。
        之前把面板内容包在 <Pressable onPress={() => {}}> 里挡背景点击，
        结果内层按钮的点击被外层 Pressable 抢走 —— 点「复制全文」没反应。
        现在遮罩是铺满的绝对定位 Pressable，面板是它上面的普通 View，
        行按钮的点击不会被任何东西截胡。
      */}
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
        <Animated.View style={[styles.sheet, { opacity }]}>
          <View style={styles.handle} />
          {preview ? (
            <Text style={styles.preview} numberOfLines={2}>
              {preview}
            </Text>
          ) : null}

          <Pressable
            onPress={doCopy}
            style={({ pressed }: { pressed: boolean }) => [
              styles.row,
              pressed ? { backgroundColor: tv.colors.bgCard } : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel="复制全文"
          >
            <Text style={[styles.rowText, copied ? { color: tv.colors.accentBright } : null]}>
              {copied ? '✓ 已复制' : '复制全文'}
            </Text>
          </Pressable>

          <View style={styles.sep} />

          <Pressable
            onPress={onClose}
            style={({ pressed }: { pressed: boolean }) => [
              styles.row,
              pressed ? { backgroundColor: tv.colors.bgCard } : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel="取消"
          >
            <Text style={[styles.rowText, { color: tv.colors.textSecondary }]}>取消</Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: C.scrim,
      padding: tv.space.md,
      paddingBottom: tv.space.xxl,
    },
    sheet: {
      backgroundColor: C.bgRaised,
      borderRadius: tv.radius.lg,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    handle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: C.borderStrong,
      marginTop: tv.space.sm,
    },
    preview: {
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.5,
      paddingHorizontal: tv.space.lg,
      paddingTop: tv.space.md,
      paddingBottom: tv.space.sm,
    },
    row: {
      paddingHorizontal: tv.space.lg,
      paddingVertical: tv.space.md,
    },
    rowText: {
      color: C.text,
      fontSize: tv.type.base,
      fontWeight: tv.weight.medium,
    },
    sep: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: C.border,
      marginLeft: tv.space.lg,
    },
  });
}
