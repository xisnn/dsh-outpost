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
import { MOTION, useMotionPreference } from '../design/motion';
import { useTheme } from '../design/theme';
import { navigationColumns } from '../core/adaptiveNavigation';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  Animated,
  BackHandler,
  Dimensions,
  Keyboard,
  PanResponder,
  useWindowDimensions,
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
  popToRoot: () => void;
  reset: (name: string, params?: Record<string, unknown>) => void;
  canGoBack: boolean;
  column?: 'master' | 'detail';
  selectedSessionId?: string;
}

const NavContext = createContext<NavContextValue | null>(null);

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used inside NavHost');
  return ctx;
}

interface NavHostProps {
  initial: Screen;
  render: (screen: Screen, active: boolean) => React.ReactNode;
  /** Normal Home contains the workspace list; the butler root contains a chat. */
  rootIsList?: boolean;
}

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
  /** 当前窗口宽度（旋转 / 分屏时动态变化） */
  width,
  /** 手势拖动位移（只对顶层页面生效） */
  dragX,
  animateEnter,
  motionEpoch,
  reduceMotion,
  layoutStyle,
  testID,
  children,
}: {
  active: boolean;
  covered: boolean;
  width: number;
  dragX?: Animated.Value;
  animateEnter: boolean;
  motionEpoch: number;
  reduceMotion: boolean;
  layoutStyle?: StyleProp<ViewStyle>;
  testID?: string;
  children: React.ReactNode;
}) {
  // 根页面原地显示；新 push 的页面在第一次挂载时就处于入场起点。
  const enter = useRef(new Animated.Value(animateEnter && !reduceMotion ? 0 : 1)).current;
  const pendingEnter = useRef(animateEnter);

  useEffect(() => {
    enter.stopAnimation();
    if (!pendingEnter.current || reduceMotion || !active) {
      pendingEnter.current = false;
      enter.setValue(1);
      return;
    }
    pendingEnter.current = false;
    const animation = Animated.timing(enter, {
      toValue: 1,
      duration: MOTION.navigation,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [active, enter, motionEpoch, reduceMotion]);

  const translateX = enter.interpolate({
    inputRange: [0, 1],
    outputRange: [Math.min(width * 0.06, 24), 0],
  });
  const opacity = enter.interpolate({
    inputRange: [0, 1],
    outputRange: [0.94, 1],
  });

  // 被覆盖时露出一点边缘，暗示下面还有页面
  const coverShift = covered && !reduceMotion ? -width * 0.08 : 0;

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
        layoutStyle,
      ]}
      testID={testID}
      pointerEvents={active ? 'auto' : 'none'}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      {children}
    </Animated.View>
  );
}

interface NavEntry {
  screen: Screen;
  key: number;
  animateEnter: boolean;
}

