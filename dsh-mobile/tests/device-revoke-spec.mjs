/**
 * 服务端设备撤销的测试。
 *
 * ## 守什么
 *
 * 「退出并清除所有授权」不能只清本机凭据 —— 服务端还留着一条可用记录，
 * 手机丢了就是后门。所以清授权时必须**先撤销服务端**再清本地。
 *
 * ## 服务端能力（已实测确认）
 *
 *   GET  /mgw/devices               列出已配对设备
 *   POST /mgw/devices/<id>/revoke   撤销（会 close(4003) 踢掉在线连接）
 *
 * 两个坑：
 *   · 撤销必须带同源 Origin，否则 403（CSRF 保护）
 *   · 服务端的 device.id 是 UUID，客户端存的是 `dsh-outpost-xxx`，
 *     两者不同 —— 要用 clientDeviceId 匹配
 *
 * ## 这一组用模拟服务端跑
 *
 * 真实 DSH 的撤销会真的删掉设备记录，不适合放进自动化测试
 * （跑一次就把环境搞脏了）。所以这里用 fake-dsh 模拟同样的协议。
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

// ── 一个只实现 /mgw/devices 和 /revoke 的最小服务端 ──────────────
//
// 复刻真实插件的关键行为：
//   · 非 GET 请求校验同源 Origin（不带就 403）
//   · revoke 成功返回 {revoked:true}，不存在返回 404
//   · device.id 是 UUID，clientDeviceId 是客户端标识

function startRevokeServer() {
  /** id → { id, name, clientDeviceId } */
  const devices = new Map();
  const revokeCalls = [];
  const forbiddenCalls = [];
  const token = 'TESTTOKEN_' + Math.random().toString(36).slice(2);
  const cookieName = 'dsh-auth-test';

  /** 所有打开的 socket，退出前强制销毁 */
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;

    // 登录换 cookie
    if (req.method === 'GET' && p === '/' && url.searchParams.has('token')) {
      if (url.searchParams.get('token') !== token) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      res.writeHead(303, {
        location: './api/remote.mux',
        'set-cookie': `${cookieName}=v1; Path=/; HttpOnly`,
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && p === '/api/remote.mux') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('ok');
      return;
    }

    // 下面两个是重点
    if (req.method === 'GET' && p === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices: [...devices.values()] }));
      return;
    }

    if (req.method === 'POST' && p.startsWith('/mgw/devices/') && p.endsWith('/revoke')) {
      // 同源校验（和真实插件一致）
      const origin = req.headers.origin;
      const host = req.headers.host;
      const sameOrigin = origin && host && new URL(origin).host === host;
      if (!sameOrigin) {
        forbiddenCalls.push({ origin, host });
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'cross-origin management request rejected' }));
        return;
      }
      const id = decodeURIComponent(p.slice('/mgw/devices/'.length, -'/revoke'.length));
      revokeCalls.push(id);
      const existed = devices.delete(id);
      res.writeHead(existed ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revoked: existed }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not-found' }));
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        authority: `127.0.0.1:${port}`,
        token,
        cookie: `${cookieName}=v1`,
        devices,
        revokeCalls,
        forbiddenCalls,
        close: async () => {
          // 强制销毁所有 socket，再关服务端。
          // 只调用 server.close() 的话，keep-alive 连接会让回调
          // 永远等不到，进程退出时 libuv 报 handle 未关闭。
          for (const s of sockets) s.destroy();
          sockets.clear();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

const { revokeOwnDevice, listPairedDevices } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
);

// ══════════════════════════════════════════════════════════════

await check('列出设备：能拿到服务端的设备列表', async () => {
  const srv = await startRevokeServer();
  try {
    srv.devices.set('uuid-1', {
      id: 'uuid-1',
      name: '手机',
      clientDeviceId: 'dsh-outpost-abc',
    });
    const list = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (list.length !== 1) return `期望 1 台，得到 ${list.length}`;
    return list[0].id === 'uuid-1' ? true : 'id 不对';
  } finally {
    await srv.close();
  }
});

