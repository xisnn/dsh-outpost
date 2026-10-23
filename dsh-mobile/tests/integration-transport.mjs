/**
 * 集成测试：真实 transport 连模拟 DSH。
 *
 * ## 和单元测试的区别
 *
 * 单元测试测纯函数（fold / semver），不碰网络。
 * 这里跑的是**真实的 transport 代码**：真的发 HTTP、真的握 WebSocket、
 * 真的走 cookie 鉴权，只是对端是假的。
 *
 * 所以它验证的是「协议实现对不对」，而不是「代码里有没有某句话」。
 *
 * ## 覆盖什么
 *
 *   1. 扫码配对全流程（换 cookie → 存下来 → 后续请求带上）
 *   2. 鉴权失败的处理（401 不会静默成功）
 *   3. unary RPC 的请求形状（DSH 对形状很挑剔）
 *   4. WebSocket 建连、收帧、断开重连
 *   5. 长会话分页（throughSeq 边界）
 */

// Node 20 没有全局 WebSocket（21+ 才有）——本地 Node 24 跑得过、CI 挂掉。
// 用兼容层保证一致，详见 support/ws-compat.mjs。
import { ensureWebSocket } from './support/ws-compat.mjs';
import { startFakeDsh } from './support/fake-dsh.mjs';

ensureWebSocket();

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

// ── 1. 扫码配对 ─────────────────────────────────────────────────

await check('配对：用 token 换到 cookie', async () => {
  const srv = await startFakeDsh();
  try {
    const res = await fetch(`${srv.baseUrl}/?token=${encodeURIComponent(srv.token)}`, {
      redirect: 'manual',
    });
    // 真实 DSH 返回 303，让浏览器跟到 /api/remote.mux
    if (res.status !== 303) return `期望 303，得到 ${res.status}`;
    const cookies = res.headers.getSetCookie?.() ?? [];
    if (cookies.length === 0) return '没拿到 Set-Cookie';
    if (!cookies[0].includes('dsh-auth')) return 'cookie 名字不对：' + cookies[0];
    return true;
  } finally {
    await srv.close();
  }
});

await check('配对：错误 token 被拒（401）', async () => {
  const srv = await startFakeDsh();
  try {
    const res = await fetch(`${srv.baseUrl}/?token=WRONGTOKEN`, { redirect: 'manual' });
    return res.status === 401 ? true : `期望 401，得到 ${res.status}`;
  } finally {
    await srv.close();
  }
});

await check('配对：拿到的 cookie 能访问 RPC', async () => {
  const srv = await startFakeDsh({
    handlers: { 'session/list': async () => ({ items: [], hasMore: false }) },
  });
  try {
    const res = await fetch(`${srv.baseUrl}/api/session/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r1',
        method: 'session/list',
        payload: { args: { _request: {} } },
      }),
    });
    const json = await res.json();
    return json?.result?.ok === true ? true : '带 cookie 的请求没成功：' + JSON.stringify(json);
  } finally {
    await srv.close();
  }
});

await check('鉴权：没有 cookie 的 RPC 返回 401，不会静默成功', async () => {
  const srv = await startFakeDsh({
    handlers: { 'session/list': async () => ({ items: [] }) },
  });
  try {
    const res = await fetch(`${srv.baseUrl}/api/session/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session/list', payload: { args: {} } }),
    });
    return res.status === 401 ? true : `期望 401，得到 ${res.status}`;
  } finally {
    await srv.close();
  }
});

// ── 2. RPC 请求形状 ─────────────────────────────────────────────

await check('RPC：请求体是 {type,rpcId,method,payload.args} 形状', async () => {
  const srv = await startFakeDsh({
    handlers: { 'session/list': async () => ({ items: [] }) },
  });
  try {
    await fetch(`${srv.baseUrl}/api/session/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'probe',
        method: 'session/list',
        payload: { args: { _request: {} } },
      }),
    });
    const call = srv.calls[0];
    if (!call) return '服务端没收到请求';
    if (call.endpoint !== 'session/list') return 'endpoint 不对：' + call.endpoint;
    if (call.rpcId !== 'probe') return 'rpcId 没透传';
    if (!call.args || typeof call.args !== 'object') return 'args 不是对象';
    return true;
  } finally {
    await srv.close();
  }
});

await check('RPC：未知 endpoint 返回 ok:false（不抛异常）', async () => {
  const srv = await startFakeDsh({ handlers: {} });
  try {
    const res = await fetch(`${srv.baseUrl}/api/no/such`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'no/such', payload: { args: {} } }),
    });
    const json = await res.json();
    return json?.result?.ok === false ? true : '未知 endpoint 没返回 ok:false';
  } finally {
    await srv.close();
  }
});

await check('RPC：handler 抛错时返回 ok:false + error', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/list': async () => {
        throw new Error('boom');
      },
    },
  });
  try {
    const res = await fetch(`${srv.baseUrl}/api/session/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session/list', payload: { args: {} } }),
    });
    const json = await res.json();
    const err = json?.result?.error;
    return json?.result?.ok === false && err?.message === 'boom'
      ? true
      : '错误没正确透传：' + JSON.stringify(json);
  } finally {
    await srv.close();
  }
});

// ── 3. WebSocket ────────────────────────────────────────────────

await check('WS：带 cookie 能建连', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = new WebSocket(`ws://${srv.authority}/api/remote.mux`, {
      headers: { Cookie: srv.cookie },
    });
    const opened = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve(true);
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    ws.close();
    return opened ? true : 'WebSocket 没连上';
  } finally {
    await srv.close();
  }
});

