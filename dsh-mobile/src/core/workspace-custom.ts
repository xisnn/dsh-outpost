/**
 * 工作区本地自定义（重命名 / 头像 emoji）。
 *
 * DSH 的 cwd 是路径本身、不可改名，所以这些是**纯客户端展示层**覆盖：
 * key 用归一化后的 cwd，存在 AsyncStorage。
 */

export interface WorkspaceCustom {
  /** 自定义显示名 */
  name?: string;
  /** 头像 emoji（如 📁 🚀 🧪） */
  emoji?: string;
}

export const WORKSPACE_CUSTOM_KEY = '@dsh/workspaceCustom';

/** 可选的 emoji 头像池 */
export const EMOJI_CHOICES = [
  '📁', '💼', '🚀', '🧪', '🛠️', '📦', '🎨', '📊',
  '🤖', '🧠', '🌱', '🔥', '💡', '🗂️', '⚙️', '🎯',
];

export function applyCustom<T extends { path: string; name: string }>(
  ws: T,
  map: Record<string, WorkspaceCustom>,
): T & { emoji?: string; customName?: string } {
  const c = map[ws.path];
  if (!c) return ws;
  return {
    ...ws,
    name: c.name?.trim() || ws.name,
    emoji: c.emoji,
    customName: c.name?.trim() || undefined,
  };
}
