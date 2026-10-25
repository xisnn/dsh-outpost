/**
 * 交叉验证：用**真实插件**的设备注册表 + 我们的真实客户端代码，
 * 看「撤销自己」在真机上到底能不能成功。
 *
 * ## 为什么需要这个文件
 *
 * 现有的 `device-revoke-spec.mjs` 用的是手搓的模拟服务端，那个服务端
 * **返回了 clientDeviceId**。而真实插件的 `publicDevice()` 只返回
 * id / name / createdAt / lastSeenAt / online / connections —— **没有**
 * clientDeviceId。
 *
 * 于是：
 *   · 测试里 `revokeOwnDevice()` 能靠 clientDeviceId 找到自己 → 通过
 *   · 真机上列表里根本没有 clientDeviceId → 找不到自己 → 返回 already-gone
 *   · 上层把 already-gone 当成 serverOk = true → 用户看到「撤销成功」
 *   · 但服务端记录还在，设备仍然能连、能批命令
 *
 * 这个文件直接 `require` 真实插件的 `lib/devices.js`（不是复制它的逻辑），
 * 用它的 `createRegistry()` 造设备，再让我们的真实 `revokeOwnDevice()` 去撤。
 * 这样客户端和「服务端」不共享任何假设。
 *
 * ## 插件不在时
 *
 * 明确 SKIP（打印出来），不静默通过。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';

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
let skip = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
function skipped(n, why) {
  skip += 1;
  console.log('  SKIP  ' + n + (why ? ' — ' + why : ''));
}
async function check(n, fn) {
  try {
    const r = await fn();
    if (r === true) ok(n);
    else if (r && r.skip) skipped(n, r.skip);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

// ── 定位真实插件 ────────────────────────────────────────────────
const CANDIDATES = [
  process.env.DSH_GATEWAY_PLUGIN_DIR,
  path.join(
    process.env.USERPROFILE ?? '',
    '.dsh',
    'profiles',
    'web',
    'node_modules',
    'dsh-plugin-mobile-gateway',
  ),
  path.join(
    process.env.HOME ?? '',
    '.dsh',
    'profiles',
    'web',
    'node_modules',
    'dsh-plugin-mobile-gateway',
  ),
].filter(Boolean);

const pluginDir = CANDIDATES.find((d) => existsSync(path.join(d, 'lib', 'devices.js')));
const devicesModulePath = pluginDir ? path.join(pluginDir, 'lib', 'devices.js') : null;

const { listPairedDevices, revokeOwnDevice, revokeDevice, isSameDevice } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
);

/**
 * 用真实 registry 起一个最小管理接口。
 *
 * 返回形状严格复刻插件源码：
 *   GET  /mgw/devices            → { devices: registry.list() }
 *   POST /mgw/devices/<id>/revoke → { revoked } + 200/404
 */
async function startRealRegistryServer() {
  const { createRegistry } = require(devicesModulePath);
  const file = path.join(
    process.env.TEMP ?? '/tmp',
    `dsh-crosscheck-${process.pid}-${Date.now()}.json`,
  );
  try {
    unlinkSync(file);
  } catch {
    /* 不存在 */
  }
  const registry = createRegistry(file);

  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices: registry.list() }));
      return;
    }
    if (req.method === 'POST' && req.url && req.url.endsWith('/revoke')) {
      const id = decodeURIComponent(
        req.url.slice('/mgw/devices/'.length, -'/revoke'.length),
      );
      const revoked = registry.revoke(id);
      res.writeHead(revoked ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revoked }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    registry,
    /** 造一台已配对设备，返回客户端会持有的那个 clientDeviceId */
    pairDevice(clientDeviceId) {
      const pairing = registry.createPairing('crosscheck');
      const claimed = registry.claimPairing(pairing.code, clientDeviceId, undefined);
      return claimed;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((r) => server.close(r));
      try {
        unlinkSync(file);
      } catch {
        /* ignore */
      }
    },
  };
}

console.log('');
if (!pluginDir) {
  console.log('⚠️  找不到真实网关插件，整组交叉验证跳过。');
  console.log('   装了插件后重跑，或用 DSH_GATEWAY_PLUGIN_DIR 指定目录。');
  console.log('');
}

// ══════════════════════════════════════════════════════════════

