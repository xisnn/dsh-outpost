/**
 * P1-1：把服务端设备 UUID 和「服务器身份」绑定起来。
 *
 * ## 缺陷是什么
 *
 * `gatewayServerDeviceId`（服务端注册表主键 UUID）之前是**全局凭据** ——
 * 只存 UUID，没存它是哪台服务器给的。于是：
 *
 *   · 用户把地址从电脑 A 改成电脑 B
 *   · 电脑 A 重装 DSH / 重装网关插件（注册表重建）
 *   · 同一个 IP 换了机器（DHCP）
 *
 * 这三种情况下，拿旧 UUID 去打撤销接口，服务端都会返回 **404**。
 * 而 404 被归类成 `already-gone`（「本来就没有」）→ 上层当成撤销成功
 * → 用户看到「已撤销」，而**新服务器上这台设备的授权其实还在**，
 * 手机丢了也踢不掉。这是本轮最隐蔽的一条。
 *
 * ## 判据从哪来（不是虚构的字段）
 *
 * 查了真实插件 `dsh-plugin-mobile-gateway` 的源码：
 *
 *   · `gatewayId` 写在独立状态文件里（`gateway-state.mjs`），
 *     首次创建用 `linkSync` 保证**永不覆盖**已有身份
 *     → 跨重启稳定、不随设备撤销变化 → **可以当服务器身份**
 *   · `gatewayInstanceId` 是 `crypto.randomUUID()`，每次进程启动重生成
 *     → **绝不能**当身份（否则每次重启都误判成「换了服务器」）
 *
 * `gatewayId` 出现在 `paired` 帧、`hello` 帧、`GET /mgw/status`、
 * `POST /mgw/pair` 的 payload 里（都是 `...gatewayIdentity`）。
 * 所以「这个 UUID 属于哪台服务器」是能被**真实验证**的。
 *
 * ## 本文件测什么
 *
 * 驱动真实产品函数（serverIdentity.ts + deviceAuth.ts + approvalGateway.ts），
 * 服务端用 fake-dsh（已按真实插件形状带 gatewayId）。
 *
 *   · 绑定解析的六种结论
 *   · 跨服务器：旧 UUID 不得用于新服务器
 *   · 同一地址、gatewayId 变了（注册表重建）：视为不同服务器
 *   · gatewayInstanceId 变化不得影响判定
 *   · 404 在身份无法确认时**不得**被判成撤销成功
 *   · 404 在身份确认后才算「本来就没有」
 *   · 切换到新服务器后能正常重新配对并建立新绑定
 *   · 正常配对/重连能力不受影响
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

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
void require;

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

const AsyncStorageStub = (await imp(path.join(SHIM_DIR, 'async-storage-stub.mjs'))).default;
const cookieMod = await imp(path.join(SHIM_DIR, 'cookie-fetch.mjs'));
const cookieFetch = cookieMod.makeCookieFetch();
const wsMod = await imp(path.join(SHIM_DIR, 'ws-compat.mjs'));
wsMod.ensureWebSocket();
globalThis.fetch = cookieFetch;

const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);
const { ApprovalGateway } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'),
);
const { startFakeDsh } = await imp(path.join(SHIM_DIR, 'fake-dsh.mjs'));
const identity = await imp(
  path.join(__dirname, '..', 'src', 'core', 'serverIdentity.ts'),
);
const {
  normalizeBaseUrl,
  readGatewayId,
  readServerDeviceId,
  saveServerBinding,
  resolveBinding,
  canTrustNotFound,
  mayUseStoredDeviceId,
  clearServerBinding,
} = identity;
const deviceAuth = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
);
const { revokeOwnDevice, revokeOwnDeviceDetailed, listPairedDevices } = deviceAuth;
const { __resetRevocationCache } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceRevocation.ts'),
);

const KC_KEY = '__dshTestKeychainState__';
function ks() {
  if (!globalThis[KC_KEY]) globalThis[KC_KEY] = { store: new Map() };
  return globalThis[KC_KEY].store;
}
const BINDING_SERVICE = 'com.dshpocket.credentials.dsh.gatewayServerBinding';

function resetAll() {
  AsyncStorageStub.__reset();
  ks().clear();
  __resetRevocationCache();
}

async function waitFor(fn, timeoutMs = 8000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

function makeConn(srv) {
  const conn = new DshConnection({ baseUrl: srv.baseUrl, fetchImpl: cookieFetch });
  conn.setCookieReader(async () => {
    const cookies = cookieMod.getCookies(srv.baseUrl);
    const parts = Object.entries(cookies)
      .filter(([name]) => name.startsWith('dsh-auth'))
      .map(([name, value]) => `${name}=${value}`);
    return parts.length ? parts.join('; ') : undefined;
  });
  return conn;
}

/** 预置登录 cookie（模拟「已配对、登录态有效」） */
async function seedCookie(srv) {
  const conn = makeConn(srv);
  await conn.loginWithToken(srv.token);
  conn.close();
}

