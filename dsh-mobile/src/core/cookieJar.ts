/**
 * 原生 Cookie 容器的清理。
 *
 * ## 为什么需要（这是一个真实的安全漏洞）
 *
 * 登录流程是「带 `credentials: 'include'` 请求 → RN 原生层自动接收并保存
 * Set-Cookie → 再用 CookieManager 把 cookie 读回来」。
 *
 * 也就是说 `dsh-auth-*` 这份**会话凭据同时存在两个地方**：
 *
 *   1. Keystore（我们主动存的，`CredentialKey.cookie`）
 *   2. **RN 原生 cookie 容器**（系统自动存的，`CookieManager`）
 *
 * 「退出并清除所有授权」之前只清了第 1 个，第 2 个一直留着。
 * 后果很具体：
 *
 *   · 用户点「退出并清除所有授权」（界面文案是「如果要把手机给别人用、
 *     或者怀疑凭据泄露，选这个」）
 *   · Keystore 清了、界面退回配对页 —— 看起来干净了
 *   · 但原生容器里还有一份可用的 `dsh-auth-*`
 *   · 下次启动 `readCookieFromJar()` 会把它读回来；
 *     任何带 `credentials: 'include'` 的请求（含 `POST /mgw/pair`）
 *     仍然以老用户身份通过鉴权
 *
 * 等于「清除授权」没清干净，留了一个后门入口。
 *
 * ## 怎么清
 *
 * `@react-native-cookies/cookies` 提供 `clearAll()` 和 `clearByName()`。
 * 这里两个都用：
 *
 *   · 先 `clearByName` 按名字清 `dsh-auth*`（精准，不动别的站点/别的 cookie）
 *   · 再 `clearAll` 兜底（部分平台 clearByName 对 HttpOnly 不生效）
 *
 * 失败**不抛错**：清 cookie 是「尽力而为」，但调用方需要知道结果，
 * 所以返回结果对象，由上层决定要不要提示用户。
 *
 * ## P1-4：返回值必须可信（不能拿 `true` 糊过去）
 *
 * 之前这里返回 `boolean`，而 boolean 表达不了**三种完全不同**的处境：
 *
 *   · 清干净了                     → 可以提示「已清除」
 *   · 还有残留（确认读到了）        → 必须提示「没清干净」
 *   · 根本没法确认（读不出来）      → **不能**当成清干净
 *
 * 第三种是最危险的：`getAll()` 抛异常时旧代码 `catch {}` 之后保持
 * `ok = true` —— 于是「复核失败」被报成了「确认清干净」。用户点
 * 「退出并清除所有授权」，界面说干净了，原生容器里其实还有一份可用
 * 的 `dsh-auth-*`。
 *
 * 所以现在分四类（`CookieCleanupResult`）：
 *
 *   · `cleared`      复核确认没有残留  → 成功
 *   · `unavailable`  原生模块本身加载不到（Node/测试环境、或平台没有
 *                    这个模块）→ **平台上不存在第二个存储**，不是残留问题
 *   · `partial`      复核确认**还有**残留（附剩余数量）
 *   · `unverified`   **无法确认**（枚举/复核抛异常、或平台没有枚举 API）
 *                    → 绝不等同于成功
 *
 * 分类原则：只信「再读一次读不到」，不信 API 的返回值 —— 这个原生模块
 * 在部分机型上会「返回成功但实际没删」。但只要**复核本身**做不了，
 * 结论就只能是不确定，不能倒推成成功。
 *
 * ⚠️ 全程不记录 cookie 值。失败原因只写**类别**（哪个 API 抛了、
 *    错误码是什么），绝不把 cookie 名/值写进结果或日志。
 */

/** CookieManager 里我们关心的 cookie 名前缀（DSH 的会话 cookie） */
const DSH_COOKIE_PREFIX = 'dsh-auth';

