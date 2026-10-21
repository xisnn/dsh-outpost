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
import { NoticeHost } from './components/NoticeHost';
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
/** 管家会话绑定的工作区路径（决定 cwd，也决定队员归属哪个项目） */
const BUTLER_WORKSPACE_KEY = '@dsh/butlerWorkspace';
/**
 * 工作区路径 → 该项目的管家会话 id。
 *
 * 为什么要这个映射：切项目再切回来时，原来的会话还在（上下文、队员都在），
 * 应该恢复它而不是新建。只存一个 BUTLER_SESSION_KEY 的话，切回来会开新会话，
 * 用户看到的就是「上下文不见了」。
 */
const BUTLER_WS_SESSIONS_KEY = '@dsh/butlerSessionsByWs';
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
  /** 需要用户先选一个管家工作区（开启管家模式时还没绑过） */
  butlerNeedWorkspace: boolean;
  /** 用户选好工作区后调用，建会话并绑定 */
  pickButlerWorkspace: (path: string) => void;
  /** 当前管家绑定的工作区路径 */
  butlerWorkspace: string | null;
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
  // 管家绑定的工作区；null 表示还没选过，需要引导用户选一个
  const [butlerWorkspace, setButlerWorkspace] = useState<string | null>(null);
  const [butlerNeedWorkspace, setButlerNeedWorkspace] = useState(false);
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
        const savedButlerWs = await AsyncStorage.getItem(BUTLER_WORKSPACE_KEY);
        if (savedButlerWs) setButlerWorkspace(savedButlerWs);

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
   * 管家会话绑一个工作区（cwd），派出去的队员就落在那个项目里。
   * 队员是会话级的（TeamMemberSnapshot 挂在 parentSessionId 上），
   * 所以「按项目复用队员」等价于「一个项目一个管家会话」。
   *
   * 关键：每个工作区记住自己的会话（BUTLER_WS_SESSIONS_KEY 是个 map）。
   * 切项目再切回来时恢复原会话 —— 上下文和队员都还在。
   * 之前只存一个全局 sessionId 且无条件新建，用户切回来发现上下文没了。
   *
   * forceWorkspace：用户刚选的目录。不传就沿用上次绑定的。
   */
  const ensureButlerSession = useCallback(
    async (forceWorkspace?: string): Promise<string | null> => {
      setButlerBusy(true);
      try {
        if (store.workspaces.length === 0) await store.loadSessions();

        const prevWs = await AsyncStorage.getItem(BUTLER_WORKSPACE_KEY);
        const targetWs = forceWorkspace ?? prevWs ?? '';

        // 还没绑过工作区 → 返回 null，交给 UI 弹选择框
        if (!targetWs) return null;

        // 同一工作区且有会话 → 直接复用
        if (butlerSessionId && prevWs === targetWs) {
          void primeButler(butlerSessionId);
          return butlerSessionId;
        }

        // 查这个工作区以前有没有管家会话
        let byWs: Record<string, string> = {};
        try {
          const raw = await AsyncStorage.getItem(BUTLER_WS_SESSIONS_KEY);
          if (raw) byWs = JSON.parse(raw) as Record<string, string>;
        } catch {
          // 解析失败就当没有
        }

        const remembered = byWs[targetWs];
        // 记住的会话可能已经被用户删了，确认它还在列表里
        const stillExists =
          !!remembered && store.sessions.some((s) => s.sessionId === remembered);

        if (remembered && stillExists) {
          // 恢复原会话：上下文、队员都在
          setButlerSessionId(remembered);
          setButlerWorkspace(targetWs);
          setButlerNeedWorkspace(false);
          await AsyncStorage.setItem(BUTLER_SESSION_KEY, remembered);
          await AsyncStorage.setItem(BUTLER_WORKSPACE_KEY, targetWs);
          void primeButler(remembered);
          return remembered;
        }

        // 这个项目第一次开 → 新建会话
        const id = await store.createSession(targetWs);
        byWs[targetWs] = id;
        setButlerSessionId(id);
        setButlerWorkspace(targetWs);
        setButlerNeedWorkspace(false);
        await AsyncStorage.setItem(BUTLER_SESSION_KEY, id);
        await AsyncStorage.setItem(BUTLER_WORKSPACE_KEY, targetWs);
        await AsyncStorage.setItem(BUTLER_WS_SESSIONS_KEY, JSON.stringify(byWs));
        // 新会话要重新注入人格
        await AsyncStorage.removeItem(BUTLER_PRIMED_KEY);
        void primeButler(id);
        return id;
      } catch {
        return null;
      } finally {
        setButlerBusy(false);
      }
    },
    [butlerSessionId, store, primeButler],
  );

  const setButlerMode = useCallback(
    (on: boolean) => {
      setButlerModeState(on);
      void AsyncStorage.setItem(BUTLER_KEY, on ? '1' : '0');
      if (!on) return;
      // 还没有会话或还没绑工作区 → 先让用户选一个项目。
      // 每次都问太烦，所以只在「没绑过」或「会话丢了」时才弹。
      void (async () => {
        const id = await ensureButlerSession();
        if (!id) setButlerNeedWorkspace(true);
      })();
    },
    [ensureButlerSession],
  );

  /** 用户选好管家工作区：建会话并绑定 */
  const pickButlerWorkspace = useCallback(
    (path: string) => {
      setButlerNeedWorkspace(false);
      void ensureButlerSession(path);
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
      butlerNeedWorkspace,
      pickButlerWorkspace,
      butlerWorkspace,
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
      butlerNeedWorkspace,
      pickButlerWorkspace,
      butlerWorkspace,
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
          {authed ? <NavHost initial={{ name: 'Home' }} render={renderScreen} /> : <PairScreen />}
          {/* 全局通知横幅：盖在导航之上，任意页面都能看到 */}
          {authed ? <GlobalNotices /> : null}
        </AppContext.Provider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * 全局通知横幅的挂载点。
 *
 * 单独抽出来是为了能在 useApp() 内部拿 store（App 组件本身在 Provider 外面）。
 * 同时负责「点通知跳会话」：这里拿不到 nav，所以用 store 记录待跳转的会话，
 * 由 NavHost 里的页面消费——见 store.pendingOpenSession。
 */
function GlobalNotices() {
  const { store } = useApp();
  const [, force] = React.useState(0);

  React.useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    store.startNoticeScan();
    return () => {
      unsub();
      store.stopNoticeScan();
    };
  }, [store]);

  // 通知初始化 + 点通知跳转。
  // initNotifications 会申请权限、建通道；原生模块缺失时静默降级。
  React.useEffect(() => {
    let off: (() => void) | undefined;
    void (async () => {
      try {
        const { initNotifications, onNotificationOpen } = await import('./core/notify');
        await initNotifications();
        off = await onNotificationOpen((sid) => store.requestOpenSession(sid));
      } catch (e) {
        // 不能让通知初始化把整个 App 拖垮
        console.warn('[dsh] 通知初始化失败', e);
      }
    })();
    return () => off?.();
  }, [store]);

  return (
    <NoticeHost
      items={store.notices}
      onPress={(item) => {
        if (item.sessionId) store.requestOpenSession(item.sessionId);
      }}
      onDismiss={(id) => store.dismissNotice(id)}
    />
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
          key={String(screen.params?.sessionId ?? '')}
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
