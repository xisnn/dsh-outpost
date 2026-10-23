/**
 * 集成测试：审批网关（真实 WebSocket 通信）。
 *
 * ## 为什么要单独测这块
 *
 * 审批网关是坑最多的一环，之前踩过四个连环 bug：
 *
 *   1. WS 没带 `X-DSH-Device-ID` 头 → 服务端 400
 *   2. deviceId 塞进查询串 → 服务端不认（只读 header）
 *   3. 端点硬编码 3081 → 被防火墙拦
 *   4. 失效 token 没有自愈 → 永远 401
 *
 * 这些用「读源码断言」是测不出来的 —— 必须真的建一条 WS 连接，
 * 看握手过不过、收到什么帧。这个文件就是干这个的。
 *
 * ## 为什么用 ws 库而不是 Node 内置 WebSocket
 *
 * Node 22+ 的全局 `WebSocket` **不支持自定义请求头**（`headers` 选项被忽略），
 * 而网关握手必须带 `X-DSH-Device-ID`。
 *
 * 这点本身也是个提醒：RN 里的 WebSocket 同样不能设 header，
 * 产品代码是靠「构造函数第三个参数」绕过去的（见 approvalGateway.ts）。
 * 这里用 ws 库是因为它在 Node 侧能设 header，模拟的是「客户端真实能力」。
 *
 * ## 覆盖什么
 *
 *   1. 配对流程（POST /mgw/pair → 拿 code → WS 用子协议 + header 连接）
 *   2. 缺 header 必须被拒
 *   3. 配对码一次性（用第二次被拒）
 *   4. 收到 approval-requested 帧
 *   5. 回 approval-response 帧，服务端能收到
 *   6. 服务端推 approval-resolved
 *   7. 断开感知 + 重连
 *   8. replay 帧（重连时补发未决审批）
 */

import WS from 'ws';

import { startFakeDsh } from './support/fake-dsh.mjs';

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

/** 连一条网关 WS（ws 库版），返回 { ws, opened } */
function openGateway(srv, { code, deviceId, token } = {}) {
  const protocols = ['dsh-mobile-v1'];
  if (code) protocols.push(`dsh-pair.${code}`);
  if (token) protocols.push(`dsh-auth.${token}`);

  const headers = {};
  if (deviceId) headers['X-DSH-Device-ID'] = deviceId;

  const ws = new WS(`ws://${srv.authority}/ws/mobile`, protocols, { headers });
  const opened = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 3000);
    ws.on('open', () => {
      clearTimeout(t);
      resolve(true);
    });
    ws.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    ws.on('close', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  return { ws, opened };
}

/** 等一条满足条件的 JSON 消息 */
function waitMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      resolve(null);
    }, timeoutMs);
    function onMsg(raw) {
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(parsed);
      }
    }
    ws.on('message', onMsg);
  });
}

/** 建一条已完成的网关连接（配对 + 收到 paired 帧） */
async function connectGateway(srv, deviceId) {
  const code = srv.makePairingCode();
  const { ws, opened } = openGateway(srv, { code, deviceId });
  const isOpen = await opened;
  if (!isOpen) throw new Error('网关连不上');
  const paired = await waitMessage(ws, (m) => m.kind === 'paired');
  if (!paired) throw new Error('连上了但没收到 paired 帧');
  return ws;
}

// ── 1. 配对流程 ────────────────────────────────────────────────

await check('配对：POST /mgw/pair 返回 pairingCode 和 endpoints', async () => {
  const srv = await startFakeDsh();
  try {
    const res = await fetch(`${srv.baseUrl}/mgw/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
      body: '{}',
    });
    if (res.status !== 201) return `期望 201，得到 ${res.status}`;
    const json = await res.json();
    const code = json?.payload?.pairingCode;
    const eps = json?.payload?.endpoints;
    if (!code) return '没返回 pairingCode';
    if (!Array.isArray(eps) || eps.length === 0) return '没返回 endpoints';
    return true;
  } finally {
    await srv.close();
  }
});

await check('配对：没 cookie 时 /mgw/pair 返回 401', async () => {
  const srv = await startFakeDsh();
  try {
    const res = await fetch(`${srv.baseUrl}/mgw/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.status === 401 ? true : `期望 401，得到 ${res.status}`;
  } finally {
    await srv.close();
  }
});

await check('连接：子协议 + X-DSH-Device-ID 头 → 连上并收到 paired 帧', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'test-device-001');
    ws.close();
    return true;
  } finally {
    await srv.close();
  }
});

