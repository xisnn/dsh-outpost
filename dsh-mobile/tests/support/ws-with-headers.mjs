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

  // ── Node `ws` 特有的 `unexpected-response`（惰性桥接）──
  //
  // ⚠️ 为什么必须显式桥接：
  //
  // 握手被拒（401/403）时，`ws` 与 RN 的 WebSocket 事件模型不同：
  //   · RN（Android okhttp / iOS）→ 触发 error，message 带 401
  //   · Node `ws` → 只发一个独立的 `unexpected-response`
  //
  // 产品代码里有专门处理它的分支（approvalGateway 的
  // `unexpected-response` 监听），用于「失效 token 自愈」。
  // 替身若不提供订阅能力，产品那段逻辑在测试中永远收不到事件。
  //
  // ⚠️ 为什么必须「惰性」注册：
  //
  // `ws` 库的内部逻辑是「只要有人监听 unexpected-response，
  // 就不再触发 error 和 close」。无条件注册会让所有使用本替身的测试
  // 失去 error/close 语义，破坏其它用例（实际已踩过：
  // integration-transport 的「WS：没 cookie 被 401 拒绝」因此假失败）。
  // 因此只在调用方真的订阅时才安装 real 上的监听器。
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
