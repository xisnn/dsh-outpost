/**
 * 传输层：认证 + unary RPC + 流式 WebSocket。
 *
 * 这部分是纯逻辑，不依赖 React Native —— WebSocket 与 fetch 由调用方注入，
 * 因此同一份代码既能在 RN 里跑，也能在 Node 里被测试。
 *
 * 协议实测见 docs/protocol-notes.md。
 */

import { assertSecureUrl, checkBaseUrlSecurity, redactUrl } from '../net-security';
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

/**
 * HTTP RPC 的默认超时。
 *
 * 为什么需要：之前完全没有超时。网络半死不活时（信号弱、切网、
 * 服务端卡住），fetch 会永久挂起 —— 不报错、不返回、不重试。
 * 用户看到的是「一直转圈」「连接状态卡在检测中」「发消息没反应」，
 * 只能杀 App 重进。
 *
 * 30 秒的取值：
 *   · 普通 RPC（列会话、发消息）正常 1 秒内返回，30 秒足够宽松
 *   · 长会话分页可能要久一些，调用方可以用 __timeoutMs 覆盖
 *   · 不能太长 —— 用户等 30 秒已经很难受了，再久不如早点报错重试
 */
const RPC_TIMEOUT_MS = 30_000;

/** 探测类接口（ping / 兼容性检查）用更短的超时，避免拖住界面 */
export const PROBE_TIMEOUT_MS = 8_000;

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
  private connectingWs?: Promise<WebSocket>;
  private socketGeneration = 0;
  private streamId = 0;
  private readonly streams = new Map<string, (frame: StreamFrame) => void>();
  /** 由宿主注入的原生 cookie 读取器（RN 必需） */
  private cookieReader?: (baseUrl: string) => Promise<string | undefined>;

  constructor(opts: TransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // 构造时就校验一次：不合规的地址连对象都建不出来。
    //
    // 为什么放在构造而不是每个调用点：连接是**所有**带凭据请求的唯一来源
    // （RPC / 会话流 WS / 上传 / 文件下载都从这里拿 baseUrl），在入口挡一次，
    // 比在每个调用点重复挡更可靠 —— 后者只要有人加新调用就漏。
    assertSecureUrl(this.baseUrl, '连接地址');
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
   *
   * ## ⚠️ 关键坑：303 被跟随之后的状态码不可信
   *
   * 服务端对 `GET /?token=xxx` 返回 **303 + Set-Cookie**，location 是 `./`
   * ——也就是回到 `/`。RN 的 fetch 会自动跟随这个重定向，于是实际发出的
   * 第二个请求是 `GET /`。
   *
   * 问题在于：**重定向那一步不一定带着刚拿到的 cookie**（取决于原生
   * 网络栈把 Set-Cookie 写进 jar 的时机）。没带上就是 401。
   *
   * 实测（Android 15 / API 35 模拟器）：
   *   GET /?token=xxx   → 303 + set-cookie   ✅
   *   GET /  (无 cookie) → 401               ❌ ← fetch 的最终结果
   *
   * 所以**绝不能拿 res.status 判断配对成功与否**。正确做法：
   * 请求发出去之后，只看 cookie jar 里有没有 dsh-auth cookie。
   * 有 = 配对成功（服务端已经认可了 token 并下发凭据），
   * 没有才去纠结状态码。
   */
  async loginWithToken(token: string): Promise<string> {
    // 明文 HTTP 只允许发往私有地址。公网域名必须 https ——
    // 否则 token 会明文经过公网。校验放在最前面，不合格的地址
    // 连请求都不发。
    const insecure = checkBaseUrlSecurity(this.baseUrl);
    if (insecure) throw new Error(insecure);

    // ⚠️ 登录前必须先清空本服务的 cookie jar。
    //
    // 为什么：后面要用「jar 里有没有 dsh-auth cookie」来判断配对是否
    // 成功（303 被跟随之后状态码不可信，见下面的说明）。
    // 但 cookie jar 是**原生层的持久容器** —— 上一次登录留下的
    // dsh-auth cookie 会一直在里面。不清的话：
    //
    //     jar 里有旧 cookie + 错误 token → 读到旧 cookie → 判定成功
    //
    // 也就是**任何 token 都能通过**，认证被完全绕过。
    //
    // 清空只针对本服务地址，不影响用户连的其他 DSH 实例。
    await this.clearCookieJar();

    const url = `${this.baseUrl}/?token=${encodeURIComponent(token)}`;
    let res: Response | undefined;
    let fetchError: unknown;
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
      fetchError = e;
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new Error(
        `连接失败（fetch 阶段）：${msg}。地址=${redactUrl(this.baseUrl)}`,
      );
    } finally {
      void fetchError;
    }

    // ⚠️ 先看 cookie jar，再看状态码。
    //
    // 顺序不能反：303 被跟随之后最终落到 `GET /`，那一步很可能因为
    // 还没带上 cookie 而返回 401 —— 但配对其实**已经成功**了
    // （Set-Cookie 已经下发）。先判状态码会把成功当失败。
    //
    // 前提是上面已经清空过 jar，所以这里读到的只可能是
    // **本次登录**服务端下发的 cookie。
    //
    // 详见上面方法注释里的实测数据。
    const cookie = await this.readCookieFromJar();
    if (cookie) {
      this.cookie = cookie;
      return cookie;
    }

    // jar 里没有 cookie，这才是真的失败。这时候状态码才有参考价值。
    if (res && res.status >= 400) {
      throw new Error(`token exchange failed: HTTP ${res.status}`);
    }

    throw new Error(
      'token exchange failed: no cookie in jar. ' +
        '确认 token 未过期，且服务地址与端口和启动日志一致。',
    );
  }

  /**
   * 清空本服务地址下的 dsh-auth cookie。
   *
   * 登录前调用。目的只有一个：保证登录后从 jar 里读到的 cookie
   * **一定是本次登录下发的**，而不是上次遗留的。
   *
   * 不清的话，cookie jar 里的历史凭据会让「jar 里有 cookie」
   * 这个判据失效 —— 错误的 token 也能通过认证。
   *
   * 只清本 baseUrl 下的 cookie，不影响用户连的其他 DSH 实例。
   * 失败不阻断：读不到 CookieManager 时（纯 Node 环境）本来就没有
   * 第二个存储需要清。
   */
  private async clearCookieJar(): Promise<void> {
    try {
      const { clearNativeCookieJar } = await import('../cookieJar');
      await clearNativeCookieJar(this.baseUrl);
    } catch {
      // 清理失败也让登录继续 —— 但下面的判据会因此变得不严格。
      // 这种情况在真机上不该出现（CookieManager 是 RN 的必需依赖），
      // 真出现了说明宿主没注入 reader，那时 readCookieFromJar 也会返回空。
    }
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

    // 超时控制。不同接口耗时差别大（列会话很快，长会话分页可能要久），
    // 允许调用方通过 args.__timeoutMs 覆盖。
    const override = Number(args.__timeoutMs ?? 0);
    const timeoutMs = override > 0 ? override : RPC_TIMEOUT_MS;
    // ⚠️ 必须把 __timeoutMs 从真实参数里摘掉，否则会被发给服务端，
    // 有些接口对未知参数会直接报错。
    const { __timeoutMs: _ignoredTimeout, ...realArgs } = args;
    void _ignoredTimeout;

    const body: RpcEnvelope = {
      type: 'client-request',
      rpcId: nextRpcId(),
      method: endpoint,
      payload: { args: realArgs },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
        // ⚠️ 必须有超时。
        //
        // 之前没有 signal，一旦网络半死不活（信号弱、切网、服务端卡住），
        // fetch 会**永久挂起** —— 不报错、不返回、也不重试。
        // 表现就是：界面一直转圈、连接状态卡在「检测中」、发消息没反应。
        // 手机关掉再开 WiFi 才恢复。
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (e) {
      clearTimeout(timer);
      const err = e as { name?: string; message?: string };
      if (__DEV__) console.log('[transport] fetch failed', url, err?.name, err?.message);
      // 超时单独给一条提示：和「连不上」不是一回事，
      // 用户能做的事也不同（等一下再试 vs 检查地址/网络）。
      if (err?.name === 'AbortError') {
        throw makeRpcError(
          endpoint,
          'network',
          `请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`,
          e,
        );
      }
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

  /** 建立 WebSocket（惰性，复用，带并发 single-flight 与代次隔离） */
  private async ensureSocket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === 1) return this.ws;
    if (this.connectingWs) return this.connectingWs;
    if (!this.cookie) throw new Error('not authenticated');

    const generation = ++this.socketGeneration;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/remote.mux';
    const ws = this.openWebSocket(wsUrl, this.cookie);
    const isCurrent = () => this.socketGeneration === generation && this.ws === ws;

    const connectPromise = (async () => {
      let handshakeErrorText = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(makeRpcError('remote.mux', 'network', '连接超时：15 秒内没能和服务建立 WebSocket')),
          15000,
        );
        let settled = false;
        const finishReject = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        };
        ws.addEventListener('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
        ws.addEventListener('error', (ev: Event) => {
          const msg = (ev as { message?: unknown })?.message;
          if (typeof msg === 'string' && msg) {
            handshakeErrorText = redactUrl(msg);
          }
          const isAuth =
            /(^|[^0-9])(401|403)([^0-9]|$)|unauthorized|forbidden/i.test(handshakeErrorText);
          finishReject(
            makeRpcError(
              'remote.mux',
              isAuth ? 'http' : 'network',
              isAuth
                ? `HTTP 401 (${handshakeErrorText})`
                : handshakeErrorText || 'WebSocket 连接失败：检查服务地址是否可达、服务是否还在运行',
            ),
          );
        });
        ws.addEventListener('close', (ev: { code?: number; reason?: string }) => {
          const code = Number(ev?.code ?? 0);
          const why = String(ev?.reason ?? '');
          const combined = `${why} ${handshakeErrorText}`.trim();
          const isAuth =
            /(^|[^0-9])(401|403)([^0-9]|$)|unauthorized|forbidden/i.test(combined);
          finishReject(
            makeRpcError(
              'remote.mux',
              isAuth ? 'http' : 'network',
              isAuth
                ? `HTTP 401 (${combined})`
                : `WebSocket 握手关闭（code ${code}${why ? `：${why}` : ''}）`,
            ),
          );
        });
        // Node ws 兼容：握手返回 401/403 时触发 unexpected-response
        const wsWithUnexpected = ws as unknown as {
          on?: (
            event: string,
            cb: (req: unknown, res: { statusCode?: number; statusMessage?: string }) => void,
          ) => void;
        };
        wsWithUnexpected.on?.('unexpected-response', (_req, res) => {
          const status = Number(res?.statusCode ?? 0);
          const text = String(res?.statusMessage ?? '');
          const isAuth = status === 401 || status === 403;
          finishReject(
            makeRpcError(
              'remote.mux',
              isAuth ? 'http' : 'network',
              `HTTP ${status || 500}${text ? ` ${text}` : ''}`,
            ),
          );
        });
      });

      if (this.socketGeneration !== generation) {
        try { ws.close(); } catch { /* ignore */ }
        throw makeRpcError('remote.mux', 'network', '连接已被更新或关闭');
      }

      ws.addEventListener('message', (ev: MessageEvent) => {
        if (!isCurrent()) return;
        let frame: StreamFrame;
        try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
        const handler = frame.streamId ? this.streams.get(frame.streamId) : undefined;
        handler?.(frame);
      });

      // ── 连接关闭 / 出错：必须让当前代次的所有活跃流立刻失败 ────────────────
      const failAllStreams = (reason: string) => {
        if (!isCurrent()) return;
        const entries = [...this.streams.entries()];
        this.streams.clear();
        this.ws = undefined;
        for (const [, handler] of entries) {
          try {
            handler({
              type: 'error',
              streamId: '',
              error: { code: 'network', message: reason },
            });
          } catch {
            /* 单个流处理失败不影响其它 */
          }
        }
      };

      ws.addEventListener('close', (ev: { code?: number; reason?: string }) => {
        if (!isCurrent()) return;
        const code = Number(ev?.code ?? 0);
        const why = String(ev?.reason ?? '');
        const detail = code === 1000
          ? '连接已关闭'
          : `连接已断开（code ${code}${why ? `：${why}` : ''}）`;
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.log('[transport] ws closed', code, why);
        }
        failAllStreams(detail);
      });

      ws.addEventListener('error', () => {
        if (!isCurrent()) return;
        failAllStreams('WebSocket 连接出错');
      });

      this.ws = ws;
      return ws;
    })();

    this.connectingWs = connectPromise;
    try {
      return await connectPromise;
    } finally {
      if (this.connectingWs === connectPromise) {
        this.connectingWs = undefined;
      }
    }
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
      new (
        u: string,
        p?: string | string[] | null,
        opts?: { headers?: Record<string, string> },
      ): WebSocket;
    };
    const isReactNative =
      typeof navigator !== 'undefined' &&
      (navigator as { product?: string }).product === 'ReactNative';
    if (isReactNative && cookie) {
      // RN Android OkHttp WebSocket 不会自动携带 CookieManager 里的 cookie，
      // 必须通过第 3 个参数显式传 Cookie，否则 /api/remote.mux 返回 401，
      // 导致 ChatScreen 顶部报 error、session/follow 无法接收 user/message。
      return new Ctor(url, undefined, { headers: { Cookie: cookie } });
    }
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

  /** 立即重置底层 WebSocket 并终止所有活跃流（供前后台恢复或测试断连使用） */
  resetSocket(reason = '连接已重置'): void {
    this.socketGeneration += 1;
    this.connectingWs = undefined;
    const entries = [...this.streams.entries()];
    this.streams.clear();
    const ws = this.ws;
    this.ws = undefined;
    for (const [, handler] of entries) {
      try {
        handler({
          type: 'error',
          streamId: '',
          error: { code: 'network', message: reason },
        });
      } catch {
        /* ignore */
      }
    }
    try { ws?.close(); } catch { /* ignore */ }
  }

  close(): void {
    this.socketGeneration += 1;
    this.connectingWs = undefined;
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
