/**
 * PendingSendStore：待发送消息的唯一持久化入口。
 *
 * 关键约束：
 *   · 所有写入串行化（进程内 mutex 队列），防止并发读改写丢更新；
 *   · 写后立即回读，回读必须与写入字节完全一致；
 *   · 正常新发送永远生成新 requestId；只有用户显式 retry() 才复用旧 ID；
 *   · 任何写失败都不改变内存状态（事务式保存）。
 */

import {
  DEFAULT_ABANDONED_TTL_MS,
  DEFAULT_ACCEPTED_TTL_MS,
  DEFAULT_EXPIRED_TTL_MS,
  DEFAULT_PENDING_SEND_LIMITS,
  DEFAULT_PENDING_SEND_TTL_MS,
  PENDING_SEND_SCHEMA,
  type AttachmentDraft,
  type PendingSendDocument,
  type PendingSendInput,
  type PendingSendLimits,
  type PendingSendRecord,
  type PendingSendState,
  type PendingAttachment,
} from './types';
import {
  canUserRetry,
  evaluatePendingSendBinding,
  transitionPendingSend,
  type BindingRejectionReason,
  type CurrentServiceBinding,
  type PendingSendEvent,
} from './state';
import { computeSendFingerprint, utf8ByteLength } from './fingerprint';
import { createRequestId } from './ids';
import {
  KeychainPendingSendPersistence,
  PendingSendPersistenceError,
  type PendingSendPersistence,
} from './persistence';
import {
  NoopPendingSendStaging,
  PendingSendStagingError,
  type PendingSendStaging,
} from './staging';

export interface PendingSendStoreOptions {
  persistence?: PendingSendPersistence;
  /** 生产 App 必须注入真实私有目录暂存；测试/无文件场景默认 no-op。 */
  staging?: PendingSendStaging;
  idFactory?: () => string;
  now?: () => number;
  limits?: Partial<PendingSendLimits>;
  ttlMs?: number;
  acceptedTtlMs?: number;
  abandonedTtlMs?: number;
  expiredTtlMs?: number;
}

export type PendingSendStoreErrorCode =
  | 'not-hydrated'
  | 'corrupt-document'
  | 'read-failed'
  | 'write-failed'
  | 'read-back-mismatch'
  | 'document-too-large'
  | 'duplicate-request-id'
  | 'request-not-found'
  | 'request-not-retryable'
  | 'limit-exceeded'
  | 'invalid-record'
  | 'cleanup-failed';

export class PendingSendStoreError extends Error {
  readonly code: PendingSendStoreErrorCode;
  readonly cause?: unknown;

  constructor(code: PendingSendStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'PendingSendStoreError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface PendingSendClearResult {
  records: 'cleared' | 'failed';
  staging: 'cleared' | 'failed';
}

export class PendingSendBindingError extends Error {
  readonly code = 'PENDING_SEND_FOREIGN_BINDING';
  readonly reason: BindingRejectionReason;

  constructor(reason: BindingRejectionReason) {
    super(`pending send cannot be retried in current service context: ${reason}`);
    this.name = 'PendingSendBindingError';
    this.reason = reason;
  }
}

export interface PendingSendRecovery {
  requestId: string;
  from: PendingSendState;
  to: PendingSendState;
}

interface PendingSendDocumentState {
  schema: 1;
  revision: number;
  updatedAt: number;
  records: PendingSendRecord[];
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'queued',
  'preparing',
  'ready',
  'sending',
  'accepted',
  'unknown',
  'failed',
  'confirmed',
  'abandoned',
  'expired',
]);

function emptyDocument(now: number): PendingSendDocumentState {
  return { schema: PENDING_SEND_SCHEMA, revision: 0, updatedAt: now, records: [] };
}

function cloneRecord(record: PendingSendRecord): PendingSendRecord {
  return JSON.parse(JSON.stringify(record)) as PendingSendRecord;
}