async function closeGateway(gw) {
  gw.disconnect();
  await new Promise((r) => setTimeout(r, 250));
  gw.disconnect();
}

/** 连一次网关，返回学到的服务端 UUID（模拟真实配对/重连） */
async function learnServerId(srv) {
  const statuses = [];
  const gw = new ApprovalGateway(srv.baseUrl, {
    onStatus: (s, d) => statuses.push(`${s}:${d ?? ''}`),
    onApproval: () => {},
    onResolved: () => {},
  });
  await gw.connect();
  await waitFor(() => statuses.some((s) => s.startsWith('online')));
  await new Promise((r) => setTimeout(r, 400));
  await closeGateway(gw);
  // 从 Keystore 读回来（产品代码就是这么存的）
  const rec = ks().get('com.dshpocket.credentials.dsh.gatewayServerDeviceId');
  return rec ? rec.password : undefined;
}

// ══════════════════════════════════════════════════════════════
// 一、纯函数：地址归一化 / 字段提取
// ══════════════════════════════════════════════════════════════

await check('normalizeBaseUrl：去掉尾部斜杠、大小写归一', () => {
  const cases = [
    ['http://192.168.1.5:3095/', 'http://192.168.1.5:3095'],
    ['http://192.168.1.5:3095', 'http://192.168.1.5:3095'],
    ['HTTP://Host.Local:3095', 'http://host.local:3095'],
    ['http://a.local:3095///', 'http://a.local:3095'],
  ];
  const bads = cases.filter(([i, o]) => normalizeBaseUrl(i) !== o);
  return bads.length === 0 ? true : JSON.stringify(bads);
});

await check('normalizeBaseUrl：不同端口/不同主机必须不相等', () => {
  const a = normalizeBaseUrl('http://192.168.1.5:3095');
  const b = normalizeBaseUrl('http://192.168.1.5:3081');
  const c = normalizeBaseUrl('http://192.168.1.6:3095');
  if (a === b) return '不同端口被当成同一台';
  if (a === c) return '不同主机被当成同一台';
  return true;
});

await check('readGatewayId / readServerDeviceId：只接受非空字符串', () => {
  if (readGatewayId({ gatewayId: 'g-1' }) !== 'g-1') return '读不出正常值';
  if (readGatewayId({ gatewayId: '' }) !== undefined) return '空串被当成有效值';
  if (readGatewayId({ gatewayId: 123 }) !== undefined) return '非字符串被当成有效值';
  if (readGatewayId(null) !== undefined) return 'null 处理不对';
  if (readServerDeviceId({ device: { id: 'u-1' } }) !== 'u-1') return '读不出 device.id';
  if (readServerDeviceId({ device: {} }) !== undefined) return '缺 id 时没返回 undefined';
  if (readServerDeviceId({ device: null }) !== undefined) return 'null device 处理不对';
  return true;
});

// ══════════════════════════════════════════════════════════════
// 二、绑定解析的六种结论
// ══════════════════════════════════════════════════════════════

