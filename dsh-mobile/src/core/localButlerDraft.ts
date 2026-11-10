/**
 * 本机管家输入草稿（P3）。
 *
 * 使用独立 key，**不复用** `@dsh/chatDrafts`：
 *   - 电脑管家聊天草稿属于桌面会话，按 sessionId 存在 chatDrafts 里；
 *   - 本机管家没有桌面 sessionId，草稿只属于「本机」这一侧。
 *
 * 这样切换运行位置时，两边不会显示对方的半截输入，也不会因为一边清空
 * 草稿而误删另一边的记录。
 */
import type { HostLocationStorage } from './hostLocation';

export interface LocalButlerDraft {
  text: string;
  updatedAt: number;
}

export const LOCAL_BUTLER_DRAFT_KEY = '@dsh/localButlerDraft';
/** 与聊天输入上限一致，避免同一段文字在两种界面里被不同长度截断。 */
export const MAX_LOCAL_DRAFT_CHARS = 20_000;

export function parseLocalButlerDraft(raw: string | null): LocalButlerDraft | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.text !== 'string' || !row.text.trim()) return null;
    const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
    return { text: row.text.slice(0, MAX_LOCAL_DRAFT_CHARS), updatedAt };
  } catch {
    return null;
  }
}

export async function loadLocalButlerDraft(storage: HostLocationStorage): Promise<LocalButlerDraft | null> {
  try {
    return parseLocalButlerDraft(await storage.getItem(LOCAL_BUTLER_DRAFT_KEY));
  } catch {
    return null;
  }
}

export async function saveLocalButlerDraft(
  storage: HostLocationStorage,
  text: string,
  now = Date.now(),
): Promise<void> {
  try {
    if (!text.trim()) {
      await storage.setItem(LOCAL_BUTLER_DRAFT_KEY, '');
      return;
    }
    await storage.setItem(
      LOCAL_BUTLER_DRAFT_KEY,
      JSON.stringify({ text: text.slice(0, MAX_LOCAL_DRAFT_CHARS), updatedAt: now }),
    );
  } catch {
    // Draft persistence is a convenience; never block sending on it.
  }
}