function isRecordLike(value: unknown): value is PendingSendRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<PendingSendRecord>;
  return (
    v.schema === PENDING_SEND_SCHEMA &&
    typeof v.requestId === 'string' &&
    v.requestId.length > 0 &&
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0 &&
    (v.mode === 'queue' || v.mode === 'steer') &&
    typeof v.text === 'string' &&
    Array.isArray(v.attachments) &&
    typeof v.fingerprint === 'string' &&
    typeof v.state === 'string' &&
    KNOWN_STATES.has(v.state) &&
    typeof v.attemptCount === 'number' &&
    Number.isFinite(v.attemptCount) &&
    typeof v.createdAt === 'number' &&
    typeof v.updatedAt === 'number' &&
    typeof v.expiresAt === 'number' &&
    !!v.binding &&
    typeof v.binding === 'object'
  );
}

function parseDocument(raw: string): PendingSendDocumentState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PendingSendStoreError('corrupt-document', '待发送文档无法解析', e);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PendingSendStoreError('corrupt-document', '待发送文档不是对象');
  }
  const doc = parsed as Partial<PendingSendDocumentState>;
  if (doc.schema !== PENDING_SEND_SCHEMA || typeof doc.revision !== 'number') {
    throw new PendingSendStoreError('corrupt-document', '待发送文档版本或 revision 非法');
  }
  if (!Array.isArray(doc.records) || !doc.records.every(isRecordLike)) {
    throw new PendingSendStoreError('corrupt-document', '待发送文档包含非法记录');
  }
  const ids = new Set<string>();
  for (const record of doc.records) {
    if (ids.has(record.requestId)) {
      throw new PendingSendStoreError('corrupt-document', '待发送文档包含重复 requestId');
    }
    ids.add(record.requestId);
  }
  return {
    schema: PENDING_SEND_SCHEMA,
    revision: doc.revision,
    updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
    records: doc.records.map(cloneRecord),
  };
}

export class PendingSendStore {
  private readonly persistence: PendingSendPersistence;
  private readonly staging: PendingSendStaging;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly limits: PendingSendLimits;
  private readonly ttlMs: number;
  private readonly acceptedTtlMs: number;
  private readonly abandonedTtlMs: number;
  private readonly expiredTtlMs: number;

  private doc: PendingSendDocumentState | null = null;
  /** 串行化所有读写；一条 Promise 链就是进程内 mutex。 */
  private lock: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(options: PendingSendStoreOptions = {}) {
    this.persistence = options.persistence ?? new KeychainPendingSendPersistence();
    this.staging = options.staging ?? new NoopPendingSendStaging();
    this.idFactory = options.idFactory ?? (() => createRequestId());
    this.now = options.now ?? (() => Date.now());
    this.limits = { ...DEFAULT_PENDING_SEND_LIMITS, ...(options.limits ?? {}) };
    this.ttlMs = options.ttlMs ?? DEFAULT_PENDING_SEND_TTL_MS;
    this.acceptedTtlMs = options.acceptedTtlMs ?? DEFAULT_ACCEPTED_TTL_MS;
    this.abandonedTtlMs = options.abandonedTtlMs ?? DEFAULT_ABANDONED_TTL_MS;
    this.expiredTtlMs = options.expiredTtlMs ?? DEFAULT_EXPIRED_TTL_MS;
  }

  get isHydrated(): boolean {
    return this.doc !== null;
  }

  /** 订阅待发送记录变化；返回取消订阅函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // UI 订阅者异常不能影响存储状态
      }
    }
  }

  /** 启动时可以显式 hydrate；重复调用会重新读取磁盘。 */
  async ensureHydrated(): Promise<void> {
    if (this.doc) return;
    await this.hydrate();
  }

  private runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lock.then(() => fn());
    // 无论成功失败，都不让队列卡死。
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private requireDoc(): PendingSendDocumentState {
    if (!this.doc) {
      throw new PendingSendStoreError('not-hydrated', '待发送存储尚未 hydrate');
    }
    return this.doc;
  }

  private assertDocumentSize(document: PendingSendDocumentState): string {
    const serialized = JSON.stringify(document);
    const bytes = utf8ByteLength(serialized);
    if (bytes > this.limits.maxDocumentBytes) {
      throw new PendingSendStoreError(
        'document-too-large',
        `待发送文档超过上限：${bytes} > ${this.limits.maxDocumentBytes} bytes`,
      );
    }
    return serialized;
  }

