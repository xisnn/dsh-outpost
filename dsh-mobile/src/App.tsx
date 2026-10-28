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
import { ActivityIndicator, Alert, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DshConnection } from './core/transport';
import { checkBaseUrlSecurity } from './core/net-security';
import { Store } from './core/store';
import { PendingSendStore } from './core/pendingSend/store';
import {
  CredentialKey,
  clearAllCredentials,
  clearCredential,
  loadCredential,
  saveCredential,
} from './core/secureStore';
import {
  clearLegacyCredentialStorageVerified,
  migrateLegacyCredentials,
  shouldBlockAutoLogin,
  LegacyCredentialKey,
  type CredentialMigrationReport,
} from './core/credentialMigration';
import { clearNativeCookieJarDetailed } from './core/cookieJar';
import {
  clearApprovalRevoked,
  loadRevocationState,
  markApprovalRevoked,
  type RevocationPersistResult,
} from './core/deviceRevocation';
import {
  loadLoginIntent,
  setLoginIntent,
} from './core/loginIntent';
import { revokeOwnDeviceDetailed } from './core/deviceAuth';
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
import { DevicesScreen } from './screens/DevicesScreen';
import { WorkspacesScreen } from './screens/WorkspacesScreen';
import { TaskBoardScreen } from './screens/TaskBoardScreen';

// 旧版本明文凭据键（@dsh/cookie / @dsh/lastCookie / @dsh/gatewayToken /
// @dsh/gatewayDeviceId）统一由 core/credentialMigration.ts 管理 ——
// 迁移、清理、以及「清除授权」时的兜底删除都在那里。
const BASE_URL_KEY = '@dsh/baseUrl';

/**
 * 还没配对时用来撑住 DshConnection 的占位地址。
 *
 * 为什么需要：DshConnection 构造时会校验地址，空字符串会让
 * `new URL('')` 抛异常 → 渲染期崩溃 → 用户连配对页都看不到。
 * 详见 store 的 useMemo 注释。
 *
 * 必须是**合法且私有**的地址：合法才能通过构造校验；
 * 私有才符合「明文 HTTP 只发私有网段」的策略，即使漏判也不会
 * 把凭据发到公网。
 */
const PLACEHOLDER_BASE_URL = 'http://127.0.0.1:1';
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

/**
 * 服务端撤销那一半的结果（P0-2）。
 *
 * ## 为什么不能用 `revokeFailed: boolean`
 *
 * 之前是一个布尔值，只在「凭据齐全、请求发出去了、且返回 failed」时才
 * 被置位。于是**所有没发出请求的路径都是「成功」**：
 *
 *   · Cookie 读不出来（Keystore 异常）      → 静默跳过 → 报「全部成功」
 *   · deviceId / serverDeviceId 都没有      → 静默跳过 → 报「全部成功」
 *   · baseUrl 空（用户没连过）              → 静默跳过 → 报「全部成功」
 *
 * 用户看到的是「所有授权已成功撤销」，而电脑上那条记录一直有效。
 * 手机丢了场景下这一点非常致命。
 *
 * 现在改成判别联合，每种结局都有明确含义，且**只有前两种**能对用户
 * 声称「服务端那边已经没问题了」。
 */
type ServerRevokeResult =
  /** 服务端确认撤销成功 */
  | { kind: 'revoked' }
  /**
   * 服务端确认目标设备不存在，**且**设备身份已确认属于这台服务器。
   *
   * ⚠️ 注意它和「撤销成功」的区别：对用户是等价的（都没有残留授权），
   * 但推导路径不同，报告里要分开写清楚。
   */
  | { kind: 'already-gone'; how: 'identity' | 'empty-list' }
  /** 服务端撤销失败（网络 / 鉴权 / 服务端错误）—— 授权**可能还在** */
  | { kind: 'failed'; reason: string; status?: number }
  /** 缺凭据 / 身份不明，**根本没发出请求** —— 无法确认，不能算成功 */
  | { kind: 'unconfirmed'; reason: string };

/** 本地凭据清理的结果（P0-2 / P1-3 / P1-4） */
interface LocalCleanupResult {
  /** Keystore 里四份凭据是否清理并回读确认 */
  secureStorage: 'cleared' | 'failed';
  /**
   * 旧版明文副本是否**经回读确认**全部删除。
   *
   * ⚠️ 不是「删了几个」，而是「能不能断言磁盘上没有了」。
   * 回读失败 / 删除抛错 / 仍有残留 → false。
   */
  legacyPlaintext: boolean;
  /** 原生 cookie 容器的清理结论（P1-4：区分清掉了 / 平台没有 / 有残留 / 无法确认） */
  cookieJar: 'cleared' | 'unavailable' | 'partial' | 'unverified';
  /**
   * 「审批授权已撤销」这个决定本身有没有**持久化**（P0-1）。
   *
   * 和上面几项分开：那几项是「敏感凭据清掉了没有」，这一项是
   * 「撤销决定能不能跨重启存活」。二者独立 —— 凭据清干净了，
   * 撤销标记仍可能没写进去，下次启动就会自动重新申请配对。
   */
  revocation: RevocationPersistResult;
  /** P0-1 待发送记录是否清除并回读确认 */
  pendingSends: 'cleared' | 'failed';
}

/**
 * 「退出并清除所有授权」的完整结果。
 *
 * 两半分开：本地清理成功**不等于**服务端撤销成功，反之亦然。
 * 界面必须能分别如实告知，绝不能把两者混成一个「成功」。
 */
interface ClearAuthorizationResult {
  server: ServerRevokeResult;
  local: LocalCleanupResult;
}

/**
 * 结果里有没有「不能让用户以为全部搞定」的成分。
 *
 * 这是 UI 文案的**唯一**判据 —— 集中在一处，避免各处自己拼条件时
 * 漏掉某条路径（漏掉的那条就会显示成「全部成功」）。
 */