/**
 * 清理结果的四种判定。
 *
 * 调用方（App.tsx）按这个决定要不要警告用户：
 *   · `cleared` / `unavailable` → 不需要警告（后者是平台没有第二个存储）
 *   · `partial` / `unverified`  → **必须**告知「无法确认 cookie 缓存已清除」
 */
export type CookieCleanupResult =
  /** 复核确认没有残留 */
  | { kind: 'cleared' }
  /**
   * 原生 CookieManager 模块**本身**加载不到。
   *
   * 这不是「清理失败」—— 平台（如纯 Node 环境）根本没有第二个 cookie
   * 存储，没有东西可清。和 `unverified` 的区别是：这个连 API 都不存在，
   * 那个是 API 存在但结果不可信。
   */
  | { kind: 'unavailable'; reason: string }
  /** 复核**确认**还有残留（`remaining` = 仍存在的 dsh-auth* 数量） */
  | { kind: 'partial'; remaining: number }
  /** 无法确认清理结果（枚举/复核抛异常，或平台没有枚举 API）—— 不可当成功 */
  | { kind: 'unverified'; reason: string };

/** 原生模块的最小结构（只声明我们用到的部分，全部可选 —— 平台差异大） */
interface CookieManagerLike {
  getAll?: (url?: string) => Promise<Record<string, unknown>>;
  get?: (url?: string, useWebKit?: boolean) => Promise<Record<string, unknown>>;
  setFromResponse?: (url: string, value: string) => Promise<boolean | void>;
  set?: (
    url: string,
    cookie: { name: string; value: string; path?: string; httpOnly?: boolean; secure?: boolean },
    useWebKit?: boolean,
  ) => Promise<boolean | void>;
  clearAll?: (withKernel?: boolean) => Promise<boolean | void>;
  clearByName?: (
    url: string,
    name: string,
    useWebKit?: boolean,
  ) => Promise<boolean | void>;
}

/** 延迟加载：原生模块缺失时（测试环境 / 没重编 APK）不能让整条链路崩 */
async function loadCookieManager(): Promise<CookieManagerLike | null> {
  try {
    const mod = await import('@react-native-cookies/cookies' as string);
    const cm = (mod as { default?: unknown }).default ?? mod;
    if (!cm || typeof cm !== 'object') return null;
    return cm as never;
  } catch {
    // 模块不存在 / 原生不可用 —— 交给调用方按「平台上没有第二个存储」处理
    return null;
  }
}

/**
 * 把异常归类成**不含敏感数据**的短标签。
 *
 * 为什么不直接用 `e.message`：原生模块的报错文本我们无法控制，
 * 万一它把 cookie 值拼进消息里，就会顺着界面/日志泄露出去。
 * 错误码和类型名是系统级分类，安全且足够定位问题。
 */
