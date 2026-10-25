/**
 * 旧版本明文凭据的一次性迁移与清理。
 *
 * ## 为什么需要
 *
 * v0.16.0 把 Cookie / 网关 device token / device id 从 AsyncStorage
 * 搬到了 Keychain（见 core/secureStore.ts），但**只搬了新写入的**：
 *
 *   · 老版本升级上来的用户，凭据还躺在 AsyncStorage 里
 *     （`@dsh/cookie`、`@dsh/gatewayToken`、`@dsh/gatewayDeviceId`）
 *   · 新版本只读 Keychain，读不到它们 —— 表现是「升级后被踢回配对页，
 *     要重新扫码」
 *   · 更糟的是那几份明文**永远不会被删掉**。之前只有「清除所有授权」
 *     顺手删了 `@dsh/lastCookie`，另外三个一个都没清
 *
 * 所以这里补上迁移：把还能用的旧凭据搬进 Keychain，搬完删明文。
 *
 * ## 安全约束（顺序不能变）
 *
 *   1. **先写安全存储、回读校验成功，才删明文**
 *      反过来（先删再写）一旦写入失败，用户的登录态就没了，
 *      而且明文副本也找不回来。
 *
 *   2. **失败不静默降级**
 *      安全存储不可用时，绝不「那先用明文凑合」—— 那等于没做迁移。
 *      这里如实返回 failed，由上层提示用户，并且**不**拿明文值去登录。
 *
 *   3. **不覆盖安全存储里已有的值**
 *      已有的值可能比明文副本新（比如用户升级后重新配对过）。
 *
 *   4. **可重复调用**
 *      迁移成功后旧键已删，再跑一次什么也不做，不会破坏有效凭据。
 *
 *   5. **不输出凭据**
 *      报告里只有键名，没有任何值；错误信息也只描述类别。
 *
 * ## 「确认没有」和「读不到」必须分开（P1-3）
 *
 * 旧实现在读明文存储失败时直接 `return report`，而 report 的默认状态是
 * `clean` —— 上层看到的是「确认没有明文凭据」。可真实情况是**未知**：
 * 数据库被锁 / 磁盘满 / 文件损坏的时候，那几份明文很可能还躺在磁盘上，
 * 我们只是没能读到。
 *
 * 「未知」被报成「干净」等于让一个本该 fail-closed 的安全检查静默
 * fail-open。所以报告改成七种显式结论：
 *
 *   · `clean`          读到了，且确认没有任何明文键
 *   · `migrated`       迁进安全存储，且明文回读确认已删除
 *   · `already-secure` 安全存储已有更新的值，明文回读确认已删除
 *   · `failed`         找到明文，但迁移失败（明文留在原地待重试）
 *   · `read-failed`    明文存储读不出来 → **不知道**有没有明文
 *   · `clear-failed`   删明文失败，或回读仍能看到残留
 *   · `verify-failed`  删完之后回读校验失败 → 无法确认是否真的删掉了
 *
 * 后三种都不等于成功。`shouldBlockAutoLogin()` 把 `read-failed` /
 * `failed` / `clear-failed` / `verify-failed` 统一判为「不要自动登录」，
 * 由上层显式提示用户，而不是假装一切正常地继续跑。
 *
 * ## `@dsh/lastCookie` 的语义
 *
 * 旧版本 signOut 会把当前 cookie **复制**到 `@dsh/lastCookie` 再删
 * `@dsh/cookie`，目的是「退出后还能一键恢复上次配对」。问题在于：
 *
 *   · 它是一份完整可用的明文认证凭据
 *   · 用户点「断开连接」之后它还在，等于留了个后门入口
 *
 * 所以迁移时它按「上次配对」处理：
 *   · 有 `@dsh/cookie`   → 用 `@dsh/cookie`（当前登录态），lastCookie 直接删
 *   · 只有 lastCookie    → 迁移进 Keychain，但**不自动登录**，
 *                          只标记 hasLastPairing，等用户主动点「直接继续」
 * 迁移完成后两份明文都不复存在，值只在 Keychain 里。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CredentialKey,
  clearCredential,
  isSecureStorageAvailable,
  loadCredential,
  saveCredential,
  type CredentialKeyName,
} from './secureStore';

/**
 * 历史版本用过、现在必须清理的 AsyncStorage 键。
 *
 * ⚠️ 这四个都是**明文**（SQLite / SharedPreferences），只在应用沙箱
 * 这一层受保护 —— adb backup、root、云备份都可能把凭据带走。
 */
