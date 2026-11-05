import { StyleSheet } from 'react-native';
import type { useTheme } from './theme';

/** Shared action hierarchy. Quiet actions sit directly on their parent card. */
export function actionStyles(tv: ReturnType<typeof useTheme>) {
  const C = tv.colors;
  return StyleSheet.create({
    base: {
      minHeight: 44,
      minWidth: 64,
      paddingHorizontal: tv.space.md,
      paddingVertical: tv.space.sm,
      borderRadius: tv.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primary: { backgroundColor: C.accent },
    secondary: { backgroundColor: C.accentWash },
    quiet: { backgroundColor: 'transparent' },
    danger: { backgroundColor: C.danger },
    primaryText: { color: C.onAccent, fontSize: tv.type.sm, fontWeight: tv.weight.semibold },
    secondaryText: { color: C.accentBright, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    quietText: { color: C.textSecondary, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    dangerText: { color: C.danger, fontSize: tv.type.sm, fontWeight: tv.weight.medium },
    dangerFillText: { color: C.bg, fontSize: tv.type.sm, fontWeight: tv.weight.semibold },
    disabled: { opacity: 0.4 },
  });
}
