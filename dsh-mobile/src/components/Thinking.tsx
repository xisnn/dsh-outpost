/**
 * 思考三点动画 + 思考折叠面板。
 *
 * 视觉：
 * - 三点：1.6s 循环，相位错开 180ms，透明度 + 轻微上浮
 * - 折叠面板：左侧竖线 + 标题行，展开显示斜体推理文本
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../design/theme';
import { motion, radius, space, type, weight } from '../design/tokens';
import { Collapse } from './ui';

type Styles = ReturnType<typeof makeStyles>;

function Dot({ delay, color, styles }: { delay: number; color: string; styles: Styles }) {
  const v = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const seg = motion.thinkingCycleMs / 3;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, {
          toValue: 1,
          duration: seg * 0.5,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 0,
          duration: seg * 0.5,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(Math.max(0, motion.thinkingCycleMs - seg - delay)),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [delay, v]);

  return (
    <Animated.View
      style={[
        styles.dot,
        {
          backgroundColor: color,
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.95] }),
          transform: [
            { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -2.5] }) },
          ],
        },
      ]}
    />
  );
}

export function ThinkingDots({ color }: { color?: string }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const dotColor = color ?? tv.colors.textSecondary;
  return (
    <View style={styles.dotsRow}>
      <Dot delay={0} color={dotColor} styles={styles} />
      <Dot delay={motion.thinkingDotStaggerMs} color={dotColor} styles={styles} />
      <Dot delay={motion.thinkingDotStaggerMs * 2} color={dotColor} styles={styles} />
    </View>
  );
}

/** 思考折叠面板 */
export function ThinkingAccordion({ text, done }: { text: string; done: boolean }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const [open, setOpen] = useState(false);
  const firstLine = text.trim().split('\n')[0]?.slice(0, 52) ?? '';
  const charCount = text.length;

  const toggle = () => setOpen((v) => !v);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={toggle}
        style={({ pressed }: { pressed: boolean }) => [
          styles.head,
          pressed && { backgroundColor: tv.colors.bgCard },
        ]}
      >
        {/* 左侧竖线 */}
        <View
          style={[
            styles.rail,
            { backgroundColor: done ? tv.colors.textFaint : tv.colors.accent },
          ]}
        />

        <View style={styles.headMain}>
          {done ? (
            <Text style={styles.doneIcon}>◇</Text>
          ) : (
            <ThinkingDots color={tv.colors.accent} />
          )}
          <Text style={styles.label} numberOfLines={1}>
            {done ? '已思考' : '思考中'}
            {!open && firstLine ? ` · ${firstLine}` : ''}
          </Text>
        </View>

        <Text style={styles.meta}>
          {open ? '收起' : `${charCount} 字`}
        </Text>
      </Pressable>

      {open ? (
        <Collapse>
          <View style={styles.body}>
            <Text style={styles.bodyText} selectable>
              {text}
            </Text>
          </View>
        </Collapse>
      ) : null}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    dotsRow: { flexDirection: 'row', alignItems: 'center' },
    dot: { width: 4.5, height: 4.5, borderRadius: 2.25, marginRight: 3 },

    wrap: {
      marginHorizontal: space.lg + 2,
      marginVertical: space.sm,
      backgroundColor: C.bgRaised,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: C.border,
      overflow: 'hidden',
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: space.md,
      paddingRight: space.md,
      paddingVertical: 10,
    },
    rail: {
      width: 2,
      height: 14,
      borderRadius: 1,
      marginRight: space.md,
    },
    headMain: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 },
    doneIcon: { color: C.textTertiary, fontSize: 11 },
    label: {
      color: C.textSecondary,
      fontSize: type.sm,
      fontWeight: weight.medium,
      flex: 1,
      marginLeft: 6,
    },
    meta: { color: C.textFaint, fontSize: type.micro, marginLeft: space.sm },
    body: {
      paddingLeft: space.md,
      paddingRight: space.md,
      paddingBottom: space.md,
      paddingTop: 2,
    },
    bodyText: {
      color: C.textTertiary,
      fontSize: type.sm - 1,
      lineHeight: (type.sm - 1) * 1.65,
      fontStyle: 'italic',
    },
  });
}