export const LegacyCredentialKey = {
  /** 旧版本的会话 Cookie（能读写 DSH、执行命令） */
  cookie: '@dsh/cookie',
  /** 旧版本的审批网关长期 token（能在手机上批准命令执行） */
  gatewayToken: '@dsh/gatewayToken',
  /** 旧版本的稳定设备 id（不是秘密，但和 token 一起清） */
  gatewayDeviceId: '@dsh/gatewayDeviceId',
  /** 旧版本 signOut 复制出来的 Cookie 副本（「上次配对」） */
  lastCookie: '@dsh/lastCookie',
} as const;

export type LegacyCredentialKeyName =
  (typeof LegacyCredentialKey)[keyof typeof LegacyCredentialKey];

/** 需要清理的全部历史明文键（顺序固定，便于断言） */
export const ALL_LEGACY_KEYS: readonly LegacyCredentialKeyName[] = [
  LegacyCredentialKey.cookie,
  LegacyCredentialKey.gatewayToken,
  LegacyCredentialKey.gatewayDeviceId,
  LegacyCredentialKey.lastCookie,
];

/** 迁移结果分类（P1-3：把「确认没有」和「读不到」拆开） */
export type CredentialMigrationStatus =
  /** 明文存储**读取成功**，且确认没有任何历史凭据（全新安装 / 已迁移过） */
  | 'clean'
  /** 本次完成了迁移：写安全存储 + 回读校验 + 明文回读确认删除 */
  | 'migrated'
  /** 安全存储已有凭据，本次只清理了旧明文副本（同样经过回读确认） */
  | 'already-secure'
  /** 找到明文凭据，但迁移失败（安全存储不可用 / 写入校验失败等） */
  | 'failed'
  /**
   * **读不到**旧明文存储 → 是否存在明文凭据**未知**。
   *
   * ⚠️ 这一条绝不能退化成 `clean`。读失败可能是数据库被锁、磁盘满、
   * 文件损坏 —— 此时明文很可能还在磁盘上，只是我们看不见。
   * 未知就按「有风险」处理（fail-closed）。
   */
  | 'read-failed'
  /** 删明文失败，或删完回读仍能看到残留 */
  | 'clear-failed'
  /** 删完回读**校验本身**失败 → 无法确认明文是否真的删掉了 */
  | 'verify-failed';

/**
 * 「不是成功态」的全部状态。
 *
 * 抽成常量有两个原因：
 *   · `shouldBlockAutoLogin()` 和 `migrateLegacyCredentials()` 都要判断
 *     「这算不算失败」，两处必须**永远一致** —— 写两遍迟早会漂。
 *   · 放进 `Set` 后不受 TypeScript 的控制流收窄影响：在
 *     `migrateLegacyCredentials()` 的末尾，`report.status` 已经被前面的
 *     分支收窄成「不含 read-failed」的联合类型，直接写
 *     `report.status === 'read-failed'` 会报 TS2367（不可能成立）。
 */
const FAILURE_STATUSES: ReadonlySet<CredentialMigrationStatus> = new Set([
  'failed',
  'read-failed',
  'clear-failed',
  'verify-failed',
]);

/** 迁移报告（**只有键名，没有任何凭据值**） */
export interface CredentialMigrationReport {
  status: CredentialMigrationStatus;
  /**
   * 明文存储是否**读取成功**。
   *
   * 独立字段，不靠 `status` 反推：`status` 描述的是本次迁移的结论，
   * 而 `readSucceeded` 描述的是「结论所依赖的前提成不成立」。
   * false 时其余字段（migrated / cleared / leftover）都只能理解为
   * 「本次调用观察到的部分事实」，不能当作「磁盘上就是如此」。
   */
  readSucceeded: boolean;
  /** 本次写进安全存储的凭据（用 CredentialKey 的名字） */
  migrated: CredentialKeyName[];
  /** 已确认删除的旧明文键（仅在这些键经过回读校验后才算数） */
  cleared: LegacyCredentialKeyName[];
  /** 仍留在明文存储里、需要下次重试的旧键 */
  leftover: LegacyCredentialKeyName[];
  /**
   * 迁移得到的会话 cookie 是否只是「上次配对」的备份。
   *
   * true 表示旧版本里用户已经点过「断开连接」，本次只是把可恢复的
   * 上次配对搬进 Keychain —— 上层**不应该**据此自动登录。
   */
  fromLastCookie: boolean;
  /** 明文删除是否经过了回读校验（true 才敢说「已删干净」） */
  clearVerified: boolean;
  /** 失败原因（只描述类别，绝不含凭据值） */
  error?: string;
}

