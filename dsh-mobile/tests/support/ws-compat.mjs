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
