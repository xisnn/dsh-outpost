/**
 * 极简栈式导航。
 *
 * 为什么不用 @react-navigation/native-stack：
 * 它依赖 react-native-screens，而后者在 RN 0.81 + Fabric 下存在
 * 原生 ABI 不兼容问题（RNSScreenStackHeaderConfigProps 析构崩溃）。
 * 三层导航本身很简单，自己实现更可控，也少一个原生依赖。
 *
 * 转场动画：新页面从右侧滑入 + 淡入，配合底层页面轻微左移。
 * 用 Animated + useNativeDriver，Fabric 下正常工作。
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, BackHandler, Dimensions, View, StyleSheet } from 'react-native';

export interface Screen {
  name: string;
  params?: Record<string, unknown>;
}

interface NavContextValue {
  stack: Screen[];
  push: (name: string, params?: Record<string, unknown>) => void;
  pop: () => void;
  reset: (name: string, params?: Record<string, unknown>) => void;
  canGoBack: boolean;
}

const NavContext = createContext<NavContextValue | null>(null);

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used inside NavHost');
  return ctx;
}

interface NavHostProps {
  initial: Screen;
  render: (screen: Screen) => React.ReactNode;
}

const SCREEN_WIDTH = Dimensions.get('window').width;
/** 转场时长：太快看不出、太慢显得卡 */
const DURATION = 240;

/** 单个页面容器：负责自己的入场动画 */
function ScreenPane({
  active,
  /** 是否被新页面压在下面（需要轻微让位） */
  covered,
  children,
}: {
  active: boolean;
  covered: boolean;
  children: React.ReactNode;
}) {
  // 0 = 完全在右侧屏外，1 = 就位
  const enter = useRef(new Animated.Value(1)).current;
  const firstMount = useRef(true);

  useEffect(() => {
    if (firstMount.current) {
      firstMount.current = false;
      return;
    }
    // 页面被 push 上来：从右侧滑入
    enter.setValue(0);
    Animated.timing(enter, {
      toValue: 1,
      duration: DURATION,
      useNativeDriver: true,
    }).start();
  }, [enter]);

  const translateX = enter.interpolate({
    inputRange: [0, 1],
    outputRange: [SCREEN_WIDTH * 0.28, 0],
  });
  const opacity = enter.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 1],
  });

  // 被覆盖时露出一点边缘，暗示下面还有页面
  const coverShift = covered ? -SCREEN_WIDTH * 0.08 : 0;

  return (
    <Animated.View
      style={[
        styles.screen,
        {
          opacity,
          transform: [{ translateX: Animated.add(translateX, coverShift) }],
        },
      ]}
      pointerEvents={active ? 'auto' : 'none'}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      {children}
    </Animated.View>
  );
}

export function NavHost({ initial, render }: NavHostProps) {
  const [stack, setStack] = useState<Screen[]>([initial]);

  const push = useCallback((name: string, params?: Record<string, unknown>) => {
    setStack((s) => [...s, { name, params }]);
  }, []);

  const pop = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const reset = useCallback((name: string, params?: Record<string, unknown>) => {
    setStack([{ name, params }]);
  }, []);

  // Android 返回键
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      let handled = false;
      setStack((s) => {
        if (s.length > 1) {
          handled = true;
          return s.slice(0, -1);
        }
        return s;
      });
      return handled;
    });
    return () => sub.remove();
  }, []);

  const value = useMemo<NavContextValue>(
    () => ({
      stack,
      push,
      pop,
      reset,
      canGoBack: stack.length > 1,
    }),
    [stack, push, pop, reset],
  );

  const topIndex = stack.length - 1;

  return (
    <NavContext.Provider value={value}>
      <View style={styles.root}>
        {stack.map((screen, i) => {
          const isTop = i === topIndex;
          return (
            <ScreenPane key={`${i}-${screen.name}`} active={isTop} covered={!isTop}>
              {render(screen)}
            </ScreenPane>
          );
        })}
      </View>
    </NavContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
});
