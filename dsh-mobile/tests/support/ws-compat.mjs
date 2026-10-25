/**
 * 跨 Node 版本的 WebSocket 适配层。
 *
 * ## 为什么需要
 *
 * Node 21+ 才有全局 `WebSocket`（undici 实现）。Node 20 **没有**。
 *
 * 本地开发用的是 Node 24，集成测试全过；推到 CI（Node 20）后
 * 直接报 `WebSocket is not defined`，5 项 WS 测试全红。
 *
 * ## 为什么不干脆升级 CI 到 Node 22
 *
 * 可以，但**测试应该在任何支持的 Node 版本上都能跑**。
 * package.json 里写着 `engines: node >= 20`，那测试就得兼容 20。
 * 升级 CI 只是把问题藏起来 —— 用户用 Node 20 跑测试仍会失败。
 *
 * ## 这个文件做什么
 *
 * 用 `ws` 库（已经是显式 devDependency）实现一个**和全局 WebSocket
 * 接口一致**的构造器，然后兜底赋给 globalThis：
 *
 *   · Node 21+ → 用原生的（更快，行为更接近真实浏览器）
 *   · Node 20  → 用 ws 库的适配层
 *
 * 两个测试文件共用这一份，避免各自实现导致行为不一致。
 */

import WS from 'ws';

/**
 * 把 ws 库的实例包装成 DOM 风格。
 *
 * 产品代码和测试都用 DOM 风格：`ws.onopen`、`ws.addEventListener`、
 * `ws.readyState`。ws 库是 EventEmitter 风格（`.on('open')`），不兼容。
 */
function wrapWs(real, url) {
  const handlers = { open: [], message: [], error: [], close: [] };

  const ws = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    get readyState() {
      return real.readyState;
    },
    get url() {
      return url;
    },
    get protocol() {
      return real.protocol;
    },
    get bufferedAmount() {
      return real.bufferedAmount;
    },
    send(data) {
      real.send(data);
    },
    close(code, reason) {
      real.close(code, reason);
    },
    addEventListener(kind, fn) {
      if (handlers[kind]) handlers[kind].push(fn);
    },
    removeEventListener(kind, fn) {
      if (handlers[kind]) handlers[kind] = handlers[kind].filter((f) => f !== fn);
    },
  };

  // DOM 属性风格：ws.onopen = fn
  for (const kind of ['open', 'message', 'error', 'close']) {
    let current = null;
    Object.defineProperty(ws, `on${kind}`, {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
      configurable: true,
      enumerable: true,
    });
    handlers[kind].push((ev) => {
      if (typeof current === 'function') current(ev);
    });
  }

  // ── Node `ws` 特有的 `unexpected-response`（惰性桥接）──────────────
  //
  // ## 为什么需要
  //
  // 握手被拒（401/403）时，`ws` 与 RN 的 WebSocket 事件模型不同：
  //
  //   · RN（Android okhttp / iOS）→ 触发 `error`（message 带 401），随后 close
  //   · Node `ws` → 只发 `unexpected-response`
  //
  // 产品代码里有一个专门处理 `unexpected-response` 的分支
  // （approvalGateway，用于「失效 token 自愈」）。替身若不提供 `on()`
  // 订阅能力，产品那段逻辑在测试中永远收不到事件。
  //
  // ## ⚠️ 为什么必须「惰性」注册
  //
  // `ws` 库的内部逻辑是：**只要有人监听 `unexpected-response`，
  // 就不再触发 `error` 和 `close`**。所以如果这里无条件
  // `real.on('unexpected-response', ...)`，所有用这个替身的测试
  // （包括纯协议层的 integration-transport）都会失去 error/close 事件，
  // 导致「WS：没 cookie 被 401 拒绝」这类用例假失败 —— 实际已经踩过。
  //
  // 因此改为：只有当调用方**真的订阅了** `unexpected-response`
  // 时才注册 real 上的监听器，保持其它测试的事件语义完全不变。
  const unexpectedHandlers = [];
  let unexpectedBridgeInstalled = false;

  const ensureUnexpectedBridge = () => {
    if (unexpectedBridgeInstalled) return;
    unexpectedBridgeInstalled = true;
    real.on('unexpected-response', (req, res) => {
      for (const cb of [...unexpectedHandlers]) {
        try {
          cb(req, res);
        } catch {
          // 单个监听器抛错不影响其它监听器（与 EventEmitter 行为一致）
        }
      }
    });
  };

  ws.on = (event, cb) => {
    if (event !== 'unexpected-response') return;
    unexpectedHandlers.push(cb);
    ensureUnexpectedBridge();
  };
  ws.once = (event, cb) => {
    if (event !== 'unexpected-response') return;
    unexpectedHandlers.push(cb);
    ensureUnexpectedBridge();
  };
  ws.off = ws.removeListener = (event, cb) => {
    if (event !== 'unexpected-response') return;
    const i = unexpectedHandlers.indexOf(cb);
    if (i >= 0) unexpectedHandlers.splice(i, 1);
  };

  const fire = (kind, ev) => {
    for (const fn of handlers[kind]) {
      try {
        fn(ev);
      } catch {
        /* 单个处理器出错不影响其他 */
      }
    }
  };

  real.on('open', () => fire('open', {}));
  real.on('message', (data) => fire('message', { data: String(data) }));
  real.on('error', (err) => fire('error', { message: err?.message ?? 'error' }));
  real.on('close', (code, reason) => fire('close', { code, reason: String(reason ?? '') }));

  return ws;
}

