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
import {
  ConversationActionsApi, formatFileMention, parseHostQueue, replyForkPoint,
  type HostQueueItem, type HostQueueSnapshot, type ReplyForkPoint,
} from './conversationActions';
import {
  listButlerTasks,
  getButlerTask,
  createButlerTask,
  cancelButlerTask,
  resumeButlerTask,
  type ButlerTask,
  type ButlerTaskStatus,
  type NewButlerTask,
} from './butlerTasks';
import {
  deleteButlerMemory,
  listButlerMemoryHistory,
  loadButlerMemory,
  setButlerMemory,
  type ButlerMemoryChange,
  type ButlerMemoryEntry,
  type ButlerMemoryInput,
  type ButlerMemorySnapshot,
} from './butlerMemory';
import { ButlerSessionOwnership } from './butlerSessionOwnership';
import { buildButlerWake, isPhoneButlerControlMessage } from './butler';
import type { WorkspaceCustom } from '../core/workspace-custom';
import {
  foldEvents,
  toChatItems,
  foldEventsIncremental,
  createIncrementalFoldCache,
  isInjectedMessage,
  stripModeTag,
  type ChatItem,
  type IncrementalFoldCache,
  type Turn,
} from '../core/fold';
import { notifyDone } from '../core/notify';
import { buildCompatReport, classifyError } from '../core/protocol';
import { isAuthFailure, isForbiddenRejection, isRetryable, RpcError } from '../core/rpc-error';
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
import type { PendingSendStore } from './pendingSend/store';
import {
  classifyPromptFailure,
  PendingSendFailurePersistError,
  PendingSendPostAcceptError,
} from './pendingSend/errors';
import type { PendingSendBinding, PendingSendRecord, AttachmentDraft, PendingAttachment } from './pendingSend/types';
import { guessImageMime, readFileBase64 } from './rpc/upload';
import {
  armP0PauseBeforePrompt,
  armP0TestRequest,
  isP0ConfirmationBlocked,
  shouldDropP0Response,
  shouldPauseP0BeforePrompt,
  unblockP0Confirmation,
} from '../dev/p0Verify';

const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/** 延迟加载待发送模块：避免 Store 的 Node 测试被 RN 原生模块解析链拖死。 */
function createDefaultPendingSendStore(): PendingSendStore {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./pendingSend/store') as typeof import('./pendingSend/store');
  return new mod.PendingSendStore();
}

function defaultLoadPendingBinding(baseUrl: string): Promise<PendingSendBinding> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./pendingSend/serviceBinding') as typeof import('./pendingSend/serviceBinding');
  // 本地组装；真正的“当前服务器”验证在 runPendingSend 里用已认证远端接口执行。
  return mod.loadPendingSendBinding(baseUrl, { requireRemote: false });
}

function defaultVerifyPendingBinding(
  expected: PendingSendBinding,
  baseUrl: string,
  cookie: string | undefined,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('./pendingSend/serviceBinding') as typeof import('./pendingSend/serviceBinding');
  return mod.verifyPendingSendBinding(expected, baseUrl, cookie);
}

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
export const REBUILD_BATCH_MS = 60;

/**
 * 判断流事件是否属于必须 0ms 立即刷新的关键状态事件（F-03）：
 *   - user/message：P0-1 PendingSend 对账确认（accepted → confirmed）不得延迟；
 *   - turn/start / turn/end：回合开始与结束状态、最终回答落定不得延迟；
 *   - approval/asked / approval/decided：F-01 审批安全状态不得延迟；
 *   - deliverables/presented：交付文件卡片即时展示。
 * 其余高频中间事件（step/start、assistant/message 流式片段、tool/call、tool/result）
 * 进入 60ms 批量合并窗口，避免每收到一个流事件都全量 rebuild。
 */
export function isCriticalStreamEvent(eventType?: string): boolean {
  return (
    eventType === 'user/message' ||
    eventType === 'turn/start' ||
    eventType === 'turn/end' ||
    eventType === 'approval/asked' ||
    eventType === 'approval/decided' ||
    eventType === 'deliverables/presented'
  );
}

/**
 * 从快照或会话列表行提取服务端权威运行状态（F-03）：
 * 用于修正断线恢复后因缺失 turn/end 事件而可能残留的「进行中」状态。
 */
export function extractAuthoritativeRunning(
  snapshot?: unknown,
  summary?: { running?: boolean },
): boolean | undefined {
  if (snapshot && typeof snapshot === 'object') {
    const snap = snapshot as Record<string, unknown>;
    if (typeof snap.running === 'boolean') return snap.running;
    const proj = snap.projections as { values?: Record<string, unknown> } | undefined;
    const values = proj?.values;
    if (values && typeof values === 'object') {
      if (typeof values.running === 'boolean') return values.running;
      const st = values.status;
      if (typeof st === 'string') {
        if (st === 'idle' || st === 'completed' || st === 'stopped' || st === 'aborted') {
          return false;
        }
        if (st === 'running' || st === 'in_progress') return true;
      } else if (st && typeof st === 'object') {
        const stObj = st as Record<string, unknown>;
        if (typeof stObj.running === 'boolean') return stObj.running;
      }
    }
  }
  if (summary && typeof summary.running === 'boolean') {
    return summary.running;
  }
  return undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * 把「拉列表失败」翻译成用户能照做的话。
 *
 * ## 为什么需要
 *
 * 实测遇到过一个很典型的状态：电脑上的 DSH 进程还活着、端口还在监听，
 * 但事件循环卡死了 —— 任何请求都超时，重启前不会自愈。
 *
 * 这种情况下界面上如果只显示
 * `session/list: TypeError: Network request failed`，
 * 用户完全不知道该干什么：是手机网断了？密码不对？还是电脑坏了？
 *
 * 所以按错误类型给出不同建议，每种都指向一个**具体动作**。
 */
function describeLoadError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);

  // 超时 / 网络层失败：最可能是电脑那边没响应
  if (/AbortError|timeout|请求超时|Network request failed/i.test(raw)) {
    return (
      '连不上电脑上的 DSH。\n\n' +
      '可能的原因：\n' +
      '· DSH 服务已停止或卡死（最常见）\n' +
      '· 手机和电脑不在同一个网络\n' +
      '· 电脑防火墙拦了端口\n\n' +
      '请先在电脑上确认 DSH 还在正常运行；如果是卡住了，重启 DSH 服务后再点「重试」。'
    );
  }

  // 凭据失效（401）：要去重新配对
  if (/(^|[^0-9])401([^0-9]|$)|unauthorized|not authenticated/i.test(raw)) {
    return (
      '登录凭据已失效。\n\n' +
      '请在电脑上重新获取带 token 的链接，回到配对页重新连接。'
    );
  }

  // 403 访问地址限制（trusted-host / Origin）：凭据仍保留，不能当成凭据失效
  if (/(^|[^0-9])403([^0-9]|$)|forbidden/i.test(raw)) {
    return (
      '服务地址未被允许访问（HTTP 403）。\n\n' +
      '当前登录凭据仍有效，但 DSH 拒绝了该访问地址（Host 未列入 trustedHosts）。请检查服务地址是否为 DSH 监听的局域网 IP / 127.0.0.1。'
    );
  }

  // 服务端明确说网关没开
  if (/gateway\/not-found|not-found/i.test(raw)) {
    return '电脑上的 DSH 没有开启这个接口。\n\n请确认 DSH 版本和移动网关插件都正常。';
  }

  // 兜底：仍然给出原始信息，方便用户反馈
  return `加载失败：${raw}`;
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

export interface StoreOptions {
  /** 注入测试用待发送存储；生产默认是 App 级单例。 */
  pendingSendStore?: PendingSendStore;
  /** 注入测试用服务身份来源；生产使用 Keychain 中已持久化的绑定。 */
  loadPendingBinding?: (baseUrl: string) => Promise<PendingSendBinding>;
  /** 注入测试用身份验证；生产走已认证的远端 gatewayId 查询。 */
  verifyPendingBinding?: (
    expected: PendingSendBinding,
    baseUrl: string,
    cookie: string | undefined,
  ) => Promise<void>;
  /** P0-2：会话流自动重连初始退避（默认 500ms） */
  reconnectBaseMs?: number;
  /** P0-2：会话流自动重连最大退避（默认 15_000ms） */
  reconnectMaxMs?: number;
  /** P0-2：抖动随机数源（测试可注入确定性函数） */
  random?: () => number;
}

/** Replay the installed dsh-agent-loop inbox fold on the inclusive fork prefix.
 * removedCount omitted means zero, not delete-to-end; outcome does not alter splice.
 * Reject malformed coordinates/identities even when a later splice would hide them.
 */
