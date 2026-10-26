/**
 * 会话状态管理。
 *
 * 设计原则：
 * - 事件流是唯一事实来源，turn 模型由 fold 派生
 * - 增量事件到达时重新 fold（数据量小，简单可靠）
 * - 网络/流断开时保留已有数据，标记状态，不丢内容
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DshConnection, StreamHandle } from '../core/transport';
import { PROBE_TIMEOUT_MS } from '../core/transport';
import { SessionApi, groupByWorkspace, readStatus } from '../core/rpc/session';
import { ModelApi } from '../core/rpc/model';
import { AccountApi, type BalanceResult } from '../core/rpc/account';
import { UploadApi } from '../core/rpc/upload';
import { WorkspaceApi } from '../core/rpc/workspace';
import { DirectoryPickerApi } from '../core/rpc/directory';
import type { WorkspaceCustom } from '../core/workspace-custom';
import { foldEvents, toChatItems, isInjectedMessage, stripModeTag, type ChatItem, type Turn } from '../core/fold';
import { notifyDone } from '../core/notify';
import { buildCompatReport, classifyError } from '../core/protocol';
import { isRetryable, RpcError } from '../core/rpc-error';
import type { NoticeItem, NoticeKind } from '../components/NoticeHost';
import {
  ApprovalGateway,
  type ApprovalOutcome,
  type GatewayStatus,
  type PendingApproval,
} from '../core/approvalGateway';
import {
  markApprovalRevoked,
  type RevocationPersistResult,
  type RevocationStatus,
} from '../core/deviceRevocation';

/** 已归档会话 id 的存储 key（DSH 不返回归档状态，只能客户端自己记） */
const ARCHIVED_KEY = '@dsh/archivedSessions';
import type { AttachRef, AgentTeam, EventRecord, PromptPart, SessionAddress, SessionSummary } from '../core/types';

/** 待发送附件：本地显示用 ref + 真正发出去的 part */
/** Promise 超时包装：超过 ms 就抛 Error('timeout') */
/**
 * emit 的节流窗口（毫秒）。
 *
 * 60ms ≈ 16fps，人眼已经看不出延迟，但比「每个 token 都渲染」
 * 少了一个数量级的重渲染。具体取舍见 emit() 的注释。
 */
const EMIT_THROTTLE_MS = 60;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

export interface OutgoingAttachment {
  ref: AttachRef;
  part: PromptPart;
}

/** 一次性提示（目前用于「任务完成」） */
export interface TeamNotice {
  id: string;
  text: string;
  time: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

export interface ChatState {
  sessionId: string;
  items: ChatItem[];
  turns: Turn[];
  running: boolean;
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  error?: string;
  title: string | null;
  contextRatio: number;
  contextUsed: number;
  contextWindow: number;
  model: string | null;
  provider: string | null;
  /** 思考强度（off/low/high/max 之类），没有就是模型不支持 */
  reasoningEffort: string | null;
  tokenUsage?: {
    uncachedInputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Agent Teams 名册 + 任务板（有队伍时才有） */
  agentTeam?: AgentTeam;
}

const EMPTY_CHAT: Omit<ChatState, 'sessionId'> = {
  items: [],
  turns: [],
  running: false,
  loading: true,
  loadingOlder: false,
  hasOlder: false,
  title: null,
  contextRatio: 0,
  contextUsed: 0,
  contextWindow: 0,
  model: null,
  provider: null,
  reasoningEffort: null,
};

export class Store {
  readonly api: SessionApi;
  readonly models: ModelApi;
  readonly account: AccountApi;
  readonly upload: UploadApi;
  readonly workspace: WorkspaceApi;
  /** 电脑目录浏览（directoryPicker） */
  readonly dirs: DirectoryPickerApi;
  private conn: DshConnection;

  connection: ConnectionState = 'idle';
  connectionError?: string;
  /** 给用户看的友好提示（分类后的，含下一步建议） */
  connectionHint?: string;

  /** 账户余额（null = 未加载） */
  balance: BalanceResult | null = null;
  /** 上次成功拿到余额的时间戳，用于 TTL 缓存（接口要 2-5 秒，别每次进页面都打） */
  balanceFetchedAt = 0;
  /** 账户登录态链接 */
  accountLinks: { usageUrl?: string; topUpUrl?: string } = {};
  balanceLoading = false;
  balanceError?: string;

  /** 工作区本地自定义（改名 / emoji） */
  workspaceCustom: Record<string, WorkspaceCustom> = {};

  sessions: SessionSummary[] = [];
  workspaces: ReturnType<typeof groupByWorkspace> = [];
  /** 已归档（用户视角的「已删除」）的会话 id。DSH 不返回，客户端自己存 */
  private archived = new Set<string>();
  private archivedLoaded = false;
  sessionsLoading = false;
  sessionsError?: string;

  private chats = new Map<string, ChatState>();
  private streams = new Map<string, { handle: StreamHandle; cursor: number; records: Map<number, EventRecord>; snapshot: unknown }>();
  private listeners = new Set<() => void>();
  /** 节流窗口的定时器（null 表示当前不在窗口内） */
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 窗口内是否有未通知的更新 */
  private emitPending = false;

  /**
   * 本 app 创建的会话 id。
   *
   * 用途：这些会话由当前 web 服务独占，桌面端没有持有写句柄，
   * 因此可以安全地切换模型 / 发消息。UI 上给它们打「手机」标记。
   */
  private ownedSessions = new Set<string>();

  /** cwd → workspaceId 缓存（建会话时用，避免每次都打 workspace/create） */
  private workspaceIdByPath = new Map<string, string>();

  /** 供 UI 层读取文件用（/api/file 需要 baseUrl + cookie） */
  get fileBaseUrl(): string {
    return this.conn.baseUrl;
  }
  get fileCookie(): string | undefined {
    return this.conn.currentCookie;
  }

  constructor(conn: DshConnection) {
    this.conn = conn;
    this.api = new SessionApi(conn);
    this.models = new ModelApi(conn);
    this.account = new AccountApi(conn);
    this.upload = new UploadApi(conn);
    this.workspace = new WorkspaceApi(conn);
    this.dirs = new DirectoryPickerApi(conn);
  }