  /** 保存整份文档：先写入并回读校验，成功后才替换内存状态。 */
  private async save(next: PendingSendDocumentState): Promise<PendingSendDocumentState> {
    const document: PendingSendDocumentState = {
      ...next,
      revision: (this.doc?.revision ?? 0) + 1,
      updatedAt: this.now(),
    };
    const serialized = this.assertDocumentSize(document);
    try {
      await this.persistence.writeRaw(serialized);
    } catch (e) {
      if (e instanceof PendingSendPersistenceError) throw e;
      throw new PendingSendStoreError('write-failed', '待发送文档写入失败', e);
    }
    let back: string | undefined;
    try {
      back = await this.persistence.readRaw();
    } catch (e) {
      throw new PendingSendStoreError('read-back-mismatch', '待发送文档回读失败', e);
    }
    if (back !== serialized) {
      throw new PendingSendStoreError(
        'read-back-mismatch',
        '待发送文档回读内容与写入不一致',
      );
    }
    this.doc = document;
    this.emit();
    return document;
  }

  /** 读取并校验磁盘文档；不自动创建文档。 */
  async hydrate(): Promise<{ recovered: PendingSendRecovery[]; pruned: number }> {
    return this.runExclusive(async () => {
      const raw = await this.persistence.readRaw().catch((e: unknown) => {
        throw new PendingSendStoreError('read-failed', '待发送文档读取失败', e);
      });
      this.doc = raw === undefined ? emptyDocument(this.now()) : parseDocument(raw);
      const recovered = await this.recoverInternal();
      const prunedRecords = await this.pruneInternal();
      // 启动时清理不再被任何记录引用的暂存文件（崩溃/清理失败的残留）。
      const referenced = this.doc.records.flatMap((r) =>
        r.attachments.map((a) => a.stagedUri),
      );
      await this.staging.cleanupOrphans(referenced).catch(() => 0);
      this.emit();
      return { recovered, pruned: prunedRecords.length };
    });
  }

  /** 进行重启恢复：sending -> unknown；preparing -> failed；不自动重发。 */
  async recoverAfterRestart(): Promise<PendingSendRecovery[]> {
    return this.runExclusive(async () => {
      this.requireDoc();
      return this.recoverInternal();
    });
  }

  private async recoverInternal(): Promise<PendingSendRecovery[]> {
    const doc = this.requireDoc();
    const now = this.now();
    const changed: PendingSendRecovery[] = [];
    const records = doc.records.map((record) => {
      const next = transitionPendingSend(record, { type: 'recover-after-restart' }, now);
      if (next !== record) {
        changed.push({ requestId: record.requestId, from: record.state, to: next.state });
        return next;
      }
      return record;
    });
    if (changed.length > 0) {
      await this.save({ ...doc, records });
    }
    return changed;
  }

  /**
   * 清理：
   *   · confirmed：立即删除（如果崩溃在确认后删除前）；
   *   · abandoned：1h 后删除；
   *   · accepted：24h 未确认删除（不自动重发）；
   *   · 未决：7 天过期后删除。
   * @returns 被删除的记录副本；调用方可据此写非敏感墓碑。
   */
  async prune(): Promise<PendingSendRecord[]> {
    return this.runExclusive(async () => {
      this.requireDoc();
      return this.pruneInternal();
    });
  }

  private async pruneInternal(): Promise<PendingSendRecord[]> {
    const doc = this.requireDoc();
    const now = this.now();
    const removed: PendingSendRecord[] = [];
    const expiredNow: PendingSendRecord[] = [];
    const keep: PendingSendRecord[] = [];
    for (const record of doc.records) {
      let remove = false;
      if (record.state === 'confirmed') {
        remove = true;
      } else if (record.state === 'expired') {
        // 过期记录先保留 1h 展示提示；附件在进入 expired 时已清理。
        remove = now - record.updatedAt >= this.expiredTtlMs;
      } else if (record.state === 'abandoned') {
        remove = now - record.updatedAt >= this.abandonedTtlMs;
      } else if (record.state === 'accepted') {
        // accepted 超过等待确认窗口：转为 expired 短暂展示“曾受理但未确认”，
        // 不再直接静默删除，避免误显示为未发送。
        if (now - (record.acceptedAt ?? record.updatedAt) >= this.acceptedTtlMs) {
          const expired = transitionPendingSend(record, { type: 'expire' }, now);
          expiredNow.push(expired);
          keep.push(expired);
          continue;
        }
      } else if (now >= record.expiresAt) {
        const expired = transitionPendingSend(record, { type: 'expire' }, now);
        expiredNow.push(expired);
        keep.push(expired);
        continue;
      }
      if (remove) removed.push(cloneRecord(record));
      else keep.push(record);
    }
    if (removed.length > 0 || expiredNow.length > 0) {
      await this.save({ ...doc, records: keep });
      // 共享同一 stagedUri 的未决记录可能仍在使用该文件；只清理不再被引用的。
      const stillReferenced = new Set(
        keep
          .filter(
            (r) =>
              r.state !== 'confirmed' &&
              r.state !== 'abandoned' &&
              r.state !== 'expired',
          )
          .flatMap((r) => r.attachments.map((a) => a.stagedUri)),
      );
      const cleanupAttachments = [...removed, ...expiredNow]
        .flatMap((r) => r.attachments)
        .filter((a) => !stillReferenced.has(a.stagedUri));
      await this.staging.removeAttachments(cleanupAttachments).catch(() => undefined);
    }
    return [...removed, ...expiredNow];
  }

