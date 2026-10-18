/**
 * 扫码配对面板。
 *
 * 扫电脑终端里那行 URL 的二维码（DSH 启动脚本会打印），
 * 扫到后交给调用方解析、填表并直接连接。
 *
 * 视觉照微信扫码：整屏压暗、中间挖一个方框、白色四角、一条来回扫的线。
 * 相机用 camera-kit 的 Camera 组件，自带的取景框关掉（showFrame={false}）。
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Linking,
  Easing,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Camera } from 'react-native-camera-kit';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../design/theme';

const ACCENT = '#5AC8FA';

export function ScanSheet({
  visible,
  onClose,
  onScanned,
}: {
  visible: boolean;
  onClose: () => void;
  /** 拿到二维码文本（调用方负责解析/连接） */
  onScanned: (text: string) => void;
}) {
  const tv = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);
  const [state, setState] = useState<'asking' | 'ready' | 'denied'>('asking');
  const handled = useRef(false);
  const sweep = useRef(new Animated.Value(0)).current;

  // 取景框：屏宽的 68%，最多 300
  const frame = Math.min(width * 0.68, 300);
  const frameTop = Math.max((height - frame) / 2 - insets.top - 40, insets.top + 90);
  const frameLeft = (width - frame) / 2;

  useEffect(() => {
    if (!visible) {
      setState('asking');
      handled.current = false;
      return;
    }
    let live = true;
    void (async () => {
      try {
        if (Platform.OS === 'android') {
          const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
          if (!live) return;
          setState(res === PermissionsAndroid.RESULTS.GRANTED ? 'ready' : 'denied');
        } else {
          setState('ready');
        }
      } catch {
        if (live) setState('denied');
      }
    })();
    return () => {
      live = false;
    };
  }, [visible]);

  // 扫描线：来回扫
  useEffect(() => {
    if (state !== 'ready') return;
    sweep.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: 1900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(sweep, {
          toValue: 0,
          duration: 1900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, sweep]);

  const translateY = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [6, frame - 12],
  });

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {state === 'ready' ? (
          <Camera
            style={StyleSheet.absoluteFill}
            scanBarcode
            showFrame={false}
            allowedBarcodeTypes={['qr']}
            onReadCode={(e) => {
              if (handled.current) return;
              handled.current = true;
              onScanned(e.nativeEvent.codeStringValue);
            }}
            onError={() => setState('denied')}
          />
        ) : null}

        {/* 四块暗色遮罩，围出中间的取景框 */}
        {state === 'ready' ? (
          <>
            <View style={[styles.dim, { left: 0, right: 0, top: 0, height: frameTop }]} />
            <View style={[styles.dim, { left: 0, right: 0, top: frameTop + frame, bottom: 0 }]} />
            <View style={[styles.dim, { left: 0, top: frameTop, width: frameLeft, height: frame }]} />
            <View
              style={[styles.dim, { left: frameLeft + frame, right: 0, top: frameTop, height: frame }]}
            />

            {/* 白色四角 */}
            <View style={[styles.corner, styles.cornerTL, { left: frameLeft, top: frameTop }]} />
            <View style={[styles.corner, styles.cornerTR, { left: frameLeft + frame - 26, top: frameTop }]} />
            <View style={[styles.corner, styles.cornerBL, { left: frameLeft, top: frameTop + frame - 26 }]} />
            <View
              style={[styles.corner, styles.cornerBR, { left: frameLeft + frame - 26, top: frameTop + frame - 26 }]}
            />

            {/* 扫描线 */}
            <Animated.View
              style={[
                styles.scanLine,
                { left: frameLeft + 10, width: frame - 20, top: frameTop, transform: [{ translateY }] },
              ]}
            />

            <Text style={[styles.frameHint, { top: frameTop + frame + 18 }]}>
              将电脑上的二维码放入框内，即可自动扫描
            </Text>
          </>
        ) : null}

        {/* 顶部标题 */}
        <View style={[styles.top, { paddingTop: insets.top + 14 }]}>
          <Text style={styles.title}>扫描二维码</Text>
          <Text style={styles.subtitle}>配对 DSH · 扫一次 30 天免登录</Text>
        </View>

        {state !== 'ready' ? (
          <View style={styles.center}>
            {state === 'asking' ? (
              <>
                <ActivityIndicator color="#fff" />
                <Text style={styles.centerText}>正在请求相机权限…</Text>
              </>
            ) : (
              <>
                <Text style={styles.centerTitle}>相机不可用</Text>
                <Text style={styles.centerText}>
                  没有相机权限，或相机启动失败。{'\n'}可以返回手动粘贴链接，或去系统设置里打开权限。
                </Text>
                <Pressable
                  onPress={() => {
                    void Linking.openSettings();
                  }}
                  style={({ pressed }: { pressed: boolean }) => [
                    styles.settingsBtn,
                    pressed ? { opacity: 0.75 } : null,
                  ]}
                >
                  <Text style={styles.settingsText}>去设置</Text>
                </Pressable>
              </>
            )}
          </View>
        ) : null}

        <Pressable
          onPress={onClose}
          style={({ pressed }: { pressed: boolean }) => [
            styles.close,
            { bottom: insets.bottom + 30 },
            pressed ? { opacity: 0.75 } : null,
          ]}
        >
          <Text style={styles.closeText}>取消</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.58)' },
    corner: { position: 'absolute', width: 26, height: 26 },
    cornerTL: { borderTopWidth: 3, borderLeftWidth: 3, borderColor: '#FFFFFF', borderTopLeftRadius: 6 },
    cornerTR: { borderTopWidth: 3, borderRightWidth: 3, borderColor: '#FFFFFF', borderTopRightRadius: 6 },
    cornerBL: { borderBottomWidth: 3, borderLeftWidth: 3, borderColor: '#FFFFFF', borderBottomLeftRadius: 6 },
    cornerBR: { borderBottomWidth: 3, borderRightWidth: 3, borderColor: '#FFFFFF', borderBottomRightRadius: 6 },
    scanLine: {
      position: 'absolute',
      height: 2.5,
      borderRadius: 2,
      backgroundColor: ACCENT,
      shadowColor: ACCENT,
      shadowOpacity: 0.9,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 0 },
      elevation: 6,
    },
    frameHint: {
      position: 'absolute',
      left: 0,
      right: 0,
      color: 'rgba(255,255,255,0.82)',
      fontSize: tv.type.xs,
      textAlign: 'center',
    },
    top: { paddingHorizontal: 24, alignItems: 'center' },
    title: { color: '#fff', fontSize: tv.type.lg, fontWeight: tv.weight.semibold },
    subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: tv.type.micro, marginTop: 6 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    centerTitle: { color: '#fff', fontSize: tv.type.base, fontWeight: tv.weight.medium },
    centerText: {
      color: 'rgba(255,255,255,0.72)',
      fontSize: tv.type.sm,
      textAlign: 'center',
      lineHeight: tv.type.sm * 1.6,
      marginTop: 10,
    },
    close: {
      position: 'absolute',
      alignSelf: 'center',
      paddingVertical: 12,
      paddingHorizontal: 40,
      borderRadius: 24,
      backgroundColor: 'rgba(255,255,255,0.16)',
    },
    closeText: { color: '#fff', fontSize: tv.type.base, fontWeight: tv.weight.medium },
    settingsBtn: {
      marginTop: 18,
      paddingVertical: 10,
      paddingHorizontal: 24,
      borderRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.5)',
    },
    settingsText: { color: '#fff', fontSize: tv.type.sm },
  });
}