export function NavHost({ initial, render, rootIsList = false }: NavHostProps) {
  const tv = useTheme();
  const [entries, setEntries] = useState<NavEntry[]>([
    { screen: initial, key: 0, animateEnter: false },
  ]);
  const entriesRef = useRef(entries);
  const nextKey = useRef(1);
  const [motionEpoch, setMotionEpoch] = useState(0);
  const reduceMotion = useMotionPreference();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  // 窗口宽度动态获取：旋转、分屏时手势比例跟随当前宽度。
  const { width, height, fontScale } = useWindowDimensions();
  const unobscured = useRef({width, height});
  const [ime, setIme] = useState<{width: number; height: number; fullHeight: number} | null>(null);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      // Read the native window at the event, after adjustResize. Subsequent
      // height changes are real window resizing, not another IME subtraction.
      const window = Dimensions.get('window');
      setIme({width: window.width, height: window.height,
        fullHeight: unobscured.current.width === window.width ? unobscured.current.height : window.height});
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setIme(null));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const imeVisible = ime !== null || Keyboard.isVisible();
  if (!imeVisible) unobscured.current = {width, height};
  const availableHeight = ime && ime.width === width
    ? Math.max(height, ime.fullHeight + height - ime.height)
    : imeVisible && unobscured.current.width === width ? Math.max(height, unobscured.current.height) : height;
  const columns = navigationColumns(entries.map(entry => entry.screen), width,
    availableHeight, rootIsList, fontScale);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const paneWidth = columns?.detailWidth ?? width;
  const widthRef = useRef(paneWidth);
  widthRef.current = paneWidth;
  const dragX = useRef(new Animated.Value(0)).current;
  const committed = useRef(false);
  const pendingPop = useRef<number | null>(null);
  const motionToken = useRef(0);

  const updateEntries = useCallback((next: NavEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  // 新导航先兑现已经请求的 pop，再取消旧动画。旧回调不能操作新栈顶。
  const interrupt = useCallback(() => {
    motionToken.current += 1;
    const target = pendingPop.current;
    pendingPop.current = null;
    dragX.stopAnimation();
    committed.current = false;
    dragX.setValue(0);
    const current = entriesRef.current;
    if (target !== null && current.length > 1 && current[current.length - 1].key === target) {
      updateEntries(current.slice(0, -1));
    }
  }, [dragX, updateEntries]);

  const push = useCallback((name: string, params?: Record<string, unknown>) => {
    interrupt();
    setMotionEpoch((epoch) => epoch + 1);
    const current = entriesRef.current;
    if (name === 'Chat' && columnsRef.current && typeof params?.sessionId === 'string') {
      const identity = (value?: Record<string, unknown>) => JSON.stringify([
        value?.sessionId, value?.address ?? null, !!value?.butler, !!value?.readOnly,
      ]);
      const target = identity(params);
      for (let i = current.length - 1; i > columnsRef.current.masterIndex; i--) {
        if (current[i].screen.name === 'Chat' && identity(current[i].screen.params) === target) {
          // Select the existing instance. A second owner would close the same
          // Store stream when it later unmounts.
          updateEntries(current.slice(0, i + 1));
          return;
        }
      }
    }
    updateEntries([...current, {
      screen: { name, params }, key: nextKey.current++, animateEnter: true,
    }]);
  }, [interrupt, updateEntries]);

  const pop = useCallback(() => {
    interrupt();
    const current = entriesRef.current;
    if (current.length <= 1) return;
    setMotionEpoch((epoch) => epoch + 1);
    if (reduceMotionRef.current) {
      updateEntries(current.slice(0, -1));
      return;
    }
    pendingPop.current = current[current.length - 1].key;
    const token = motionToken.current;
    Animated.timing(dragX, {
      toValue: widthRef.current,
      duration: MOTION.navigation,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && token === motionToken.current) interrupt();
    });
  }, [dragX, interrupt, updateEntries]);

  const popToRoot = useCallback(() => {
    interrupt();
    const current = entriesRef.current;
    if (current.length <= 1) return;
    setMotionEpoch((epoch) => epoch + 1);
    // Preserve the mounted root, its draft, and its reading position.
    updateEntries(current.slice(0, 1));
  }, [interrupt, updateEntries]);

  const reset = useCallback((name: string, params?: Record<string, unknown>) => {
    interrupt();
    setMotionEpoch((epoch) => epoch + 1);
    updateEntries([{ screen: { name, params }, key: nextKey.current++, animateEnter: false }]);
  }, [interrupt, updateEntries]);

  // Android 返回键同步读取当前栈；不依赖 React updater 何时执行。
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (entriesRef.current.length <= 1) return false;
      pop();
      return true;
    });
    return () => sub.remove();
  }, [pop]);

  useEffect(() => {
    interrupt();
  }, [width, paneWidth, columns?.masterIndex, reduceMotion, interrupt]);

  useEffect(() => () => {
    motionToken.current += 1;
    pendingPop.current = null;
    committed.current = false;
    dragX.stopAnimation();
  }, [dragX]);

  const settleDrag = useCallback(() => {
    dragX.stopAnimation();
    if (reduceMotionRef.current) {
      dragX.setValue(0);
      return;
    }
    Animated.spring(dragX, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 20,
    }).start();
  }, [dragX]);

  const dismissDrag = useCallback(() => {
    const current = entriesRef.current;
    if (current.length <= 1) {
      settleDrag();
      return;
    }
    setMotionEpoch((epoch) => epoch + 1);
    pendingPop.current = current[current.length - 1].key;
    if (reduceMotionRef.current) {
      interrupt();
      return;
    }
    const token = motionToken.current;
    Animated.timing(dragX, {
      toValue: widthRef.current,
      duration: MOTION.exit,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && token === motionToken.current) interrupt();
    });
  }, [dragX, interrupt, settleDrag]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // 只在左缘起手时才愿意接管
        onStartShouldSetPanResponder: () => false,

        // ⚠️ 必须用 Capture 版本，否则手势永远不生效。
        //
        // 页面里全是 ScrollView / FlatList。RN 的响应者系统里，
        // 子级（ScrollView）会先一步抢到 move 事件，父级的
        // onMoveShouldSetPanResponder 根本没机会被调用 ——
        // 表现就是「在真机上怎么划都没反应」。
        //
        // Capture 阶段是父级先挑，只在「左缘 + 横向为主」时才接，
        // 所以不会误抢列表的纵向滚动。
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponderCapture: (evt, g) => {
          const startX = evt.nativeEvent.pageX - g.dx;
          return !columnsRef.current && isBackGesture(startX, g.dx, g.dy, entriesRef.current.length > 1);
        },

        // 非 Capture 的也留着：万一 Capture 没被调用（某些 RN 版本/嵌套
        // 场景），还能退回到冒泡阶段兜底。
        onMoveShouldSetPanResponder: (evt, g) => {
          const startX = evt.nativeEvent.pageX - g.dx;
          return !columnsRef.current && isBackGesture(startX, g.dx, g.dy, entriesRef.current.length > 1);
        },

        // 一旦我们接管了，就别再让子级抢回去（否则滑到一半会断）
        onPanResponderTerminationRequest: () => false,

        onPanResponderGrant: () => {
          interrupt();
          setMotionEpoch((epoch) => epoch + 1);
          committed.current = !columnsRef.current && entriesRef.current.length > 1;
        },
        onPanResponderMove: (_evt, g) => {
          if (!committed.current) return;
          // 只往右拖，往左不动（避免页面往左飞出屏幕）
          dragX.setValue(Math.max(0, g.dx));
        },
        onPanResponderRelease: (_evt, g) => {
          if (!committed.current) return;
          committed.current = false;
          if (shouldDismiss(g.dx, g.vx, widthRef.current)) {
            dismissDrag();
          } else {
            settleDrag();
          }
        },
        onPanResponderTerminate: () => {
          if (!committed.current) return;
          committed.current = false;
          settleDrag();
        },
      }),
    [dragX, interrupt, dismissDrag, settleDrag],
  );

  const stack = useMemo(() => entries.map((entry) => entry.screen), [entries]);
  const canGoBack = stack.length > 1;
  const topScreen = stack[stack.length - 1];
  const selectedSessionId = topScreen?.name === 'Chat' && typeof topScreen.params?.sessionId === 'string'
    ? topScreen.params.sessionId : undefined;
  const value = useMemo<NavContextValue>(
    () => ({
      stack,
      push,
      pop,
      popToRoot,
      reset,
      canGoBack,
      selectedSessionId,
    }),
    [stack, push, pop, popToRoot, reset, canGoBack, selectedSessionId],
  );

  const popList = (key: number) => {
    const index = columnsRef.current?.masterIndex;
    if (index === undefined || index < 1 || entriesRef.current[index]?.key !== key) return;
    interrupt();
    setMotionEpoch(epoch => epoch + 1);
    updateEntries(entriesRef.current.slice(0, index));
  };
  const topIndex = stack.length - 1;

  return (
    <NavContext.Provider value={value}>
      <View style={styles.root} {...pan.panHandlers}>
        {entries.map((entry, i) => {
          const isTop = i === topIndex;
          const isMaster = columns?.masterIndex === i;
          const visible = isTop || isMaster;
          // Retain the same parent and entry keys at every size. Hidden chats
          // stay mounted, but only the current Chat receives active=true.
          const layoutStyle: StyleProp<ViewStyle> = columns
            ? isMaster
              ? {left: 0, right: columns.detailWidth, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: tv.colors.border}
              : isTop ? {left: columns.masterWidth, right: 0} : {display: 'none'}
            : undefined;
          return (
            <ScreenPane
              key={entry.key}
              active={visible}
              covered={!isTop && !columns}
              width={isMaster && columns ? columns.masterWidth : paneWidth}
              layoutStyle={layoutStyle}
              testID={columns && visible ? (isMaster ? 'navigation-master' : 'navigation-detail') : undefined}
              dragX={isTop && canGoBack ? dragX : undefined}
              animateEnter={entry.animateEnter}
              motionEpoch={motionEpoch}
              reduceMotion={reduceMotion}
            >
              <NavContext.Provider value={{...value, column: isMaster ? 'master' : columns && isTop ? 'detail' : undefined,
                ...(isMaster ? {canGoBack: i > 0, pop: () => popList(entry.key)} : {})}}>
                {render(entry.screen, visible)}
              </NavContext.Provider>
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
