/**
 * 会话状态管理。
 *
 * 设计原则：
 * - 事件流是唯一事实来源，turn 模型由 fold 派生
 * - 增量事件到达时重新 fold（数据量小，简单可靠）
 * - 网络/流断开时保留已有数据，标记状态，不丢内容
 */

import type { DshConnection, StreamHandle } from '../core/transport';
import { SessionApi, groupByWorkspace, readStatus } from '../core/rpc/session';
import { ModelApi } from '../core/rpc/model';
import { AccountApi, type BalanceResult } from '../core/rpc/account';
import { UploadApi } from '../core/rpc/upload';
import { WorkspaceApi } from '../core/rpc/workspace';
import type { WorkspaceCustom } from '../core/workspace-custom';
import { foldEvents, toChatItems, type ChatItem, type Turn } from '../core/fold';
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

  constructor(conn: DshConnection) {
    this.conn = conn;
    this.api = new SessionApi(conn);
    this.models = new ModelApi(conn);
    this.account = new AccountApi(conn);
    this.upload = new UploadApi(conn);
    this.workspace = new WorkspaceApi(conn);
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
      this.sessions = items;
      this.workspaces = groupByWorkspace(items);
      const row = items.find((s) => s.sessionId === sessionId);
      const status = readStatus(row?.projections);
      const cur = this.getChat(sessionId);

      // 任务完成检测：投影刷新时对比前后状态（team/* 事件不在会话日志里，只能靠投影）
      const prevStatus = new Map((cur.agentTeam?.tasks ?? []).map((t) => [t.id, t.status]));
      if (status.agentTeam) {
        for (const t of status.agentTeam.tasks) {
          const before = prevStatus.get(t.id);
          if (t.status === 'completed' && before !== undefined && before !== 'completed') {
            this.pushNotice(`${t.ownerName ?? '队员'} 完成了：${t.subject}`);
          }
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

  private pushNotice(text: string): void {
    if (this.teamNotices.some((n) => n.text === text)) return;
    this.teamNotices = [...this.teamNotices, { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, time: Date.now() }].slice(-3);
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

  // ── 列表 ──────────────────────────────────────────────────────────
  async loadSessions(): Promise<void> {
    if (this.sessionsLoading) return;
    this.sessionsLoading = true;
    this.sessionsError = undefined;
    this.emit();
    try {
      const items = await this.api.list();
      this.sessions = items;
      this.workspaces = groupByWorkspace(items);
    } catch (e) {
      this.sessionsError = e instanceof Error ? e.message : String(e);
    } finally {
      this.sessionsLoading = false;
      this.emit();
    }
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

    // 乐观插入：本地先显示，等真实事件回来再被 fold 覆盖
    this.chats.set(sessionId, {
      ...cur,
      items: [
        ...cur.items,
        {
          kind: 'user',
          key: `local-${Date.now()}`,
          turn: (cur.turns.at(-1)?.turn ?? 0) + 1,
          text: text.trim(),
          time: Date.now(),
          parts: attachments.map((a) => a.ref),
        },
      ],
    });
    this.emit();

    try {
      await this.api.prompt({ sessionId, text, parts: content, mode });
    } catch (e) {
      const c = this.getChat(sessionId);
      this.chats.set(sessionId, {
        ...c,
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
