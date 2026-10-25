/**
 * 模拟 DSH 服务端。
 *
 * ## 为什么需要它
 *
 * 现有测试分两种，都不够：
 *   · 单元测试：只测纯函数（fold / semver / fileref），跑得快但不碰网络
 *   · e2e.mjs：连真实 DSH，能验证真行为，但 CI 里没有 DSH，只能手工跑
 *
 * 中间缺的是「**有真实网络行为、但不需要外部服务**」这一层。
 * 这个文件填的就是它：起一个真 HTTP + WebSocket 服务，模仿 DSH 的协议，
 * 让 transport / rpc / approvalGateway 跑真实代码路径。
 *
 * ## 它模仿什么
 *
 *   POST /api/<ns>/<method>           unary RPC（真 HTTP 请求）
 *   GET  /?token=<token>              换 cookie（303 重定向）
 *   WS   /api/remote.mux              流式通道（真 WebSocket 握手）
 *   POST /mgw/pair                    网关配对
 *   WS   <port>/ws/mobile              审批网关
 *
 * ## 它不模仿什么
 *
 * 不实现 DSH 的真实业务逻辑（折叠事件、模型调用）。
 * 那是 e2e.mjs 的事（连真 DSH）。这里只保证**协议形状**和**网络行为**对。
 */

import http from 'node:http';
import crypto from 'node:crypto';

