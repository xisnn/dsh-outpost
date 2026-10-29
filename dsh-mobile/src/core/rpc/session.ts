/**
 * 会话相关的 RPC 封装。
 *
 * 所有载荷形状来自实测（docs/protocol-notes.md §2.3）。
 * 注意：session/list 的第一个参数叫 _request，其他方法叫 request。
 */

import type { DshConnection, StreamHandle } from '../transport';
import { isTempWorkspace } from '../workspaceFilter';
import type {
  EventRecord,
  FollowSnapshot,
  Projections,
  PromptPart,
  SessionAddress,
  SessionSummary,
} from '../types';

export interface SessionListResult {
  items: SessionSummary[];
}

export interface SessionPageResult {
  records: EventRecord[];
  hasMore: boolean;
}

export class SessionApi {
  constructor(private readonly conn: DshConnection) {}

  /** 列出所有会话 */
  async list(): Promise<SessionSummary[]> {
    const res = await this.conn.call<SessionListResult>('session/list', { _request: {} });
    return res?.items ?? [];
  }

  /**
   * 分页取历史。
   * throughSeq 必须来自 follow 首帧的 cursor，否则会报 past cursor。
   */
  async page(params: {
    sessionId: string;
    address?: SessionAddress;
    throughSeq: number;
    beforeSeq?: number;
    maxMessages?: number;
  }): Promise<SessionPageResult> {
    const request: Record<string, unknown> = {
      address: (params.address ?? {
        kind: 'session',
        sessionId: params.sessionId,
      }) satisfies SessionAddress,
      throughSeq: params.throughSeq,
    };
    if (params.beforeSeq !== undefined) request.beforeSeq = params.beforeSeq;
    if (params.maxMessages !== undefined) request.maxMessages = params.maxMessages;

    const res = await this.conn.call<SessionPageResult>('session/page', {
      request,
      // 长会话的分页查询要给足时间。
      //
      // 实测：一个 92 条消息、几百个事件的会话，在模拟器上默认 30 秒
      // 不够用，界面顶部报「session/page: 请求超时（30 秒无响应）」。
      // 服务端本身没卡（同时测登录接口只要 0.3 秒），是这次查询确实慢 ——
      // 要把会话事件读出来、折叠成消息，事件多的时候很重。
      //
      // 给 60 秒：比默认翻倍，但不像 prompt 那样给到 3 分钟 ——
      // 用户在看历史时对等待更敏感，超时了要能尽快给出「加载失败」。
      __timeoutMs: 60_000,
    });
    return { records: res?.records ?? [], hasMore: res?.hasMore ?? false };
  }

  /** 发消息。mode: queue = 排队（默认），steer = 立即插话 */
  async prompt(params: {
    sessionId: string;
    text: string;
    /** 附件等结构化片段；给了就以它为准（text 会被忽略，由调用方自己加进去） */
    parts?: PromptPart[];
    requestId?: string;
    mode?: 'queue' | 'steer';
    clientTimeZone?: string;
  }): Promise<void> {
    const content: PromptPart[] =
      params.parts && params.parts.length > 0
        ? params.parts
        : params.text
          ? [{ type: 'text', text: params.text }]
          : [];
    if (content.length === 0) throw new Error('消息内容为空');
    await this.conn.call('session/prompt', {
      request: {
        requestId: params.requestId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: params.sessionId,
        mode: params.mode ?? 'queue',
        content,
        ...(params.clientTimeZone ? { clientTimeZone: params.clientTimeZone } : {}),
      },
      // ⚠️ session/prompt 必须给足超时。
      //
      // 它和普通查询不一样：服务端收到之后要**启动一轮模型推理**，
      // 排队、加载上下文、首字生成都可能耗时。默认 30 秒在真机上
      // 不够 —— 实测模拟器上长会话直接报「请求超时（30 秒无响应）」，
      // 但服务端其实正常接收并跑起来了，而且消息已经入了队列。
      //
      // 给 3 分钟：足够覆盖绝大多数首字延迟，又不至于让用户无限等。
      // 注意这只是**等待「入队成功」的确认**，不是等模型答完 ——
      // 真正的回复通过 WebSocket 事件流式推回来，和后端那段耗时无关。
      __timeoutMs: 180_000,
    });
  }

  /** 打断当前轮 */
  async cancel(sessionId: string): Promise<void> {
    await this.conn.call('session/cancel', { request: { sessionId } });
  }

  /** 管理排队中的消息 */
  async updateQueue(params: {
    sessionId: string;
    itemId: string;
    action:
      | { kind: 'remove' }
      | { kind: 'steer' }
      | { kind: 'edit'; content: Array<{ type: 'text'; text: string }> };
  }): Promise<void> {
    await this.conn.call('session/updateQueue', {
      request: {
        sessionId: params.sessionId,
        itemId: params.itemId,
        action: params.action,
      },
    });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.conn.call('session/rename', { request: { sessionId, title } });
  }