function assertEmptyForkInbox(records: readonly EventRecord[], atSeq: number): void {
  const inbox: Record<'next-turn' | 'next-step', unknown[]> = {'next-turn': [], 'next-step': []};
  for (const {event} of [...records].sort((a, b) => a.event.seq - b.event.seq)) {
    if (event.seq > atSeq) break;
    if (event.type !== 'agent/inbox/spliced') {
      if (event.type.startsWith('agent/inbox/')) throw new Error('切点包含未知 inbox 事件');
      continue;
    }
    const splice = event.data;
    const target = splice.target;
    const removed = splice.removedCount === undefined ? 0 : splice.removedCount;
    if ((target !== 'next-turn' && target !== 'next-step') ||
        !Number.isSafeInteger(splice.start) || typeof splice.start !== 'number' || splice.start < 0 ||
        !Number.isSafeInteger(removed) || typeof removed !== 'number' || removed < 0 ||
        !Array.isArray(splice.inserted) || (splice.outcome !== undefined && splice.outcome !== 'canceled')) {
      throw new Error(`切点 inbox splice 无效 (seq ${event.seq})`);
    }
    const slot = inbox[target];
    if (splice.start > slot.length || splice.start + removed > slot.length) throw new Error(`切点 inbox splice 越界 (seq ${event.seq})`);
    // Validate inserted messages independently, including messages removed by later events.
    parseHostQueue({kind: 'sequenced', asOfSeq: event.seq, values: {inbox: {'next-turn': splice.inserted, 'next-step': []}}}, 'fork-prefix');
    slot.splice(splice.start, removed, ...splice.inserted);
    parseHostQueue({kind: 'sequenced', asOfSeq: event.seq, values: {inbox}}, 'fork-prefix');
  }
  if (inbox['next-turn'].length || inbox['next-step'].length) throw new Error('该回答切点仍有排队消息，不能安全派生');
}

export class Store {
  readonly api: SessionApi;
  readonly models: ModelApi;
  readonly account: AccountApi;
  readonly upload: UploadApi;
  readonly workspace: WorkspaceApi;
  /** 电脑目录浏览（directoryPicker） */
  readonly dirs: DirectoryPickerApi;
  /** P0-1：持久化待发送记录（App 级单例，由 App 注入） */
  readonly pendingSends: PendingSendStore;
  private readonly loadPendingBinding: (baseUrl: string) => Promise<PendingSendBinding>;
  private readonly verifyPendingBinding: (
    expected: PendingSendBinding,
    baseUrl: string,
    cookie: string | undefined,
  ) => Promise<void>;
  private conn: DshConnection;
  private readonly conversationApi: ConversationActionsApi;
  private conversationClosed = false;
  private readonly queueWithdrawals = new Map<string, Promise<HostQueueItem>>();
  private readonly replyForks = new Map<string, Promise<{sessionId: string}>>();

  /** Bind an action to this authenticated Host and the live owning chat stream. */
  private conversationGuard(sessionId: string): () => void {
    const entry = this.streams.get(sessionId), generation = entry?.generation;
    const conn = this.conn, baseUrl = conn.baseUrl, cookie = conn.currentCookie;
    const assertCurrent = () => {
      if (this.conversationClosed || this.authInvalidated || this.connection !== 'connected' ||
          !entry || !entry.handle || entry.connecting || entry.retryTimer || this.streams.get(sessionId) !== entry || entry.generation !== generation ||
          entry.address?.kind === 'subagent' || this.sessions.some(row => row.sessionId === sessionId && row.origin === 'subagent') ||
          conn !== this.conn || baseUrl !== conn.baseUrl || cookie !== conn.currentCookie) {
        throw new Error('会话连接已变化，请返回当前会话重试');
      }
    };
    assertCurrent();
    return assertCurrent;
  }

  /** A write receipt survives closing the page, but never a changed Host/auth identity. */
  private async conversationContext(sessionId: string) {
    const assertCurrent = this.conversationGuard(sessionId);
    const conn = this.conn, baseUrl = conn.baseUrl, cookie = conn.currentCookie;
    const assertHost = () => {
      if (this.conversationClosed || this.authInvalidated || this.conn !== conn ||
          conn.baseUrl !== baseUrl || conn.currentCookie !== cookie) {
        throw new Error('服务身份已变化，操作结果不可用于当前连接');
      }
    };
    try {
      const binding = await this.loadPendingBinding(baseUrl);
      assertCurrent();
      await this.verifyPendingBinding(binding, baseUrl, cookie);
      assertCurrent();
    } catch (error) {
      if (isAuthFailure(error) || isForbiddenRejection(error)) this.markAuthTerminal(error);
      throw error;
    }
    const api = new ConversationActionsApi({
      call: async <T,>(endpoint: string, args: Record<string, unknown>): Promise<T> => {
        const request = args.request as {sessionId?: string} | undefined;
        const sourceRead = request?.sessionId === sessionId && endpoint !== 'session/fork' && endpoint !== 'session/updateQueue';
        // New fork projections do not require the original page to remain open.
        if (request?.sessionId === sessionId) assertCurrent();
        else assertHost();
        if (endpoint === 'session/fork') this.assertForkConversation(sessionId);
        const cursor = this.streams.get(sessionId)?.cursor ?? -1;
        try {
          const result = await conn.call<T>(endpoint, args);
          if (sourceRead) assertCurrent();
          else assertHost();
          if (sourceRead && endpoint === 'session/projections' && parseHostQueue(result, sessionId).asOfSeq < cursor) {
            throw new Error('Host 队列投影已过期，请刷新后重试');
          }
          return result;
        } catch (error) {
          if (isAuthFailure(error) || isForbiddenRejection(error)) this.markAuthTerminal(error);
          throw error;
        }
      },
    });
    return {api, assertCurrent, assertHost};
  }

  async conversationQueue(sessionId: string): Promise<HostQueueSnapshot> {
    return (await this.conversationContext(sessionId)).api.queue(sessionId);
  }

  /** Single-flight per durable item. Never infer success from its later disappearance. */
  withdrawQueuedText(sessionId: string, itemId: string): Promise<HostQueueItem> {
    const key = JSON.stringify([sessionId, itemId]);
    const existing = this.queueWithdrawals.get(key);
    if (existing) return existing;
    const task = (async () => (await this.conversationContext(sessionId)).api.removeQueuedText(sessionId, itemId))();
    this.queueWithdrawals.set(key, task);
    void task.finally(() => { if (this.queueWithdrawals.get(key) === task) this.queueWithdrawals.delete(key); }).catch(() => {});
    return task;
  }

  private assertForkConversation(sessionId: string, records: Iterable<EventRecord> = this.streams.get(sessionId)?.records.values() ?? []): void {
    if (this.butlerOwnership.isManaged(sessionId)) throw new Error('Host 管理的管家会话不能派生');
    for (const record of records) {
      if (record.event.type !== 'user/message') continue;
      const data = record.event.data;
      const content = data.content ?? (data.message as {content?: unknown} | undefined)?.content;
      if (Array.isArray(content) && content.some(part => part?.type === 'text' && typeof part.text === 'string' && isPhoneButlerControlMessage(part.text))) {
        throw new Error('管家控制会话不能派生');
      }
    }
  }

  private conversationForkPoint(records: EventRecord[], cursor: number, hasMore: boolean, reply: {turn: number; step: number}): ReplyForkPoint {
    if (records.length > 20_000) return {eligible: false, reason: '历史过长，请先缩小会话范围'};
    if (!Number.isSafeInteger(reply.turn) || reply.turn < 0 || !Number.isSafeInteger(reply.step) || reply.step < 0) {
      return {eligible: false, reason: '缺少持久回答轮次和步骤'};
    }
    const seqs = records.filter(record => record.event?.type === 'assistant/message' &&
      record.event.data?.turn === reply.turn && record.event.data?.step === reply.step).map(record => record.event.seq);
    const point = replyForkPoint(records, seqs.length ? Math.max(...seqs) : -1, {cursor, hasMore, synchronized: true});
    if (!point.eligible) return point;
    try {
      assertEmptyForkInbox(records, point.atSeq);
      return point;
    } catch (error) {
      return {eligible: false, reason: error instanceof Error ? error.message : String(error)};
    }
  }

  canForkReply(sessionId: string, reply: {turn: number; step: number}): boolean {
    try {
      this.conversationGuard(sessionId)();
      this.assertForkConversation(sessionId);
      const entry = this.streams.get(sessionId)!;
      return this.conversationForkPoint([...entry.records.values()], entry.cursor, this.getChat(sessionId).hasOlder, reply).eligible;
    } catch { return false; }
  }

  /** A completed visible final step may request read-only backfill before strict validation. */
  canPrepareForkReply(sessionId: string, reply: {turn: number; step: number}): boolean {
    try {
      this.conversationGuard(sessionId)();
      this.assertForkConversation(sessionId);
      const chat = this.getChat(sessionId);
      if (!chat.hasOlder) return this.canForkReply(sessionId, reply);
      const turn = chat.turns.find(row => row.turn === reply.turn);
      const last = turn?.steps[turn.steps.length - 1];
      return turn?.reason === 'completed' && !turn.running && last?.step === reply.step &&
        last.blocks.some(block => block.kind === 'text' && !!block.text.trim());
    } catch {return false;}
  }

  /** Load a bounded, dense durable prefix; never activate the fork or send a prompt. */
  forkReply(sessionId: string, reply: {turn: number; step: number}): Promise<{sessionId: string}> {
    const key = JSON.stringify([sessionId, reply.turn, reply.step]);
    const existing = this.replyForks.get(key);
    if (existing) return existing;
    const task = this.runReplyFork(sessionId, reply);
    this.replyForks.set(key, task);
    void task.finally(() => { if (this.replyForks.get(key) === task) this.replyForks.delete(key); }).catch(() => {});
    return task;
  }

