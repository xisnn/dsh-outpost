/**
 * 工具输出 / Diff 全屏查看器。
 *
 * 卡片里的预览是**有损**的（最多十几行），这里必须保证：
 *   · 内容完整：原文一字不删，纵向 + 横向都能滚；
 *   · 可读：等宽字体、长行横向滚动、diff 行带 +/− 与底色；
 *   · 可选中：正文是 `selectable` 的；
 *   · 「复制全部」只在这里出现 —— 工具卡片上不放常驻复制按钮。
 *
 * 视觉全部走主题 token，深色/浅色一致；不新增依赖。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../design/theme';
import type { DiffLine, ToolDiff } from '../core/toolDiff';
import { diffToText } from '../core/toolDiff';
import { copyTextToClipboard } from './clipboard';

/** 复制反馈时长 */
const COPIED_MS = 1200;

export function ToolOutputViewer({
  visible,
  title,
  subtitle,
  content,
  diff,
  onClose,
}: {
  visible: boolean;
  /** 顶部标题，例如「执行命令 · 输出」 */
  title: string;
  /** 文件路径等次要信息（可很长，单行省略，查看器正文里保留全量内容） */
  subtitle?: string;
  /** 纯文本内容（mode=text 时必传；diff 模式下不需要） */
  content?: string;
  /** 传入则按 diff 行渲染（优先于 content） */
  diff?: ToolDiff;
  onClose: () => void;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;
    setCopied(false);
  }, [visible]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const isDiff = !!diff;
  /** 复制全部永远取「完整内容」：diff 用带前缀的全文，文本用原始 output */
  const fullText = isDiff ? diffToText(diff) : content ?? '';

  const onCopy = () => {
    if (!copyTextToClipboard(fullText)) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <Modal visible={visible} transparent={false} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={styles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel="关闭"
          >
            <Text style={styles.closeIcon}>✕</Text>
          </Pressable>
          <View style={styles.titleBox}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <Pressable
            onPress={onCopy}
            disabled={!fullText}
            hitSlop={10}
            style={({ pressed }: { pressed: boolean }) => [
              styles.copyBtn,
              pressed ? { opacity: tv.motion.pressOpacity } : null,
              !fullText ? { opacity: 0.35 } : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel="复制全部"
          >
            <Text style={[styles.copyText, copied ? { color: tv.colors.accentBright } : null]}>
              {copied ? '✓ 已复制' : '复制全部'}
            </Text>
          </Pressable>
        </View>

        {isDiff ? (
          <DiffBody diff={diff} styles={styles} />
        ) : (
          <TextBody content={content ?? ''} styles={styles} />
        )}

        <View style={{ height: Math.max(insets.bottom, tv.space.md) }} />
      </View>
    </Modal>
  );
}

/**
 * 纯文本正文：单个纵向 ScrollView，长行自然折行。
 *
 * ⚠️ 不要在外层纵向 ScrollView 里再套横向 ScrollView：两轴嵌套在 Android 上
 * 会互相抢手势（实测纵向滑不动）。折行虽然不如横向滚动「保真」，但内容一个
 * 字都不会丢，且单指操作最稳。
 */
function TextBody({
  content,
  styles,
}: {
  content: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  if (!content) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>(无输出)</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.code} selectable>
        {content}
      </Text>
    </ScrollView>
  );
}

/** Diff 正文：每行一个可选择的文本行（长行折行，避免嵌套滚动） */
function DiffBody({ diff, styles }: { diff: ToolDiff; styles: ReturnType<typeof makeStyles> }) {
  const tv = useTheme();
  if (diff.lines.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>(没有可展示的差异)</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.diffContent}>
      {diff.lines.map((line, i) => (
        <DiffRow key={`${line.kind}-${i}`} line={line} styles={styles} />
      ))}
      <Text style={[styles.diffSummary, { color: tv.colors.textTertiary }]}>
        {`+${diff.added}  −${diff.removed}`}
      </Text>
    </ScrollView>
  );
}

function DiffRow({ line, styles }: { line: DiffLine; styles: ReturnType<typeof makeStyles> }) {
  const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  return (
    <View
      style={[
        styles.diffRow,
        line.kind === 'add' ? styles.diffRowAdd : null,
        line.kind === 'del' ? styles.diffRowDel : null,
      ]}
    >
      <Text style={styles.diffPrefix} selectable={false}>
        {prefix}
      </Text>
      <Text style={styles.diffText} selectable>
        {line.text || ' '}
      </Text>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: C.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: C.border,
    },
    closeBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    closeIcon: { color: C.textSecondary, fontSize: 18 },
    titleBox: { flex: 1, minWidth: 0, paddingHorizontal: tv.space.xs },
    title: {
      color: C.text,
      fontSize: tv.type.base,
      fontWeight: tv.weight.semibold,
    },
    subtitle: {
      color: C.textFaint,
      fontSize: tv.type.micro,
      marginTop: 2,
      fontFamily: 'monospace',
    },
    copyBtn: {
      paddingHorizontal: tv.space.sm,
      paddingVertical: 6,
      borderRadius: tv.radius.sm,
      backgroundColor: C.bgCard,
    },
    copyText: {
      color: C.textSecondary,
      fontSize: tv.type.xs,
      fontWeight: tv.weight.medium,
    },
    flex: { flex: 1 },
    scrollContent: { padding: tv.space.md },
    code: {
      color: C.text,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      fontFamily: 'monospace',
    },
    diffContent: { paddingVertical: tv.space.md },
    diffRow: {
      flexDirection: 'row',
      paddingHorizontal: tv.space.md,
      paddingVertical: 1,
    },
    diffRowAdd: { backgroundColor: C.successWash },
    diffRowDel: { backgroundColor: C.dangerWash },
    diffPrefix: {
      width: 14,
      color: C.textTertiary,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      fontFamily: 'monospace',
    },
    diffText: {
      color: C.text,
      fontSize: tv.type.xs,
      lineHeight: tv.type.xs * 1.6,
      fontFamily: 'monospace',
    },
    diffSummary: {
      fontSize: tv.type.micro,
      paddingHorizontal: tv.space.md,
      marginTop: tv.space.sm,
    },
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: tv.space.xl },
    emptyText: { color: C.textTertiary, fontSize: tv.type.sm },
  });
}
