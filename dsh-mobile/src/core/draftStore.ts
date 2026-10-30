/**
 * 会话输入草稿持久化（F-04）。
 *
 * ## 要解决什么
 *
 * 用户在输入框里写了一半就切会话 / 返回列表 / App 被杀，再回来时文字没了。
 * 这里按 `sessionId` 保存未发送的**文本草稿**，并在重新进入会话时恢复。
 *
 * ## 设计取舍
 *
 * - **按 sessionId 独立**：多会话互不串稿；
 * - **300ms 防抖写盘**：每敲一个字都写 AsyncStorage 会卡输入法；
 * - **上限 50 条**：按 `updatedAt` 保留最近更新的 50 个非空会话，防止无限膨胀；
 * - **过期与已删除会话清理**：`prune()` 会删掉超过 30 天的草稿，以及调用方传入的
 *   「当前仍存在的 sessionId 集合」之外的记录（会话被删后不留残稿）；
 * - **隐私**：草稿是用户输入，可能含敏感信息。这里**不写入日志、不做网络同步**，
 *   只落在 App 私有目录的 AsyncStorage（Android 上位于应用沙箱
 *   `/data/data/<pkg>/...`，其他应用不可读；不额外加密是因为输入法级别的
 *   高频写入需要低延迟，而 Keystore 逐次加解密在 300ms 防抖窗口内会明显卡顿）。
 *   彻底「退出并清除所有授权」时调用 `clearAll()` 一并删除（见 App.tsx）。
 * - **不做附件持久化**：附件已有 PendingSend 暂存机制；草稿只保存文本，避免复制大文件。
 *
 * ## 不碰什么
 *
 * 只读写本模块自己的 AsyncStorage key，不接触 PendingSend 状态机、通信、认证与审批。
 */
import type { DraftRecord, DraftStorageLike } from './draftTypes';

export type { DraftRecord, DraftStorageLike } from './draftTypes';

/** 持久化 key：不要改，改了会让老草稿失效 */
export const DRAFT_STORAGE_KEY = '@dsh/chatDrafts';

/** 防抖写盘窗口 */
export const DRAFT_DEBOUNCE_MS = 300;
/** 最多保留多少条非空会话草稿 */
export const MAX_DRAFTS = 50;
/**
 * 单条草稿的**输入上限**（由输入框 `maxLength` 强制，达到上限时界面给出可见提示）。
 *
 * 注意：存储层**绝不做静默截断** —— 用户输入多少就存多少。这个常量只用于
 * 输入框限制与提示文案，避免「打字打一半被悄悄吞掉」。
 */
export const MAX_DRAFT_CHARS = 20_000;
/** 草稿过期时间：30 天没动过就清掉 */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 解析持久化 JSON。
 *
 * 容错：非法 JSON / 结构不对 / 空文本一律丢弃；同 sessionId 取 updatedAt 最新的一条。
 */
export function parseDrafts(raw: string | null): DraftRecord[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const bySession = new Map<string, DraftRecord>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<DraftRecord>;
    if (typeof r.sessionId !== 'string' || !r.sessionId) continue;
    if (typeof r.text !== 'string' || !r.text.trim()) continue;
    const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0;
    const prev = bySession.get(r.sessionId);
    if (!prev || updatedAt >= prev.updatedAt) {
      bySession.set(r.sessionId, {
        sessionId: r.sessionId,
        // 不截断：历史/异常数据原样保留，避免静默丢字
        text: r.text,
        updatedAt,
      });
    }
  }
  return [...bySession.values()];
}

/** 序列化（按 updatedAt 倒序，方便调试和裁剪） */
export function serializeDrafts(records: readonly DraftRecord[]): string {
  const sorted = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  return JSON.stringify(sorted);
}

/**
 * 清理：过期、空文本、不存在的会话、超过上限。
 *
 * @param knownSessionIds 当前服务端仍存在的会话；不传则不做「已删除会话」清理
 */
export function pruneDrafts(
  records: readonly DraftRecord[],
  opts: { now: number; knownSessionIds?: ReadonlySet<string>; max?: number; ttlMs?: number },
): DraftRecord[] {
  const max = opts.max ?? MAX_DRAFTS;
  const ttl = opts.ttlMs ?? DRAFT_TTL_MS;
  // 只有拿到非空的完整会话列表时才按会话 ID 淘汰，防止列表尚未加载完时误删全部草稿
  const checkKnown = !!opts.knownSessionIds && opts.knownSessionIds.size > 0;
  const kept = records.filter((r) => {
    if (!r.text.trim()) return false;
    if (opts.now - r.updatedAt > ttl) return false;
    if (checkKnown && !opts.knownSessionIds!.has(r.sessionId)) return false;
    return true;
  });
  kept.sort((a, b) => b.updatedAt - a.updatedAt);
  return kept.slice(0, max);
}

/** 默认存储：懒加载 AsyncStorage，避免在 Node 单测里拉入原生模块 */
function defaultStorage(): DraftStorageLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@react-native-async-storage/async-storage');
  return (mod?.default ?? mod) as DraftStorageLike;
}

export class ComposerDraftStore {
  private storage: DraftStorageLike | null;
  private readonly storageFactory: () => DraftStorageLike;
  private readonly map = new Map<string, DraftRecord>();
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 写入串行链：保证落盘顺序与内存最新状态一致，防止旧快照覆盖新状态 */
  private persistChain: Promise<void> = Promise.resolve();
  /** 用户已主动输入过的 session：hydrate 时不能用磁盘旧值覆盖 */
  private touched = new Set<string>();
  /** clearAll 代际号：使进行中的 ensureHydrated 读取失效，防止清完后被慢读复活 */
  private clearEpoch = 0;
  private listeners = new Set<() => void>();