/** 新建一份空报告 */
function emptyReport(): CredentialMigrationReport {
  return {
    status: 'clean',
    readSucceeded: true,
    migrated: [],
    cleared: [],
    leftover: [],
    fromLastCookie: false,
    clearVerified: false,
  };
}

/**
 * 把旧版本的明文凭据迁进安全存储，并清掉明文副本。
 *
 * 幂等：可以安全地在每次启动时调用。
 */
export async function migrateLegacyCredentials(): Promise<CredentialMigrationReport> {
  const report = emptyReport();

  // ── 1. 一次性读出全部旧明文键 ───────────────────────────────
  //
  // ⚠️ 读失败**不能**当成「没有旧凭据」（P1-3 的核心修正）。
  //
  // 旧实现这里是 `catch { return report; }`，而 report 默认 status='clean'
  // —— 于是「存储读不出来」被报成了「确认没有明文凭据」。
  // 数据库被锁 / 磁盘满 / 文件损坏时，那几份明文很可能还在磁盘上，
  // 只是我们看不见；上层看到 clean 就会放心地继续自动登录。
  //
  // 现在如实返回 read-failed：结论是「未知」，由 shouldBlockAutoLogin()
  // 决定拦下自动登录并提示用户。
  const legacy: Partial<Record<LegacyCredentialKeyName, string>> = {};
  try {
    const entries = await AsyncStorage.multiGet([...ALL_LEGACY_KEYS]);
    for (const [key, value] of entries) {
      if (typeof value === 'string' && value !== '') {
        legacy[key as LegacyCredentialKeyName] = value;
      }
    }
  } catch {
    report.status = 'read-failed';
    report.readSucceeded = false;
    // 注意：这里**不**给出「不确定的键列表」。读都读不到，
    // 任何具体的键名都只是猜测；调用方应当按「全部未知」处理。
    report.error = '旧凭据存储读取失败，无法确认是否仍有明文凭据';
    return report;
  }

  const hasAnyLegacy = ALL_LEGACY_KEYS.some((k) => !!legacy[k]);
  if (!hasAnyLegacy) {
    // 全新安装，或者之前已经迁移过 —— 什么都不做，尤其不要碰安全存储。
    //
    // clearVerified 置 true：虽然什么都没删，但刚才那次**成功的 multiGet**
    // 已经确认了「磁盘上没有任何旧明文键」—— 这正是这个字段要表达的事。
    // （它不是「我删过东西」，而是「我确认过明文已经不在」。）
    report.clearVerified = true;
    return report;
  }

  // ── 2. 安全存储可用性前置检查 ───────────────────────────────
  //
  // 不可用时直接判失败：既不能写（迁移没意义），也不能继续用明文
  // （那就是「静默降级」）。把旧值留在原地等下次启动重试。
  const secureOk = await isSecureStorageAvailable();
  if (!secureOk) {
    report.status = 'failed';
    report.leftover = ALL_LEGACY_KEYS.filter((k) => !!legacy[k]);
    report.error = '安全存储不可用，凭据迁移未完成';
    return report;
  }

  // ── 3. 逐个迁移 ─────────────────────────────────────────────
  //
  // 这里要同时记两件**性质完全不同**的事，不能混成一个 'failed'：
  //
  //   · writeFailed    —— 凭据没写进安全存储。明文留在原地，登录态保住了，
  //                       但「凭据还在明文里」这件事没被解决。
  //   · clearFailures  —— 凭据已经安全迁移（或本来就在安全存储里），
  //                       只是那份**多余的明文副本**删不掉。
  //
  // 前者说明迁移没做成；后者说明迁移做成了、但清理没做成。上层要提示
  // 用户的话，说法完全不同，所以报告状态也分开（failed / clear-failed）。
  let writeFailed = false;
  const clearFailures: LegacyCredentialKeyName[] = [];

  const removeLegacy = async (key: LegacyCredentialKeyName): Promise<void> => {
    try {
      await AsyncStorage.removeItem(key);
      report.cleared.push(key);
    } catch {
      // ⚠️ 删失败**不能**记进 cleared —— 那是在报告里撒谎。
      // 先按「还在」记进 leftover（fail-closed），最终状态见第 4、5 步。
      report.leftover.push(key);
      clearFailures.push(key);
    }
  };

  /**
   * 迁移一个凭据。
   *
   * 三条规则按顺序判断：
   *   1. 安全存储已有值 → 只删明文，**不覆盖**（可能更新）
   *   2. 安全存储没有值、明文有值 → 写 → 回读校验 → 删明文
   *   3. 写入或校验失败 → 保留明文（下次重试）+ 整体判失败
   */
  const migrateOne = async (
    legacyKey: LegacyCredentialKeyName,
    credentialKey: CredentialKeyName,
  ): Promise<void> => {
    const legacyValue = legacy[legacyKey];
    if (!legacyValue) return;

    const existing = await loadCredential(credentialKey);
    if (existing) {
      // 安全存储里已经有更新的值 —— 明文只是陈旧副本，删掉即可。
      await removeLegacy(legacyKey);
      return;
    }

    try {
      await saveCredential(credentialKey, legacyValue);
      // 回读校验：写进去必须读得出来，否则不能删明文。
      // （Keystore 在部分设备上会静默失败，这里必须实际读一次。）
      const verify = await loadCredential(credentialKey);
      if (verify !== legacyValue) {
        throw new Error('verify failed');
      }
    } catch {
      report.leftover.push(legacyKey);
      writeFailed = true;
      report.error = '写入安全存储失败，凭据迁移未完成';
      return;
    }

    report.migrated.push(credentialKey);
    await removeLegacy(legacyKey);
  };

  // Cookie 有两个历史来源，是同一份凭据的两个副本：
  //   `@dsh/cookie`     当前登录态
  //   `@dsh/lastCookie` 旧版本 signOut 时复制出来的「上次配对」
  //
  // 优先用当前登录态；只有它不存在时才回退到 lastCookie ——
  // 那种情况等价于「旧版本里用户点过断开连接」，
  // 恢复后**不应该**自动登录，只应提供「直接继续」入口。
  const cookieSource: LegacyCredentialKeyName | undefined = legacy[LegacyCredentialKey.cookie]
    ? LegacyCredentialKey.cookie
    : legacy[LegacyCredentialKey.lastCookie]
      ? LegacyCredentialKey.lastCookie
      : undefined;

  if (cookieSource) {
    report.fromLastCookie = cookieSource === LegacyCredentialKey.lastCookie;
    await migrateOne(cookieSource, CredentialKey.cookie);
  }

  // lastCookie 永远是 cookie 的冗余副本：cookie 那边处理完之后它必须消失。
  //
  // ⚠️ 但有两种情况要留着：
  //   · 它本身就是 cookieSource 且迁移失败（leftover 里已有它）
  //   · cookie 的迁移也失败了 —— 这时 lastCookie 是用户仅剩的凭据副本，
  //     删掉等于让他彻底丢失登录态。等下次启动迁移成功再一起清。
  const cookieMigrated = report.migrated.includes(CredentialKey.cookie);
  const cookieAlreadySecure = !report.leftover.includes(LegacyCredentialKey.cookie);
  if (
    legacy[LegacyCredentialKey.lastCookie] &&
    report.leftover.indexOf(LegacyCredentialKey.lastCookie) < 0 &&
    report.cleared.indexOf(LegacyCredentialKey.lastCookie) < 0 &&
    (cookieMigrated || cookieAlreadySecure)
  ) {
    await removeLegacy(LegacyCredentialKey.lastCookie);
  }

  await migrateOne(LegacyCredentialKey.gatewayToken, CredentialKey.gatewayToken);
  await migrateOne(LegacyCredentialKey.gatewayDeviceId, CredentialKey.gatewayDeviceId);

  // ── 4. 明文删除的回读校验（P1-3）─────────────────────────────
  //
  // `removeItem()` 返回成功**不等于**键真的没了：AsyncStorage 在 RN 里
  // 是一层原生桥，写请求可能只是排进了队列（甚至被静默丢弃）。所以
  // 删完必须**再读一次**，确认磁盘上确实没有了。
  //
  // 三种结论：
  //   · 回读成功且全是 null        → clearVerified = true
  //   · 回读成功但有键还在         → clear-failed（残留，明文认证入口还在）
  //   · 回读本身抛异常             → verify-failed（无法确认，按有风险处理）
  //
  // 读不到就按「可能还在」处理（fail-closed），绝不假设删成功了。
  //
  // ⚠️ 写失败（writeFailed）时**不做**这一步：那些凭据是故意留在明文的
  // （删了用户就丢登录态），回读必然看到它们，于是会把「迁移没做成」
  // 误报成「清理没做成」。写失败的结论更严重，优先级更高，见第 5 步。
  if (!writeFailed) {
    try {
      const after = await AsyncStorage.multiGet([...ALL_LEGACY_KEYS]);
      const residue = after
        .filter(([, value]) => typeof value === 'string' && value !== '')
        .map(([key]) => key as LegacyCredentialKeyName);

      if (residue.length > 0) {
        // 回读看到的才是事实：以它为准修正 cleared / leftover。
        // removeItem 报告成功、实际却还在的键，从 cleared 挪回 leftover。
        for (const key of residue) {
          const claimed = report.cleared.indexOf(key);
          if (claimed >= 0) report.cleared.splice(claimed, 1);
          if (report.leftover.indexOf(key) < 0) report.leftover.push(key);
        }
      }
      // 只有「回读看到全部消失」且「没有任何一次 removeItem 抛错」
      // 才敢说 verified —— 两者缺一都不能声称清干净了。
      report.clearVerified = residue.length === 0 && clearFailures.length === 0;

      if (residue.length > 0) {
        report.status = 'clear-failed';
        report.error = `明文凭据删除后仍有残留（${residue.length} 个键）`;
      }
    } catch {
      // 校验本身失败 —— 既不能声称删干净了，也不能声称没删。
      // 保留 cleared 里已报告删掉的部分，但状态明确标成 verify-failed。
      report.clearVerified = false;
      report.status = 'verify-failed';
      report.error = '明文删除后的回读校验失败，无法确认是否已删除';
    }
  }

  // ── 5. 汇总状态 ─────────────────────────────────────────────
  //
  // 优先级从「最不确定」到「最确定」：
  //   verify-failed（删没删掉不知道，最糟）
  //   → failed（凭据没迁成）
  //   → clear-failed（迁成了但明文残留）
  //   → migrated / already-secure / clean（成功态）
  if (report.status === 'verify-failed') {
    // 保持：无法确认删除结果，上层必须按有风险处理。
  } else if (writeFailed) {
    report.status = 'failed';
  } else if (report.status === 'clear-failed' || clearFailures.length > 0) {
    // 回读发现残留，或者某次 removeItem 直接抛错 —— 明文入口没清干净。
    report.status = 'clear-failed';
    report.error = report.error ?? '明文凭据清理失败';
  } else if (report.migrated.length > 0) {
    report.status = 'migrated';
  } else if (report.cleared.length > 0) {
    report.status = 'already-secure';
  } else if (report.leftover.length > 0) {
    // 没迁移、没删掉、却有明文需要处理 —— 只能是清理失败。
    report.status = 'clear-failed';
    report.error = '明文凭据清理失败';
  } else {
    report.status = 'clean';
  }

  // 只有真正的失败态才保留错误说明；成功态里残留的 error 一律清掉，
  // 避免上层看到「状态 migrated 但 error 非空」这种自相矛盾的报告。
  //
  // 用集合而不是长 `||` 链：TypeScript 会把 report.status 沿着上面的
  // 分支赋值收窄，直接比较 'read-failed' 会被判成「不可能成立」
  // （那个状态在上面已经 return 了），`Set.has()` 不受收窄影响。
  if (!FAILURE_STATUSES.has(report.status)) delete report.error;

  return report;
}