/**
 * 构造器：Node 20 和 21+ 都能用。
 *
 * ## 参数兼容处理
 *
 * 浏览器 API 是 `new WebSocket(url, protocols)` —— 第二个参数只能是
 * 字符串或字符串数组。
 *
 * 但 RN 扩展了第三个参数传 options：`new WebSocket(url, protocols, opts)`。
 * 而很多代码（包括本项目的测试）写成 `new WebSocket(url, { headers })` ——
 * 省略 protocols 直接传 options。
 *
 * 原生 WebSocket 会忽略这种写法（或者按空协议处理）；
 * 但 `ws` 库会把它当成 protocols 数组 → 报
 * "An invalid or duplicated subprotocol was specified"。
 *
 * 所以这里要**识别出「第二参数是 options 对象」的情况**并纠正。
 *
 * @param {string} url
 * @param {string[]|string|{headers?: Record<string,string>}} [protocolsOrOptions]
 * @param {{headers?: Record<string,string>}} [options]
 */
export function CompatWebSocket(url, protocolsOrOptions, options) {
  let protocols = protocolsOrOptions;
  let opts = options;

  // `new WebSocket(url, { headers })` —— 第二参数其实是 options
  if (
    protocolsOrOptions &&
    !Array.isArray(protocolsOrOptions) &&
    typeof protocolsOrOptions === 'object'
  ) {
    opts = protocolsOrOptions;
    protocols = [];
  }

  const list = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
  // ws 库对空字符串/非字符串元素会抛错，先过滤干净
  const clean = list.filter((p) => typeof p === 'string' && p.length > 0);

  const real = new WS(url, clean, { headers: opts?.headers ?? {} });
  return wrapWs(real, url);
}

// 补上 DOM 常量（有些代码会读 WebSocket.OPEN）
CompatWebSocket.CONNECTING = 0;
CompatWebSocket.OPEN = 1;
CompatWebSocket.CLOSING = 2;
CompatWebSocket.CLOSED = 3;

/**
 * 确保 globalThis.WebSocket 可用且**行为一致**。
 *
 * 为什么不「有原生的就用原生的」：
 *
 *   Node 21+ 的原生 WebSocket **不支持构造函数第三个参数传 header**
 *   （那是 RN 的扩展）。审批网关必须带 `X-DSH-Device-ID`，
 *   用原生实现会被静默忽略 → 服务端 400。
 *
 * 所以**一律换成兼容层**，不管 Node 版本。
 * 好处是两个测试文件和产品代码在 CI / 本地行为完全一致。
 *
 * @returns {'ws-shim'} 固定返回，方便测试断言「确实装了兼容层」
 */
export function ensureWebSocket() {
  globalThis.WebSocket = CompatWebSocket;
  return 'ws-shim';
}
