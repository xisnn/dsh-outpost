/**
 * 工具调用卡片。
 *
 * 视觉：
 * - 左侧状态点（执行中脉冲 / 完成绿 / 失败红）
 * - 工具图标 + 中文名 + 参数摘要（等宽字体）
 * - 展开看完整参数与输出
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ToolBlock } from '../core/fold';
import { useTheme } from '../design/theme';
import { radius, space, type, weight, toolMeta } from '../design/tokens';
import { Collapse } from './ui';

type Styles = ReturnType<typeof makeStyles>;

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  const o = input as Record<string, unknown>;
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'description', 'sessionId', 'name']) {
    if (typeof o[key] === 'string' && o[key]) {
      const v = String(o[key]).replace(/\s+/g, ' ').trim();
      return v.length > 70 ? v.slice(0, 70) + '…' : v;
    }
  }
  const first = Object.entries(o).find(([, v]) => typeof v === 'string' && v);
  if (first) return String(first[1]).slice(0, 70);
  return JSON.stringify(input).slice(0, 70);
}

/** 执行中的脉冲点 */
function PulseDot({ color, styles }: { color: string; styles: Styles }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 1,
          duration: 750,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 0,
          duration: 750,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={styles.dotWrap}>
      <Animated.View
        style={[
          styles.dotHalo,
          {
            backgroundColor: color,
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.05, 0.3] }),
            transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }],
          },
        ]}
      />
      <View style={[styles.dotCore, { backgroundColor: color }]} />
    </View>
  );
}

export function ToolCard({ block }: { block: ToolBlock }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);
  const meta = toolMeta(block.name);
  const summary = summarize(block.input);

  const statusColor = block.pending
    ? tv.colors.textTertiary
    : block.isError
      ? tv.colors.danger
      : tv.colors.success;
  const statusText = block.pending ? '执行中' : block.isError ? '失败' : '完成';

  const toggle = () => setOpen((v) => !v);

  return (
    <Pressable
      onPress={toggle}
      style={({ pressed }: { pressed: boolean }) => [
        styles.card,
        block.isError && styles.cardError,
        pressed && { backgroundColor: tv.colors.bgCard },
      ]}
    >
      <View style={styles.head}>
        <View style={styles.iconCol}>
          {block.pending ? (
            <PulseDot color={tv.colors.textTertiary} styles={styles} />
          ) : (
            <View style={[styles.iconBadge, { borderColor: statusColor + '44' }]}>
              <Text style={[styles.iconChar, { color: statusColor }]}>{meta.icon}</Text>
            </View>
          )}
        </View>

        <View style={styles.main}>
          <View style={styles.titleLine}>
            <Text style={styles.toolName} numberOfLines={1}>
              {meta.label}
            </Text>
            <Text style={[styles.status, { color: statusColor }]}>{statusText}</Text>
          </View>
          {summary ? (
            <Text style={styles.summary} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
        </View>

        <Text style={styles.chevron}>{open ? '⌃' : '⌄'}</Text>
      </View>

      {open ? (
        <Collapse>
          <View style={styles.body}>
            <Text style={styles.bodyLabel}>参数</Text>
            <Text style={styles.code} selectable>
              {typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)}
            </Text>
            {block.output !== undefined ? (
              <>
                <Text style={styles.bodyLabel}>输出</Text>
                <Text
                  style={[styles.code, block.isError && { color: tv.colors.danger }]}
                  selectable
                  numberOfLines={40}
                >
                  {block.output || '(空)'}
                </Text>
              </>
            ) : null}
          </View>
        </Collapse>
      ) : null}
    </Pressable>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    card: {
      marginHorizontal: space.lg + 2,
      marginBottom: space.sm,
      backgroundColor: C.toolBg,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.toolBorder,
      overflow: 'hidden',
    },
    cardError: { borderColor: C.dangerWash },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: space.md + 2,
      paddingVertical: 11,
    },
    iconCol: { width: 24, alignItems: 'center', justifyContent: 'center' },
    iconBadge: {
      width: 24,
      height: 24,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconChar: { fontSize: 12, fontWeight: weight.semibold },
    dotWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
    dotHalo: { position: 'absolute', width: 9, height: 9, borderRadius: 4.5 },
    dotCore: { width: 5, height: 5, borderRadius: 2.5 },
    main: { flex: 1, marginLeft: space.sm + 2, minWidth: 0 },
    titleLine: { flexDirection: 'row', alignItems: 'center' },
    toolName: { color: C.text, fontSize: type.sm + 0.5, fontWeight: weight.semibold },
    status: { fontSize: type.micro, marginLeft: space.sm, fontWeight: weight.medium },
    summary: {
      color: C.textFaint,
      fontSize: type.xs,
      marginTop: 3,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    chevron: { color: C.textFaint, fontSize: 12, marginLeft: space.sm },
    body: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: C.toolBorder,
      paddingHorizontal: space.md,
      paddingBottom: space.md,
      paddingTop: space.sm,
    },
    bodyLabel: {
      color: C.textFaint,
      fontSize: type.micro,
      fontWeight: weight.semibold,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      marginBottom: 5,
      marginTop: space.sm,
    },
    code: {
      color: C.textSecondary,
      fontSize: type.xs,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      lineHeight: 17,
    },
  });
}
