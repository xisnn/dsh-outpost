import type { AttachmentDraft } from './pendingSend/types';

export interface SharedMessage {
  id: string;
  receivedAt: number;
  text: string;
  files: AttachmentDraft[];
  textFile?: AttachmentDraft;
  skipped: string[];
}
export interface SharedComposerDraft extends AttachmentDraft { id: string }
export type SharePresentation = 'chat' | 'butler';
interface Application { promise: Promise<boolean>; finish: (applied: boolean) => void; applied: boolean; sessionId: string }

/** Store ownership and presentation keep drafts out of another login or a hidden chat instance. */
export class SharedComposerInbox {
  private queues = new WeakMap<object, Map<string, SharedMessage[]>>();
  private applications = new WeakMap<object, Map<string, Application>>();
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  enqueue(source: object, sessionId: string, message: SharedMessage, presentation: SharePresentation = 'chat'): boolean {
    const applications = this.applications.get(source) ?? new Map<string, Application>();
    if (applications.has(message.id)) return false;
    let finish: (applied: boolean) => void = () => {};
    const promise = new Promise<boolean>(resolve => { finish = resolve; });
    applications.set(message.id, { promise, finish, applied: false, sessionId });
    this.applications.set(source, applications);
    const queues = this.queues.get(source) ?? new Map<string, SharedMessage[]>();
    const key = JSON.stringify([presentation, sessionId]);
    queues.set(key, [...(queues.get(key) ?? []), message]);
    this.queues.set(source, queues);
    for (const listener of this.listeners) listener();
    return true;
  }
  waitApplied(source: object, id: string): Promise<boolean> {
    return this.applications.get(source)?.get(id)?.promise ?? Promise.resolve(false);
  }
  appliedDestination(source: object, id: string): string | undefined {
    const item = this.applications.get(source)?.get(id);
    return item?.applied ? item.sessionId : undefined;
  }
  isApplied(source: object, id: string): boolean {
    return this.applications.get(source)?.get(id)?.applied ?? false;
  }
  complete(source: object, id: string): void {
    const application = this.applications.get(source)?.get(id);
    if (application) { application.applied = true; application.finish(true); }
  }
  cancel(source: object, id: string): void {
    const applications = this.applications.get(source);
    const application = applications?.get(id);
    if (!application || application.applied) return;
    for (const [key, messages] of this.queues.get(source) ?? []) {
      this.queues.get(source)?.set(key, messages.filter(message => message.id !== id));
    }
    applications?.delete(id);
    application.finish(false);
  }
  take(source: object, sessionId: string, presentation: SharePresentation = 'chat'): SharedMessage[] {
    const queues = this.queues.get(source);
    const key = JSON.stringify([presentation, sessionId]);
    const messages = queues?.get(key) ?? [];
    queues?.delete(key);
    return messages;
  }
}

export function mergeSharedMessage(
  currentText: string, currentFiles: readonly SharedComposerDraft[], message: SharedMessage, maxChars: number,
): { text: string; files: SharedComposerDraft[]; textAsFile: boolean } {
  const combined = currentText && message.text ? `${currentText}\n\n${message.text}` : currentText || message.text;
  const textAsFile = combined.length > maxChars && !!message.text;
  if (textAsFile && !message.textFile) throw new Error('分享文字超出草稿上限，缺少 TXT 副本，请重新分享');
  const incoming = [...message.files, ...(textAsFile && message.textFile ? [message.textFile] : [])];
  const known = new Set(currentFiles.map(file => file.id));
  const files = [...currentFiles];
  incoming.forEach((file, index) => {
    const id = `share:${message.id}:${index}`;
    if (!known.has(id)) { files.push({ ...file, id }); known.add(id); }
  });
  return { text: textAsFile ? currentText : combined, files, textAsFile };
}

export const sharedComposerInbox = new SharedComposerInbox();
