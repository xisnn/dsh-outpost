/** Shared full-screen viewer for chat attachments and delivered images. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, Image, PanResponder, StyleSheet, Text, View } from 'react-native';
import { MotionModal as Modal } from './MotionModal';
import { MotionPressable as Pressable } from './MotionPressable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { saveImageToGallery } from '../core/fileSave';
import { useMotionPreference } from '../design/motion';
import { clampImage, pinchImage, MAX_SCALE, DOUBLE_TAP_SCALE, DISMISS_DISTANCE, type ImageSize, type ImageTransform } from '../core/imageViewport';

export interface ViewerImage {
  uri?: string;
  caption?: string;
  failed?: boolean;
  onRetry?: () => void;
  onError?: () => void;
  save?: { fsPath: string; name: string };
}
type Touch = { pageX: number; pageY: number };
const neutral = (): ImageTransform => ({ scale: 1, x: 0, y: 0 });
const midpoint = (a: Touch, b: Touch) => ({ x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 });
const spacing = (a: Touch, b: Touch) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

export function ImageViewer({ visible, images, initialIndex = 0, onClose, onLongPress }: {
  visible: boolean; images: ViewerImage[]; initialIndex?: number; onClose: () => void;
  onLongPress?: (image: ViewerImage) => void;
}) {
  const insets = useSafeAreaInsets();
  const reduced = useMotionPreference();
  const [index, setIndex] = useState(initialIndex);
  const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 });
  const [bitmap, setBitmap] = useState<{ uri: string; width: number; height: number }>();
  const [broken, setBroken] = useState<string>();
  const [zoomed, setZoomed] = useState(false);
  const current = images[index];
  const stage = useRef<View>(null);
  const stageOrigin = useRef({ x: 0, y: 0 });
  const scale = useRef(new Animated.Value(1)).current;
  const pan = useRef(new Animated.ValueXY()).current;
  const transform = useRef(neutral());
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const lastTap = useRef(0);
  const gesture = useRef<{
    base: ImageTransform; origin: Touch; hadPinch: boolean; mode: 'drag' | 'pinch';
    distance: number; middle: { x: number; y: number };
  } | null>(null);
  const latest = useRef({ visible, current, images, index, reduced, viewport, bitmap, onClose, onLongPress });
  latest.current = { visible, current, images, index, reduced, viewport, bitmap, onClose, onLongPress };
  const mounted = useRef(true);
  const fittedImage = useCallback((): ImageSize => {
    const live = latest.current;
    return live.bitmap && live.bitmap.uri === live.current?.uri ? live.bitmap : live.viewport;
  }, []);
  const stop = useCallback(() => { animation.current?.stop(); animation.current = null; }, []);
  const apply = useCallback((next: ImageTransform, animate = false) => {
    stop();
    transform.current = next;
    setZoomed(next.scale > 1.02);
    if (!animate || latest.current.reduced) {
      scale.setValue(next.scale); pan.setValue({ x: next.x, y: next.y });
      return;
    }
    const running = Animated.parallel([
      Animated.spring(scale, { toValue: next.scale, useNativeDriver: true, bounciness: 0, speed: 20 }),
      Animated.spring(pan, { toValue: { x: next.x, y: next.y }, useNativeDriver: true, bounciness: 0, speed: 20 }),
    ]);
    animation.current = running; running.start();
  }, [pan, scale, stop]);
  const bounded = useCallback((value: ImageTransform) => clampImage(latest.current.viewport, fittedImage(), value), [fittedImage]);
  const goTo = useCallback((next: number) => {
    const live = latest.current;
    if (!live.visible || next < 0 || next >= live.images.length) return false;
    gesture.current = null; lastTap.current = 0; setIndex(next); apply(neutral());
    return true;
  }, [apply]);

  useEffect(() => {
    if (visible) setIndex(Math.min(Math.max(0, initialIndex), Math.max(0, latest.current.images.length - 1)));
  }, [visible, initialIndex]);
  useEffect(() => { setIndex(value => Math.min(value, Math.max(0, images.length - 1))); }, [images.length]);
  useEffect(() => {
    gesture.current = null; lastTap.current = 0; setBroken(undefined); apply(neutral());
    return stop;
  }, [visible, current?.uri, viewport.width, viewport.height, apply, stop]);
  useEffect(() => { if (reduced) apply(bounded(transform.current)); }, [reduced, apply, bounded]);
  useEffect(() => { if (bitmap && bitmap.uri === current?.uri) apply(bounded(transform.current)); }, [bitmap, current?.uri, apply, bounded]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; gesture.current = null; stop(); }; }, [stop]);

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: event => event.nativeEvent.touches.length >= 2,
    onMoveShouldSetPanResponderCapture: (event, g) => event.nativeEvent.touches.length >= 2 || Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8,
    onPanResponderGrant: event => {
      if (!latest.current.visible) return;
      stop(); lastTap.current = 0;
      const touches = event.nativeEvent.touches;
      const first = touches[0]; if (!first) return;
      gesture.current = { base: { ...transform.current }, origin: first, hadPinch: touches.length >= 2,
        mode: touches.length >= 2 ? 'pinch' : 'drag', distance: touches.length >= 2 ? spacing(first, touches[1]) : 1,
        middle: touches.length >= 2 ? midpoint(first, touches[1]) : { x: first.pageX, y: first.pageY } };
    },
    onPanResponderMove: event => {
      if (!latest.current.visible) return;
      const touches = event.nativeEvent.touches, first = touches[0], active = gesture.current;
      if (!first || !active) return;
      if (touches.length >= 2) {
        const middle = midpoint(first, touches[1]);
        if (active.mode !== 'pinch') {
          active.mode = 'pinch'; active.hadPinch = true; active.base = { ...transform.current };
          active.distance = spacing(first, touches[1]); active.middle = middle;
        }
        const frame = latest.current.viewport;
        const next = pinchImage(active.base, active.distance, spacing(first, touches[1]),
          { x: active.middle.x - stageOrigin.current.x - frame.width / 2, y: active.middle.y - stageOrigin.current.y - frame.height / 2 },
          { x: middle.x - active.middle.x, y: middle.y - active.middle.y });
        apply(bounded(next));
      } else {
        if (active.mode === 'pinch') { active.mode = 'drag'; active.base = { ...transform.current }; active.origin = first; }
        const next = { ...active.base, x: active.base.x + first.pageX - active.origin.pageX, y: active.base.y + first.pageY - active.origin.pageY };
        apply(next.scale > 1.02 ? bounded(next) : next);
      }
    },
    onPanResponderRelease: (_event, g) => {
      const active = gesture.current; gesture.current = null;
      if (!active || !latest.current.visible) return;
      if (active.hadPinch || active.base.scale > 1.02 || transform.current.scale > 1.02) { apply(bounded(transform.current), true); return; }
      if (g.dy > Math.min(DISMISS_DISTANCE, latest.current.viewport.height * 0.25) && g.dy > Math.abs(g.dx)) { latest.current.onClose(); return; }
      if (Math.abs(g.dx) > latest.current.viewport.width * 0.25 && Math.abs(g.dx) > Math.abs(g.dy)) {
        if (goTo(latest.current.index + (g.dx < 0 ? 1 : -1))) return;
      }
      apply(neutral(), true);
    },
    onPanResponderTerminate: () => { gesture.current = null; apply(bounded(transform.current), true); },
  }), [apply, bounded, goTo, stop]);

  const handleLongPress = useCallback((img: ViewerImage) => {
    if (latest.current.onLongPress) { latest.current.onLongPress(img); return; }
    if (!img.save) return;
    void (async () => {
      try {
        const outcome = await saveImageToGallery(img.save!.fsPath, img.save!.name);
        if (!mounted.current || !latest.current.visible) return;
        Alert.alert(outcome.ok ? '已保存' : '保存失败', outcome.ok ? `图片已存到${outcome.where}，去相册里看看。` : outcome.reason, [{ text: '好' }]);
      } catch { if (mounted.current && latest.current.visible) Alert.alert('保存失败', '暂时无法保存图片，请稍后重试。'); }
    })();
  }, []);
  const toggleZoom = useCallback(() => {
    if (!latest.current.visible) return;
    const next = transform.current.scale > 1.02 ? neutral() : { scale: Math.min(MAX_SCALE, DOUBLE_TAP_SCALE), x: 0, y: 0 };
    apply(bounded(next), true);
  }, [apply, bounded]);
  const onTap = useCallback(() => {
    const now = Date.now();
    if (lastTap.current && now - lastTap.current < 300) { lastTap.current = 0; toggleZoom(); }
    else lastTap.current = now;
  }, [toggleZoom]);
  if (!current) return null;
  const failed = current.failed || (!!current.uri && broken === current.uri);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent
      supportedOrientations={['portrait', 'landscape', 'portrait-upside-down', 'landscape-left', 'landscape-right']}>
      <View style={styles.root}>
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Text style={styles.counter}>{`${index + 1} / ${images.length}`}</Text>
          <Pressable onPress={toggleZoom} disabled={!current.uri || failed} accessibilityRole="button" accessibilityLabel={zoomed ? '还原图片' : '放大图片'} style={styles.control}>
            <Text style={styles.controlText}>{zoomed ? '还原' : '放大'}</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={12} style={styles.control} accessibilityRole="button" accessibilityLabel="关闭图片">
            <Text style={styles.controlText}>✕</Text>
          </Pressable>
        </View>
        <View ref={stage} style={styles.stage} {...responder.panHandlers} onLayout={event => {
          const { width, height } = event.nativeEvent.layout;
          setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height });
          stage.current?.measureInWindow((x, y) => { if (mounted.current) stageOrigin.current = { x, y }; });
        }}>
          {failed ? <View style={styles.placeholder}>
            <Text style={styles.hint}>图片加载失败</Text>
            {current.onRetry ? <Pressable onPress={() => { setBroken(undefined); current.onRetry?.(); }} accessibilityRole="button" accessibilityLabel="重试加载图片" style={styles.control}>
              <Text style={styles.controlText}>点击重试</Text>
            </Pressable> : null}
          </View> : !current.uri || viewport.width <= 0 || viewport.height <= 0 ? <ActivityIndicator color="#fff" accessibilityLabel="正在加载图片" /> : (
            <Animated.View style={{ width: viewport.width, height: viewport.height, transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale }] }}>
              <Pressable onPress={onTap} onLongPress={() => handleLongPress(current)} style={styles.imageTouch} accessibilityRole="imagebutton" accessibilityLabel={current.caption || '图片，双击放大'}>
                <Image key={current.uri} source={{ uri: current.uri }} style={{ width: viewport.width, height: viewport.height }} resizeMode="contain"
                  onLoad={event => { const source = event.nativeEvent.source; if (mounted.current && latest.current.visible && latest.current.current?.uri === current.uri && source.width > 0 && source.height > 0) setBitmap({ uri: current.uri!, width: source.width, height: source.height }); }}
                  onError={() => { if (mounted.current && latest.current.visible && latest.current.current?.uri === current.uri) { setBroken(current.uri); latest.current.current.onError?.(); } }} />
              </Pressable>
            </Animated.View>
          )}
        </View>
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          {current.caption ? <Text style={styles.caption} numberOfLines={2}>{current.caption}</Text> : null}
          {images.length > 1 ? <View style={styles.navigation}>
            <Pressable onPress={() => goTo(index - 1)} disabled={index === 0} accessibilityRole="button" accessibilityLabel="上一张图片" style={[styles.control, index === 0 && styles.disabled]}><Text style={styles.controlText}>上一张</Text></Pressable>
            <Pressable onPress={() => goTo(index + 1)} disabled={index === images.length - 1} accessibilityRole="button" accessibilityLabel="下一张图片" style={[styles.control, index === images.length - 1 && styles.disabled]}><Text style={styles.controlText}>下一张</Text></Pressable>
          </View> : null}
        </View>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingBottom: 8, backgroundColor: '#000', zIndex: 2, gap: 12 },
  counter: { flex: 1, color: 'rgba(255,255,255,0.85)', fontSize: 14 },
  control: { minWidth: 44, minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', borderRadius: 22, backgroundColor: '#242424' },
  controlText: { color: '#fff', fontSize: 14 }, disabled: { opacity: 0.35 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' }, imageTouch: { flex: 1 },
  placeholder: { alignItems: 'center', gap: 16 }, hint: { color: '#fff', fontSize: 14 },
  bottom: { backgroundColor: '#000', zIndex: 2, paddingHorizontal: 18, paddingTop: 8, gap: 10 },
  navigation: { flexDirection: 'row', justifyContent: 'space-between' },
  caption: { color: 'rgba(255,255,255,0.8)', fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
