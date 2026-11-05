import React, { useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { useTheme } from '../design/theme';

/** Static placeholders: one loading announcement, no decorative screen-reader stops. */
export function LoadingSkeleton({ label, variant = 'task' }: {
  label: string;
  variant?: 'task' | 'model';
}) {
  const tv = useTheme();
  const styles = useMemo(() => makeStyles(tv), [tv]);
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    AccessibilityInfo.announceForAccessibility(label);
  }, [label]);

  return (
    <View testID="initial-loading-skeleton" pointerEvents="none" accessible={false}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={styles.container}>
      {[0, 1, 2].map(row => (
        <View key={row} style={[styles.row, variant === 'model' ? styles.modelRow : styles.taskRow]}>
          <View style={[styles.bar, styles.title, { width: row === 1 ? '58%' : '74%' }]} />
          <View style={[styles.bar, styles.subtitle]} />
          {variant === 'task' ? <View style={[styles.bar, styles.meta]} /> : null}
        </View>
      ))}
    </View>
  );
}

function makeStyles(tv: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    container: { marginHorizontal: tv.layout.screenPadding },
    row: { padding: tv.space.md, marginBottom: tv.space.sm },
    taskRow: {
      borderRadius: tv.radius.md, backgroundColor: tv.colors.bgRaised,
      borderWidth: StyleSheet.hairlineWidth, borderColor: tv.colors.border,
    },
    modelRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tv.colors.border },
    bar: { backgroundColor: tv.colors.border, borderRadius: tv.radius.sm },
    title: { height: tv.type.sm },
    subtitle: { width: '90%', height: tv.type.xs, marginTop: tv.space.sm },
    meta: { width: '38%', height: tv.type.micro, marginTop: tv.space.md },
  });
}