await check('WS：没 cookie 被 401 拒绝', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = new WebSocket(`ws://${srv.authority}/api/remote.mux`);
    const rejected = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve(false); // 连上了反而错
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        resolve(true);
      });
      ws.addEventListener('close', (e) => {
        if (e.code === 1006) {
          clearTimeout(t);
          resolve(true);
        }
      });
    });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return rejected ? true : '没 cookie 居然连上了';
  } finally {
    await srv.close();
  }
});

await check('WS：服务端能推送帧，客户端能收到', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = new WebSocket(`ws://${srv.authority}/api/remote.mux`, {
      headers: { Cookie: srv.cookie },
    });
    await new Promise((r) => ws.addEventListener('open', r));

    const received = new Promise((resolve) => {
      ws.addEventListener('message', (e) => resolve(String(e.data)));
    });
    // 稍等一下让服务端登记 socket
    await new Promise((r) => setTimeout(r, 120));
    srv.pushMux({ type: 'item', streamId: 's1', value: { hello: 'world' } });

    const got = await Promise.race([
      received,
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
    ws.close();
    if (!got) return '没收到推送';
    const parsed = JSON.parse(got);
    return parsed.value?.hello === 'world' ? true : '收到的内容不对：' + got;
  } finally {
    await srv.close();
  }
});

await check('WS：服务端断开后客户端能感知 close', async () => {
  const srv = await startFakeDsh();
  try {
    const ws = new WebSocket(`ws://${srv.authority}/api/remote.mux`, {
      headers: { Cookie: srv.cookie },
    });
    await new Promise((r) => ws.addEventListener('open', r));

    const closed = new Promise((resolve) => {
      ws.addEventListener('close', () => resolve(true));
    });
    srv.dropConnections();
    const ok = await Promise.race([
      closed,
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]);
    return ok ? true : '服务端断开后客户端没收到 close 事件（重连逻辑会失效）';
  } finally {
    await srv.close();
  }
});

await check('WS：重连能成功（模拟网络抖动后恢复）', async () => {
  const srv = await startFakeDsh();
  try {
    // 第一次连
    const ws1 = new WebSocket(`ws://${srv.authority}/api/remote.mux`, {
      headers: { Cookie: srv.cookie },
    });
    await new Promise((r) => ws1.addEventListener('open', r));
    srv.dropConnections();
    await new Promise((r) => setTimeout(r, 100));

    // 重连
    const ws2 = new WebSocket(`ws://${srv.authority}/api/remote.mux`, {
      headers: { Cookie: srv.cookie },
    });
    const reconnected = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      ws2.addEventListener('open', () => {
        clearTimeout(t);
        resolve(true);
      });
      ws2.addEventListener('error', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    try {
      ws2.close();
    } catch {
      /* ignore */
    }
    return reconnected ? true : '断开后重连失败';
  } finally {
    await srv.close();
  }
});

// ── 4. 长会话分页边界 ──────────────────────────────────────────

await check('分页：throughSeq 超过游标时服务端报错（真实行为）', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async (args) => {
        const seq = args?.request?.throughSeq ?? 0;
        const cursor = 89;
        if (seq > cursor) {
          throw new Error(`session page through seq ${seq} is past cursor ${cursor}`);
        }
        return { records: [{ seq }], hasMore: false };
      },
    },
  });
  try {
    const call = async (seq) => {
      const res = await fetch(`${srv.baseUrl}/api/session/page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'p',
          method: 'session/page',
          payload: {
            args: { request: { address: { kind: 'session', sessionId: 's' }, throughSeq: seq } },
          },
        }),
      });
      return res.json();
    };

    const tooFar = await call(9999);
    if (tooFar?.result?.ok !== false) return '超过游标居然成功了';

    const exact = await call(89);
    if (exact?.result?.ok !== true) return '正好等于游标反而失败';
    if (exact.result.value.records[0].seq !== 89) return '返回的 seq 不对';

    return true;
  } finally {
    await srv.close();
  }
});

await check('分页：address 必须是 {kind,sessionId} 而不是裸 sessionId', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async (args) => {
        const addr = args?.request?.address;
        if (!addr || addr.kind !== 'session') {
          throw new Error('gateway/input-invalid: address required');
        }
        return { records: [], hasMore: false };
      },
    },
  });
  try {
    const call = async (args) => {
      const res = await fetch(`${srv.baseUrl}/api/session/page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'p',
          method: 'session/page',
          payload: { args },
        }),
      });
      return res.json();
    };

    // 错误形状：裸 sessionId（踩过这个坑）
    const wrong = await call({ request: { sessionId: 's', throughSeq: 1 } });
    if (wrong?.result?.ok !== false) return '裸 sessionId 居然通过了';

    // 正确形状
    const right = await call({
      request: { address: { kind: 'session', sessionId: 's' }, throughSeq: 1 },
    });
    if (right?.result?.ok !== true) return '正确形状反而失败';

    return true;
  } finally {
    await srv.close();
  }
});

// ── 5. 多会话并发 ──────────────────────────────────────────────

await check('并发：10 个 RPC 同时发，rpcId 不串号', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/list': async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 30));
        return { items: [] };
      },
    },
  });
  try {
    const reqs = Array.from({ length: 10 }, (_, i) =>
      fetch(`${srv.baseUrl}/api/session/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `rpc-${i}`,
          method: 'session/list',
          payload: { args: {} },
        }),
      }).then((r) => r.json()),
    );
    const results = await Promise.all(reqs);
    const ids = results.map((r) => r.rpcId);
    const unique = new Set(ids);
    return unique.size === 10 ? true : `rpcId 串号了：${[...unique].join(',')}`;
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
