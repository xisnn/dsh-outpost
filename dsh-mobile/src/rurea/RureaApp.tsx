/**
 * Rurea agent-first shell (A2 decoupling).
 *
 * The phone agent is the primary surface; the legacy dsh client lives behind a
 * single entry (AgentSettings → "dsh 客户端", showDshEntry). This shell hosts the
 * Agent* screens with ONLY theme + motion + navigation + the OutpostAgent bridge
 * — no DshConnection / Store / pairing / credential machinery. The Agent* screens
 * are useApp()-free (verified), and the native agent core talks to cloud models
 * directly, so the agent runs fully independent of the dsh gateway.
 *
 * Additive: the default dsh build (index.js → App) is unchanged. This entry is
 * selected via -PDSH_RUREA_ENTRY=index.rurea.js.
 */
import 'react-native-gesture-handler';
import React, { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeProvider, useTheme } from '../design/theme';
import { MotionProvider } from '../design/motion';
import { themeLabels, type ThemeMode } from '../design/tokens';
import { NavHost, type Screen } from '../nav/NavHost';
import { AgentButlerScreen } from '../screens/AgentButlerScreen';
import { AgentDemoScreen } from '../screens/AgentDemoScreen';
import { AgentSettingsScreen } from '../screens/AgentSettingsScreen';
import { AgentMemoryScreen } from '../screens/AgentMemoryScreen';
import { BackgroundDisplayScreen } from '../screens/BackgroundDisplayScreen';
import DshApp from '../App';

const THEME_KEY = '***';

function readThemeMode(raw: string | null): ThemeMode {
  return raw && raw in themeLabels ? (raw as ThemeMode) : 'light';
}

function renderScreen(screen: Screen, active: boolean) {
  switch (screen.name) {
    case 'AgentSettings':
      // showDshEntry: the single legacy-dsh entry, only in the Rurea context.
      return <AgentSettingsScreen showDshEntry />;
    case 'AgentMemory':
      return <AgentMemoryScreen active={active} />;
    case 'BackgroundDisplay':
      return <BackgroundDisplayScreen />;
    case 'AgentDemo':
      return <AgentDemoScreen active={active} />;
    case 'DshClient':
      // The legacy dsh client, self-contained (brings its own providers).
      return <DshApp />;
    default:
      return <AgentButlerScreen active={active} />;
  }
}

function ThemedStatusBar() {
  const tv = useTheme();
  return (
    <StatusBar
      barStyle={tv.isDark ? 'light-content' : 'dark-content'}
      backgroundColor={tv.colors.bg}
    />
  );
}

export default function RureaApp() {
  const [initialMode, setInitialMode] = useState<ThemeMode>('light');
  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY)
      .then((v) => setInitialMode(readThemeMode(v)))
      .catch(() => {});
  }, []);
  const onThemeChange = useCallback((m: ThemeMode) => {
    void AsyncStorage.setItem(THEME_KEY, m);
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider initial={initialMode} onChange={onThemeChange}>
          <MotionProvider>
            <BottomSheetModalProvider>
              <ThemedStatusBar />
              <NavHost initial={{ name: 'AgentButler' }} render={renderScreen} rootIsList={false} />
            </BottomSheetModalProvider>
          </MotionProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