/** 极简 WebSocket 服务端（RFC 6455 子集，够测试用） */
function makeWsServer() {
  /** @type {Set<import('node:net').Socket>} */
  const clients = new Set();
  const handlers = { message: [], close: [] };

  function emit(kind, ...args) {
    for (const h of handlers[kind] ?? []) h(...args);
  }

  /** 把数据帧编码成 WebSocket frame（server→client 不掩码） */
  function encodeFrame(payload, opcode = 0x1) {
    const data = Buffer.from(payload, 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, data]);
  }

  /** 解析客户端发来的帧（客户端帧必须掩码） */
  function decodeFrames(buf, onFrame) {
    let offset = 0;
    while (offset + 2 <= buf.length) {
      const b0 = buf[offset];
      const b1 = buf[offset + 1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = offset + 2;

      if (len === 126) {
        if (p + 2 > buf.length) break;
        len = buf.readUInt16BE(p);
        p += 2;
      } else if (len === 127) {
        if (p + 8 > buf.length) break;
        len = Number(buf.readBigUInt64BE(p));
        p += 8;
      }

      let mask;
      if (masked) {
        if (p + 4 > buf.length) break;
        mask = buf.subarray(p, p + 4);
        p += 4;
      }
      if (p + len > buf.length) break;

      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) {
        payload[i] = masked ? buf[p + i] ^ mask[i % 4] : buf[p + i];
      }
      offset = p + len;

      onFrame(opcode, payload);
    }
    return buf.subarray(offset);
  }

  return {
    clients,
    on(kind, fn) {
      (handlers[kind] ??= []).push(fn);
    },
    /** 处理一个 upgrade 请求
     *
     * @param req http.IncomingMessage
     * @param socket net.Socket
     * @param protocol 服务端选中的子协议。**必须回给客户端** ——
     *   ws 客户端在带了子协议时，如果响应里没有 `Sec-WebSocket-Protocol`，
     *   会直接报 "Server sent no subprotocol" 并断开（1006）。
     *   真实网关也是这么回的。
     */
    accept(req, socket, protocol) {
      const key = req.headers['sec-websocket-key'];
      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
          '\r\n',
      );
      clients.add(socket);

      let pending = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        pending = decodeFrames(Buffer.concat([pending, chunk]), (opcode, payload) => {
          if (opcode === 0x8) {
            // close
            try {
              socket.write(encodeFrame('', 0x8));
              socket.end();
            } catch {
              /* ignore */
            }
            return;
          }
          if (opcode === 0x9) {
            // ping → pong
            try {
              socket.write(encodeFrame(payload.toString(), 0xa));
            } catch {
              /* ignore */
            }
            return;
          }
          if (opcode === 0x1) emit('message', payload.toString('utf8'), socket);
        });
      });
      socket.on('close', () => {
        clients.delete(socket);
        emit('close', socket);
      });
      socket.on('error', () => {
        clients.delete(socket);
      });
      // 返回一个带 send() 的对象，而不是裸 socket ——
      // 裸 socket 直接 write(JSON) 会让客户端收不到（缺 WebSocket 帧头）。
      return {
        socket,
        /** 发一条 JSON 文本帧 */
        send(obj) {
          const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
          try {
            socket.write(encodeFrame(text));
          } catch {
            /* ignore */
          }
        },
      };
    },
    /** 发给所有客户端 */
    broadcast(text) {
      const frame = encodeFrame(text);
      for (const c of clients) {
        try {
          c.write(frame);
        } catch {
          /* ignore */
        }
      }
    },
    /** 主动断开所有连接（模拟服务端重启） */
    killAll() {
      for (const c of clients) {
        try {
          c.destroy();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
    },
    /**
     * 发一个 close 帧再断开（模拟服务端主动 close(code, reason)）。
     *
     * 必须真的发 WebSocket close 帧 —— 直接 destroy() 的话客户端只会
     * 收到 1006（异常关闭），拿不到服务端想表达的 4003。
     */
    killAllWithCode(code, reason) {
      const body = Buffer.alloc(2 + Buffer.byteLength(String(reason ?? ''), 'utf8'));
      body.writeUInt16BE(code, 0);
      body.write(String(reason ?? ''), 2, 'utf8');
      const frame = encodeFrame(body, 0x8);
      for (const c of clients) {
        try {
          c.write(frame);
          c.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
    },
    close() {
      this.killAll();
    },
  };
}

/**
 * 启动一个模拟 DSH。
 *
 * @param {object} opts
 * @param {number} [opts.port] 0 = 自动分配
 * @param {string} [opts.token] 配对 token
 * @param {object} [opts.handlers] 各 RPC 的处理函数
 */
export async function startFakeDsh(opts = {}) {
  const token = opts.token ?? 'TESTTOKEN' + crypto.randomBytes(12).toString('hex');
  /** 配对成功后发给客户端的长期 token（重连时用 dsh-auth.<它>） */
  const DEVICE_TOKEN = 'device-token-' + crypto.randomBytes(12).toString('hex');
  /**
   * 服务端**实例标识**（插件的 `gatewayId`）。
   *
   * 真实插件把它存进独立状态文件，跨重启稳定、不随设备撤销变化。
   * 测试需要能指定它（模拟「同一地址换了服务器」/「注册表重建」），
   * 所以允许 opts.gatewayId 覆盖。
   */
  const GATEWAY_ID = opts.gatewayId ?? crypto.randomUUID();
  const cookieName = 'dsh-auth-test';
  const cookieValue = 'v1.' + crypto.randomBytes(24).toString('base64url');
  const cookie = `${cookieName}=${cookieValue}`;

  /** RPC 处理函数表：'session/list' → fn(args, ctx) */
  const handlers = opts.handlers ?? {};
  /** 每次收到的 RPC 都记下来，测试里可以断言「发的是不是这个形状」 */
  const calls = [];
  /** 网关连上的设备 */
  const gatewayDevices = new Set();
  /**
   * 客户端 device id → **服务端** device id（UUID）。
   *
   * 真实插件里这是两套完全不同的 id：客户端发 `X-DSH-Device-ID`
   * （`dsh-outpost-xxx`），服务端自己生成 UUID 当注册表主键，
   * 且 `GET /mgw/devices` 只返回 UUID（不返回客户端标识）。
   * 这里复刻这个映射，才能测出「撤销自己」是否真的能找到记录。
   */
  const SERVER_DEVICE_IDS = new Map();
  /** /mgw/pair 被调了几次（测试诊断用） */
  let pairCalls = 0;
  /** 撤销请求收到的服务端 device id 列表（测试断言用） */
  const revokeCalls = [];
  const gatewayPairings = new Map(); // pairingCode → { deviceId, used }
  let gatewayConnected = false;

  /** @type {import('node:net').Socket | null} */
  let homeSocket = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // ── 换 cookie ───────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
      const given = url.searchParams.get('token');
      if (given !== token) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      res.writeHead(303, {
        location: './api/remote.mux',
        'set-cookie': `${cookie}=; Path=/; HttpOnly; Max-Age=2592000`,
      });
      res.end();
      return;
    }

    // ── 配对 ───────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/mgw/pair') {
      if (!(req.headers.cookie ?? '').includes(cookieName)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      pairCalls += 1;
      const pairingCode = crypto.randomBytes(16).toString('base64url');
      gatewayPairings.set(pairingCode, { deviceId: null, used: false });
      const authority = req.headers.host;
      const body = {
        payload: {
          version: 2,
          pairingCode,
          publicUrl: `ws://${authority}/ws/mobile`,
          gatewayId: 'fake-gateway',
          gatewayName: 'Fake',
          // 真实网关会在 endpoints 里列多个候选（3081 网关 + 3095 web server）。
          // 产品代码 pickUrl() 会优先挑「和 baseUrl 完全同源」的那条，
          // 所以这里把同源地址放第一位是关键 —— 放错了会导致
          // 断线重连时连到错误的端口（实测踩过）。
          endpoints: [
            `ws://${authority}/ws/mobile`,
            `ws://127.0.0.1:3081/ws/mobile`,
          ],
        },
      };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    // ── GET /api/remote.mux（非 upgrade）───────────────────────
    //
    // `loginWithToken` 用默认的 redirect:'follow'，会把 303 跟到
    // `./api/remote.mux`。真实 DSH 在这个路径上对普通 GET 返回一个
    // 200 的空壳（真正的用途是 WebSocket upgrade）。
    //
    // 如果这里返回 404，登录就会报 "token exchange failed: HTTP 404" ——
    // 集成测试第一版就是栽在这，看着像「产品代码有 bug」，
    // 其实是我的模拟服务端不完整。
    if (req.method === 'GET' && url.pathname === '/api/remote.mux') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>fake dsh</title>ok');
      return;
    }

    // ── 网关状态（真实插件同款）────────────────────────────────
    //
    // 真实插件：`GET /mgw/status` 返回
    //   { version, requireAuth, gatewayEnabled, gatewayMode,
    //     gatewayId, gatewayName,          ← ...gatewayIdentity
    //     gatewayInstanceId,               ← 每次启动都变，**不可**当身份
    //     endpoints, connectedClients, wsPath, lan: {...}, ... }
    //
    // 客户端用 gatewayId 确认「存下来的设备 UUID 属于这台服务器」
    // （见 src/core/serverIdentity.ts）。这里只需暴露身份相关字段。
    if (req.method === 'GET' && url.pathname === '/mgw/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          version: 'fake',
          requireAuth: true,
          gatewayEnabled: true,
          gatewayMode: 'persistent',
          gatewayId: GATEWAY_ID,
          gatewayName: 'fake-gateway',
          gatewayInstanceId: crypto.randomUUID(),
          wsPath: '/ws/mobile',
          connectedClients: gatewayDevices.size,
        }),
      );
      return;
    }

    // ── 设备列表 ───────────────────────────────────────────────
    //
    // ⚠️ 返回形状必须复刻真实插件的 `GET /mgw/devices`：
    //      { devices: [ { id, name, createdAt, lastSeenAt, online,
    //                     connections, displayName } ] }
    //   关键是 **id 是服务端 UUID，且没有 clientDeviceId**。
    //
    //   这里之前返回 `payload.devices` + 把客户端 id 当 `id`，
    //   两个问题：
    //     · 形状不对（真实是顶层 devices，不是 payload 包一层）
    //     · id 语义不对（客户端标识 ≠ 服务端主键）
    //   结果「撤销自己」在测试里能过、真机失败。
    if (req.method === 'GET' && url.pathname === '/mgw/devices') {
      const devices = [...gatewayDevices].map((clientId, i) => ({
        id: SERVER_DEVICE_IDS.get(clientId) ?? `srv-${i}`,
        name: `fake-device-${i}`,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        online: true,
        connections: 1,
        displayName: `fake-device-${i}`,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices }));
      return;
    }

    // ── 撤销设备 ───────────────────────────────────────────────
    //
    // 真实插件：POST /mgw/devices/<serverUUID>/revoke
    //   · 成功 200 { revoked: true }
    //   · 不存在 404 { revoked: false }
    //   · 非 GET 且不同源 → 403（CSRF 保护）
    if (
      req.method === 'POST' &&
      url.pathname.startsWith('/mgw/devices/') &&
      url.pathname.endsWith('/revoke')
    ) {
      const origin = req.headers.origin;
      const host = req.headers.host;
      let sameOrigin = false;
      try {
        sameOrigin = !!origin && !!host && new URL(origin).host === host;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'forbidden',
            message: 'cross-origin management request rejected',
          }),
        );
        return;
      }
      const targetId = decodeURIComponent(
        url.pathname.slice('/mgw/devices/'.length, -'/revoke'.length),
      );
      // 按服务端 UUID 找对应的客户端 id
      let revoked = false;
      for (const [clientId, serverId] of SERVER_DEVICE_IDS) {
        if (serverId === targetId) {
          gatewayDevices.delete(clientId);
          SERVER_DEVICE_IDS.delete(clientId);
          revoked = true;
          break;
        }
      }
      revokeCalls.push(targetId);
      res.writeHead(revoked ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ revoked }));
      return;
    }

    // ── unary RPC ──────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const endpoint = url.pathname.slice('/api/'.length);
      // 鉴权：cookie 不对就 401（模仿真实行为）
      if (!(req.headers.cookie ?? '').includes(cookieName)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }

      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* ignore */
      }
      const args = parsed?.payload?.args ?? {};
      calls.push({ endpoint, args, rpcId: parsed?.rpcId });

      const fn = handlers[endpoint];
      if (!fn) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'server-response',
            rpcId: parsed?.rpcId,
            result: {
              ok: false,
              error: { code: 'gateway/not-found', message: `no handler for ${endpoint}` },
            },
          }),
        );
        return;
      }
      let value;
      try {
        value = await fn(args);
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'server-response',
            rpcId: parsed?.rpcId,
            result: { ok: false, error: { code: 'internal', message: String(e?.message ?? e) } },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'server-response',
          rpcId: parsed?.rpcId,
          result: { ok: true, value },
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  // ── WebSocket 升级 ───────────────────────────────────────────
  const muxWs = makeWsServer();
  const gatewayWs = makeWsServer();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/api/remote.mux') {
      if (!(req.headers.cookie ?? '').includes(cookieName)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      homeSocket = muxWs.accept(req, socket);
      return;
    }

    if (url.pathname === '/ws/mobile') {
      // 网关：必须有 X-DSH-Device-ID 头，配对码走子协议
      const deviceId = req.headers['x-dsh-device-id'];
      if (!deviceId) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((s) => s.trim());
      const pairProto = protocols.find((p) => p.startsWith('dsh-pair.'));
      // ⚠️ 长期 token 的子协议是 `dsh-auth.`，不是 `dsh-token.`。
      //
      // 真实插件 lib/index.mjs 的 extractCredential() 只认这两个前缀：
      //   if (protocol.startsWith('dsh-auth.')) return { kind: 'token', ... }
      //   if (protocol.startsWith('dsh-pair.')) return { kind: 'pairing', ... }
      // PROTOCOL.md 第 90-91 行也是 `dsh-auth.<token>`。
      //
      // 模拟服务端曾经写成 dsh-token.，于是「客户端写错前缀」这个真实缺陷
      // 一直测不出来 —— 假服务端认了一个真服务端不认的前缀。
      const authProto = protocols.find((p) => p.startsWith('dsh-auth.'));

      if (pairProto) {
        const code = pairProto.slice('dsh-pair.'.length);
        const rec = gatewayPairings.get(code);
        if (!rec || rec.used) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          );
          socket.destroy();
          return;
        }
        rec.used = true; // 一次性
        rec.deviceId = String(deviceId);
        gatewayDevices.add(String(deviceId));
      } else if (authProto) {
        const tok = authProto.slice('dsh-auth.'.length);
        if (tok !== DEVICE_TOKEN) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          );
          socket.destroy();
          return;
        }
        gatewayDevices.add(String(deviceId));
      } else {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }

      gatewayConnected = true;
      // 回 `dsh-mobile-v1` —— 协议里的基础子协议。
      // 不回的话 ws 客户端会报 "Server sent no subprotocol" 并断开。
      const s = gatewayWs.accept(req, socket, 'dsh-mobile-v1');
      // 配对上就发 paired 帧（复刻真实服务端行为）
      //
      // ⚠️ 字段名必须是 `token` 不是 `deviceToken` ——
      // ApprovalGateway 读的是 `frame.token`（见 handleFrame 的 paired 分支），
      // 存下来用于后续重连。第一版写成 deviceToken，导致重连一直失败，
      // 表现出来就是「断线后永远连不回来」。
      //
      // ⚠️ `device` 是**嵌套对象**，不是扁平字段 `deviceId`。
      // 真实插件（lib/index.mjs）发的是：
      //   { kind:'paired', token, device: { id, name, createdAt, lastSeenAt,
      //                                      online, connections } }
      // 而 publicDevice() 不返回 clientDeviceId。
      //
      // 这里之前写成了扁平的 `deviceId: '<client id>'`，导致：
      //   · 产品代码读 frame.device.id 拿不到东西（字段根本不存在）
      //   · 「撤销自己」在测试里能过（因为测试假服务端返回了 clientDeviceId），
      //     真机上却认不出自己 —— 又一个「假服务端迎合错误假设」的例子。
      // 所以这里必须按真实形状发：device.id 是**服务端 UUID**（这里用
      // 客户端 id 的哈希派生一个稳定 UUID，模拟服务端自己生成的主键）。
      const serverDeviceId = SERVER_DEVICE_IDS.get(String(deviceId)) ?? (() => {
        const id = crypto.randomUUID();
        SERVER_DEVICE_IDS.set(String(deviceId), id);
        return id;
      })();
      setTimeout(() => {
        s.send({
          kind: 'paired',
          token: DEVICE_TOKEN,
          device: {
            id: serverDeviceId,
            name: 'fake-device',
            createdAt: Date.now(),
            lastSeenAt: null,
            online: true,
            connections: 1,
          },
          // 真实插件发的是 `{ kind:'paired', token, device, ...gatewayIdentity }`，
          // 而 `gatewayIdentity = { gatewayId, gatewayName }`。
          // gatewayId 来自插件的独立状态文件（`gateway-state.mjs`），
          // 用 linkSync 保证「永不覆盖已有身份」，所以**跨重启、跨设备撤销
          // 都稳定** —— 这正是客户端用来判断「这个 UUID 是不是这台服务器
          // 给的」的依据（见 src/core/serverIdentity.ts）。
          //
          // ⚠️ 注意别和 `gatewayInstanceId` 搞混：那个是
          // `crypto.randomUUID()`，插件每次进程启动都重新生成，
          // **不能**用来标识服务器身份。
          gatewayId: GATEWAY_ID,
          gatewayName: 'fake-gateway',
        });
        // 真实插件紧接着发 hello（也带 device.id）。
        // 重连时不发 paired，只有 hello —— 客户端要能从这里学到自己的
        // 服务端 UUID，否则老用户重连后仍然撤销不了自己。
        s.send({
          kind: 'hello',
          gatewayId: GATEWAY_ID,
          gatewayName: 'fake-gateway',
          protocol: 3,
          capabilities: ['split-channels', 'images'],
          authenticated: true,
          device: { id: serverDeviceId, name: 'fake-device' },
          port: 3095,
          clients: 1,
        });
      }, 5);
      return;
    }

    socket.destroy();
  });

  await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;
  const authority = `127.0.0.1:${port}`;
  const baseUrl = `http://${authority}`;

  return {
    port,
    baseUrl,
    authority,
    token,
    cookie,
    calls,
    gatewayDevices,
    /** 撤销请求收到的服务端 device id（测试断言「撤的是不是对的那条」） */
    revokeCalls,
    /**
     * 客户端 device id → 服务端 UUID。
     *
     * 测试要验证「撤销自己」时，需要知道服务端给这台设备分配的 UUID，
     * 因为客户端只能从 paired/hello 帧里学到它。
     */
    serverDeviceIds: SERVER_DEVICE_IDS,
    /** 本假服务端的实例标识（paired/hello/`GET /mgw/status` 都会带） */
    gatewayId: GATEWAY_ID,
    get pairCalls() {
      return pairCalls;
    },
    get gatewayConnected() {
      return gatewayConnected;
    },

    /** 模拟服务端推送一条 mux 帧 */
    pushMux(frame) {
      muxWs.broadcast(typeof frame === 'string' ? frame : JSON.stringify(frame));
    },
    /** 模拟网关推送 */
    pushGateway(frame) {
      gatewayWs.broadcast(typeof frame === 'string' ? frame : JSON.stringify(frame));
    },
    /** 收网关发来的消息 */
    onGatewayMessage(fn) {
      gatewayWs.on('message', (text) => fn(JSON.parse(text), text));
    },
    /** 收 mux 发来的消息 */
    onMuxMessage(fn) {
      muxWs.on('message', (text) => fn(JSON.parse(text), text));
    },
    /** 断开所有 ws（模拟服务端重启 / 网络抖动） */
    dropConnections() {
      muxWs.killAll();
      gatewayWs.killAll();
      gatewayConnected = false;
    },
    /**
     * 用指定 close code 主动关闭网关连接（模拟服务端撤销设备）。
     *
     * 真实插件 revoke 设备时执行 `client.close(4003, 'device revoked')`。
     * 客户端必须能靠这个码区分「授权被作废」和「网络断了」——
     * 两者要触发完全相反的处理。
     */
    closeGatewayWith(code, reason) {
      gatewayWs.killAllWithCode(code, reason);
      gatewayConnected = false;
    },
    /** 发一个配对码（给测试直接构造） */
    makePairingCode() {
      const code = crypto.randomBytes(16).toString('base64url');
      gatewayPairings.set(code, { deviceId: null, used: false });
      return code;
    },
    async close() {
      muxWs.close();
      gatewayWs.close();
      await new Promise((r) => server.close(r));
    },
  };
}
