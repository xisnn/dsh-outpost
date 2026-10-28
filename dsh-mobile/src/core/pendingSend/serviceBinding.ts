/**
 * 发送身份绑定：把“这台手机 + 这台 DSH 服务实例 + 当前授权上下文”做成
 * 可持久化比较的稳定标识。
 *
 * 关键原则：
 *   · gatewayId 来自 DSH 网关 `gateway-state.mjs` 持久化的稳定实例 UUID；
 *   · authContextHash 只由 gatewayId + 服务端设备 UUID + 客户端设备 id
 *     派生，**不包含会轮换的 cookie**；
 *   · 地址是独立字段；地址变化时未经重新验证不能自动重试；
 *   · 缺少任何身份字段都返回错误，安全阻断，不生成假 ID。
 */

import { CredentialKey, loadCredential } from '../secureStore';
import {
  fetchServerGatewayId,
  normalizeBaseUrl,
  readServerBindingSnapshot,
} from '../serverIdentity';
import { sha256Hex } from './fingerprint';
import { evaluatePendingSendBinding } from './state';
import type { PendingSendBinding } from './types';

export type PendingSendIdentityErrorCode =
  | 'base-url-missing'
  | 'binding-missing'
  | 'address-changed'
  | 'gateway-missing'
  | 'device-context-missing'
  | 'auth-context-missing'
  | 'remote-identity-unavailable'
  | 'remote-instance-mismatch';

export type RemoteGatewayVerifier = (
  baseUrl: string,
  cookie: string | undefined,
) => Promise<string | undefined>;

export interface LoadPendingSendBindingOptions {
  /** 生产默认 true；本地组装测试可显式 false。 */
  requireRemote?: boolean;
  /** 认证 cookie；requireRemote=true 时必须有。 */
  cookie?: string;
  verifyRemote?: RemoteGatewayVerifier;
}

export class PendingSendIdentityError extends Error {
  readonly code: PendingSendIdentityErrorCode;

  constructor(code: PendingSendIdentityErrorCode, message: string) {
    super(message);
    this.name = 'PendingSendIdentityError';
    this.code = code;
  }
}

/**
 * 读取并验证当前服务身份。
 *
 * `requireRemote` 默认 true：除本地 Keychain 绑定外，还必须用当前登录 cookie
 * 请求已认证的 `/mgw/status`，拿到**实时 gatewayId**并与本地绑定比对。
 * 只读本地缓存不能作为“当前服务器仍是同一实例”的证明；地址相同也可能
 * 已经被另一台机器占用。
 */
export async function loadPendingSendBinding(
  currentBaseUrl: string,
  options: LoadPendingSendBindingOptions = {},
): Promise<PendingSendBinding> {
  const baseUrl = normalizeBaseUrl(currentBaseUrl);
  if (!baseUrl) {
    throw new PendingSendIdentityError('base-url-missing', '当前没有可用的服务地址');
  }

  const binding = await readServerBindingSnapshot();
  if (!binding) {
    throw new PendingSendIdentityError(
      'binding-missing',
      '本机没有可验证的服务端身份绑定，请重新配对',
    );
  }
  if (normalizeBaseUrl(binding.baseUrl) !== baseUrl) {
    // 地址变化后不能拿旧绑定直接发到新地址 —— 必须先重新配对验证。
    throw new PendingSendIdentityError(
      'address-changed',
      '服务地址已变化，尚未重新验证服务器身份，不能发送或重试',
    );
  }
  if (!binding.gatewayId) {
    throw new PendingSendIdentityError(
      'gateway-missing',
      '服务端没有提供稳定实例标识，无法安全发送',
    );
  }

  const [serverDeviceId, clientDeviceId] = await Promise.all([
    loadCredential(CredentialKey.gatewayServerDeviceId),
    loadCredential(CredentialKey.gatewayDeviceId),
  ]);
  if (!serverDeviceId || !clientDeviceId) {
    throw new PendingSendIdentityError(
      'device-context-missing',
      '缺少服务端设备标识或本机设备标识，无法确认授权上下文',
    );
  }

  // 不包含 cookie：cookie 会正常轮换，不能当作不可变身份。
  const authContextHash = sha256Hex(
    JSON.stringify({
      v: 1,
      gatewayId: binding.gatewayId,
      serverDeviceId,
      clientDeviceId,
    }),
  );

  if (options.requireRemote !== false) {
    if (!options.cookie) {
      throw new PendingSendIdentityError(
        'auth-context-missing',
        '没有当前登录凭据，无法进行已认证的服务器身份验证',
      );
    }
    const verify = options.verifyRemote ?? fetchServerGatewayId;
    const remoteGatewayId = await verify(baseUrl, options.cookie);
    if (!remoteGatewayId) {
      throw new PendingSendIdentityError(
        'remote-identity-unavailable',
        '无法通过已认证请求确认当前服务器实例身份',
      );
    }
    if (remoteGatewayId !== binding.gatewayId) {
      throw new PendingSendIdentityError(
        'remote-instance-mismatch',
        '当前连接的服务器实例与本地绑定不一致',
      );
    }
  }

  return {
    baseUrl,
    gatewayId: binding.gatewayId,
    authContextHash,
    identityQuality: 'confirmed',
  };
}

/**
 * 重试前验证：本地绑定三项 + 已认证远端 gatewayId 必须同时匹配。
 *
 * 任何一项失败都抛 PendingSendIdentityError，调用方不得继续发送。
 */
export async function verifyPendingSendBinding(
  expected: PendingSendBinding,
  currentBaseUrl: string,
  cookie: string | undefined,
  verifyRemote: RemoteGatewayVerifier = fetchServerGatewayId,
): Promise<void> {
  const local = await loadPendingSendBinding(currentBaseUrl, { requireRemote: false });
  const verdict = evaluatePendingSendBinding(expected, {
    baseUrl: local.baseUrl,
    gatewayId: local.gatewayId,
    authContextHash: local.authContextHash,
  });
  if (!verdict.ok) {
    throw new PendingSendIdentityError(
      verdict.reason === 'service-address-changed'
        ? 'address-changed'
        : verdict.reason === 'server-instance-changed'
          ? 'remote-instance-mismatch'
          : verdict.reason === 'authorization-context-changed'
            ? 'device-context-missing'
            : 'remote-identity-unavailable',
      `发送身份验证失败：${verdict.reason}`,
    );
  }
  if (!cookie) {
    throw new PendingSendIdentityError(
      'auth-context-missing',
      '没有当前登录凭据，无法进行已认证的服务器身份验证',
    );
  }
  const remoteGatewayId = await verifyRemote(local.baseUrl, cookie);
  if (!remoteGatewayId) {
    throw new PendingSendIdentityError(
      'remote-identity-unavailable',
      '无法通过已认证请求确认当前服务器实例身份',
    );
  }
  if (remoteGatewayId !== expected.gatewayId) {
    throw new PendingSendIdentityError(
      'remote-instance-mismatch',
      '当前连接的服务器实例与待发送记录不一致',
    );
  }
}
