/**
 * F-01 收尾复核：使用**真实 DSH 移动网关插件（dsh-plugin-mobile-gateway/lib/index.mjs）**
 * 进行隔离无破坏性集成验证（区别于 startFakeDsh 模拟网关）。
 *
 * 重点核查边界：
 *   1. 真实网关对 rpcId / approvalId 的去重与终态处理：
 *      completeApproval 立即从 pendingApprovals 删除并 resolve 一次；重复发送同 rpcId 返回
 *      { kind: 'approval-response', accepted: false, reason: 'not-pending' }，绝不二次执行。
 *   2. 客户端不把「WebSocket 发送成功」等同于「服务端尚未执行」：
 *      一旦 send() 返回 true，若确认帧丢失导致超时或中途断线，转入 unconfirmed（结果未知），
 *      禁止盲目再次允许，直到收到权威确认或重连后服务端权威重放（replay: true）。
 *   3. 完整覆盖：普通审批、高危二次确认、拒绝、确认丢失（超时锁定结果未知）、迟到确认/重复响应收敛、
 *      断线恢复（服务端已执行 vs 服务端未收到并重放）。
 *   4. 零真实破坏性命令，真实 LLM 调用 0 次。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

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

const cookieMod = await imp(path.join(__dirname, 'support', 'cookie-fetch.mjs'));
globalThis.fetch = cookieMod.makeCookieFetch();
const wsMod = await imp(path.join(__dirname, 'support', 'ws-compat.mjs'));
wsMod.ensureWebSocket();

const { ApprovalGateway } = await imp(path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'));
const { ApprovalSubmitController } = await imp(path.join(__dirname, '..', 'src', 'core', 'approvalDock.ts'));

// ── 定位并加载真实 dsh-plugin-mobile-gateway ────────────────────────
const CANDIDATES = [
  process.env.DSH_GATEWAY_PLUGIN_DIR,
  path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'dsh-plugin-mobile-gateway'),
  path.join(process.env.HOME ?? '', '.dsh', 'profiles', 'web', 'node_modules', 'dsh-plugin-mobile-gateway'),
].filter(Boolean);

const pluginDir = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'lib', 'index.mjs')));
if (!pluginDir) {
  console.error('FAIL: 未找到真实 dsh-plugin-mobile-gateway 插件目录');
  process.exit(1);
}

const realPluginMod = await imp(path.join(pluginDir, 'lib', 'index.mjs'));
const realPlugin = realPluginMod.default ?? realPluginMod;

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  OK    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return true;
    await sleep(35);
  }
  return Boolean(await fn());
}

/**
 * 启动真实 dsh-plugin-mobile-gateway 实例（隔离临时目录，不碰真实用户设备表）。
 */
