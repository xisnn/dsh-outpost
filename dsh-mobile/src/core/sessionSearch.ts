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

export interface GlobalSessionResult<T = unknown> {
  session: T;
  workspacePath: string;
  workspaceName: string;
  /** Host-provided message excerpt; absent for local-only matches. */
  snippet?: string;
}

/**
 * 跨工作区搜索：标题、sessionId、目录与工作区名均参与匹配。
 * 结果保持原工作区/会话的既有顺序，不额外重排。
 */
export function searchSessionsAcrossWorkspaces<
  T extends {
    sessionId: string;
    cwd?: string;
    projections?: { values?: { title?: unknown } };
  },
  W extends { path: string; name: string; sessions: T[] },
>(workspaces: readonly W[], query: string): GlobalSessionResult<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const results: GlobalSessionResult<T>[] = [];
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      const rawTitle = session.projections?.values?.title;
      const title = typeof rawTitle === 'string' ? rawTitle : '';
      const haystack = [title, session.sessionId, session.cwd ?? '', workspace.path, workspace.name]
        .join('\n')
        .toLowerCase();
      if (words.every((word) => haystack.includes(word))) {
        results.push({
          session,
          workspacePath: workspace.path,
          workspaceName: workspace.name,
        });
      }
    }
  }
  return results;
}

/** Keep local ordering, append ranked content hits only for still-visible sessions. */
export function mergeContentSearch<
  T extends {sessionId: string; cwd?: string; projections?: {values?: {title?: unknown}}},
  W extends {path: string; name: string; sessions: T[]},
>(workspaces: readonly W[], query: string, hits: readonly {sessionId: string; snippet: string}[]): GlobalSessionResult<T>[] {
  if (!query.trim()) return [];
  const results = searchSessionsAcrossWorkspaces<T, W>(workspaces, query);
  const present = new Map(results.map(result => [result.session.sessionId, result]));
  const visible = new Map<string, GlobalSessionResult<T>>();
  for (const workspace of workspaces) for (const session of workspace.sessions) {
    visible.set(session.sessionId, {session, workspacePath: workspace.path, workspaceName: workspace.name});
  }
  for (const hit of hits) {
    const existing = present.get(hit.sessionId);
    if (existing) {if (existing.snippet === undefined) existing.snippet = hit.snippet; continue;}
    const target = visible.get(hit.sessionId);
    if (!target) continue;
    const result = {...target, snippet: hit.snippet};
    results.push(result); present.set(hit.sessionId, result);
  }
  return results;
}
