/**
 * 手机端提醒：震动 + 系统通知。
 *
 * ## 为什么是「本地通知」而不是「远程推送」
 *
 * DSH 没有 webhook / push 机制（asar 里那些 webhooks 是 standardwebhooks
 * 第三方 SDK 的代码，不是 DSH 的能力），FCM 要 Google 服务国内收不到，
 * Web Push 在 RN 里做不到。
 *
 * 所以走本地通知：App 在后台轮询时发现任务完成/需要审批，立刻弹通知。
 * 不需要任何外部服务，国内手机也能用。
 *
 * ## 局限（说清楚，别让用户误以为万能）
 *
 * App 被系统杀掉后收不到 —— 安卓会杀后台。要真正做到杀进程也能收，
 * 只能接厂商推送通道（小米/华为/OPPO 各自的 SDK），工作量远超本项目。
 *
 * ## 为什么用 react-native-notify-kit 而不是 Notifee
 *
 * Notifee 已经归档（archived），官方 README 指向 react-native-notify-kit
 * 作为「支持新架构的维护版」。API 是 Notifee 兼容的，迁移成本低。
 * 我们用的 RN 0.81 + Fabric 必须要支持新架构的版本。
 *
 * ## 降级策略
 *
 * 原生模块加载失败（没重编 APK、或者跑在 Expo Go 里）时，
 * 自动退回「只有震动 + 应用内横幅」，不让整个 App 崩。
 */

import { AppState, Platform, Vibration } from 'react-native';

// 延迟加载原生模块：加载失败时降级，而不是整个 App 起不来
type NotifeeModule = {
  requestPermission: () => Promise<{ authorizationStatus: number }>;
  createChannel: (c: {
    id: string;
    name: string;
    importance: number;
    vibration?: boolean;
    sound?: string;
  }) => Promise<string>;
  displayNotification: (n: {
    title: string;
    body: string;
    data?: Record<string, string>;
    android?: {
      channelId?: string;
      smallIcon?: string;
      pressAction?: { id: string };
      importance?: number;
      autoCancel?: boolean;
    };
  }) => Promise<string>;
  getInitialNotification: () => Promise<{
    notification?: { data?: Record<string, string> };
  } | null>;
  onForegroundEvent: (
    cb: (evt: {
      type: number;
      detail?: { notification?: { data?: Record<string, string> } };
    }) => void,
  ) => () => void;
};

/**
 * AndroidImportance / EventType 是 TypeScript 的 `enum`，
 * 编译成 JS 后**不在默认导出对象上** —— 直接读 notifee.AndroidImportance.HIGH
 * 会拿到 undefined，然后 `.HIGH` 报 "Cannot read property 'HIGH' of undefined"。
 *
 * 这里用它们的实际数值（见 dist/types/NotificationAndroid.d.ts 和
 * Notification.d.ts 里的 enum 定义），比依赖运行时对象稳。
 */
const ANDROID_IMPORTANCE_HIGH = 4;
const EVENT_TYPE_PRESS = 1;

let notifee: NotifeeModule | null = null;
let notifeeTried = false;
let channelReady = false;
/** 上次初始化失败的原因（给自测入口显示用） */
let lastError = '';

/** 读一下初始化状态，供自测入口显示 */
export function notifyDebugState(): string {
  if (!notifeeTried) return '未初始化';
  if (!notifee) return `原生模块加载失败${lastError ? `：${lastError}` : ''}`;
  if (!channelReady) return `通道未就绪${lastError ? `：${lastError}` : ''}`;
  return '就绪';
}

/** 懒加载原生通知模块。失败返回 null，调用方负责降级。 */
async function getNotifee(): Promise<NotifeeModule | null> {
  if (notifeeTried) return notifee;
  notifeeTried = true;
  try {
    const mod = await import('react-native-notify-kit');
    const m = (mod as { default?: unknown }).default ?? mod;
    notifee = m as NotifeeModule;
    return notifee;
  } catch {
    notifee = null;
    return null;
  }
}

/** 通知通道 id（Android 8+ 必须建通道才能弹通知） */
const CHANNEL_ID = 'dsh-task';

/** 通知开关（用户可在设置里关掉） */
let enabled = true;

/** 上次提醒时间，避免短时间内连续震动 */
let lastAt = 0;
const MIN_GAP_MS = 3000;

export function setNotifyEnabled(v: boolean): void {
  enabled = v;
}

export function isNotifyEnabled(): boolean {
  return enabled;
}

