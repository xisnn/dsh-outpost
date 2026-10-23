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
  const cookieName = 'dsh-auth-test';
  const cookieValue = 'v1.' + crypto.randomBytes(24).toString('base64url');
  const cookie = `${cookieName}=${cookieValue}`;

  /** RPC 处理函数表：'session/list' → fn(args, ctx) */
  const handlers = opts.handlers ?? {};
  /** 每次收到的 RPC 都记下来，测试里可以断言「发的是不是这个形状」 */
  const calls = [];
  /** 网关连上的设备 */
  const gatewayDevices = new Set();
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

    // ── 设备列表 ───────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          payload: {
            devices: [...gatewayDevices].map((id, i) => ({
              id,
              name: `fake-device-${i}`,
              lastSeenAt: Date.now(),
            })),
          },
        }),
      );
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
        if (tok !== 'valid-device-token') {
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
      // 配对上就发 paired 帧（真实服务端行为）
      setTimeout(() => {
        s.send({
          kind: 'paired',
          deviceToken: 'valid-device-token',
          deviceId: String(deviceId),
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