/**
 * 判断本次迁移结果是否**必须拦下自动登录**（P1-3，fail-closed）。
 *
 * ## 为什么不是每条失败都拦
 *
 * 报告的失败态分两类：
 *
 *   · **凭据状态不确定 / 仍以明文暴露** → 必须拦
 *       - `read-failed`    明文存储读不出来，**不知道**有没有明文凭据残留。
 *                          此时自动登录没有意义（cookie 本身也可能读不到），
 *                          但更关键的是：一旦登录成功就会掩盖「明文还在」
 *                          这件事，用户永远不知道自己的凭据泄露了。
 *       - `failed`         找到明文但没迁成。自动登录会用**明文**里的
 *                          cookie 直接进主界面，等于把「迁移失败」这件
 *                          安全事件静默吞掉，明文继续躺在磁盘上。
 *       - `verify-failed`  删没删掉无法确认 → 与 read-failed 同理。
 *       - `clear-failed`   已确认明文残留 → 与 failed 同理（凭据确实
 *                          以明文留在磁盘上）。
 *
 *   · **安全状态明确、只是拿不到凭据** → 不拦（拦了反而让用户困惑）
 *       - `clean` / `migrated` / `already-secure` 都是成功态。
 *
 * 一句话：**只要存在「我们无法断言明文已经不存在」的情形，就不自动登录。**
 * 拦下来之后由 UI 提示用户（例如进配对页 + 一条说明），而不是让用户
 * 在不知情的情况下继续用着一个已泄露的凭据。
 *
 * 纯函数：不读存储、不抛异常，方便上层在 bootstrap 里直接调用和测试。
 */
