/**
 * 事件模型：DSH session 日志里我们认得的类型。
 *
 * 全部字段名来自本机实测采样（见 probes/_event-samples.json），
 * 不是从文档猜的。改动这里之前请先重新采样。
 */

/** 内容块 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text?: string; reasoning?: string }
  | { type: 'image'; mediaType?: string; name?: string }
  | { type: 'tool-call'; name: string; arguments?: string; callId?: string }
  | { type: string; [key: string]: unknown };

/**
 * session/prompt 里可以发的内容片段。
 *
 * 实测（probes/verify-upload*.mjs）：
 * - 图片**只能**内联 base64，`{type:'image', receiptId}` 会被 wire 校验拒绝
 * - 文件**只能**用上传回执，没有内联形式
 */
export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string };

/**
 * 已落地到会话里的附件引用（从 user/message 的 content 里 fold 出来）。
 *
 * 注意 Host 存的是 `{type, attachment:{...}}`，输入时的 `receiptId` 字段不会被保留。
 */
export type AttachRef =
  | {
      kind: 'image';
      attachmentId: string;
      mediaType?: string;
      width?: number;
      height?: number;
      bytes?: number;
      name?: string;
      /** 本地预览 URI（乐观插入时直接可用，免去向 Host 再要一次） */
      localUri?: string;
    }
  | {
      kind: 'file';
      attachmentId: string;
      name?: string;
      bytes?: number;
      localUri?: string;
    };

/** 一条事件记录（session/page 与 session/follow 的 records 元素） */
export interface EventRecord {
  type: 'event';
  event: {
    type: string;
    seq: number;
    time: number;
    data: Record<string, unknown>;
    ignorable?: true;
    sourceEventSeqs?: unknown;
    surfaceOp?: unknown;
  };
}

/** follow 首帧 */
export interface FollowSnapshot {
  type: unknown;
  header: unknown;
  cursor: number;
  records: EventRecord[];
  hasMore: boolean;
  projections?: Projections;
}

/** 会话状态投影 */
export interface Projections {
  kind?: 'cached' | 'sequenced';
  asOfSeq?: number;
  values?: {
    title?: string | null;
    todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> | null;
    inbox?: { 'next-turn'?: unknown[]; 'next-step'?: unknown[] };
    tokenUsage?: {
      uncachedInputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    contextPressure?: {
      pressureTokens?: number;
      projectedTokens?: number;
      contextWindow?: number;
    };
    sessionStats?: {
      turns?: number;
      steps?: number;
      llmMs?: number;
      toolMs?: number;
      ttftMs?: number;
      decodeMs?: number;
      decodeTokens?: number;
    };
    /**
     * 模型选择。实测投影里是 `modelSelection`（不是 `model`）：
     *   { lastUsed: {...} | null, next: { provider, model, reasoningEffort } }
     * `next` 是「下一次对话会用」的模型与思考强度。
     */
    modelSelection?: {
      lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null;
      next?: { provider?: string; model?: string; reasoningEffort?: string } | null;
    } | null;
    /** 兼容旧字段名（部分版本直接给 model） */
    model?: { provider?: string; model?: string; reasoningEffort?: string } | null;
    agentPreset?: string | null;
    workingDirectory?: string | null;
    /**
     * Agent Teams 的名册与任务板（投影自带，不需要额外 RPC）。
     * 只有「有队伍」的会话才有；管家模式就是靠它渲染团队状态条。
     */
    agentTeam?: AgentTeam;
    [key: string]: unknown;
  };
}

export interface TeamMember {
  id: string;
  name: string;
  role: 'lead' | 'teammate';
  /** 持久生命周期；Lead 恒为 active，回合活动看 Session 状态 */
  phase: 'failed' | 'provisioning' | 'active';
  error?: string;
}

export interface TeamTask {
  id: string;
  revision: number;
  subject: string;
  description: string;
  status: 'completed' | 'pending' | 'in_progress' | 'deleted';
  blockedBy: string[];
  writeScopes: string[];
  ownerName?: string;
  ready: boolean;
  writeScopeWarnings: string[];
}

export interface AgentTeam {
  members: TeamMember[];
  tasks: TeamTask[];
  failure?: string;
}

/**
 * 会话地址。普通会话用 `session`；**子 agent 会话必须用 `subagent` 地址**，
 * 直接用 `{kind:'session'}` 会被服务端拒绝：
 *   session/agent-busy: subagent Sessions require their durable parent address
 */
export type SessionAddress =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'subagent';
      parentSessionId: string;
      childSessionId: string;
      /** 实测：continuable 能读到队员的完整记录 */
      mode: 'one-shot' | 'continuable' | 'unknown';
    };

/** session/list 的一行 */
export interface SessionSummary {
  sessionId: string;
  cwd?: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  agentAvailable: boolean;
  parentSessionId?: string;
  origin?: 'subagent';
  projections?: Projections;
}

/** 工作区（按 cwd 分组） */
export interface Workspace {
  /** cwd；未记录时为 '' */
  path: string;
  /** 展示名：目录最后一段 */
  name: string;
  sessions: SessionSummary[];
  /** 最近更新时间 */
  updatedAt: number;
  /** 是否有正在跑的会话 */
  running: boolean;
}
