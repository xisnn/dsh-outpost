import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { Store } from '../core/store';
import { watchButlerActivity } from '../core/butlerActivity';
import { normalizeButlerWorkspace } from '../core/butlerApprovalScope';
import { normalizeBaseUrl } from '../core/pairing';
import { beginButlerActivity, isNotifyEnabled, subscribeNotifyEnabled } from '../core/notify';

/** App-level observer: the task screen and the current tab need not be open. */
export function useButlerActivity(options: {
  store: Store; baseUrl: string; workspace: string | null; sessionId: string | null;
  enabled: boolean;
}): void {
  const { store, baseUrl, workspace, sessionId, enabled } = options;
  const [notifyEnabled, setNotifyEnabled] = useState(isNotifyEnabled);
  useEffect(() => subscribeNotifyEnabled(() => setNotifyEnabled(isNotifyEnabled())), []);
  const ownsTarget = () => Platform.OS === 'android' && enabled && notifyEnabled &&
    !!baseUrl && !!workspace?.trim() && !!sessionId && normalizeBaseUrl(store.fileBaseUrl) === normalizeBaseUrl(baseUrl) &&
    !store.authInvalidated && store.gatewayStatus !== 'revoked' && store.gatewayStatus !== 'unknown' &&
    store.sessions.some(session => session.sessionId === sessionId && typeof session.cwd === 'string' &&
      normalizeButlerWorkspace(session.cwd) === normalizeButlerWorkspace(workspace));
  const available = () => ownsTarget() && store.connection === 'connected' && store.gatewayStatus === 'online';
  const allowed = available();
  const scope = useMemo(() => ({}), [store, baseUrl, workspace, sessionId, enabled, notifyEnabled]);
  const live = useRef(scope);
  const mounted = useRef(true);
  live.current = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!allowed || !workspace || !sessionId) return;
    const owns = () => mounted.current && live.current === scope && ownsTarget() && isNotifyEnabled();
    const current = () => owns() && available();
    const notification = beginButlerActivity(sessionId, current, owns);
    const stop = watchButlerActivity({
      workspace,
      list: () => store.listButlerTasks(),
      publish: value => {
        if (current()) notification.publish(value);
        else notification.close();
      },
    });
    return () => { notification.close(); stop(); };
  }, [scope, allowed, store, workspace, sessionId]);
}
