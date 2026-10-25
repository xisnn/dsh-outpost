/**
 * 登录意图的持久化状态。
 *
 * ## 解决什么问题
 *
 * 「这台手机现在要不要自动登录」这件事，必须**持久化**。
 *
 * 之前它是靠 `migrateLegacyCredentials()` 的一次性返回值 `fromLastCookie`
 * 判断的：
 *
 *   ```ts
 *   const autoResume = !migration.fromLastCookie;
 *   if (savedBase && savedCookie && autoResume) { 自动登录 }
 *   ```
 *
 * 这在**第一次**启动时是对的，第二次就错了。因为迁移会删掉
 * `@dsh/lastCookie`：
 *
 *   第 1 次启动（旧版点过「断开连接」，只剩 lastCookie）
 *     → fromLastCookie = true → 不自动登录 ✓ → 显示「直接继续」
 *     → 迁移把 lastCookie 写进 Keychain，删掉明文键
 *
 *   第 2 次启动（用户什么都没做，只是关了 App 又打开）
 *     → 已经没有 lastCookie 了 → 迁移返回 clean、fromLastCookie = false
 *     → autoResume = true → Keychain 里那份 cookie 被当成正常登录态
 *     → **自动登录** ✗
 *
 * 用户「我主动断开过」的决定，在第二次启动时被程序悄悄推翻了。
 * 而且他第一次启动时看到的还是「直接继续」—— 界面说的和实际做的相反。
 *
 * 根因：**一次性函数返回值不能承载跨重启的状态**。
 *
 * ## 怎么实现
 *
 * 一个持久化的意图记录（AsyncStorage，不是秘密，不需要进 Keychain）：
 *
 *   `active`      正常已登录 —— 允许自动登录
 *   `signed-out`  用户主动断开过，但凭据还留着 —— **不自动登录**，
 *                 配对页提供「直接继续」由用户自己决定
 *
 * 读取失败 / 数据损坏 → `unknown`，同样**不自动登录**（fail-closed）。
 *
 * 唯一的例外是「键不存在」：那是**升级兼容**用的 —— v0.16.x 之前的版本
 * 没有这个键，但那些用户的历史行为就是自动登录。把「不存在」判成
 * `unknown` 会让所有存量用户升级后被踢到配对页，等于制造一次大规模
 * 重新登录。这个取舍写在 `loadLoginIntent()` 的注释里。
 *
 * ## 和凭据的关系
 *
 * 意图和凭据是**两个独立的东西**，刻意分开存：
 *
 *   · 意图是「用户想不想自动登录」（AsyncStorage，可丢，丢了按安全侧处理）
 *   · 凭据是「能不能登录」（Keychain，加密）
 *
 * 分开的好处：意图写失败时不会破坏凭据（用户还能点「直接继续」）；
 * 凭据被清掉时意图也不会把用户锁死。
 *
 * ## 崩溃与部分写入
 *
 * 写入顺序刻意设计成「崩在哪一步都不会放宽安全边界」：
 *
 *   · 断开连接：**先**写 signed-out，再返回。崩在中间 → 已经是 signed-out，
 *     下次启动不会自动登录 ✓（方向安全）
 *   · 扫码配对：先存凭据，**再**写 active。崩在中间 → 意图还是 signed-out，
 *     下次启动不自动登录，用户点一下「直接继续」即可 ✓（方向安全）
 *
 * 反过来的顺序都会产生「意图说 active 但没有凭据」或
 * 「凭据在但意图还是旧的 signed-out」—— 前者无害，后者只是多点一下。
 * 两种崩溃都不会变成「偷偷自动登录」。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 登录意图的存储键。
 *
 * 不含任何凭据，只是「用户上次是主动断开还是正常在线」这一个标记。
 */
const INTENT_KEY = '@dsh/loginIntent';

/** 记录格式版本（将来要改结构时用） */
const INTENT_VERSION = 1;

/**
 * 登录意图的三态。
 *
 * ⚠️ 和 deviceRevocation 一样，不要退回成 boolean —— 「读不出来」
 * 必须能和「明确已登录」「明确已断开」区分开。
 */
export type LoginIntentStatus =
  /** 正常已登录：允许自动登录 */
  | 'active'
  /** 用户主动断开过（凭据保留）：不自动登录，等用户点「直接继续」 */
  | 'signed-out'
  /** 读失败 / 数据损坏：不自动登录（fail-closed） */
  | 'unknown';

interface LoginIntentRecord {
  v: number;
  status: 'active' | 'signed-out';
  at: number;
}