  /** 拉取账户余额与登录态 */
  async loadAccount(): Promise<void> {
    if (this.balanceLoading) return;
    this.balanceLoading = true;
    this.balanceError = undefined;
    this.emit();
    try {
      // 账户接口偶尔会长时间不返回（上游平台无响应），
      // 不加超时的话「我的」页的加载圈会一直转。
      const bal = await withTimeout(this.account.getBalance(), 12_000);
      const state = await withTimeout(
        this.account.getState().catch(() => null),
        12_000,
      );
      this.balance = bal;
      if (bal.status === 'ready') this.balanceFetchedAt = Date.now();
      if (state) {
        this.accountLinks = state.links ?? {};
      }
      if (bal.status === 'failed') {
        this.balanceError = '余额查询失败，可能需要重新登录平台账号';
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.balanceError = msg === 'timeout' ? '余额查询超时，下拉可重试' : msg;
    } finally {
      this.balanceLoading = false;
      this.emit();
    }
  }

  /** 余额是否还在 TTL 内（默认 90 秒），命中就不用再请求 */
  balanceFresh(ttlMs = 90_000): boolean {
    return this.balance !== null && Date.now() - this.balanceFetchedAt < ttlMs;
  }

  /** 设置工作区自定义（改名 / emoji） */
  setWorkspaceCustom(path: string, patch: WorkspaceCustom): void {
    const cur = this.workspaceCustom[path] ?? {};
    const next: WorkspaceCustom = { ...cur, ...patch };
    // 清掉空字段，避免存冗余
    if (!next.name?.trim()) delete next.name;
    if (!next.emoji) delete next.emoji;

    if (next.name === undefined && next.emoji === undefined) {
      delete this.workspaceCustom[path];
    } else {
      this.workspaceCustom[path] = next;
    }
    this.emit();
  }

  /** 批量恢复自定义（启动时从 AsyncStorage） */
  restoreWorkspaceCustom(map: Record<string, WorkspaceCustom>): void {
    this.workspaceCustom = { ...map };
    this.emit();
  }

  /** 取某个工作区的自定义 */
  customFor(path: string): WorkspaceCustom | undefined {
    return this.workspaceCustom[path];
  }

  /** 是否由本 app 创建（可安全操作） */
  isOwned(sessionId: string): boolean {
    return this.ownedSessions.has(sessionId);
  }

  /** 载入持久化的「app 创建的会话」列表 */
  restoreOwned(ids: string[]): void {
    for (const id of ids) this.ownedSessions.add(id);
    this.emit();
  }

  /** 当前 app 创建的会话 id（供持久化） */
  ownedList(): string[] {
    return [...this.ownedSessions];
  }

  /**
   * 新建一个 app 专属会话。
   * 返回新 sessionId；失败抛错。
   */
  /**
   * 新建会话。
   *
   * ⚠️ 必须走 workspaceId 而不是 cwd：
   * 只传 cwd 建出来的会话不会登记进工作区注册表（~/.dsh/storages/workspace.json），
   * 桌面端按注册表渲染，于是「手机上建的会话在电脑上看不到」。
   * 先 workspace/create {path} 解析出 workspaceId（幂等），再用它建。
   */
  async createSession(cwd: string): Promise<string> {
    let workspaceId: string | undefined;
    if (cwd) {
      try {
        const ws = await this.workspace.ensureForPath(cwd);
        workspaceId = ws?.workspaceId;
        if (workspaceId) this.workspaceIdByPath.set(cwd, workspaceId);
      } catch {
        // 注册表不可用时退回 cwd：会话仍能建（只是桌面端看不到），不阻塞用户
      }
    }
    const res = await this.api.create(
      workspaceId ? { workspaceId } : { cwd: cwd || undefined },
    );
    this.ownedSessions.add(res.sessionId);
    this.emit();
    await this.loadSessions();
    return res.sessionId;
  }

  /** 拉取模型目录 */
  modelCatalog() {
    return this.models.catalog();
  }

  /** 切换会话模型，成功后刷新该会话的元数据 */
  async selectModel(
    sessionId: string,
    selected: { provider: string; model: string; reasoningEffort?: string },
  ): Promise<void> {
    await this.models.select(sessionId, selected);
    const cur = this.getChat(sessionId);
    this.chats.set(sessionId, { ...cur, model: selected.model, provider: selected.provider });
    this.emit();
    // 会话列表里的模型标签也要更新
    void this.loadSessions();
  }

  /** 重新拉会话元数据（模型切换 / 团队状态轮询） */
  async refreshChatMeta(sessionId: string): Promise<void> {
    try {
      const items = await this.api.list();
      // 注意：这里必须过滤归档会话！
      // 曾经直接赋 items，导致「从工作区返回后已删除的会话又冒出来」——
      // 因为 refreshChatMeta 在返回、轮询、切模型时都会跑，把列表重刷成未过滤的。
      await this.ensureArchivedLoaded();
      this.sessions = items;
      this.workspaces = groupByWorkspace(this.visibleSessions(items));
      const row = items.find((s) => s.sessionId === sessionId);
      const status = readStatus(row?.projections);
      const cur = this.getChat(sessionId);

      // 任务完成检测：投影刷新时对比前后状态（team/* 事件不在会话日志里，只能靠投影）
      const prevStatus = new Map((cur.agentTeam?.tasks ?? []).map((t) => [t.id, t.status]));
      const justCompleted: string[] = [];
      if (status.agentTeam) {
        for (const t of status.agentTeam.tasks) {
          const before = prevStatus.get(t.id);
          if (t.status === 'completed' && before !== undefined && before !== 'completed') {
            justCompleted.push(`${t.ownerName ?? '队员'} 完成了「${t.subject}」`);
            this.pushNotice(`${t.ownerName ?? '队员'} 完成了：${t.subject}`);
          }
        }
      }

      // 队员全部干完时，主动唤醒管家做汇总。
      // 原因：DSH 的 Agent Teams 在队友完成后只更新任务投影，
      // 不会自动给 lead 发消息 —— 管家虽然说了「结果回来我汇总」，
      // 但那一轮 turn 已经结束，没人叫它，它就永远不说话了。
      if (justCompleted.length > 0) {
        const stillRunning = (status.agentTeam?.tasks ?? []).some(
          (t) => t.status === 'in_progress' || t.status === 'pending',
        );
        const running = row?.running ?? false;
        if (!stillRunning && !running) {
          void this.wakeButler(sessionId, justCompleted);
        }
      }

      this.chats.set(sessionId, {
        ...cur,
        title: status.title ?? cur.title,
        contextUsed: status.contextUsed,
        contextWindow: status.contextWindow,
        contextRatio: status.contextRatio,
        model: status.model?.model ?? cur.model,
        provider: status.model?.provider ?? cur.provider,
        reasoningEffort: status.model?.reasoningEffort ?? cur.reasoningEffort,
        tokenUsage: status.tokenUsage,
        agentTeam: status.agentTeam,
      });
      this.emit();
    } catch {
      // 刷新失败不影响主流程
    }
  }

  // ── 一次性提示（任务完成等） ─────────────────────────────────────
  /** UI 弹一条就算消费掉，最多留 3 条 */
  teamNotices: TeamNotice[] = [];

  // ── 应用内通知（多会话） ─────────────────────────────────────────
  //
  // 和 teamNotices 的区别：teamNotices 是聊天页内的短提示，
  // 这个是全局横幅，任意页面都能看到——因为管家可能同时在跑好几个会话，
  // 用户切到别的页面时也应该被提醒。
  notices: NoticeItem[] = [];
  /** 上一次扫描时各会话的快照，用来做差异检测 */
  private lastScan = new Map<
    string,
    { running: boolean; title: string; tasks: Map<string, string>; pendingApprovals: number }
  >();
  private scanTimer?: ReturnType<typeof setInterval>;

  /**
   * 开始全局扫描。
   *
   * 轮询策略：只在「有会话在跑」时才查，空闲时完全停掉，
   * 避免手机待机时还在发请求。
   */
  startNoticeScan(): void {
    if (this.scanTimer) return;
    // 立刻扫一次，别等 5 秒 —— 用户刚发完任务就想看到反馈
    void this.scanOnce();
    this.scanTimer = setInterval(() => {
      void this.scanOnce();
    }, 5000);
  }

  /**
   * 手动推一条通知（调试/自测用）。
   *
   * 之所以需要：真实任务常常比扫描间隔还快，或者要等几十秒才结束，
   * 手工验通知很费劲。留一个能直接触发横幅的入口，
   * 可以立刻确认 UI 那条链路是通的。
   */
  debugNotice(text = '测试通知：这轮跑完了'): void {
    this.pushBanner({ kind: 'done', text, detail: '调试' });
  }

  stopNoticeScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }

