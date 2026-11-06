/** RN-independent protocol/data boundary for references, Host inbox and reply forks.
 * Wire evidence: installed @deepseek-ai/* 0.2.1-rc.2, notably
 * dsh-api-session-controller/types, dsh-agent/types, dsh-llm/message,
 * dsh-file-reference/{types,grammar}, dsh-session-reference/{types,uri}.
 * No Host runtime imports. RPC must unwrap transport errors and never retry writes.
 */
import type {EventRecord} from './types';

export interface ConversationActionsRpc {
  call<T = unknown>(endpoint: string, args: Record<string, unknown>): Promise<T>;
}
export class ConversationActionsProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversationActionsProtocolError'; }
}
function fail(message: string): never { throw new ConversationActionsProtocolError(message); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${field}: expected object`);
  return value as Record<string, unknown>;
}
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || controls.test(value)) return fail(`${field}: expected nonempty text without controls`);
  return value;
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return fail(`${field}: expected array`);
  return value;
}

export interface FileReferenceCandidate { path: string; kind: 'file' | 'directory' }
export function formatFileMention(candidate: FileReferenceCandidate, preserveQuote = false): string {
  const path = nonempty(candidate.path, 'file.path');
  if (candidate.kind !== 'file' && candidate.kind !== 'directory') return fail('file.kind: unsupported');
  if (path.includes('"')) return fail('file.path: quotes cannot be represented');
  const text = candidate.kind === 'directory' ? `${path}/` : path;
  const quoted = preserveQuote || /\s/u.test(text);
  return `@${quoted ? '"' : ''}${text}${quoted && candidate.kind === 'file' ? '"' : ''}`;
}
export function parseFileReferenceCandidates(value: unknown): FileReferenceCandidate[] {
  return array(value, 'fileReferences/list').map((raw) => {
    const row = object(raw, 'file candidate');
    if (row.kind !== 'file' && row.kind !== 'directory') return fail('file.kind: unsupported');
    const candidate: FileReferenceCandidate = {path: nonempty(row.path, 'file.path'), kind: row.kind};
    formatFileMention(candidate); // An unsafe path is an error, never a silently truncated result.
    return candidate;
  });
}

// Encode UTF-8 JSON as unpadded base64url without Buffer, btoa or TextEncoder.
// JSON.stringify escapes lone surrogates before encodeURIComponent sees them.
export function encodeSessionReferenceUri(sessionId: string): string {
  nonempty(sessionId, 'sessionId');
  const bytes: number[] = [];
  const encoded = encodeURIComponent(JSON.stringify(sessionId));
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') { bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(encoded.charCodeAt(i));
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let payload = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    payload += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) payload += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) payload += alphabet[c & 63]!;
  }
  return `dsh-session:${payload}`;
}
export function formatSessionMention(sessionId: string, label: string): string {
  nonempty(label, 'session.label');
  const escaped = label.replace(/[\\\]]/gu, (character) => `\\${character}`);
  return `@[${escaped}](${encodeSessionReferenceUri(sessionId)})`;
}
/** Verify the entire canonical mention, including its label and exact session identity. */
export function validateSessionMention(mention: unknown, sessionId: string, label: string): string {
  const expected = formatSessionMention(sessionId, label);
  if (mention !== expected) return fail('session.mention: noncanonical or mismatched session/label');
  return expected;
}
export interface SessionReferenceCandidate {
  sessionId: string; label: string; displayTitle?: string; cwd?: string;
  mention: string; sameWorkspace: boolean; createdAt: number;
}
export function parseSessionReferenceCandidates(value: unknown, requestingSessionId?: string): SessionReferenceCandidate[] {
  if (requestingSessionId !== undefined) nonempty(requestingSessionId, 'requestingSessionId');
  const seen = new Set<string>();
  return array(value, 'sessionReferenceResolver/candidates').map((raw) => {
    const row = object(raw, 'session candidate');
    const sessionId = nonempty(row.sessionId, 'sessionId');
    if (sessionId === requestingSessionId || seen.has(sessionId)) return fail('session candidate: self or duplicate');
    seen.add(sessionId);
    const label = nonempty(row.label, 'session.label');
    const displayTitle = row.displayTitle === undefined ? undefined : nonempty(row.displayTitle, 'session.displayTitle');
    const cwd = row.cwd === undefined ? undefined : nonempty(row.cwd, 'session.cwd');
    if (typeof row.sameWorkspace !== 'boolean' || !integer(row.createdAt)) return fail('session candidate: invalid metadata');
    return {
      sessionId, label, ...(displayTitle === undefined ? {} : {displayTitle}), ...(cwd === undefined ? {} : {cwd}),
      sameWorkspace: row.sameWorkspace, createdAt: row.createdAt,
      mention: validateSessionMention(row.mention, sessionId, displayTitle ?? label),
    };
  });
}

type Json = null | string | number | boolean | Json[] | {[key: string]: Json};
function snapshot(value: unknown): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(snapshot);
  const row = object(value, 'wire JSON');
  return Object.fromEntries(Object.entries(row).map(([key, part]) => [key, snapshot(part)]));
}
export type HostQueueSlot = 'next-turn' | 'next-step';
export interface HostQueueItem {
  origin: 'host'; sessionId: string; itemId: string; slot: HostQueueSlot;
  requestId?: string; sourceKind: string; text: string;
  /** Exact JSON blocks, including attachments and unrecognized future types. */
  content: ReadonlyArray<Readonly<Record<string, Json>>>;
  attachments: ReadonlyArray<Readonly<Record<string, Json>>>;
  message: Readonly<Record<string, Json>>;
  eligible: boolean;
  ineligibleReason?: 'non-human-source' | 'non-text-content' | 'empty-text';
}
export interface HostQueueSnapshot { sessionId: string; asOfSeq: number; items: HostQueueItem[] }
/** Only a sequenced Host projection is authoritative. Missing keys are not an empty queue. */
export function parseHostQueue(value: unknown, sessionId: string): HostQueueSnapshot {
  nonempty(sessionId, 'sessionId');
  const projection = object(value, 'session/projections');
  if (projection.kind !== 'sequenced' || !integer(projection.asOfSeq, -1)) return fail('session/projections: exact sequenced baseline required');
  const inbox = object(object(projection.values, 'projections.values').inbox, 'projections.values.inbox');
  const seen = new Set<string>();
  const items: HostQueueItem[] = [];
  for (const slot of ['next-step', 'next-turn'] as const) {
    for (const raw of array(inbox[slot], `inbox.${slot}`)) {
      const message = object(snapshot(raw), 'inbox message') as Record<string, Json>;
      const itemId = nonempty(message.id, 'inbox.message.id');
      if (seen.has(itemId)) return fail('inbox: duplicate message id');
      seen.add(itemId);
      if (message.role !== 'user') return fail('inbox.message.role: expected user');
      const source = object(message.source, 'inbox.message.source');
      const sourceKind = nonempty(source.kind, 'source.kind');
      const requestId = source.rpcId === undefined ? undefined : nonempty(source.rpcId, 'source.rpcId');
      const content = array(message.content, 'inbox.message.content').map((rawPart) => {
        const part = object(rawPart, 'inbox content') as Record<string, Json>;
        nonempty(part.type, 'content.type');
        if (part.type === 'text' && typeof part.text !== 'string') return fail('content.text: expected string');
        return part;
      });
      const text = content.filter((p) => p.type === 'text').map((p) => p.text as string).join('');
      const attachments = content.filter((p) => p.type !== 'text');
      // Extra text-block fields may carry future semantics; never discard them while editing.
      const plainText = content.every((p) => p.type === 'text' && Object.keys(p).every((key) => key === 'type' || key === 'text'));
      const ineligibleReason = sourceKind !== 'user' ? 'non-human-source' : !plainText ? 'non-text-content' : !text.trim() ? 'empty-text' : undefined;
      items.push({origin: 'host', sessionId, itemId, slot, sourceKind, ...(requestId === undefined ? {} : {requestId}),
        text, content, attachments, message, eligible: ineligibleReason === undefined,
        ...(ineligibleReason === undefined ? {} : {ineligibleReason})});
    }
  }
  return {sessionId, asOfSeq: projection.asOfSeq, items};
}

export interface ForkHistoryState {
  /** From the current follow/page baseline, after merging all pages. */
  hasMore: boolean; cursor: number;
  /** False after any disconnect until authoritative history has been reconciled. */
  synchronized: boolean;
}
export type ReplyForkPoint =
  | {eligible: true; replySeq: number; atSeq: number; turn: number; step: number}
  | {eligible: false; reason: string};
/** Compute an inclusive turn/end cut from durable records, never a UI key or stream delta.
 * Conservative policy: all history pages must be loaded, every seq through cursor present,
 * target turn and steps balanced, final reply textual and not interrupted, reason completed.
 * Unknown events inside the target turn disable branching even if marked ignorable.
 */
export function replyForkPoint(records: readonly EventRecord[], replySeq: number, history: ForkHistoryState): ReplyForkPoint {
  const no = (reason: string): ReplyForkPoint => ({eligible: false, reason});
  if (!history || history.synchronized !== true || history.hasMore !== false || !integer(history.cursor)) return no('历史尚未完整同步');
  if (!integer(replySeq)) return no('缺少持久回答 seq');
  const bySeq = new Map<number, EventRecord['event']>();
  for (const record of records) {
    const ev = record?.event;
    if (record?.type !== 'event' || !ev || !integer(ev.seq) || ev.seq > history.cursor || typeof ev.type !== 'string' ||
      !Number.isFinite(ev.time) || !ev.data || typeof ev.data !== 'object' || Array.isArray(ev.data)) return no('历史事件无效');
    const prior = bySeq.get(ev.seq);
    if (prior && JSON.stringify(prior) !== JSON.stringify(ev)) return no('历史 seq 冲突');
    bySeq.set(ev.seq, ev);
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (!events.length || events[0]!.seq !== 0 || events.at(-1)!.seq !== history.cursor ||
    events.some((ev, i) => ev.seq !== i)) return no('历史存在缺口');
  const reply = bySeq.get(replySeq);
  if (!reply || reply.type !== 'assistant/message' || !integer(reply.data.turn) || !integer(reply.data.step)) return no('目标不是持久回答');
  const {turn, step} = reply.data;
  const start = events.findIndex((ev) => ev.seq < replySeq && ev.type === 'turn/start' && ev.data.turn === turn);
  if (start < 0) return no('缺少轮次起点');
  let activeStep: number | undefined;
  let lastReply: number | undefined;
  const calls = new Set<string>();
  const requested = new Set<string>();
  const dispatched = new Set<string>();
  const answered = new Set<string>();
  const approvals = new Set<string>();
  const steps = new Set<number>();
  for (let i = start + 1; i < events.length; i++) {
    const ev = events[i]!, data = ev.data;
    if (data.turn !== undefined && data.turn !== turn) return no('轮次边界不一致');
    if (ev.surfaceOp !== undefined && ev.surfaceOp !== 'append') return no('回答涉及历史替换');
    if (ev.type === 'turn/end') {
      const reason = data.reason;
      if (data.turn !== turn || !reason || typeof reason !== 'object' || (reason as Record<string, unknown>).kind !== 'completed') return no('轮次未正常完成');
      if (activeStep !== undefined || calls.size || approvals.size || lastReply !== replySeq) return no('回答不是完整轮次的最终回答');
      // Surface replacements later in the log can invalidate a once-final reply.
      if (events.slice(i + 1).some((later) => later.surfaceOp !== undefined && later.surfaceOp !== 'append')) return no('后续历史发生替换');
      return {eligible: true, replySeq, atSeq: ev.seq, turn, step};
    }
    switch (ev.type) {
      case 'step/start':
        if (data.turn !== turn || !integer(data.step) || activeStep !== undefined || steps.has(data.step)) return no('步骤起点不完整');
        activeStep = data.step; steps.add(data.step); lastReply = undefined;
        break;
      case 'step/end':
        if (data.turn !== turn || activeStep === undefined || data.step !== activeStep || calls.size) return no('步骤结束不完整');
        activeStep = undefined;
        break;
      case 'assistant/message': {
        if (data.turn !== turn || activeStep === undefined || data.step !== activeStep || data.interrupted !== undefined || calls.size) return no('回答尚未完整落地');
        const message = data.message as Record<string, unknown> | undefined;
        if (!message || message.role !== 'assistant' || typeof message.id !== 'string' || !message.id || !Array.isArray(message.content)) return no('回答消息不完整');
        const content = message.content as Array<Record<string, unknown>>;
        if (content.some((p) => !p || (p.type !== 'text' && p.type !== 'reasoning' && p.type !== 'tool-call') ||
          (p.type === 'text' && typeof p.text !== 'string'))) return no('回答内容未知');
        for (const part of content) {
          if (part.type !== 'tool-call') continue;
          if (typeof part.id !== 'string' || !part.id || typeof part.name !== 'string' || !part.name ||
            typeof part.arguments !== 'string' || requested.has(part.id)) return no('回答中的工具调用不完整');
          requested.add(part.id); calls.add(part.id);
        }
        lastReply = content.some((p) => p.type === 'text' && (p.text as string).trim()) && !content.some((p) => p.type === 'tool-call') ? ev.seq : undefined;
        break;
      }
      case 'tool/call':
        if (data.turn !== turn || activeStep === undefined || data.step !== activeStep || typeof data.callId !== 'string' || !data.callId || dispatched.has(data.callId) || answered.has(data.callId)) return no('工具调用不完整');
        dispatched.add(data.callId); calls.add(data.callId); lastReply = undefined;
        break;
      case 'tool/result': {
        const message = data.message as Record<string, unknown> | undefined;
        const id = message?.toolCallId;
        if (data.turn !== turn || activeStep === undefined || data.step !== activeStep || typeof id !== 'string' || !dispatched.has(id) || !calls.delete(id)) return no('工具结果不完整');
        answered.add(id); lastReply = undefined;
        break;
      }
      case 'approval/asked':
        if (typeof data.id !== 'string' || !data.id || approvals.has(data.id)) return no('审批记录不完整');
        approvals.add(data.id); break;
      case 'approval/decided':
        if (typeof data.id !== 'string' || !approvals.delete(data.id)) return no('审批记录不完整');
        break;
      case 'user/message': case 'system/message': case 'developer/message':
        if (ev.seq > replySeq) return no('回答之后仍有上下文消息');
        break;
      case 'request/header': case 'agent/inbox/spliced':
        break;
      default:
        return no(`轮次包含尚未支持的事件 ${ev.type}`);
    }
  }
  return no('轮次仍在进行中');
}

export function parseForkResponse(value: unknown, sourceSessionId: string): {sessionId: string} {
  nonempty(sourceSessionId, 'sourceSessionId');
  const sessionId = nonempty(object(value, 'session/fork').sessionId, 'fork.sessionId');
  if (sessionId === sourceSessionId) return fail('session/fork: returned source identity');
  return {sessionId};
}
function requireAccepted(value: unknown): void {
  if (object(value, 'session/updateQueue').accepted !== true) fail('session/updateQueue: missing accepted:true receipt; outcome unknown');
}

export class ConversationActionsApi {
  constructor(private readonly rpc: ConversationActionsRpc) {}
  async fileReferences(sessionId: string, query: string): Promise<FileReferenceCandidate[]> {
    nonempty(sessionId, 'sessionId');
    if (typeof query !== 'string' || controls.test(query)) return fail('reference query: invalid');
    return parseFileReferenceCandidates(await this.rpc.call('fileReferences/list', {agentId: sessionId, query}));
  }
  async sessionReferences(sessionId: string, query: string): Promise<SessionReferenceCandidate[]> {
    nonempty(sessionId, 'sessionId');
    if (typeof query !== 'string' || controls.test(query)) return fail('reference query: invalid');
    return parseSessionReferenceCandidates(await this.rpc.call('sessionReferenceResolver/candidates', {agentId: sessionId, query}), sessionId);
  }
  async queue(sessionId: string): Promise<HostQueueSnapshot> {
    nonempty(sessionId, 'sessionId');
    return parseHostQueue(await this.rpc.call('session/projections', {request: {sessionId}}), sessionId);
  }
  private async queuedText(sessionId: string, itemId: string): Promise<HostQueueItem> {
    nonempty(itemId, 'itemId');
    const item = (await this.queue(sessionId)).items.find((candidate) => candidate.itemId === itemId);
    if (!item) return fail('Host queue item no longer exists');
    if (!item.eligible) return fail(`Host queue item cannot be edited or withdrawn: ${item.ineligibleReason}`);
    return item;
  }
  /** Return the preserved draft only AFTER accepted:true. Failure leaves outcome uncertain;
   * reconcile projections/history before offering another mutation. No automatic retry.
   */
  async removeQueuedText(sessionId: string, itemId: string): Promise<HostQueueItem> {
    const item = await this.queuedText(sessionId, itemId);
    requireAccepted(await this.rpc.call('session/updateQueue', {request: {sessionId, itemId, action: {kind: 'remove'}}}));
    return item;
  }
  async editQueuedText(sessionId: string, itemId: string, text: string): Promise<void> {
    if (typeof text !== 'string' || !text.trim()) return fail('queue edit: nonblank text required');
    await this.queuedText(sessionId, itemId);
    requireAccepted(await this.rpc.call('session/updateQueue', {request: {sessionId, itemId, action: {kind: 'edit', content: [{type: 'text', text}]}}}));
  }
  /** Creates only the fork. Does not send a prompt, rename, or silently remove inherited inbox. */
  async forkAfterReply(sessionId: string, records: readonly EventRecord[], replySeq: number, history: ForkHistoryState): Promise<{sessionId: string}> {
    nonempty(sessionId, 'sessionId');
    const point = replyForkPoint(records, replySeq, history);
    if (!point.eligible) return fail(point.reason);
    return parseForkResponse(await this.rpc.call('session/fork', {request: {sessionId, atSeq: point.atSeq}}), sessionId);
  }
}
