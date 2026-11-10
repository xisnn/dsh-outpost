/**
 * 管家执行位置（P3）。
 *
 * ## 位置是什么
 *
 * 只描述**管家任务在哪里执行**：
 *   - `desktop`：已配对的电脑 Host，沿用现有 REST + 审批网关；
 *   - `local`：手机本机运行环境（P1/P2 的 RuntimeSupervisor + 本机 DSH）。
 *
 * 它**不是**全局连接模式：普通聊天、工作区、配对与电脑模式都不受影响。
 * 因此默认值必须是 `desktop`，老安装升级后行为与升级前完全一致。
 *
 * ## 为什么默认 `desktop`
 *
 * 旧版本没有这个键。读不到、读到非法值、存储故障时都回落到 `desktop`：
 * 宁可让用户回到已经可用的电脑链路，也不要在启动时把管家指到一个
 * 尚未准备好运行环境的位置。
 */

export type HostLocation = 'desktop' | 'local';

/** 持久化 key：新增键，不改动任何既有 key 的语义。 */
export const HOST_LOCATION_KEY = '@dsh/hostLocation';

export const DEFAULT_HOST_LOCATION: HostLocation = 'desktop';

export interface HostLocationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
}

/** 非法/缺失值一律按电脑处理，防止旧数据或损坏数据把管家指错位置。 */
export function parseHostLocation(value: string | null | undefined): HostLocation {
  return value === 'local' ? 'local' : 'desktop';
}

export async function loadHostLocation(storage: HostLocationStorage): Promise<HostLocation> {
  try {
    return parseHostLocation(await storage.getItem(HOST_LOCATION_KEY));
  } catch {
    return DEFAULT_HOST_LOCATION;
  }
}

export async function saveHostLocation(
  storage: HostLocationStorage,
  location: HostLocation,
): Promise<void> {
  await storage.setItem(HOST_LOCATION_KEY, location);
}

/**
 * 本机运行环境是否可用。
 *
 * 只做能力声明，不触发安装、启动或模型请求。参数显式传入，便于在没有
 * React Native 的 Node 单测里覆盖 iOS / 缺少原生模块的情形。
 */
export function localRuntimeSupported(platform: string, nativeModule: unknown): boolean {
  return platform === 'android' && Boolean(nativeModule);
}