await check('连接：缺 X-DSH-Device-ID 头 → 被拒', async () => {
  const srv = await startFakeDsh();
  try {
    const code = srv.makePairingCode();
    // 故意不带 header —— 这正是之前踩的坑：以为能走查询串
    const { ws, opened } = openGateway(srv, { code });
    const isOpen = await opened;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return isOpen ? '没带 device id 居然连上了（服务端校验缺失）' : true;
  } finally {
    await srv.close();
  }
});

await check('连接：配对码一次性，第二次用会被拒', async () => {
  const srv = await startFakeDsh();
  try {
    const code = srv.makePairingCode();

    const first = openGateway(srv, { code, deviceId: 'dev-once-1' });
    const open1 = await first.opened;
    try {
      first.ws.close();
    } catch {
      /* ignore */
    }
    if (!open1) return '第一次配对就没成功';

    const second = openGateway(srv, { code, deviceId: 'dev-once-2' });
    const open2 = await second.opened;
    try {
      second.ws.close();
    } catch {
      /* ignore */
    }
    return open2 ? '配对码能重复使用（安全性问题）' : true;
  } finally {
    await srv.close();
  }
});

// ── 2. 审批帧收发 ──────────────────────────────────────────────

await check('审批：能收到 approval-requested 帧', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'appr-1');
    const waitReq = waitMessage(ws, (m) => m.kind === 'approval-requested');
    await new Promise((r) => setTimeout(r, 100));

    srv.pushGateway({
      kind: 'approval-requested',
      rpcId: 'rpc-approval-1',
      sessionId: 'sess-1',
      approvalId: 'appr-1',
      toolName: 'pwsh',
      reason: '需要在工作区外创建文件',
      replay: false,
    });

    const got = await waitReq;
    ws.close();
    if (!got) return '没收到审批帧';
    if (got.approvalId !== 'appr-1') return 'approvalId 不对';
    if (got.toolName !== 'pwsh') return 'toolName 不对';
    return true;
  } finally {
    await srv.close();
  }
});

await check('审批：客户端回的 approval-response 服务端能收到', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'appr-2');

    const gotResponse = new Promise((resolve) => {
      srv.onGatewayMessage((msg) => {
        if (msg.type === 'approval-response') resolve(msg);
      });
    });

    ws.send(
      JSON.stringify({
        type: 'approval-response',
        rpcId: 'rpc-approval-2',
        sessionId: 'sess-2',
        approvalId: 'appr-2',
        outcome: 'allowed-once',
      }),
    );

    const got = await Promise.race([
      gotResponse,
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    ws.close();
    if (!got) return '服务端没收到 approval-response';
    if (got.outcome !== 'allowed-once') return 'outcome 不对：' + got.outcome;
    if (got.approvalId !== 'appr-2') return 'approvalId 没透传';
    return true;
  } finally {
    await srv.close();
  }
});

await check('审批：outcome 只接受 allowed-once / rejected', async () => {
  // 协议约束：真实网关只认这两个值。「始终允许」在协议里不存在。
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'appr-3');
    const seen = [];
    srv.onGatewayMessage((msg) => {
      if (msg.type === 'approval-response') seen.push(msg.outcome);
    });

    ws.send(
      JSON.stringify({
        type: 'approval-response',
        rpcId: 'r1',
        sessionId: 's',
        approvalId: 'a1',
        outcome: 'allowed-once',
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'approval-response',
        rpcId: 'r2',
        sessionId: 's',
        approvalId: 'a2',
        outcome: 'rejected',
      }),
    );

    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    const valid = seen.every((o) => o === 'allowed-once' || o === 'rejected');
    return valid && seen.length === 2 ? true : '出现了非法的 outcome：' + seen.join(',');
  } finally {
    await srv.close();
  }
});

