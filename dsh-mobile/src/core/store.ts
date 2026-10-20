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
import { SessionApi, groupByWorkspace, readStatus } from '../core/rpc/session';
import { ModelApi } from '../core/rpc/model';
import { AccountApi, type BalanceResult } from '../core/rpc/account';
import { UploadApi } from '../core/rpc/upload';
import { WorkspaceApi } from '../core/rpc/workspace';
import { DirectoryPickerApi } from '../core/rpc/directory';
import type { WorkspaceCustom } from '../core/workspace-custom';
import { foldEvents, toChatItems, isInjectedMessage, stripModeTag, type ChatItem, type Turn } from '../core/fold';
import { notifyDone } from '../core/notify';
import {
  ApprovalGateway,
  type ApprovalOutcome,
  type PendingApproval,
} from '../core/approvalGateway';

/** 已归档会话 id 的存储 key（DSH 不返回归档状态，只能客户端自己记） */
const ARCHIVED_KEY = '@dsh/archivedSessions';
import type { AttachRef, AgentTeam, EventRecord, PromptPart, SessionAddress, SessionSummary } from '../core/types';

/** 待发送附件：本地显示用 ref + 真正发出去的 part */
/** Promise 超时包装：超过 ms 就抛 Error('timeout') */
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

  // ── 审批网关 ─────────────────────────────────────────────────────
  //
  // 为什么单独开一条连接：DSH 的审批是 Host 侧 waterfall，结果靠 Remote Event
  // 监听器的返回值回传，没有 HTTP RPC 可调。所以借 `dsh-plugin-mobile-gateway`
  // 的独立 WebSocket 来收发审批，**不动现有 RPC 传输层** —— 网关挂了不影响聊天。
  private gateway?: ApprovalGateway;
  /** 待审批列表，key 是 rpcId */
  pendingApprovals: PendingApproval[] = [];
  /** 网关连接状态 */
  gatewayStatus: 'idle' | 'connecting' | 'online' | 'offline' = 'idle';
  /** 网关不可用时的原因（用于 UI 提示） */
  gatewayHint = '';

  /** 连上审批网关。进聊天页时调用；已经有连接就复用。 */
  connectApprovals(baseUrl: string, pairingCode?: string): void {
    if (this.gateway && this.gatewayStatus !== 'offline') return;
    if (!this.gateway) {
      this.gateway = new ApprovalGateway(baseUrl, {
        onStatus: (s, detail) => {
          this.gatewayStatus = s;
          this.gatewayHint = detail ?? '';
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

  /** 断开网关（离开聊天页时调用） */
  disconnectApprovals(): void {
    this.gateway?.disconnect();
    this.gateway = undefined;
    this.pendingApprovals = [];
    this.gatewayStatus = 'idle';
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

  dismissNotice(id: string): void {
    this.teamNotices = this.teamNotices.filter((n) => n.id !== id);
    this.emit();
  }

  // ── 订阅 ──────────────────────────────────────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
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
      await this.api.list();
      this.connection = 'connected';
      this.connectionError = undefined;
      this.emit();
      return true;
    } catch (e) {
      this.connection = 'error';
      this.connectionError = e instanceof Error ? e.message : String(e);
      this.emit();
      return false;
    }
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