await check('撤销：用 clientDeviceId 找到服务端的 UUID 再撤销', async () => {
  const srv = await startRevokeServer();
  try {
    srv.devices.set('uuid-real-id', {
      id: 'uuid-real-id',
      name: '手机',
      clientDeviceId: 'dsh-outpost-xyz',
    });
    // 客户端只知道自己的 clientDeviceId
    const outcome = await revokeOwnDevice(srv.baseUrl, srv.cookie, 'dsh-outpost-xyz');
    if (outcome !== 'revoked') return `结果不对：${outcome}`;
    if (srv.revokeCalls[0] !== 'uuid-real-id') {
      return `撤销了错误的 id：${srv.revokeCalls[0]}`;
    }
    return srv.devices.size === 0 ? true : '服务端记录没删掉';
  } finally {
    await srv.close();
  }
});

await check('撤销：必须带同源 Origin（否则 403）', async () => {
  const srv = await startRevokeServer();
  try {
    srv.devices.set('uuid-2', { id: 'uuid-2', name: '手机', clientDeviceId: 'dsh-outpost-q' });
    // 我们的实现会带 Origin，所以不该被拒
    const outcome = await revokeOwnDevice(srv.baseUrl, srv.cookie, 'dsh-outpost-q');
    if (srv.forbiddenCalls.length > 0) {
      return `被 CSRF 校验拒了：${JSON.stringify(srv.forbiddenCalls[0])}`;
    }
    return outcome === 'revoked' ? true : `结果不对：${outcome}`;
  } finally {
    await srv.close();
  }
});

await check('撤销：设备已不存在时返回 already-gone（不算失败）', async () => {
  const srv = await startRevokeServer();
  try {
    // 服务端没有这台设备
    const outcome = await revokeOwnDevice(srv.baseUrl, srv.cookie, 'dsh-outpost-nonexistent');
    return outcome === 'already-gone' ? true : `结果不对：${outcome}`;
  } finally {
    await srv.close();
  }
});

await check('撤销：网络不可达时返回 failed（让上层提示用户）', async () => {
  // 用一个关了端口
  const outcome = await revokeOwnDevice('http://127.0.0.1:1', 'cookie', 'dsh-outpost-z');
  return outcome === 'failed' ? true : `结果不对：${outcome}`;
});

await check('撤销：deviceId 为空时直接 failed，不发请求', async () => {
  const srv = await startRevokeServer();
  try {
    const outcome = await revokeOwnDevice(srv.baseUrl, srv.cookie, '');
    if (outcome !== 'failed') return `结果不对：${outcome}`;
    return srv.revokeCalls.length === 0 ? true : '不该发请求';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 顺序：必须先撤销服务端再清本地
// ══════════════════════════════════════════════════════════════

const { readFileSync } = await import('node:fs');
const appSrc = readFileSync('src/App.tsx', 'utf8');

await check('clearAuthorization 先撤销服务端，再清本地', () => {
  const i = appSrc.indexOf('const clearAuthorization');
  if (i < 0) return '找不到实现';
  const body = appSrc.slice(i, i + 2000);
  const revokeIdx = body.indexOf('revokeOwnDevice');
  const clearIdx = body.indexOf('clearAllCredentials');
  if (revokeIdx < 0) return '没有调用 revokeOwnDevice';
  if (clearIdx < 0) return '没有调用 clearAllCredentials';
  return revokeIdx < clearIdx
    ? true
    : '先清了本地再撤销 —— 那时已经没法证明身份，服务端记录永远留着';
});

await check('撤销失败时会提示用户', () => {
  const i = appSrc.indexOf('const clearAuthorization');
  const body = appSrc.slice(i, i + 2000);
  return body.includes('notifyRevokeFailed') ? true : '撤销失败静默处理，用户以为彻底清了';
});

await check('撤销失败不阻塞本地清理', () => {
  const i = appSrc.indexOf('const clearAuthorization');
  const body = appSrc.slice(i, i + 2000);
  // 网络不通时也必须能清掉本机凭据
  if (!/revokeFailed\s*=\s*true/.test(body)) return '找不到 revokeFailed 标记';
  return /await clearAllCredentials\(\)/.test(body) ? true : '本地清理被跳过了';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);

// 不用 process.exit：tsx 的 loader 在强制退出时可能触发 libuv 断言
// （0xC0000409）。设置 exitCode 让事件循环自己结束后以正确状态退出。
process.exitCode = fail === 0 ? 0 : 1;