async function startRealIsolatedGateway(port = 3081) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-real-mgw-f01-'));
  const deviceFile = path.join(tmpDir, 'mobile-gateway-devices.json');
  const gatewayStateFile = path.join(tmpDir, 'mobile-gateway-devices.json.gateway.json');
  const cloudflareStateFile = path.join(tmpDir, 'mobile-gateway-devices.json.cloudflare.json');

  let mgwRouteHandler = null;
  let upgradeHandler = null;
  const hostListeners = new Map();
  const cleanupEffects = [];
  const activeServerSockets = new Set();

  // 可控故障注入开关：
  //   - dropConfirmationForRpcIds：服务端真实执行 completeApproval，但拦截下行的 approval-resolved 与 approval-response 确认帧（模拟确认丢失）
  const dropConfirmationForRpcIds = new Set();

  const server = http.createServer((req, res) => {
    if (mgwRouteHandler && (req.url ?? '').startsWith('/mgw')) {
      mgwRouteHandler(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('connection', (socket) => {
    activeServerSockets.add(socket);
    socket.on('close', () => activeServerSockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    if (upgradeHandler) {
      upgradeHandler(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const boundPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;

  const peerAbort = new AbortController();
  const ctx = {
    webServer: {
      port: boundPort,
      register(spec) {
        mgwRouteHandler = spec.handler;
        return () => {
          mgwRouteHandler = null;
        };
      },
      registerUpgrade(spec) {
        upgradeHandler = (req, socket, head) => {
          // 包装 socket.write？不，直接拦截 ws 实例或通过代理：
          // 更干净的做法：在客户端或服务端拦截指定 rpcId 的确认帧
          spec.handler(req, socket, head);
        };
        return () => {
          upgradeHandler = null;
        };
      },
    },
    connection: {
      createPeer() {
        return {
          signal: peerAbort.signal,
          dispose: async () => {},
        };
      },
      requestRejection() {
        // 测试内模拟已通过 DSH 会话认证的本机管理请求
        return undefined;
      },
    },
    typertGateway: {
      invoke: async () => ({}),
      stream: async () =>
        (async function* () {
          yield { type: 'baseline', value: { archivedSessionIds: [], projections: {} } };
          await new Promise((resolve) => peerAbort.signal.addEventListener('abort', resolve, { once: true }));
        })(),
    },
    agentDefaultModel: {},
    on(eventName, fn) {
      hostListeners.set(eventName, fn);
      return () => hostListeners.delete(eventName);
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanupEffects.push(cleanup);
    },
    get() {
      return undefined;
    },
  };

  realPlugin.apply(ctx, {
    gatewayEnabled: true,
    gatewayMode: 'persistent',
    requireAuth: true,
    deviceFile,
    gatewayStateFile,
    cloudflareStateFile,
    lanEnabled: false,
  });

  return {
    baseUrl,
    dropConfirmationForRpcIds,
    /** 通过真实 /mgw/pair 接口铸造一次性配对码 */
    async mintPairingCode() {
      const res = await fetch(`${baseUrl}/mgw/pair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
          Host: `127.0.0.1:${boundPort}`,
        },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      return data?.payload?.pairingCode;
    },
    /**
     * 触发真实网关的 approval/request waterfall 监听器。
     * 返回 { promise, getExecCount, getResolvedOutcome } 以验证服务端实际执行次数。
     */
    requestApproval({ sessionId, toolName, reason, displayReason }) {
      const listener = hostListeners.get('approval/request');
      if (!listener) throw new Error('真实网关未注册 approval/request 监听器');
      let execCount = 0;
      let resolvedOutcome = null;
      const p = listener(
        {
          agent: { id: sessionId },
          toolName,
          reason,
          displayReason,
        },
        // 真实 DSH Host waterfall 下游监听器在桌面端未点击前保持 pending（见插件 lib/index.mjs:3350），
        // 从而在手机短暂断线重连期间保留在 pendingApprovals 中并在重连时通过 replayPendingInteractions 重放。
        () => new Promise(() => {}),
      ).then((outcome) => {
        execCount += 1;
        resolvedOutcome = outcome;
        return outcome;
      });
      return {
        promise: p,
        getExecCount: () => execCount,
        getResolvedOutcome: () => resolvedOutcome,
      };
    },
    dropAllClientSockets() {
      for (const s of activeServerSockets) {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      }
    },
    async close() {
      peerAbort.abort();
      for (const fn of cleanupEffects) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      await new Promise((resolve) => server.close(resolve));
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

const realGwServer = await startRealIsolatedGateway(3081);
const statuses = [];
const pending = new Map();
const resolved = new Set();
const authoritativeAt = new Map();
const sentFrames = [];
const rawServerFrames = [];

// 控制模拟「确认帧在网络上丢失」的集合（服务端真实收到并处理了 approval-response，但客户端没收到 approval-resolved / approval-response）
const simulateLostAckRpcIds = new Set();
// 控制模拟「上行帧在断线瞬间未送达服务端」的集合（客户端 ws.send 调用后未能到达服务端）
const simulateDroppedUpstreamRpcIds = new Set();

const gw = new ApprovalGateway(realGwServer.baseUrl, {
  onStatus: (s) => statuses.push(s),
  onApproval: (a) => {
    authoritativeAt.set(a.rpcId, Date.now());
    pending.set(a.rpcId, a);
  },
  onResolved: (rpcId) => {
    if (simulateLostAckRpcIds.has(rpcId)) {
      // 模拟网络丢包：吞掉下行的确认信号
      return;
    }
    resolved.add(rpcId);
    pending.delete(rpcId);
  },
});

// 包装 gw.respond 以记录每次真实发送，并支持模拟「断线前上行帧未到达服务端」
const origRespond = gw.respond.bind(gw);
gw.respond = (a, outcome) => {
  sentFrames.push({ rpcId: a.rpcId, outcome, time: Date.now() });
  if (simulateDroppedUpstreamRpcIds.has(a.rpcId)) {
    // 模拟已写进本机缓冲区但连接随即中断、服务端实际未收到该包
    return true;
  }
  return origRespond(a, outcome);
};

const controller = new ApprovalSubmitController({ commitTimeoutMs: 450 });
const candidate = (id) => {
  const a = pending.get(id);
  if (!a) throw new Error(`审批 ${id} 不在待审批列表`);
  return {
    id: a.rpcId,
    sessionId: a.sessionId,
    approvalId: a.approvalId,
    toolName: a.toolName,
    reason: a.reason,
    displayReason: a.displayReason,
  };
};
const submit = (id, outcome = 'allowed-once') =>
  controller.submit({
    approval: candidate(id),
    outcome,
    gatewayOnline: statuses.at(-1) === 'online',
    send: (approval, decision) => {
      const original = pending.get(approval.id);
      return original ? gw.respond(original, decision) : false;
    },
  });
const reconcile = (gatewayOnline = statuses.at(-1) === 'online') =>
  controller.reconcile({
    serverPendingIds: new Set(pending.keys()),
    serverResolvedIds: resolved,
    authoritativePendingAt: authoritativeAt,
    gatewayOnline,
  });
const sentCount = (id) => sentFrames.filter((f) => f.rpcId === id).length;

try {
  console.log('\n── 真实 dsh-plugin-mobile-gateway 隔离集成验证 ─────────');
  const pairingCode = await realGwServer.mintPairingCode();
  check('真实网关 /mgw/pair 成功签发一次性配对码', typeof pairingCode === 'string' && pairingCode.length > 10);

  await gw.connect(pairingCode);
  check('真实 ApprovalGateway 与真实 dsh-plugin-mobile-gateway 完成握手与配对上线', await waitFor(() => statuses.at(-1) === 'online'));

  // 1. 普通审批 + 真实网关幂等性核查
  const hostReq1 = realGwServer.requestApproval({
    sessionId: 'sess-real-1',
    toolName: 'read',
    reason: '读取 README.md',
    displayReason: { file_path: 'E:\\work\\dsBot\\README.md' },
  });
  check('真实网关广播 approval-requested 并生成真实 UUID rpcId/approvalId', await waitFor(() => pending.size === 1));
  const apNormal = [...pending.values()][0];
  check('普通审批提交 sent，在途重复点击被客户端拦截', submit(apNormal.rpcId).status === 'sent' && submit(apNormal.rpcId).status === 'duplicate');
  check('真实网关收到响应后 resolve 宿主 Promise 且仅执行 1 次', await waitFor(() => {
    reconcile();
    return resolved.has(apNormal.rpcId) && !controller.inFlightIds.has(apNormal.rpcId) && hostReq1.getExecCount() === 1;
  }) && hostReq1.getResolvedOutcome() === 'allowed-once' && sentCount(apNormal.rpcId) === 1);

  // 直接向真实网关补发相同 rpcId 的重复帧，验证真实网关底层返回 not-pending 且绝不二次执行宿主回调
  origRespond(apNormal, 'allowed-once');
  await sleep(120);
  check('真实网关对已决 rpcId 的重复响应严格幂等（不二次执行宿主 Promise）', hostReq1.getExecCount() === 1);

  // 2. 高危审批二次确认
  const hostReqHigh = realGwServer.requestApproval({
    sessionId: 'sess-real-1',
    toolName: 'pwsh',
    reason: 'Remove-Item -Recurse -Force E:\\work\\dsBot\\_mock_dir',
    displayReason: { command: 'Remove-Item -Recurse -Force E:\\work\\dsBot\\_mock_dir' },
  });
  await waitFor(() => [...pending.values()].some((x) => x.toolName === 'pwsh'));
  const apHigh = [...pending.values()].find((x) => x.toolName === 'pwsh');
  check('高危操作首次点击仅进入 armed，真实网关未收到任何帧', submit(apHigh.rpcId).status === 'armed' && sentCount(apHigh.rpcId) === 0);
  check('高危操作第二次点击发送并由真实网关确认完成（仅执行 1 次）', submit(apHigh.rpcId).status === 'sent' && await waitFor(() => {
    reconcile();
    return resolved.has(apHigh.rpcId) && hostReqHigh.getExecCount() === 1;
  }) && sentCount(apHigh.rpcId) === 1);

  // 3. 拒绝审批
  const hostReqReject = realGwServer.requestApproval({
    sessionId: 'sess-real-1',
    toolName: 'edit',
    reason: '修改 config.ts',
    displayReason: { file_path: 'E:\\work\\dsBot\\src\\config.ts' },
  });
  await waitFor(() => [...pending.values()].some((x) => x.toolName === 'edit'));
  const apReject = [...pending.values()].find((x) => x.toolName === 'edit');
  check('拒绝审批一次点击即送达真实网关并返回 rejected', submit(apReject.rpcId, 'rejected').status === 'sent' && await waitFor(() => {
    reconcile();
    return resolved.has(apReject.rpcId) && hostReqReject.getResolvedOutcome() === 'rejected';
  }) && hostReqReject.getExecCount() === 1);

  // 4. 关键边界 A：审批响应已送达真实网关并已执行，但 approval-resolved 确认丢失 / 超时 ->
  //    客户端必须进入「结果未知（unconfirmed）」，严禁盲目再次允许；随后迟到确认到达时正确收敛。
  const hostReqLostAck = realGwServer.requestApproval({
    sessionId: 'sess-real-1',
    toolName: 'read',
    reason: '测试确认帧丢失与迟到确认',
  });
  await waitFor(() => pending.size > 0);
  const apLostAck = [...pending.values()][0];
  simulateLostAckRpcIds.add(apLostAck.rpcId);

  check('确认丢失场景：首次提交已送达真实网关并执行', submit(apLostAck.rpcId).status === 'sent' && await waitFor(() => hostReqLostAck.getExecCount() === 1));
  await sleep(520);
  check('确认超时后转入「结果未知（unconfirmed）」，不把发送成功当成未执行', reconcile(true) && controller.isUnconfirmed(apLostAck.rpcId) && /结果未知/.test(controller.errorFor(apLostAck.rpcId) ?? ''));
  const blindResubmit = submit(apLostAck.rpcId);
  check('处于「结果未知（unconfirmed）」期间禁止盲目再次提交（不重发、宿主执行仍为 1 次）', blindResubmit.status === 'unconfirmed' && sentCount(apLostAck.rpcId) === 1 && hostReqLostAck.getExecCount() === 1);

  // 模拟迟到确认（或重连/探测收到真实网关的 not-pending 权威应答）到达
  simulateLostAckRpcIds.delete(apLostAck.rpcId);
  origRespond(apLostAck, 'allowed-once'); // 真实网关对已决项回 { kind: 'approval-response', accepted: false, reason: 'not-pending' }
  check('收到真实网关 not-pending / 迟到权威确认后自动解除结果未知并完成收敛', await waitFor(() => {
    reconcile(true);
    return resolved.has(apLostAck.rpcId) && !controller.isUnconfirmed(apLostAck.rpcId);
  }) && hostReqLostAck.getExecCount() === 1);

  // 5. 关键边界 B：客户端调用了 send() 但因断线实际未到达真实网关 ->
  //    断线时先进入「结果未知（unconfirmed）」禁止盲目提交；
  //    真实网关自动重连后通过 replayPendingInteractions 重放 replay: true，权威证明仍未决，解除锁定并完成提交！
  const hostReqDrop = realGwServer.requestApproval({
    sessionId: 'sess-real-1',
    toolName: 'read',
    reason: '测试断线未送达与真实网关重连 replay 恢复',
  });
  await waitFor(() => pending.size > 0);
  const apDrop = [...pending.values()][0];
  simulateDroppedUpstreamRpcIds.add(apDrop.rpcId);

  check('断线前提交：客户端已调 send 但服务端尚未收到', submit(apDrop.rpcId).status === 'sent' && hostReqDrop.getExecCount() === 0);
  realGwServer.dropAllClientSockets();
  check('真实网关连接断开后转入「结果未知（unconfirmed）」并锁定盲目重发', await waitFor(() => statuses.at(-1) === 'offline') && reconcile(false) && controller.isUnconfirmed(apDrop.rpcId) && submit(apDrop.rpcId).status === 'unconfirmed');

  simulateDroppedUpstreamRpcIds.delete(apDrop.rpcId);
  check('真实网关自动重连并由 replayPendingInteractions 权威重放未决审批（replay: true）', await waitFor(() => {
    reconcile(statuses.at(-1) === 'online');
    return statuses.at(-1) === 'online' && !controller.isUnconfirmed(apDrop.rpcId);
  }, 35000));

  check('权威重放证明服务端仍未决后，允许重新提交并由真实网关执行 1 次完成', submit(apDrop.rpcId).status === 'sent' && await waitFor(() => {
    reconcile(true);
    return resolved.has(apDrop.rpcId) && hostReqDrop.getExecCount() === 1;
  }) && hostReqDrop.getResolvedOutcome() === 'allowed-once');

  // 6. 关键边界 C：客户端已调 send() 且服务端已执行，但确认帧因断线丢失 ->
  //    重连后真实网关不会重放该已决 rpcId（approvals=0），客户端保持「结果未知（unconfirmed）」绝不解锁盲目重发！
  const hostReqDropDone = realGwServer.requestApproval({
    sessionId: 'sess-real-1',
    toolName: 'read',
    reason: '测试服务端已执行但断线丢失确认后的防重放保护',
  });
  await waitFor(() => pending.size > 0);
  const apDropDone = [...pending.values()][0];
  simulateLostAckRpcIds.add(apDropDone.rpcId);

  check('断线已执行场景：响应已送达真实网关并执行 1 次（确认帧在断线中丢失）', submit(apDropDone.rpcId).status === 'sent' && await waitFor(() => hostReqDropDone.getExecCount() === 1));
  realGwServer.dropAllClientSockets();
  await waitFor(() => statuses.at(-1) === 'offline');
  reconcile(false);
  await waitFor(() => statuses.at(-1) === 'online', 35000);
  await sleep(150);
  reconcile(true);
  check(
    '重连后真实网关未重放已决项时，客户端保持 unconfirmed 锁定，禁止再次提交，宿主执行严格保持 1 次',
    controller.isUnconfirmed(apDropDone.rpcId) &&
      submit(apDropDone.rpcId).status === 'unconfirmed' &&
      hostReqDropDone.getExecCount() === 1,
  );
} finally {
  gw.disconnect();
  await realGwServer.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（真实 dsh-plugin-mobile-gateway，真实 LLM 调用 0 次）`);
process.exit(fail === 0 ? 0 : 1);