  constructor(storage?: DraftStorageLike, storageFactory: () => DraftStorageLike = defaultStorage) {
    this.storage = storage ?? null;
    this.storageFactory = storageFactory;
  }

  private getStorage(): DraftStorageLike {
    if (!this.storage) this.storage = this.storageFactory();
    return this.storage;
  }

  /** 幂等加载；失败按「无草稿」处理，不阻塞输入 */
  async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydrating) return this.hydrating;
    const epochAtStart = this.clearEpoch;
    this.hydrating = (async () => {
      try {
        const raw = await this.getStorage().getItem(DRAFT_STORAGE_KEY);
        if (this.clearEpoch !== epochAtStart) return;
        for (const rec of parseDrafts(raw)) {
          // 用户在 hydrate 完成前已经输入过的会话，以内存中的新内容为准
          if (this.touched.has(rec.sessionId)) continue;
          const prev = this.map.get(rec.sessionId);
          if (!prev || rec.updatedAt >= prev.updatedAt) this.map.set(rec.sessionId, rec);
        }
      } catch {
        // 读不到就当没有草稿
      } finally {
        this.hydrated = true;
        this.hydrating = null;
        this.emit();
      }
    })();
    return this.hydrating;
  }

  get(sessionId: string): string {
    return this.map.get(sessionId)?.text ?? '';
  }

  has(sessionId: string): boolean {
    return !!this.map.get(sessionId)?.text.trim();
  }

  list(): DraftRecord[] {
    return [...this.map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  size(): number {
    return this.map.size;
  }

  /** 更新草稿（空文本 = 删除），300ms 防抖落盘 */
  set(sessionId: string, text: string): void {
    if (!sessionId) return;
    this.touched.add(sessionId);
    if (!text.trim()) {
      if (this.map.delete(sessionId)) this.schedulePersist();
      this.emit();
      return;
    }
    // 不截断：输入上限由输入框 maxLength + 可见提示负责
    this.map.set(sessionId, { sessionId, text, updatedAt: Date.now() });
    // 限制总量：超过上限时淘汰最久未更新的草稿
    if (this.map.size > MAX_DRAFTS) {
      const sorted = [...this.map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const rec of sorted.slice(MAX_DRAFTS)) this.map.delete(rec.sessionId);
    }
    this.schedulePersist();
    this.emit();
  }

  /** 立即删除某会话草稿（发送入队成功后调用） */
  async clear(sessionId: string): Promise<void> {
    if (!sessionId) return;
    this.touched.add(sessionId);
    const changed = this.map.delete(sessionId);
    this.emit();
    if (changed) await this.enqueuePersist();
  }

  /**
   * 清理过期 / 已删除会话的草稿。
   * @returns 被清理的条数
   */
  async prune(knownSessionIds?: Iterable<string>): Promise<number> {
    const known = knownSessionIds ? new Set(knownSessionIds) : undefined;
    const before = this.map.size;
    const kept = pruneDrafts([...this.map.values()], { now: Date.now(), knownSessionIds: known });
    this.map.clear();
    for (const rec of kept) this.map.set(rec.sessionId, rec);
    const removed = before - this.map.size;
    if (removed > 0) await this.enqueuePersist();
    else this.emit();
    return removed;
  }

  /**
   * 彻底清除（退出并清除所有授权时调用）。
   *
   * 无论当前内存是否已 hydrate，都必须在写串行链末尾执行 removeItem 并回读确认；
   * 删除抛错或回读仍有残留时一律抛错，由调用方如实报告失败。
   */
  async clearAll(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearEpoch += 1;
    this.hydrated = true;
    for (const id of this.map.keys()) this.touched.add(id);
    this.map.clear();
    this.emit();
    // 串行化：排在所有已排队的旧写入之后，确保最终状态是「空」
    await this.enqueuePersist();
    await this.getStorage().removeItem(DRAFT_STORAGE_KEY);
    const remaining = await this.getStorage().getItem(DRAFT_STORAGE_KEY);
    if (remaining !== null) {
      throw new Error('draft-storage-not-cleared');
    }
  }

  /** 把防抖中的变更立即写盘（页面卸载 / 切后台时调用） */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.enqueuePersist();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 单个监听器失败不影响其它 */
      }
    }
  }

  private schedulePersist(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueuePersist();
    }, DRAFT_DEBOUNCE_MS);
  }

  /**
   * 把一次落盘排到串行链末尾。
   *
   * 关键：`persistNow()` 在真正执行时才读取 `this.list()`，所以即使前一次
   * 写入还在途中，后加入的写入也会拿到「最新内存状态」；配合串行链保证
   * 磁盘最终状态与内存一致，不会出现「已清除的草稿被旧写入复活」。
   */
  private enqueuePersist(): Promise<void> {
    const run = () => this.persistNow();
    this.persistChain = this.persistChain.then(run, run);
    return this.persistChain;
  }

  private async persistNow(): Promise<void> {
    try {
      const records = this.list();
      if (records.length === 0) {
        await this.getStorage().removeItem(DRAFT_STORAGE_KEY);
      } else {
        await this.getStorage().setItem(DRAFT_STORAGE_KEY, serializeDrafts(records));
      }
    } catch {
      // 写失败不阻塞输入；内容仍在内存里，下次变更会重试
    }
  }
}

/** 全局单例（App 与列表页共用，保证草稿标记实时） */
export const draftStore = new ComposerDraftStore();
