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
 *   重连   子协议 ['dsh-mobile-v1', 'dsh-auth.<deviceToken>']
 *   收     {"kind":"approval-requested", rpcId, sessionId, approvalId, toolName, reason, displayReason, replay}
 *          {"kind":"approval-resolved",  rpcId, sessionId, approvalId, outcome}
 *   发     {"type":"approval-response", rpcId, sessionId, approvalId, outcome}
 *          outcome 只能是 allowed-once / rejected
 *
 * ## 三条不能违反的规则
 *
 * 1. **网络问题不能破坏授权状态**
 *    握手失败有太多与凭据无关的原因：切 Wi-Fi、进电梯、电脑休眠、
 *    DSH 重启、3081 被防火墙拦、代理抽风。这些情况下 token 完全有效，
 *    清掉是纯误伤 —— 而且清掉之后如果网络还没恢复，重新配对也拿不到码，
 *    整条链路停摆，用户必须重开 App。
 *    所以：**只有服务端明确说凭据不行，才清 token**。
 *
 * 2. **用户主动撤销后不得自动恢复**
 *    撤销后本地没有 token，但 Cookie 还在。如果 connect() 看到
 *    「没 token」就自动申请配对码，几秒内设备就又被授权了 ——
 *    用户的撤销决定被自己撤销掉。见 core/deviceRevocation.ts。
 *
 * 3. **旧连接的异步回调不得影响新连接**
 *    断线重连、切前后台、撤销后重连都会并发产生多个 WebSocket。
 *    每个连接带一个 generation，回调里先校验是不是当前连接，
 *    否则「旧连接迟到的 onclose」会把刚建好的新连接状态踩掉。
 */

import {
  CredentialKey,
  clearCredential,
  loadCredential,
  saveCredential,
} from './secureStore';

import {
  clearApprovalRevoked,
  getApprovalRevocationStatus,
  markApprovalRevoked,
} from './deviceRevocation';

import { readGatewayId, readServerDeviceId, saveServerBinding } from './serverIdentity';

import { redactUrl } from './net-security';

/** 网关默认端口（插件配置 lanPort） */
const GATEWAY_PORT = 3081;

/**
 * 服务端「设备被撤销」的关闭码。
 *
 * 插件 lib/index.mjs 里撤销设备时会：
 *   client.close(4003, 'device revoked')
 *
 * ⚠️ **4003 不等于「设备被撤销」**。真实插件把 4003 用在两个完全不同的场景：
 *
 *   client.close(4003, 'device revoked')        ← 撤销了这台设备（凭据作废）
 *   client.close(4003, 'authentication enabled') ← 管理界面把鉴权开关打开了，
 *                                                  踢掉的是**没带凭据**的连接
 *
 * 第二个场景和「这台设备被撤销」毫无关系：它是 Debug 模式下无凭证连接
 * 被清理，或者服务端重新开启鉴权。把这种情况也当成「设备被撤销」，
 * 会在服务端**没有**删掉设备记录的情况下永久停掉自动配对 ——
 * 用户必须手动重新授权才能恢复，而服务端那条记录一直有效。
 *
 * 所以必须按 reason 区分。见 isDeviceRevokedClose()。
 */
const CLOSE_DEVICE_REVOKED = 4003;

/**
 * 判断 4003 的关闭是不是「设备被撤销」。
 *
 * 服务端 reason 只有两种（见插件源码）：
 *   'device revoked'        → 真的撤销了
 *   'authentication enabled' → 鉴权开关变化，设备记录还在
 *
 * 判定原则：只有**明确**是 device revoked 才算撤销。
 * 其它（含拿不到 reason、未来新增的 4003 用途）一律按「未知原因」处理 ——
 * 保留凭据、继续退避重连，而不是永久停掉用户的审批功能。
 *
 * 这个方向的保守是刻意的：
 *   · 误判成「已撤销」→ 用户失去审批功能，且服务端记录还在（不一致）
 *   · 误判成「普通断开」→ 最多多连几次，服务端仍会用 4003 拒绝我们
 */
export function isDeviceRevokedClose(code: number, reason: string): boolean {
  if (code !== CLOSE_DEVICE_REVOKED) return false;
  // 归一化后精确匹配，避免 'not device revoked' 之类被 startsWith 放进来
  return /(^|\s)device\s+revoked(\s|$)/i.test(reason.trim());
}

/**
 * 连续申请配对码的次数上限。
 *
 * 防止「拿不到码 → 重试 → 还是拿不到」无限循环打服务端。
 * 超过后停止自动配对，只保留退避重连（等用户手动干预）。
 * 成功连上（onopen）会重置为 0。
 */
