import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, type ModalProps } from 'react-native';
import { MOTION, useMotionPreference } from '../design/motion';

/** Full-screen viewers retain native presentation; overlays share a reversible fade. */
export function MotionModal(props: ModalProps) {
  const reduced = useMotionPreference();
  if (props.transparent && props.animationType !== 'none') return <FadingModal {...props} />;
  return <Modal {...props} animationType={reduced ? 'none' : props.animationType} />;
}

function FadingModal({ visible = true, children, onShow, onRequestClose, ...props }: ModalProps) {
  const reduced = useMotionPreference();
  const [presented, setPresented] = useState(visible);
  const opacity = useRef(new Animated.Value(0)).current;
  const shown = useRef(false);
  const requested = useRef(visible);
  const generation = useRef(0);
  const running = useRef<Animated.CompositeAnimation | null>(null);
  const retained = useRef(children);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  requested.current = visible;
  if (visible) retained.current = children;

  const enter = () => {
    running.current?.stop();
    if (reducedRef.current) { opacity.setValue(1); return; }
    running.current = Animated.timing(opacity, {
      toValue: 1, duration: MOTION.enter, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    });
    running.current.start();
  };

  useEffect(() => {
    const current = ++generation.current;
    running.current?.stop();
    if (visible) {
      setPresented(true);
      if (shown.current) enter();
    } else {
      const finish = () => {
        if (generation.current !== current || requested.current) return;
        shown.current = false;
        setPresented(false);
        opacity.setValue(0);
      };
      if (reduced || !shown.current) finish();
      else {
        running.current = Animated.timing(opacity, {
          toValue: 0, duration: MOTION.exit, easing: Easing.in(Easing.cubic), useNativeDriver: true,
        });
        running.current.start(({ finished }) => { if (finished) finish(); });
      }
    }
    return () => { generation.current += 1; running.current?.stop(); };
  }, [visible, reduced, opacity]);

  if (!presented) return null;
  return (
    <Modal
      {...props}
      visible
      animationType="none"
      onRequestClose={event => { if (requested.current) onRequestClose?.(event); }}
      onShow={event => {
        shown.current = true;
        if (requested.current) { enter(); onShow?.(event); }
        else { shown.current = false; setPresented(false); }
      }}
    >
      <Animated.View
        style={{ flex: 1, opacity }}
        pointerEvents={visible ? 'auto' : 'none'}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        accessibilityElementsHidden={!visible}
      >
        {visible ? children : retained.current}
      </Animated.View>
    </Modal>
  );
}
