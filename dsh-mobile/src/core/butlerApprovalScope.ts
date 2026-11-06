import type { ButlerTask } from './butlerTasks';

/** Exact workspace identity; Windows drive paths are case insensitive. */
export function normalizeButlerWorkspace(value: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  const path = windows ? value.replace(/\\/g, '/').toLowerCase() : value;
  return path.replace(/\/+$/, '') || '/';
}

/** Only Host task ownership can associate an independent session with the butler. */
export function butlerTaskApprovalSessions(tasks: readonly ButlerTask[], workspace: string): ReadonlySet<string> {
  const normalize = normalizeButlerWorkspace;
  const result = new Set<string>();
  if (!workspace.trim()) return result;
  const root = normalize(workspace);
  for (const task of tasks) {
    if (typeof task.id === 'string' && task.id && typeof task.cwd === 'string' &&
        normalize(task.cwd) === root && typeof task.sessionId === 'string' && task.sessionId) {
      result.add(task.sessionId);
    }
  }
  return result;
}