function isFullyClear(result: ClearAuthorizationResult): boolean {
  const serverOk = result.server.kind === 'revoked' || result.server.kind === 'already-gone';
  return (
    serverOk &&
    result.local.secureStorage === 'cleared' &&
    result.local.legacyPlaintext &&
    // cookie 容器「平台没有」不算残留（这个平台上没有第二份存储）
    (result.local.cookieJar === 'cleared' || result.local.cookieJar === 'unavailable') &&
    // 撤销决定必须真的落盘 —— 只留在内存里的话重启后会被推翻（P0-1）
    result.local.revocation.ok &&
    // 待发送记录也必须清除；未清除时不能让用户以为全部清干净
    result.local.pendingSends === 'cleared'
  );
}

export interface AppContextValue {
  store: Store;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  saveCookie: (cookie: string) => Promise<void>;
  /**
   * 断开连接：只是本次不用了，凭据仍留在 Keystore。
   *
   * 返回 false 表示「退出意图没能落盘」—— 下次启动可能仍会自动登录，
   * 界面必须如实告知（否则用户以为退出了，其实没有）。
   * 想彻底清除授权用 clearAuthorization()。
   */
  signOut: () => Promise<boolean>;
  /**
   * 退出并清除所有授权（**不可恢复**）。
   *
   * 删掉 Keystore 里的 Cookie / 网关 token / device id，
   * 清掉管家会话等派生状态，并尽量通知服务端撤销。
   *
   * 返回值把「服务端撤销」和「本地清理」两半**分别**报告 ——
   * 界面必须能如实告知用户哪一半成功了（见 ClearAuthorizationResult）。
   */
  clearAuthorization: () => Promise<ClearAuthorizationResult>;
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
  /**
   * 本机审批授权是否已被撤销（用户主动撤销 / 服务端踢掉）。
   *
   * true 时不会自动建立审批连接 —— 只有用户主动重新授权才恢复。
   */
  approvalRevoked: boolean;
  /** 用户主动重新授权审批通道（清除撤销标记 + 重新配对） */
  reauthorizeApprovals: () => Promise<boolean>;
  /** 撤销本机的审批授权（服务端 + 本地），不影响聊天用的 Cookie */
  revokeOwnApproval: () => Promise<{ serverOk: boolean; localOk: boolean }>;
  /**
   * 安全存储不可用 / 迁移失败时的错误说明（null = 正常）。
   *
   * 有这个值时界面必须明确告知用户「凭据没能安全保存」，
   * 而不是静默降级到明文存储。
   */
  secureStorageError: string | null;
}

/**
 * 「清除所有授权」结果的分项提示（P0-2）。
 *
 * ## 为什么要替换掉原来的两个布尔提示
 *
 * 之前是 `revokeFailed: boolean` + `legacyCleared/cookieJarCleared: boolean`：
 * 布尔值只有两个状态，而实际有四种**对用户含义完全不同**的结局：
 *
 *   · 发出去并成功了
 *   · 服务端说本来就没有（且身份确认过）
 *   · 请求失败（网络/鉴权）—— 授权可能还在
 *   · 压根没发出去（缺凭据 / 身份不明）—— 无法确认
 *
 * 后两种压进同一个 `true` 里，文案只能说「撤销失败」，用户分不清
 * 「我该换个网络重试」还是「我根本不在这台服务器的配对上」。
 *
 * 这里按结果分项列出，**服务端**和**本地**分开说 —— 本地清干净了
 * 不代表服务端也干净了，这是本轮的核心要求之一。
 *
 * ⚠️ 绝不出现 Cookie / token / 设备 UUID 原文，只说结论。
 */