/** 内存缓存（只在拿到确定结论时写入，unknown 不缓存） */
let cached: LoginIntentStatus | null = null;

function isStatus(v: unknown): v is 'active' | 'signed-out' {
  return v === 'active' || v === 'signed-out';
}

/**
 * 读登录意图。
 *
 * 判定规则：
 *
 * | 存储状态            | 结论        | 自动登录 |
 * |---------------------|-------------|----------|
 * | 键不存在            | `active`    | ✅ 允许（升级兼容） |
 * | `{status:'active'}` | `active`    | ✅ 允许 |
 * | `{status:'signed-out'}` | `signed-out` | ❌ 禁止 |
 * | 读抛异常            | `unknown`   | ❌ 禁止 |
 * | 非法 JSON / 结构不对 | `unknown`   | ❌ 禁止 |
 *
 * 为什么「键不存在」算 active 而不是 unknown：
 * v0.16.x 及更早的版本没有这个键。如果按 unknown 处理，所有存量用户
 * 升级后第一次启动都会掉到配对页 —— 那是一次无谓的大规模重新登录，
 * 而且并没有换来任何安全性（那些用户本来就没有「主动断开」的记录，
 * 他们的历史行为就是自动登录）。
 *
 * 真正的「用户主动断开」从本版本起**一定**会写入 signed-out，
 * 所以「键不存在」只可能是「从没记录过」或「升级上来」。
 *
 * ⚠️ 但**读失败**（抛异常）绝不能也归到 active —— 那是 P0 里
 * 「撤销标记读失败被当成未撤销」的同一个坑，换到登录意图上。
 */
export async function loadLoginIntent(): Promise<LoginIntentStatus> {
  if (cached) return cached;

  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(INTENT_KEY);
  } catch {
    // 读失败：不缓存，下次重试。结论是「不知道」，不是「已登录」。
    return 'unknown';
  }

  if (raw === null || raw === '') {
    // 从没记录过（全新安装 / 从旧版本升级）—— 按升级兼容处理。
    // 不缓存：万一之后写入了记录，能立刻读到新的。
    return 'active';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 非法 JSON：写了一半 / 被别的东西覆盖 → 不知道
    return 'unknown';
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'unknown';
  }

  const rec = parsed as Partial<LoginIntentRecord>;
  if (!isStatus(rec.status)) {
    return 'unknown';
  }

  cached = rec.status;
  return cached;
}

/**
 * 写登录意图。
 *
 * @returns true 表示**已确认落盘**（写完回读校验过）；false 表示没写成功。
 *
 * 为什么要回读校验：`AsyncStorage.setItem` 在部分 Android 机型上会
 * 「返回成功但实际没写」（磁盘满、数据库锁等待超时都可能这样）。
 * 调用方（尤其是「断开连接」）需要知道是否真的持久化了 ——
 * 没落盘就不能对外声称「已经退出了」。
 */
export async function setLoginIntent(status: 'active' | 'signed-out'): Promise<boolean> {
  const record: LoginIntentRecord = {
    v: INTENT_VERSION,
    status,
    at: Date.now(),
  };
  try {
    await AsyncStorage.setItem(INTENT_KEY, JSON.stringify(record));
  } catch {
    return false;
  }

  // 回读校验：确认真的写进去了，而且读出来就是我们要的值。
  // 这一步也顺便排除了「写成功但内容是旧的」这种诡异情况。
  try {
    const back = await AsyncStorage.getItem(INTENT_KEY);
    if (!back) return false;
    const parsed = JSON.parse(back) as Partial<LoginIntentRecord>;
    if (parsed?.status !== status) return false;
  } catch {
    return false;
  }

  cached = status;
  return true;
}

/**
 * 删除登录意图记录（彻底清除授权时用）。
 *
 * 删除后 `loadLoginIntent()` 会返回 `active`（升级兼容语义）。
 * 这在「凭据也一起清了」的前提下是安全的 —— 没有凭据就没有自动登录。
 *
 * ⚠️ 但**不要**指望靠「删意图」来实现「退出登录」：
 * 删完读出来是 active，等于什么都没做。退出登录必须写 signed-out。
 */
export async function clearLoginIntent(): Promise<boolean> {
  try {
    await AsyncStorage.removeItem(INTENT_KEY);
  } catch {
    return false;
  }
  cached = null;
  return true;
}

/** 仅用于测试：丢掉内存缓存，强制下次从存储读 */
export function __resetLoginIntentCache(): void {
  cached = null;
}
