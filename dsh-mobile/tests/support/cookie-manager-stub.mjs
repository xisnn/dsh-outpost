/**
 * @react-native-cookies/cookies 的 Node 替身。
 *
 * ## 为什么要它
 *
 * `DshConnection.loginWithToken()` 换到 cookie 后，会调
 * `readCookieFromJar()` 从 RN 的原生 cookie 容器读回来。
 * 那个模块在 Node 里不存在，会走到 catch 分支返回 undefined，
 * 于是报 `token exchange failed: no cookie in jar`。
 *
 * ## 它做什么
 *
 * 维护一个简单的 (url → cookies) 表。真实 CookieManager 的行为：
 *   · `get(url)` 返回该 url 匹配的 cookie 字典
 *   · `set(url, cookie)` 写入
 *   · `clearAll()` 清空
 *
 * 测试里由 fake-dsh 的 303 响应触发写入 —— 但 Node fetch 不会自动
 * 把 Set-Cookie 塞进这里（没有浏览器语义），所以测试要显式 set。
 *
 * 这也是个真实提醒：**RN 里 fetch 带 credentials:'include' 会自动
 * 处理 cookie（走原生实现），但 Node 的 fetch 不会**。
 * 所以这个 stub 是「测试脚手架」，不是「模拟了一个假行为」。
 */

/** @type {Map<string, Record<string, { name: string; value: string }>>} */
const jar = new Map();

/** 从 URL 抽出 host 作为 key（真实 CookieManager 按 domain 匹配） */
function keyOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

const CookieManager = {
  async get(url) {
    const host = keyOf(url);
    return jar.get(host) ?? {};
  },

  async set(url, cookie) {
    const host = keyOf(url);
    const cur = jar.get(host) ?? {};
    const name = cookie?.name;
    if (!name) return;
    cur[name] = { name, value: String(cookie.value ?? '') };
    jar.set(host, cur);
  },

  async setFromResponse(url, setCookieHeader) {
    // 真实实现会解析 Set-Cookie 响应头。测试里 fake-dsh 的 303
    // 会带一条 `dsh-auth-test=v1.xxx; Path=/; HttpOnly` —— 这里解析它。
    const host = keyOf(url);
    const cur = jar.get(host) ?? {};
    const first = String(setCookieHeader ?? '').split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      cur[name] = { name, value };
      jar.set(host, cur);
    }
  },

  async clearAll() {
    jar.clear();
    return null;
  },

  async clearByName(url) {
    jar.delete(keyOf(url));
    return null;
  },

  // ── 测试辅助 ──────────────────────────────────────────────
  __dump() {
    return Object.fromEntries(jar);
  },
  __reset() {
    jar.clear();
  },
};

export default CookieManager;
export { CookieManager };