  /** 把 UI 草稿复制到私有暂存区并计算真实字节 SHA-256。 */
  async stageDrafts(drafts: AttachmentDraft[]): Promise<PendingAttachment[]> {
    const staged: PendingAttachment[] = [];
    try {
      for (const draft of drafts) {
        staged.push(await this.staging.stage(draft));
      }
      return staged;
    } catch (e) {
      await this.staging.removeAttachments(staged).catch(() => undefined);
      if (e instanceof PendingSendStagingError) throw e;
      throw new PendingSendStoreError('write-failed', '附件暂存失败', e);
    }
  }

  /** 记录创建失败/身份失败时清理已经复制到暂存区的文件。 */
  async discardStaged(attachments: PendingAttachment[]): Promise<void> {
    await this.staging.removeAttachments(attachments).catch(() => undefined);
  }

  /** 逐项校验暂存文件仍存在且 SHA-256 未变。 */
  async verifyAttachments(attachments: PendingAttachment[]): Promise<void> {
    for (const attachment of attachments) {
      await this.staging.verify(attachment);
    }
  }

  /** 附件上传回执写回（preparing/ready 阶段）。 */
  async updateAttachments(
    requestId: string,
    attachments: PendingAttachment[],
  ): Promise<PendingSendRecord> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      const index = doc.records.findIndex((r) => r.requestId === requestId);
      if (index < 0) {
        throw new PendingSendStoreError('request-not-found', `找不到待发送记录 ${requestId}`);
      }
      const current = doc.records[index]!;
      if (current.state !== 'preparing' && current.state !== 'ready') {
        throw new PendingSendStoreError(
          'request-not-retryable',
          `状态 ${current.state} 不允许更新附件回执`,
        );
      }
      const next: PendingSendRecord = {
        ...current,
        attachments: attachments.map((a) => ({ ...a })),
        updatedAt: this.now(),
      };
      const records = doc.records.slice();
      records[index] = next;
      await this.save({ ...doc, records });
      return cloneRecord(next);
    });
  }

  async create(input: PendingSendInput): Promise<PendingSendRecord> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      const now = this.now();
      if (!input.text.trim() && input.attachments.length === 0) {
        throw new PendingSendStoreError('invalid-record', '消息文本和附件不能同时为空');
      }
      if (doc.records.length >= this.limits.maxRecords) {
        throw new PendingSendStoreError(
          'limit-exceeded',
          `待发送记录已达上限 ${this.limits.maxRecords} 条`,
        );
      }
      if (input.attachments.length > this.limits.maxAttachments) {
        throw new PendingSendStoreError(
          'limit-exceeded',
          `单条消息附件超过上限 ${this.limits.maxAttachments} 个`,
        );
      }
      if (utf8ByteLength(input.text) > this.limits.maxTextBytes) {
        throw new PendingSendStoreError(
          'limit-exceeded',
          `消息文本超过上限 ${this.limits.maxTextBytes} bytes`,
        );
      }
      for (const attachment of input.attachments) {
        if (!/^[a-f0-9]{64}$/i.test(attachment.contentSha256)) {
          throw new PendingSendStoreError(
            'invalid-record',
            `附件 ${attachment.name} 缺少合法的 contentSha256`,
          );
        }
        if (!attachment.stagedUri) {
          throw new PendingSendStoreError(
            'invalid-record',
            `附件 ${attachment.name} 缺少私有暂存路径`,
          );
        }
      }
      if (!input.binding.baseUrl || !input.binding.authContextHash) {
        throw new PendingSendStoreError('invalid-record', '待发送记录缺少服务绑定');
      }
      const requestId = this.idFactory();
      if (doc.records.some((r) => r.requestId === requestId)) {
        throw new PendingSendStoreError('duplicate-request-id', '生成到重复 requestId');
      }
      const record: PendingSendRecord = {
        schema: PENDING_SEND_SCHEMA,
        requestId,
        sessionId: input.sessionId,
        mode: input.mode,
        text: input.text,
        attachments: input.attachments.map((a) => ({ ...a })),
        fingerprint: computeSendFingerprint(input.text, input.mode, input.attachments),
        state: 'queued',
        attemptCount: 0,
        binding: {
          ...input.binding,
          gatewayId: input.binding.gatewayId || null,
          identityQuality: input.binding.gatewayId ? 'confirmed' : 'unverifiable',
        },
        createdAt: now,
        updatedAt: now,
        expiresAt: input.expiresAt ?? now + this.ttlMs,
      };
      await this.save({ ...doc, records: [...doc.records, record] });
      return cloneRecord(record);
    });
  }

  async list(sessionId?: string): Promise<PendingSendRecord[]> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      return doc.records
        .filter((r) => sessionId === undefined || r.sessionId === sessionId)
        .map(cloneRecord);
    });
  }

  async get(requestId: string): Promise<PendingSendRecord | undefined> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      const found = doc.records.find((r) => r.requestId === requestId);
      return found ? cloneRecord(found) : undefined;
    });
  }

  async apply(requestId: string, event: PendingSendEvent): Promise<PendingSendRecord> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      const index = doc.records.findIndex((r) => r.requestId === requestId);
      if (index < 0) {
        throw new PendingSendStoreError('request-not-found', `找不到待发送记录 ${requestId}`);
      }
      const current = doc.records[index]!;
      const next = transitionPendingSend(current, event, this.now());
      const records = doc.records.slice();
      records[index] = next;
      await this.save({ ...doc, records });
      return cloneRecord(next);
    });
  }

  /**
   * 用户显式重试。只在这里允许复用旧 requestId。
   *
   * 若当前服务地址/实例/授权上下文与记录不一致，直接拒绝，绝不跨服务端重试。
   */
  async retry(requestId: string, currentBinding: CurrentServiceBinding): Promise<PendingSendRecord> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      const current = doc.records.find((r) => r.requestId === requestId);
      if (!current) {
        throw new PendingSendStoreError('request-not-found', `找不到待发送记录 ${requestId}`);
      }
      if (!canUserRetry(current)) {
        throw new PendingSendStoreError(
          'request-not-retryable',
          `状态 ${current.state} 不允许用户重试`,
        );
      }
      const verdict = evaluatePendingSendBinding(current.binding, currentBinding);
      if (!verdict.ok) throw new PendingSendBindingError(verdict.reason);

      const next = transitionPendingSend(current, { type: 'user-retry' }, this.now());
      const records = doc.records.slice();
      const index = doc.records.indexOf(current);
      records[index] = next;
      await this.save({ ...doc, records });
      return cloneRecord(next);
    });
  }

  async clearAll(): Promise<PendingSendClearResult> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      // 先清记录：记录写入失败时目录尚未动，调用方仍可重试并保留完整数据。
      try {
        await this.save({ ...doc, records: [] });
      } catch (e) {
        throw new PendingSendStoreError('write-failed', '待发送记录清除失败', e);
      }
      // 记录已清除后，目录清理失败只报告 partial；残留文件由下次启动 cleanupOrphans 继续清理。
      try {
        await this.staging.clearAll();
        return { records: 'cleared', staging: 'cleared' } as const;
      } catch {
        return { records: 'cleared', staging: 'failed' } as const;
      }
    });
  }

  /** 诊断/UI 用：当前文档统计。 */
  async stats(): Promise<{ count: number; bytes: number; revision: number }> {
    return this.runExclusive(async () => {
      const doc = this.requireDoc();
      const serialized = JSON.stringify(doc);
      return {
        count: doc.records.length,
        bytes: utf8ByteLength(serialized),
        revision: doc.revision,
      };
    });
  }
}
