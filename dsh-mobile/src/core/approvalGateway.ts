/**
 * 审批网关客户端。
 *
 * 背景：手机端之前只能「看到」审批，不能回答 —— DSH 的审批是 Host 侧的
 * `approval/request` waterfall，结果靠 Remote Event 监听器的返回值回传，
 * 没有 HTTP RPC 可以调（我把 asar 里 12 个候选接口名都试过，全部 not found）。
 *
 * 解法：用官方社区的 `dsh-plugin-mobile-gateway` 插件。它在 Host 内部接入
 * 那个 waterfall，然后通过独立 WebSocket 把审批投影给手机，手机回帧即可。
 *
 * 本文件只做审批这一件事，**不动现有 RPC 传输层** —— 现有功能全部走老路径，
 * 这里是一条并行的旁路连接。这样即使网关挂了，聊天等功能也不受影响。
 *
 * 协议要点（来自插件自带的 PROTOCOL.md）：
 *   连接   ws://<host>:3081/ws/mobile
 *   配对   子协议 ['dsh-mobile-v1', 'dsh-pair.<pairingCode>']
 *          请求头 X-DSH-Device-ID（稳定设备 id，用于复用可信设备记录）
 *   收     {"kind":"approval-requested", rpcId, sessionId, approvalId, toolName, reason, displayReason, replay}
 *          {"kind":"approval-resolved",  rpcId, sessionId, approvalId, outcome}
 *   发     {"type":"approval-response", rpcId, sessionId, approvalId, outcome}
 *          outcome 只能是 allowed-once / rejected
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** 网关默认端口（插件配置 lanPort） */
const GATEWAY_PORT = 3081;

/** 设备 id 持久化键：配对时用它复用可信设备记录 */
const DEVICE_ID_KEY = '@dsh/gatewayDeviceId';

/** 长期设备 token（配对成功后拿到，避免每次重连都要配对码） */
const DEVICE_TOKEN_KEY = '@dsh/gatewayToken';

/** 一条待审批 */
export interface PendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  reason?: string;
  displayReason?: Record<string, string>;
  /** 服务端重放的（连上时已存在的未决审批） */
  replay?: boolean;
}

export type ApprovalOutcome = 'allowed-once' | 'rejected';

export interface GatewayEvents {
  /** 连接状态变化 */
  onStatus?: (status: 'idle' | 'connecting' | 'online' | 'offline', detail?: string) => void;
  /** 来了一个待审批 */
  onApproval?: (a: PendingApproval) => void;
  /** 审批已决（可能是本机回的，也可能是别的设备/WebUI 回的） */
  onResolved?: (rpcId: string, outcome: string) => void;
}

/** 从 baseUrl 里取出主机名，拼出网关地址 */
export function gatewayUrlFrom(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `ws://${u.hostname}:${GATEWAY_PORT}/ws/mobile`;
  } catch {
    return '';
  }
}

