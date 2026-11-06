import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_DRAFT_CHARS } from '../core/draftStore';
import { mergeSharedMessage, sharedComposerInbox, type SharedComposerDraft, type SharePresentation } from '../core/sharedComposer';

/** Wait for draft hydration and the visible destination; acknowledge only after a React commit. */
export function useSharedComposer(options: {
  source: object; sessionId: string; presentation: SharePresentation; ready: boolean; enabled: boolean;
  text: string; files: SharedComposerDraft[];
  apply: (value: {text: string; files: SharedComposerDraft[]; textAsFile: boolean}) => void;
  onError: (message: string) => void;
}): void {
  const {source, sessionId, presentation, ready, enabled} = options;
  const scope = useMemo(() => ({}), [source, sessionId, presentation]);
  const live = useRef({...options, scope});
  live.current = {...options, scope};
  const [committed, setCommitted] = useState<Array<{source: object; id: string}>>([]);
  const awaiting = useRef<Array<{source: object; id: string}>>([]);
  useEffect(() => {
    for (const item of committed) {
      sharedComposerInbox.complete(item.source, item.id);
      awaiting.current = awaiting.current.filter(value => value !== item);
    }
    if (committed.length) setCommitted([]);
  }, [committed]);
  useEffect(() => () => {
    for (const item of awaiting.current) sharedComposerInbox.cancel(item.source, item.id);
    awaiting.current = [];
  }, [scope]);
  useEffect(() => {
    if (!ready || !enabled) return;
    const consume = () => {
      const current = live.current;
      if (current.scope !== scope || !current.ready || !current.enabled) return;
      for (const message of sharedComposerInbox.take(source, sessionId, presentation)) {
        try {
          const merged = mergeSharedMessage(current.text, current.files, message, MAX_DRAFT_CHARS);
          current.text = merged.text;
          current.files = merged.files;
          current.apply(merged);
          const item = {source, id: message.id};
          awaiting.current.push(item);
          setCommitted(items => [...items, item]);
        } catch {
          sharedComposerInbox.cancel(source, message.id);
          current.onError('分享未能加入草稿，请重新选择目标会话');
        }
      }
    };
    const unsubscribe = sharedComposerInbox.subscribe(consume);
    consume();
    return unsubscribe;
  }, [scope, source, sessionId, presentation, ready, enabled]);
}
