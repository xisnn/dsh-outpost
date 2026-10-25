/**
 * 凭据的安全存储。
 *
 * ## 为什么不能放 AsyncStorage
 *
 * 之前 Cookie 和审批网关的 device token 都存在 AsyncStorage 里。它是
 * 明文（SQLite/SharedPreferences），只在**应用沙箱**这一层受保护：
 *
 *   · Android 的 `adb backup` 能导出（如果 allowBackup 为 true）
 *   · root 设备、或者拿到应用数据目录的人能直接读
 *   · 云备份（部分 ROM）可能把应用数据一起传上去
 *
 * 而这个 App 的凭据能做的事情**远超普通聊天 App**：
 *   · Cookie → 能读你电脑上的文件、执行命令
 *   · 审批网关 token → **能在手机端批准电脑执行命令**
 *
 * 所以必须放进 Android Keystore / iOS Keychain 支持的安全存储。
 *
 * ## 用什么
 *
 * `react-native-keychain` —— Android 侧走 Keystore（AES-GCM + 硬件支持
 * 时绑 TEE），iOS 侧走 Keychain。都是系统级加密，应用数据目录被拷走
 * 也没用。
 *
 * ## 设计取舍
 *
 * · **只放两个凭据**：会话 Cookie、网关 device token。
 *   其他数据（主题、工作区自定义名、管家会话 id）不是秘密，继续放
 *   AsyncStorage —— 迁移它们没收益，反而增加出错面。
 *
 * · **一条一条存取**，不做批量。Keystore 的每次操作都有开销，
 *   但凭据只有两三条，不值得为性能做批量。
 *
 * · **失败要能被发现**。如果 Keystore 不可用（极少数设备/模拟器），
 *   明确抛错让上层决定，而不是静默降级到明文 —— 静默降级等于没做。
 */

/**
 * 延迟加载 react-native-keychain。
 *
 * 为什么不在顶层 `import * as Keychain from 'react-native-keychain'`：
 * 它内部会 `import ... from 'react-native'`，而 RN 的入口是 Flow 语法，
 * Node 侧的工具链（tsx/esbuild）解析不了 —— 直接静态 import 会让
 * 所有跑测试的文件在加载阶段就崩。
 *
 * 改成运行时按需加载：真机上第一次读写凭据时才 require，测试里
 * 由 loader hook 换成内存替身。
 */
type KeychainModule = {
  setGenericPassword: (
    username: string,
    password: string,
    options?: { service?: string; accessible?: string },
  ) => Promise<unknown>;
  getGenericPassword: (options?: {
    service?: string;
  }) => Promise<false | { username: string; password: string; service?: string }>;
  resetGenericPassword: (options?: { service?: string }) => Promise<unknown>;
  ACCESSIBLE: Record<string, string>;
};

let keychainModule: KeychainModule | null = null;

function getKeychain(): KeychainModule {
  if (keychainModule) return keychainModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('react-native-keychain') as
    | KeychainModule
    | { default: KeychainModule };
  keychainModule = 'default' in mod ? mod.default : mod;
  return keychainModule;
}

/** 存进 Keychain 的凭据键名 */
export const CredentialKey = {
  /** 会话 Cookie（能读写 DSH） */
  cookie: 'dsh.cookie',
  /** 审批网关的长期 device token（能批准命令执行） */
  gatewayToken: 'dsh.gatewayToken',
  /** 审批网关的稳定设备 id（不是秘密，但和 token 放一起方便一起清） */
  gatewayDeviceId: 'dsh.gatewayDeviceId',
  /**
   * **服务端**给这台设备分配的 device id（UUID）。
   *
   * ## 为什么必须单独存
   *
   * 服务端有两套 id，用途完全不同：
   *
   *   · `gatewayDeviceId`（`dsh-outpost-xxx`）—— 客户端自己生成的安装标识，
   *     走 `X-DSH-Device-ID` 请求头，服务端只拿它复用设备记录
   *   · `gatewayServerDeviceId`（UUID）—— 服务端注册表里的主键，
   *     `POST /mgw/devices/<这个>/revoke` 认的是它
   *
   * 关键事实：`GET /mgw/devices` 返回的条目里**没有**客户端标识
   * （真实插件 `publicDevice()` 只返回 id/name/createdAt/lastSeenAt/
   * online/connections，见 tests/protocol-contract-spec.mjs）。
   *
   * 所以只按 `dsh-outpost-xxx` 去列表里找自己，**永远找不到** ——
   * `revokeOwnDevice()` 会返回 `already-gone`，上层当成撤销成功，
   * 而服务端记录还在、设备仍能连、仍能批命令。
   *
   * 服务端在 `paired` / `hello` 帧里会把它的 UUID 告诉我们
   * （`frame.device.id`），所以这里存下来，撤销时直接用它。
   */
  gatewayServerDeviceId: 'dsh.gatewayServerDeviceId',
  /**
   * **服务端实例身份绑定**（P1-1）。
   *
   * `gatewayServerDeviceId` 只回答了「服务端给我分配的 UUID 是什么」，
   * 没回答「这个 UUID 属于哪一台服务器」。于是：
   *
   *   · 用户把地址从电脑 A 改成电脑 B（或 A 重装、换 IP 后复用同一地址）
   *   · Keychain 里那份旧 UUID 仍在
   *   · 撤销时拿旧 UUID 去打新服务器 → 404 → 被归类成「本来就没有」
   *     → 上层当成撤销成功，而新服务器上这台设备的授权其实还在
   *
   * 真实插件在 `paired` / `hello` 帧里带 `gatewayId`（服务端实例标识，
   * 存在独立的状态文件里，跨重启稳定、不随设备撤销变化 —— 见
   * `gateway-state.mjs` 的注释），这里把
   * `{ baseUrl, gatewayId, deviceId }` 作为一个整体存下来，
   * 三者必须同时匹配才认为这份 UUID 属于当前这台服务器。
   *
   * ⚠️ 内容不是秘密（URL + 两个标识），但和 device id 放一起，
   * 「彻底清除」时一并清掉。
   */
  gatewayServerBinding: 'dsh.gatewayServerBinding',
  /**
   * 审批撤销标记的**安全存储副本**（P0-1 降级通道）。
   *
   * 主副本在 AsyncStorage（`@dsh/approvalRevoked`）。当 AsyncStorage
   * 写失败（磁盘满 / 数据库锁 / 文件损坏）时，撤销标记会落到这里 ——
   * Keystore 和 AsyncStorage 是两套独立的底层存储，同时坏掉的概率
   * 远低于单独一套。
   *
   * 两个存储都是**写后回读校验**，校验通过才算持久化成功。
   */
  revocationMarker: 'dsh.revocationMarker',
} as const;

