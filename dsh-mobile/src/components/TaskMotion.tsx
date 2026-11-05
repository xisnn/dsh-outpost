import React, { useState } from 'react';
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { MOTION, useMotionPreference } from '../design/motion';
export { MotionPressable as TaskPressable } from './MotionPressable';
import { MotionPressable as TaskPressable } from './MotionPressable';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../design/theme';

export const taskLayout = LinearTransition.duration(MOTION.layout).reduceMotion(ReduceMotion.System);
export const taskEnter = FadeIn.duration(MOTION.enter).reduceMotion(ReduceMotion.System);
export const taskExit = FadeOut.duration(MOTION.exit).reduceMotion(ReduceMotion.System);
export const TaskSection = Animated.View;

export function TaskStatus({ label, color, style, textStyle }: {
  label: string;
  color: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const border = useAnimatedStyle(() => ({
    borderColor: withTiming(color, { duration: 160, reduceMotion: ReduceMotion.System }),
  }));
  const text = useAnimatedStyle(() => ({
    color: withTiming(color, { duration: 160, reduceMotion: ReduceMotion.System }),
  }));
  return (
    <Animated.View style={[style, border]} layout={taskLayout}>
      <Animated.Text key={label} style={[textStyle, text]} entering={taskEnter} exiting={taskExit}>
        {label}
      </Animated.Text>
    </Animated.View>
  );
}

export function TaskDisclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  const tv = useTheme();
  const [expanded, setExpanded] = useState(false);
  const height = useSharedValue(0);
  const reduced = useMotionPreference();
  const contentStyle = useAnimatedStyle(() => ({
    height: withTiming(expanded ? height.value : 0, { duration: reduced ? 0 : 240 }),
    opacity: withTiming(expanded ? 1 : 0, { duration: reduced ? 0 : 160 }),
  }));
  const arrowStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(expanded ? '180deg' : '0deg', { duration: reduced ? 0 : 180 }) }],
  }));
  return (
    <View style={{ marginTop: tv.space.md }}>
      <TaskPressable
        accessibilityRole="button"
        accessibilityLabel="执行设置"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(value => !value)}
        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: tv.space.sm }}
      >
        <Text style={{ color: tv.colors.textSecondary, fontSize: tv.type.xs }}>执行设置</Text>
        <Text style={{ flex: 1, textAlign: 'right', color: tv.colors.textTertiary, fontSize: tv.type.xs, marginRight: tv.space.sm }}>{summary}</Text>
        <Animated.Text style={[{ color: tv.colors.textSecondary, fontSize: tv.type.sm }, arrowStyle]}>⌄</Animated.Text>
      </TaskPressable>
      <Animated.View style={[{ overflow: 'hidden' }, contentStyle]}>
        <View
          onLayout={event => { height.value = event.nativeEvent.layout.height; }}
          pointerEvents={expanded ? 'auto' : 'none'}
          importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
          accessibilityElementsHidden={!expanded}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingBottom: tv.space.sm }}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}
