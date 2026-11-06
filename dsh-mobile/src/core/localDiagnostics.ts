import {REQUIRED_ENDPOINTS, OPTIONAL_ENDPOINTS} from './protocol';

interface DiagnosticInput {
  version?: unknown;
  platform?: unknown;
  platformVersion?: unknown;
  connection?: unknown;
  authInvalidated?: unknown;
  gatewayStatus?: unknown;
  butlerMode?: unknown;
  missingEndpoints?: unknown;
  notifyEnabled?: unknown;
  notifyState?: unknown;
}
const allowedEndpoints = new Set<string>([...REQUIRED_ENDPOINTS, ...OPTIONAL_ENDPOINTS]);
function enumValue(value: unknown, allowed: readonly string[], fallback = 'unknown'): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
function notificationState(value: unknown): string {
  if (value === '就绪') return 'ready';
  if (value === '未初始化') return 'not-initialized';
  if (typeof value !== 'string') return 'unknown';
  if (value.startsWith('原生模块加载失败')) return 'unavailable';
  if (value.startsWith('通道未就绪')) return 'channel-unavailable';
  return 'unknown';
}
/** Deliberately constructs every field. Never spread/serialize Store, logs, URLs or errors. */
export function buildLocalDiagnostics(input: DiagnosticInput) {
  const connection = enumValue(input.connection, ['idle', 'connecting', 'connected', 'error']);
  const platformVersion = typeof input.platformVersion === 'number' && Number.isInteger(input.platformVersion) && input.platformVersion >= 0 && input.platformVersion < 1000
    ? input.platformVersion
    : typeof input.platformVersion === 'string' && /^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(input.platformVersion) ? input.platformVersion : null;
  const missingEndpoints = Array.isArray(input.missingEndpoints)
    ? [...new Set(input.missingEndpoints.filter((value): value is string => typeof value === 'string' && allowedEndpoints.has(value)))] : [];
  return {
    format: 'outpost-local-diagnostics/v1',
    generatedAt: new Date().toISOString(),
    appVersion: typeof input.version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.version) ? input.version : 'unknown',
    platform: enumValue(input.platform, ['android', 'ios'], 'other'),
    platformVersion,
    chat: {
      connection,
      accessBlocked: input.authInvalidated === true,
      errorCategory: input.authInvalidated === true ? 'access-blocked' : connection === 'error' ? 'connection-error' : 'none',
    },
    approval: {status: enumValue(input.gatewayStatus, ['idle', 'connecting', 'online', 'offline', 'revoked', 'unknown'])},
    butlerMode: typeof input.butlerMode === 'boolean' ? input.butlerMode : null,
    compatibility: {requiredEndpoints: [...REQUIRED_ENDPOINTS], optionalEndpoints: [...OPTIONAL_ENDPOINTS], missingEndpoints},
    notifications: {
      enabled: typeof input.notifyEnabled === 'boolean' ? input.notifyEnabled : null,
      initialization: notificationState(input.notifyState),
    },
  };
}
