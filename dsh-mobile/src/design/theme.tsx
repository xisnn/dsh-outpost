/**
 * 主题上下文：提供当前色板 + 切换能力。
 *
 * 所有组件通过 useTheme() 拿 colors，不再直接 import colors。
 * 这样切换主题时整棵树重渲染，无需重启。
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  paletteOf,
  palettes,
  type Palette,
  type ThemeMode,
  radius,
  space,
  type,
  weight,
  layout,
  motion,
} from './tokens';

export interface Theme {
  mode: ThemeMode;
  colors: Palette;
  radius: typeof radius;
  space: typeof space;
  type: typeof type;
  weight: typeof weight;
  layout: typeof layout;
  motion: typeof motion;
  isDark: boolean;
}

interface ThemeContextValue extends Theme {
  setMode: (m: ThemeMode) => void;
  modes: ThemeMode[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({
  initial = 'light',
  onChange,
  children,
}: {
  initial?: ThemeMode;
  onChange?: (m: ThemeMode) => void;
  children: React.ReactNode;
}) {
  const [mode, setModeState] = useState<ThemeMode>(initial);

  const setMode = useCallback(
    (m: ThemeMode) => {
      setModeState(m);
      onChange?.(m);
    },
    [onChange],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      colors: paletteOf(mode),
      radius,
      space,
      type,
      weight,
      layout,
      motion,
      isDark: mode === 'dark',
      setMode,
      modes: Object.keys(palettes) as ThemeMode[],
    }),
    [mode, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
