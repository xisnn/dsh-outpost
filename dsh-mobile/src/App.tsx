/**
 * App 入口：主题 + 自己实现的栈导航 + 三层页面。
 *
 * 不依赖 react-native-screens（它在 RN 0.81 + Fabric 下有原生 ABI 问题）。
 *
 * 层次：
 *   ThemeProvider（色板可运行时切换，纯白/暖白/深色）
 *     AppContext（store / baseUrl / cookie）
 *       NavHost
 *         Home        ← 底部 tab：工作区 | 我的
 *         Sessions
 *         Chat
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DshConnection } from './core/transport';
import { Store } from './core/store';
import { WORKSPACE_CUSTOM_KEY, type WorkspaceCustom } from './core/workspace-custom';
import { ThemeProvider, useTheme } from './design/theme';
import { palettes, type ThemeMode } from './design/tokens';
import { buildButlerPrime, BUTLER_PRIME_VERSION } from './core/butler';
import { NavHost, type Screen } from './nav/NavHost';
import { PairScreen } from './screens/PairScreen';
import { HomeScreen } from './screens/HomeScreen';
import { SessionsScreen } from './screens/SessionsScreen';
import { ChatScreen } from './screens/ChatScreen';
import { WorkspacesScreen } from './screens/WorkspacesScreen';
import { TaskBoardScreen } from './screens/TaskBoardScreen';

const COOKIE_KEY = '@dsh/cookie';
const LAST_COOKIE_KEY = '@dsh/lastCookie';
const BASE_URL_KEY = '@dsh/baseUrl';
const OWNED_KEY = '@dsh/ownedSessions';
const THEME_KEY = '@dsh/themeMode';
const BUTLER_KEY = '@dsh/butlerMode';
const BUTLER_SESSION_KEY = '@dsh/butlerSession';
const BUTLER_PRIMED_KEY = '@dsh/butlerPrimed';

export interface AppContextValue {
  store: Store;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  saveCookie: (cookie: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** 管家模式：开启后首页直接跟管家对话，工作区列表退到「我的」里 */
  butlerMode: boolean;
  setButlerMode: (on: boolean) => void;
  /** 管家会话（首次开启时创建并持久化） */
  butlerSessionId: string | null;
  butlerBusy: boolean;
  /** 退出后仍保留的上一次配对，可一键恢复，避免误触后要重新找 token */
  hasLastPairing: boolean;
  resumePairing: () => Promise<boolean>;
}

export const AppContext = React.createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = React.useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

/** 从持久化值解析主题，非法值回落到纯白 */
function readThemeMode(raw: string | null): ThemeMode {
  return raw && raw in palettes ? (raw as ThemeMode) : 'light';
}

