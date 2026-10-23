/**
 * 给 Node 的 fetch 加「浏览器 cookie 语义」。
 *
 * ## 为什么需要
 *
 * 产品代码是这样的：
 *
 *   // loginWithToken
 *   await fetch(`${baseUrl}/?token=xxx`, { credentials: 'include' })
 *   const cookie = await CookieManager.get(baseUrl)   // ← 从原生容器读
 *
 * 在 RN 里，`credentials:'include'` 由原生实现处理：Set-Cookie 自动进容器。
 * **但 Node 的 fetch 不会** —— 它既不存 Set-Cookie，也不在后续请求里带上。
 *
 * 所以直接拿 Node fetch 跑产品代码，会得到
 * `token exchange failed: no cookie in jar`。
 *
 * ## 这个文件做什么
 *
 * 包一层 fetch，补齐三个浏览器行为：
 *   1. 收到 Set-Cookie → 写进 cookie jar
 *   2. 发请求时 → 从 jar 取匹配的 cookie 放进 Cookie 头
 *   3. credentials:'include' → 同源/跨源按浏览器规则处理（这里简化成总是带）
 *
 * 这样产品代码的行为就和在 RN 里一致了，测的才是真东西。
 */

/** @type {Map<string, Record<string, string>>} */
const jar = new Map();

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/** 解析一条 Set-Cookie，返回 { name, value } */
function parseSetCookie(raw) {
  const first = String(raw ?? '').split(';')[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() };
}

/** 造一个带 cookie 语义的 fetch */
export function makeCookieFetch(realFetch = globalThis.fetch) {
  return async function cookieFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input);
    const host = hostOf(url);

    // ── 出站：带上 jar 里的 cookie ──────────────────────────
    const cookies = jar.get(host) ?? {};
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const headers = new Headers(init.headers ?? {});
    if (cookieHeader && !headers.has('Cookie')) {
      headers.set('Cookie', cookieHeader);
    }

    // ⚠️ 关键：不能用 redirect:'manual'。
    //
    // 产品代码明确写了「RN 的 fetch 不支持 redirect:'manual'，
    // 303 会被自动跟随成 200」（见 transport/index.ts 的注释）。
    // 所以这里保持默认的 follow —— 和 RN 一致。
    //
    // 但 follow 有个后果：中间那次 303 的 Set-Cookie 被 Node 吞掉了，
    // res.headers 里看不到。所以我们要自己接管重定向：
    // 用 manual 发一次，如果拿到 303 就记下 Set-Cookie，再手动跟随。
    //
    // 这样既复现了 RN 的「最终 200」行为，又没丢掉 cookie。
    const first = await realFetch(input, {
      ...init,
      headers,
      redirect: 'manual',
    });

    let res = first;

    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get('location');
      if (location) {
        // 先收进站 Set-Cookie
        absorbSetCookies(first, host);
        // 手动跟随（相对路径要解析）
        const nextUrl = new URL(location, url).href;
        const nextCookies = jar.get(hostOf(nextUrl)) ?? {};
        const nextHeader = Object.entries(nextCookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
        const nextHeaders = new Headers(init.headers ?? {});
        if (nextHeader) nextHeaders.set('Cookie', nextHeader);
        res = await realFetch(nextUrl, {
          ...init,
          headers: nextHeaders,
          redirect: 'follow',
        });
      }
    }

    // ── 入站：把 Set-Cookie 收进 jar ────────────────────────
    absorbSetCookies(res, host);

    return res;
  };
}

/** 把响应里的 Set-Cookie 写进 jar */
function absorbSetCookies(res, host) {
  const setCookies =
    res.headers.getSetCookie?.() ??
    (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const raw of setCookies) {
    const parsed = parseSetCookie(raw);
    if (!parsed) continue;
    const cur = jar.get(host) ?? {};
    // 空值 + Max-Age=0 之类表示删除，这里简化：空值就删
    if (parsed.value === '') delete cur[parsed.name];
    else cur[parsed.name] = parsed.value;
    jar.set(host, cur);
  }
}

/** 读某个 host 下的 cookie（模拟 CookieManager.get） */
export function getCookies(url) {
  return { ...(jar.get(hostOf(url)) ?? {}) };
}

/** 清空 jar */
export function resetCookies() {
  jar.clear();
}

/** 直接塞一个 cookie（测试预置用） */
export function setCookie(url, name, value) {
  const host = hostOf(url);
  const cur = jar.get(host) ?? {};
  cur[name] = value;
  jar.set(host, cur);
}