export type CredentialKeyName = (typeof CredentialKey)[keyof typeof CredentialKey];

/** Keychain 服务名（同一个 App 内区分不同用途） */
const SERVICE = 'com.dshpocket.credentials';

/**
 * 写入一个凭据。
 *
 * 已存在则覆盖 —— Keychain 的 setGenericPassword 本身就是 upsert 语义。
 */
export async function saveCredential(key: CredentialKeyName, value: string): Promise<void> {
  if (!value) {
    // 空值等于「没有凭据」，直接清掉，避免留下空串干扰判断
    await clearCredential(key);
    return;
  }
  await getKeychain().setGenericPassword(key, value, {
    service: `${SERVICE}.${key}`,
    // 只在设备解锁后可读。不要 ALWAYS —— 那会在锁屏状态下也能读，
    // 对一个能批准命令执行的凭据来说太宽了。
    accessible: getKeychain().ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/** 读一个凭据，没有则返回 undefined */
export async function loadCredential(key: CredentialKeyName): Promise<string | undefined> {
  try {
    const res = await getKeychain().getGenericPassword({ service: `${SERVICE}.${key}` });
    if (!res || !res.password) return undefined;
    return res.password;
  } catch {
    // Keystore 读失败（比如用户改了锁屏方式导致密钥失效）当作没有
    return undefined;
  }
}

/** 删一个凭据 */
export async function clearCredential(key: CredentialKeyName): Promise<void> {
  try {
    await getKeychain().resetGenericPassword({ service: `${SERVICE}.${key}` });
  } catch {
    // 本来就没有也算成功
  }
}

/**
 * 清掉**所有**授权凭据。
 *
 * 这是「退出并清除所有授权」用的 —— 和「断开连接」是两件事：
 *   · 断开连接：只清当前会话，保留「上次配对」以便恢复
 *   · 清除授权：Cookie + 网关 token + 设备 id 全部抹掉，不可恢复
 *
 * ⚠️ 但**不**清 `revocationMarker`。
 *
 * 撤销标记不是「授权凭据」，而恰恰相反 —— 它记录的是「用户已经撤销过」。
 * 在「退出并清除所有授权」里把它一起删掉，等于把唯一能证明「这台设备
 * 不该自动重新授权」的证据抹了；万一 Cookie / 明文副本没删干净，
 * 下次启动就会自动登录并重新配对，正好是用户最不想要的。
 * 它由 `markApprovalRevoked()` 显式写入、由 `clearApprovalRevoked()`
 * （只允许用户主动重新授权时调用）显式清除。
 */
export async function clearAllCredentials(): Promise<void> {
  await Promise.all([
    clearCredential(CredentialKey.cookie),
    clearCredential(CredentialKey.gatewayToken),
    clearCredential(CredentialKey.gatewayDeviceId),
    clearCredential(CredentialKey.gatewayServerDeviceId),
    clearCredential(CredentialKey.gatewayServerBinding),
  ]);
}

/** Keystore 是否可用（不依赖具体值，只探一次读写） */
export async function isSecureStorageAvailable(): Promise<boolean> {
  const probeKey = 'dsh.probe';
  try {
    await getKeychain().setGenericPassword(probeKey, 'ok', {
      service: `${SERVICE}.${probeKey}`,
      accessible: getKeychain().ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    const res = await getKeychain().getGenericPassword({ service: `${SERVICE}.${probeKey}` });
    await getKeychain().resetGenericPassword({ service: `${SERVICE}.${probeKey}` });
    return !!res && res.password === 'ok';
  } catch {
    return false;
  }
}