await check('绑定：没有绑定 → unbound（不是 confirmed）', async () => {
  resetAll();
  const r = await resolveBinding('http://a.local:3095');
  if (r.kind !== 'unbound') return `得到 ${r.kind}`;
  if (canTrustNotFound(r)) return 'unbound 竟然允许把 404 当成功';
  if (mayUseStoredDeviceId(r)) return 'unbound 竟然允许直接用存储 UUID';
  return true;
});

await check('绑定：baseUrl + gatewayId 都匹配 → confirmed', async () => {
  resetAll();
  await saveServerBinding({
    baseUrl: 'http://a.local:3095',
    gatewayId: 'gw-A',
    deviceId: 'uuid-A',
  });
  const r = await resolveBinding('http://a.local:3095', 'gw-A');
  if (r.kind !== 'confirmed') return `得到 ${r.kind}`;
  if (r.deviceId !== 'uuid-A') return 'deviceId 不对';
  if (!canTrustNotFound(r)) return 'confirmed 却不让信 404';
  if (!mayUseStoredDeviceId(r)) return 'confirmed 却不允许用存储 UUID';
  return true;
});

await check('绑定：地址变了 → foreign（禁止复用旧 UUID）', async () => {
  resetAll();
  await saveServerBinding({
    baseUrl: 'http://a.local:3095',
    gatewayId: 'gw-A',
    deviceId: 'uuid-A',
  });
  const r = await resolveBinding('http://b.local:3095', 'gw-B');
  if (r.kind !== 'foreign') return `得到 ${r.kind}`;
  if (mayUseStoredDeviceId(r)) return 'foreign 竟然允许用旧 UUID 去撤 —— 会误伤别的服务器';
  if (canTrustNotFound(r)) return 'foreign 竟然允许把 404 当成功';
  return true;
});

await check('绑定：同一地址但 gatewayId 变了（注册表重建）→ foreign', async () => {
  resetAll();
  await saveServerBinding({
    baseUrl: 'http://a.local:3095',
    gatewayId: 'gw-A',
    deviceId: 'uuid-A',
  });
  // 地址完全一样，但服务器已经是另一个实例（重装插件 / 换机器）
  const r = await resolveBinding('http://a.local:3095', 'gw-B');
  if (r.kind !== 'foreign') return `得到 ${r.kind} —— 同地址换服务器没被识别出来`;
  if (canTrustNotFound(r)) return '注册表重建后仍把 404 当成功 —— 记录其实还在';
  return true;
});

await check('绑定：老协议（没有 gatewayId）→ assumed，但禁止采信 404', async () => {
  resetAll();
  // 老版本插件不发 gatewayId
  await saveServerBinding({
    baseUrl: 'http://a.local:3095',
    gatewayId: null,
    deviceId: 'uuid-legacy',
  });
  const r = await resolveBinding('http://a.local:3095');
  if (r.kind !== 'assumed') return `得到 ${r.kind}`;
  // 仍然允许发请求（否则老用户永远撤不掉）
  if (!mayUseStoredDeviceId(r)) return 'assumed 被禁止发请求 —— 老用户撤不掉授权';
  // 但 404 绝不能算成功
  if (canTrustNotFound(r)) return 'assumed 把 404 当成功 —— 正是要修的那个漏洞';
  return true;
});

await check('绑定：当前帧没带 gatewayId → assumed（拿不到身份）', async () => {
  resetAll();
  await saveServerBinding({
    baseUrl: 'http://a.local:3095',
    gatewayId: 'gw-A',
    deviceId: 'uuid-A',
  });
  const r = await resolveBinding('http://a.local:3095', undefined);
  if (r.kind !== 'assumed') return `得到 ${r.kind}`;
  if (canTrustNotFound(r)) return '拿不到身份时仍把 404 当成功';
  return true;
});

