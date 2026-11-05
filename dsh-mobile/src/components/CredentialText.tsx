/** Screen-only protection. Message storage and send payloads always keep their originals. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme } from '../design/theme';
import { displayCredentials, findCredentials } from '../core/credentialDisplay';

export function useCredentialDisplay(text: string, scope: string, enabled = true) {
  const ranges = useMemo(() => findCredentials(text), [text]);
  const owner = useMemo(() => ({ text, scope, enabled }), [text, scope, enabled]);
  const latest = useRef(owner);
  latest.current = owner;
  const epoch = useRef(0);
  const live = useRef(true);
  const [disclosure, setDisclosure] = useState({ owner, revealed: [] as number[] });
  // Changed props are masked in this render, before any effect can run.
  const current = disclosure.owner === owner;
  if (!current) setDisclosure({ owner, revealed: [] });
  const revealed = new Set(current && enabled ? disclosure.revealed : []);
  const renderEpoch = epoch.current;

  useEffect(() => {
    live.current = true;
    if (!enabled || ranges.length === 0) return;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') return;
      epoch.current++;
      setDisclosure(previous => ({ ...previous, revealed: [] }));
    });
    return () => { live.current = false; subscription.remove(); };
  }, [owner, ranges, enabled]);

  function toggle(index: number) {
    if (!enabled || !live.current || latest.current !== owner || epoch.current !== renderEpoch ||
        AppState.currentState !== 'active' || index < 0 || index >= ranges.length) return;
    setDisclosure(previous => {
      const values = previous.owner === owner ? previous.revealed : [];
      return { owner, revealed: values.includes(index) ? values.filter(value => value !== index) : [...values, index] };
    });
  }
  return { text: displayCredentials(text, ranges, revealed), count: ranges.length, revealed, toggle, enabled };
}

type Disclosure = ReturnType<typeof useCredentialDisplay>;

/** Controls are siblings of the bubble press target, so reveal never also expands or copies. */
export function CredentialRevealControls({ display }: { display: Disclosure }) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  if (!display.count) return null;
  return <View style={styles.controls}>
    <Text style={styles.hint}>{display.revealed.size ? '凭据已按选择显示' : '凭据已隐藏'} · 发送仍使用原文</Text>
    {display.enabled ? <View style={styles.buttons}>
      {Array.from({ length: display.count }, (_, index) => {
        const shown = display.revealed.has(index);
        const label = `${shown ? '隐藏' : '显示'}第 ${index + 1} 处凭据`;
        return <Pressable key={index} accessibilityRole="button" accessibilityLabel={label}
          accessibilityState={{ expanded: shown }}
          accessibilityHint="只改变此消息的显示，离开聊天或进入后台后重新隐藏"
          onPress={() => display.toggle(index)} style={styles.button}>
          <Text style={styles.buttonText}>{label}</Text>
        </Pressable>;
      })}
    </View> : null}
  </View>;
}

/** Pending messages have no reveal affordance, including their accessibility text. */
export function CredentialText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const masked = useMemo(() => displayCredentials(text, findCredentials(text)), [text]);
  return <Text style={style}>{masked}</Text>;
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    controls: { marginTop: tv.space.xs, maxWidth: '100%' },
    hint: { color: tv.colors.textSecondary, fontSize: tv.type.xs, lineHeight: tv.type.xs * 1.5 },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: tv.space.xs },
    button: { minHeight: 44, minWidth: 64, justifyContent: 'center', paddingHorizontal: tv.space.sm },
    buttonText: { color: tv.colors.accentBright, fontSize: tv.type.xs, fontWeight: tv.weight.medium },
  });
}
