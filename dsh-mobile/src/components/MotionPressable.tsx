import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, type PressableProps, type View, type ViewStyle } from 'react-native';
import { MOTION, useMotionPreference } from '../design/motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export type MotionPressableProps = PressableProps & { feedback?: 'scale' | 'opacity' | 'none' };

/** Animate the original touch target, preserving flex, hitSlop and responder behavior. */
export const MotionPressable = forwardRef<View, MotionPressableProps>(function MotionPressable({
  feedback, style, onPressIn, onPressOut, ...props
}, ref) {
  const reduced = useMotionPreference();
  const progress = useRef(new Animated.Value(0)).current;
  const running = useRef<Animated.CompositeAnimation | null>(null);
  const [pressed, setPressed] = useState(false);
  const resolved = typeof style === 'function' ? style({ pressed }) : style;
  const base = StyleSheet.flatten(resolved) || {};
  // Full-screen dismiss layers and text-selection surfaces must remain stationary.
  const mode = feedback ?? (props.accessible === false || props.onLongPress || base.position === 'absolute' || !props.onPress ? 'none' : 'scale');
  const enabled = !reduced && !props.disabled && mode !== 'none';
  const scale = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.985] }), [progress]);
  const opacity = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] }), [progress]);

  useEffect(() => {
    if (!enabled) {
      running.current?.stop();
      progress.setValue(0);
      if (props.disabled) setPressed(false);
    }
    return () => { running.current?.stop(); };
  }, [enabled, progress, props.disabled]);

  const animate = (next: boolean) => {
    setPressed(next);
    running.current?.stop();
    if (!enabled) { progress.setValue(0); return; }
    running.current = Animated.timing(progress, {
      toValue: next ? 1 : 0, duration: MOTION.press,
      easing: Easing.out(Easing.quad), useNativeDriver: true,
    });
    running.current.start();
  };
  const transform = Array.isArray(base.transform) ? base.transform : [];
  const motionStyle: Animated.WithAnimatedObject<ViewStyle> | undefined = enabled
    ? mode === 'opacity'
      ? { opacity: Animated.multiply(typeof base.opacity === 'number' ? base.opacity : 1, opacity) }
      : typeof base.transform === 'string' ? undefined : { transform: [...transform, { scale }] }
    : undefined;

  return (
    <AnimatedPressable
      {...props}
      ref={ref}
      style={[resolved, motionStyle]}
      onPressIn={event => { animate(true); onPressIn?.(event); }}
      onPressOut={event => { animate(false); onPressOut?.(event); }}
    />
  );
});