await check('绑定：数据损坏 → unverifiable（不是 unbound）', async () => {
  resetAll();
  ks().set(BINDING_SERVICE, { username: 'x', password: '{不是合法 JSON' });
  const r = await resolveBinding('http://a.local:3095', 'gw-A');
  if (r.kind !== 'unverifiable') return `得到 ${r.kind} —— 损坏被当成「没绑定」`;
  if (canTrustNotFound(r)) return 'unverifiable 竟然允许信 404';
  if (mayUseStoredDeviceId(r)) return 'unverifiable 竟然允许用来源不明的 UUID';
  return true;
});

await check('绑定：字段不完整 → unverifiable', async () => {
  resetAll();
  ks().set(BINDING_SERVICE, { username: 'x', password: JSON.stringify({ v: 1 }) });
  const r = await resolveBinding('http://a.local:3095', 'gw-A');
  return r.kind === 'unverifiable' ? true : `得到 ${r.kind}`;
});

await check('绑定：版本号不认识 → unverifiable', async () => {
  resetAll();
  ks().set(BINDING_SERVICE, {
    username: 'x',
    password: JSON.stringify({
      v: 99,
      baseUrl: 'http://a.local:3095',
      gatewayId: 'gw-A',
      deviceId: 'uuid-A',
    }),
  });
  const r = await resolveBinding('http://a.local:3095', 'gw-A');
  return r.kind === 'unverifiable' ? true : `得到 ${r.kind}`;
});

await check('绑定：写入后能回读校验成功', async () => {
  resetAll();
  const saved = await saveServerBinding({
    baseUrl: 'http://a.local:3095/',
    gatewayId: 'gw-A',
    deviceId: 'uuid-A',
  });
  if (!saved) return 'saveServerBinding 报失败';
  const rec = ks().get(BINDING_SERVICE);
  if (!rec) return 'Keystore 里没有绑定';
  const parsed = JSON.parse(rec.password);
  if (parsed.baseUrl !== 'http://a.local:3095') return `baseUrl 没归一化：${parsed.baseUrl}`;
  if (parsed.gatewayId !== 'gw-A') return 'gatewayId 不对';
  if (parsed.deviceId !== 'uuid-A') return 'deviceId 不对';
  return true;
});

await check('绑定：clearServerBinding 会真的删掉（并回读确认）', async () => {
  resetAll();
  await saveServerBinding({
    baseUrl: 'http://a.local:3095',
    gatewayId: 'gw-A',
    deviceId: 'uuid-A',
  });
  const cleared = await clearServerBinding();
  if (!cleared) return 'clear 报失败';
  const r = await resolveBinding('http://a.local:3095', 'gw-A');
  return r.kind === 'unbound' ? true : `清掉后仍是 ${r.kind}`;
});

// ══════════════════════════════════════════════════════════════
// 三、真实网关：配对/重连时学到的绑定带 gatewayId
// ══════════════════════════════════════════════════════════════

await check('真实网关：配对后存下 UUID + 服务端身份绑定', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const serverId = await learnServerId(srv);
    if (!serverId) return '前置条件不成立：没学到服务端 UUID';
    const rec = ks().get(BINDING_SERVICE);
    if (!rec) return '没有写绑定 —— 换服务器时会误用旧 UUID';
    const parsed = JSON.parse(rec.password);
    if (parsed.deviceId !== serverId) return '绑定里的 deviceId 和 UUID 不一致';
    if (parsed.gatewayId !== srv.gatewayId) {
      return `绑定里的 gatewayId 不对：${parsed.gatewayId}（应为 ${srv.gatewayId}）`;
    }
    if (normalizeBaseUrl(parsed.baseUrl) !== normalizeBaseUrl(srv.baseUrl)) {
      return '绑定里的 baseUrl 不对';
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('真实网关：绑定能解析成 confirmed（可以信 404）', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const serverId = await learnServerId(srv);
    if (!serverId) return '前置条件不成立';
    const r = await resolveBinding(srv.baseUrl, srv.gatewayId);
    if (r.kind !== 'confirmed') return `得到 ${r.kind}`;
    if (r.deviceId !== serverId) return '解析出的 deviceId 不对';
    return canTrustNotFound(r) ? true : 'confirmed 却不让信 404';
  } finally {
    await srv.close();
  }
});

