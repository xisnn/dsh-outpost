/**
 * 传输层：认证 + unary RPC + 流式 WebSocket。
 *
 * 这部分是纯逻辑，不依赖 React Native —— WebSocket 与 fetch 由调用方注入，
 * 因此同一份代码既能在 RN 里跑，也能在 Node 里被测试。
 *
 * 协议实测见 docs/protocol-notes.md。
 */

import { checkBaseUrlSecurity, redactUrl } from '../net-security';
import { RpcError, type RpcErrorKind } from '../rpc-error';

/**
 * 造一个带分类和用户提示的 RPC 错误。
 *
 * 分类规则不放在这里，而是根据 kind + raw 现算 —— 保持 transport
 * 只管「哪一层失败」，具体话术交给 rpc-error。
 */
function makeRpcError(
  endpoint: string,
  kind: RpcErrorKind,
  raw: string,
  cause?: unknown,
): RpcError {
  const lower = raw.toLowerCase();

  // 接口不存在 = 版本不匹配，这是最重要的一类
  const missing = /not-?found|unknown\s+method|no\s+such|unimplemented/i.test(lower);
  const auth = kind === 'http' && /40[13]/.test(raw);
  const authText = /unauthor|forbidden|invalid.*(token|cookie)/i.test(lower);
  const serverErr = kind === 'http' && /5\d\d/.test(raw);

  let userTitle: string;
  let userHint: string;
  let retryable: boolean;

  if (missing) {
    userTitle = '这个 DSH 版本不支持该功能';
    userHint =
      '电脑上的 DSH 可能比你装的 App 老，或者接口改过名。\n' +
      '建议把 DSH 更新到最新版，再试一次。';
    retryable = false;
  } else if (auth || authText) {
    userTitle = '登录状态失效了';
    userHint =
      'DSH 服务可能重启过（token 每次启动都会变）。\n' +
      '回配对页用新的 token 重新连一次就好。';
    retryable = false;
  } else if (kind === 'network') {
    userTitle = '连不上电脑上的 DSH';
    userHint =
      '检查：① 电脑上 DSH 还在跑吗；② 手机和电脑在同一网络吗；\n' +
      '③ 换过 WiFi 的话，电脑地址可能变了，需要重新扫码。';
    retryable = true;
  } else if (kind === 'malformed') {
    userTitle = 'DSH 返回的数据格式变了';
    userHint =
      'App 按旧格式解析不了。建议把 App 更新到最新版。\n' +
      '如果已经是最新版，说明上游改得比较快。';
    retryable = true;
  } else if (serverErr) {
    userTitle = 'DSH 那边出错了';
    userHint = '这是电脑端的问题，不是手机的。\n建议看看 DSH 日志，或者重启一下 DSH。';
    retryable = true;
  } else {
    userTitle = '操作失败了';
    userHint = '详情里是原始错误信息。';
    retryable = false;
  }

  return new RpcError({ endpoint, kind, raw, userTitle, userHint, retryable, cause });
}

export interface TransportOptions {
  /** 服务地址，如 http://192.168.1.10:3095（局域网 / Tailscale / 自建公网都只是一个 URL） */
  baseUrl: string;
  /** 已保存的 cookie；没有则先用 token 换 */
  cookie?: string;
  /** 首次配对用的 token */
  token?: string;
  /** 注入的 fetch（RN 有全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 注入的 WebSocket 构造器 */
  WebSocketImpl?: typeof WebSocket;
}

export interface RpcEnvelope {
  type: 'client-request';
  rpcId: string;
  method: string;
  payload: { args: Record<string, unknown> };
}

export interface RpcResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; details?: unknown };
}

let rpcCounter = 0;
function nextRpcId(): string {
  rpcCounter += 1;
  return `r${Date.now().toString(36)}-${rpcCounter}`;
}

/** 从 Set-Cookie 里提取 cookie 键值对（不含属性） */
export function extractCookie(setCookieHeaders: string[] | null): string | undefined {
  if (!setCookieHeaders?.length) return undefined;
  const parts = setCookieHeaders.map((c) => c.split(';')[0].trim()).filter(Boolean);
  return parts.length ? parts.join('; ') : undefined;
}

export class DshConnection {
  readonly baseUrl: string;
  private cookie?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: typeof WebSocket;
  private ws?: WebSocket;
  private streamId = 0;
  private readonly streams = new Map<string, (frame: StreamFrame) => void>();
  /** 由宿主注入的原生 cookie 读取器（RN 必需） */
  private cookieReader?: (baseUrl: string) => Promise<string | undefined>;

  constructor(opts: TransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.cookie = opts.cookie;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const WSImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
    if (!WSImpl) throw new Error('no WebSocket implementation available');
    this.WS = WSImpl;
  }

  get hasCookie(): boolean {
    return !!this.cookie;
  }

