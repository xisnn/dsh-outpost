/**
 * 连接错误横幅：非终止错误延迟 3 秒出现，401/403 立即出现。
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { CONNECTION_BANNER_DELAY_MS, shouldShowConnectionBanner } from '../core/connectionBanner';
import { useTheme } from '../design/theme';
import { layout, space, type, weight } from '../design/tokens';

export function ConnectionBanner({
  connection,
  hint,
  terminal,
  delayMs = CONNECTION_BANNER_DELAY_MS,
}: {
  connection: string;
  hint?: string;
  terminal: boolean;
  delayMs?: number;
}) {
  const tv = useTheme();
  const styles = React.useMemo(() => makeStyles(tv), [tv]);
  const sinceRef = useRef(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const isError = connection === 'error' && !!hint;
    if (!isError) {
      sinceRef.current = 0;
      setNow(Date.now());
      return;
    }
    if (terminal) {
      // 终止态立即显示，不启动延迟计时
      setNow(Date.now());
      return;
    }
    if (!sinceRef.current) sinceRef.current = Date.now();
    const elapsed = Date.now() - sinceRef.current;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, delayMs - elapsed));
    return () => clearTimeout(timer);
  }, [connection, hint, terminal, delayMs]);

  const show = shouldShowConnectionBanner({
    connection,
    hint,
    terminal,
    errorSince: sinceRef.current,
    now,
    delayMs,
  });
  if (!show || !hint) return null;

  const [title, ...rest] = hint.split('\n');
  return (
    <View
      style={[styles.bar, terminal ? styles.barDanger : styles.barWarning]}
      accessibilityRole="alert"
      accessibilityLiveRegion={terminal ? 'assertive' : 'polite'}
    >
      <Text style={styles.icon}>{terminal ? '⛔' : '⚠'}</Text>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {rest.length > 0 ? (
          <Text style={styles.hint} numberOfLines={3}>
            {rest.join(' ')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      marginHorizontal: layout.screenPadding,
      marginTop: space.xs,
      paddingVertical: 7,
      paddingHorizontal: 9,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
    },
    barWarning: { backgroundColor: C.warningWash, borderColor: C.warning },
    barDanger: { backgroundColor: C.dangerWash, borderColor: C.danger },
    icon: { color: C.textSecondary, fontSize: type.xs, lineHeight: type.xs * 1.5 },
    body: { flex: 1, gap: 2 },
    title: {
      color: C.text,
      fontSize: type.micro,
      lineHeight: type.xs * 1.5,
      fontWeight: weight.medium,
    },
    hint: {
      color: C.textTertiary,
      fontSize: type.micro,
      lineHeight: type.xs * 1.4,
    },
  });
}
