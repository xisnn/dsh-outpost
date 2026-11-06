import {RpcError} from './rpc-error';

export interface ContentHit {sessionId: string; snippet: string}
export interface ContentSearchPage {items: ContentHit[]; hasMore: boolean}
export type ContentSearchStatus = 'idle' | 'pending' | 'ready' | 'unsupported' | 'failed' | 'too-long';
export interface ContentSearchState extends ContentSearchPage {query: string; status: ContentSearchStatus}
export const emptyContentSearch = (): ContentSearchState => ({query: '', status: 'idle', items: [], hasMore: false});
export const contentQueryKey = (query: string): string => query.trim().replace(/\s+/g, ' ').toLowerCase();

export function parseContentSearch(value: unknown): ContentSearchPage {
  const data = value as Partial<ContentSearchPage> | null;
  if (!data || !Array.isArray(data.items) || data.items.length > 20 ||
      (data.hasMore !== undefined && typeof data.hasMore !== 'boolean')) throw new Error('正文搜索返回格式无效');
  const seen = new Set<string>();
  const items: ContentHit[] = [];
  for (const item of data.items) {
    if (!item || typeof item.sessionId !== 'string' || !item.sessionId || item.sessionId.length > 512 ||
        typeof item.snippet !== 'string' || item.snippet.length > 4000) throw new Error('正文搜索命中格式无效');
    if (!seen.has(item.sessionId)) {items.push({sessionId: item.sessionId, snippet: item.snippet}); seen.add(item.sessionId);}
  }
  return {items, hasMore: data.hasMore === true};
}
export function contentSearchUnsupported(error: unknown): boolean {
  if (!(error instanceof RpcError)) return false;
  if (error.kind === 'http') return /^HTTP (404|405)\b/.test(error.raw);
  if (error.kind !== 'rpc') return false;
  return /^gateway\/(?:method-unavailable|service-unavailable|lookup-unavailable|not-found)\b/.test(error.raw) ||
    /^gateway\/internal\s+(?:session\s+)?search\s+is\s+(?:disabled|unavailable)\b/i.test(error.raw) ||
    /^gateway\/internal\s+search_disabled\b/i.test(error.raw);
}

type Schedule = (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
/** Only committed input is submitted. Query, timeout and disposal each retire late replies. */
export class ContentSearchController {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private unsupported = false;
  private state = emptyContentSearch();
  constructor(
    private readonly read: (query: string) => Promise<ContentSearchPage>,
    private readonly publish: (state: ContentSearchState) => void,
    private readonly schedule: Schedule = setTimeout,
    private readonly unschedule: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}
  private retire(): number {
    if (this.timer !== undefined) this.unschedule(this.timer);
    if (this.deadline !== undefined) this.unschedule(this.deadline);
    this.timer = this.deadline = undefined;
    return ++this.generation;
  }
  cancel(): void {
    this.retire();
    if (!this.closed) {this.state = emptyContentSearch(); this.publish(this.state);}
  }
  input(query: string): void {
    if (contentQueryKey(query) !== contentQueryKey(this.state.query)) this.cancel();
  }
  submit(text: string, retry = false): void {
    if (this.closed) return;
    const query = text.trim();
    if (!retry && this.state.status === 'pending' && contentQueryKey(query) === contentQueryKey(this.state.query)) return;
    const generation = this.retire();
    const status: ContentSearchStatus = !query ? 'idle' : query.length > 500 ? 'too-long' : this.unsupported && !retry ? 'unsupported' : 'pending';
    this.state = {query, status, items: [], hasMore: false};
    this.publish(this.state);
    if (status !== 'pending') return;
    if (retry) this.unsupported = false;
    const finish = (next: ContentSearchState) => {
      if (this.closed || generation !== this.generation) return;
      this.retire(); this.state = next; this.publish(next);
    };
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.deadline = this.schedule(() => finish({query, status: 'failed', items: [], hasMore: false}), 20000);
      void Promise.resolve().then(() => {
        if (this.closed || generation !== this.generation) return undefined;
        return this.read(query);
      }).then(page => {
        if (page) finish({query, status: 'ready', ...page});
      }, error => {
        if (this.closed || generation !== this.generation) return;
        const unsupported = contentSearchUnsupported(error);
        if (unsupported) this.unsupported = true;
        finish({query, status: unsupported ? 'unsupported' : 'failed', items: [], hasMore: false});
      });
    }, 250);
  }
  dispose(): void {this.closed = true; this.retire();}
}