  /** 扫一遍所有会话，发现状态变化就推通知 */
  private async scanOnce(): Promise<void> {
    try {
      const items = await this.api.list();
      await this.ensureArchivedLoaded();
      const archived = this.archived;
      const live = items.filter((s) => !archived.has(s.sessionId));

      // 注意：这里**不能**用「有没有会话在跑」来决定要不要扫。
      // 踩过的坑：任务跑得比扫描间隔还快时，两次扫描都看到 running=false，
      // 中间的 running→false 转变被完全跳过，用户永远收不到通知。
      // 正确做法是每次都扫，靠 lastScan 快照做差异检测。
      const anyRunning = live.some((s) => s.running);
      if (this.lastScan.size === 0 && !anyRunning) {
        // 首次扫描且全空闲：只建立基线，不通知（省一次推送）
        for (const row of live) {
          const st = readStatus(row.projections);
          this.lastScan.set(row.sessionId, {
            running: row.running,
            title: st.title ?? '会话',
            tasks: new Map(
              (st.agentTeam?.tasks ?? []).map((t) => [t.id, t.status]),
            ),
            pendingApprovals: 0,
          });
        }
        return;
      }

      for (const row of live) {
        const status = readStatus(row.projections);
        const title = status.title ?? '会话';
        const prev = this.lastScan.get(row.sessionId);
        const tasks = new Map(
          (status.agentTeam?.tasks ?? []).map((t) => [t.id, t.status]),
        );
        const pendingApprovals = this.pendingApprovals.filter(
          (a) => a.sessionId === row.sessionId,
        ).length;

        // 第一次见到这个会话：只记基线，不通知（避免一开 App 就刷一堆）
        if (prev) {
          // 任务完成
          for (const t of status.agentTeam?.tasks ?? []) {
            const before = prev.tasks.get(t.id);
            if (t.status === 'completed' && before !== undefined && before !== 'completed') {
              this.pushBanner({
                kind: 'done',
                text: `${t.ownerName ?? '队员'} 完成了「${t.subject}」`,
                detail: title,
                sessionId: row.sessionId,
              });
            }
          }

          // 从「在跑」变成「不跑了」= 这一轮结束。
          // 没有 error 字段可查（readStatus 不返回），所以统一按「跑完了」报，
          // 失败时聊天页里的工具卡会显示红色，不影响用户判断。
          if (prev.running && !row.running) {
            this.pushBanner({
              kind: 'done',
              text: '这轮跑完了',
              detail: title,
              sessionId: row.sessionId,
            });
          }

          // 新的审批请求
          if (pendingApprovals > prev.pendingApprovals) {
            this.pushBanner({
              kind: 'approval',
              text: '需要你授权',
              detail: title,
              sessionId: row.sessionId,
            });
          }
        }

        this.lastScan.set(row.sessionId, {
          running: row.running,
          title,
          tasks,
          pendingApprovals,
        });
      }

      // 清理已删除/归档的会话，避免快照无限增长
      const alive = new Set(live.map((s) => s.sessionId));
      for (const key of [...this.lastScan.keys()]) {
        if (!alive.has(key)) this.lastScan.delete(key);
      }
    } catch {
      // 扫描失败静默，不影响主流程
    }
  }

  private pushBanner(n: {
    kind: NoticeKind;
    text: string;
    detail?: string;
    sessionId?: string;
  }): void {
    // 同样的文案 10 秒内不重复推（轮询可能连着两次看到同一状态）
    const now = Date.now();
    if (
      this.notices.some(
        (x) => x.text === n.text && x.sessionId === n.sessionId && now - x.time < 10_000,
      )
    ) {
      return;
    }
    const item: NoticeItem = {
      id: `nt-${now}-${Math.random().toString(36).slice(2, 6)}`,
      kind: n.kind,
      text: n.text,
      detail: n.detail,
      sessionId: n.sessionId,
      time: now,
    };
    this.notices = [item, ...this.notices].slice(0, 3);
    // 同时震动 + 弹系统通知（后台也能看到）。
    // 把会话 id 传过去，用户点通知能直接跳回对应会话。
    notifyDone(n.text, false, {
      sessionId: n.sessionId,
      detail: n.detail ? `${n.detail} · DSH` : 'DSH',
    });
    this.emit();
  }

