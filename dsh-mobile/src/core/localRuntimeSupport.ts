/** React Native 侧的本机运行环境能力探测（不触发安装/启动/模型请求）。 */
import { NativeModules, Platform } from 'react-native';

import { localRuntimeSupported } from './hostLocation';

export function p6AgentAvailable(): boolean {
  return Platform.OS === 'android' && Boolean(NativeModules.OutpostAgent);
}

export function legacyLocalRuntimeAvailable(): boolean {
  const bridge = NativeModules.OutpostLocalDsh as
    | { hasBundledRuntime?: boolean }
    | undefined;
  if (!localRuntimeSupported(Platform.OS, bridge)) return false;
  // Older packages do not expose this constant. Only an explicit false hides
  // the legacy local path; absence preserves compatibility for old builds.
  return bridge?.hasBundledRuntime !== false;
}

export function localRuntimeAvailable(): boolean {
  // The P6 native agent is the new local execution path. Only fall back to the
  // legacy DSH package when it actually carries its runtime payload.
  return p6AgentAvailable() || legacyLocalRuntimeAvailable();
}
