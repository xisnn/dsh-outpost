/** A Host withdrawal receipt is independent of a mounted ChatScreen.
 * Save the original before the write; only accepted receipts can become drafts.
 * Bind copies to the exact authenticated Host without persisting its cookie.
 */
import {sha256Hex} from './pendingSend/fingerprint';
import type {HostQueueItem} from './conversationActions';

export const WITHDRAWAL_STORAGE_KEY = '@dsh/withdrawalRecovery';
export interface WithdrawalCopy {
  scope: string; sessionId: string; itemId: string; text: string;
  state: 'unconfirmed' | 'confirmed'; restored: boolean;
}
interface Storage {getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void>}
export function withdrawalScope(baseUrl: string, cookie?: string): string {
  return sha256Hex(JSON.stringify([baseUrl.replace(/\/+$/, ''), cookie ?? '']));
}
export class WithdrawalRecovery {
  private rows: WithdrawalCopy[] = [];
  private ready?: Promise<void>;
  private chain: Promise<void> = Promise.resolve();
  private epoch = 0;
  private listeners = new Set<() => void>();
  constructor(private storageFactory: () => Storage = () => {
    const mod = require('@react-native-async-storage/async-storage');
    return mod.default ?? mod;
  }) {}
  subscribe(fn: () => void) {this.listeners.add(fn); return () => {this.listeners.delete(fn);};}
  private emit() {for (const fn of this.listeners) fn();}
  async hydrate() {
    if (!this.ready) {
      const epoch = this.epoch;
      this.ready = this.storageFactory().getItem(WITHDRAWAL_STORAGE_KEY).then(raw => {
        const rows: unknown = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(rows) || rows.some(r => !r || typeof r.scope !== 'string' || typeof r.sessionId !== 'string' ||
            typeof r.itemId !== 'string' || typeof r.text !== 'string' || !['unconfirmed','confirmed'].includes(r.state) || typeof r.restored !== 'boolean')) {
          throw new Error('撤回文字副本无法读取');
        }
        if (epoch === this.epoch) {this.rows = rows; this.emit();}
      }).catch(error => {this.ready = undefined; throw error;});
    }
    await this.ready;
  }
  list(scope: string, sessionId: string) {return this.rows.filter(r => r.scope === scope && r.sessionId === sessionId).map(r => ({...r}));}
  private persist() {
    const run = () => this.storageFactory().setItem(WITHDRAWAL_STORAGE_KEY, JSON.stringify(this.rows));
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
  async prepare(scope: string, item: HostQueueItem) {
    const epoch = this.epoch;
    await this.hydrate();
    if (epoch !== this.epoch) throw new Error('授权已清除');
    if (this.rows.some(r => r.scope === scope && r.sessionId === item.sessionId && r.itemId === item.itemId)) throw new Error('这条消息已有撤回记录，请先核对处理结果');
    if (this.rows.length >= 50) throw new Error('请先清理已保存的撤回副本');
    const copy: WithdrawalCopy = {scope, sessionId:item.sessionId, itemId:item.itemId, text:item.text, state:'unconfirmed', restored:false};
    this.rows.push(copy); this.emit();
    await this.persist(); // Storage failure must prevent the Host write.
    return {copy, epoch};
  }
  async confirm(ticket: {copy: WithdrawalCopy; epoch: number}, item: HostQueueItem) {
    if (ticket.epoch !== this.epoch || !this.rows.includes(ticket.copy)) throw new Error('授权已清除，撤回副本未恢复');
    if (item.itemId !== ticket.copy.itemId || item.sessionId !== ticket.copy.sessionId) throw new Error('撤回回执身份不匹配');
    ticket.copy.text = item.text;
    ticket.copy.state = 'confirmed'; this.emit();
    await this.persist();
    return {...ticket.copy};
  }
  async markRestored(copy: WithdrawalCopy) {
    const row = this.rows.find(r => r.scope === copy.scope && r.sessionId === copy.sessionId && r.itemId === copy.itemId);
    if (!row || row.state !== 'confirmed') throw new Error('尚未确认撤回，不能恢复草稿');
    row.restored = true; this.emit(); await this.persist();
  }
  async discard(copy: WithdrawalCopy) {
    this.rows = this.rows.filter(r => !(r.scope === copy.scope && r.sessionId === copy.sessionId && r.itemId === copy.itemId));
    this.emit(); await this.persist();
  }
  async clearAll() {
    this.epoch++; this.rows = []; this.ready = Promise.resolve(); this.emit();
    await this.persist(); await this.storageFactory().removeItem(WITHDRAWAL_STORAGE_KEY);
    if (await this.storageFactory().getItem(WITHDRAWAL_STORAGE_KEY) !== null) throw new Error('撤回副本未清除');
  }
}
export const withdrawalRecovery = new WithdrawalRecovery();

export function mergeWithdrawnDraft(draft: string, copy: WithdrawalCopy, maxLength: number): string {
  if (copy.state !== 'confirmed') throw new Error('Host 尚未确认撤回，不会恢复草稿');
  const merged = draft ? `${draft}\n\n${copy.text}` : copy.text;
  if (merged.length > maxLength) throw new Error('现有草稿空间不足，撤回文字已保存在副本中');
  return merged;
}