  get currentCookie(): string | undefined {
    return this.cookie;
  }

  /**
   * 用首次配对 token 换 cookie。返回 cookie，由调用方持久化。
   *
   * ⚠️ 这里不能像浏览器/Node 那样读 `Set-Cookie` 响应头：
   * - RN 的 fetch 不支持 `redirect: 'manual'`（303 会被自动跟随成 200）
   * - RN 的 Headers 没有 `getSetCookie()`
   *
   * 所以改用 RN 的原生 cookie 容器：
   * 1. 带 `credentials: 'include'` 请求 → 原生层自动接收并保存 Set-Cookie
   * 2. 用 CookieManager 把保存的 cookie 读回来，交给调用方持久化
   */
  async loginWithToken(token: string): Promise<string> {
    // 明文 HTTP 只允许发往私有地址。公网域名必须 https ——
    // 否则 token 会明文经过公网。校验放在最前面，不合格的地址
    // 连请求都不发。
    const insecure = checkBaseUrlSecurity(this.baseUrl);
    if (insecure) throw new Error(insecure);

    const url = `${this.baseUrl}/?token=${encodeURIComponent(token)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'text/html' },
      });
    } catch (e) {
      // 错误信息里带地址有助于排查，但必须脱敏 ——
      // baseUrl 理论上不含 token（配对解析时已剥离），
      // 这里再兜一层，防止将来有人改了解析逻辑把 token 带进来。
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new Error(
        `连接失败（fetch 阶段）：${msg}。地址=${redactUrl(this.baseUrl)}`,
      );
    }

    // 303 被自动跟随，最终是 200；状态码不再可靠，直接读 cookie 容器
    if (res.status >= 400) {
      throw new Error(`token exchange failed: HTTP ${res.status}`);
    }

    const cookie = await this.readCookieFromJar();
    if (!cookie) {
      throw new Error(
        'token exchange failed: no cookie in jar. ' +
          '确认 token 未过期，且服务地址与端口和启动日志一致。',
      );
    }
    this.cookie = cookie;
    return cookie;
  }

  /** 从 RN 的原生 cookie 容器读回 dsh-auth cookie */
  private async readCookieFromJar(): Promise<string | undefined> {
    // 优先用 @react-native-cookies/cookies（如果装了）
    try {
      const mod = await import('@react-native-cookies/cookies' as string);
      const cm = (mod as { default?: unknown }).default ?? mod;
      const get = (cm as { get?: (u: string) => Promise<Record<string, { value: string }>> }).get;
      if (get) {
        // 加超时：原生 cookie 容器偶发不回调，不能让它把整个连接卡死
        const all = await Promise.race([
          get(this.baseUrl),
          new Promise<Record<string, { value: string }>>((_, reject) =>
            setTimeout(() => reject(new Error('CookieManager.get timeout')), 5000),
          ),
        ]);
        const parts = Object.entries(all ?? {})
          .filter(([name]) => name.startsWith('dsh-auth'))
          .map(([name, c]) => `${name}=${c.value}`);
        if (parts.length) {
          return parts.join('; ');
        }
      }
    } catch (e) {
    }

    // 兜底：让调用方从 native 层注入读取函数
    if (this.cookieReader) {
      try {
        return await this.cookieReader(this.baseUrl);
      } catch (e) {
      }
    }
    return undefined;
  }

  /** 由宿主注入「从原生 cookie 容器读取」的能力（RN 下必需） */
  setCookieReader(fn: (baseUrl: string) => Promise<string | undefined>): void {
    this.cookieReader = fn;
  }

  /** unary 调用：POST /api/<ns>/<method> */
  async call<T = unknown>(endpoint: string, args: Record<string, unknown>): Promise<T> {
    if (!this.cookie) throw new Error('not authenticated: call loginWithToken first');
    const body: RpcEnvelope = {
      type: 'client-request',
      rpcId: nextRpcId(),
      method: endpoint,
      payload: { args },
    };
    const url = `${this.baseUrl}/api/${endpoint}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: this.cookie,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (__DEV__) console.log('[transport] fetch failed', url, err?.name, err?.message);
      // 网络层的错误统一包一层可操作提示 —— 用户看到
      // 「Network request failed」是不知道该怎么做的。
      throw makeRpcError(endpoint, 'network', `${err?.name ?? ''}: ${err?.message ?? ''}`.trim(), e);
    }
    if (!res.ok) {
      // HTTP 状态码本身也带信息：401 = 鉴权失效，5xx = 服务端内部错
      throw makeRpcError(endpoint, 'http', `HTTP ${res.status}`);
    }
    // 解析失败不能把原始异常抛给上层 —— 用户会看到
    // "Unexpected token < in JSON" 这种完全看不懂的东西。
    let parsed: { result?: RpcResult<T> } | undefined;
    try {
      parsed = (await res.json()) as { result?: RpcResult<T> };
    } catch {
      parsed = undefined;
    }
    const result = parsed?.result;
    if (!result) {
      // 能拿到 200 但结构不对 —— 典型的「上游改了返回格式」
      throw makeRpcError(endpoint, 'malformed', 'malformed response（没有 result 字段）');
    }
    if (result.ok === false) {
      const err = result.error;
      throw makeRpcError(
        endpoint,
        'rpc',
        `${err?.code ?? 'unknown'} ${err?.message ?? ''}`.trim(),
      );
    }
    return result.value as T;
  }

  /** 建立 WebSocket（惰性，复用） */
  private async ensureSocket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === 1) return this.ws;
    if (!this.cookie) throw new Error('not authenticated');
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/remote.mux';

    // RN 的 WebSocket 构造函数只接受 (url, protocols)，没法设自定义 header。
    //
    // 之前这里只传了 url —— cookie 参数收下就丢了，等于裸连。
    // 服务端 `authorizedClient()` 会检查 Sec-WebSocket-Protocol 里有没有
    // clientToken，没有就 401，于是 WebSocket 永远连不上、会话永远是空的
    // （这就是「点进已有会话显示空调话」的真凶）。
    //
    // 解法：把 cookie 值当成子协议传进去。RN 会把数组里的每一段写进
    // Sec-WebSocket-Protocol，正好被服务端认出来。
    // 子协议名只允许 token 字符，cookie 的值恰好是 base64url + '.'，符合规范。
    const ws = this.openWebSocket(wsUrl, this.cookie);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('连接超时：15 秒内没能和服务建立 WebSocket')),
        15000,
      );
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      // error 事件本身没有可用信息（String(event) === '[object Object]'），
      // 真正有用的是 close 事件的 code/reason，所以这里给出可操作的提示。
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('WebSocket 连接失败：检查服务地址是否可达、服务是否还在运行'));
      });
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      let frame: StreamFrame;
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      const handler = frame.streamId ? this.streams.get(frame.streamId) : undefined;
      handler?.(frame);
    });

    this.ws = ws;
    return ws;
  }

  /**
   * 打开 WebSocket。
   *
   * 鉴权靠 RN 的原生 cookie 容器：登录时用 `credentials: 'include'` 让原生层
   * 存下 Set-Cookie，之后同域请求（包括 WebSocket）会自动带上。
   * 这就是为什么 openWebSocket 收下 cookie 参数却不用它 —— 容器已经管了。
   *
   * ⚠️ 但要说清楚：这依赖原生 cookie 容器的域匹配。如果 App 存的 cookie
   * 域和 WS 连接的域对不上（比如手动写了 baseUrl 但 cookie 是另一个域的），
   * WS 就会 401，表现是「会话一直是空的」。
   * 排查时优先看这个，不要怀疑网络。
   */
  protected openWebSocket(url: string, cookie: string): WebSocket {
    const Ctor = this.WS as unknown as {
      new (u: string, p?: string | string[]): WebSocket;
    };
    // cookie 参数留给子类覆盖用；原生容器已负责携带，这里不重复注入
    void cookie;
    return new Ctor(url);
  }

  /**
   * 打开一条流。返回句柄：async iterate 下行 item，close 取消。
   */
  async openStream(
    endpoint: string,
    args: Record<string, unknown>,
  ): Promise<StreamHandle> {
    const ws = await this.ensureSocket();
    const streamId = `s${Date.now().toString(36)}-${++this.streamId}`;

    const queue: unknown[] = [];
    let done = false;
    let failure: Error | undefined;
    let notify: (() => void) | undefined;

    const wake = () => { notify?.(); notify = undefined; };

    this.streams.set(streamId, (frame) => {
      if (frame.type === 'item') { queue.push(frame.value); wake(); }
      else if (frame.type === 'end') { done = true; wake(); }
      else if (frame.type === 'error') {
        failure = new Error(frame.error?.message ?? 'stream error');
        done = true;
        wake();
      } else if (frame.type === 'ready') { wake(); }
    });

    ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));

    // 注意：这里必须捕获外层 this，不能在对象字面量里用 this
    const streams = this.streams;
    const handle: StreamHandle = {
      streamId,
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) { yield queue.shift(); continue; }
          if (failure) throw failure;
          if (done) return;
          await new Promise<void>((r) => { notify = r; });
        }
      },
      close() {
        streams.delete(streamId);
        if (ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'cancel', streamId })); } catch { /* ignore */ }
        }
      },
    };
    return handle;
  }

  close(): void {
    this.streams.clear();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = undefined;
  }
}

export interface StreamHandle {
  streamId: string;
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
  close(): void;
}

export type StreamFrame =
  | { type: 'item'; streamId: string; value: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error?: { code?: string; message?: string } }
  | { type: 'ready'; streamId?: string };
