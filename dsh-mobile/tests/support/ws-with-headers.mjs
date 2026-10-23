/**
 * 支持自定义 header 的 WebSocket 构造函数（给 Node 测试用）。
 *
 * ## 为什么需要
 *
 * `ApprovalGateway` 这样建连：
 *
 *   const TypeCtor = WebSocket as unknown as new (url, protocols, opts) => WebSocket;
 *   new TypeCtor(url, protocols, { headers: { 'X-DSH-Device-ID': deviceId } });
 *
 * RN 的 WebSocket 构造函数**支持第三个参数传 headers**（非标准扩展）。
 * 但 Node 的全局 WebSocket（undici 实现）会**静默忽略**它 ——
 * 于是握手缺少 X-DSH-Device-ID，服务端返回 400。
 *
 * 这个文件提供一个构造器，接收同样的三个参数，
 * 内部换成 `ws` 库（它支持 headers），但对外暴露**和 WebSocket 一样的事件接口**
 * （onopen / onmessage / onerror / onclose / addEventListener / readyState / send / close），
 * 因为产品代码用的是 DOM 风格属性赋值。
 *
 * ## 为什么不用 ws 直接替换
 *
 * ws 的事件是 EventEmitter 风格（`.on('open')`），
 * 产品代码写的是 `ws.onopen = ...`。不兼容。
 * 所以这里做一层适配。
 */

import WS from 'ws';

/**
 * @param {string} url
 * @param {string[]} [protocols]
 * @param {{headers?: Record<string,string>}} [options]
 */
export function makeHeaderWebSocket(url, protocols, options) {
  const real = new WS(url, protocols ?? [], {
    headers: options?.headers ?? {},
  });

  // DOM 风格的事件处理器
  const handlers = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  const ws = {
    // DOM 常量
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

  // DOM 属性风格的 onXxx
  for (const kind of ['open', 'message', 'error', 'close']) {
    const key = `on${kind}`;
    let current = null;
    Object.defineProperty(ws, key, {
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
  real.on('message', (data) => {
    fire('message', { data: String(data) });
  });
  real.on('error', (err) => {
    fire('error', { message: err?.message ?? 'error' });
  });
  real.on('close', (code, reason) => {
    fire('close', { code, reason: String(reason ?? '') });
  });

  return ws;
}

/**
 * 安装到 globalThis.WebSocket。
 *
 * 必须在 import ApprovalGateway 之前调用 —— 它用的是全局 WebSocket。
 * 但我们没法改 import 时机（产品代码里是运行时读全局），
 * 所以只要在 `gw.connect()` 之前装上就行。
 */
export function installHeaderWebSocket() {
  globalThis.WebSocket = makeHeaderWebSocket;
  return makeHeaderWebSocket;
}