export function shouldBlockAutoLogin(report: CredentialMigrationReport): boolean {
  switch (report.status) {
    case 'read-failed':
    case 'failed':
    case 'verify-failed':
    case 'clear-failed':
      return true;
    case 'clean':
    case 'migrated':
    case 'already-secure':
      return false;
    default: {
      // 类型上不会走到这里；万一将来加了新状态而忘了更新这里，
      // 默认拦下（fail-closed），而不是默认放行。
      //
      // 注意：这里的 true 分支必须永远和 FAILURE_STATUSES 保持一致
      // （两处都是「非成功态 = 拦」）。之所以不直接复用那个 Set，是因为
      // switch 能让 TypeScript 在**新增状态时编译报错**（exhaustive 检查），
      // 而 Set 不会 —— 那种「静默漏掉一个新状态」正是安全代码最怕的。
      const exhaustive: never = report.status;
      void exhaustive;
      return true;
    }
  }
}

/**
 * 清掉**所有**历史明文凭据键（不碰安全存储）。
 *
 * 「退出并清除所有授权」和「本机被撤销」时调用：确保不留任何
 * 明文认证入口，即使迁移曾经失败过。
 *
 * ## P1-3 之后的行为变化
 *
 * 返回值语义从「尝试删了哪些键」收紧为「**回读确认已不存在**的键」。
 * 这是刻意保留旧签名（`Promise<LegacyCredentialKeyName[]>`）的前提下
 * 能做到的最诚实的改进：
 *
 *   · 旧实现：removeItem 抛错就 catch 掉，但仍把**其余键**算进返回值，
 *     上层只数长度 → 删掉 3 个也算失败（凑不满 4），但**回读失败**
 *     时四把全在 `cleared` 里 → 上层误判成「清干净了」。
 *   · 新实现：委托给 `clearLegacyCredentialStorageVerified()`，
 *     只返回回读确认不存在的键；回读失败时返回空数组。
 *     上层 `cleared.length === 4` 这个判据因此自动变准，**且不必改 App.tsx**。
 *
 * 想同时拿到「哪些没清掉」「是否验证过」，请直接用 verified 版本。
 *
 * @returns 回读确认已不存在的键（用于测试断言，不含值）
 */
