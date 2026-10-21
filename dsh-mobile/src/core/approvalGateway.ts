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
  const id = `dsh-pocket-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
      pairingCode = (await this.requestPairingCode()) ?? undefined;
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
      // RN 的 WebSocket 只接受 (url, protocols?) —— 没有第三参数，
      // 所以设备 id 走查询串（协议文档允许 `?pairingCode=`，同理可用其他参数）。
      const fullUrl = `${url}?deviceId=${encodeURIComponent(this.deviceId)}`;
      const ws = new WebSocket(fullUrl, protocols);
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

      ws.onclose = () => {
        this.ws = undefined;
        if (this.closed) return;
        this.events.onStatus?.('offline');
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
  private async requestPairingCode(): Promise<string | null> {
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
      const j = (await res.json()) as { payload?: { pairingCode?: string } };
      return j.payload?.pairingCode ?? null;
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
