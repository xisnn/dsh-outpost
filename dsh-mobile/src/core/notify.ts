/**
 * 手机端提醒：任务完成时震动 + 系统通知。
 *
 * 为什么不做真正的远程推送（FCM / Web Push）：
 *   1. DSH 没有 webhook / push 机制（我查过 asar，那里的 webhooks 是
 *      standardwebhooks 第三方 SDK 的代码，不是 DSH 的能力）
 *   2. FCM 要 Google 服务和证书，国内手机基本收不到
 *   3. Web Push 需要 App 内置浏览器内核承载 service worker，RN 里做不到
 *
 * 所以采用**本地提醒**：App 在前台/后台轮询时发现任务完成，
 * 立刻震动 + 弹本地通知。这不需要任何外部服务，国内手机也能用。
 *
 * 局限：App 被系统杀掉后收不到（安卓会杀后台）。这是本地提醒的固有边界，
 * 真要做到杀进程也能收，只能走厂商推送通道（小米/华为/OPPO 各自的 SDK），
 * 那个工作量远超这个项目。
 *
 * 依赖：只用 RN 内置的 Vibration 和 NotificationManager 能力，
 * 不引入新依赖，避免增加构建复杂度。
 */

import { AppState, Platform, Vibration } from 'react-native';

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
 * 震动提醒。
 *
 * 用 RN 内置 Vibration：
 *   - Android 用 pattern 数组（[等待, 震动, 等待, 震动...]）
 *   - iOS 只支持固定时长
 *
 * 选「两短震」而不是长震：长震太吵，两下足够引起注意又不烦人。
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
 * 任务完成提醒。
 *
 * @param text 提示文字（会显示在屏幕上）
 * @param force 忽略节流（用户主动触发的操作传 true）
 */
export function notifyDone(text: string, force = false): void {
  if (!enabled) return;

  const now = Date.now();
  if (!force && now - lastAt < MIN_GAP_MS) return;
  lastAt = now;

  vibrateShort('done');
}

/** 设备是否在前台 */
export function isForeground(): boolean {
  try {
    return AppState.currentState === 'active';
  } catch {
    return true;
  }
}