  dismissNotice(id: string): void {
    this.notices = this.notices.filter((n) => n.id !== id);
    this.emit();
  }

  // ── 审批网关 ─────────────────────────────────────────────────────
  //
  // 为什么单独开一条连接：DSH 的审批是 Host 侧 waterfall，结果靠 Remote Event
  // 监听器的返回值回传，没有 HTTP RPC 可调。所以借 `dsh-plugin-mobile-gateway`
  // 的独立 WebSocket 来收发审批，**不动现有 RPC 传输层** —— 网关挂了不影响聊天。
  private gateway?: ApprovalGateway;
  /** 待审批列表，key 是 rpcId */
  pendingApprovals: PendingApproval[] = [];
  /** 网关连接状态 */
  gatewayStatus: GatewayStatus = 'idle';
  /** 网关不可用时的原因（用于 UI 提示） */
  gatewayHint = '';

  /**
   * 从持久化的撤销状态同步网关状态（App 启动时调用一次）。
   *
   * 为什么需要：`gatewayStatus` 是 UI 的唯一事实来源，但它是**内存**状态，
   * 启动时是 'idle'。如果不先把存储里的状态灌进来：
   *   · 界面上「已撤销授权」不显示，用户看不出需要手动重新授权
   *   · 而且 connectApprovals 会先跑到 'offline'，再被网关内部的
   *     撤销状态检查拦成 'revoked' —— 状态会闪一下
   *
   * ⚠️ 三态都要处理，不能只看「是否已撤销」：
   *   revoked   → 'revoked'（等用户主动重新授权）
   *   unknown   → 'unknown'（存储读不出来，同样禁止自动配对）
   *   not-revoked → 保持原样（不动）
   *
   * 把 unknown 漏掉的话，启动瞬间界面显示「未连接」，而实际状态是
   * 「不知道」—— 用户看不出区别，但程序行为上两者都禁止自动配对。
   *
   * 注意：这里**只改状态**，不建连接、不改凭据。
   */
  syncRevokedState(status: RevocationStatus): void {
    if (status === 'revoked') {
      this.gatewayStatus = 'revoked';
      this.gatewayHint = '审批授权已撤销，需要重新授权';
      this.emit();
      return;
    }
    if (status === 'unknown') {
      this.gatewayStatus = 'unknown';
      this.gatewayHint = '授权状态暂时无法确认，不会自动连接审批';
      this.emit();
    }
  }

  /** 连上审批网关。App 挂载时调用；已经有连接就复用。 */
  connectApprovals(baseUrl: string, pairingCode?: string): void {
    // 已经在线 / 正在连 → 直接复用，不要重复建连接。
    // 切前后台、store 重建、页面重进都会走到这里。
    if (this.gateway && (this.gatewayStatus === 'online' || this.gatewayStatus === 'connecting')) {
      return;
    }
    // 已撤销 / 状态未知：连也不连，直接保持明确的「未授权」，
    // 由 UI 引导用户主动重新授权（unknown 时等存储恢复）。
    // 见 core/deviceRevocation.ts 的三态说明。
    if (
      (this.gatewayStatus === 'revoked' || this.gatewayStatus === 'unknown') &&
      !pairingCode
    ) {
      return;
    }

    if (!this.gateway) {
      this.gateway = new ApprovalGateway(baseUrl, {
        onStatus: (s, detail) => {
          this.gatewayStatus = s;
          this.gatewayHint = detail ?? '';
          if (s === 'revoked') {
            // 服务端踢掉 / 用户撤销：立刻清空待审批，不给用户留可点按钮。
            // （这些审批已经无法回答 —— 连接都没了。）
            this.pendingApprovals = [];
          }
          this.emit();
        },
        onApproval: (a) => {
          // 按 rpcId 去重：重连时服务端会重放未决审批
          if (!this.pendingApprovals.some((p) => p.rpcId === a.rpcId)) {
            this.pendingApprovals = [...this.pendingApprovals, a];
          }
          this.emit();
          // 需要用户决策，震一下提醒
          notifyDone(`需要审批：${a.toolName}`);
        },
        onResolved: (rpcId, outcome) => {
          this.pendingApprovals = this.pendingApprovals.filter((p) => p.rpcId !== rpcId);
          this.emit();
          // 让聊天记录里那张卡片也进入已决状态
          if (outcome === 'allowed-once' || outcome === 'rejected') {
            this.markApprovalDecided(rpcId, outcome);
          }
        },
      });
    }
    void this.gateway.connect(pairingCode);
  }

  /**
   * 用户主动重新授权审批通道。
   *
   * 和 connectApprovals 的区别：这个会**先解掉「已撤销」标记**。
   * 只应由用户点「重新授权」触发 —— 网络恢复、重连都不得调用。
   *
   * ⚠️ 如果网关实例已经存在但指向**别的地址**（用户改了服务地址），
   * 必须重建 —— `ApprovalGateway.baseUrl` 是 readonly，改不了。
   * 之前这里直接复用旧实例，会一直连老主机。
   */
  reauthorizeApprovals(baseUrl: string, pairingCode?: string): void {
    const target = baseUrl.replace(/\/+$/, '');
    if (this.gateway && this.gateway.serviceUrl !== target) {
      // 地址变了：拆掉旧的，下面会按新地址重建
      this.gateway.disconnect();
      this.gateway = undefined;
      this.gatewayStatus = 'idle';
      this.gatewayHint = '';
    }
    if (!this.gateway) {
      this.connectApprovals(baseUrl, pairingCode);
      return;
    }
    void this.gateway.reauthorize(pairingCode);
  }

