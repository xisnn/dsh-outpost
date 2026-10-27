/**
 * 登录安全回归测试：错误凭据绝不能被判为成功。
 *
 * ## 背景
 *
 * 模拟器验收时发现 `loginWithToken()` 把「配对成功」误判成 401
 * （RN 跟随 303 后落到 `GET /`，那一步没带上 cookie）。
 *
 * 第一版修复把判断顺序改成「先看 cookie jar，再看状态码」，
 * 但**漏了清空 jar**，于是产生一个新的安全问题：
 *
 *   如果 jar 里本来就有旧 cookie，那么无论 token 对不对，
 *   都会「登录成功」—— 认证被完全绕过。
 *
 * 正确修复是「登录前清空本服务的 cookie jar」+「先看 jar」。
 *
 * ## 这个文件怎么测
 *
 * 用**真实的产品代码**（DshConnection），通过注入一个
 * 可观察的 cookie reader 来验证：
 *
 *   1. reader 被调用时，jar 是否已经被清过
 *   2. 错误 token 时，能不能因为旧 cookie 而「通过」
 *
 * 关键设计：reader 的行为由 shim 的 jar 决定 —— 产品代码的
 * `clearCookieJar()` 会真的清到它。这样测的是完整链路，
 * 而不是「假设清过了」。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

register('./support/rn-module-hook.mjs', import.meta.url);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

const SHIM_DIR = path.join(__dirname, 'support');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(SHIM_DIR, '_async-storage-shim.cjs');
  }
  if (request === '@react-native-cookies/cookies') {
    return path.join(SHIM_DIR, '_cookie-manager-shim.cjs');
  }
  if (request === 'react-native-keychain') {
    return path.join(SHIM_DIR, '_keychain-shim.cjs');
  }
  return origResolve.call(this, request, parent, ...rest);
};

let pass = 0;
let fail = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
async function check(n, fn) {
  try {
    const r = await fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

const CookieShim = require(path.join(SHIM_DIR, '_cookie-manager-shim.cjs'));

const VALID_TOKEN = '{{SECRET_9bhby36q}}';

// ── 最小登录服务端（复刻真实行为）──────────────────────────────

function startLoginServer() {
  const sockets = new Set();
  let validLogins = 0;
  let invalidLogins = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');

    // 登录：带 token 参数
    if (url.searchParams.has('token')) {
      const tok = url.searchParams.get('token');
      if (tok === VALID_TOKEN) {
        validLogins += 1;
        res.writeHead(303, {
          location: './',
          'set-cookie': 'dsh-auth-NEW=v1.fresh.payload; Path=/; HttpOnly',
        });
        res.end();
        return;
      }
      invalidLogins += 1;
      // 无效 token：401，且**绝不下发 cookie**
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }

    // 跟随重定向后的 GET /
    if (url.pathname === '/') {
      const cookie = req.headers.cookie ?? '';
      if (cookie.includes('dsh-auth')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>ok</html>');
      } else {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        get validLogins() {
          return validLogins;
        },
        get invalidLogins() {
          return invalidLogins;
        },
        close: async () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

/**
 * 造连接。cookie 读写在 shim 的 jar 里 —— 产品代码的
 * clearCookieJar() 会真的作用于它，链路完整。
 */
async function makeConn(baseUrl) {
  const { DshConnection } = await imp(
    path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
  );

  const fetchImpl = async (input, init) => {
    const res = await fetch(input, init);
    // 模拟原生网络栈：收到 Set-Cookie 就写进 jar
    //
    // ⚠️ Node 的 fetch 会自动跟随 303，而**跟随之后 set-cookie 就丢了**。
    // RN 也有同样的现象（这正是我们要修的那个 bug 的来源），
    // 但 RN 的原生层会在跟随**之前**把 Set-Cookie 写进 cookie jar。
    //
    // 所以这里单独补一次：用 redirect: 'manual' 拿原始 303 的响应头，
    // 只为了把 cookie 存进 jar，模拟 RN 原生层的行为。
    // 主请求的返回值仍是跟随后的 res，和 RN 一致。
    if (res.redirected || res.status >= 300) {
      try {
        const raw = await fetch(input, { ...init, redirect: 'manual' });
        const sc = raw.headers.get('set-cookie');
        if (sc) {
          const m = sc.match(/(dsh-auth[^=]*)=([^;]+)/);
          if (m) await CookieShim.set(baseUrl, { name: m[1], value: m[2] });
        }
      } catch {
        /* 忽略：拿不到就算了 */
      }
    }
    return res;
  };

  const conn = new DshConnection({ baseUrl, fetchImpl });
  conn.setCookieReader(async (u) => {
    const all = await CookieShim.get(u);
    const parts = Object.entries(all ?? {})
      .filter(([n]) => n.startsWith('dsh-auth'))
      .map(([n, c]) => `${n}=${c?.value ?? ''}`);
    return parts.length ? parts.join('; ') : undefined;
  });
  return conn;
}

/** 往 jar 里塞一个「历史遗留」cookie */
async function seedStale(baseUrl) {
  await CookieShim.set(baseUrl, {
    name: 'dsh-auth-STALE',
    value: 'v1.stale.payload',
  });
}