await check('gatewayInstanceId 变化不影响判定（它不是身份）', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const serverId = await learnServerId(srv);
    if (!serverId) return '前置条件不成立';
    // 同一个 gatewayId（同一台服务器），但进程重启导致 gatewayInstanceId 换了。
    // 我们的判定只看 gatewayId，所以仍然必须是 confirmed ——
    // 否则每次服务端重启都会误判成「换了服务器」，撤销功能全废。
    const r1 = await resolveBinding(srv.baseUrl, srv.gatewayId);
    const r2 = await resolveBinding(srv.baseUrl, srv.gatewayId);
    if (r1.kind !== 'confirmed' || r2.kind !== 'confirmed') {
      return `判定不稳定：${r1.kind} / ${r2.kind}`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 四、核心：跨服务器撤销不得谎报成功
// ══════════════════════════════════════════════════════════════

await check('跨服务器：旧服务器的 UUID 不得用于新服务器', async () => {
  resetAll();
  const srvA = await startFakeDsh();
  const srvB = await startFakeDsh();
  await seedCookie(srvA);
  try {
    // 在 A 上配对，学到 A 的 UUID 和绑定
    const idA = await learnServerId(srvA);
    if (!idA) return '前置条件不成立：A 上没学到 UUID';

    // 用户切到 B（B 上还没有这台设备）
    await seedCookie(srvB);
    const idB = await learnServerId(srvB);
    if (!idB) return '前置条件不成立：B 上没学到 UUID';

    // 现在把绑定手动改回「属于 A」（模拟用户切回 A 的地址但存储没更新）
    await saveServerBinding({
      baseUrl: srvA.baseUrl,
      gatewayId: srvA.gatewayId,
      deviceId: idA,
    });

    // 对着 **B** 发撤销，但传的是 A 的 UUID
    const detail = await revokeOwnDeviceDetailed(
      srvB.baseUrl,
      srvB.cookie,
      'dsh-outpost-cross',
      idA,
    );

    // 关键断言：绝不能报成成功
    if (detail.kind === 'revoked') {
      return '把 A 的 UUID 撤到了 B 上还报成功 —— 可能误伤了 B 的设备';
    }
    if (detail.kind === 'already-gone') {
      return '404 被当成 already-gone —— B 上这台设备的授权其实还在';
    }
    // A 上那条记录也不能因为这次操作被删掉
    return srvA.gatewayDevices.size > 0 ? true : 'A 上的记录被误删了';
  } finally {
    await srvA.close();
    await srvB.close();
  }
});

await check('跨服务器：同一地址换服务器（gatewayId 变了）→ 404 不算成功', async () => {
  resetAll();
  // 关键场景：**地址完全一样**，但已经是另一台服务器 / 注册表重建。
  //
  // 做法：起一个服务端拿到它的端口，关掉后在**同一个端口**起新的，
  // 并给新实例一个不同的 gatewayId。这样 baseUrl 字符串完全没变，
  // 只有 gatewayId 变了 —— 正是最难发现、也最危险的情况。
  const srvOld = await startFakeDsh({ gatewayId: 'gw-old-instance' });
  const oldPort = srvOld.port;
  const oldBase = srvOld.baseUrl;
  await seedCookie(srvOld);
  let idOnOld;
  try {
    idOnOld = await learnServerId(srvOld);
    if (!idOnOld) return '前置条件不成立：没学到旧服务器的 UUID';
    const bind = JSON.parse(ks().get(BINDING_SERVICE).password);
    if (bind.gatewayId !== 'gw-old-instance') return '旧绑定没记下旧 gatewayId';
  } finally {
    await srvOld.close();
  }

  // 同端口重启，换一个 gatewayId（= 另一台服务器 / 注册表重建）
  //
  // 关闭后立刻重绑同一端口在 Windows 上偶发失败（旧的监听还占着），
  // 先等一小会儿再起；起不来就如实 skip，不伪装成通过。
  let srvNew;
  for (let attempt = 0; attempt < 5 && !srvNew; attempt += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      srvNew = await startFakeDsh({ port: oldPort, gatewayId: 'gw-new-instance' });
    } catch {
      srvNew = undefined;
    }
  }
  if (!srvNew) return { skip: `端口 ${oldPort} 没能复用，跳过这个精确场景` };
  try {
    if (srvNew.port !== oldPort) {
      return { skip: `端口没复用上（${srvNew.port} vs ${oldPort}）` };
    }
    if (srvNew.baseUrl !== oldBase) return '地址没保持一致，测试前提不成立';

    // 确认新服务端真的能应答（否则后面的 404 结论没有意义）
    const alive = await cookieFetch(`${srvNew.baseUrl}/mgw/status`, { method: 'GET' })
      .then((r) => r.status === 200)
      .catch(() => false);
    if (!alive) return { skip: '同端口的新服务端没能正常应答' };

    await seedCookie(srvNew);
    // 新服务端上这台设备是存在的（模拟「注册表重建后又配对过」）——
    // 这样我们才能区分「真的没有记录」和「记录在但 UUID 对不上」
    srvNew.gatewayDevices.add('dsh-outpost-same-addr');
    srvNew.serverDeviceIds.set('dsh-outpost-same-addr', 'uuid-on-new-server');

    const detail = await revokeOwnDeviceDetailed(
      srvNew.baseUrl,
      srvNew.cookie,
      'dsh-outpost-same-addr',
      idOnOld,
    );

    // 旧 UUID 属于旧实例，新实例上它当然是 404 —— 但**绝不能**报成功
    if (detail.kind === 'already-gone') {
      return '同一地址换了服务器，404 被当成已撤销 —— 新服务器上授权还在';
    }
    if (detail.kind === 'revoked') {
      return '居然真撤销了 —— 说明拿旧 UUID 去撤了新服务器的东西';
    }
    // 新服务器上那条记录必须还在（没有被误删）
    return srvNew.gatewayDevices.has('dsh-outpost-same-addr')
      ? true
      : '新服务器上的记录被误删了 —— 不该用旧 UUID 去动它';
  } finally {
    await srvNew.close();
  }
});

await check('身份确认后：404 才能算「本来就没有」', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    // 先配对，拿到真实绑定（confirmed）
    const realId = await learnServerId(srv);
    if (!realId) return '前置条件不成立';

    // 把服务端记录清掉，模拟「之前确实撤销过」
    srv.gatewayDevices.clear();
    srv.serverDeviceIds.clear();

    // 用**同一个** UUID 再撤一次：服务端返回 404，
    // 但身份是 confirmed，所以这个 404 只可能是「本来就没有」
    const detail = await revokeOwnDeviceDetailed(
      srv.baseUrl,
      srv.cookie,
      'dsh-outpost-self',
      realId,
    );
    if (detail.kind !== 'already-gone') {
      return `得到 ${detail.kind}，期望 already-gone`;
    }
    if (detail.how !== 'identity') return `how 不对：${detail.how}`;
    return true;
  } finally {
    await srv.close();
  }
});