  /**
   * 本机审批授权被撤销（用户主动撤销 / 服务端 4003 踢掉）。
   *
   * 三件事：
   *   1. 断开网关（并禁止自动重连）
   *   2. 清本地设备凭据 + 置撤销标记（deviceRevocation 里做）
   *   3. 界面进入明确的「未授权」状态
   *
   * 注意**不动 Cookie**：聊天、看会话仍然正常，撤销的只是审批权限。
   *
   * @returns 撤销标记的**持久化结果**（P0-1）。
   *
   * 它以前是 `Promise<void>` —— 于是「标记没写进存储」这件事被完全吞掉。
   * 调用方（尤其「退出并清除所有授权」）需要知道这一半成没成，
   * 才能如实告诉用户「重启后可能失效」，而不是默认成功。
   */
  async revokeOwnApprovalAuthorization(
    reason: 'self-revoked' | 'server-revoked' | 'cleared',
  ): Promise<RevocationPersistResult> {
    this.gateway?.disconnect();
    this.pendingApprovals = [];
    this.gatewayStatus = 'revoked';
    this.gatewayHint = reason === 'cleared' ? '已清除所有授权' : '审批授权已撤销，需要重新授权';
    this.emit();
    return markApprovalRevoked(reason);
  }

  /** 回答一个审批 */
  answerApproval(a: PendingApproval, outcome: ApprovalOutcome): boolean {
    if (!this.gateway) return false;
    const ok = this.gateway.respond(a, outcome);
    if (ok) {
      // 乐观移除，等服务端 approval-resolved 再确认
      this.markApprovalDecided(a.rpcId, outcome);
      this.emit();
    }
    return ok;
  }

  /**
   * 把聊天记录里对应的审批卡片标成已决。
   *
   * fold 出来的 approvals 是只读派生数据，这里只能按 id 找回去改 decided。
   * 找不到就跳过（可能卡片还没 fold 出来）。
   */
  private markApprovalDecided(rpcId: string, outcome: string): void {
    for (const [, chat] of this.chats) {
      for (const item of chat.items) {
        if (item.kind !== 'assistant') continue;
        // ChatItem 的 assistant 分支把 approvals 直接挂在条目上（不在 turn 里）
        const list = (item as { approvals?: Array<{ id: string; decided?: string }> })
          .approvals;
        if (!list) continue;
        const hit = list.find((a) => a.id === rpcId);
        if (hit) hit.decided = outcome;
      }
    }
  }

  /** 断开网关（App 卸载 / 撤销授权时调用） */
  disconnectApprovals(): void {
    this.gateway?.disconnect();
    this.gateway = undefined;
    this.pendingApprovals = [];
    // ⚠️ 'revoked' / 'unknown' 是**授权状态**，不是连接状态 ——
    // 断开连接不能把它们抹成 'idle'。
    //
    // 抹掉的话「已撤销授权」在界面上会变回「未连接」，
    // 用户看不出区别，也不知道需要手动重新授权；
    // 'unknown' 被抹成 'idle' 更糟：界面会显示成正常待连接，
    // 而实际程序是禁止自动配对的（状态与行为不一致）。
    if (this.gatewayStatus !== 'revoked' && this.gatewayStatus !== 'unknown') {
      this.gatewayStatus = 'idle';
      this.gatewayHint = '';
    }
    this.emit();
  }

  /**
   * 网关帧通道，给文件下载用。
   *
   * 返回 null 表示网关没连上 —— 调用方应回退到 /api/file。
   */
  get gatewayChannel(): {
    send(obj: Record<string, unknown>): void;
    waitFor(
      kind: string,
      match: (f: Record<string, unknown>) => boolean,
      timeoutMs?: number,
    ): Promise<Record<string, unknown>>;
  } | null {
    if (!this.gateway || this.gatewayStatus !== 'online') return null;
    return this.gateway;
  }

  /** 已经唤醒过的会话，避免同一批任务反复触发 */
  private waking = new Set<string>();

  /**
   * 队员全部完成后，主动给管家发一条消息让它汇总。
   *
   * DSH 的 Agent Teams 不会在队友完成时自动唤醒 lead，
   * 所以这一步必须由客户端补上，否则管家承诺的「结果回来我汇总」永远等不到。
   */
  private async wakeButler(sessionId: string, done: string[]): Promise<void> {
    if (this.waking.has(sessionId)) return;
    this.waking.add(sessionId);
    try {
      const text =
        `〔系统通知〕队员已经做完，请向用户汇总结果：\n` +
        done.map((d) => `- ${d}`).join('\n') +
        `\n\n请用 2-3 句简短说明结论，不要重复派活。`;
      await this.send(sessionId, text, []);
    } catch {
      // 发送失败就静默放弃，不打扰用户（下次任务完成还能再触发）
    } finally {
      // 留一段时间窗口，避免同一批任务在多次轮询里重复唤醒
      setTimeout(() => this.waking.delete(sessionId), 30_000);
    }
  }

  private pushNotice(text: string): void {
    if (this.teamNotices.some((n) => n.text === text)) return;
    this.teamNotices = [...this.teamNotices, { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, time: Date.now() }].slice(-3);
    // 手机提醒：震动 + 通知。
    // 放在这里而不是 ChatScreen：store 是唯一的「任务完成」汇聚点，
    // 用户在别的页面（工作区列表、我的）也应该被提醒到。
    notifyDone(text);
  }

  /** 关掉聊天页内的短提示（teamNotices） */
  dismissTeamNotice(id: string): void {
    this.teamNotices = this.teamNotices.filter((n) => n.id !== id);
    this.emit();
  }

  /**
   * 待打开的会话。
   *
   * 通知横幅点一下要跳到对应会话，但 GlobalNotices 拿不到 nav 上下文
   * （它在 NavHost 外面）。所以这里记一个请求，由 HomeScreen 消费。
   */
  pendingOpenSession: string | null = null;

  requestOpenSession(sessionId: string): void {
    this.pendingOpenSession = sessionId;
    this.emit();
  }

  consumeOpenSession(): string | null {
    const s = this.pendingOpenSession;
    this.pendingOpenSession = null;
    return s;
  }