const MAX_PAIRING_ATTEMPTS = 3;

/**
 * 连续申请配对码达到上限后的冷却时间。
 *
 * 到这个阶段说明「网关确实起不来」（插件没装 / 没开 / 网络长期不通）。
 * 此时既不能无限打服务端，也不能永久停摆 —— 用一个长间隔的慢速重试，
 * 让网络恢复后仍能自己好起来。
 */
const PAIRING_COOLDOWN_MS = 60_000;

/**
 * 「授权状态未知」时的重试间隔。
 *
 * 撤销标记读不出来时不能自动配对（fail-closed），但也不能永久停摆 ——
 * 存储故障通常是暂时的（磁盘满被清理、进程被杀在写入中途、系统正在
 * 压缩数据库）。用一个中等间隔重试：比正常退避慢（别为了一次 IO 抖动
 * 就打服务端），但比配对码冷却快（存储恢复后要能及时连回来）。
 */
const REVOCATION_UNKNOWN_RETRY_MS = 15_000;

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

/** 网关连接状态 */
export type GatewayStatus =
  | 'idle'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'revoked'
  /**
   * 授权状态未知：读不到撤销标记（存储故障 / 数据损坏）。
   *
   * 和 `revoked` 分开是为了让界面能说清楚「是撤销了」还是「暂时确认不了」——
   * 前者要用户主动重新授权，后者通常等一下就好。
   * 两者都**禁止**自动配对。
   */
  | 'unknown';

export interface GatewayEvents {
  /** 连接状态变化 */
  onStatus?: (status: GatewayStatus, detail?: string) => void;
  /** 来了一个待审批 */
  onApproval?: (a: PendingApproval) => void;
  /** 审批已决（可能是本机回的，也可能是别的设备/WebUI 回的） */
  onResolved?: (rpcId: string, outcome: string) => void;
}

/** 从 baseUrl 里取出主机名，拼出网关地址 */
export function gatewayUrlFrom(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${u.hostname}:${GATEWAY_PORT}/ws/mobile`;
  } catch {
    return '';
  }
}

/**
 * 生成/读取稳定的设备 id（存 Keystore，和 token 一起被 clearAllCredentials 清掉）
 */
async function ensureDeviceId(): Promise<string> {
  try {
    const saved = await loadCredential(CredentialKey.gatewayDeviceId);
    if (saved) return saved;
  } catch {
    /* 读不到就重新生成 */
  }
  const id = `dsh-outpost-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await saveCredential(CredentialKey.gatewayDeviceId, id);
  } catch {
    /* 存不了也无所谓，本次会话内有效 */
  }
  return id;
}

/**
 * 判断关闭原因里是否**明确**表示凭据被拒。
 *
 * 数据来源（不要假设 RN 能稳定拿到 HTTP 状态码 —— 它拿不到）：
 *
 *   · Android okhttp 握手失败时，RN 会把异常消息塞进 close reason，
 *     形如 `Expected HTTP 101 response but was '401 Unauthorized'`。
 *     见 react-native/Libraries/WebSocket/WebSocket.js：
 *     `websocketFailed` → `CloseEvent('close', { code: 1006, reason: ev.message })`。
 *   · iOS 上 reason 可能是空的 —— 所以 onerror 里也存一份（lastErrorText）。
 *
 * ## 为什么只认 401，不认 403
 *
 * 这一条是**照着真实网关源码核对**的（dsh-plugin-mobile-gateway 0.10.3
 * lib/index.mjs 的 rejectUpgrade 调用点）：
 *
 *   · 凭据缺失 / 无效 / 过期 → `rejectUpgrade(socket, 401, 'missing or invalid device credential')`
 *   · 配对码无效或已用过     → `rejectUpgrade(socket, 401, 'invalid or expired pairing code')`
 *   · 网关未开启             → `rejectUpgrade(socket, 503, 'mobile gateway is disabled')`
 *   · 缺少 X-DSH-Device-ID   → `rejectUpgrade(socket, 400, ...)`
 *
 * 而 403 只出现在这些地方，**全都与设备凭据无关**：
 *
 *   · 管理接口 loopback-only
 *   · 跨源管理请求（CSRF）
 *   · Web restart / stop 的 loopback 限制
 *   · 局域网监听只接受私网地址（`LAN listener accepts private-network clients only`）
 *   · 无效的 WebSocket 路径
 *
 * 也就是说：**真实的设备凭据失效只会以 401 出现，永远不会是 403**。
 * 把 403 当成「凭据失效」，会让下面这个真实场景误删有效 token：
 *
 *   手机从公司网络 / 移动网络接入，源地址不是私网
 *   → 局域网监听回 403 'LAN listener accepts private-network clients only'
 *   → 客户端看到 "403 Forbidden" → 以为 token 失效 → 删掉它
 *   → 换回家里 Wi-Fi 时，本来有效的凭据已经没了，必须重新扫码。
 *
 * 这正是「网络连接失败 ≠ 认证凭据失效」。
 *
 * ⚠️ 也不要把 timeout / ECONNREFUSED / 1006 / 'Network request failed'
 * 算进来 —— 那是「断网误清 token」的老 bug。
 */