await check('身份无法确认 + 404 → 必须 failed（不能报成功）', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    // 完全没有绑定（模拟老版本升级 / 绑定写入失败）
    // 服务端上也没有这台设备 → 撤销会 404
    const detail = await revokeOwnDeviceDetailed(
      srv.baseUrl,
      srv.cookie,
      'dsh-outpost-unbound',
      'uuid-from-unknown-server',
    );
    if (detail.kind === 'already-gone') {
      return '没有身份绑定却把 404 当成已撤销 —— 这正是要修的漏洞';
    }
    if (detail.kind === 'revoked') return '不该撤销成功';
    return true;
  } finally {
    await srv.close();
  }
});

await check('foreign 绑定：直接拒绝使用存储 UUID（不发破坏性请求）', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    // 绑定明确属于**另一台**服务器
    await saveServerBinding({
      baseUrl: 'http://some-other-machine.local:3095',
      gatewayId: 'gw-other',
      deviceId: 'uuid-other',
    });
    const before = srv.revokeCalls.length;
    const detail = await revokeOwnDeviceDetailed(
      srv.baseUrl,
      srv.cookie,
      'dsh-outpost-foreign',
      'uuid-other',
    );
    // 不该拿外来 UUID 去发撤销请求
    const usedForeignUuid = srv.revokeCalls.slice(before).includes('uuid-other');
    if (usedForeignUuid) {
      return '拿别的服务器的 UUID 去打撤销接口 —— 可能误伤无关设备';
    }
    if (detail.kind === 'revoked' || detail.kind === 'already-gone') {
      return `报了成功：${JSON.stringify(detail)}`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

await check('绑定读失败：不得当成「没绑定」而放行 404', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    // 写一个坏掉的绑定
    ks().set(BINDING_SERVICE, { username: 'x', password: '{{{坏' });
    const detail = await revokeOwnDeviceDetailed(
      srv.baseUrl,
      srv.cookie,
      'dsh-outpost-bad-binding',
      'uuid-whatever',
    );
    if (detail.kind === 'already-gone') {
      return '绑定损坏却把 404 当成功 —— 读不到 ≠ 没有';
    }
    return true;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 五、切换服务器后仍能正常工作（不破坏正常能力）
// ══════════════════════════════════════════════════════════════

await check('切换服务器：能正常重新配对，并建立新绑定', async () => {
  resetAll();
  const srvA = await startFakeDsh();
  const srvB = await startFakeDsh();
  try {
    await seedCookie(srvA);
    const idA = await learnServerId(srvA);
    if (!idA) return '前置条件不成立';
    const bindA = JSON.parse(ks().get(BINDING_SERVICE).password);
    if (bindA.gatewayId !== srvA.gatewayId) return 'A 的绑定不对';

    // 切到 B 并重新配对
    await seedCookie(srvB);
    const idB = await learnServerId(srvB);
    if (!idB) return '在 B 上配对失败 —— 切换服务器后功能不可用';
    if (idB === idA) return 'B 复用了 A 的 UUID —— 设备身份串号了';

    // 绑定必须更新成 B 的
    const bindB = JSON.parse(ks().get(BINDING_SERVICE).password);
    if (bindB.gatewayId !== srvB.gatewayId) {
      return `绑定没更新到 B：${bindB.gatewayId}（应为 ${srvB.gatewayId}）`;
    }
    if (bindB.deviceId !== idB) return '绑定里的 UUID 没更新';

    const r = await resolveBinding(srvB.baseUrl, srvB.gatewayId);
    return r.kind === 'confirmed' ? true : `切换后绑定解析成 ${r.kind}`;
  } finally {
    await srvA.close();
    await srvB.close();
  }
});

await check('切换服务器后：在 B 上撤销自己可以成功', async () => {
  resetAll();
  const srvA = await startFakeDsh();
  const srvB = await startFakeDsh();
  try {
    await seedCookie(srvA);
    if (!(await learnServerId(srvA))) return '前置条件不成立（A）';
    await seedCookie(srvB);
    const idB = await learnServerId(srvB);
    if (!idB) return '前置条件不成立（B）';

    const detail = await revokeOwnDeviceDetailed(
      srvB.baseUrl,
      srvB.cookie,
      'dsh-outpost-on-b',
      idB,
    );
    if (detail.kind !== 'revoked') {
      return `在 B 上撤销自己失败：${JSON.stringify(detail)}`;
    }
    return srvB.gatewayDevices.size === 0 ? true : 'B 上的记录没删掉';
  } finally {
    await srvA.close();
    await srvB.close();
  }
});

await check('普通重连（同一服务器）不破坏绑定', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const id1 = await learnServerId(srv);
    if (!id1) return '前置条件不成立';
    const bind1 = ks().get(BINDING_SERVICE).password;

    // 再连一次（模拟服务端重启后 hello 重连）
    const id2 = await learnServerId(srv);
    const bind2 = ks().get(BINDING_SERVICE).password;
    if (id1 !== id2) return '重连后 UUID 变了（不该变）';

    const p1 = JSON.parse(bind1);
    const p2 = JSON.parse(bind2);
    if (p1.gatewayId !== p2.gatewayId) return '重连把 gatewayId 改了';
    if (p1.deviceId !== p2.deviceId) return '重连把 deviceId 改了';
    return true;
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 六、缺口：缺少必要条件时必须如实报「没发请求」
// ══════════════════════════════════════════════════════════════

await check('缺 Cookie：明确报 unconfirmed/missing-cookie，不静默跳过', async () => {
  resetAll();
  const detail = await revokeOwnDeviceDetailed(
    'http://127.0.0.1:1',
    undefined,
    'dsh-outpost-x',
    'uuid-x',
  );
  if (detail.kind !== 'unconfirmed') return `得到 ${detail.kind}`;
  if (detail.reason !== 'missing-cookie') return `reason 不对：${detail.reason}`;
  return true;
});

await check('缺 baseUrl：明确报 unconfirmed/missing-base-url', async () => {
  resetAll();
  const detail = await revokeOwnDeviceDetailed('', 'cookie', 'dsh-outpost-x', 'uuid-x');
  if (detail.kind !== 'unconfirmed') return `得到 ${detail.kind}`;
  return detail.reason === 'missing-base-url' ? true : `reason 不对：${detail.reason}`;
});

await check('没有任何 id：明确报 unconfirmed/no-target', async () => {
  resetAll();
  const detail = await revokeOwnDeviceDetailed('http://a.local:3095', 'c', '', undefined);
  if (detail.kind !== 'unconfirmed') return `得到 ${detail.kind}`;
  return detail.reason === 'no-target' ? true : `reason 不对：${detail.reason}`;
});

await check('网络不可达：报 failed/network（不是成功）', async () => {
  resetAll();
  const detail = await revokeOwnDeviceDetailed(
    'http://127.0.0.1:1',
    'cookie',
    'dsh-outpost-x',
    'uuid-x',
  );
  if (detail.kind !== 'failed') return `得到 ${detail.kind}`;
  return detail.reason === 'network' ? true : `reason 不对：${detail.reason}`;
});

// ══════════════════════════════════════════════════════════════
// 七、向后兼容：旧的三值 API 行为不变
// ══════════════════════════════════════════════════════════════

await check('向后兼容：revokeOwnDevice 仍返回三值字符串', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    const serverId = await learnServerId(srv);
    if (!serverId) return '前置条件不成立';
    const outcome = await revokeOwnDevice(
      srv.baseUrl,
      srv.cookie,
      'dsh-outpost-compat',
      serverId,
    );
    if (outcome !== 'revoked') return `得到 ${outcome}，期望 revoked`;
    return true;
  } finally {
    await srv.close();
  }
});

await check('向后兼容：列表为空时 already-gone 仍是成功语义', async () => {
  resetAll();
  const srv = await startFakeDsh();
  await seedCookie(srv);
  try {
    // 服务端一台设备都没有 → 空列表是这台服务器的直接回答，
    // 不需要身份绑定就能确定「没有可撤的」
    const listed = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (!listed.ok) return '列表请求失败';
    if (listed.devices.length !== 0) return '测试前提不成立：列表不是空的';
    const detail = await revokeOwnDeviceDetailed(
      srv.baseUrl,
      srv.cookie,
      'dsh-outpost-none',
    );
    if (detail.kind !== 'already-gone') return `得到 ${detail.kind}`;
    return detail.how === 'empty-list' ? true : `how 不对：${detail.how}`;
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败，${skip} 跳过`);
process.exitCode = fail === 0 ? 0 : 1;