async function jarHas(baseUrl, needle) {
  const all = await CookieShim.get(baseUrl);
  return Object.keys(all ?? {}).some((n) => n.includes(needle));
}

// ══════════════════════════════════════════════════════════════
// 一、正常路径
// ══════════════════════════════════════════════════════════════

await check('有效 token → 登录成功并拿到 cookie', async () => {
  const srv = await startLoginServer();
  CookieShim.__reset();
  try {
    const conn = await makeConn(srv.baseUrl);
    const cookie = await conn.loginWithToken(VALID_TOKEN);
    if (!cookie || !String(cookie).includes('dsh-auth')) return '没返回有效 cookie';
    // 注意：测试的 fetch 为了抓 set-cookie 会额外发一次请求，
    // 所以这里只要求「至少 1 次有效登录」，不苛求精确次数。
    if (srv.validLogins < 1) return '服务端没收到有效登录请求';
    return true;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 二、安全边界（核心）
// ══════════════════════════════════════════════════════════════

await check('🔴 错误 token + jar 里有历史 cookie → 必须失败', async () => {
  const srv = await startLoginServer();
  CookieShim.__reset();
  await seedStale(srv.baseUrl);
  try {
    const conn = await makeConn(srv.baseUrl);
    let threw = false;
    try {
      await conn.loginWithToken('WRONG_TOKEN');
    } catch {
      threw = true;
    }
    if (!threw) {
      return '错误 token 被判成成功 —— jar 里的历史 cookie 让它通过了，这是认证绕过';
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('🔴 错误 token（jar 为空）→ 必须失败', async () => {
  const srv = await startLoginServer();
  CookieShim.__reset();
  try {
    const conn = await makeConn(srv.baseUrl);
    let threw = false;
    try {
      await conn.loginWithToken('WRONG_TOKEN');
    } catch {
      threw = true;
    }
    return threw ? true : '错误 token 被判成成功';
  } finally {
    await srv.close();
  }
});

await check('🔴 登录前清空了历史 cookie', async () => {
  const srv = await startLoginServer();
  CookieShim.__reset();
  await seedStale(srv.baseUrl);
  try {
    const hadStale = await jarHas(srv.baseUrl, 'STALE');
    if (!hadStale) return '测试前提不成立：没种进历史 cookie';

    const conn = await makeConn(srv.baseUrl);
    await conn.loginWithToken(VALID_TOKEN);

    // 登录成功后，历史 cookie 应当已被清掉
    const stillStale = await jarHas(srv.baseUrl, 'STALE');
    return stillStale ? '历史 cookie 还在 —— 登录前没有清空 jar' : true;
  } finally {
    await srv.close();
  }
});

await check('🔴 换服务端 → 不能复用上一个的 cookie', async () => {
  const srvA = await startLoginServer();
  const srvB = await startLoginServer();
  CookieShim.__reset();
  try {
    // A 上正常登录
    const connA = await makeConn(srvA.baseUrl);
    await connA.loginWithToken(VALID_TOKEN);

    // B 上用错误 token —— 不能因为 jar 里（A 的地址下）有 cookie 就成功
    const connB = await makeConn(srvB.baseUrl);
    let threw = false;
    try {
      await connB.loginWithToken('WRONG_TOKEN');
    } catch {
      threw = true;
    }
    return threw ? true : '在 B 上用错误 token 却成功了 —— 复用了别的服务端的 cookie';
  } finally {
    await srvA.close();
    await srvB.close();
  }
});

await check('🔴 服务端不可达 → 明确报错', async () => {
  CookieShim.__reset();
  const conn = await makeConn('http://127.0.0.1:1');
  await seedStale('http://127.0.0.1:1');
  let threw = false;
  try {
    await conn.loginWithToken(VALID_TOKEN);
  } catch {
    threw = true;
  }
  return threw ? true : '连不上却报成功 —— 又是历史 cookie 误判';
});

// ══════════════════════════════════════════════════════════════
// 三、静态校验：确保 fix 不会被误删
// ══════════════════════════════════════════════════════════════

const { readFileSync } = await import('node:fs');
const transportSrc = readFileSync('src/core/transport/index.ts', 'utf8');

await check('loginWithToken 在发请求前调用了 clearCookieJar', () => {
  const i = transportSrc.indexOf('async loginWithToken');
  if (i < 0) return '找不到 loginWithToken';
  const body = transportSrc.slice(i, i + 2000);
  const clearIdx = body.indexOf('clearCookieJar');
  const fetchIdx = body.indexOf('this.fetchImpl');
  if (clearIdx < 0) return '没有调用 clearCookieJar —— 历史 cookie 会让错误 token 通过';
  if (fetchIdx < 0) return '找不到 fetch 调用';
  return clearIdx < fetchIdx ? true : '清理在请求之后才做，起不到作用';
});

await check('readCookieFromJar 只认 dsh-auth 前缀', () => {
  const i = transportSrc.indexOf('private async readCookieFromJar');
  if (i < 0) return '找不到';
  const body = transportSrc.slice(i, i + 1400);
  return body.includes("startsWith('dsh-auth')") ? true : '没有按前缀过滤，可能读进无关 cookie';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
