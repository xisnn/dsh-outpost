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
import { normalizeBaseUrl, readServerBindingSnapshot } from '../serverIdentity';
import { sha256Hex } from './fingerprint';
import type { PendingSendBinding } from './types';

export type PendingSendIdentityErrorCode =
  | 'base-url-missing'
  | 'binding-missing'
  | 'address-changed'
  | 'gateway-missing'
  | 'device-context-missing';

export class PendingSendIdentityError extends Error {
  readonly code: PendingSendIdentityErrorCode;

  constructor(code: PendingSendIdentityErrorCode, message: string) {
    super(message);
    this.name = 'PendingSendIdentityError';
    this.code = code;
  }
}

/**
 * 读取当前可验证的服务身份。
 *
 * 只有已经持久化的 gatewayServerBinding 与当前连接地址一致、且
 * gatewayId / gatewayServerDeviceId / gatewayDeviceId 都可用时，才返回
 * `confirmed` 绑定。否则抛出 PendingSendIdentityError，让上层阻止发送。
 */
export async function loadPendingSendBinding(currentBaseUrl: string): Promise<PendingSendBinding> {
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

  return {
    baseUrl,
    gatewayId: binding.gatewayId,
    authContextHash,
    identityQuality: 'confirmed',
  };
}