/** 生成/读取稳定的设备 id */
async function ensureDeviceId(): Promise<string> {
  try {
    const saved = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (saved) return saved;
  } catch {
    /* 读不到就重新生成 */
  }
  const id = `dsh-outpost-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* 存不了也无所谓，本次会话内有效 */
  }
  return id;
}

/**
 * 审批网关连接。
 *
 * 生命周期由调用方控制：进聊天页 connect()，离开 disconnect()。
 * 断线自动重连（指数退避，最长 30 秒）。
 */
export class ApprovalGateway {
  private ws?: WebSocket;
  private readonly events: GatewayEvents;
  private readonly baseUrl: string;
  private deviceId = '';
  private token = '';
  /** /mgw/pair 返回的候选地址（用于挑一个能连的，见 pickUrl） */
  private endpoints?: string[];
  private publicUrl?: string;
  private closed = false;
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** 等特定帧的调用者（文件下载用） */
  private frameWaiters = new Map<
    string,
    Array<{
      match: (f: Record<string, unknown>) => boolean;
      resolve: (f: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();

  constructor(baseUrl: string, events: GatewayEvents) {
    this.baseUrl = baseUrl;
    this.events = events;
  }

  get url(): string {
    return this.pickUrl();
  }

  /**
   * 选一个能连的网关地址。
   *
   * ⚠️ 这里踩过坑：原来直接硬编码 `ws://<主机>:3081/ws/mobile`。
   * 在真机上 3081 很可能被 Windows 防火墙拦掉（而 3095 因为是
   * DSH 自己的端口，之前调试过所以放行了），结果网关一直 offline，
   * 审批只能显示「到电脑上确认」。
   *
   * `/mgw/pair` 返回的 endpoints 里其实同时给了两条路：
   *   ws://<host>:3095/ws/mobile   ← 走 DSH Web 端口（手机必然可达）
   *   ws://<host>:3081/ws/mobile   ← 网关直连
   * 还有几条是虚拟网卡地址（VMware 之类），手机根本连不到。
   *
   * 所以顺序是：
   *   1. 和 baseUrl 完全同源（host + port 都一致）的 endpoint —— 这是
   *      已经被验证可达的地址，最可靠；
   *   2. publicUrl；
   *   3. 和 baseUrl 同 host 的 endpoint（端口可能不同）；
   *   4. 退回硬编码 3081。
   */
  private pickUrl(): string {
    const eps = this.endpoints ?? [];
    try {
      const base = new URL(this.baseUrl);
      const wantHost = base.hostname;
      const wantPort = base.port || (base.protocol === 'https:' ? '443' : '80');

      // 1. 完全同源
      for (const e of eps) {
        try {
          const u = new URL(e);
          const port = u.port || (u.protocol === 'wss:' ? '443' : '80');
          if (u.hostname === wantHost && port === wantPort) return e;
        } catch {
          /* 跳过坏地址 */
        }
      }

      // 2. publicUrl
      if (this.publicUrl) return this.publicUrl;

      // 3. 同 host，端口不同
      for (const e of eps) {
        try {
          if (new URL(e).hostname === wantHost) return e;
        } catch {
          /* 跳过 */
        }
      }
    } catch {
      /* baseUrl 不合法，走兜底 */
    }

    // 4. 兜底：老的硬编码行为
    return gatewayUrlFrom(this.baseUrl);
  }

  /** 建立连接。没有设备 token 时自动申请配对码 */
  async connect(pairingCode?: string): Promise<void> {
    this.closed = false;
    this.deviceId = await ensureDeviceId();

    if (!this.token) {
      try {
        this.token = (await AsyncStorage.getItem(DEVICE_TOKEN_KEY)) || '';
      } catch {
        this.token = '';
      }
    }

    // 没 token 也没传配对码 → 向 DSH 申请一个
    //
    // 这一步之前缺了，导致网关永远连不上：connect() 只在「有 pairingCode」
    // 或「有已保存 token」时才连，而首次两者都没有，直接 return 了。
    // 用户看到的就是「审批无法在手机上回答」。
    //
    // POST /mgw/pair 用 App 现有的 cookie 鉴权，返回一次性配对码。
    if (!pairingCode && !this.token) {
      const paired = await this.requestPairingCode();
      pairingCode = paired?.pairingCode;
      // 顺手把地址列表存下来 —— 真机上 3081 常被防火墙拦，
      // 需要用 endpoints 里走 3095 的那条（见 pickUrl）
      this.endpoints = paired?.endpoints;
      this.publicUrl = paired?.publicUrl;
      if (!pairingCode) {
        this.events.onStatus?.('offline', '网关未开启');
        return;
      }
    }

    const url = this.url;
    if (!url) {
      this.events.onStatus?.('offline', '地址无效');
      return;
    }

    // 有 token 就用 token，否则用配对码
    const protocols = ['dsh-mobile-v1'];
    if (pairingCode) {
      protocols.push(`dsh-pair.${pairingCode}`);
    } else if (this.token) {
      protocols.push(`dsh-token.${this.token}`);
    } else {
      this.events.onStatus?.('offline', '需要配对码');
      return;
    }

    this.events.onStatus?.('connecting');
    try {
      // ⚠️ 这里必须带 `X-DSH-Device-ID` 请求头，否则服务端直接 400。
      //
      // 网关源码里是硬性要求的：
      //   if (!clientDeviceId) {
      //     log('pairing rejected: missing X-DSH-Device-ID (outdated client)')
      //     rejectUpgrade(socket, 400, ...)
      //   }
      // 而且它只认 header（query 里塞 deviceId 不认）——之前把 deviceId
      // 放查询串是错的，结果网关永远 offline，审批只能显示「到电脑上确认」。
      //
      // RN 的 WebSocket 构造函数有第三个参数可以传 headers（非标准但 RN 支持），
      // Android 端会逐个 addHeader。这是唯一能在 RN 里设置 WS 请求头的办法，
      // 不需要写原生模块。
      const TypeCtor = WebSocket as unknown as new (
        url: string,
        protocols?: string | string[],
        options?: { headers?: Record<string, string> },
      ) => WebSocket;
      const ws = new TypeCtor(url, protocols, {
        headers: { 'X-DSH-Device-ID': this.deviceId },
      });
      this.ws = ws;

      ws.onopen = () => {
        this.retry = 0;
        this.events.onStatus?.('online');
      };

      ws.onmessage = (ev: WebSocketMessageEvent) => {
        this.handleFrame(String(ev.data));
      };

      ws.onerror = () => {
        this.events.onStatus?.('offline', '连接失败');
      };

      ws.onclose = (ev: { code?: number; reason?: string }) => {
        this.ws = undefined;
        if (this.closed) return;
        // 把关闭码带出来 —— 400/401 的含义完全不同，排查时全靠它：
        //   400 = 缺 X-DSH-Device-ID 头（RN 没发出去）
        //   401 = 配对码无效/已用/过期，或设备 token 已失效
        const code = ev?.code ?? 0;
        const why = String(ev?.reason ?? '');
        this.events.onStatus?.(
          'offline',
          code ? `连接被关闭 ${code}${why ? ` ${why}` : ''}` : '连接已断开',
        );

        // ⚠️ 自愈：凭据失效时必须清掉本地 token 并重新配对。
        //
        // 踩坑：网关的配对是一次性的（服务端 claimPairing 里
        // `pairings.delete(codeHash)`，即使后续握手失败也算用掉），
        // 而 devices 注册表可能随网关重启而重置。
        // 如果本地存着一个已经失效的 token，connect() 会因为
        // 「有 token 就不配对」而一直拿它重试，永远 401 —— 用户看到
        // 的就是审批永远只能「到电脑上确认」。
        const unauthorized = /401|unauthorized|invalid|expired/i.test(why);
        if (unauthorized) {
          this.token = '';
          void AsyncStorage.removeItem(DEVICE_TOKEN_KEY).catch(() => undefined);
          // 不传旧配对码：让下次 connect() 重新申请一个新的
          this.scheduleRetry();
          return;
        }

        this.scheduleRetry(pairingCode);
      };
    } catch (e) {
      this.events.onStatus?.('offline', e instanceof Error ? e.message : '连接出错');
    }
  }

  /**
   * 向 DSH 申请一次性配对码。
   *
   * `POST /mgw/pair` 用 App 现有的 cookie 鉴权（和普通 RPC 一样的登录态），
   * 返回 `{ payload: { pairingCode, endpoints } }`。
   *
   * 失败返回 null —— 多半是移动网关没装或没开，
   * 由调用方显示「网关未开启」而不是当成错误。
   */
  private async requestPairingCode(): Promise<{
    pairingCode: string;
    endpoints?: string[];
    publicUrl?: string;
  } | null> {
    try {
      // 管理接口在 web server 端口上（不是网关的 3081）
      const base = this.baseUrl.replace(/\/+$/, '');
      const res = await fetch(`${base}/mgw/pair`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) return null;
      const j = (await res.json()) as {
        payload?: { pairingCode?: string; endpoints?: string[]; publicUrl?: string };
      };
      const code = j.payload?.pairingCode;
      if (!code) return null;
      return {
        pairingCode: code,
        endpoints: j.payload?.endpoints,
        publicUrl: j.payload?.publicUrl,
      };
    } catch {
      return null;
    }
  }

  /** 断线重连：指数退避，最长 30 秒 */
  private scheduleRetry(pairingCode?: string): void {
    if (this.closed) return;
    this.retry += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retry, 5));
    this.retryTimer = setTimeout(() => {
      void this.connect(pairingCode);
    }, delay);
  }

  /** 处理服务端帧 */
  private handleFrame(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    // 先给等待者（文件下载等）机会认领这一帧
    const kind = String(frame.kind ?? '');
    const waiters = this.frameWaiters.get(kind);
    if (waiters && waiters.length > 0) {
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const w = waiters[i];
        if (w.match(frame)) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
      }
    }

    if (kind === 'paired') {
      // 拿到长期 token，存下来，下次重连不用再配对
      const tok = String(frame.token ?? '');
      if (tok) {
        this.token = tok;
        void AsyncStorage.setItem(DEVICE_TOKEN_KEY, tok).catch(() => undefined);
      }
      return;
    }

    if (kind === 'approval-requested') {
      this.events.onApproval?.({
        rpcId: String(frame.rpcId ?? ''),
        sessionId: String(frame.sessionId ?? ''),
        approvalId: String(frame.approvalId ?? ''),
        toolName: String(frame.toolName ?? ''),
        reason: frame.reason === undefined ? undefined : String(frame.reason),
        displayReason:
          frame.displayReason && typeof frame.displayReason === 'object'
            ? (frame.displayReason as Record<string, string>)
            : undefined,
        replay: frame.replay === true,
      });
      return;
    }

    if (kind === 'approval-resolved') {
      this.events.onResolved?.(String(frame.rpcId ?? ''), String(frame.outcome ?? ''));
    }
  }

  /** 发一帧（文件下载等复用同一条连接） */
  send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('网关未连接');
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * 等一个满足条件的帧。
   *
   * 文件下载要按 kind + transferId + offset 精确匹配 —— 同一时间可能有
   * 多个下载在跑，帧会交错到达，光看 kind 会认错。
   */
  waitFor(
    kind: string,
    match: (f: Record<string, unknown>) => boolean,
    timeoutMs = 20000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const list = this.frameWaiters.get(kind) ?? [];
      const entry = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          const cur = this.frameWaiters.get(kind) ?? [];
          const i = cur.indexOf(entry);
          if (i >= 0) cur.splice(i, 1);
          reject(new Error(`等 ${kind} 超时`));
        }, timeoutMs),
      };
      list.push(entry);
      this.frameWaiters.set(kind, list);
    });
  }

  /** 回答一个审批 */
  respond(a: PendingApproval, outcome: ApprovalOutcome): boolean {    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'approval-response',
          rpcId: a.rpcId,
          sessionId: a.sessionId,
          approvalId: a.approvalId,
          outcome,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 主动断开，不再重连 */
  disconnect(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    try {
      this.ws?.close();
    } catch {
      /* 已经关了 */
    }
    this.ws = undefined;
  }

  get online(): boolean {
    return this.ws !== undefined && this.ws.readyState === 1;
  }
}

/** 清掉已保存的设备 token（重新配对时用） */
export async function forgetGatewayDevice(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    /* 忽略 */
  }
}
