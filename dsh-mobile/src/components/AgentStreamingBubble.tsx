/**
 * Rurea C1 增量流式输出气泡：
 * - 打字机增量文本 + 光标（尊重 reduceMotion，无障碍时不闪烁）；
 * - 顶部状态行与一键「停止」按钮，随时可中断在途流式响应；
 * - 完成落盘前的 `settling` 过渡态与 `AssistantBubble` 视觉齐平，消除完成瞬间闪烁。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import type { StreamingBubbleMode } from '../core/agentStream';

export const STREAM_CURSOR = '▍';
const CURSOR_BLINK_MS = 530;

export function AgentStreamingBubble({
  mode,
  statusLabel,
  text,
  showCursor,
  canStop,
  stopDisabled = false,
  reduceMotion = false,
  onStop,
}: {
  mode: Exclude<StreamingBubbleMode, 'hidden'>;
  statusLabel: string;
  text: string;
  showCursor: boolean;
  canStop: boolean;
  stopDisabled?: boolean;
  reduceMotion?: boolean;
  onStop?: () => void;
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [cursorOn, setCursorOn] = useState(true);

  useEffect(() => {
    if (!showCursor || reduceMotion) {
      setCursorOn(true);
      return;
    }
    setCursorOn(true);
    const timer = setInterval(() => setCursorOn((prev) => !prev), CURSOR_BLINK_MS);
    return () => clearInterval(timer);
  }, [showCursor, reduceMotion]);

  if (mode === 'settling') {
    return (
      <View style={styles.row}>
        <View style={styles.bubble}>
          <Text style={styles.label}>{statusLabel}</Text>
          <Text style={styles.bodyText} selectable>{text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <View style={styles.headerRow}>
          <View style={styles.statusGroup}>
            <ActivityIndicator size="small" color={tv.colors.accent} />
            <Text style={styles.statusText} numberOfLines={1}>{statusLabel}</Text>
          </View>
          {canStop && onStop ? (
            <Pressable
              onPress={onStop}
              disabled={stopDisabled}
              accessibilityRole="button"
              accessibilityLabel="停止当前回答"
              accessibilityState={{ disabled: stopDisabled }}
              hitSlop={6}
              style={[styles.stopBtn, stopDisabled ? styles.muted : null]}
            >
              <View style={styles.stopDot} />
              <Text style={styles.stopText}>停止</Text>
            </Pressable>
          ) : null}
        </View>
        {text.length > 0 ? (
          <Text style={styles.streamText} selectable accessibilityLiveRegion="polite">
            {text}
            {showCursor ? (
              <Text style={[styles.cursor, !cursorOn ? styles.cursorOff : null]}>
                {STREAM_CURSOR}
              </Text>
            ) : null}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    row: { paddingHorizontal: tv.layout.screenPadding, marginTop: tv.space.md, alignItems: 'flex-start' },
    bubble: {
      maxWidth: '92%',
      paddingHorizontal: tv.space.lg,
      paddingVertical: tv.space.sm + 1,
      borderRadius: tv.radius.lg,
      backgroundColor: C.bgRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
    },
    label: { color: C.textTertiary, fontSize: tv.type.micro, fontWeight: '600', marginBottom: 3 },
    bodyText: { color: C.text, fontSize: tv.type.base, lineHeight: tv.type.base * 1.5 },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    statusGroup: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
    statusText: { color: C.textSecondary, fontSize: tv.type.sm, flexShrink: 1 },
    stopBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      minHeight: 28,
      paddingHorizontal: 10,
      borderRadius: tv.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.danger,
    },
    stopDot: { width: 6, height: 6, borderRadius: 1.5, backgroundColor: C.danger },
    stopText: { color: C.danger, fontSize: tv.type.xs, fontWeight: '600' },
    streamText: { color: C.text, fontSize: tv.type.base, lineHeight: tv.type.base * 1.5, marginTop: tv.space.sm },
    cursor: { color: C.accent, fontWeight: '700' },
    cursorOff: { opacity: 0 },
    muted: { opacity: 0.5 },
  });
}