  // ── 订阅 ──────────────────────────────────────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /**
   * 通知所有订阅者重新渲染。
   *
   * ## 为什么必须节流
   *
   * 流式输出时，服务端每个 token 都会推一个事件，每个事件都会走到
   * 这里。一次快速回复能推几百次 —— 每次都同步跑一遍所有订阅者，
   * 等于让整个界面树每毫秒重渲染一次。
   *
   * 手机上这个开销非常大，表现出来就是：
   *   · 文字一个一个往外蹦，不是流式滚动
   *   · 界面卡顿、滚动掉帧
   *   · 用户感觉「回消息很慢」—— 其实模型早就答完了，是渲染跟不上
   *
   * ## 节流策略
   *
   * 用「尾随节流」（trailing throttle）：第一次立刻发，之后在窗口内
   * 合并，窗口结束时补发一次。
   *
   * 为什么不只用 requestAnimationFrame：文本更新不需要跟帧同步，
   * 60ms 一次（约 16fps）人眼已经完全看不出延迟，但比每 token
   * 一次少了整整一个数量级。
   *
   * 为什么不能只在窗口结束时发（纯 debounce）：那样在持续输出时
   * 会一直不刷新，看起来像是卡住。
   */
  private emit(): void {
    // 第一次调用：立刻通知，保证交互即时响应
    if (this.emitTimer === null) {
      this.flushEmit();
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        // 窗口内还有未发出的更新 → 补发一次
        if (this.emitPending) {
          this.emitPending = false;
          this.emit();
        }
      }, EMIT_THROTTLE_MS);
      return;
    }
    // 窗口内：标记待发，不再重复通知
    this.emitPending = true;
  }