/**
 * 初始化通知能力：申请权限 + 建通道。
 *
 * 必须在 App 启动时调一次。失败不抛错（用户可能拒绝了权限，
 * 那就只走震动 + 应用内横幅）。
 */
export async function initNotifications(): Promise<boolean> {
  const nf = await getNotifee();
  if (!nf) return false;
  try {
    const perm = await nf.requestPermission();
    if (Platform.OS === 'android') {
      await nf.createChannel({
        id: CHANNEL_ID,
        name: '任务提醒',
        importance: ANDROID_IMPORTANCE_HIGH,
        vibration: true,
      });
    }
    channelReady = true;
    lastError = '';
    // 授权状态：1 = 已授权
    return (perm?.authorizationStatus ?? 0) >= 1;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/**
 * 震动。
 *
 * ⚠️ Android 必须声明 `android.permission.VIBRATE`，否则原生层会抛
 * SecurityException（"Neither user ... nor current process has
 * android.permission.VIBRATE"）。这个异常在 try/catch 里**抓不到** ——
 * 它是原生线程抛的，直接把 App 崩掉。实测崩过一次。
 *
 * 所以：manifest 里必须有 VIBRATE 权限（已加），这里再包一层防御。
 */
export function vibrateShort(kind: 'done' | 'ask' = 'done'): void {
  try {
    if (Platform.OS === 'android') {
      // 两短震：0ms 等 → 60ms 震 → 80ms 等 → 60ms 震
      Vibration.vibrate(kind === 'done' ? [0, 60, 80, 60] : [0, 40]);
    } else {
      Vibration.vibrate(80);
    }
  } catch {
    // 某些设备/权限下震动不可用，静默忽略
  }
}

/**
 * 弹一条系统通知（后台也能看到）。
 *
 * 原生模块不可用时静默失败 —— 调用方仍然有震动和应用内横幅兜底。
 *
 * @param title 标题
 * @param body 正文
 * @param sessionId 点了通知要跳去的会话
 */
export async function showSystemNotification(
  title: string,
  body: string,
  sessionId?: string,
): Promise<void> {
  if (!enabled) return;
  const nf = await getNotifee();
  if (!nf || !channelReady) return;
  try {
    await nf.displayNotification({
      title,
      body,
      data: sessionId ? { sessionId } : {},
      android: {
        channelId: CHANNEL_ID,
        smallIcon: 'ic_launcher',
        pressAction: { id: 'default' },
        importance: ANDROID_IMPORTANCE_HIGH,
        autoCancel: true,
      },
    });
  } catch {
    // 通知失败不影响主流程
  }
}

/**
 * 任务完成提醒。
 *
 * @param text 提示文字
 * @param force 忽略节流（用户主动触发的操作传 true）
 * @param opts 额外信息（会话 id、副标题）
 */
export function notifyDone(
  text: string,
  force = false,
  opts?: { sessionId?: string; detail?: string },
): void {
  if (!enabled) return;

  const now = Date.now();
  if (!force && now - lastAt < MIN_GAP_MS) return;
  lastAt = now;

  vibrateShort('done');

  // 系统通知：前台也弹（用户可能正在看别的页面）。
  // 不 await —— 通知是锦上添花，不能阻塞调用方。
  void showSystemNotification(
    opts?.detail ? `${opts.detail}` : 'DSH',
    text,
    opts?.sessionId,
  );
}

/** 设备是否在前台 */
export function isForeground(): boolean {
  try {
    return AppState.currentState === 'active';
  } catch {
    return true;
  }
}

/**
 * 注册「点通知跳会话」的监听。
 *
 * @param onOpen 收到会话 id 时调用
 * @returns 取消订阅函数
 */
export async function onNotificationOpen(
  onOpen: (sessionId: string) => void,
): Promise<() => void> {
  const nf = await getNotifee();
  if (!nf) return () => undefined;

  // 冷启动：App 是被通知点开的
  try {
    const initial = await nf.getInitialNotification();
    const sid = initial?.notification?.data?.sessionId;
    if (sid) onOpen(sid);
  } catch {
    /* ignore */
  }

  // 前台/后台点击
  try {
    return nf.onForegroundEvent((evt) => {
      if (evt.type !== EVENT_TYPE_PRESS) return;
      const sid = evt.detail?.notification?.data?.sessionId;
      if (sid) onOpen(sid);
    });
  } catch {
    return () => undefined;
  }
}
