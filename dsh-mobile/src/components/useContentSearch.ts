import {useEffect, useMemo, useRef, useState} from 'react';
import type {Store} from '../core/store';
import {normalizeBaseUrl} from '../core/pairing';
import {ContentSearchController, contentQueryKey, emptyContentSearch, type ContentSearchState} from '../core/contentSearch';

export function useContentSearch(store: Store, baseUrl: string, query: string) {
  const owner = useMemo(() => ({}), [store, baseUrl]);
  const allowed = () => !store.authInvalidated && store.connection === 'connected' &&
    normalizeBaseUrl(store.fileBaseUrl) === normalizeBaseUrl(baseUrl);
  const available = allowed();
  const live = useRef(owner);
  live.current = owner;
  const mounted = useRef(false);
  const [snapshot, setSnapshot] = useState<{owner: object; state: ContentSearchState}>(() => ({owner, state: emptyContentSearch()}));
  const controller = useMemo(() => new ContentSearchController(
    text => {
      if (live.current !== owner || !mounted.current || !allowed()) throw new Error('聊天连接不可用');
      return store.searchSessions(text);
    },
    state => {if (mounted.current && live.current === owner) setSnapshot({owner, state});},
  ), [owner, store]);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => () => controller.dispose(), [controller]);
  useEffect(() => {if (!available) controller.cancel();}, [available, controller]);
  const state = available && snapshot.owner === owner && contentQueryKey(snapshot.state.query) === contentQueryKey(query)
    ? snapshot.state : emptyContentSearch();
  return {
    available, state,
    input(text: string) {if (live.current === owner && mounted.current) controller.input(text);},
    submit(text: string, retry = false) {if (live.current === owner && mounted.current && allowed()) controller.submit(text, retry);},
  };
}
