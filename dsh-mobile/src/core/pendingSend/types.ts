/**
 * 持久化发送（P0-1）的基础类型。
 *
 * 这里刻意不依赖 React、Store、网络层，方便 Node 直接测试状态机和存储层。
 */

/** 一条待发送记录的生命周期。 */
export type PendingSendState =
  /** 已落盘，尚未开始准备附件 */
  | 'queued'
  /** 正在读取/上传附件；prompt 一定尚未发出 */
  | 'preparing'
  /** 附件已就绪，尚未调用 session/prompt */
  | 'ready'
  /** 已落盘“将发送”，prompt 可能已在途 */
  | 'sending'
  /** session/prompt 返回 accepted:true（服务端只保证入队） */
  | 'accepted'
  /** 结果未知，可能已执行；重试必须复用 requestId */
  | 'unknown'
  /** 明确未送达/被拒绝，任务确定没执行 */
  | 'failed'
  /** 会话记录中已出现相同 rpcId 的 user/message */
  | 'confirmed'
  /** 用户主动放弃；未发送过的记录可直接清理 */
  | 'abandoned'
  /** 超过保留期，payload 已清除 */
  | 'expired';

export const PENDING_SEND_SCHEMA = 1;

/**
 * 记录绑定的服务实例与授权上下文。
 *
 * 只存 hash / 标识，不存 cookie、token 或原始 device id。
 * `gatewayId` 来自 DSH 网关的稳定实例标识；缺失时不允许跨重启重试。
 */
export interface PendingSendBinding {
  /** 归一化后的服务地址 */
  baseUrl: string;
  /** 服务端实例标识（DSH gatewayId）；null 表示老协议没提供 */
  gatewayId: string | null;
  /** 服务端设备 id、客户端设备 id、凭据上下文等派生出的 SHA-256 */
  authContextHash: string;
  /** confirmed = baseUrl + gatewayId 都可确认；unverifiable = 至少缺一个 */
  identityQuality: 'confirmed' | 'unverifiable';
}

export interface PendingAttachment {
  kind: 'image' | 'file';
  /** 本地文件 URI；重试时重新读取，不把文件内容存进 keychain */
  localUri: string;
  name: string;
  size: number;
  mime?: string;
  /** 文件内容 SHA-256；没有它禁止发送 */
  contentSha256: string;
  /** 文件上传回执；仅 file 类型，重试时可复用 */
  receiptId?: string;
  attachmentId?: string;
}

export interface PendingSendError {
  classification: 'definite' | 'unknown';
  code: string;
  /** 截断后的安全文案，不写入日志 */
  message: string;
}

export interface PendingSendRecord {
  schema: typeof PENDING_SEND_SCHEMA;
  requestId: string;
  sessionId: string;
  mode: 'queue' | 'steer';
  text: string;
  attachments: PendingAttachment[];
  /** 文本 + 附件内容哈希的指纹；只用于展示/冲突检测，不用于自动复用 ID */
  fingerprint: string;
  state: PendingSendState;
  attemptCount: number;
  binding: PendingSendBinding;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  acceptedAt?: number;
  confirmedAt?: number;
  lastError?: PendingSendError;
}

export interface PendingSendDocument {
  schema: typeof PENDING_SEND_SCHEMA;
  revision: number;
  updatedAt: number;
  records: PendingSendRecord[];
}

export interface PendingSendInput {
  sessionId: string;
  mode: 'queue' | 'steer';
  text: string;
  attachments: PendingAttachment[];
  binding: PendingSendBinding;
  /** 默认 createdAt + 7 天 */
  expiresAt?: number;
}

export interface PendingSendLimits {
  maxRecords: number;
  maxTextBytes: number;
  maxAttachments: number;
  maxDocumentBytes: number;
}

export const DEFAULT_PENDING_SEND_LIMITS: PendingSendLimits = {
  maxRecords: 20,
  maxTextBytes: 32 * 1024,
  maxAttachments: 8,
  maxDocumentBytes: 256 * 1024,
};

/** 默认保留期：未决记录 7 天。 */
export const DEFAULT_PENDING_SEND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** accepted 但 24h 没在会话里看到的事件：不再自动重发，直接清理。 */
export const DEFAULT_ACCEPTED_TTL_MS = 24 * 60 * 60 * 1000;
/** 已放弃记录保留 1h，供 UI 撤回提示。 */
export const DEFAULT_ABANDONED_TTL_MS = 60 * 60 * 1000;

/** 未决状态（需要用户明确处理，绝不自动重发）。 */
export function isUnresolvedState(state: PendingSendState): boolean {
  return (
    state === 'queued' ||
    state === 'preparing' ||
    state === 'ready' ||
    state === 'sending' ||
    state === 'accepted' ||
    state === 'unknown' ||
    state === 'failed'
  );
}

/** 终态；不会再有网络副作用。 */
export function isTerminalState(state: PendingSendState): boolean {
  return state === 'confirmed' || state === 'abandoned' || state === 'expired';
}
