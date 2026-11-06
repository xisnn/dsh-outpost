import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { AttachmentDraft } from './pendingSend/types';
import type { SharedMessage } from './sharedComposer';

interface ShareNative {
  listPending(): Promise<string>;
  acknowledge(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  addListener(name: string): void;
  removeListeners(count: number): void;
}
const native = (): ShareNative | undefined => Platform.OS === 'android' ? NativeModules.OutpostShareInbox : undefined;
function file(value: unknown): AttachmentDraft {
  const f = value as AttachmentDraft;
  if (!f || !['file', 'image'].includes(f.kind) || typeof f.uri !== 'string' || !f.uri.startsWith('file://') ||
      typeof f.name !== 'string' || typeof f.size !== 'number' || !Number.isFinite(f.size) || f.size < 0 ||
      f.size > 50 * 1024 * 1024 || (f.mime !== undefined && typeof f.mime !== 'string')) throw new Error('分享文件数据无效');
  return { kind: f.kind, uri: f.uri, name: f.name, size: f.size, mime: f.mime };
}
export function parseSharedMessages(raw: string): SharedMessage[] {
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 8) throw new Error('分享收件箱数据无效');
  return values.map(value => {
    if (!value || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id) || typeof value.text !== 'string' ||
        value.text.length > 2 * 1024 * 1024 || (value.text.length > 0 && !value.textFile) || !Number.isFinite(value.receivedAt) ||
        !Array.isArray(value.files) || value.files.length > 16 || !Array.isArray(value.skipped) ||
        value.skipped.some((item: unknown) => typeof item !== 'string')) throw new Error('分享内容数据无效');
    return { id: value.id, text: value.text, receivedAt: value.receivedAt,
      files: value.files.map(file), textFile: value.textFile ? file(value.textFile) : undefined, skipped: value.skipped };
  });
}
export async function listSharedMessages(): Promise<SharedMessage[]> {
  const bridge = native();
  return bridge ? parseSharedMessages(await bridge.listPending()) : [];
}
export function subscribeSharedMessages(listener: () => void): () => void {
  const bridge = native();
  if (!bridge) return () => undefined;
  const subscription = new NativeEventEmitter(bridge).addListener('OutpostShareInboxChanged', listener);
  return () => subscription.remove();
}
export async function acknowledgeSharedMessage(id: string): Promise<void> { await native()?.acknowledge(id); }
export async function discardSharedMessage(id: string): Promise<void> { await native()?.discard(id); }