export async function clearLegacyCredentialStorage(): Promise<LegacyCredentialKeyName[]> {
  const result = await clearLegacyCredentialStorageVerified();
  return result.cleared;
}

/** `clearLegacyCredentialStorageVerified()` 的结果 */
export interface LegacyClearResult {
  /**
   * 清理后**回读确认已不存在**的键。
   *
   * 注意：它表达的是「磁盘上现在没有这些键」，不是「我这次一定删掉了它」。
   * 本来就为空的键也会出现在这里（removeItem 对不存在的键是幂等的）。
   * 想判断「是不是真的清干净了」，请只看 `verified`。
   */
  cleared: LegacyCredentialKeyName[];
  /** 回读时仍能看到、或删除时抛错的键 */
  remaining: LegacyCredentialKeyName[];
  /**
   * 是否**经回读确认**全部键都不在了。
   *
   * false 有两种原因，上层不必区分（都按「明文可能还在」处理）：
   *   · removeItem 抛错
   *   · 回读校验本身失败（无法确认）
   *
   * ⚠️ verified === false 时，`cleared` / `remaining` 都**不足以**证明
   * 「没留下明文」，上层必须按「可能还有残留」处理并提示用户。
   */
  verified: boolean;
}

/**
 * 清掉全部历史明文键，并**回读校验**（P1-3）。
 *
 * ## 为什么不能只看 removeItem 的返回值
 *
 * AsyncStorage 的 removeItem 在 RN 里走原生桥，返回 resolve 只代表
 * 「请求发出去了」。原生侧可能因为数据库锁 / 磁盘满 / 文件损坏而
 * 静默失败。之前这里把「没抛异常」当成「删掉了」，于是：
 *
 *   · 用户点了「退出并清除所有授权」
 *   · 明文 Cookie 其实还在
 *   · 上层看到 cleared.length === 4，认为清干净了
 *
 * 所以现在删完必须再 `multiGet` 一次，以**磁盘上的事实**为准。
 *
 * 单个键删失败不阻塞其它键：能清一个是一个。
 * 但结论必须如实 —— 只要有一个键没确认删除，`verified` 就是 false。
 */