  /**
   * 新建会话。返回 { sessionId, agentPreset }。
   *
   * 新建的会话归当前 web 服务独占，不会被桌面端的写句柄占用，
   * 因此可以正常 selectModel / prompt（已实测）。
   */
  async create(params: {
    cwd?: string;
    /** 优先用 workspaceId：这样会话会登记进工作区注册表，桌面端才看得到 */
    workspaceId?: string;
    sessionId?: string;
    agentPreset?: string;
  }): Promise<{ sessionId: string; agentPreset?: string }> {
    const request: Record<string, unknown> = {};
    // cwd 与 workspaceId 互斥，优先 workspaceId
    if (params.workspaceId) request.workspaceId = params.workspaceId;
    else if (params.cwd) request.cwd = params.cwd;
    if (params.sessionId) request.sessionId = params.sessionId;
    if (params.agentPreset) request.agentPreset = params.agentPreset;
    const res = await this.conn.call<{ sessionId: string; agentPreset?: string }>(
      'session/create',
      { request },
    );
    if (!res?.sessionId) throw new Error('session/create 没有返回 sessionId');
    return res;
  }

  /**
   * 打开会话流。首帧是完整快照（cursor + records + projections）。
   * 之后是增量事件。
   */
  async follow(
    sessionId: string,
    address?: SessionAddress,
  ): Promise<{
    handle: StreamHandle;
    snapshot: FollowSnapshot;
    next: () => Promise<EventRecord | undefined>;
  }> {
    // 子 agent 会话必须用 subagent 地址，普通会话用 session 地址
    const addr: SessionAddress = address ?? { kind: 'session', sessionId };
    const handle = await this.conn.openStream('session/follow', {
      request: { address: addr },
    });

    const iterator = handle[Symbol.asyncIterator]();

    const first = await iterator.next();
    if (first.done) throw new Error('session/follow closed before snapshot');
    const snapshot = first.value as FollowSnapshot;

    return {
      handle,
      snapshot,
      next: async () => {
        const r = await iterator.next();
        if (r.done) return undefined;
        // 增量帧可能直接是事件记录，也可能包在 {type, event} 里
        const v = r.value as EventRecord | EventRecord['event'];
        if (v && typeof v === 'object' && 'event' in v) return v as EventRecord;
        if (v && typeof v === 'object' && 'type' in v && 'seq' in v) {
          return { type: 'event', event: v as EventRecord['event'] } as EventRecord;
        }
        return undefined;
      },
    };
  }
}

/**
 * 归一化 cwd，避免同一个目录因为斜杠数量不同被拆成两个工作区。
 * 例：`C:\\work\\demo` 和 `C:\work\demo` 应视为同一个。
 */
export function normalizeCwd(raw: string): string {
  if (!raw) return '';
  return raw.replace(/\\{2,}/g, '\\').replace(/\/{2,}/g, '/').replace(/[\\/]+$/, '');
}

/** 按 cwd 把会话分成工作区 */
export function groupByWorkspace(sessions: SessionSummary[]) {
  const map = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    // 子 agent 会话不计入工作区主列表
    if (s.origin === 'subagent') continue;
    const key = normalizeCwd(s.cwd ?? '');
    // 过滤 DSH 自己的临时工作区（Temp 下的 dsh-prop-xxx 之类）。
    // 实测一台机器 173 个会话里有 46 个是这种，真实项目只剩 3 个，
    // 不滤掉列表根本没法看。判定规则见 core/workspaceFilter.ts。
    if (isTempWorkspace(key)) continue;
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }

  return [...map.entries()]
    .map(([cwd, list]) => {
      const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
      const name = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : '未命名工作区';
      return {
        path: cwd,
        name,
        sessions: sorted,
        updatedAt: sorted[0]?.updatedAt ?? 0,
        running: sorted.some((s) => s.running),
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 从 projections 里取展示用状态 */
export function readStatus(projections?: Projections) {
  const v = projections?.values ?? {};
  const pressure = v.contextPressure ?? {};
  const used = pressure.pressureTokens ?? 0;
  const window = pressure.contextWindow ?? 0;
  return {
    title: v.title ?? null,
    running: false, // 由 session 行决定
    contextUsed: used,
    contextWindow: window,
    contextRatio: window > 0 ? used / window : 0,
    tokenUsage: v.tokenUsage,
    // 投影里实际叫 modelSelection.next；有的版本给 v.model，都兼容一下
    model: v.modelSelection?.next ?? v.modelSelection?.lastUsed ?? v.model ?? null,
    todos: v.todos ?? null,
    inbox: v.inbox,
    agentTeam: v.agentTeam,
  };
}