function describeError(e: unknown): string {
  if (e && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
    const name = (e as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
  }
  return 'unknown error';
}

/** 从 CookieManager 的结果里挑出 DSH 的 cookie 名（不读值） */
function dshCookieNames(all: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(all ?? {}).filter((n) => n.startsWith(DSH_COOKIE_PREFIX));
}

/** 枚举结果：成功拿到名字 / 平台不支持枚举 / 枚举失败 */
type Enumeration =
  | { kind: 'ok'; names: string[] }
  | { kind: 'unsupported' }
  | { kind: 'failed'; error: string };

/**
 * 列出当前容器里的 DSH cookie 名（**只列名字，不碰值**）。
 *
 * ## 为什么不能只用 getAll
 *
 * 真实原生实现里 `getAll` 只有 **iOS** 有：
 *
 *   iOS     RNCookieManagerIOS.m  `getAll:(BOOL)useWebKit`      → 真的返回全部
 *   Android CookieManagerModule.java
 *           `public void getAll(...) { promise.reject(new Exception(GET_ALL_NOT_SUPPORTED)); }`
 *
 * 也就是说 Android 上 `getAll` **永远 reject**。如果这里只在 getAll 失败时
 * 直接放弃，Android 每次清理都会得出「无法确认」→ 界面永远在警告
 * → 用户很快学会忽略这个警告 → 真出问题时也看不见了。
 *
 * 所以 getAll 失败要**回退到 `get(url)`**（Android/iOS 都有）：撤销/清除
 * 授权时 baseUrl 通常是有的，拿它查就够复核了。
 *
 * 只有在「getAll 失败且没有 baseUrl」或「两个 API 都没有」时，
 * 才诚实地承认枚举不了（`unsupported` / `failed`）—— 那种情况结论只能是
 * 不确定，不能倒推成成功。
 */
async function listDshCookies(
  cm: CookieManagerLike,
  baseUrl?: string,
): Promise<Enumeration> {
  let getAllError: string | undefined;

  if (typeof cm.getAll === 'function') {
    try {
      return { kind: 'ok', names: dshCookieNames(await cm.getAll(baseUrl)) };
    } catch (e) {
      // Android 的 getAll 必然走到这里（GET_ALL_NOT_SUPPORTED）
      getAllError = describeError(e);
    }
  }

  if (baseUrl && typeof cm.get === 'function') {
    try {
      return { kind: 'ok', names: dshCookieNames(await cm.get(baseUrl, true)) };
    } catch (e) {
      return { kind: 'failed', error: describeError(e) };
    }
  }

  // getAll 抛过但没 baseUrl 可用 get，或平台两个 API 都没有
  if (getAllError) return { kind: 'failed', error: getAllError };
  return { kind: 'unsupported' };
}

/**
 * 清掉原生 cookie 容器里的 DSH 会话 cookie，并**分类**返回真实结果。
 *
 * @param baseUrl 只清这个服务地址下的 cookie（避免误删别的站点）。
 *                不传则退化成全清（退出登录场景可以接受）。
 *
 * 流程：精准清（按名字）→ 兜底全清 → **复核**（只信再读一次读不到）。
 * 复核做不了 → `unverified`；复核有残留 → `partial`。
 */
export async function clearNativeCookieJarDetailed(
  baseUrl?: string,
): Promise<CookieCleanupResult> {
  const cm = await loadCookieManager();
  if (!cm) {
    // 没有 CookieManager：这个平台上 cookie 不在原生容器里
    // （比如纯 Node 环境）。没有「第二个存储」需要清。
    return { kind: 'unavailable', reason: 'native cookie manager module unavailable' };
  }

  /** 过程中收集的失败类别（只在无法给出确定结论时拼进 reason） */
  const failures: string[] = [];

  // ── 1. 精准清：按名字删 dsh-auth* ─────────────────────────
  //
  // 先枚举再删，避免误删别的站点/别的 cookie。
  // 枚举失败不算致命 —— 下面还有 clearAll 兜底，最终由复核定结论。
  const before = await listDshCookies(cm, baseUrl);
  if (before.kind === 'failed') {
    failures.push(`enumerate failed (${before.error})`);
  }
  if (before.kind === 'ok' && baseUrl && typeof cm.clearByName === 'function') {
    for (const name of before.names) {
      try {
        await cm.clearByName(baseUrl, name, true);
      } catch (e) {
        // 记类别，不记 cookie 名/值
        failures.push(`clearByName rejected (${describeError(e)})`);
      }
    }
  }

  // ── 2. 兜底全清 ───────────────────────────────────────────
  //
  // 为什么要兜底：部分平台（尤其 Android WebKit 内核）对 HttpOnly
  // cookie 的 clearByName 不生效，只有 clearAll 才真的删掉。
  // 登录态 cookie 恰好是 HttpOnly 的（服务端 Set-Cookie 里带 HttpOnly）。
  if (typeof cm.clearAll === 'function') {
    try {
      await cm.clearAll(true);
    } catch (e) {
      failures.push(`clearAll rejected (${describeError(e)})`);
    }
  } else {
    failures.push('no clearAll on this platform');
  }

  // ── 3. 复核：真的清掉了吗 ─────────────────────────────────
  //
  // 只信「再读一次读不到」，不信 API 的返回值。
  // ⚠️ 但「复核做不了」只能得出「不确定」，绝不能倒推成「清干净了」。
  const after = await listDshCookies(cm, baseUrl);

  if (after.kind === 'failed') {
    return {
      kind: 'unverified',
      reason: withFailures(`recheck failed (${after.error})`, failures),
    };
  }
  if (after.kind === 'unsupported') {
    return {
      kind: 'unverified',
      reason: withFailures('no enumeration API to recheck cookies', failures),
    };
  }
  if (after.names.length > 0) {
    // 复核**确认**有残留 —— 这是最强证据，比任何 API 返回值可信
    return { kind: 'partial', remaining: after.names.length };
  }
  // 复核确认容器里已经没有 dsh-auth* —— 成功
  return { kind: 'cleared' };
}

/** 把过程中收集的失败类别拼到 reason 里（便于排查，且不含敏感数据） */
function withFailures(reason: string, failures: string[]): string {
  if (failures.length === 0) return reason;
  return `${reason}; ${failures.join('; ')}`;
}

/**
 * 清掉原生 cookie 容器里的 DSH 会话 cookie（布尔包装）。
 *
 * 这是 `clearNativeCookieJarDetailed()` 的薄包装，保留旧签名给
 * 不方便处理联合类型的调用方用。
 *
 * 映射规则：
 *   · `cleared`     → true （已确认清干净）
 *   · `unavailable` → true （**平台没有第二个存储**，没有东西可清 ——
 *                     这是历史行为：Node/测试环境没有 CookieManager 时
 *                     也返回 true。保留它，否则会把「平台不支持」
 *                     误报成「清理失败」）
 *   · `partial`     → false（确认有残留）
 *   · `unverified`  → false（**无法确认 = 不报成功**）
 *
 * ⚠️ 需要区分「无法确认」和「平台没有」的调用方请直接用 Detailed 版本。
 */
export async function clearNativeCookieJar(baseUrl?: string): Promise<boolean> {
  const result = await clearNativeCookieJarDetailed(baseUrl);
  return result.kind === 'cleared' || result.kind === 'unavailable';
}

/**
 * 把 Keychain 里保存的 `dsh-auth*=...` 会话 Cookie 同步写回原生 CookieManager（P0-3）。
 *
 * 用途：
 *   · 先清理当前 baseUrl 下的旧 `dsh-auth*`，防止旧 Cookie 与新 Cookie 并存；
 *   · 再写入当前生效的 Cookie，确保任何依赖 `credentials: 'include'` 的请求与
 *     Keychain/DshConnection.cookie 严格一致。
 */
export async function syncNativeCookieJar(
  baseUrl: string,
  cookieHeader: string | undefined,
): Promise<boolean> {
  const trimmedBase = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmedBase) return false;
  const cm = await loadCookieManager();
  if (!cm) return true; // 纯 Node 环境无原生容器

  await clearNativeCookieJarDetailed(trimmedBase).catch(() => undefined);
  if (!cookieHeader) return true;

  const pairs = cookieHeader
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const secure = trimmedBase.startsWith('https://');

  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name.startsWith(DSH_COOKIE_PREFIX) || !value) continue;

    if (typeof cm.set === 'function') {
      try {
        await cm.set(
          trimmedBase,
          { name, value, path: '/', httpOnly: true, secure },
          true,
        );
        continue;
      } catch {
        // 回退到 setFromResponse
      }
    }
    if (typeof cm.setFromResponse === 'function') {
      try {
        await cm.setFromResponse(
          trimmedBase,
          `${name}=${value}; Path=/; HttpOnly${secure ? '; Secure' : ''}`,
        );
      } catch {
        return false;
      }
    }
  }
  return true;
}
