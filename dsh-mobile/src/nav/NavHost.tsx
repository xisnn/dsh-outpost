/**
 * 极简栈式导航。
 *
 * 为什么不用 @react-navigation/native-stack：
 * 它依赖 react-native-screens，而后者在 RN 0.81 + Fabric 下存在
 * 原生 ABI 不兼容问题（RNSScreenStackHeaderConfigProps 析构崩溃）。
 * 三层导航本身很简单，自己实现更可控，也少一个原生依赖。
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { BackHandler, View, StyleSheet } from 'react-native';

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

export interface NavHostProps {
  initial: string;
  render: (screen: Screen) => React.ReactNode;
}

export function NavHost({ initial, render }: NavHostProps) {
  const [stack, setStack] = useState<Screen[]>([{ name: initial }]);

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
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        pop();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length, pop]);

  const value = useMemo<NavContextValue>(
    () => ({ stack, push, pop, reset, canGoBack: stack.length > 1 }),
    [stack, push, pop, reset],
  );

  // 整个栈都渲染，只有栈顶可见（其余 display:none）。
  // 这样压栈/出栈不会卸载下层页面：
  //   - 工作区列表的滚动位置、tab 选择都保留
  //   - 返回时不会重新拉一遍数据、也没有白屏闪烁
  // 这是 react-navigation 的标准行为，之前只渲染栈顶所以状态会丢。
  const topIndex = stack.length - 1;

  return (
    <NavContext.Provider value={value}>
      <View style={styles.root}>
        {stack.map((screen, i) => {
          const isTop = i === topIndex;
          return (
            <View
              key={`${i}-${screen.name}`}
              style={[styles.screen, isTop ? null : styles.hidden]}
              pointerEvents={isTop ? 'auto' : 'none'}
              accessibilityElementsHidden={!isTop}
              importantForAccessibility={isTop ? 'auto' : 'no-hide-descendants'}
            >
              {render(screen)}
            </View>
          );
        })}
      </View>
    </NavContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1 },
  hidden: { display: 'none' },
});