  private async runReplyFork(sessionId: string, reply: {turn: number; step: number}): Promise<{sessionId: string}> {
    this.assertForkConversation(sessionId);
    const {api, assertCurrent, assertHost} = await this.conversationContext(sessionId);
    const entry = this.streams.get(sessionId)!;
    const cursor = entry.cursor;
    const records = new Map(entry.records);
    let hasMore = this.getChat(sessionId).hasOlder;
    let pages = 0;
    // Even hasMore:false cannot excuse a missing middle prefix.
    while (hasMore || records.size !== cursor + 1 || !records.has(0)) {
      assertCurrent();
      if (++pages > 32 || records.size > 20_000) throw new Error('历史过长，请先加载完整历史后再派生');
      let beforeSeq = 0;
      while (beforeSeq <= cursor && records.has(beforeSeq)) beforeSeq++;
      const later = [...records.keys()].filter(seq => seq > beforeSeq);
      beforeSeq = later.length ? Math.min(...later) : cursor + 1;
      const page = await this.api.page({sessionId, address: entry.address, throughSeq: cursor, beforeSeq, maxMessages: 200});
      assertCurrent();
      const previousSize = records.size;
      for (const record of page.records) {
        const seq = record?.event?.seq;
        if (!Number.isSafeInteger(seq) || seq < 0 || seq > cursor || seq >= beforeSeq) throw new Error('分页历史 seq 无效');
        const prior = records.get(seq);
        if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error('分页历史 seq 冲突');
        records.set(seq, record);
      }
      hasMore = page.hasMore;
      if (records.size === previousSize) throw new Error('历史分页未补全，不能派生');
    }
    if (records.size > 20_000) throw new Error('历史过长，请先加载完整历史后再派生');
    // Concurrent stream events must be included in the same dense validation.
    for (const [seq, record] of entry.records) {
      const prior = records.get(seq);
      if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error('持久历史发生变化');
      records.set(seq, record);
    }
    const history = [...records.values()];
    this.assertForkConversation(sessionId, history);
    const point = this.conversationForkPoint(history, entry.cursor, false, reply);
    if (!point.eligible) throw new Error(point.reason);
    assertCurrent();
    const fork = await api.forkAfterReply(sessionId, history, point.replySeq, {cursor: entry.cursor, hasMore: false, synchronized: true});
    try {
      assertHost();
      const queue = await api.queue(fork.sessionId);
      if (queue.asOfSeq < point.atSeq || queue.items.length) throw new Error('派生会话队列非空或投影不完整');
      assertHost();
    } catch (error) {
      throw Object.assign(new Error(`已创建派生会话，但无法确认队列为空；未自动打开，请勿重复创建。${error instanceof Error ? error.message : String(error)}`),
        {forkSessionId: fork.sessionId, forkQueueUnsafe: true});
    }
    return fork;
  }

  async conversationReferences(sessionId: string, kind: 'file' | 'session', query: string) {
    const assertCurrent = this.conversationGuard(sessionId);
    try {
      if (kind === 'file') {
        const rows = await this.conversationApi.fileReferences(sessionId, query);
        assertCurrent();
        return rows.map(row => ({key: `file:${row.path}`, label: row.path.replace(/\/$/, '').split('/').pop() || row.path,
          detail: row.path, mention: formatFileMention(row), directory: row.kind === 'directory'}));
      }
      const rows = await this.conversationApi.sessionReferences(sessionId, query);
      assertCurrent();
      const visible = new Set(this.visibleSessions(this.sessions).filter(row => row.origin !== 'subagent' || row.parentSessionId === sessionId).map(row => row.sessionId));
      return rows.filter(row => row.sessionId !== sessionId && visible.has(row.sessionId)).map(row => ({
        key: `session:${row.sessionId}`, label: row.displayTitle ?? row.label, detail: row.cwd,
        mention: row.mention,
      }));
    } catch (error) {
      if (isAuthFailure(error) || isForbiddenRejection(error)) this.markAuthTerminal(error);
      throw error;
    }
  }

  connection: ConnectionState = 'idle';
  connectionError?: string;
  /** 给用户看的友好提示（分类后的，含下一步建议） */
  connectionHint?: string;
  /** P0-3：当前会话是否已遇到不可自动恢复的终止态（401 凭据失效或 403 地址受限），停止后台高频轮询 */
  authInvalidated = false;

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
  private streams = new Map<
    string,
    {
      handle?: StreamHandle;
      cursor: number;
      records: Map<number, EventRecord>;
      sortedRecords: EventRecord[];
      maxSeq: number;
      recordsNeedSort: boolean;
      foldCache: IncrementalFoldCache;
      rebuildTimer?: ReturnType<typeof setTimeout>;
      rebuildPending: boolean;
      authoritativeRunning?: boolean;
      snapshot: unknown;
      address?: SessionAddress;
      generation: number;
      retryAttempt: number;
      retryTimer?: ReturnType<typeof setTimeout>;
      connecting: boolean;
    }
  >();
  private streamGenerationCounter = 0;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly random: () => number;
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

  /** P0-1 single-flight：同一未决记录同时只允许一个发送流程。 */
  private pendingInFlight = new Map<string, Promise<PendingSendRecord>>();

  /** 供 UI 层读取文件用（/api/file 需要 baseUrl + cookie） */
  get fileBaseUrl(): string {
    return this.conn.baseUrl;
  }
  get fileCookie(): string | undefined {
    return this.conn.currentCookie;
  }

  constructor(conn: DshConnection, opts: StoreOptions = {}) {
    this.conn = conn;
    this.api = new SessionApi(conn);
    this.models = new ModelApi(conn);
    this.account = new AccountApi(conn);
    this.upload = new UploadApi(conn);
    this.workspace = new WorkspaceApi(conn);
    this.dirs = new DirectoryPickerApi(conn);
    this.conversationApi = new ConversationActionsApi(conn);
    this.pendingSends = opts.pendingSendStore ?? createDefaultPendingSendStore();
    this.loadPendingBinding = opts.loadPendingBinding ?? defaultLoadPendingBinding;
    this.verifyPendingBinding = opts.verifyPendingBinding ?? defaultVerifyPendingBinding;
    this.reconnectBaseMs = Math.max(20, opts.reconnectBaseMs ?? 500);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, opts.reconnectMaxMs ?? 15_000);
    this.random = opts.random ?? Math.random;
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

  /** 管家任务：宿主侧 TaskApi（v0.19） */
  private readonly butlerOwnership = new ButlerSessionOwnership();

  async listButlerTasks(status?: ButlerTaskStatus): Promise<ButlerTask[]> {
    const tasks = await listButlerTasks(this.conn, status);
    for (const task of tasks) this.butlerOwnership.remember(task);
    return tasks;
  }

  async getButlerTask(id: string): Promise<ButlerTask> {
    const task = await getButlerTask(this.conn, id);
    this.butlerOwnership.remember(task);
    return task;
  }

  async createButlerTask(input: NewButlerTask, idempotencyKey?: string): Promise<ButlerTask> {
    const task = await createButlerTask(this.conn, input, idempotencyKey);
    this.butlerOwnership.remember(task);
    return task;
  }

  async cancelButlerTask(id: string): Promise<ButlerTask> {
    const task = await cancelButlerTask(this.conn, id);
    this.butlerOwnership.remember(task);
    return task;
  }

  async resumeButlerTask(id: string): Promise<ButlerTask> {
    const task = await resumeButlerTask(this.conn, id);
    this.butlerOwnership.remember(task);
    return task;
  }

  /** P4 管家身份与用户记忆（只读/显式用户编辑；不参与任务与工具授权）。 */
  async getButlerMemory(): Promise<ButlerMemorySnapshot> {
    return loadButlerMemory(this.conn);
  }

  async listButlerMemoryHistory(id?: string): Promise<ButlerMemoryChange[]> {
    return listButlerMemoryHistory(this.conn, id);
  }

  async setButlerMemory(input: ButlerMemoryInput): Promise<ButlerMemoryEntry> {
    return setButlerMemory(this.conn, input);
  }

