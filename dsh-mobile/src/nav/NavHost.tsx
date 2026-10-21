/**
 * 极简栈式导航 + 边缘滑动手势。
 *
 * 为什么不用 @react-navigation/native-stack：
 * 它依赖 react-native-screens，而后者在 RN 0.81 + Fabric 下存在
 * 原生 ABI 不兼容问题（RNSScreenStackHeaderConfigProps 析构崩溃）。
 * 三层导航本身很简单，自己实现更可控，也少一个原生依赖。
 *
 * ## 手势
 *
 * 左缘往右滑 = 返回上一页，页面跟着手指走，松手按位移决定：
 *   - 滑过 35% 屏宽 或 快速一甩 → 返回
 *   - 否则弹回原位
 *
 * 几个关键取舍：
 *
 * 1. **只在左缘 28px 内起手才认**。整屏都能划会和聊天列表的横向
 *    操作（图片查看、代码块横滑）打架，误触率高得没法用。
 *
 * 2. **必须比纵向位移大才认**。手指斜着划时，纵向占优说明用户
 *    想滚列表，不该触发返回。
 *
 * 3. **根页面右滑什么都不做**。不加这条的话，用户习惯性一划就把
 *    App 划退出了（Android 上特别容易误退）。
 *
 * 4. **用 useNativeDriver 做动画，但手势位移用 JS 值**。
 *    PanResponder 的事件在 JS 线程，强行给 Animated.event 配
 *    native driver 会在 Fabric 下丢帧。
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  BackHandler,
  Dimensions,
  PanResponder,
  View,
  StyleSheet,
} from 'react-native';

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

/** 手势起手的左缘宽度。窄一点更稳，避免和内容横滑冲突 */
export const EDGE_WIDTH = 28;

/** 滑过这个比例就判定为「返回」 */
export const DISMISS_RATIO = 0.35;

/** 松手时的速度阈值（px/ms），甩一下就返回 */
export const FLING_VELOCITY = 0.5;

/**
 * 判定松手后是否返回。
 *
 * 抽成纯函数是为了能单测 —— 手势这块在模拟器上很难稳定复现，
 * 逻辑对错只能靠测试保证。
 *
 * @param dx 横向位移（向右为正）
 * @param vx 横向速度（px/ms）
 * @param width 屏宽
 */
export function shouldDismiss(dx: number, vx: number, width: number): boolean {
  if (dx <= 0) return false;
  // 甩得够快，不管位移多少都算返回（模拟「一划就走」）
  if (vx > FLING_VELOCITY) return true;
  return dx > width * DISMISS_RATIO;
}

/**
 * 这一下手势该不该被认作「返回」。
 *
 * @param startX 起手点 x
 * @param dx 当前横向位移
 * @param dy 当前纵向位移
 * @param canGoBack 栈里还有上一页吗
 */
export function isBackGesture(
  startX: number,
  dx: number,
  dy: number,
  canGoBack: boolean,
): boolean {
  if (!canGoBack) return false; // 根页面：不认，避免一划退 App
  if (startX > EDGE_WIDTH) return false; // 必须从左缘起手
  if (dx <= 0) return false; // 只能往右划
  // 纵向占优说明用户想滚列表
  if (Math.abs(dy) > Math.abs(dx)) return false;
  return true;
}

/** 单个页面容器：负责自己的入场动画 */
function ScreenPane({
  active,
  /** 是否被新页面压在下面（需要轻微让位） */
  covered,
  /** 手势拖动位移（只对顶层页面生效） */
  dragX,
  children,
}: {
  active: boolean;
  covered: boolean;
  dragX?: Animated.Value;
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

  // 拖动位移叠加入场位移。dragX 只有顶层才有，底层页面是纯让位。
  const finalX = dragX
    ? Animated.add(Animated.add(translateX, coverShift), dragX)
    : Animated.add(translateX, coverShift);

  return (
    <Animated.View
      style={[
        styles.screen,
        {
          opacity,
          transform: [{ translateX: finalX }],
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

  // Android 返回键：根页面时返回 false，让系统处理（退到后台而不是卡死）
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

  // ── 边缘手势 ──────────────────────────────────────────────────
  const canGoBack = stack.length > 1;
  const canGoBackRef = useRef(canGoBack);
  canGoBackRef.current = canGoBack;

  /** 手势位移，0 = 就位，正值 = 被往右拖 */
  const dragX = useRef(new Animated.Value(0)).current;
  /** 这一下是否已判定为返回手势（避免中途变成滚动又变回来） */
  const committed = useRef(false);

  const popRef = useRef(pop);
  popRef.current = pop;

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 只在左缘起手时才愿意接管
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (evt, g) => {
          const startX = evt.nativeEvent.pageX - g.dx;
          return isBackGesture(startX, g.dx, g.dy, canGoBackRef.current);
        },
        onPanResponderGrant: () => {
          committed.current = true;
        },
        onPanResponderMove: (_evt, g) => {
          if (!committed.current) return;
          // 只往右拖，往左不动（避免页面往左飞出屏幕）
          dragX.setValue(Math.max(0, g.dx));
        },
        onPanResponderRelease: (_evt, g) => {
          if (!committed.current) return;
          committed.current = false;
          if (shouldDismiss(g.dx, g.vx, SCREEN_WIDTH)) {
            // 先动画到位，再真正出栈，避免闪一下
            Animated.timing(dragX, {
              toValue: SCREEN_WIDTH,
              duration: 180,
              useNativeDriver: true,
            }).start(() => {
              dragX.setValue(0);
              popRef.current();
            });
          } else {
            Animated.spring(dragX, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 0,
              speed: 20,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          committed.current = false;
          Animated.spring(dragX, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
            speed: 20,
          }).start();
        },
      }),
    [dragX],
  );

  const value = useMemo<NavContextValue>(
    () => ({
      stack,
      push,
      pop,
      reset,
      canGoBack,
    }),
    [stack, push, pop, reset, canGoBack],
  );

  const topIndex = stack.length - 1;

  return (
    <NavContext.Provider value={value}>
      <View style={styles.root} {...pan.panHandlers}>
        {stack.map((screen, i) => {
          const isTop = i === topIndex;
          return (
            <ScreenPane
              key={`${i}-${screen.name}`}
              active={isTop}
              covered={!isTop}
              dragX={isTop && canGoBack ? dragX : undefined}
            >
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
  fill: { ...StyleSheet.absoluteFillObject },
  screen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
});