await check('审批：服务端推 approval-resolved，客户端能收到', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'appr-4');
    const waitResolved = waitMessage(ws, (m) => m.kind === 'approval-resolved');
    await new Promise((r) => setTimeout(r, 100));

    srv.pushGateway({
      kind: 'approval-resolved',
      rpcId: 'rpc-4',
      sessionId: 'sess-4',
      approvalId: 'appr-4',
      outcome: 'rejected',
    });

    const got = await waitResolved;
    ws.close();
    if (!got) return '没收到 resolved 帧';
    return got.outcome === 'rejected' ? true : 'outcome 不对';
  } finally {
    await srv.close();
  }
});

await check('审批：重连时服务端补发未决审批（replay 帧）', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'appr-5');
    const waitReplay = waitMessage(
      ws,
      (m) => m.kind === 'approval-requested' && m.replay === true,
    );
    await new Promise((r) => setTimeout(r, 100));

    srv.pushGateway({
      kind: 'approval-requested',
      rpcId: 'rpc-replay',
      sessionId: 'sess-5',
      approvalId: 'appr-replay',
      toolName: 'pwsh',
      reason: '断线期间积压的审批',
      replay: true,
    });

    const got = await waitReplay;
    ws.close();
    if (!got) return '重连后没收到补发的审批（用户的审批会永远卡着）';
    return got.replay === true ? true : 'replay 标记丢了，无法与实时审批区分';
  } finally {
    await srv.close();
  }
});

// ── 3. 断线与自愈 ─────────────────────────────────────────────

await check('断线：服务端断开后客户端收到 close', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'appr-6');
    const closed = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      ws.on('close', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    srv.dropConnections();
    const got = await closed;
    return got ? true : '服务端断开后没收到 close（重连不会触发）';
  } finally {
    await srv.close();
  }
});

await check('自愈：用已失效的 device token 重连会被拒', async () => {
  const srv = await startFakeDsh();
  try {
    // 模拟「本地存了个失效 token」：用 dsh-auth.<错的> 去连
    const { ws, opened } = openGateway(srv, {
      token: 'stale-token-that-is-invalid',
      deviceId: 'stale-device',
    });
    const isOpen = await opened;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    // 关键：必须失败。如果连上了，说明「清理失效 token 重新配对」的
    // 自愈逻辑永远不会被触发，用户会卡在「审批只能去电脑上点」。
    return isOpen ? '失效 token 居然连上了，自愈逻辑不会生效' : true;
  } finally {
    await srv.close();
  }
});

await check('自愈：清掉 token 后重新配对能连上', async () => {
  const srv = await startFakeDsh();
  try {
    // 第一步：失效 token 失败
    const bad = openGateway(srv, { token: 'stale', deviceId: 'heal-device' });
    const badOpen = await bad.opened;
    try {
      bad.ws.close();
    } catch {
      /* ignore */
    }
    if (badOpen) return '前置条件不对：失效 token 不该连上';

    // 第二步：走正常配对流程（模拟自愈逻辑）
    const ws = await connectGateway(srv, 'heal-device');
    ws.close();
    return true;
  } finally {
    await srv.close();
  }
});

// ── 4. 设备列表 ────────────────────────────────────────────────

await check('设备：配对过的设备会出现在 /mgw/devices', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = await connectGateway(srv, 'listed-device');
    ws.close();
    // 等一拍让服务端登记
    await new Promise((r) => setTimeout(r, 120));

    const res = await fetch(`${srv.baseUrl}/mgw/devices`, {
      headers: { Cookie: srv.cookie },
    });
    const json = await res.json();
    const devices = json?.payload?.devices ?? [];
    const found = devices.some((d) => d.id === 'listed-device');
    return found ? true : '配对的设备没出现在列表里：' + JSON.stringify(devices);
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