  /** 立刻同步通知所有订阅者 */
  private flushEmit(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* 单个订阅者失败不影响其它 */ }
    }
  }

  // ── 连接 ──────────────────────────────────────────────────────────
  async loginWithToken(token: string): Promise<string> {
    this.connection = 'connecting';
    this.emit();
    try {
      const cookie = await this.conn.loginWithToken(token);
      this.connection = 'connected';
      this.emit();
      return cookie;
    } catch (e) {
      this.connection = 'error';
      this.connectionError = e instanceof Error ? e.message : String(e);
      this.emit();
      throw e;
    }
  }

  async ping(): Promise<boolean> {
    try {
      // 探测用硬上限，不能等满 RPC 的 30 秒。
      //
      // 「我的 → 连接状态」每次进页面都会调这个。如果网络半死不活、
      // 底层 fetch 又没超时，界面就一直停在「检测中…」——
      // 用户看到的就是截图里那个样子。
      //
      // 8 秒没响应就当连不上：给用户明确结论，别让他干等。
      await withTimeout(this.api.list(), PROBE_TIMEOUT_MS);
      this.connection = 'connected';
      this.connectionError = undefined;
      this.connectionHint = undefined;
      this.emit();
      // 连上之后顺手探一下版本兼容性（只读，不产生副作用）。
      // 失败不影响连接状态 —— 探测本身不该让 App 显示「连不上」。
      void this.checkCompatibility().catch(() => undefined);
      return true;
    } catch (e) {
      this.connection = 'error';
      this.connectionError = e instanceof Error ? e.message : String(e);
      // 原始 message 是给日志看的（比如 `session/list: gateway/not-found`），
      // 用户需要的是「我该做什么」—— 分类后给出人话提示。
      if (e instanceof RpcError) {
        this.connectionHint = `${e.userTitle}\n${e.userHint}`;
      } else {
        const info = classifyError(e, 'session/list');
        this.connectionHint = `${info.title}\n${info.hint}`;
      }
      this.emit();
      return false;
    }
  }

  // ── 协议兼容性自检 ────────────────────────────────────────────
  //
  // 连上之后顺便探一下「我需要的能力在不在」。
  //
  // 为什么需要：如果 DSH 升级后删了 / 改了某个接口，用户不会立刻知道 ——
  // 他要等到点进那个功能才看到报错，而且报错是 gateway/not-found。
  // 主动探测一次，能在界面上提前给出「哪些功能在这版 DSH 上不可用」。

  /** 兼容性报告（连上后自动填充；空表示还没探过或不兼容但没填） */
  compatSummary = '';
  /** 哪些必需接口不可用 */
  compatMissing: string[] = [];
  /** 是否已经探过 */
  compatChecked = false;

  /**
   * 探测关键接口可用性。
   *
   * 用最轻的调用：`session/list` 已经调过了，剩下的用
   * `workspace/*` 的只读版本（不产生副作用）。
   *
   * 只探「只读」接口 —— 探测时**绝不能**真的建会话或改状态。
   */
  async checkCompatibility(): Promise<void> {
    if (this.compatChecked) return;
    this.compatChecked = true;

    const probes: Array<{ endpoint: string; run: () => Promise<unknown> }> = [
      { endpoint: 'session/list', run: () => this.api.list() },
      // 这几个只读接口能反映版本差异
      { endpoint: 'session/modelCatalog', run: () => this.models.catalog() },
      { endpoint: 'account/getState', run: () => this.account.getState() },
    ];

    const results: Record<string, boolean> = {};
    for (const p of probes) {
      try {
        await p.run();
        results[p.endpoint] = true;
      } catch (e) {
        results[p.endpoint] = false;
        // 网络问题不算「接口缺失」—— 那是另一类问题，不能误报版本不兼容
        if (!isRetryable(e)) continue;
      }
    }

    const report = buildCompatReport(results);
    this.compatMissing = report.missing;
    this.compatSummary = report.summary;
    this.emit();
  }

  // ── 工作区 ────────────────────────────────────────────────────────
  /**
   * 新建工作区。
   *
   * DSH 的 `workspace/create` 是**幂等**的：路径已登记过就返回已有的
   * workspaceId，不报错。所以「新建」在已存在时等价于「打开」。
   *
   * 但目录必须**已经存在于电脑上**，否则服务端报 `workspace/invalid-path`
   * （ENOENT: realpath）。这里把它翻译成人话，方便 UI 直接展示。
   */
  async createWorkspace(rawPath: string): Promise<
    { ok: true; workspaceId: string; path: string } | { ok: false; error: string }
  > {
    const path = rawPath.trim().replace(/[\\/]+$/, '');
    if (!path) return { ok: false, error: '请填写目录路径' };
    // Windows 绝对路径校验，避免填相对路径后在服务端报奇怪的错
    if (!/^[A-Za-z]:\\/.test(path) && !/^\\\\/.test(path)) {
      return { ok: false, error: '请填写完整路径，例如 E:\\work\\my-project' };
    }

    try {
      const ws = await this.workspace.ensureForPath(path);
      if (!ws?.workspaceId) {
        return { ok: false, error: '创建失败：服务端没返回工作区信息' };
      }
      this.workspaceIdByPath.set(path, ws.workspaceId);
      await this.loadSessions();
      return { ok: true, workspaceId: ws.workspaceId, path };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ENOENT|invalid-path|no such file/i.test(msg)) {
        return {
          ok: false,
          error: `电脑上找不到这个目录：${path}\n请先在电脑上创建好文件夹，再回来添加。`,
        };
      }
      if (/EACCES|permission/i.test(msg)) {
        return { ok: false, error: `没有访问权限：${path}` };
      }
      return { ok: false, error: msg };
    }
  }

  // ── 列表 ──────────────────────────────────────────────────────────
  async loadSessions(): Promise<void> {
    if (this.sessionsLoading) return;
    this.sessionsLoading = true;
    this.sessionsError = undefined;
    this.emit();
    try {
      // 归档列表由客户端自己维护（DSH 不返回这个信息），
      // 加载前先同步一次，避免新设备/清缓存后状态错乱
      await this.ensureArchivedLoaded();
      const items = await this.api.list();
      this.sessions = items;
      this.workspaces = groupByWorkspace(this.visibleSessions(items));
    } catch (e) {
      this.sessionsError = e instanceof Error ? e.message : String(e);
    } finally {
      this.sessionsLoading = false;
      this.emit();
    }
  }

  /** 过滤掉已归档的会话（用户视角的「已删除」） */
  private visibleSessions(items: SessionSummary[]): SessionSummary[] {
    if (this.archived.size === 0) return items;
    return items.filter((s) => !this.archived.has(s.sessionId));
  }

  /** 归档列表存在 AsyncStorage，只在首次用到时读一次 */
  private async ensureArchivedLoaded(): Promise<void> {
    if (this.archivedLoaded) return;
    this.archivedLoaded = true;
    try {
      const raw = await AsyncStorage.getItem(ARCHIVED_KEY);
      if (raw) {
        const ids = JSON.parse(raw) as string[];
        if (Array.isArray(ids)) this.archived = new Set(ids);
      }
    } catch {
      // 读失败就当没有归档
    }
  }

  private async persistArchived(): Promise<void> {
    try {
      await AsyncStorage.setItem(ARCHIVED_KEY, JSON.stringify([...this.archived]));
    } catch {
      // 存不下也不影响当前会话
    }
  }

  /**
   * 重命名会话。
   *
   * DSH 有 `session/rename`，改完会把新标题写进会话投影，
   * 所以这里也顺手更新本地的 sessions 缓存，列表立刻能看到新名字
   * （不用等下一次 loadSessions）。
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    const next = title.trim();
    if (!next) throw new Error('名字不能为空');
    await this.api.rename(sessionId, next);
    // 本地同步：会话列表 + 已打开的聊天缓存
    this.sessions = this.sessions.map((s) =>
      s.sessionId === sessionId
        ? {
            ...s,
            projections: {
              ...s.projections,
              values: { ...s.projections?.values, title: next },
            },
          }
        : s,
    );
    this.workspaces = groupByWorkspace(this.visibleSessions(this.sessions));
    const cur = this.chats.get(sessionId);
    if (cur) this.chats.set(sessionId, { ...cur, title: next });
    this.emit();
  }

  /** 用户视角的「删除对话」= 归档。会立刻从列表里移除 */
  async archiveSession(sessionId: string): Promise<void> {
    await this.ensureArchivedLoaded();
    const ids = await this.workspace.archiveSession(sessionId);
    // 优先用服务端返回的完整列表，保证多设备一致
    if (ids.length > 0) this.archived = new Set(ids);
    else this.archived.add(sessionId);
    await this.persistArchived();
    // 立即从前端列表里剔除，不等下次 loadSessions
    this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId);
    this.workspaces = groupByWorkspace(this.visibleSessions(this.sessions));
    // 顺带把聊天缓存清掉，避免删完还能点进去
    this.chats.delete(sessionId);
    this.emit();
  }

  /** 从「已删除」里恢复（取消归档） */
  async unarchiveSession(sessionId: string): Promise<void> {
    await this.ensureArchivedLoaded();
    const ids = await this.workspace.unarchiveSession(sessionId);
    if (ids.length > 0) this.archived = new Set(ids);
    else this.archived.delete(sessionId);
    await this.persistArchived();
    await this.loadSessions();
  }

  /** 已归档的会话（给「最近删除」页面用） */
  getArchivedIds(): string[] {
    return [...this.archived];
  }

  // ── 对话 ──────────────────────────────────────────────────────────
  getChat(sessionId: string): ChatState {
    return this.chats.get(sessionId) ?? { sessionId, ...EMPTY_CHAT };
  }

  /** 打开会话：建流 → 首帧快照 → 可选补历史 */
  /**
   * follow 带子 agent 地址的降级：`mode` 在 session/list 里没有暴露，
   * 先试 continuable，失败再试 one-shot / unknown。
   */
  private async followWithFallback(sessionId: string, address?: SessionAddress) {
    if (address?.kind !== 'subagent') return this.api.follow(sessionId, address);
    const sub = address;
    const modes: Array<'continuable' | 'one-shot' | 'unknown'> = ['continuable', 'one-shot', 'unknown'];
    let lastErr: unknown;
    for (const mode of modes) {
      try {
        return await this.api.follow(sessionId, {
          kind: 'subagent',
          parentSessionId: sub.parentSessionId,
          childSessionId: sub.childSessionId,
          mode,
        });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async openChat(sessionId: string, address?: SessionAddress): Promise<void> {
    if (this.streams.has(sessionId)) return;

    this.chats.set(sessionId, { sessionId, ...EMPTY_CHAT });
    this.emit();

    try {
      const followed = await this.followWithFallback(sessionId, address);
      const { handle, snapshot, next } = followed;
      const records = new Map<number, EventRecord>();
      for (const r of snapshot.records ?? []) {
        if (r?.event?.seq !== undefined) records.set(r.event.seq, r);
      }

      this.streams.set(sessionId, { handle, cursor: snapshot.cursor, records, snapshot });

      const status = readStatus(snapshot.projections);
      this.updateChatFromRecords(sessionId, {
        title: status.title,
        contextUsed: status.contextUsed,
        contextWindow: status.contextWindow,
        contextRatio: status.contextRatio,
        model: status.model?.model ?? null,
        provider: status.model?.provider ?? null,
        reasoningEffort: status.model?.reasoningEffort ?? null,
        tokenUsage: status.tokenUsage,
        agentTeam: status.agentTeam,
        hasOlder: snapshot.hasMore,
        loading: false,
      });
      // 首帧 records 也要 fold 一次，否则界面是空的
      this.rebuild(sessionId);

      // 异步补更早的历史
      if (snapshot.hasMore) {
        void this.loadOlder(sessionId);
      }

      // 后续增量
      void this.pump(sessionId, () => next());
    } catch (e) {
      const cur = this.getChat(sessionId);
      this.chats.set(sessionId, {
        ...cur,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
      this.emit();
    }
  }

  /** 持续消费增量事件 */
  private async pump(sessionId: string, next: () => Promise<EventRecord | undefined>): Promise<void> {
    const entry = this.streams.get(sessionId);
    if (!entry) return;
    try {
      while (true) {
        const rec = await next();
        if (!rec) break;
        const seq = rec.event?.seq;
        if (typeof seq !== 'number') continue;
        entry.records.set(seq, rec);
        this.rebuild(sessionId);
      }
    } catch (e) {
      const cur = this.getChat(sessionId);
      this.chats.set(sessionId, {
        ...cur,
        error: e instanceof Error ? e.message : String(e),
        running: false,
      });
      this.emit();
    }
  }

  /** 往前翻历史 */
  async loadOlder(sessionId: string, batch = 200): Promise<void> {
    const entry = this.streams.get(sessionId);
    if (!entry) return;
    const cur = this.getChat(sessionId);
    if (cur.loadingOlder || !cur.hasOlder) return;

    this.chats.set(sessionId, { ...cur, loadingOlder: true });
    this.emit();

    try {
      const seqs = [...entry.records.keys()];
      const earliest = seqs.length ? Math.min(...seqs) : undefined;
      const page = await this.api.page({
        sessionId,
        throughSeq: entry.cursor,
        beforeSeq: earliest,
        maxMessages: batch,
      });
      for (const r of page.records ?? []) {
        if (r?.event?.seq !== undefined) entry.records.set(r.event.seq, r);
      }
      this.rebuild(sessionId, { hasOlder: page.hasMore, loadingOlder: false });
    } catch (e) {
      const c = this.getChat(sessionId);
      this.chats.set(sessionId, {
        ...c,
        loadingOlder: false,
        error: e instanceof Error ? e.message : String(e),
      });
      this.emit();
    }
  }

  private updateChatFromRecords(sessionId: string, patch: Partial<ChatState>): void {
    const cur = this.getChat(sessionId);
    this.chats.set(sessionId, { ...cur, ...patch });
    this.emit();
  }

  /** 用当前全部记录重新 fold */
  private rebuild(sessionId: string, patch: Partial<ChatState> = {}): void {
    const entry = this.streams.get(sessionId);
    const cur = this.getChat(sessionId);
    if (!entry) {
      this.chats.set(sessionId, { ...cur, ...patch });
      this.emit();
      return;
    }
    const records = [...entry.records.values()].sort(
      (a, b) => (a.event?.seq ?? 0) - (b.event?.seq ?? 0),
    );
    const turns = foldEvents(records);
    const items = toChatItems(turns);
    const last = turns[turns.length - 1];
    this.chats.set(sessionId, {
      ...cur,
      ...patch,
      turns,
      items,
      running: last?.running ?? false,
      loading: false,
    });
    this.emit();
  }

  // ── 输入 ──────────────────────────────────────────────────────────
  /**
   * 发消息（可带附件），默认排队。
   *
   * `attachments` 里每一项同时带两份信息：
   * - `ref`：本地乐观显示用（图片有 localUri，立刻能出缩略图）
   * - `part`：真正发给 Host 的 content 片段
   */
  async send(
    sessionId: string,
    text: string,
    attachments: OutgoingAttachment[] = [],
    mode: 'queue' | 'steer' = 'queue',
  ): Promise<void> {
    const cur = this.getChat(sessionId);
    const parts = attachments.map((a) => a.part);
    const content: PromptPart[] = [
      ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ...parts,
    ];
    if (content.length === 0) return;

    // 注入消息（管家初始化 / 系统通知 / 模式切换）只在网络侧发送，
    // 不做乐观插入，否则会在聊天里闪一条「用户消息」。
    const injected = text.trim() ? isInjectedMessage(text) : false;

    if (!injected) {
      // 乐观插入：本地先显示，等真实事件回来再被 fold 覆盖。
      // 注意剥掉尾部的模式标记，否则会闪一下 〔模式:计划〕。
      //
      // 同时把 running 置 true —— 这一步很关键。
      // 之前只插入消息不设 running，界面要等下一次 refreshChatMeta 轮询
      // （5 秒）才知道「开始跑了」；加上模型首字延迟十几秒，
      // 用户发完消息后屏幕上长时间毫无反应，像是卡死了。
      this.chats.set(sessionId, {
        ...cur,
        running: true,
        items: [
          ...cur.items,
          {
            kind: 'user',
            key: `local-${Date.now()}`,
            turn: (cur.turns.at(-1)?.turn ?? 0) + 1,
            text: stripModeTag(text).trim(),
            time: Date.now(),
            parts: attachments.map((a) => a.ref),
          },
        ],
      });
      this.emit();
    }

    try {
      await this.api.prompt({ sessionId, text, parts: content, mode });
    } catch (e) {
      const c = this.getChat(sessionId);
      this.chats.set(sessionId, {
        ...c,
        // 发送失败必须把 running 复位，否则界面会一直显示「思考中」转圈
        running: false,
        error: e instanceof Error ? e.message : String(e),
      });
      this.emit();
      throw e;
    }
  }

  /** 打断当前轮 */
  async cancel(sessionId: string): Promise<void> {
    await this.api.cancel(sessionId);
  }

  /** 关闭会话流 */
  closeChat(sessionId: string): void {
    const entry = this.streams.get(sessionId);
    entry?.handle.close();
    this.streams.delete(sessionId);
  }

  close(): void {
    for (const id of [...this.streams.keys()]) this.closeChat(id);
    this.conn.close();
  }
}