function parseCustomMap(raw: string | null): Record<string, WorkspaceCustom> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as Record<string, WorkspaceCustom>;
  } catch {
    return null;
  }
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  // 服务地址由用户在配对页填写；这里默认留空，避免把开发者的地址带进开源仓库
  const [baseUrl, setBaseUrlState] = useState('');
  // 启动时从磁盘读到的主题；ThemeProvider 只在挂载时用 initial
  const [initialMode, setInitialMode] = useState<ThemeMode>('light');
  // cookie 必须进 state：store 依赖 baseUrl+cookie 重建，
  // 否则配对成功后新建的 store 里没有 cookie，会报 not authenticated。
  const [cookie, setCookie] = useState<string | undefined>(undefined);
  // 管家模式
  const [butlerMode, setButlerModeState] = useState(false);
  const [butlerSessionId, setButlerSessionId] = useState<string | null>(null);
  const [butlerBusy, setButlerBusy] = useState(false);
  const [hasLastPairing, setHasLastPairing] = useState(false);

  const store = useMemo(() => {
    const conn = new DshConnection({ baseUrl, cookie });
    return new Store(conn);
  }, [baseUrl, cookie]);

  useEffect(() => {
    (async () => {
      try {
        const savedTheme = await AsyncStorage.getItem(THEME_KEY);
        setInitialMode(readThemeMode(savedTheme));

        const savedButler = await AsyncStorage.getItem(BUTLER_KEY);
        setButlerModeState(savedButler === '1');
        const savedButlerSession = await AsyncStorage.getItem(BUTLER_SESSION_KEY);
        if (savedButlerSession) setButlerSessionId(savedButlerSession);

        const lastCookie = await AsyncStorage.getItem(LAST_COOKIE_KEY);

        const savedBase = await AsyncStorage.getItem(BASE_URL_KEY);
        const savedCookie = await AsyncStorage.getItem(COOKIE_KEY);
        setHasLastPairing(!!lastCookie || !!savedCookie);
        if (savedBase) setBaseUrlState(savedBase);
        if (savedBase && savedCookie) {
          // 乐观登录：有 cookie 就直接进，不再用一次网络探测决定登录态。
          // 之前探测失败（网络抖动 / 服务正重启）会把人打回配对页，
          // 看起来就像「莫名其妙被退出登录」。
          setCookie(savedCookie);
          setAuthed(true);
        }
      } catch {
        // 读取失败就当作未登录
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // 「手机创建的会话」标记持久化 + 恢复
  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(OWNED_KEY);
        if (raw) {
          const ids = JSON.parse(raw);
          if (Array.isArray(ids)) store.restoreOwned(ids.filter((x) => typeof x === 'string'));
        }
      } catch {
        // 忽略
      }
    })();
  }, [store]);

  // 只在 owned 列表真的变化时写回（避免每次 emit 都落盘）
  useEffect(() => {
    let last = JSON.stringify(store.ownedList());
    const unsub = store.subscribe(() => {
      const next = JSON.stringify(store.ownedList());
      if (next === last) return;
      last = next;
      void AsyncStorage.setItem(OWNED_KEY, next);
    });
    return unsub;
  }, [store]);

  // 工作区自定义（改名 / emoji）：store 重建后重新挂载，所以每次都从磁盘恢复
  useEffect(() => {
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(WORKSPACE_CUSTOM_KEY);
        const map = parseCustomMap(raw);
        if (map) store.restoreWorkspaceCustom(map);
      } catch {
        // 忽略
      }
    })();
  }, [store]);

  useEffect(() => {
    let last = JSON.stringify(store.workspaceCustom);
    const unsub = store.subscribe(() => {
      const next = JSON.stringify(store.workspaceCustom);
      if (next === last) return;
      last = next;
      void AsyncStorage.setItem(WORKSPACE_CUSTOM_KEY, next);
    });
    return unsub;
  }, [store]);

  const saveCookie = useCallback(async (c: string) => {
    await AsyncStorage.setItem(COOKIE_KEY, c);
    setCookie(c);
    setAuthed(true);
  }, []);

  const signOut = useCallback(async () => {
    // 留一份「上次配对」，误触退出时能一键恢复，不用重新找 token
    const cur = await AsyncStorage.getItem(COOKIE_KEY);
    if (cur) await AsyncStorage.setItem(LAST_COOKIE_KEY, cur);
    await AsyncStorage.removeItem(COOKIE_KEY);
    setCookie(undefined);
    setAuthed(false);
    setHasLastPairing(!!cur);
  }, []);

  /** 用上次的 cookie 直接恢复登录（验证通过才恢复） */
  const resumePairing = useCallback(async (): Promise<boolean> => {
    const last =
      (await AsyncStorage.getItem(LAST_COOKIE_KEY)) ??
      (await AsyncStorage.getItem(COOKIE_KEY));
    if (!last) return false;
    try {
      const conn = new DshConnection({ baseUrl, cookie: last });
      const probe = new Store(conn);
      const ok = await probe.ping();
      probe.close();
      if (!ok) return false;
      await AsyncStorage.setItem(COOKIE_KEY, last);
      setCookie(last);
      setAuthed(true);
      return true;
    } catch {
      return false;
    }
  }, [baseUrl]);

  const setBaseUrl = useCallback((v: string) => {
    setBaseUrlState(v);
    void AsyncStorage.setItem(BASE_URL_KEY, v);
  }, []);

  const onThemeChange = useCallback((m: ThemeMode) => {
    void AsyncStorage.setItem(THEME_KEY, m);
  }, []);

  /**
   * 给管家会话注入人格（发一条带标记的首条消息，fold 层会把它从界面滤掉）。
   * 失败（比如模型限流）就留着下次开启再试。
   */
  const primeButler = useCallback(
    async (id: string) => {
      try {
        const done = await AsyncStorage.getItem(BUTLER_PRIMED_KEY);
        if (done === BUTLER_PRIME_VERSION) return;
        await store.send(id, buildButlerPrime(), []);
        await AsyncStorage.setItem(BUTLER_PRIMED_KEY, BUTLER_PRIME_VERSION);
      } catch {
        // 忽略：额度/网络问题，下次开启重试
      }
    },
    [store],
  );

  /**
   * 确保管家会话存在。
   *
   * 管家会话的 cwd 用「最近活跃的那个工作区」—— 这样它派出去的队员
   * 直接落在用户正在做的项目里，而不是一个空目录。
   * 建会话走 store.createSession，内部会用 workspaceId 建（登记进注册表）。
   */
  const ensureButlerSession = useCallback(async (): Promise<string | null> => {
    if (butlerSessionId) {
      void primeButler(butlerSessionId);
      return butlerSessionId;
    }
    setButlerBusy(true);
    try {
      if (store.workspaces.length === 0) await store.loadSessions();
      const cwd = store.workspaces.find((w) => !!w.path)?.path ?? '';
      const id = await store.createSession(cwd);
      setButlerSessionId(id);
      await AsyncStorage.setItem(BUTLER_SESSION_KEY, id);
      await AsyncStorage.removeItem(BUTLER_PRIMED_KEY);
      void primeButler(id);
      return id;
    } catch {
      return null;
    } finally {
      setButlerBusy(false);
    }
  }, [butlerSessionId, store, primeButler]);

  const setButlerMode = useCallback(
    (on: boolean) => {
      setButlerModeState(on);
      void AsyncStorage.setItem(BUTLER_KEY, on ? '1' : '0');
      if (on) void ensureButlerSession();
    },
    [ensureButlerSession],
  );

  const ctxValue = useMemo<AppContextValue>(
    () => ({
      store,
      baseUrl,
      setBaseUrl,
      saveCookie,
      signOut,
      butlerMode,
      setButlerMode,
      butlerSessionId,
      butlerBusy,
      hasLastPairing,
      resumePairing,
    }),
    [
      store,
      baseUrl,
      setBaseUrl,
      saveCookie,
      signOut,
      butlerMode,
      setButlerMode,
      butlerSessionId,
      butlerBusy,
      hasLastPairing,
      resumePairing,
    ],
  );

  if (!ready) {
    return (
      <ThemeProvider initial="light">
        <Boot />
      </ThemeProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider initial={initialMode} onChange={onThemeChange}>
        <AppContext.Provider value={ctxValue}>
          <ThemedStatusBar />
          {authed ? <NavHost initial="Home" render={renderScreen} /> : <PairScreen />}
        </AppContext.Provider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function renderScreen(screen: Screen) {
  switch (screen.name) {
    case 'Sessions':
      return (
        <SessionsScreen
          workspacePath={String(screen.params?.workspacePath ?? '')}
          workspaceName={String(screen.params?.workspaceName ?? '')}
        />
      );
    case 'Chat':
      return (
        <ChatScreen
          sessionId={String(screen.params?.sessionId ?? '')}
          title={screen.params?.title ? String(screen.params.title) : undefined}
          butler={screen.params?.butler === true}
        />
      );
    case 'Workspaces':
      return <WorkspacesScreen />;
    case 'TaskBoard':
      return <TaskBoardScreen sessionId={String(screen.params?.sessionId ?? '')} />;
    case 'Subagent':
      // 队员事件流：只读，用 subagent 地址才读得到
      return (
        <ChatScreen
          sessionId={String(screen.params?.childSessionId ?? '')}
          title={screen.params?.title ? String(screen.params.title) : undefined}
          address={{
            kind: 'subagent',
            parentSessionId: String(screen.params?.parentSessionId ?? ''),
            childSessionId: String(screen.params?.childSessionId ?? ''),
            mode: 'continuable',
          }}
          readOnly
        />
      );
    default:
      return <HomeScreen />;
  }
}

/** 状态栏跟随主题（深色主题用浅色图标） */
function ThemedStatusBar() {
  const tv = useTheme();
  return (
    <StatusBar
      barStyle={tv.isDark ? 'light-content' : 'dark-content'}
      backgroundColor={tv.colors.bg}
    />
  );
}

function Boot() {
  const tv = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: tv.colors.bg }]}>
      <ActivityIndicator color={tv.colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
