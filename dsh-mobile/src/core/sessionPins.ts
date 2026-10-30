/**
 * F-07 会话置顶：本地持久化与稳定排序。
 *
 * 只保存 sessionId 列表，不碰服务端会话数据、排序字段或删除逻辑。
 * 默认存储懒加载 AsyncStorage，Node 单测可注入内存适配器。
 */

export const PINNED_SESSIONS_KEY = '@dsh/pinnedSessions';

export interface PinStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}

/** 容错读取：非数组、非字符串、重复 id 均安全处理。 */
export function parsePinnedSessions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((x): x is string => typeof x === 'string' && !!x))];
  } catch {
    return [];
  }
}

/**
 * 置顶项排到最前，其余保持原始相对顺序。
 * 置顶项之间也保持原列表顺序，避免每次刷新互相跳动。
 */
export function sortSessionsWithPins<T extends { sessionId: string }>(
  sessions: readonly T[],
  pinned: ReadonlySet<string>,
): T[] {
  return sessions
    .map((session, index) => ({ session, index, pinned: pinned.has(session.sessionId) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index)
    .map((x) => x.session);
}

function defaultStorage(): PinStorageLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@react-native-async-storage/async-storage');
  return (mod?.default ?? mod) as PinStorageLike;
}

export class SessionPinStore {
  private storage: PinStorageLike | null;
  private readonly storageFactory: () => PinStorageLike;
  private ids = new Set<string>();
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  /** 写盘串行链：保证连续快速 toggle 时底层 setItem 严格按序执行，绝不乱序覆盖 */
  private persistChain: Promise<void> = Promise.resolve();
  /** 每个 sessionId 的操作代际号：防止并发 toggle 写盘失败回滚时冲掉后续新操作或其它会话状态 */
  private sessionRev = new Map<string, number>();
  /** clearAll 代际号：使进行中的 ensureHydrated 慢读失效，防止清完后被旧数据覆盖 */
  private clearEpoch = 0;
  private listeners = new Set<() => void>();

  constructor(storage?: PinStorageLike, storageFactory: () => PinStorageLike = defaultStorage) {
    this.storage = storage ?? null;
    this.storageFactory = storageFactory;
  }

  private getStorage(): PinStorageLike {
    if (!this.storage) this.storage = this.storageFactory();
    return this.storage;
  }

  async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydrating) return this.hydrating;
    const epochAtStart = this.clearEpoch;
    this.hydrating = (async () => {
      try {
        const raw = await this.getStorage().getItem(PINNED_SESSIONS_KEY);
        if (this.clearEpoch !== epochAtStart) return;
        for (const id of parsePinnedSessions(raw)) {
          // 若用户在 hydrate 完成前已操作过该会话，以内存最新状态为准
          if (!this.sessionRev.has(id)) {
            this.ids.add(id);
          }
        }
      } catch {
        // 读不到就按没有置顶处理，不阻塞列表
      } finally {
        this.hydrated = true;
        this.hydrating = null;
        this.emit();
      }
    })();
    return this.hydrating;
  }

  isPinned(sessionId: string): boolean {
    return this.ids.has(sessionId);
  }

  list(): string[] {
    return [...this.ids];
  }

  /**
   * 切换置顶并串行化落盘。
   *
   * - 连续快速调用时，内存立即更新，落盘按 `persistChain` 排队依次执行，
   *   每次写入真正执行时才读取当前最新 `this.list()`，杜绝慢写覆盖快写；
   * - 写盘失败时只在该 sessionId 未被后续操作再次修改时回滚该项，不冲掉其它会话的置顶变更。
   */
  async toggle(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    await this.ensureHydrated();
    const prevPinned = this.ids.has(sessionId);
    const nextPinned = !prevPinned;
    const rev = (this.sessionRev.get(sessionId) ?? 0) + 1;
    this.sessionRev.set(sessionId, rev);
    if (nextPinned) this.ids.add(sessionId);
    else this.ids.delete(sessionId);
    this.emit();

    try {
      await this.enqueuePersist();
      return nextPinned;
    } catch (e) {
      if (this.sessionRev.get(sessionId) === rev) {
        if (prevPinned) this.ids.add(sessionId);
        else this.ids.delete(sessionId);
        this.emit();
      }
      throw e;
    }
  }

  /** 删除会话时同步移除其置顶记录（若存在）。 */
  async remove(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await this.ensureHydrated();
    const rev = (this.sessionRev.get(sessionId) ?? 0) + 1;
    this.sessionRev.set(sessionId, rev);
    if (!this.ids.delete(sessionId)) return;
    this.emit();
    await this.enqueuePersist();
  }

  /** 退出并清除所有授权时清空置顶记录。 */
  async clearAll(): Promise<void> {
    this.clearEpoch += 1;
    this.hydrated = true;
    for (const id of this.ids) {
      this.sessionRev.set(id, (this.sessionRev.get(id) ?? 0) + 1);
    }
    this.ids.clear();
    this.emit();
    const run = async () => {
      const st = this.getStorage();
      if (typeof st.removeItem === 'function') {
        await st.removeItem(PINNED_SESSIONS_KEY);
      } else {
        await st.setItem(PINNED_SESSIONS_KEY, '[]');
      }
    };
    const next = this.persistChain.then(run, run);
    this.persistChain = next.catch(() => undefined);
    await next;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueuePersist(): Promise<void> {
    const run = async () => {
      await this.getStorage().setItem(PINNED_SESSIONS_KEY, JSON.stringify(this.list()));
    };
    const next = this.persistChain.then(run, run);
    this.persistChain = next.catch(() => undefined);
    return next;
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 单个监听器失败不影响其他监听器 */
      }
    }
  }
}

export const sessionPinStore = new SessionPinStore();
