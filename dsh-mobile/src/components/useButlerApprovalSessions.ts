import { useEffect, useMemo, useState } from 'react';
import type { ButlerTask } from '../core/butlerTasks';
import { butlerTaskApprovalSessions } from '../core/butlerApprovalScope';

interface TaskSource { listButlerTasks(): Promise<ButlerTask[]> }
interface Request { rpcId: string; sessionId: string }

/** Resolve task ownership only while another session actually needs an answer. */
export function useButlerApprovalSessions(
  source: TaskSource, sessionId: string, workspace: string, enabled: boolean,
  requests: readonly Request[],
): ReadonlySet<string> {
  const scope = useMemo(() => ({}), [source, sessionId, workspace, enabled]);
  const [resolved, setResolved] = useState<{ scope: object; sessions: ReadonlySet<string> } | null>(null);
  const requestKey = JSON.stringify(requests.filter(a => a.sessionId && a.sessionId !== sessionId).map(a => [a.rpcId, a.sessionId]).sort());
  useEffect(() => {
    if (!enabled || !workspace || requestKey === '[]') return;
    let alive = true;
    void source.listButlerTasks().then(tasks => {
      if (alive) setResolved({ scope, sessions: butlerTaskApprovalSessions(tasks, workspace) });
    }).catch(() => {
      if (alive) setResolved(null);
    });
    return () => { alive = false; };
  }, [source, scope, enabled, workspace, requestKey]);
  return resolved?.scope === scope ? resolved.sessions : EMPTY;
}
const EMPTY: ReadonlySet<string> = new Set();
