import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Dimensions, Keyboard, Platform } from 'react-native';
import type { FlatList } from 'react-native';
import { useMotionPreference } from '../design/motion';
import {
  NEAR_BOTTOM_PX, classifyListChange, distanceFromBottom, shouldMarkNewContent,
  shouldShowJumpToBottom, tailOf, type ListTail, type ScrollItemLike,
} from '../core/scrollFollow';

/** Keep following an active conversation until the user deliberately reads history. */
export function useChatScroll<T extends ScrollItemLike>(items: readonly T[], sessionKey: string, visible: boolean) {
  const scrollRef = useRef<FlatList<T>>(null);
  const reduced = useMotionPreference();
  const latest = useRef({ reduced, visible, sessionKey });
  latest.current = { reduced, visible, sessionKey };
  const alive = useRef(false);
  const foreground = useRef(AppState.currentState === 'active');
  const following = useRef(true);
  const dragging = useRef(false);
  const userGesture = useRef(false);
  const momentum = useRef(false);
  const distance = useRef(0);
  const away = useRef(false);
  const newContent = useRef(false);
  const tail = useRef<ListTail | null>(null);
  const followGeneration = useRef(0);
  const followTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const anchorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [anchorReady, setAnchorReady] = useState(false);
  const [kbHeight, setKbHeight] = useState(0);

  const cancelFollow = useCallback(() => {
    followGeneration.current += 1;
    if (followTimer.current !== undefined) clearTimeout(followTimer.current);
    followTimer.current = undefined;
  }, []);
  const canScroll = useCallback(() => alive.current && foreground.current && latest.current.visible && latest.current.sessionKey === sessionKey, [sessionKey]);
  const scrollToBottom = useCallback((animated: boolean) => {
    if (!canScroll() || !following.current || dragging.current || momentum.current) return;
    userGesture.current = false;
    scrollRef.current?.scrollToEnd({ animated: animated && !latest.current.reduced });
  }, [canScroll]);
  const scheduleFollow = useCallback((ms: number) => {
    cancelFollow();
    if (!canScroll() || !following.current) return;
    const generation = followGeneration.current;
    followTimer.current = setTimeout(() => {
      if (generation !== followGeneration.current) return;
      followTimer.current = undefined;
      scrollToBottom(true);
    }, ms);
  }, [cancelFollow, canScroll, scrollToBottom]);

  useEffect(() => {
    alive.current = true;
    following.current = true;
    dragging.current = momentum.current = userGesture.current = false;
    distance.current = 0;
    away.current = newContent.current = false;
    tail.current = null;
    setAwayFromBottom(false);
    setHasNewContent(false);
    setAnchorReady(false);
    setKbHeight(0);
    return () => {
      alive.current = false;
      cancelFollow();
      if (anchorTimer.current !== undefined) clearTimeout(anchorTimer.current);
      anchorTimer.current = undefined;
    };
  }, [sessionKey, cancelFollow]);

  useEffect(() => {
    if (!visible) { cancelFollow(); dragging.current = momentum.current = userGesture.current = false; return; }
    let listening = true;
    foreground.current = AppState.currentState === 'active';
    setKbHeight(Keyboard.metrics?.()?.height ?? 0);
    scheduleFollow(60);
    const state = AppState.addEventListener('change', value => {
      if (!listening) return;
      foreground.current = value === 'active';
      cancelFollow();
      if (!foreground.current) dragging.current = momentum.current = userGesture.current = false;
      else { setKbHeight(Keyboard.metrics?.()?.height ?? 0); scheduleFollow(60); }
    });
    const show = Keyboard.addListener('keyboardDidShow', event => {
      if (!listening || !canScroll()) return;
      setKbHeight(event.endCoordinates?.height ?? 0);
      scheduleFollow(120);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      if (!listening || !canScroll()) return;
      setKbHeight(0);
      scheduleFollow(60);
    });
    let screen = Dimensions.get('screen');
    let windowWidth = Dimensions.get('window').width;
    const dimensions = Platform.OS === 'android' ? Dimensions.addEventListener('change', next => {
      const resized = next.screen.width !== screen.width || next.screen.height !== screen.height || next.window.width !== windowWidth;
      screen = next.screen;
      windowWidth = next.window.width;
      // Android RN only emits IME coordinates when visibility changes. Resizing an
      // already open IME leaves KeyboardAvoidingView using the old screenY.
      // Dismiss on display/width changes; ordinary keyboard height changes are excluded.
      if (resized && listening && canScroll() && Keyboard.isVisible()) Keyboard.dismiss();
    }) : undefined;
    return () => { listening = false; cancelFollow(); dragging.current = momentum.current = userGesture.current = false; state.remove(); show.remove(); hide.remove(); dimensions?.remove(); };
  }, [visible, cancelFollow, canScroll, scheduleFollow]);

  useEffect(() => {
    const next = tailOf(items);
    const change = classifyListChange(tail.current, next);
    tail.current = next;
    if (shouldMarkNewContent(change, distance.current) && !following.current && !newContent.current) {
      newContent.current = true;
      setHasNewContent(true);
    }
    if (change !== 'prepended') scheduleFollow(60);
  }, [items, scheduleFollow]);

  const applyScrollMetrics = useCallback((metrics: { contentHeight: number; offsetY: number; viewportHeight: number }) => {
    const next = distanceFromBottom(metrics);
    distance.current = next;
    // Keyboard/viewport resize and programmatic scrolling must not change reading intent.
    if (dragging.current || momentum.current) following.current = next < NEAR_BOTTOM_PX;
    const nextAway = shouldShowJumpToBottom(next, away.current);
    if (nextAway !== away.current) { away.current = nextAway; setAwayFromBottom(nextAway); }
    if (next < NEAR_BOTTOM_PX && newContent.current) { newContent.current = false; setHasNewContent(false); }
  }, []);
  const beginDrag = useCallback(() => {
    cancelFollow();
    dragging.current = userGesture.current = true;
    following.current = false;
  }, [cancelFollow]);
  const endDrag = useCallback(() => { dragging.current = false; }, []);
  const beginMomentum = useCallback(() => {
    if (!userGesture.current) return;
    momentum.current = true;
    cancelFollow();
  }, [cancelFollow]);
  const endMomentum = useCallback(() => { momentum.current = userGesture.current = false; }, []);
  const jumpToBottom = useCallback(() => {
    if (!canScroll()) return;
    cancelFollow();
    dragging.current = momentum.current = userGesture.current = false;
    following.current = true;
    distance.current = 0;
    away.current = newContent.current = false;
    setAwayFromBottom(false);
    setHasNewContent(false);
    scrollToBottom(true);
  }, [canScroll, cancelFollow, scrollToBottom]);
  const contentSizeChanged = useCallback(() => {
    scrollToBottom(false);
    if (!anchorReady && items.length > 0 && canScroll() && anchorTimer.current === undefined) {
      // Enable anchoring after the first bottom request has had a layout frame to settle.
      anchorTimer.current = setTimeout(() => {
        anchorTimer.current = undefined;
        if (canScroll()) setAnchorReady(true);
      }, 80);
    }
  }, [anchorReady, items.length, canScroll, scrollToBottom]);
  const viewportChanged = useCallback(() => scheduleFollow(60), [scheduleFollow]);

  return { scrollRef, awayFromBottom, hasNewContent, anchorReady, kbHeight, jumpToBottom,
    applyScrollMetrics, beginDrag, endDrag, beginMomentum, endMomentum, contentSizeChanged, viewportChanged };
}
