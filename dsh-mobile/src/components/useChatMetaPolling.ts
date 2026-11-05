import { useEffect } from 'react';
import { AppState } from 'react-native';

interface MetaSource { refreshChatMeta(sessionId: string): Promise<void> }

/** UI polling only; global team completion monitoring remains owned by Store. */
export function useChatMetaPolling(source: MetaSource, sessionId: string, visible: boolean, enabled: boolean, busy: boolean) {
  useEffect(() => {
    if (!visible || !enabled) return;
    let active = false;
    let disposed = false;
    let epoch = 0;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { epoch += 1; if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const refresh = async () => {
      if (!active || pending) return;
      pending = true;
      try { await source.refreshChatMeta(sessionId); }
      catch { /* A failed refresh must not break the next foreground attempt. */ }
      finally {
        pending = false;
        if (active) {
          const generation = epoch;
          timer = setTimeout(() => {
            if (generation !== epoch || !active) return;
            timer = undefined;
            void refresh();
          }, busy ? 2000 : 15000);
        }
      }
    };
    const onState = (state: string | null) => {
      if (disposed) return;
      const next = state === 'active';
      if (next === active) return;
      active = next;
      clear();
      if (active) void refresh();
    };
    const subscription = AppState.addEventListener('change', onState);
    onState(AppState.currentState);
    return () => { disposed = true; active = false; clear(); subscription.remove(); };
  }, [source, sessionId, visible, enabled, busy]);
}
