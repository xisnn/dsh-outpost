import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../design/theme';
import { fileTypeLabel } from '../core/filePresentation';

/** Shared visual label for draft, pending, history and delivered file cards. */
export function FileTypeBadge({ name, compact = false }: { name?: string; compact?: boolean }) {
  const tv = useTheme();
  const styles = useMemo(() => StyleSheet.create({
    badge: { width: compact ? 32 : 40, height: compact ? 32 : 40, flexShrink: 0,
      borderRadius: tv.radius.sm, backgroundColor: tv.colors.accentWash,
      justifyContent: 'center', alignItems: 'center' },
    label: { color: tv.colors.accentBright, fontSize: compact ? 9 : tv.type.micro, fontWeight: tv.weight.semibold },
  }), [tv, compact]);
  return <View style={styles.badge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Text style={styles.label} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{fileTypeLabel(name)}</Text>
  </View>;
}
