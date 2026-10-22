/**
 * 会话搜索（纯逻辑，不依赖 React Native）。
 *
 * 单独放这里是为了能直接单测 —— 从 .tsx 里 import 会把整个 react-native
 * 拖进来，esbuild 解析不了（踩过）。
 */

/**
 * 按标题过滤会话。
 *
 * 边界情况比看起来多：大小写、前后空格、标题为 null/空、
 * 多个关键词、没有 projections 的脏数据。
 *
 * 多关键词用 AND（全部命中）—— 符合「越输越窄」的直觉。
 */
export function filterSessions<T>(sessions: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return sessions;
  const words = q.split(/\s+/).filter(Boolean);
  return sessions.filter((item) => {
    const values = (item as {
      projections?: { values?: { title?: unknown } };
    }).projections?.values;
    const raw = values?.title;
    const title = typeof raw === 'string' ? raw.toLowerCase() : '';
    return words.every((w) => title.includes(w));
  });
}
