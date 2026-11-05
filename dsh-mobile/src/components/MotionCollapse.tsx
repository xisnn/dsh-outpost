import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { MOTION, useMotionPreference } from '../design/motion';

/** Animate explicit toggles only; history mounts and streaming layout stay immediate. */
export function MotionCollapse({
  open = true,
  children,
}: {
  open?: boolean;
  children: React.ReactNode;
}) {
  const reduceMotion = useMotionPreference();
  const [present, setPresent] = useState(open);
  const height = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(open ? 1 : 0)).current;
  const measuredHeight = useRef<number | null>(null);
  const wantedOpen = useRef(open);
  const previousOpen = useRef(open);
  const reduced = useRef(reduceMotion);
  const retained = useRef(open);
  const waitingForMeasure = useRef(false);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const generation = useRef(0);

  const stop = useCallback(() => {
    // A stopped animation can still deliver its completion callback.
    generation.current += 1;
    const running = animation.current;
    animation.current = null;
    running?.stop();
  }, []);

  const transitionTo = useCallback((nextOpen: boolean) => {
    stop();
    const targetHeight = nextOpen ? measuredHeight.current ?? 0 : 0;
    const finish = () => {
      height.setValue(nextOpen ? measuredHeight.current ?? 0 : 0);
      opacity.setValue(nextOpen ? 1 : 0);
      if (!nextOpen) {
        retained.current = false;
        measuredHeight.current = null;
        setPresent(false);
      }
    };
    if (reduced.current) {
      finish();
      return;
    }
    const id = generation.current;
    const running = Animated.parallel([
      Animated.timing(height, {
        toValue: targetHeight,
        duration: MOTION.layout,
        useNativeDriver: false,
      }),
      Animated.timing(opacity, {
        toValue: nextOpen ? 1 : 0,
        duration: nextOpen ? MOTION.enter : MOTION.exit,
        useNativeDriver: false,
      }),
    ]);
    animation.current = running;
    running.start(({ finished }) => {
      if (!finished || id !== generation.current) return;
      animation.current = null;
      finish();
    });
  }, [height, opacity, stop]);

  useLayoutEffect(() => {
    wantedOpen.current = open;
    reduced.current = reduceMotion;
    const changed = previousOpen.current !== open;
    previousOpen.current = open;
    // Never animate an initially open history row, including its first layout.
    if (!changed && !animation.current && !waitingForMeasure.current) return;
    stop();
    if (open) {
      retained.current = true;
      setPresent(true);
      if (measuredHeight.current === null) {
        waitingForMeasure.current = true;
      } else {
        waitingForMeasure.current = false;
        transitionTo(true);
      }
    } else {
      waitingForMeasure.current = false;
      if (retained.current) transitionTo(false);
    }
  }, [open, reduceMotion, stop, transitionTo]);

  useLayoutEffect(() => stop, [stop]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    if (!retained.current) return;
    const nextHeight = event.nativeEvent.layout.height;
    if (!Number.isFinite(nextHeight) || nextHeight < 0) return;
    const oldHeight = measuredHeight.current;
    measuredHeight.current = nextHeight;
    if (!wantedOpen.current) return;
    if (waitingForMeasure.current) {
      waitingForMeasure.current = false;
      transitionTo(true);
    } else if (oldHeight !== nextHeight) {
      // Streaming/nested content changes snap to their new size, without a
      // fresh transition per token. Also release any obsolete opening target.
      stop();
      height.setValue(nextHeight);
      opacity.setValue(1);
    }
  }, [height, opacity, stop, transitionTo]);

  if (!present) return null;
  return (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      aria-hidden={!open}
      style={[styles.clip, { height, opacity }]}
    >
      <View onLayout={onLayout} style={styles.content} collapsable={false}>
        {children}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  // Measure natural content height independently of the animated viewport.
  content: { position: 'absolute', top: 0, left: 0, right: 0 },
});