export function isCredentialRejection(text: string): boolean {
  if (!text) return false;

  // 401 是唯一由网关用来表达「凭据不对」的 HTTP 码。
  // 前后不能紧邻数字（避免匹配到端口号、时间戳、ECONNREFUSED 127.0.0.1:4011）。
  if (/(^|[^0-9])401([^0-9]|$)/.test(text)) return true;

  // 网关 401 的正文 / close reason 用词（见上面 rejectUpgrade 的调用点）。
  // 这些词只会出现在「凭据不对」的语境里。
  return /unauthorized|missing or invalid device credential|invalid device credential|invalid or expired (?:token|pairing code)|token (?:is )?(?:invalid|expired)/i.test(
    text,
  );
}

/**
 * 审批网关连接。
 *
 * 生命周期由调用方控制：App 挂载时 connect()，卸载时 disconnect()。
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
  /**
   * 连接代次。
   *
   * 每次真正新建 WebSocket 就 +1；回调里先比对，不匹配就忽略 ——
   * 这样「旧连接迟到的 onclose/onerror」不会污染新连接。
   * 也是「撤销授权和自动重连同时发生」时不出错的关键。
   */
  private generation = 0;
  /**
   * 是否有一次 connect 正在 await 途中。
   *
   * 防止并发 connect()：`connect()` 里有一串 await，期间 `this.ws`
   * 还是空的，第二个调用会以为「没连」而再建一条。
   */
  private connecting = false;
  /**
   * 当前占着 `connecting` 标记的那一代（0 = 没人占）。
   *
   * `finally` 里靠它判断「该不该由我来放开标记」——
   * 否则旧 connect 醒来时会把新 connect 的标记一起清掉。
   */
  private connectOwner = 0;
  /** 上一次连接错误的消息（用于判断是否鉴权失败） */
  private lastErrorText = '';
  /**
   * 当前这条连接是用**配对码**建立的（而不是长期 token）。
   *
   * 用途：配对码被拒（一次性码已用过/过期）时服务端也回 401，
   * 那种情况下要清的是「这次配对尝试」，**不能**去清已经存好的
   * 长期 token —— 那是另一份凭据。
   */
  private usedPairingCode = false;
  /** 连续申请配对码的次数（见 MAX_PAIRING_ATTEMPTS） */
  private pairingAttempts = 0;
  /**
   * 诊断计数：连续握手失败次数。
   *
   * ⚠️ **只用于状态提示，绝不用于判定 token 失效**。
   * 之前就是拿它当判据（>= 2 就清 token），断网 30 秒即误删有效凭据。
   */
  private consecutiveFailures = 0;
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

  /** 这个网关实例连向哪个服务地址（store 用它判断要不要重建实例） */
  get serviceUrl(): string {
    return this.baseUrl;
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

  /**
   * 建立连接。
   *
   * @param pairingCode 用户主动提供的配对码（扫码/粘贴）。传了就一定用它配对，
   *                    并清除「已撤销」标记 —— 这是用户的明确授权动作。
   */
  async connect(pairingCode?: string): Promise<void> {
    if (pairingCode) {
      // 用户主动配对 = 明确重新授权。先解掉撤销标记再连。
      await clearApprovalRevoked();
    }
    this.closed = false;

    // 已经有连接在跑（CONNECTING/OPEN）或已排了重试 → 不重复建。
    // 切前后台、store 重建、页面重进都会调用 connect()，
    // 不去重的话会同时挂好几条 WS，服务端看到多台「设备」，
    // 撤销时也容易踩到旧连接。
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

    // ⚠️ 并发保护。
    //
    // connect() 里有一串 await（读 deviceId / 读 token / 查撤销标记 /
    // 申请配对码），期间如果又有人调 connect()，两个调用都会通过上面
    // 的 `this.ws` 检查（那时还没建 ws），于是各建一条连接。
    // 结果是服务端看到两条「同一台设备」的连接，撤销时只踢掉一条。
    //
    // 用代次 + 在途标记双重兜底：后进来的调用直接返回，
    // 由前一个调用负责把连接建起来。
    if (this.connecting) return;
    this.connecting = true;

    // 在**入口**就占一代。这样 disconnect()（会把 generation +1）
    // 能立刻让这次还在 await 中的 connect 作废 —— 否则「用户在
    // 加载过程中点了断开」会被随后的建连动作覆盖掉。
    const generation = ++this.generation;
    // 记录「这次 connect 占着在途标记」，finally 里只清自己的那一份 ——
    // 否则旧 connect 醒来时会把新 connect 的标记一起清掉。
    this.connectOwner = generation;

    /** 这次 connect 是否还有效（没被 disconnect / 更新的 connect 取代） */
    const stillValid = () => !this.closed && generation === this.generation;

    try {
      this.deviceId = await ensureDeviceId();
      if (!stillValid()) return;

      // ── 用户撤销过 / 撤销状态未知 → 绝不自动配对 ─────────────
      //
      // 这是 P0 的核心：撤销后本地没有 token，而 Cookie 通常还有效。
      // 如果这里放行，connect() 会申请配对码 → 配对成功 → 设备重新获得
      // 审批权限。用户点的那下「撤销」等于没生效。
      //
      // ⚠️ 判据是三态，不是布尔值：
      //
      //   revoked     → 用户明确撤销过，禁止自动配对
      //   unknown     → 读不到 / 数据损坏 / 存储不可用，**同样禁止**
      //   not-revoked → 确认没撤销过，才允许自动配对
      //
      // `unknown` 必须和 `revoked` 一样拦下来。把它当成「未撤销」是一个
      // fail-open：用户撤销自己时如果服务端撤销失败（serverOk=false），
      // 本地标记就是**唯一**屏障 —— 而那种情况下不会有 4003 来兜底，
      // 因为服务端根本没删掉那条记录。屏障一失效，设备就静默重新获得
      // 了审批权限。
      //
      // 只有用户再次主动配对（传 pairingCode，或走 reauthorize()）才解禁。
      if (!pairingCode) {
        const revocation = await getApprovalRevocationStatus();
        if (revocation === 'revoked') {
          this.events.onStatus?.('revoked', '审批授权已撤销，需要重新授权');
          return;
        }
        if (revocation === 'unknown') {
          // 状态未知 ≠ 授权有效。
          //
          // 这里**不清**任何凭据，也**不**置撤销标记 —— 存储里可能明明
          // 有标记，只是这次读不到。等存储恢复后自然能读到。
          //
          // 用慢速通道重试而不是高频轮询：存储故障通常不会在几百毫秒内
          // 自愈，但也必须能自己好起来（要求 5：存储恢复后允许重新读取）。
          this.events.onStatus?.('unknown', '授权状态暂时无法确认，稍后自动重试');
          this.scheduleRetry(REVOCATION_UNKNOWN_RETRY_MS);
          return;
        }
      }
      if (!stillValid()) return;

      if (!this.token) {
        try {
          this.token = (await loadCredential(CredentialKey.gatewayToken)) || '';
        } catch {
          this.token = '';
        }
      }
      if (!stillValid()) return;

      // 没 token 也没传配对码 → 向 DSH 申请一个
      //
      // 这一步之前缺了，导致网关永远连不上：connect() 只在「有 pairingCode」
      // 或「有已保存 token」时才连，而首次两者都没有，直接 return 了。
      // 用户看到的就是「审批无法在手机上回答」。
      //
      // POST /mgw/pair 用 App 现有的 cookie 鉴权，返回一次性配对码。
      if (!pairingCode && !this.token) {
        if (this.pairingAttempts >= MAX_PAIRING_ATTEMPTS) {
          // ⚠️ 不能直接 return —— 那样网络恢复后这条链路就永久停摆了
          // （必须重开 App 才能好，这正是用户报过的症状）。
          //
          // 正确做法：退到**慢速通道**。不再连着打服务端，但保留一个
          // 长间隔重试；下次重试时重置计数，允许再试一小轮。
          // 净效果：最多 3 次/分钟，既不刷服务端，也不会永久卡死。
          this.events.onStatus?.('offline', '网关暂时不可用，稍后自动重试');
          this.pairingAttempts = 0;
          this.scheduleRetry(PAIRING_COOLDOWN_MS);
          return;
        }
        this.pairingAttempts += 1;
        const paired = await this.requestPairingCode();
        if (!stillValid()) return;
        pairingCode = paired?.pairingCode;
        // 顺手把地址列表存下来 —— 真机上 3081 常被防火墙拦，
        // 需要用 endpoints 里走 3095 的那条（见 pickUrl）
        this.endpoints = paired?.endpoints;
        this.publicUrl = paired?.publicUrl;
        if (!pairingCode) {
          // ⚠️ 这里**必须继续重试**，不能直接 return。
          //
          // 之前的写法是 `onStatus('offline'); return;` —— 断网时
          // requestPairingCode() 拿不到码，整条链路就此停摆，
          // 网络恢复后也不会自己好，必须重开 App。
          // 用户报的「审批通道一直是灰的」有一部分就是这个。
          this.events.onStatus?.('offline', '网关暂时不可用，稍后自动重试');
          this.scheduleRetry();
          return;
        }
      }

      const url = this.url;
      if (!url) {
        this.events.onStatus?.('offline', '地址无效');
        return;
      }

      // 有 token 就用 token，否则用配对码
      //
      // ⚠️ token 的子协议是 `dsh-auth.`，不是 `dsh-token.`。
      // 插件 extractCredential() 只认 dsh-auth. / dsh-pair.：
      //   if (protocol.startsWith('dsh-auth.')) return { kind: 'token', ... }
      // 写错的话服务端认为「没带凭据」→ 401 → 客户端以为是 token 失效
      // → 清 token 重新配对。表现就是「每次断线都掉审批权限」。
      const protocols = ['dsh-mobile-v1'];
      if (pairingCode) {
        protocols.push(`dsh-pair.${pairingCode}`);
      } else if (this.token) {
        protocols.push(`dsh-auth.${this.token}`);
      } else {
        this.events.onStatus?.('offline', '需要配对码');
        return;
      }

      if (!stillValid()) return;

      this.events.onStatus?.('connecting');
      this.lastErrorText = '';
      try {
        this.openSocket(url, protocols, generation);
      } catch (e) {
        if (generation !== this.generation) return;
        this.events.onStatus?.('offline', e instanceof Error ? e.message : '连接出错');
        this.scheduleRetry();
      }
    } finally {
      // 无论走哪个分支（成功建连 / 撤销拦住 / 申请码失败 / 抛错），
      // 都要放开在途标记，否则后续 connect() 会被永久挡住。
      //
      // ⚠️ 只清**自己这一代**的标记：如果期间已经有一次新的 connect()
      // 接管了（connectOwner 变了），说明标记归它管，不能在这里清掉。
      if (this.connectOwner === generation) {
        this.connecting = false;
        this.connectOwner = 0;
      }
    }
  }

  /**
   * 真正建 WebSocket 并挂回调。
   *
   * 抽出来是为了让 connect() 的流程（读凭据 → 判断授权 → 申请配对码）
   * 保持线性可读，而不是所有东西挤在一个 try 里。
   *
   * @param generation 本次连接属于第几代，回调里用它丢弃旧连接的事件
   */
  private openSocket(url: string, protocols: string[], generation: number): void {
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
    this.usedPairingCode = protocols.some((p) => p.startsWith('dsh-pair.'));

    /** 这个回调是否属于当前这一代连接 */
    const isCurrent = () => generation === this.generation && this.ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      this.retry = 0;
      this.consecutiveFailures = 0;
      this.pairingAttempts = 0;
      this.lastErrorText = '';
      this.events.onStatus?.('online');
    };

    ws.onmessage = (ev: WebSocketMessageEvent) => {
      if (!isCurrent()) return;
      this.handleFrame(String(ev.data));
    };

    ws.onerror = (ev: Event) => {
      if (!isCurrent()) return;
      // Android 的握手失败会把 okhttp 的异常消息带进来
      // （形如 `Expected HTTP 101 response but was '401 Unauthorized'`），
      // 这是判断「服务端明确拒了我们」的重要线索，先存下来。
      // 脱敏后再用：理论上它不该含凭据，但显示到界面之前一律过一遍。
      const msg = (ev as { message?: unknown })?.message;
      if (typeof msg === 'string' && msg) {
        this.lastErrorText = redactUrl(msg);
      }
      this.events.onStatus?.('offline', '连接失败');
    };

    // ── 握手被拒（401/403/404…）─────────────────────────────────
    //
    // ⚠️ 这是一个**真实的跨平台差异**，也是「失效 token 不自愈」的根因：
    //
    //   · RN 的 WebSocket（Android okhttp / iOS）→ 握手失败走 `onerror`，
    //     message 里带 `Expected HTTP 101 response but was '401 Unauthorized'`，
    //     随后还会触发 `onclose`
    //   · Node 的 `ws` 库 → 握手失败**既不触发 error 也不触发 close**，
    //     只发一个独立的 `unexpected-response` 事件，然后连接就结束了
    //
    // 我们的测试跑在 Node 上（`ws` 替身）。只监听 onerror/onclose 时，
    // 401 这条路径在测试里**永远走不到清理分支**：
    // `lastErrorText` 一直是空 → `isCredentialRejection('')` 为 false →
    // 保留那个已经失效的 token → 反复重连 → 最终超时。
    //
    // 表现就是 `gateway-recovery-spec` 的「失效 token 自愈」偶发失败。
    //
    // ## 为什么这里不能只记错误文本再 close()
    //
    // 实测（ws 8.x）：401 时事件序列只有 `unexpected-response`，
    // **不会再有 `close`**。而在握手失败后调用 `ws.close()` 也不会
    // 产生新的 close 事件 —— 连接从来没建立起来。
    //
    // 所以「记文本 → close → 让 onclose 统一处理」这条路是走不通的。
    // 必须在 `unexpected-response` 里**直接把凭据失效这一支处理掉**，
    // 与 onclose 里的逻辑保持一致（清 token → 通知 → 安排重试）。
    //
    // 真机上没有这个事件，这段不会执行，生产行为不变。
    const wsWithUnexpected = ws as unknown as {
      on?: (
        event: string,
        cb: (req: unknown, res: { statusCode?: number; statusMessage?: string }) => void,
      ) => void;
      removeListener?: (event: string, cb: (...args: never[]) => void) => void;
    };
    wsWithUnexpected.on?.(
      'unexpected-response',
      (_req, res: { statusCode?: number; statusMessage?: string }) => {
        if (!isCurrent()) return;
        const code = typeof res?.statusCode === 'number' ? res.statusCode : 0;
        const text = String(res?.statusMessage ?? '');
        // 记成 `HTTP 401 Unauthorized`，让 isCredentialRejection 的
        // 401 数字判据与 unauthorized 词汇判据都能命中（保留给后续判断用）。
        if (code) {
          this.lastErrorText = redactUrl(`HTTP ${code}${text ? ` ${text}` : ''}`);
        }

        // 这条连接已经废了，先解除引用，避免后续回调误判为当前连接
        this.ws = undefined;

        const combined = `${text} ${this.lastErrorText}`.trim();

        // 与 onclose 同源：只有「带 token 且不是刚用配对码」时才谈得上失效
        if (this.token && !this.usedPairingCode && isCredentialRejection(combined)) {
          this.token = '';
          this.consecutiveFailures = 0;
          void clearCredential(CredentialKey.gatewayToken).catch(() => undefined);
          this.events.onStatus?.('offline', '配对凭据已失效，正在重新配对');
          this.scheduleRetry();
          return;
        }

        // 其它握手失败（403/404/5xx）：按普通离线处理，**保留 token**
        // —— 这类错误与凭据有效性无关（见 isCredentialRejection 的注释）。
        this.consecutiveFailures += 1;
        this.events.onStatus?.(
          'offline',
          code ? `连接被拒绝（HTTP ${code}）` : '连接被拒绝',
        );
        this.scheduleRetry();
      },
    );

    ws.onclose = (ev: { code?: number; reason?: string }) => {
      if (!isCurrent()) return; // 旧连接的迟到回调，忽略
      this.ws = undefined;

      const code = ev?.code ?? 0;
      // 服务端的 close reason 会拼进用户可见的提示里。
      // 理论上它只写「invalid or expired pairing code」这类文本，
      // 但万一哪天带上了凭据，就会直接显示在界面上 —— 先脱敏再拼。
      const why = redactUrl(String(ev?.reason ?? ''));
      const combined = `${why} ${this.lastErrorText}`.trim();

      // 主动断开（disconnect）不触发任何状态/重连
      if (this.closed) {
        this.events.onStatus?.('idle');
        return;
      }

      // ── 4003：服务端用这个码表示两件不同的事 ─────────────────
      //
      //   'device revoked'         → 授权被作废（最强信号，必须停）
      //   'authentication enabled' → 鉴权开关变化，设备记录还在
      //
      // 只有前者能触发「置撤销标记 + 停自动重连」。后者是普通断开：
      // 保留 token、继续退避重连（用户可能只是切了下 Debug 开关）。
      //
      // ⚠️ 拿不到 reason 时按普通断开处理，不按撤销处理 ——
      // 撤销是破坏性结论（会清凭据、要用户手动重新授权），
      // 不能在证据不足时下。
      if (isDeviceRevokedClose(code, why)) {
        this.events.onStatus?.('revoked', '这台设备的审批授权已被撤销');
        this.token = '';
        this.pairingAttempts = 0;
        // 标记 + 清 Keystore/明文副本。失败也继续（内存里已经不重连了）。
        void markApprovalRevoked('server-revoked').catch(() => undefined);
        return; // 不再 scheduleRetry —— 撤销后自动重连等于自愈成未授权
      }

      // 4003 但不是 device revoked（鉴权开关变化 / reason 缺失）
      if (code === CLOSE_DEVICE_REVOKED) {
        this.consecutiveFailures += 1;
        this.events.onStatus?.('offline', '连接被服务端关闭（鉴权设置变化），稍后重试');
        this.scheduleRetry();
        return;
      }

      // ── 服务端明确拒绝凭据 → 清 token，重新配对 ─────────────
      //
      // 判据只有「明确的鉴权词汇」（401/403/unauthorized/...）。
      // 不看失败次数 —— 次数永远不能证明凭据失效。
      if (this.token && !this.usedPairingCode && isCredentialRejection(combined)) {
        this.token = '';
        this.consecutiveFailures = 0;
        void clearCredential(CredentialKey.gatewayToken).catch(() => undefined);
        this.events.onStatus?.('offline', '配对凭据已失效，正在重新配对');
        this.scheduleRetry();
        return;
      }

      // ── 其它情况：网络/服务端不可达，**保留 token** ──────────
      //
      // 切 Wi-Fi、进电梯、电脑休眠、DSH 重启、3081 被防火墙拦、
      // 代理异常 —— 全部走这里。token 是有效的，动它才是 bug。
      this.consecutiveFailures += 1;
      this.events.onStatus?.(
        'offline',
        code ? `连接被关闭 ${code}${why ? ` ${why}` : ''}` : '连接已断开',
      );

      // ⚠️ 重连时**绝不能复用配对码**。
      //
      // 配对码是一次性的（服务端配对成功立刻 delete），拿旧码重连
      // 必然 401 —— 这正是「断线后再也连不回来」的根因。
      //
      // 正确做法：不传参数，让 connect() 自己决定 ——
      // 有 token 就用 `dsh-auth.` 子协议，没 token 才重新申请配对码。
      this.scheduleRetry();
    };
  }

  /**
   * 用户主动重新授权审批。
   *
   * 和 connect() 的区别：这个**先解掉「已撤销」标记**，属于用户明确动作。
   * 只应该由 UI 上「重新授权」按钮、或扫码配对成功调用。
   *
   * @param pairingCode 用户提供的配对码；不传则自动向服务端申请
   */
  async reauthorize(pairingCode?: string): Promise<void> {
    await clearApprovalRevoked();
    this.token = '';
    this.pairingAttempts = 0;
    this.retry = 0;
    this.disconnect();
    await this.connect(pairingCode);
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let res: Response;
      try {
        res = await fetch(`${base}/mgw/pair`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
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

  /**
   * 断线重连：指数退避，最长 30 秒。
   *
   * 上限 30 秒是刻意的：
   *   · 太短（1 秒）在服务端长时间不可用时会打出大量握手，
   *     耗电、耗连接、日志刷屏；
   *   · 太长（几分钟）用户网络恢复后要等太久。
   *
   * @param overrideMs 指定延迟（用于「配对码拿不到」时的慢速通道），
   *                   不传则按退避序列算
   */
  private scheduleRetry(overrideMs?: number): void {
    if (this.closed) return;
    this.retry += 1;
    const delay =
      typeof overrideMs === 'number'
        ? overrideMs
        : Math.min(30_000, 1000 * 2 ** Math.min(this.retry, 5));
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  /**
   * 从 paired / hello 帧里记下「本机在这台服务器上的身份」。
   *
   * 存两样东西，缺一不可：
   *
   *   1. `gatewayServerDeviceId` —— 服务端注册表主键（UUID），撤销时用它
   *   2. `gatewayServerBinding`  —— **这个 UUID 属于哪台服务器**
   *      （`{ baseUrl, gatewayId, deviceId }`）
   *
   * ## 为什么必须一起存（P1-1）
   *
   * 只存 UUID 的话，它就是个全局凭据。用户换服务器（电脑 A → 电脑 B）、
   * 或者 A 重装插件导致注册表重建之后，旧 UUID 打过去会得到 404，
   * 而 404 会被上层解释成「本来就没有」→ 用户看到「撤销成功」，
   * 实际新服务器上这台设备的授权还在。
   *
   * 真实插件的 paired/hello 帧都带 `gatewayId`
   * （`...gatewayIdentity` = `{ gatewayId, gatewayName }`），
   * 所以「UUID 属于哪台服务器」是**能被真实验证**的，不需要猜。
   *
   * ⚠️ 别用 `gatewayInstanceId`：那个每次进程启动都重新生成，
   * 拿它当身份会导致每次重启都误判成「换了服务器」。
   *
   * @param frame paired 或 hello 帧
   */
  private async rememberServerDevice(frame: Record<string, unknown>): Promise<void> {
    const serverId = readServerDeviceId(frame);
    if (!serverId) return;
    try {
      await saveCredential(CredentialKey.gatewayServerDeviceId, serverId);
    } catch {
      // 存不下 device id 不阻塞连接：撤销时会退回「列表里找自己」
      return;
    }
    // 绑定写失败也不阻塞连接，但它会让撤销退化成「身份无法确认」
    // （404 不会被当成成功）—— 安全方向是对的，只是需要用户去电脑上确认。
    await saveServerBinding({
      baseUrl: this.baseUrl,
      gatewayId: readGatewayId(frame),
      deviceId: serverId,
    }).catch(() => false);
  }

  /** 处理服务端帧 */
  private handleFrame(raw: string): void {    let frame: Record<string, unknown>;
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
        this.pairingAttempts = 0;
        void saveCredential(CredentialKey.gatewayToken, tok).catch(() => undefined);
      }
      // 顺手记下**服务端**的 device id（UUID）。
      //
      // 真实插件的 paired 帧带 `device: { id, name, createdAt, ... }`，
      // 这个 id 是服务端注册表的主键，撤销时必须用它。
      //
      // 之前没存，导致「撤销这台手机」只能拿客户端标识
      // （dsh-outpost-xxx）去列表里找自己 —— 而列表不返回客户端标识，
      // 于是永远找不到 → revokeOwnDevice 返回 already-gone →
      // 上层当成撤销成功，实际服务端记录还在。
      void this.rememberServerDevice(frame);
      return;
    }

    if (kind === 'hello') {
      // hello 也带 device.id（重连时不再发 paired，只有 hello）。
      // 没有它，老用户重连后仍然不知道自己的服务端 id。
      void this.rememberServerDevice(frame);
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
  respond(a: PendingApproval, outcome: ApprovalOutcome): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
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

  /**
   * 主动断开，不再重连。
   *
   * 注意：这是「本次不用了」，**不改变授权状态** ——
   * 下次 connect() 仍然会用已保存的 token 连回来。
   */
  disconnect(): void {
    this.closed = true;
    // 代次 +1：让所有在途连接的回调失效
    this.generation += 1;
    // ⚠️ 必须放开在途标记。
    //
    // disconnect() 会让在途 connect() 的后续 stillValid() 全部失败并
    // return，那个 connect 的 finally 也会把 connecting 置 false ——
    // 但如果此刻正卡在 ensureDeviceId()/loadCredential() 的 await 里，
    // 要等它醒来才放开。期间任何 connect()/reauthorize() 都会命中
    // `if (this.connecting) return` **静默什么都不做**。
    //
    // 用户看到的就是：点「重新授权」→ 撤销标记已经清了 → 但永远连不上，
    // 必须重开 App。这里提前放开，让新的调用能立刻开始。
    this.connecting = false;
    this.connectOwner = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close();
    } catch {
      /* 已经关了 */
    }
    // 等在途的帧请求失败收尾，避免调用方挂到超时
    for (const [, list] of this.frameWaiters) {
      for (const w of list) {
        clearTimeout(w.timer);
        w.reject(new Error('网关已断开'));
      }
    }
    this.frameWaiters.clear();
  }

  get online(): boolean {
    return this.ws !== undefined && this.ws.readyState === 1;
  }

  /** 当前是否持有设备 token（测试与诊断用） */
  get deviceToken(): string {
    return this.token;
  }

  /** 连续握手失败次数（仅诊断） */
  get failures(): number {
    return this.consecutiveFailures;
  }
}

/** 清掉已保存的设备 token（重新配对时用） */
export async function forgetGatewayDevice(): Promise<void> {
  try {
    await clearCredential(CredentialKey.gatewayToken);
  } catch {
    /* 忽略 */
  }
}