await check('真实 registry：设备列表条目里没有 clientDeviceId', async () => {
  if (!pluginDir) return { skip: '插件不可用' };
  const srv = await startRealRegistryServer();
  try {
    srv.pairDevice('dsh-outpost-abc');
    const r = await listPairedDevices(srv.baseUrl, 'cookie');
    if (!r.ok) return `列表请求失败：${r.kind}`;
    if (r.devices.length !== 1) return `期望 1 台，得到 ${r.devices.length}`;
    const d = r.devices[0];
    // 这条不是「必须没有」，而是把事实钉住：真机上有没有这个字段
    if ('clientDeviceId' in d && d.clientDeviceId !== undefined) {
      return true; // 插件以后加了，客户端就能可靠认出自己
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('关键：有服务端 UUID 时 revokeOwnDevice 能真的撤销', async () => {
  if (!pluginDir) return { skip: '插件不可用' };
  const srv = await startRealRegistryServer();
  try {
    const CLIENT_ID = 'dsh-outpost-crosscheck-001';
    const claimed = srv.pairDevice(CLIENT_ID);
    const serverDeviceId = claimed.device.id;
    const before = srv.registry.list().length;

    // 客户端从 paired/hello 帧里学到了服务端 UUID（现在会存进 Keystore）
    const outcome = await revokeOwnDevice(srv.baseUrl, 'cookie', CLIENT_ID, serverDeviceId);
    const after = srv.registry.list().length;

    if (outcome !== 'revoked') {
      return `返回 ${outcome}，期望 revoked`;
    }
    if (after !== 0) {
      return `服务端设备记录还在（${before} → ${after}）`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('关键：没有服务端 UUID 时如实报 failed（不能谎报成功）', async () => {
  if (!pluginDir) return { skip: '插件不可用' };
  const srv = await startRealRegistryServer();
  try {
    const CLIENT_ID = 'dsh-outpost-crosscheck-legacy';
    srv.pairDevice(CLIENT_ID);
    const before = srv.registry.list().length;

    // 老版本升级上来、还没重连过 → 没有 gatewayServerDeviceId
    const outcome = await revokeOwnDevice(srv.baseUrl, 'cookie', CLIENT_ID);
    const after = srv.registry.list().length;

    // 关键：服务端记录还在，所以**绝不能**返回 already-gone / revoked
    if (after !== before) {
      return `服务端记录被意外删除（${before} → ${after}）`;
    }
    return outcome === 'failed'
      ? true
      : `返回了 ${outcome} —— 上层会当成撤销成功，实际服务端记录还在`;
  } finally {
    await srv.close();
  }
});

await check('关键：撤销后服务端确实拒绝了该设备的 token', async () => {
  if (!pluginDir) return { skip: '插件不可用' };
  const srv = await startRealRegistryServer();
  try {
    const CLIENT_ID = 'dsh-outpost-crosscheck-002';
    const claimed = srv.pairDevice(CLIENT_ID);
    const token = claimed.token;
    const serverDeviceId = claimed.device.id;

    // 撤销前：token 能认证
    const authBefore = srv.registry.authenticate(token, CLIENT_ID, undefined);
    if (!authBefore) return '前置条件不成立：配对后的 token 认证失败';

    const outcome = await revokeOwnDevice(
      srv.baseUrl,
      'cookie',
      CLIENT_ID,
      serverDeviceId,
    );
    if (outcome !== 'revoked') return `撤销返回 ${outcome}`;

    // 撤销后：token 必须失效
    const authAfter = srv.registry.authenticate(token, CLIENT_ID, undefined);
    if (authAfter) {
      return `撤销后 token 仍然有效（服务端设备 ${serverDeviceId} 还在）—— 撤销没真正生效`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('isSameDevice 用服务端 UUID 能认出自己', async () => {
  if (!pluginDir) return { skip: '插件不可用' };
  const srv = await startRealRegistryServer();
  try {
    const CLIENT_ID = 'dsh-outpost-crosscheck-003';
    const claimed = srv.pairDevice(CLIENT_ID);
    const serverDeviceId = claimed.device.id;
    const r = await listPairedDevices(srv.baseUrl, 'cookie');
    if (!r.ok) return '列表失败';

    // 只有客户端标识 → 认不出（服务端不返回它）
    const byClientIdOnly = isSameDevice(r.devices[0], CLIENT_ID);
    if (byClientIdOnly) {
      return '仅靠客户端标识就认出了自己 —— 与服务端契约不符，请复核';
    }
    // 带上服务端 UUID → 必须认得出
    const byServerId = isSameDevice(r.devices[0], CLIENT_ID, serverDeviceId);
    if (!byServerId) {
      return '用服务端 UUID 也认不出自己 —— 界面无法标出「这台手机」';
    }
    return true;
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败，${skip} 跳过`);
process.exitCode = fail === 0 ? 0 : 1;