function notifyClearResult(result: ClearAuthorizationResult): void {
  const problems: string[] = [];

  // ── 服务端那半边 ────────────────────────────────────────────
  switch (result.server.kind) {
    case 'revoked':
    case 'already-gone':
      // 服务端确认没有残留授权 —— 不用提示
      break;
    case 'failed':
      problems.push(
        '没能通知电脑撤销这台设备的授权（网络或权限问题）。\n' +
          '  **电脑上的授权可能仍然有效**，请联网后重试，或在电脑上打开\n' +
          '  DSH 的「设备管理」手动移除这台设备。',
      );
      break;
    case 'unconfirmed':
      problems.push(
        `无法确认服务端授权是否已撤销（${result.server.reason}）。\n` +
          '  **不要假定它已经撤销**：请在电脑上打开 DSH 的「设备管理」\n' +
          '  核对这台设备是否还在列表里。',
      );
      break;
  }

  // ── 本地那半边 ──────────────────────────────────────────────
  if (result.local.secureStorage === 'failed') {
    problems.push(
      '本机的安全凭据没能确认全部清除（或「已退出」状态没能保存）。\n' +
        '  下次启动可能仍会自动登录，建议重启后再执行一次清除。',
    );
  }
  if (!result.local.legacyPlaintext) {
    problems.push(
      '旧版本遗留的明文凭据可能还有残留。\n' +
        '  建议重启一次 App 让它重试；如果仍然提示，可以卸载重装。',
    );
  }
  if (result.local.cookieJar === 'partial' || result.local.cookieJar === 'unverified') {
    problems.push(
      '系统的 cookie 缓存没能确认清空。\n' +
        '  这可能导致下次启动仍以原身份通过鉴权，建议重启后重试清除。',
    );
  }
  if (!result.local.revocation.ok) {
    // P0-1：撤销标记只留在内存里。本次运行是安全的（不会自动配对），
    // 但重启后就没有任何东西拦着自动重新授权了 —— 而这正是用户
    // 按下「撤销」时最不希望发生的事。
    problems.push(
      '「审批授权已撤销」这个状态没能写入本机存储（存储异常）。\n' +
        '  **本次运行期间不会自动重新授权**，但重启 App 后可能失效。\n' +
        '  建议重启后到「我的」页确认审批授权仍显示为「已撤销」，\n' +
        '  必要时在电脑上手动移除这台设备。',
    );
  }
  if (result.local.pendingSends === 'failed') {
    problems.push(
      '待发送消息记录没能确认清除。\n' +
        '  这些记录可能仍留在本机安全存储里，建议重启后再次执行清除。',
    );
  }

  // 不该发生：调用方只在 !isFullyClear 时进来
  if (problems.length === 0) return;

  Alert.alert(
    '已清除本机授权，但有部分内容未能确认',
    `凭据主体已清除，下面这些没能确认完成：\n\n  · ${problems.join('\n  · ')}`,
    [{ text: '知道了' }],
  );
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

/**
 * 在迁移**动手之前**先看一眼：旧版里用户是不是主动断开过？（P1-2）
 *
 * ## 为什么必须提前看
 *
 * 旧版本 `signOut()` 会把当前 Cookie **复制**到 `@dsh/lastCookie` 再删
 * `@dsh/cookie`。所以：
 *
 *   · `@dsh/cookie` 有值        → 旧版里是「正常已登录」
 *   · 只有 `@dsh/lastCookie`    → 旧版里用户**点过「断开连接」**
 *
 * 而 `migrateLegacyCredentials()` 会把这个键删掉（它本来就是一份应该
 * 消失的明文副本）。于是「用户主动退出过」这个证据只存在于
 * **迁移之前**的那一瞬间。
 *
 * 原来的代码是迁移完才 `void setLoginIntent('signed-out')` —— 既不 await，
 * 也不看结果。那段窗口里 App 被系统杀掉，证据已经没了、意图也没写成，
 * 下次启动就会自动登录回去。
 *
 * 所以这里在迁移前先读一次，把「要不要写 signed-out」这个判断提前。
 *
 * ## 读失败怎么办
 *
 * 返回 `unknown: true` 且**不**声称任何结论。调用方按「证据不明」处理
 * （不自动登录），并在迁移报告上体现风险 —— 宁可让用户点一下
 * 「直接继续」，也不能替他做一个「其实你已经退出了」的猜测。
 *
 * ⚠️ 这个函数只读 `@dsh/lastCookie` 是否存在，**不读取也不返回它的值**
 * —— 那个值是完整可用的认证凭据，绝不能流到日志或界面里。
 */
async function peekLegacySignedOutEvidence(): Promise<{
  /** 只有 lastCookie、没有当前 cookie —— 旧版里用户主动断开过 */
  fromLastCookieOnly: boolean;
  /** 读存储失败，证据不明 */
  unknown: boolean;
}> {
  try {
    const entries = await AsyncStorage.multiGet([
      LegacyCredentialKey.cookie,
      LegacyCredentialKey.lastCookie,
    ]);
    const map = new Map(entries);
    const hasCookie = !!map.get(LegacyCredentialKey.cookie);
    const hasLastCookie = !!map.get(LegacyCredentialKey.lastCookie);
    return {
      // 当前登录态还在 → 不是「主动断开」；只有备份 → 是
      fromLastCookieOnly: hasLastCookie && !hasCookie,
      unknown: false,
    };
  } catch {
    return { fromLastCookieOnly: false, unknown: true };
  }
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
  /** 本机审批授权已撤销（禁止自动配对） */
  const [approvalRevoked, setApprovalRevoked] = useState(false);
  /** 安全存储 / 迁移失败说明（null = 正常） */
  const [secureStorageError, setSecureStorageError] = useState<string | null>(null);

  const pendingSends = useMemo(() => new PendingSendStore(), []);

  const store = useMemo(() => {
    // ⚠️ baseUrl 在「未配对 / 刚清过数据」时是空字符串。
    //
    // DshConnection 的构造函数会对地址做安全校验，而 `new URL('')`
    // 直接抛异常 —— 于是构造就失败了。这个异常发生在 useMemo 里，
    // 属于渲染期错误，整个组件树会被 React 卸载，用户看到的是
    // 满屏红色 Render Error，**连配对页都到不了**。
    //
    // 实测：模拟器上清空应用数据后首次启动必然复现（Android 15 /
    // Pixel 6 AVD）。真机上「换手机 / 重装 App」也是同样的路径。
    //
    // 修法：地址还没配好时给一个占位值构造连接对象。这个 store 只用于
    // 撑住 context 的初始状态，用户填完地址后 baseUrl 变化会重建它，
    // 真正的请求都要经过 assertSecureUrl，占位地址发不出去。
    //
    // 占位用 localhost 而不是随便一个字符串：它是合法的私有地址，
    // 万一日后有人漏了判空，请求也只会打在手机自己身上，
    // 不会把凭据发到外部。
    const safeBaseUrl = baseUrl || PLACEHOLDER_BASE_URL;
    const conn = new DshConnection({ baseUrl: safeBaseUrl, cookie });
    return new Store(conn, { pendingSendStore: pendingSends });
  }, [baseUrl, cookie, pendingSends]);

  // P0-1：启动时读取待发送缓存并恢复（不自动重发，只恢复可视状态）。
  useEffect(() => {
    let alive = true;
    void pendingSends.hydrate().catch(() => {
      if (alive) {
        setSecureStorageError(
          '待发送消息缓存读取失败；在恢复安全存储前发送会被阻止。请检查锁屏状态后重启 App。',
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [pendingSends]);

  /**
   * 把迁移结果翻译成界面状态。
   *
   * 只有两种需要告知用户：
   *   · failed        —— 安全存储不可用，凭据没能安全保存
   *   · fromLastCookie —— 旧版本里用户点过「断开连接」，
   *                       这次只恢复「上次配对」，不自动登录
   *
   * 其余情况静默（迁移成功对用户应该是无感的）。
   *
   * 注意：**不打印任何凭据值**，报告里只有键名。
   */
  const applyMigrationReport = useCallback((report: CredentialMigrationReport) => {
    if (report.status === 'failed') {
      setSecureStorageError(
        report.error ?? '凭据没能保存到安全存储，请检查系统锁屏设置后重试',
      );
      return;
    }
    setSecureStorageError(null);
  }, []);

  // ── 「审批授权已撤销」的唯一事实来源 ──────────────────────────
  //
  // 之前这里只有一份 React state（approvalRevoked），由 App 自己维护。
  // 问题是服务端 4003 那条路径在网关内部直接置撤销状态，**不会**回来
  // 更新 React state —— 于是：
  //   · store.gatewayStatus 显示「已撤销授权」
  //   · 但「我的」页的「重新授权审批」入口不出现（它看的是 React state）
  // 两个事实来源描述同一个安全决定，还会往不同方向漂。
  //
  // 现在统一成：store 是唯一来源（它自己会 emit 通知订阅者），
  // App 只在启动时把存储里的标记灌进 store。React state 保留一份镜像，
  // 但每次 store 变化都重新对齐，不再各说各话。
  useEffect(() => {
    const unsub = store.subscribe(() => {
      setApprovalRevoked(store.gatewayStatus === 'revoked');
    });
    return unsub;
  }, [store]);

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

        // ── 旧版本明文凭据迁移 ────────────────────────────────────
        //
        // v0.16.0 把凭据搬进 Keystore，但没管老版本留在 AsyncStorage
        // 里的那份。结果：升级上来的用户读不到凭据（被踢回配对页），
        // 而明文副本永远躺在那里。
        //
        // 迁移规则见 core/credentialMigration.ts：先写安全存储并回读
        // 校验，成功后才删明文；失败不静默降级。
        //
        // ⚠️ P1-2：迁移会**删掉 `@dsh/lastCookie`**，而那个键同时又是
        // 「旧版本里用户主动断开过」的**唯一证据**。所以必须在迁移动手
        // 之前，先把这个证据转成持久化的登录意图 —— 否则存在一个窗口：
        //
        //   lastCookie 已删 → signed-out 还没写进去 → App 被杀
        //   → 下次启动：意图键不存在 → loadLoginIntent() 返回 'active'
        //     （升级兼容语义）→ **自动登录**
        //
        // 用户「我主动断开过」的决定就这样丢了。
        //
        // 顺序改成：**先读证据 → 先落意图 → 再迁移**。写意图失败时
        // 不能硬着头皮迁移（那会销毁证据），按下面的降级策略处理。
        const legacyPeek = await peekLegacySignedOutEvidence();
        let exitIntentPersisted: boolean | null = null;
        if (legacyPeek.fromLastCookieOnly) {
          // 旧版里只剩 lastCookie = 用户点过「断开连接」。
          // 先把这个结论持久化，并且**等它落盘**（不再 void 掉）。
          exitIntentPersisted = await setLoginIntent('signed-out').catch(() => false);
        } else if (legacyPeek.unknown) {
          // 读不到证据：不知道用户断开过没有。
          // 当作「退出意图未能确认」处理 —— 下面会移除可自动登录的凭据，
          // 让用户自己点「直接继续」，而不是替他猜。
          exitIntentPersisted = false;
        }

        const migration = await migrateLegacyCredentials();
        applyMigrationReport(migration);

        // 迁移这条路径也要覆盖：万一 peek 没识别出来（比如 cookie 和
        // lastCookie 同时存在但内容是「上次配对」），而迁移报告说
        // fromLastCookie，同样要以 signed-out 为准。
        if (migration.fromLastCookie && exitIntentPersisted === null) {
          exitIntentPersisted = await setLoginIntent('signed-out').catch(() => false);
        }

        const lastCookie = await loadCredential(CredentialKey.cookie);

        // 撤销标记：决定要不要自动建立审批连接。
        // 它和 Cookie 无关 —— 用户撤销的是审批权限，不是登录态。
        //
        // ⚠️ 这里读的是**三态**结论（revoked / unknown / not-revoked）。
        // 不能只取布尔值：读失败时必须让 store 进入 'unknown'，
        // 而不是停留在「未连接」（那样界面和行为会不一致）。
        const revocation = await loadRevocationState();
        setApprovalRevoked(revocation.status === 'revoked');
        // 把持久化的撤销状态灌进 store —— 它才是 UI 的唯一事实来源。
        store.syncRevokedState(revocation.status);

        const savedBase = await AsyncStorage.getItem(BASE_URL_KEY);
        // Cookie 已迁到 Keystore（见 core/secureStore.ts）。
        const savedCookie = lastCookie;
        setHasLastPairing(!!lastCookie);
        // ⚠️ 从存储里读回来的地址要**重新校验**再用。
        //
        // 这个值可能是旧版本写的（当时规则更松）、也可能是备份/迁移带来的。
        // 不校验就直接 setBaseUrlState，等于把「明文只发私有网段」这条规则
        // 交给了写入时的那个版本 —— 而 DshConnection 的构造期校验是最后一道，
        // 这里提前拦掉可以给出更清楚的提示，而不是让用户面对一个构造异常。
        const savedBaseInsecure = savedBase ? checkBaseUrlSecurity(savedBase) : null;
        if (savedBase && !savedBaseInsecure) {
          setBaseUrlState(savedBase);
        } else if (savedBaseInsecure) {
          // 不安全：不恢复地址，也不自动登录（cookie 留着，用户可重新扫码）
          setSecureStorageError(
            `已保存的服务地址不再允许使用：${savedBaseInsecure}\n请重新扫码配对。`,
          );
        }

        // ── 要不要自动登录 ────────────────────────────────────────
        //
        // 判据是**持久化的登录意图**，不是迁移函数的一次性返回值。
        //
        // 之前这里用的是 `!migration.fromLastCookie`，只在第一次启动
        // 是对的：迁移会删掉 @dsh/lastCookie，于是第二次启动
        // fromLastCookie 就变成 false，用户「我主动断开过」的决定
        // 被程序悄悄推翻（见 core/loginIntent.ts 的详细推演）。
        //
        // 现在的规则：
        //   active     → 允许自动登录（有 baseUrl + cookie 才真的进）
        //   signed-out → **不**自动登录，配对页显示「直接继续」
        //   unknown    → 不自动登录（读不到意图时 fail-closed）
        //
        // 另外，迁移刚把 lastCookie 迁进来的那一次（fromLastCookie）
        // 仍然要拦一下：那是「旧版里用户点过断开」的证据。
        const intent = await loadLoginIntent();
        const intentAllowsAutoLogin = intent === 'active';

        // 退出意图**没能落盘**，而本机又有可用 Cookie ——
        // 这是一个真实的跨重启风险：下次启动读不到 signed-out，
        // 会按升级兼容语义自动登录回去。
        //
        // 安全降级：把可用于自动登录的 Cookie 凭据**移除**。
        // 这样即使意图丢了，也没有东西能自动登录 —— 用户重新扫码即可，
        // 而「以为退出了、其实没退」不会发生。
        // （和 P0-1 里「持久化失败就移除可自动恢复的凭据」是同一策略。）
        let exitIntentLost = false;
        if (exitIntentPersisted === false && savedCookie) {
          await clearCredential(CredentialKey.cookie).catch(() => undefined);
          setHasLastPairing(false);
          exitIntentLost = true;
        }

        const autoResume =
          intentAllowsAutoLogin && !migration.fromLastCookie && !exitIntentLost;
        // 用校验过的地址决定要不要自动登录 —— 地址不安全时绝不自动连。
        const usableBase = savedBaseInsecure ? null : savedBase;
        if (usableBase && savedCookie && autoResume) {
          setCookie(savedCookie);
          setAuthed(true);
        } else if (savedCookie && usableBase && !autoResume) {
          // 用户主动断开过（或意图读不出来）：停在配对页，
          // 「直接继续」入口由 hasLastPairing 控制。
          // 这里**不清凭据** —— 用户点一下就能恢复。
        }

        if (exitIntentLost) {
          setSecureStorageError(
            '没能保存「已退出」状态，为避免下次启动自动登录，本机登录凭据已被移除。请重新扫码配对。',
          );
        }

        // ── 明文存储的状态未知 / 迁移失败 → 不自动登录（P1-3）────
        //
        // 「读不到明文存储」不等于「确认没有明文凭据」。那几份明文可能
        // 还躺在磁盘上，只是这次看不见。这种情况下自动登录会把用户
        // 带进一个「凭据可能已泄露」的会话，所以按 fail-closed 拦下。
        if (shouldBlockAutoLogin(migration)) {
          setAuthed(false);
          setCookie(undefined);
          setSecureStorageError(
            migration.error ??
              '无法确认本机是否还留有旧版本的明文凭据，为避免使用可能已泄露的凭据，本次不会自动登录。',
          );
        }
      } catch {
        // 读取失败就当作未登录
      } finally {
        setReady(true);
      }
    })();
    // applyMigrationReport 是稳定的（只在 App 内部用 useState setter）
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // 凭据进 Keystore，不再写 AsyncStorage
    await saveCredential(CredentialKey.cookie, c);
    // 用户主动完成了一次配对 —— 这同时是「明确授权」的动作，
    // 之前被撤销的审批权限应该在这里解禁（见 core/deviceRevocation.ts）。
    await clearApprovalRevoked();
    // 登录意图置回 active：用户刚扫码配对，明确表达了「我要登录」。
    //
    // ⚠️ 顺序：**先存凭据，再写意图**。
    // 崩在中间的话意图还是 signed-out → 下次启动不自动登录，
    // 用户点一下「直接继续」即可。反过来（先写 active 再存凭据）
    // 会留下「意图说已登录但没有凭据」的状态。
    await setLoginIntent('active');
    setApprovalRevoked(false);
    setSecureStorageError(null);
    setCookie(c);
    setAuthed(true);
    setHasLastPairing(true);
  }, []);

  /**
   * 断开连接（**不清除凭据**）。
   *
   * 语义：用户明确表示「这次不自动登录了」，但凭据留在 Keystore 里，
   * 下次打开 App 停在配对页并显示「直接继续」，由用户自己决定要不要恢复。
   *
   * ⚠️ 这里**必须**把登录意图持久化成 `signed-out`。
   *
   * 之前这个函数只改内存 state（setAuthed(false)），什么都没落盘 ——
   * 于是下次启动时「有 cookie 就自动登录」又把用户带回了主界面。
   * 用户点「断开连接」这个动作等于没生效。
   *
   * 它**不**清掉任何旧版明文副本 —— 那是「清除授权」的职责。
   * 断开连接后明文副本如果还在，说明迁移失败了，由启动时的迁移
   * 重试处理（失败会显示 secureStorageError）。
   *
   * 真正的清除用 clearAuthorization()。
   *
   * @returns true 表示意图已确认落盘（用户下次启动确实会停在配对页）；
   *          false 表示没写成功 —— 下次启动可能仍会自动登录，界面要如实告知。
   */
  const signOut = useCallback(async (): Promise<boolean> => {
    // ⚠️ 顺序：先落盘意图，再改内存状态。
    // 崩在中间的话意图已经是 signed-out（方向安全）；
    // 反过来先改内存再落盘，崩了就会「界面已退出但下次启动自动登录」。
    const persisted = await setLoginIntent('signed-out');
    setCookie(undefined);
    setAuthed(false);
    // Cookie 留在 Keystore 里，所以「上次配对」依然可用
    const still = await loadCredential(CredentialKey.cookie);
    setHasLastPairing(!!still);
    return persisted;
  }, []);

  /**
   * 退出并清除所有授权（**不可恢复**）。
   *
   * 清四样东西：
   *   1. 服务端的设备记录（先撤销，再清本地 —— 顺序见下）
   *   2. Keystore 里的 Cookie + 网关 device token + device id
   *   3. AsyncStorage 里的**所有**历史明文凭据副本
   *   4. AsyncStorage 里的派生状态（管家会话、上次工作区、自有会话标记）
   *
   * 为什么必须连带清本地会话状态：
   * 如果只删凭据，下次配对成另一台电脑后，管家会话 id、工作区路径
   * 这些会指向不存在的资源，表现为「打开就报错」或「串到别人的会话」。
   */
  const clearAuthorization = useCallback(async (): Promise<ClearAuthorizationResult> => {
    // ⚠️ 顺序很重要：**先撤销服务端，再清本地**。
    //
    // 反过来的话，本地 deviceId / cookie 已经被删，就没法再证明
    // 「我是这台设备」去调撤销接口 —— 服务端会永远留一条可用记录。
    // 手机丢了场景下，那条记录就是后门。
    //
    // 撤销失败不阻塞本地清理：网络不通时用户仍然应该能清掉本机凭据，
    // 只是服务端那条记录还在（会在界面上提示）。
    //
    // ⚠️ 竞态防护：**先把凭据读进局部变量**，再停网关。
    //
    // 4003（服务端撤销）会异步调用 markApprovalRevoked()，它清
    // gateway token；如果它抢在下面这几行之前落地，这里就会读到
    // deviceId=undefined → 服务端撤销被静默跳过。先读出来就避开这个窗口。
    //
    // ⚠️ 而且读失败**不能**当成「没凭据」静默跳过（P0-2）。
    //
    // 之前 `catch {}` 把 Keystore 读取异常吞掉，随后 `if (cookie && ...)`
    // 为假 → 撤销被跳过 → `revokeFailed` 保持 false → 用户看到「全部成功」。
    // 现在读失败单独记账，结论是 unconfirmed（**不是**成功）。
    let cookie: string | undefined;
    let deviceId: string | undefined;
    let serverDeviceId: string | undefined;
    let credentialReadFailed = false;
    try {
      [cookie, deviceId, serverDeviceId] = await Promise.all([
        loadCredential(CredentialKey.cookie),
        loadCredential(CredentialKey.gatewayDeviceId),
        loadCredential(CredentialKey.gatewayServerDeviceId),
      ]);
    } catch {
      // 读不到 → 无法证明身份 → 撤销一定发不出去，如实记账
      credentialReadFailed = true;
    }

    // ── 服务端撤销 ────────────────────────────────────────────
    //
    // 用 revokeOwnDeviceDetailed 而不是旧的三值版本：后者把
    // 「确认撤销」「确认不存在」「身份无法确认」压在一个字符串里，
    // 上层没法区分该不该对用户声称成功。
    let server: ServerRevokeResult;
    if (credentialReadFailed) {
      server = { kind: 'unconfirmed', reason: '本地凭据读取失败' };
    } else if (!baseUrl) {
      server = { kind: 'unconfirmed', reason: '还没连接过电脑（没有服务地址）' };
    } else if (!cookie) {
      server = { kind: 'unconfirmed', reason: '登录凭据已不在本机' };
    } else if (!deviceId && !serverDeviceId) {
      server = { kind: 'unconfirmed', reason: '本机没有设备标识' };
    } else {
      try {
        const detail = await revokeOwnDeviceDetailed(
          baseUrl,
          cookie,
          deviceId ?? '',
          serverDeviceId,
        );
        switch (detail.kind) {
          case 'revoked':
            server = { kind: 'revoked' };
            break;
          case 'already-gone':
            server = { kind: 'already-gone', how: detail.how };
            break;
          case 'failed':
            server = { kind: 'failed', reason: detail.reason, status: detail.status };
            break;
          case 'unconfirmed':
            server = { kind: 'unconfirmed', reason: detail.reason };
            break;
        }
      } catch {
        // 内部已兜了网络异常，走到这里是意料之外的错误 ——
        // 同样只能报「无法确认」，绝不能报成功。
        server = { kind: 'failed', reason: 'unexpected' };
      }
    }

    // 先停掉网关：否则清凭据的瞬间它可能正好在重连，
    // 拿还没删干净的 token 建起一条新连接。
    //
    // ⚠️ P0-1：这里必须拿到 markApprovalRevoked() 的**持久化结果**。
    //
    // 它现在返回 RevocationPersistResult 而不是 void —— 「撤销标记有没有
    // 真的落盘」和「服务端有没有撤销成功」是两件独立的事，都不能假设。
    // 落盘失败时本次运行仍会拒绝自动配对（内存态是 revoked），
    // 但重启后就没人拦着了，所以必须让用户知道。
    let revocation: RevocationPersistResult = {
      ok: false,
      persisted: 'none',
      memoryOnly: true,
      error: '未能写入撤销状态',
    };
    try {
      revocation = await store.revokeOwnApprovalAuthorization('cleared');
    } catch {
      // 停网关 / 置标记整体失败：再单独尝试一次只置标记的部分，
      // 因为「清掉凭据」不影响「记住撤销决定」这个独立动作。
      try {
        revocation = await markApprovalRevoked('cleared');
      } catch {
        // 彻底失败：保持默认的 ok:false
      }
    }

    // ── 本地：Keystore 凭据 ───────────────────────────────────
    let secureStorage: 'cleared' | 'failed' = 'cleared';
    try {
      await clearAllCredentials();
      // 回读校验：clearCredential 内部把异常吞掉了（「本来就没有也算成功」），
      // 所以必须实际读一次才能断言真的没了。
      const [cookieLeft, tokenLeft, devLeft, srvLeft] = await Promise.all([
        loadCredential(CredentialKey.cookie),
        loadCredential(CredentialKey.gatewayToken),
        loadCredential(CredentialKey.gatewayDeviceId),
        loadCredential(CredentialKey.gatewayServerDeviceId),
      ]);
      if (cookieLeft || tokenLeft || devLeft || srvLeft) secureStorage = 'failed';
    } catch {
      secureStorage = 'failed';
    }

    // ── 本地：历史明文副本 ────────────────────────────────────
    //
    // 用 *Verified 版本：它保证「经回读确认磁盘上没有残留」，
    // 而不是「我调了几次 removeItem」。区别只在存储层异常时才看得出来，
    // 而那正是必须如实告知用户的时候。
    let legacyPlaintext = false;
    try {
      const legacy = await clearLegacyCredentialStorageVerified();
      legacyPlaintext = legacy.verified;
    } catch {
      legacyPlaintext = false;
    }

    // ── 本地：原生 cookie 容器 ────────────────────────────────
    //
    // 这是第三个存储。登录时 `credentials: 'include'` 让 RN 原生层把
    // dsh-auth-* 存进了 CookieManager，和 Keystore 里那份是**两份独立的
    // 凭据**。只清 Keystore 的话下次启动 readCookieFromJar() 会把它读回来，
    // 任何 credentials:'include' 的请求（含 POST /mgw/pair）仍以老用户
    // 身份通过鉴权 —— 「清除授权」等于没清干净。
    let cookieJar: LocalCleanupResult['cookieJar'] = 'unverified';
    try {
      const jar = await clearNativeCookieJarDetailed(baseUrl || undefined);
      cookieJar = jar.kind;
    } catch {
      cookieJar = 'unverified';
    }

    // 派生状态一并清掉（这些不是秘密，但会污染下次配对）
    await Promise.all(
      [
        BUTLER_SESSION_KEY,
        BUTLER_WORKSPACE_KEY,
        BUTLER_WS_SESSIONS_KEY,
        BUTLER_PRIMED_KEY,
        OWNED_KEY,
      ].map((k) => AsyncStorage.removeItem(k).catch(() => undefined)),
    );

    // ── 登录意图也要处理 ──────────────────────────────────────
    //
    // 彻底清除后，下次启动必须停在配对页。
    //
    // ⚠️ 这里**不能**用 clearLoginIntent()（删掉意图键）。
    // 删掉之后 loadLoginIntent() 会返回 `active`（升级兼容语义），
    // 万一凭据没删干净（Keystore 异常 / 明文残留），就会自动登录回
    // 一个本该被清除的账号 —— 正是「清除授权」最不该发生的事。
    //
    // 所以明确写 signed-out：它比「删掉」严格。
    const intentPersisted = await setLoginIntent('signed-out').catch(() => false);
    if (!intentPersisted) {
      // 意图没落盘 → 下次启动可能自动登录。
      // 这和「凭据没清干净」是同级的风险，计入本地失败。
      secureStorage = 'failed';
    }

    // P0-1：待发送记录属于本机授权上下文，彻底清除授权时必须一并清除。
    // signOut（断开连接）不调用这里，保留待发送记录。
    let pendingSends: 'cleared' | 'failed' = 'cleared';
    try {
      await store.pendingSends.ensureHydrated();
      await store.pendingSends.clearAll();
    } catch {
      pendingSends = 'failed';
    }

    setCookie(undefined);
    setAuthed(false);
    setHasLastPairing(false);
    setButlerSessionId(null);
    // 清除授权 = 明确回到了「未授权」状态，界面要能看到
    setApprovalRevoked(true);

    const result: ClearAuthorizationResult = {
      server,
      local: { secureStorage, legacyPlaintext, cookieJar, revocation, pendingSends },
    };

    // ── 如实告知用户 ──────────────────────────────────────────
    //
    // 只有**确认全部干净**才静默。任何一半没做成都要说清楚，
    // 否则用户以为「彻底清了」，实际电脑上 / 本机还留着可用的授权。
    if (!isFullyClear(result)) {
      notifyClearResult(result);
    }

    return result;
  }, [baseUrl, store]);

  /**
   * 撤销本机的审批授权（服务端 + 本地），**保留 Cookie**。
   *
   * 和 clearAuthorization 的区别：
   *   · 这个只撤销「能在手机上批准命令执行」的权限
   *   · 聊天、看会话、文件浏览继续可用（Cookie 不动）
   *
   * 返回两个独立的结果，让界面能如实告知用户哪一半成功了 ——
   * 服务端撤销失败时**绝不能**提示「撤销成功」。
   *
   * ⚠️ P0-2 同一类问题：这里原来用 `revokeOwnDevice()` 的三值结果，
   * 并且**只有**凭据齐全时才发请求；缺凭据时 serverOk 保持 false ——
   * 这一点是对的，但 `outcome === 'already-gone'` 被当成成功同样是
   * 危险的，因为服务端返回 404 可能只是「这个 UUID 不属于这台服务器」。
   * 现在改用 detailed 版本，只有确认类结果才算服务端成功。
   */
  const revokeOwnApproval = useCallback(async () => {
    let serverOk = false;
    let localOk = false;
    let serverReason = '';
    try {
      const [cookie, deviceId, serverDeviceId] = await Promise.all([
        loadCredential(CredentialKey.cookie),
        loadCredential(CredentialKey.gatewayDeviceId),
        loadCredential(CredentialKey.gatewayServerDeviceId),
      ]);
      if (!baseUrl) {
        serverReason = '还没连接过电脑（没有服务地址）';
      } else if (!cookie) {
        serverReason = '登录凭据已不在本机';
      } else if (!deviceId && !serverDeviceId) {
        serverReason = '本机没有设备标识';
      } else {
        const detail = await revokeOwnDeviceDetailed(
          baseUrl,
          cookie,
          deviceId ?? '',
          serverDeviceId,
        );
        // 只有「确认撤销」和「确认本来就没有（身份已验证）」才算成功
        serverOk = detail.kind === 'revoked' || detail.kind === 'already-gone';
        if (!serverOk) {
          serverReason =
            detail.kind === 'failed'
              ? `服务端没撤销成功（${detail.reason}）`
              : detail.kind === 'unconfirmed'
                ? `没能发出撤销请求（${detail.reason}）`
                : '服务端结果无法确认';
        }
      }
    } catch {
      serverOk = false;
      serverReason = '撤销请求出现意外错误';
    }

    // 不管服务端成功与否，本地都必须停连 + 置撤销标记 ——
    // 否则「服务端撤销失败」会变成「本地继续自动配对」，等于没撤销。
    try {
      await store.revokeOwnApprovalAuthorization('self-revoked');
      localOk = true;
    } catch {
      localOk = false;
    }
    setApprovalRevoked(true);
    // 服务端那半没成功 → 必须让用户知道电脑上那条记录可能还在。
    // 只有「本机真的撤销了一部分但服务端不确定」才提示，避免刷屏：
    // 本地成功是常态，提示的重点是服务端残留风险。
    if (!serverOk && localOk) {
      Alert.alert(
        '本机审批已停止，但电脑上的授权没能确认撤销',
        `${serverReason}。\n\n` +
          '本机不会再自动连接审批。但**电脑上这台设备的记录可能仍然有效**。\n' +
          '请联网后重试，或在电脑上打开 DSH 的「设备管理」手动移除这台设备。',
        [{ text: '知道了' }],
      );
    }
    return { serverOk, localOk };
  }, [baseUrl, store]);

  /**
   * 用户主动重新授权审批通道。
   *
   * 只有这个（以及重新配对）会清除「已撤销」标记 ——
   * 网络恢复、自动重连都不得调用。
   *
   * 返回 false 表示「撤销标记没清掉」（存储写失败），此时**不能**
   * 假装重新授权成功了 —— 网关那边仍然会拦住自动配对。
   */
  const reauthorizeApprovals = useCallback(async (): Promise<boolean> => {
    if (!baseUrl) return false;
    const cleared = await clearApprovalRevoked();
    if (!cleared) {
      // 存储删不掉：保持「已撤销」。界面上不能显示成已恢复。
      setApprovalRevoked(true);
      return false;
    }
    setApprovalRevoked(false);
    store.reauthorizeApprovals(baseUrl);
    return true;
  }, [baseUrl, store]);

  /** 用上次的 cookie 直接恢复登录（验证通过才恢复） */
  const resumePairing = useCallback(async (): Promise<boolean> => {
    const last = await loadCredential(CredentialKey.cookie);
    if (!last) return false;
    try {
      const conn = new DshConnection({ baseUrl, cookie: last });
      const probe = new Store(conn);
      const ok = await probe.ping();
      probe.close();
      if (!ok) return false;
      // 用户点了「直接继续」= 明确表达「要恢复登录」。
      // 意图置回 active，之后每次启动都会正常自动登录
      // （而不是每次都弹一次「直接继续」）。
      await setLoginIntent('active');
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
      clearAuthorization,
      butlerMode,
      setButlerMode,
      butlerSessionId,
      butlerBusy,
      butlerNeedWorkspace,
      pickButlerWorkspace,
      butlerWorkspace,
      hasLastPairing,
      resumePairing,
      approvalRevoked,
      reauthorizeApprovals,
      revokeOwnApproval,
      secureStorageError,
    }),
    [
      store,
      baseUrl,
      setBaseUrl,
      saveCookie,
      signOut,
      clearAuthorization,
      butlerMode,
      setButlerMode,
      butlerSessionId,
      butlerBusy,
      butlerNeedWorkspace,
      pickButlerWorkspace,
      butlerWorkspace,
      hasLastPairing,
      resumePairing,
      approvalRevoked,
      reauthorizeApprovals,
      revokeOwnApproval,
      secureStorageError,
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
  const { store, baseUrl, approvalRevoked } = useApp();
  const [, force] = React.useState(0);

  React.useEffect(() => {
    const unsub = store.subscribe(() => force((n) => n + 1));
    store.startNoticeScan();
    return () => {
      unsub();
      store.stopNoticeScan();
    };
  }, [store]);

  // 审批网关：在 App 级连一次，不要绑在聊天页上。
  //
  // 原来是在 ChatScreen 的 useEffect 里 connect，离开页面就 disconnect。
  // 后果：
  //   1. 在会话列表/「我的」页收到审批时无法处理（网关已断）
  //   2. 每进一次会话都要重新申请配对码，路径长了容易失败
  //   3. 「我的」里那个状态永远显示「未连接」，没法用来排查
  // 网关本来就是个轻量旁路连接，常驻更合理。
  //
  // ⚠️ 依赖里**不含** approvalRevoked：撤销后不能因为依赖变化
  // 又跑一遍 connect —— 那正是「撤销后自动重新配对」的入口。
  // 撤销时 store 自己会断开并保持 'revoked'，connectApprovals 也会
  // 自己查撤销标记（见 core/deviceRevocation.ts）。
  React.useEffect(() => {
    if (!baseUrl) return;
    store.connectApprovals(baseUrl);
    return () => store.disconnectApprovals();
  }, [store, baseUrl]);

  // 撤销后（approvalRevoked 变 true）主动断一次，避免界面上还挂着
  // 可点的审批按钮。这里只断不连。
  React.useEffect(() => {
    if (approvalRevoked) store.disconnectApprovals();
  }, [approvalRevoked, store]);

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
    case 'Devices':
      return <DevicesScreen />;
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