  async deleteButlerMemory(id: string, expectedRevision?: number): Promise<number> {
    return deleteButlerMemory(this.conn, id, expectedRevision);
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

  private projectionRequest?: Promise<SessionSummary[]>;
  private chatMetaRefreshes = new Map<string, Promise<void>>();

  /** Share an in-flight projection snapshot between chat polling and global monitoring. */
  private listSessionProjections(): Promise<SessionSummary[]> {
    if (!this.projectionRequest) {
      this.projectionRequest = Promise.resolve().then(() => this.api.list()).finally(() => {
        this.projectionRequest = undefined;
      });
    }
    return this.projectionRequest;
  }

  /** 重新拉会话元数据；同一会话的请求与副作用一起合并。 */
  refreshChatMeta(sessionId: string): Promise<void> {
    if (this.authInvalidated) return Promise.resolve();
    const pending = this.chatMetaRefreshes.get(sessionId);
    if (pending) return pending;
    const request = (async () => {
      try {
        const items = await this.listSessionProjections();
        await this.ensureArchivedLoaded();
        this.sessions = items;
        this.workspaces = groupByWorkspace(this.visibleSessions(items));
        this.applyChatMeta(sessionId, items.find(row => row.sessionId === sessionId));
      } catch (error) {
        if (isAuthFailure(error) || isForbiddenRejection(error)) this.markAuthTerminal(error);
        // 刷新失败不影响主流程。
      } finally {
        this.chatMetaRefreshes.delete(sessionId);
      }
    })();
    this.chatMetaRefreshes.set(sessionId, request);
    return request;
  }

  private applyChatMeta(sessionId: string, row: SessionSummary | undefined): void {
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

    const entry = this.streams.get(sessionId);
    if (entry && typeof row?.running === 'boolean') {
      entry.authoritativeRunning = row.running;
    }
    const nextRunning =
      typeof row?.running === 'boolean' ? row.running : cur.running;
    let nextTurns = cur.turns;
    if (nextRunning === false && cur.turns.length > 0) {
      const lastTurn = cur.turns[cur.turns.length - 1]!;
      if (lastTurn.running) {
        nextTurns = cur.turns.slice();
        nextTurns[nextTurns.length - 1] = { ...lastTurn, running: false };
      }
    }

    this.chats.set(sessionId, {
      ...cur,
      turns: nextTurns,
      running: nextRunning,
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
      const items = await this.listSessionProjections();
      await this.ensureArchivedLoaded();
      const archived = this.archived;
      const live = items.filter((s) => !archived.has(s.sessionId));

      // Hidden chats no longer poll. Reuse the existing global scan so team completion
      // and wakeButler continue without a second per-screen background timer.
      const rows = new Map(live.map(row => [row.sessionId, row]));
      for (const [sessionId, chat] of [...this.chats]) {
        const row = rows.get(sessionId);
        if (chat.agentTeam && row) this.applyChatMeta(sessionId, row);
      }

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
    } catch (e) {
      if (isAuthFailure(e) || isForbiddenRejection(e)) {
        this.markAuthTerminal(e);
      }
      // 扫描失败静默，不影响主流程
    }
  }

  /**
   * 标记当前连接进入不可自动恢复的认证/访问终止态（P0-3）：
   *   · 401（凭据失效）或 403（trusted-host 限制）时停止后台轮询与自动重连，避免无效请求风暴；
   *   · 不清除 Keychain 中的凭据（保留给用户判断或待 trustedHosts 修正后恢复）；
   *   · 将 connection 置为 'error' 并更新明确提示。
   */
  private markAuthTerminal(e: unknown): void {
    this.authInvalidated = true;
    this.connection = 'error';
    this.connectionError = e instanceof Error ? e.message : String(e);
    if (e instanceof RpcError) {
      this.connectionHint = `${e.userTitle}\n${e.userHint}`;
    } else {
      const info = classifyError(e);
      this.connectionHint = `${info.title}\n${info.hint}`;
    }
    this.stopNoticeScan();
    for (const [sid, sEntry] of this.streams.entries()) {
      if (sEntry.retryTimer) {
        clearTimeout(sEntry.retryTimer);
        sEntry.retryTimer = undefined;
      }
      sEntry.connecting = false;
      const cur = this.getChat(sid);
      this.chats.set(sid, {
        ...cur,
        loading: false,
        running: false,
        error: isAuthFailure(e)
          ? '登录状态已失效，请回配对页重新连接'
          : '服务地址未被允许访问（HTTP 403：Host 未受信任），当前凭据已保留',
      });
    }
    this.emit();
  }

  /** 同步更新当前 Store 持有的会话 Cookie，并在变化时重置旧连接、恢复正常连接态（P0-3） */
  syncCookie(cookie: string | undefined): void {
    const prev = this.conn.currentCookie;
    this.conn.setCookie(cookie);
    if (cookie && cookie !== prev) {
      this.authInvalidated = false;
      this.connection = 'connected';
      this.connectionError = undefined;
      this.connectionHint = undefined;
      this.emit();
    } else if (!cookie) {
      this.authInvalidated = true;
      this.connection = 'idle';
      this.stopNoticeScan();
      for (const id of [...this.streams.keys()]) this.closeChat(id);
      this.emit();
    }
  }

  private pushBanner(n: {
    kind: NoticeKind;
    text: string;
    detail?: string;
    sessionId?: string;
  }): void {
    // 同类型、同会话、同文案 10 秒内不重复推（done 与 approval 独立分桶，互不吞没）
    const now = Date.now();
    if (
      this.notices.some(
        (x) =>
          x.kind === n.kind &&
          x.text === n.text &&
          x.sessionId === n.sessionId &&
          now - x.time < 10_000,
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
    // approval 通知优先保留，防止连续 done 通知把未读审批横幅挤出队列
    const combined = [item, ...this.notices];
    const approvals = combined.filter((x) => x.kind === 'approval');
    const others = combined.filter((x) => x.kind !== 'approval');
    this.notices = [...approvals, ...others].slice(0, 3);
    // 同时震动 + 弹系统通知（后台也能看到），按 kind + sessionId 分桶去重。
    notifyDone(n.text, false, {
      kind: n.kind,
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
  /** 服务端 approval-resolved 权威确认集合；不能由本地 pendingApprovals 缺失反推 */
  readonly resolvedApprovalIds = new Set<string>();
  /** 服务端最近一次权威下发/重放（approval-requested）每条 rpcId 的时间戳，用于断线重连后解除「结果未知」锁定 */
  readonly authoritativeApprovalAt = new Map<string, number>();
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
          // 记录服务端权威下发/重放该待审批的最新时间（重连后服务端重放未决项可据此解除「结果未知」锁定）
          this.authoritativeApprovalAt.set(a.rpcId, Date.now());
          if (this.authoritativeApprovalAt.size > 200) {
            const oldestKey = this.authoritativeApprovalAt.keys().next().value;
            if (oldestKey) this.authoritativeApprovalAt.delete(oldestKey);
          }
          // 按 rpcId 去重：重连时服务端会重放未决审批
          if (!this.pendingApprovals.some((p) => p.rpcId === a.rpcId)) {
            this.pendingApprovals = [...this.pendingApprovals, a];
          }
          this.emit();
          // 需要用户决策，按 approval + sessionId 分桶提醒（不被 done 通知冷却拦截）
          notifyDone(`需要审批：${a.toolName}`, false, {
            kind: 'approval',
            sessionId: a.sessionId,
          });
        },
        onResolved: (rpcId, outcome) => {
          this.resolvedApprovalIds.add(rpcId);
          // 有界保留近期权威确认，避免长期运行无限增长
          if (this.resolvedApprovalIds.size > 100) {
            const oldest = this.resolvedApprovalIds.values().next().value;
            if (oldest) this.resolvedApprovalIds.delete(oldest);
          }
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

  /** 回答一个审批（未连接或 401/403 终止态时拒绝伪造成功，真正已决状态由 onResolved 确认） */
  answerApproval(a: PendingApproval, outcome: ApprovalOutcome): boolean {
    if (!this.gateway || this.gatewayStatus !== 'online' || this.authInvalidated) return false;
    const ok = this.gateway.respond(a, outcome);
    if (ok) {
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
      // send 在 prompt 前查询 Host 归属；尚未验证或已托管时不会开启旧管家回合。
      await this.send(sessionId, buildButlerWake(done), []);
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

  /** 立刻同步通知所有订阅者（用于关键安全/完成状态，不经过 60ms 延迟） */
  private emitImmediate(): void {
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.emitPending = false;
    this.flushEmit();
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
      this.authInvalidated = false;
      this.connection = 'connected';
      this.connectionError = undefined;
      this.connectionHint = undefined;
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
      this.authInvalidated = false;
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
      this.authInvalidated = false;
      this.connection = 'connected';
      this.connectionError = undefined;
      this.connectionHint = undefined;
      this.sessions = items;
      this.workspaces = groupByWorkspace(this.visibleSessions(items));
      this.sessionsError = undefined;
      this.syncAuthoritativeRunningFromList(items);
    } catch (e) {
      if (isAuthFailure(e) || isForbiddenRejection(e)) {
        this.markAuthTerminal(e);
      }
      // 用户看到的是这句话，所以要用人话。
      //
      // RpcError 有两个字段：
      //   message   —— 开发格式（`session/list: TypeError: Network request failed`）
      //   userHint  —— 给用户看的中文
      //
      // 之前这里存的是 message，于是服务端假死时用户看到一串英文。
      // 实测场景：DSH 进程还活着、端口还在监听，但事件循环卡死，
      // 任何请求都 30 秒超时 —— 这时候最需要说清楚「是电脑那边的问题」。
      this.sessionsError = describeLoadError(e);
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

  /** Optional Host index; never rebuilds chat history or changes authorization on success. */
  async searchSessions(query: string) {
    if (this.authInvalidated || this.connection !== 'connected') throw new Error('聊天连接不可用');
    try {return await this.api.search(query);}
    catch (error) {
      if (isAuthFailure(error) || isForbiddenRejection(error)) this.markAuthTerminal(error);
      throw error;
    }
  }

  /** 重命名后同步本地投影，列表无需等待再次加载。 */
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

  /**
   * 用 session/list 返回的服务端权威 running 状态修正所有已打开会话的残留「进行中」状态（F-03）。
   */
  private syncAuthoritativeRunningFromList(items: readonly SessionSummary[]): void {
    for (const row of items) {
      if (typeof row?.running !== 'boolean') continue;
      const entry = this.streams.get(row.sessionId);
      if (entry) {
        entry.authoritativeRunning = row.running;
      }
      const cur = this.chats.get(row.sessionId);
      if (!cur) continue;
      if (row.running === false && cur.running) {
        let nextTurns = cur.turns;
        if (cur.turns.length > 0) {
          const last = cur.turns[cur.turns.length - 1]!;
          if (last.running) {
            nextTurns = cur.turns.slice();
            nextTurns[nextTurns.length - 1] = { ...last, running: false };
          }
        }
        this.chats.set(row.sessionId, { ...cur, turns: nextTurns, running: false });
      }
    }
  }

  // ── 对话 ──────────────────────────────────────────────────────────
  getChat(sessionId: string): ChatState {
    const entry = this.streams.get(sessionId);
    if (entry?.rebuildPending) {
      if (entry.rebuildTimer) {
        clearTimeout(entry.rebuildTimer);
        entry.rebuildTimer = undefined;
      }
      entry.rebuildPending = false;
      this.rebuild(sessionId, {}, { silentEmit: true });
    }
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
    const existing = this.streams.get(sessionId);
    if (existing) {
      if (existing.handle || existing.connecting) return;
      if (existing.retryTimer) {
        clearTimeout(existing.retryTimer);
        existing.retryTimer = undefined;
      }
      await this.connectChatStream(sessionId, true);
      return;
    }

    const generation = ++this.streamGenerationCounter;
    this.streams.set(sessionId, {
      cursor: -1,
      records: new Map<number, EventRecord>(),
      sortedRecords: [],
      maxSeq: -1,
      recordsNeedSort: false,
      foldCache: createIncrementalFoldCache(),
      rebuildPending: false,
      snapshot: undefined,
      address,
      generation,
      retryAttempt: 0,
      connecting: false,
    });
    this.chats.set(sessionId, { sessionId, ...EMPTY_CHAT });
    this.emit();

    await this.connectChatStream(sessionId, false);
  }

  /**
   * 建立或恢复会话流（P0-2）。
   *
   * - 首次打开与断线重连共用同一条路径；
   * - 重连成功后合并现有 `records` 与新快照 `snapshot.records`（按 `seq` 去重）；
   * - 若断线期间产生了超过单页快照窗口的事件缺口（`prevMaxSeq + 1 < minNewSnapSeq`），
   *   自动调用 `session/page` 向前补齐，保证不漏事件、不重复显示消息。
   */
  private async connectChatStream(sessionId: string, isReconnect: boolean): Promise<void> {
    const entry = this.streams.get(sessionId);
    if (!entry || entry.connecting) return;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }

    const generation = ++this.streamGenerationCounter;
    entry.generation = generation;
    entry.connecting = true;
    const isCurrent = () => {
      const cur = this.streams.get(sessionId);
      return cur === entry && cur.generation === generation;
    };

    try {
      const prevSeqs = [...entry.records.keys()];
      const prevMaxSeq = prevSeqs.length ? Math.max(...prevSeqs) : -1;

      const followed = await this.followWithFallback(sessionId, entry.address);
      if (!isCurrent()) {
        followed.handle.close();
        return;
      }

      const { handle, snapshot, next } = followed;
      entry.handle = handle;
      entry.snapshot = snapshot;
      entry.cursor = Math.max(entry.cursor, snapshot.cursor ?? -1);
      entry.retryAttempt = 0;
      entry.connecting = false;

      let minNewSnapSeq = Infinity;
      for (const r of snapshot.records ?? []) {
        const seq = r?.event?.seq;
        if (typeof seq === 'number') {
          this.upsertStreamRecord(entry, seq, r);
          if (seq < minNewSnapSeq) minNewSnapSeq = seq;
        }
      }

      // P0-2：如果断线重连期间产生了大于 snapshot 窗口的事件缺口，通过 session/page 补齐
      if (
        isReconnect &&
        prevMaxSeq >= 0 &&
        Number.isFinite(minNewSnapSeq) &&
        minNewSnapSeq > prevMaxSeq + 1
      ) {
        await this.backfillReconnectGap(
          sessionId,
          entry,
          generation,
          prevMaxSeq,
          minNewSnapSeq,
          snapshot.cursor,
        );
        if (!isCurrent()) return;
      }

      if (IS_DEV && isReconnect) {
        console.log(
          `[p0-2-verify] reconnected sessionId=${sessionId} cursor=${snapshot.cursor} records=${entry.records.size}`,
        );
      }

      const status = readStatus(snapshot.projections);
      const authRunning = extractAuthoritativeRunning(
        snapshot,
        isReconnect ? undefined : this.sessions.find((s) => s.sessionId === sessionId),
      );
      if (typeof authRunning === 'boolean') {
        entry.authoritativeRunning = authRunning;
      }
      this.authInvalidated = false;
      this.connection = 'connected';
      this.connectionError = undefined;
      this.connectionHint = undefined;
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
        error: undefined,
      });
      // 首帧 records 也要 fold 一次，否则界面是空的
      this.rebuild(sessionId, { error: undefined }, { immediateEmit: true });

      // 断线重连后若因缺少 turn/end 仍处于 running，且快照本身未携带权威 running 字段，
      // 主动拉一次 session/list 同步服务端权威 running 状态，防止永久残留「进行中」。
      if (isReconnect && authRunning === undefined && this.chats.get(sessionId)?.running) {
        void this.refreshChatMeta(sessionId);
      }

      // 异步补更早的历史（仅首次且 hasMore 时触发，避免重连反复拉全量旧历史）
      if (!isReconnect && snapshot.hasMore) {
        void this.loadOlder(sessionId);
      }

      // 后续增量
      void this.pump(sessionId, generation, () => next());
    } catch (e) {
      if (!isCurrent()) return;
      entry.connecting = false;
      entry.handle = undefined;
      this.handleStreamDisconnect(sessionId, entry, generation, e);
    }
  }

  /**
   * 补齐断线重连期间跨越单页窗口的遗漏事件（`prevMaxSeq < seq < minNewSnapSeq`）。
   */
  private async backfillReconnectGap(
    sessionId: string,
    entry: NonNullable<ReturnType<typeof this.streams.get>>,
    generation: number,
    prevMaxSeq: number,
    minNewSnapSeq: number,
    throughSeq: number,
  ): Promise<void> {
    let beforeSeq = minNewSnapSeq;
    let safety = 0;
    while (beforeSeq > prevMaxSeq + 1 && safety < 10) {
      safety += 1;
      if (this.streams.get(sessionId) !== entry || entry.generation !== generation) return;
      try {
        const page = await this.api.page({
          sessionId,
          address: entry.address,
          throughSeq,
          beforeSeq,
          maxMessages: 200,
        });
        if (this.streams.get(sessionId) !== entry || entry.generation !== generation) return;
        const recs = page.records ?? [];
        if (recs.length === 0) break;
        let earliest = beforeSeq;
        for (const r of recs) {
          const seq = r?.event?.seq;
          if (typeof seq === 'number') {
            this.upsertStreamRecord(entry, seq, r);
            if (seq < earliest) earliest = seq;
          }
        }
        if (!page.hasMore || earliest >= beforeSeq) break;
        beforeSeq = earliest;
      } catch {
        // 补齐失败不阻断当前新流，后续用户上滑或下次重连仍可补齐
        break;
      }
    }
  }

  /**
   * 处理会话流断开或建流失败：
   *   · 明确鉴权失败（401/403/未登录）→ 立即停止重连并提示重新配对；
   *   · 其余网络/服务重启异常 → 指数退避 + 随机抖动自动重连。
   */
  private handleStreamDisconnect(
    sessionId: string,
    entry: NonNullable<ReturnType<typeof this.streams.get>>,
    generation: number,
    error: unknown,
  ): void {
    if (this.streams.get(sessionId) !== entry || entry.generation !== generation) return;
    entry.handle = undefined;
    entry.connecting = false;

    const raw = error instanceof Error ? error.message : String(error);
    const authRejected = isAuthFailure(error) || (this.authInvalidated && /401|unauthor/i.test(this.connectionError ?? ''));
    const forbiddenRejected =
      (!authRejected && isForbiddenRejection(error)) ||
      (!authRejected && this.authInvalidated && /403|forbidden/i.test(this.connectionError ?? ''));

    if (authRejected || forbiddenRejected) {
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
      }
      if (!this.authInvalidated) {
        this.markAuthTerminal(error);
      }
      const cur = this.getChat(sessionId);
      this.chats.set(sessionId, {
        ...cur,
        loading: false,
        running: false,
        error: authRejected
          ? '登录状态已失效，请回配对页重新连接'
          : '服务地址未被允许访问（HTTP 403：Host 未受信任），当前凭据已保留',
      });
      if (IS_DEV) {
        console.log(
          `[p0-2-verify] auth-stopped sessionId=${sessionId} kind=${authRejected ? '401' : '403'} reason=${raw}`,
        );
      }
      this.emit();
      return;
    }

    // P0-3：后台主动用轻量 HTTP 探针复核一次是否为 401/403（RN Android OkHttp WS 握手失败可能不透传 HTTP 状态码）
    const isReactNative =
      typeof navigator !== 'undefined' &&
      (navigator as { product?: string }).product === 'ReactNative';
    if (isReactNative && entry.retryAttempt >= 1 && !this.authInvalidated) {
      void withTimeout(this.api.list(), 2500).catch((probeErr) => {
        if (this.streams.get(sessionId) !== entry || entry.generation !== generation) return;
        if (isAuthFailure(probeErr) || isForbiddenRejection(probeErr)) {
          this.handleStreamDisconnect(sessionId, entry, generation, probeErr);
        }
      });
    }

    const attempt = entry.retryAttempt;
    entry.retryAttempt += 1;
    const expDelay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(attempt, 6),
    );
    const jitterFactor = 0.85 + Math.min(1, Math.max(0, this.random())) * 0.3;
    const delayMs = Math.min(this.reconnectMaxMs, Math.max(20, Math.round(expDelay * jitterFactor)));

    const cur = this.getChat(sessionId);
    this.chats.set(sessionId, {
      ...cur,
      loading: false,
      running: false,
      error: `连接已断开，正在自动重连（第 ${entry.retryAttempt} 次）…`,
    });
    if (IS_DEV) {
      console.log(
        `[p0-2-verify] schedule-reconnect sessionId=${sessionId} attempt=${entry.retryAttempt} delayMs=${delayMs}`,
      );
    }
    this.emit();

    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (this.streams.get(sessionId) !== entry || entry.generation !== generation || this.authInvalidated) return;
      void this.connectChatStream(sessionId, true);
    }, delayMs);
  }

  /** 持续消费增量事件 */
  private async pump(
    sessionId: string,
    generation: number,
    next: () => Promise<EventRecord | undefined>,
  ): Promise<void> {
    const entry = this.streams.get(sessionId);
    if (!entry || entry.generation !== generation) return;
    try {
      while (true) {
        const rec = await next();
        if (this.streams.get(sessionId) !== entry || entry.generation !== generation) return;
        if (!rec) {
          throw new Error('会话事件流已结束');
        }
        const seq = rec.event?.seq;
        if (typeof seq !== 'number') continue;
        const evType = rec.event?.type;
        if (
          evType === 'turn/start' ||
          evType === 'step/start' ||
          evType === 'assistant/message' ||
          evType === 'tool/call'
        ) {
          entry.authoritativeRunning = true;
        } else if (evType === 'turn/end') {
          entry.authoritativeRunning = false;
        }
        this.upsertStreamRecord(entry, seq, rec);
        if (seq > entry.cursor) entry.cursor = seq;
        this.scheduleRebuild(sessionId, { immediate: isCriticalStreamEvent(evType) });
      }
    } catch (e) {
      if (this.streams.get(sessionId) !== entry || entry.generation !== generation) return;
      if (entry.rebuildPending) {
        if (entry.rebuildTimer) {
          clearTimeout(entry.rebuildTimer);
          entry.rebuildTimer = undefined;
        }
        entry.rebuildPending = false;
        this.rebuild(sessionId, {}, { silentEmit: true });
      }
      this.handleStreamDisconnect(sessionId, entry, generation, e);
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
        if (r?.event?.seq !== undefined) this.upsertStreamRecord(entry, r.event.seq, r);
      }
      this.rebuild(sessionId, { hasOlder: page.hasMore, loadingOlder: false }, { immediateEmit: true });
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

  private upsertStreamRecord(
    entry: NonNullable<ReturnType<typeof this.streams.get>>,
    seq: number,
    rec: EventRecord,
  ): void {
    const existed = entry.records.has(seq);
    entry.records.set(seq, rec);
    if (!existed && seq > entry.maxSeq && !entry.recordsNeedSort) {
      entry.sortedRecords.push(rec);
      entry.maxSeq = seq;
    } else {
      entry.recordsNeedSort = true;
      if (seq > entry.maxSeq) entry.maxSeq = seq;
    }
  }

  /**
   * 调度会话折叠重建（F-03）：
   *   - 关键状态事件（immediate = true）：立即执行 rebuild 并同步 flushEmit（0ms 延迟）；
   *   - 高频中间流事件（immediate = false）：在 60ms 窗口内批量合并，窗口结束时只执行一次 rebuild。
   */
  private scheduleRebuild(sessionId: string, opts?: { immediate?: boolean }): void {
    const entry = this.streams.get(sessionId);
    if (!entry) return;
    if (opts?.immediate) {
      if (entry.rebuildTimer) {
        clearTimeout(entry.rebuildTimer);
        entry.rebuildTimer = undefined;
      }
      entry.rebuildPending = false;
      this.rebuild(sessionId, {}, { immediateEmit: true });
      return;
    }

    entry.rebuildPending = true;
    if (entry.rebuildTimer) return;
    entry.rebuildTimer = setTimeout(() => {
      entry.rebuildTimer = undefined;
      if (!entry.rebuildPending || this.streams.get(sessionId) !== entry) return;
      entry.rebuildPending = false;
      this.rebuild(sessionId, {}, { immediateEmit: true });
    }, REBUILD_BATCH_MS);
  }

  /** 用当前记录（优先走增量尾轮折叠与历史引用复用）更新会话视图状态 */
  private rebuild(
    sessionId: string,
    patch: Partial<ChatState> = {},
    opts?: { immediateEmit?: boolean; silentEmit?: boolean },
  ): void {
    const entry = this.streams.get(sessionId);
    const cur = this.chats.get(sessionId) ?? { sessionId, ...EMPTY_CHAT };
    if (!entry) {
      this.chats.set(sessionId, { ...cur, ...patch });
      if (!opts?.silentEmit) {
        if (opts?.immediateEmit) this.emitImmediate();
        else this.emit();
      }
      return;
    }
    if (entry.recordsNeedSort) {
      entry.sortedRecords = [...entry.records.values()].sort(
        (a, b) => (a.event?.seq ?? 0) - (b.event?.seq ?? 0),
      );
      entry.recordsNeedSort = false;
    }
    const { turns, items } = foldEventsIncremental(entry.sortedRecords, entry.foldCache, {
      authoritativeRunning: entry.authoritativeRunning,
    });
    const last = turns[turns.length - 1];
    const running =
      entry.authoritativeRunning === false ? false : (last?.running ?? false);
    this.chats.set(sessionId, {
      ...cur,
      ...patch,
      turns,
      items,
      running,
      loading: false,
    });
    if (!opts?.silentEmit) {
      if (opts?.immediateEmit) this.emitImmediate();
      else this.emit();
    }
    void this.reconcilePendingNow(sessionId);
  }

  // ── 输入 ──────────────────────────────────────────────────────────
  /**
   * 发消息（可带附件），默认排队。
   *
   * `attachments` 里每一项同时带两份信息：
   * - `ref`：本地乐观显示用（图片有 localUri，立刻能出缩略图）
   * - `part`：真正发给 Host 的 content 片段
   */
  /**
   * 发一条用户消息。
   *
   * @param requestId 幂等键。**重试同一条消息必须传同一个值**。
   *
   * 为什么这很关键：DSH 服务端在 `sessionController.prompt` 里做了去重 ——
   *
   *     if (hasPromptRequest(agent, request.requestId)) return { accepted: true }
   *
   * `hasPromptRequest` 同时检查「已排队」（inbox.nextTurn / nextStep）和
   * 「已执行」（session.snapshotEvents 里的 user/message.rpcId）。
   *
   * 也就是说：**只要 requestId 相同，重复提交是安全的**，服务端直接
   * 返回 accepted 而不会再入队一次。
   *
   * 反过来，如果每次重试都换新的 requestId，服务端就当成两条不同的
   * 消息 —— 任务是**真的会重复执行**的（有副作用的工具调用尤其危险）。
   *
   * 所以调用方（ChatScreen）要在失败后保留同一个 requestId 用于重试。
   * 不传时这里生成一个，只适合「一次性、不重试」的注入消息。
   */
  async send(
    sessionId: string,
    text: string,
    attachments: OutgoingAttachment[] = [],
    mode: 'queue' | 'steer' = 'queue',
    requestId?: string,
    opts: { optimistic?: boolean } = {},
  ): Promise<void> {
    const phoneButlerControl = isPhoneButlerControlMessage(text);
    if (phoneButlerControl) {
      // App 打开旧管家时的 prime 和任务完成 wake 都必须先查归属。
      // 拒绝而非假成功，避免调用方把被跳过的 prime 记为已注入。
      await this.butlerOwnership.assertPhoneMayDrive(this.conn, sessionId);
      // 查询完成到本 continuation 恢复之间，另一个 task 响应也可能到达。
      if (this.butlerOwnership.isManaged(sessionId)) {
        throw new Error('Host 管理的会话不接受手机管家自动驱动');
      }
    }
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
    // P0-1 文本发送由 PendingSendBubble 承担“待发送”展示，不能让
    // store.send 再插一条 local-* 乐观消息，否则会和待发送气泡双显。
    const shouldInsertOptimistic = !injected && opts.optimistic !== false;

    // 记录乐观插入那条消息的 key —— 发送失败时要把**它自己**删掉。
    //
    // ⚠️ 为什么必须删：失败时如果不删，本地就留下一条「幽灵消息」。
    // 用户看到它以为已经发出去了，点重试又插一条，聊天区就出现两条
    // 一模一样的内容。实测（模拟器断网重试）能稳定复现。
    let optimisticKey: string | undefined;

    if (shouldInsertOptimistic) {
      // 乐观插入：本地先显示，等真实事件回来再被 fold 覆盖。
      // 注意剥掉尾部的模式标记，否则会闪一下 〔模式:计划〕。
      //
      // 同时把 running 置 true —— 这一步很关键。
      // 之前只插入消息不设 running，界面要等下一次 refreshChatMeta 轮询
      // （5 秒）才知道「开始跑了」；加上模型首字延迟十几秒，
      // 用户发完消息后屏幕上长时间毫无反应，像是卡死了。
      optimisticKey = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this.chats.set(sessionId, {
        ...cur,
        running: true,
        items: [
          ...cur.items,
          {
            kind: 'user',
            key: optimisticKey,
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
      // 把 requestId 透传下去 —— 服务端靠它做幂等去重。
      // 不传的话 SessionApi.prompt 会自己生成一个随机的，
      // 那样重试就变成了「新消息」，会重复执行任务。
      await this.api.prompt({ sessionId, text, parts: content, mode, requestId });
    } catch (e) {
      const c = this.getChat(sessionId);
      this.chats.set(sessionId, {
        ...c,
        // 发送失败必须把 running 复位，否则界面会一直显示「思考中」转圈
        running: false,
        error: e instanceof Error ? e.message : String(e),
        // ⚠️ 把乐观插入的那条删掉。
        //
        // 不删的话：用户看到这条以为已经发出去了，点重试又插一条，
        // 聊天区出现两条相同内容。实测断网重试能稳定复现。
        //
        // 只删自己那条（按 key 匹配），不影响已有的历史消息。
        items: optimisticKey
          ? c.items.filter((it) => it.key !== optimisticKey)
          : c.items,
      });
      this.emit();
      throw e;
    }
  }

  /** 打断当前轮 */
  async cancel(sessionId: string): Promise<void> {
    await this.api.cancel(sessionId);
  }

  // ── P0-1 持久化发送（阶段 2/3：文本与附件） ─────────────────────
  /**
   * 发送一条消息：附件先复制到私有暂存区并计算真实字节 SHA-256，再创建
   * PendingSendRecord；成功回读后才上传/发 prompt。正常新发送永远新 ID。
   */
  async sendPending(
    sessionId: string,
    text: string,
    attachments: AttachmentDraft[] = [],
    mode: 'queue' | 'steer' = 'queue',
  ): Promise<PendingSendRecord> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) throw new Error('消息内容为空');
    await this.pendingSends.ensureHydrated();

    let staged: PendingAttachment[] = [];
    let record: PendingSendRecord;
    try {
      staged = await this.pendingSends.stageDrafts(attachments);
      const binding = await this.loadPendingBinding(this.conn.baseUrl);
      record = await this.pendingSends.create({
        sessionId,
        mode,
        text: trimmed,
        attachments: staged,
        binding,
      });
      if (IS_DEV && trimmed.includes('[P0_BLOCK]')) {
        armP0TestRequest(record.requestId, true);
        console.log(`[p0-verify] arm requestId=${record.requestId}`);
      }
      if (IS_DEV && trimmed.includes('[P0_PAUSE]')) {
        armP0PauseBeforePrompt(record.requestId);
        console.log(`[p0-verify] arm-pause requestId=${record.requestId}`);
      }
    } catch (e) {
      await this.pendingSends.discardStaged(staged);
      throw e;
    }
    this.emit();
    return this.runPendingSend(record);
  }

  /** 用户明确放弃（移除）待发送记录：仅允许确定未发出/明确失败的状态。 */
  async abandonPending(sessionId: string, requestId: string): Promise<PendingSendRecord> {
    await this.pendingSends.ensureHydrated();
    const existing = await this.pendingSends.get(requestId);
    if (!existing || existing.sessionId !== sessionId) {
      throw new Error('找不到待发送记录');
    }
    const record = await this.pendingSends.abandon(requestId);
    this.emit();
    return record;
  }

  /** 用户明确点击“重试（安全）”：只在这里复用旧 requestId。 */
  async retryPending(sessionId: string, requestId: string): Promise<PendingSendRecord> {
    await this.pendingSends.ensureHydrated();
    const existing = await this.pendingSends.get(requestId);
    if (!existing || existing.sessionId !== sessionId) {
      throw new Error('找不到待发送记录');
    }
    const binding = await this.loadPendingBinding(this.conn.baseUrl);
    // 重试前必须有已认证的远端 gatewayId 验证；验证失败时不改变记录状态。
    await this.verifyPendingBinding(existing.binding, this.conn.baseUrl, this.conn.currentCookie);
    // Debug-only: if the test request was already confirmed by a real event,
    // do not start an unnecessary retry; clear the test block safely.
    if (IS_DEV && existing.state === 'confirmed') {
      unblockP0Confirmation(requestId);
      console.log(`[p0-verify] already-confirmed requestId=${requestId}`);
      return existing;
    }
    const record = await this.pendingSends.retry(requestId, binding);
    this.emit();
    const result = await this.runPendingSend(record, { identityVerified: true });
    // Unblock only after the controlled retry has started and completed its
    // local send transition. Any cached confirmation is replayed by reconcile
    // below, never before the retry state is safe.
    if (IS_DEV && isP0ConfirmationBlocked(requestId)) {
      unblockP0Confirmation(requestId);
      console.log(`[p0-verify] release-after-retry requestId=${requestId}`);
      await this.reconcilePendingNow(sessionId);
    }
    return (await this.pendingSends.get(requestId)) ?? result;
  }

  private runPendingSingleFlight(
    requestId: string,
    fn: () => Promise<PendingSendRecord>,
  ): Promise<PendingSendRecord> {
    const existing = this.pendingInFlight.get(requestId);
    if (existing) return existing;
    const promise = fn().finally(() => {
      this.pendingInFlight.delete(requestId);
    });
    this.pendingInFlight.set(requestId, promise);
    return promise;
  }

  private async assertPendingNotRemoved(requestId: string): Promise<void> {
    const latest = await this.pendingSends.get(requestId);
    if (!latest || latest.state === 'abandoned') {
      throw new Error('待发送记录已移除');
    }
  }

  private async preparePendingAttachments(
    current: PendingSendRecord,
  ): Promise<PendingAttachment[]> {
    const attachments = current.attachments.map((a) => ({ ...a }));
    for (let i = 0; i < attachments.length; i += 1) {
      await this.assertPendingNotRemoved(current.requestId);
      const attachment = attachments[i]!;
      // 每次都按原始字节重新校验；临时 URI 失效/文件被删/内容被改都拒绝。
      await this.pendingSends.verifyAttachments([attachment]);
      await this.assertPendingNotRemoved(current.requestId);
      if (attachment.kind === 'file' && !attachment.receiptId) {
        const receipt = await this.upload.uploadBinary(
          current.sessionId,
          attachment.stagedUri,
          attachment.name,
        );
        if (IS_DEV) {
          console.log(
            `[p0-verify] uploaded requestId=${current.requestId} name=${attachment.name} receiptId=${receipt.receiptId} attachmentId=${receipt.file.attachmentId}`,
          );
        }
        attachments[i] = {
          ...attachment,
          receiptId: receipt.receiptId,
          attachmentId: receipt.file.attachmentId,
          size: receipt.file.bytes ?? attachment.size,
        };
        // 原生上传可能已经在途；迟到完成不得写回或推进已移除的记录。
        await this.assertPendingNotRemoved(current.requestId);
        // 每成功一个就写回，上传中断/进程被杀后已成功的回执可复用。
        await this.pendingSends.updateAttachments(current.requestId, attachments);
      }
    }
    return attachments;
  }

  private async buildOutgoingAttachments(
    attachments: PendingAttachment[],
  ): Promise<OutgoingAttachment[]> {
    const outgoing: OutgoingAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        const mediaType =
          (attachment.mime?.startsWith('image/') ? attachment.mime : undefined) ??
          guessImageMime(attachment.name) ??
          'image/png';
        const data = await readFileBase64(attachment.stagedUri);
        outgoing.push({
          ref: {
            kind: 'image',
            attachmentId: attachment.attachmentId ?? '',
            mediaType,
            bytes: attachment.size,
            name: attachment.name,
            localUri: attachment.stagedUri,
          },
          part: { type: 'image', mediaType, data, name: attachment.name },
        });
      } else {
        if (!attachment.receiptId) {
          throw new Error(`附件上传回执丢失：${attachment.name}`);
        }
        outgoing.push({
          ref: {
            kind: 'file',
            attachmentId: attachment.attachmentId ?? '',
            name: attachment.name,
            bytes: attachment.size,
            localUri: attachment.stagedUri,
          },
          part: { type: 'file', receiptId: attachment.receiptId },
        });
      }
    }
    return outgoing;
  }

  private async failPendingAttachments(
    requestId: string,
    code: string,
    error: unknown,
  ): Promise<never> {
    await this.assertPendingNotRemoved(requestId);
    try {
      await this.pendingSends.apply(requestId, {
        type: 'definite-failure',
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    } catch (persistError) {
      throw new PendingSendFailurePersistError(requestId, persistError);
    }
    throw error;
  }

  private async runPendingSend(
    initial: PendingSendRecord,
    options: { identityVerified?: boolean } = {},
  ): Promise<PendingSendRecord> {
    return this.runPendingSingleFlight(initial.requestId, async () => {
      const requestId = initial.requestId;
      let current = await this.pendingSends.get(requestId);
      if (!current) throw new Error('待发送记录已不存在');

      if (current.state === 'queued') {
        current = await this.pendingSends.apply(requestId, { type: 'begin-preparing' });
      }
      if (current.state === 'preparing') {
        try {
          await this.preparePendingAttachments(current);
          current = (await this.pendingSends.get(requestId)) ?? current;
          if (current.state === 'preparing') {
            current = await this.pendingSends.apply(requestId, { type: 'attachments-ready' });
          }
        } catch (e) {
          // 上传失败/暂存文件失效都确定尚未调用 prompt；保持原 requestId，
          // 已成功上传的回执留在记录里供用户显式重试时复用。
          return this.failPendingAttachments(requestId, 'attachment-upload-failed', e);
        }
      }
      if (current.state === 'sending' || current.state === 'accepted') {
        // single-flight 下的重复调用直接返回当前记录，不重复发网络请求。
        return current;
      }
      if (current.state !== 'ready') {
        throw new Error(`待发送记录状态 ${current.state} 不能发送`);
      }
      // ready 可能是上次进程在上传完成后退出留下的；重新核验私有暂存文件。
      try {
        await this.pendingSends.verifyAttachments(current.attachments);
      } catch (e) {
        return this.failPendingAttachments(requestId, 'attachment-invalid', e);
      }

      await this.assertPendingNotRemoved(requestId);
      let outgoing: OutgoingAttachment[];
      try {
        outgoing = await this.buildOutgoingAttachments(current.attachments);
      } catch (e) {
        return this.failPendingAttachments(requestId, 'attachment-unreadable', e);
      }

      await this.assertPendingNotRemoved(requestId);
      // 新建发送在 prompt 之前做已认证的远端身份核验；显式 retry 已在
      // retryPending 中提前核验，避免重复网络请求。
      if (!options.identityVerified) {
        try {
          await this.verifyPendingBinding(
            current.binding,
            this.conn.baseUrl,
            this.conn.currentCookie,
          );
        } catch (e) {
          try {
            await this.pendingSends.apply(requestId, {
              type: 'definite-failure',
              code: 'identity-verification-failed',
              message: e instanceof Error ? e.message : String(e),
            });
          } catch (persistError) {
            throw new PendingSendFailurePersistError(requestId, persistError);
          }
          throw e;
        }
      }

      // 先写 sending 并回读，再发 prompt。
      current = await this.pendingSends.apply(requestId, { type: 'begin-send' });
      if (IS_DEV) {
        console.log(
          `[p0-verify] sending requestId=${requestId} attachments=${current.attachments.length}`,
        );
      }
      if (IS_DEV && shouldPauseP0BeforePrompt(requestId)) {
        console.log(`[p0-verify] paused-before-prompt requestId=${requestId}`);
        this.emit();
        await new Promise<void>(() => {});
      }

      try {
        await this.send(current.sessionId, current.text, outgoing, current.mode, requestId, {
          optimistic: false,
        });
      } catch (e) {
        const failure = classifyPromptFailure(e);
        try {
          await this.pendingSends.apply(
            requestId,
            failure.classification === 'unknown'
              ? {
                  type: 'unknown-failure',
                  code: failure.code,
                  message: failure.message,
                }
              : {
                  type: 'definite-failure',
                  code: failure.code,
                  message: failure.message,
                },
          );
        } catch (persistError) {
          // 记录仍停在 sending；重启会保守转 unknown。不能假装没发过。
          throw new PendingSendFailurePersistError(requestId, persistError);
        }
        this.emit();
        throw e;
      }

      if (IS_DEV && shouldDropP0Response(requestId)) {
        const lost = await this.pendingSends.apply(requestId, {
          type: 'unknown-failure',
          code: 'simulated-response-lost',
          message: 'debug injection: accepted response lost',
        });
        console.log(`[p0-verify] unknown requestId=${requestId}`);
        this.emit();
        return lost;
      }

      try {
        await this.pendingSends.apply(requestId, { type: 'accept' });
      } catch (e) {
        // 服务端已 accepted，但本地状态写失败：保留 requestId，记录停在
        // sending，重启 hydrate 会转 unknown；用户可安全重试同一 ID。
        throw new PendingSendPostAcceptError(requestId, e);
      }
      this.emit();
      return (await this.pendingSends.get(requestId))!;
    }).catch(async (error) => {
      // 移除与异步验证/上传可能交错。状态机已阻止 abandoned→sending；
      // 返回实际终态，使 ChatScreen 不把取消误当发送失败而恢复成待发草稿。
      const latest = await this.pendingSends.get(initial.requestId);
      if (latest?.state === 'abandoned') return latest;
      throw error;
    });
  }

  /**
   * 用服务端真实的 user/message.source.rpcId 对账 accepted 记录。
   * 只做 confirm，不改状态、不重发。
   */
  async reconcilePendingNow(sessionId: string): Promise<void> {
    const entry = this.streams.get(sessionId);
    if (!entry) return;
    const rpcIds = new Set<string>();
    for (const record of entry.records.values()) {
      const event = record.event as
        | { type?: string; data?: { source?: { kind?: string; rpcId?: unknown } } }
        | undefined;
      if (event?.type !== 'user/message') continue;
      const source = event.data?.source;
      if (source?.kind === 'user' && typeof source.rpcId === 'string') {
        rpcIds.add(source.rpcId);
      }
    }
    if (rpcIds.size === 0) return;
    await this.pendingSends
      .list(sessionId)
      .then(async (records) => {
        for (const record of records) {
          if (IS_DEV && isP0ConfirmationBlocked(record.requestId)) {
            console.log(`[p0-verify] suppressed confirm requestId=${record.requestId}`);
            continue;
          }
          if (
            rpcIds.has(record.requestId) &&
            (record.state === 'accepted' || record.state === 'sending' || record.state === 'unknown')
          ) {
            try {
              await this.pendingSends.apply(record.requestId, { type: 'confirm' });
              if (IS_DEV) {
                console.log(`[p0-verify] confirmed requestId=${record.requestId}`);
              }
            } catch {
              // 可能已被其他路径确认；忽略非法迁移
            }
          }
        }
        this.emit();
      })
      .catch(() => undefined);
  }

  /** 关闭会话流 */
  closeChat(sessionId: string): void {
    const entry = this.streams.get(sessionId);
    if (!entry) return;
    entry.generation = ++this.streamGenerationCounter;
    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer);
      entry.rebuildTimer = undefined;
    }
    entry.rebuildPending = false;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }
    entry.handle?.close();
    this.streams.delete(sessionId);
  }

  /**
   * App 回到前台时恢复连接与活跃会话流（P0-2）。
   *
   * - 重置可能处于半开假死态的底层 WebSocket；
   * - 对所有当前打开的会话流重置退避计数并立即重连，自动补齐后台期间遗漏的事件；
   * - 刷新会话列表。
   */
  handleAppForeground(baseUrl?: string): void {
    if (!this.conn.hasCookie || this.authInvalidated) return;
    if (IS_DEV) {
      console.log(`[p0-2-verify] app-foreground activeStreams=${this.streams.size}`);
    }
    const targetBase = baseUrl || this.conn.baseUrl;
    if (targetBase && targetBase !== 'http://127.0.0.1:1') {
      this.connectApprovals(targetBase);
    }
    if (this.streams.size > 0) {
      this.conn.resetSocket('App 回到前台，刷新实时连接');
      for (const [sessionId, entry] of this.streams.entries()) {
        if (entry.retryTimer) {
          clearTimeout(entry.retryTimer);
          entry.retryTimer = undefined;
        }
        entry.retryAttempt = 0;
        entry.connecting = false;
        entry.handle = undefined;
        void this.connectChatStream(sessionId, true);
      }
    }
    void this.loadSessions();
  }

  close(): void {
    this.conversationClosed = true;
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emitPending = false;
    }
    this.stopNoticeScan();
    this.disconnectApprovals();
    for (const id of [...this.streams.keys()]) this.closeChat(id);
    this.conn.close();
  }
}
