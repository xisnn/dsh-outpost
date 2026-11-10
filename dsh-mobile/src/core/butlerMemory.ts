/**
 * P4 管家身份与用户记忆客户端。
 *
 * 两个位置各自读取自己的权威：
 *   - 电脑：已配对 Host 的 outpost-butler memory API（owner 认证）；
 *   - 本机：本机运行包里的 outpost-butler memory op（固定传输白名单）。
 *
 * 这里只提交用户显式编辑，不自动提取、不写模型、不参与工具审批。
 * 记忆数据不缓存到另一个位置，切换位置必须重新读取。
 */
import type { DshConnection } from './transport';
import type { LocalRuntimeClient } from './localRuntime';
import type { HostLocation } from './hostLocation';

export type MemoryKind = 'preference' | 'project';

export interface ButlerMemoryEntry {
  id: string;
  kind: MemoryKind;
  key: string;
  value: string;
  source: 'user';
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface ButlerMemoryChange {
  seq: number;
  at: number;
  action: 'set' | 'delete';
  id: string;
  kind?: MemoryKind;
  key?: string;
  revision?: number;
}

export interface ButlerMemorySnapshot {
  butlerId: string;
  revision: number;
  entries: ButlerMemoryEntry[];
}

export interface ButlerMemoryInput {
  id?: string;
  kind: MemoryKind;
  key: string;
  value: string;
  expectedRevision?: number;
}

export interface ButlerMemoryClient {
  readonly location: HostLocation;
  load(): Promise<ButlerMemorySnapshot>;
  history(id?: string): Promise<ButlerMemoryChange[]>;
  set(input: ButlerMemoryInput): Promise<ButlerMemoryEntry>;
  remove(id: string, expectedRevision?: number): Promise<number>;
}

const BASE = '/api/outpost/butler/memory';

function snapshot(value: unknown): ButlerMemorySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid butler memory snapshot');
  const row = value as Record<string, unknown>;
  if (typeof row.butlerId !== 'string' || !Array.isArray(row.entries)) throw new Error('Invalid butler memory snapshot');
  return row as unknown as ButlerMemorySnapshot;
}

export async function loadButlerMemory(conn: DshConnection): Promise<ButlerMemorySnapshot> {
  return snapshot(await conn.request<unknown>(BASE));
}

export async function listButlerMemoryHistory(
  conn: DshConnection,
  id?: string,
): Promise<ButlerMemoryChange[]> {
  const query = id ? `?id=${encodeURIComponent(id)}` : '';
  const res = await conn.request<{ changes?: unknown }>(`${BASE}/history${query}`);
  if (!Array.isArray(res?.changes)) throw new Error('Invalid butler memory history');
  return res.changes as ButlerMemoryChange[];
}

export async function setButlerMemory(
  conn: DshConnection,
  input: ButlerMemoryInput,
): Promise<ButlerMemoryEntry> {
  const res = await conn.request<{ entry?: unknown }>(`${BASE}/set`, { method: 'POST', body: input });
  if (!res?.entry || typeof res.entry !== 'object') throw new Error('Invalid butler memory entry');
  return res.entry as ButlerMemoryEntry;
}

export async function deleteButlerMemory(
  conn: DshConnection,
  id: string,
  expectedRevision?: number,
): Promise<number> {
  const res = await conn.request<{ revision?: unknown }>(`${BASE}/delete`, {
    method: 'POST',
    body: { id, ...(expectedRevision === undefined ? {} : { expectedRevision }) },
  });
  if (typeof res?.revision !== 'number') throw new Error('Invalid butler memory revision');
  return res.revision;
}

export interface DesktopMemoryStore {
  getButlerMemory(): Promise<ButlerMemorySnapshot>;
  listButlerMemoryHistory(id?: string): Promise<ButlerMemoryChange[]>;
  setButlerMemory(input: ButlerMemoryInput): Promise<ButlerMemoryEntry>;
  deleteButlerMemory(id: string, expectedRevision?: number): Promise<number>;
}

export class DesktopMemoryClient implements ButlerMemoryClient {
  readonly location = 'desktop' as const;
  constructor(private readonly store: DesktopMemoryStore) {}
  load(): Promise<ButlerMemorySnapshot> { return this.store.getButlerMemory().then(snapshot); }
  history(id?: string): Promise<ButlerMemoryChange[]> { return this.store.listButlerMemoryHistory(id); }
  set(input: ButlerMemoryInput): Promise<ButlerMemoryEntry> { return this.store.setButlerMemory(input); }
  remove(id: string, expectedRevision?: number): Promise<number> {
    return this.store.deleteButlerMemory(id, expectedRevision);
  }
}

export class LocalMemoryClient implements ButlerMemoryClient {
  readonly location = 'local' as const;
  constructor(private readonly runtime: LocalRuntimeClient) {}
  load(): Promise<ButlerMemorySnapshot> {
    return this.runtime.query<ButlerMemorySnapshot>('memory').then(snapshot);
  }
  async history(id?: string): Promise<ButlerMemoryChange[]> {
    const res = await this.runtime.query<{ changes?: unknown }>('memory-history', id ? { id } : {});
    if (!Array.isArray(res?.changes)) throw new Error('Invalid butler memory history');
    return res.changes as ButlerMemoryChange[];
  }
  async set(input: ButlerMemoryInput): Promise<ButlerMemoryEntry> {
    const res = await this.runtime.query<{ entry?: unknown }>('memory-set', input);
    if (!res?.entry || typeof res.entry !== 'object') throw new Error('Invalid butler memory entry');
    return res.entry as ButlerMemoryEntry;
  }
  async remove(id: string, expectedRevision?: number): Promise<number> {
    const res = await this.runtime.query<{ revision?: unknown }>('memory-delete', {
      id,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    if (typeof res?.revision !== 'number') throw new Error('Invalid butler memory revision');
    return res.revision;
  }
}