export async function clearLegacyCredentialStorageVerified(): Promise<LegacyClearResult> {
  const attempted: LegacyCredentialKeyName[] = [];
  const failed: LegacyCredentialKeyName[] = [];

  for (const key of ALL_LEGACY_KEYS) {
    try {
      await AsyncStorage.removeItem(key);
      attempted.push(key);
    } catch {
      // 单个键删不掉不阻塞其它 —— 安全存储那边已经清了，
      // 这里只是补刀。但**不能**把它算进「已删除」。
      failed.push(key);
    }
  }

  // 回读校验：以磁盘上的事实为准，而不是 removeItem 的返回值。
  try {
    const after = await AsyncStorage.multiGet([...ALL_LEGACY_KEYS]);
    const remaining: LegacyCredentialKeyName[] = [];
    for (const [key, value] of after) {
      if (typeof value === 'string' && value !== '') {
        remaining.push(key as LegacyCredentialKeyName);
      }
    }
    // 回读没看到的键才算真没了 —— 以回读结果反推 cleared。
    const cleared = attempted.filter((k) => remaining.indexOf(k) < 0);
    return {
      cleared,
      remaining,
      // 两个条件缺一不可：
      //   · 回读确认一个都不剩（这是唯一的事实来源）
      //   · 没有 removeItem 抛错（说明存储层没报错，结论才可信）
      // removeItem 抛错本身就意味着存储层此刻不正常；即便这次回读看着
      // 干净，也不宣称「已验证」—— 宁可多提示一次，也不放过真实残留。
      verified: remaining.length === 0 && failed.length === 0,
    };
  } catch {
    // 回读失败 => 无法确认。这里必须**fail-closed**：
    //   · cleared 置空 —— 没有任何一个键被确认删掉
    //   · remaining 列出全部键 —— 每一个都可能还在
    // 若这里把 attempted 当作 cleared 返回，上层（App.tsx 的
    // `cleared.length === LEGACY_KEY_COUNT`）就会得出「清干净了」的假结论。
    return {
      cleared: [],
      remaining: [...ALL_LEGACY_KEYS],
      verified: false,
    };
  }
}

/**
 * 清掉全部历史明文键 + 全部安全存储凭据。
 *
 * 这是「彻底清除授权」的完整语义：**两个存储都不能留**。
 */
export async function clearAllCredentialStorage(): Promise<void> {
  await clearLegacyCredentialStorage();
  await Promise.all([
    clearCredential(CredentialKey.cookie),
    clearCredential(CredentialKey.gatewayToken),
    clearCredential(CredentialKey.gatewayDeviceId),
    clearCredential(CredentialKey.gatewayServerDeviceId),
  ]);
}
