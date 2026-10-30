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
    this.hydrating = (async () => {
      try {
        const raw = await this.getStorage().getItem(PINNED_SESSIONS_KEY);
        this.ids = new Set(parsePinnedSessions(raw));
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

  /** 切换置顶并持久化；写失败回滚内存状态并抛错。 */
  async toggle(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    await this.ensureHydrated();
    const before = new Set(this.ids);
    const nextPinned = !this.ids.has(sessionId);
    if (nextPinned) this.ids.add(sessionId);
    else this.ids.delete(sessionId);
    this.emit();
    try {
      await this.getStorage().setItem(PINNED_SESSIONS_KEY, JSON.stringify(this.list()));
      return nextPinned;
    } catch (e) {
      this.ids = before;
      this.emit();
      throw e;
    }
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
        /* 单个监听器失败不影响其他监听器 */
      }
    }
  }
}

export const sessionPinStore = new SessionPinStore();
