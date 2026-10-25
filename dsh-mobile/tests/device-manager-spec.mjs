/**
 * 设备管理页的测试。
 *
 * ## 守什么
 *
 * 手机能批准电脑执行命令，所以「谁有权限」必须能看到、能收回。
 *
 *   · 能列出所有已配对设备（含在线状态、最后活跃时间）
 *   · 能撤销任意设备（不只是自己）
 *   · 撤销走二次确认（不可逆，误触代价大）
 *   · 能认出「这台手机」，撤销它时给出不同的警告
 *
 * 服务端协议用最小的模拟服务端验证（真实 DSH 的撤销会
 * 真的删记录，不适合自动化跑）。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { readFileSync } from 'node:fs';

register('./support/rn-module-hook.mjs', import.meta.url);

const createRequireFn = createRequire;
void createRequireFn;
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

// ── 最小设备服务端（复刻真实插件的协议）─────────────────────────

function startDeviceServer(seed) {
  const devices = new Map();
  for (const d of seed) devices.set(d.id, { ...d });
  const sockets = new Set();
  const revokeCalls = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices: [...devices.values()] }));
      return;
    }

    if (req.method === 'POST' && p.startsWith('/mgw/devices/') && p.endsWith('/revoke')) {
      const origin = req.headers.origin;
      const host = req.headers.host;
      const sameOrigin = origin && host && new URL(origin).host === host;
      if (!sameOrigin) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      const id = decodeURIComponent(p.slice('/mgw/devices/'.length, -'/revoke'.length));
      revokeCalls.push(id);
      const existed = devices.delete(id);
      res.writeHead(existed ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revoked: existed }));
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
      const port = server.address().port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: 'dsh-auth-test=v1',
        devices,
        revokeCalls,
        close: async () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

const { listPairedDevices, revokeDevice } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
);

// ══════════════════════════════════════════════════════════════
// 服务端协议
// ══════════════════════════════════════════════════════════════

await check('列出设备：带上了完整信息（在线、活跃时间）', async () => {
  const srv = await startDeviceServer([
    {
      id: 'uuid-a',
      name: '手机',
      displayName: '手机 (1)',
      online: true,
      connections: 1,
      lastSeenAt: Date.now(),
      createdAt: Date.now() - 86400000,
      clientDeviceId: 'dsh-outpost-aaa',
    },
  ]);
  try {
    const res = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (!res.ok) return `请求失败：${res.kind} ${res.message}`;
    if (res.devices.length !== 1) return `期望 1 台，得到 ${res.devices.length}`;
    const d = res.devices[0];
    if (!d.displayName) return '缺 displayName';
    if (d.online !== true) return '缺 online 状态';
    if (!d.lastSeenAt) return '缺 lastSeenAt';
    if (!d.clientDeviceId) return '缺 clientDeviceId（没法认出「这台手机」）';
    return true;
  } finally {
    await srv.close();
  }
});

await check('撤销任意设备：能撤掉别人的（不只是自己）', async () => {
  const srv = await startDeviceServer([
    { id: 'uuid-me', name: '我的手机', clientDeviceId: 'dsh-outpost-me' },
    { id: 'uuid-old', name: '旧手机', clientDeviceId: 'dsh-outpost-old' },
  ]);
  try {
    // 撤「旧手机」，不是自己
    const outcome = await revokeDevice(srv.baseUrl, srv.cookie, 'uuid-old');
    if (outcome !== 'revoked') return `结果不对：${outcome}`;
    if (srv.revokeCalls[0] !== 'uuid-old') return `撤错了：${srv.revokeCalls[0]}`;
    if (srv.devices.has('uuid-me') !== true) return '把自己也撤了';
    return srv.devices.size === 1 ? true : '数量不对';
  } finally {
    await srv.close();
  }
});

await check('撤销任意设备：不存在时返回 already-gone', async () => {
  const srv = await startDeviceServer([]);
  try {
    const outcome = await revokeDevice(srv.baseUrl, srv.cookie, 'uuid-nope');
    return outcome === 'already-gone' ? true : `结果不对：${outcome}`;
  } finally {
    await srv.close();
  }
});

await check('撤销任意设备：网络不通时返回 failed', async () => {
  const outcome = await revokeDevice('http://127.0.0.1:1', 'c', 'uuid-x');
  return outcome === 'failed' ? true : `结果不对：${outcome}`;
});

// ══════════════════════════════════════════════════════════════
// 界面行为（静态检查）
// ══════════════════════════════════════════════════════════════

const src = readFileSync('src/screens/DevicesScreen.tsx', 'utf8');

await check('页面列出设备并显示在线状态', () => {
  if (!src.includes('listPairedDevices')) return '没有调用列表接口';
  if (!src.includes('d.online')) return '没有显示在线状态';
  return true;
});

await check('页面显示最后活跃时间', () => {
  if (!src.includes('lastSeenAt')) return '没有用 lastSeenAt';
  return src.includes('relTime') ? true : '没有格式化成「N 分钟前」';
});

await check('撤销走二次确认（不可逆操作）', () => {
  const i = src.indexOf('askRevoke');
  if (i < 0) return '没有二次确认';
  const body = src.slice(i, i + 900);
  if (!body.includes('Alert.alert')) return '没有弹确认框';
  return /style:\s*'cancel'/.test(body) ? true : '没有「取消」选项';
});

await check('撤销自己时给出不同的警告', () => {
  const i = src.indexOf('askRevoke');
  const body = src.slice(i, i + 900);
  // 自己 vs 别人应该有两套文案
  return body.includes('isSelf') ? true : '没有区分自己/别人';
});

await check('能认出「这台手机」', () => {
  if (!src.includes('selfId')) return '没有读本机 device id';
  if (!src.includes('CredentialKey.gatewayDeviceId')) return '没从 Keystore 读';
  return src.includes('这台手机') ? true : '没有标记出自己';
});

await check('撤销成功后从列表移除（不整页刷新）', () => {
  const i = src.indexOf('doRevoke');
  if (i < 0) return '找不到 doRevoke';
  const body = src.slice(i, i + 3000);
  // 允许写法差异（括号/空格/三元），只要是对列表做 filter
  return /filter\(\(d\) => d\.id !== device\.id\)/.test(body)
    ? true
    : '撤销后没有局部更新列表';
});

await check('支持下拉刷新', () => {
  return src.includes('RefreshControl') && src.includes('onRefresh')
    ? true
    : '没有下拉刷新（列表可能过期）';
});

await check('撤销失败时提示用户', () => {
  const i = src.indexOf('doRevoke');
  const body = src.slice(i, i + 900);
  return body.includes('撤销失败') ? true : '失败静默处理';
});

// ══════════════════════════════════════════════════════════════
// 接入
// ══════════════════════════════════════════════════════════════

const appSrc = readFileSync('src/App.tsx', 'utf8');
const profileSrc = readFileSync('src/screens/ProfileScreen.tsx', 'utf8');

await check('路由已挂到 App', () => {
  if (!appSrc.includes('DevicesScreen')) return '没 import';
  return /case 'Devices'/.test(appSrc) ? true : '没有路由分支';
});

await check('「我的」页有入口', () => {
  if (!profileSrc.includes("nav.push('Devices')")) return '没有入口';
  return profileSrc.includes('设备管理') ? true : '入口文案缺失';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
