/**
 * 待发送文档的安全持久化后端。
 *
 * 重要 Android 事实（已按 react-native-keychain 10.0.0 源码核对）：
 *   · Android 走 CipherStorageKeystoreAesGcm：Android Keystore 中的
 *     AES-256/GCM/NoPadding 密钥，数据以密文形式写入 DataStore。
 *   · `accessible` 是 **iOS/visionOS** 选项，Android 模块根本不读取它；
 *     不能在 Android 上把 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 当成安全保证。
 *   · 因此 Android 侧显式要求 `storage: KeystoreAESGCM_NoAuth`，并校验
 *     setGenericPassword 返回的实际 storage。最终安全结论以 Android
 *     真机/模拟器实测报告为准（见 docs/v0.17/ANDROID-SECURE-STORAGE-VERIFY.md）。
 *
 * 整个文档作为一个 keychain item 写入，保证一次写入的原子性；调用方
 * （PendingSendStore）负责串行化和写后回读校验。
 */

/** Keychain service 名：独立于凭据，便于单独清理和审计。 */
export const PENDING_SEND_KEYCHAIN_SERVICE = 'com.dshpocket.pendingSends.v1';

/** Android 上要求的具体 cipher；与 react-native-keychain 的 STORAGE_TYPE 枚举一致。 */
export const ANDROID_PENDING_SEND_STORAGE = 'KeystoreAESGCM_NoAuth';

/** iOS 上的可访问性；Android 不读取此字段。 */
export const IOS_PENDING_SEND_ACCESSIBLE = 'AccessibleWhenUnlockedThisDeviceOnly';

export class PendingSendPersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'PendingSendPersistenceError';
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface PendingSendPersistence {
  readRaw(): Promise<string | undefined>;
  writeRaw(value: string): Promise<void>;
  clear(): Promise<void>;
}

type KeychainResult = { service?: string; storage?: string };
type KeychainCredentials = { username: string; password: string; service?: string };

interface KeychainLike {
  setGenericPassword(
    username: string,
    password: string,
    options?: Record<string, unknown>,
  ): Promise<KeychainResult | unknown>;
  getGenericPassword(options?: Record<string, unknown>): Promise<false | KeychainCredentials>;
  resetGenericPassword(options?: Record<string, unknown>): Promise<unknown>;
}

let keychainModule: KeychainLike | null = null;

/**
 * 运行时读取平台；不能顶层 `import { Platform } from 'react-native'`：
 * RN 入口是 Flow 语法，Node/tsx 的 esbuild 会在加载测试时直接解析失败。
 * 与 core/secureStore.ts 的延迟加载策略一致。
 */
function getPlatformOS(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rn = require('react-native') as { Platform?: { OS?: string } };
    return rn?.Platform?.OS ?? 'android';
  } catch {
    return 'android';
  }
}

function getKeychain(): KeychainLike {
  if (keychainModule) return keychainModule;
  // 延迟加载：react-native-keychain 的入口依赖 react-native Flow 代码，
  // Node 测试必须能先用 shim 替换它。与 core/secureStore.ts 同一做法。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('react-native-keychain') as KeychainLike | { default: KeychainLike };
  keychainModule = 'default' in mod ? mod.default : mod;
  return keychainModule;
}

export class KeychainPendingSendPersistence implements PendingSendPersistence {
  private readonly keychain: KeychainLike;
  private readonly platformOS: string;

  constructor(keychain: KeychainLike = getKeychain(), platformOS: string = getPlatformOS()) {
    this.keychain = keychain;
    this.platformOS = platformOS;
  }

  private options(): Record<string, unknown> {
    const opts: Record<string, unknown> = { service: PENDING_SEND_KEYCHAIN_SERVICE };
    if (this.platformOS === 'android') {
      // 不用 accessible；Android 不读它。显式锁死非认证 AES-GCM。
      opts.storage = ANDROID_PENDING_SEND_STORAGE;
    } else {
      opts.accessible = IOS_PENDING_SEND_ACCESSIBLE;
      opts.cloudSync = false;
    }
    return opts;
  }

  async readRaw(): Promise<string | undefined> {
    let res: false | KeychainCredentials;
    try {
      res = await this.keychain.getGenericPassword({
        service: PENDING_SEND_KEYCHAIN_SERVICE,
      });
    } catch (e) {
      throw new PendingSendPersistenceError(
        'keychain-read-failed',
        '安全存储读取失败',
        e,
      );
    }
    if (!res) return undefined;
    return res.password;
  }

  async writeRaw(value: string): Promise<void> {
    let res: unknown;
    try {
      res = await this.keychain.setGenericPassword('pending-sends', value, this.options());
    } catch (e) {
      throw new PendingSendPersistenceError(
        'keychain-write-failed',
        '安全存储写入失败',
        e,
      );
    }
    if (this.platformOS === 'android') {
      const storage = (res as KeychainResult | undefined)?.storage;
      if (storage !== ANDROID_PENDING_SEND_STORAGE) {
        throw new PendingSendPersistenceError(
          'unexpected-android-storage',
          `Android 实际存储不是 ${ANDROID_PENDING_SEND_STORAGE}（收到 ${String(storage)}）`,
        );
      }
    }
  }

  async clear(): Promise<void> {
    try {
      await this.keychain.resetGenericPassword({
        service: PENDING_SEND_KEYCHAIN_SERVICE,
      });
    } catch (e) {
      throw new PendingSendPersistenceError(
        'keychain-clear-failed',
        '安全存储清除失败',
        e,
      );
    }
  }
}
