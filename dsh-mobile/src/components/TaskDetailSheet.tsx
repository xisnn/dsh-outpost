import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  useBottomSheetSpringConfigs,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { ReduceMotion } from 'react-native-reanimated';
import { useTheme } from '../design/theme';
import { TaskPressable } from './TaskMotion';

export function TaskDetailSheet({ visible, onClose, onAfterClose, children }: {
  visible: boolean;
  onClose: () => void;
  onAfterClose: () => void;
  children: React.ReactNode;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const modal = useRef<BottomSheetModal>(null);
  const content = useRef(children);
  const requested = useRef(visible);
  const presented = useRef(false);
  const opened = useRef(false);
  const dismissing = useRef(false);
  const [nativeCycle, setNativeCycle] = useState(0);
  const cycle = useRef(0);
  if (visible) content.current = children;
  requested.current = visible;

  const animationConfigs = useBottomSheetSpringConfigs({
    damping: 32, stiffness: 300, overshootClamping: true,
  });
  const backdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.24} pressBehavior="close" />
  ), []);

  useEffect(() => {
    if (visible) {
      if (!dismissing.current) {
        modal.current?.present();
        presented.current = true;
      }
    } else if (presented.current && opened.current) {
      dismissing.current = true;
      modal.current?.dismiss();
    }
  }, [visible, nativeCycle]);

  const changed = (index: number) => {
    if (nativeCycle !== cycle.current || index < 0) return;
    opened.current = true;
    // present() mounts on a later frame. A quick Back must wait until native
    // opening finishes, otherwise dismiss() has no mounted sheet to close.
    if (!requested.current && !dismissing.current) {
      dismissing.current = true;
      modal.current?.dismiss();
    }
  };

  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [visible, onClose]);

  const dismissed = () => {
    if (nativeCycle !== cycle.current) return;
    const reopen = dismissing.current && requested.current;
    dismissing.current = false;
    presented.current = false;
    opened.current = false;
    // A fresh native instance avoids reusing the library's mount animation
    // state after repeated early Back. Reopen only after the new ref commits.
    cycle.current += 1;
    setNativeCycle(cycle.current);
    if (reopen) return;
    onClose();
    onAfterClose();
  };

  return (
    <BottomSheetModal
      key={nativeCycle}
      ref={modal}
      snapPoints={['92%']}
      topInset={insets.top + 8}
      enableDynamicSizing={false}
      enablePanDownToClose
      enableOverDrag={false}
      backdropComponent={backdrop}
      animationConfigs={animationConfigs}
      overrideReduceMotion={ReduceMotion.System}
      onDismiss={dismissed}
      onChange={changed}
      accessible={false}
      backgroundStyle={{ backgroundColor: tv.colors.bg, borderTopLeftRadius: tv.radius.xl, borderTopRightRadius: tv.radius.xl }}
      handleIndicatorStyle={{ backgroundColor: tv.colors.borderStrong, width: 36 }}
      accessibilityLabel="任务详情"
    >
      <View style={{ flex: 1 }} pointerEvents={visible ? 'auto' : 'none'} accessibilityViewIsModal>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: tv.layout.screenPadding, paddingRight: tv.space.sm, paddingBottom: tv.space.sm, borderBottomWidth: 0.5, borderBottomColor: tv.colors.border }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: tv.colors.text, fontSize: tv.type.lg, fontWeight: '600' }}>任务详情</Text>
          <TaskPressable accessibilityRole="button" accessibilityLabel="关闭任务详情" onPress={onClose} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: tv.colors.accent, fontSize: 26 }}>×</Text>
          </TaskPressable>
        </View>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: tv.layout.screenPadding, paddingTop: tv.space.md, paddingBottom: insets.bottom + tv.space.xxxl }}>
          {content.current}
        </BottomSheetScrollView>
      </View>
    </BottomSheetModal>
  );
}
