/**
 * fold：把 DSH 的事件流组装成 UI 可直接渲染的 turn 模型。
 *
 * 输入是 session/follow 首帧的 records、session/page 的历史 records、
 * 以及后续增量事件，可能乱序、跨页、重复。输出按 seq 排序的 turn 列表。
 *
 * 实测字段（勿凭想象改动，见 probes/_event-samples.json）：
 *   user/message      data.content[] / data.role / data.id
 *   assistant/message data.message.content[] / data.turn / data.step
 *   tool/call         data.name / data.arguments(JSON 字符串) / data.callId
 *   tool/result       data.message.content[] / data.toolCallId / data.message.isError
 *   step/start        data.turn / data.step
 *   turn/end          data.turn / data.reason
 */

import type { AttachRef, ContentBlock, EventRecord } from '../types';

/**
 * 管家初始化提示的前缀。
 *
 * 管家人格是「首条带标记的用户消息」（DSH 没有注入系统提示词的接口），
 * fold 见到这个前缀就当它不存在 —— 所以常量放这里，由 butler.ts 引用。
 */
export const BUTLER_PRIME_MARK = '〔管家初始化〕';
/** 客户端替管家补发的「队员完成」通知，同样不该显示成用户消息 */
export const SYSTEM_NUDGE_MARK = '〔系统通知〕';

export function isButlerPrime(text: string): boolean {
  return text.trimStart().startsWith(BUTLER_PRIME_MARK);
}

/** 界面上不该出现的「注入消息」：管家初始化 + 系统通知 */
export function isInjectedMessage(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(BUTLER_PRIME_MARK) || t.startsWith(SYSTEM_NUDGE_MARK);
}

export interface TextBlock {
  kind: 'text';
  text: string;
}

export interface ReasoningBlock {
  kind: 'reasoning';
  text: string;
  /** 该段思考是否属于仍在进行中的步骤 */
  streaming?: boolean;
}

export interface ToolBlock {
  kind: 'tool';
  callId: string;
  name: string;
  /** 解析后的参数；解析失败时保留原始字符串 */
  input: unknown;
  rawArguments?: string;
  output?: string;
  isError?: boolean;
  /** 还没收到 tool/result */
  pending?: boolean;
}

export type Block = TextBlock | ReasoningBlock | ToolBlock;

export interface Step {
  step: number;
  blocks: Block[];
}

export interface Turn {
  turn: number;
  user?: {
    id?: string;
    text: string;
    time: number;
    /** 附件（图片/文件），按出现顺序 */
    parts: AttachRef[];
  };
  steps: Step[];
  startedAt?: number;
  endedAt?: number;
  /** completed / aborted / error / 未结束 */
  reason?: string;
  running: boolean;
}

const EMPTY = '';

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return EMPTY;
  return blocks
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === 'object')
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? EMPTY)
    .join('');
}

function reasoningOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return EMPTY;
  return blocks
    .filter((b): b is { type: string; text?: string; reasoning?: string } => !!b && typeof b === 'object')
    .filter((b) => b.type === 'reasoning')
    .map((b) => b.text ?? b.reasoning ?? EMPTY)
    .join('');
}

/**
 * 把 user/message 的 content 里的附件抽出来。
 *
 * 实测 Host 存的是 `{ type:'image'|'file', attachment:{...} }`
 * （输入时的 `receiptId` 不会被保留，见 probes/verify-upload2.mjs）。
 */
function attachPartsOf(blocks: unknown): AttachRef[] {
  if (!Array.isArray(blocks)) return [];
  const out: AttachRef[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const part = b as { type?: string; attachment?: Record<string, unknown> };
    const a = part.attachment;
    if (!a) continue;
    const attachmentId = typeof a.attachmentId === 'string' ? a.attachmentId : undefined;
    if (!attachmentId) continue;

    if (part.type === 'image') {
      out.push({
        kind: 'image',
        attachmentId,
        mediaType: typeof a.mediaType === 'string' ? a.mediaType : undefined,
        width: typeof a.width === 'number' ? a.width : undefined,
        height: typeof a.height === 'number' ? a.height : undefined,
        bytes: typeof a.bytes === 'number' ? a.bytes : undefined,
        name: typeof a.name === 'string' ? a.name : undefined,
      });
    } else if (part.type === 'file') {
      out.push({
        kind: 'file',
        attachmentId,
        name: typeof a.name === 'string' ? a.name : undefined,
        bytes: typeof a.bytes === 'number' ? a.bytes : undefined,
      });
    }
  }
  return out;
}

/** 把任意值稳定地转成可显示文本 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return EMPTY;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** tool/call 的 arguments 是 JSON 字符串，尽量解析 */
function parseArguments(raw: unknown): { input: unknown; raw?: string } {
  if (typeof raw !== 'string') return { input: raw };
  const trimmed = raw.trim();
  if (!trimmed) return { input: {}, raw };
  try {
    return { input: JSON.parse(trimmed) };
  } catch {
    return { input: raw, raw };
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

interface TurnBuilder {
  turn: Turn;
  stepsByNumber: Map<number, Step>;
}

/**
 * 把事件列表折叠成 turn 列表。
 *
 * 幂等：同一批事件重复传入结果一致（内部按 seq 去重）。
 */
export function foldEvents(records: EventRecord[]): Turn[] {
  // 1. 去重 + 排序
  const seen = new Set<number>();
  const events: EventRecord['event'][] = [];
  for (const r of records) {
    const ev = r?.event ?? (r as unknown as EventRecord['event']);
    if (!ev || typeof ev.seq !== 'number' || typeof ev.type !== 'string') continue;
    if (seen.has(ev.seq)) continue;
    seen.add(ev.seq);
    events.push(ev);
  }
  events.sort((a, b) => a.seq - b.seq);

  // 2. 折叠
  const turns = new Map<number, TurnBuilder>();
  let current: TurnBuilder | undefined;
  /** 当前正在写入的 step（用于把 tool/result 回填到对应 step） */
  let currentStepNo: number | undefined;

  const ensureTurn = (turnNo: number): TurnBuilder => {
    let b = turns.get(turnNo);
    if (!b) {
      b = {
        turn: { turn: turnNo, steps: [], running: false },
        stepsByNumber: new Map(),
      };
      turns.set(turnNo, b);
    }
    return b;
  };

  const ensureStep = (builder: TurnBuilder, stepNo: number): Step => {
    let s = builder.stepsByNumber.get(stepNo);
    if (!s) {
      s = { step: stepNo, blocks: [] };
      builder.stepsByNumber.set(stepNo, s);
      builder.turn.steps.push(s);
    }
    return s;
  };

  for (const ev of events) {
    const d = (ev.data ?? {}) as Record<string, unknown>;

    switch (ev.type) {
      case 'turn/start': {
        const turnNo = num(d.turn) ?? num(d.turnNo) ?? 0;
        const b = ensureTurn(turnNo);
        b.turn.startedAt = ev.time;
        b.turn.running = true;
        current = b;
        currentStepNo = undefined;
        break;
      }

      case 'user/message': {
        // 管家初始化提示 / 系统通知都是「假的用户消息」，界面上不显示
        if (isInjectedMessage(textOf(d.content))) break;
        // turn 号有时缺失，挂到当前 turn；否则按 seq 造一个
        const turnNo = num(d.turn) ?? current?.turn.turn ?? ev.seq;
        const b = ensureTurn(turnNo);
        if (!b.turn.user) {
          b.turn.user = {
            id: typeof d.id === 'string' ? d.id : undefined,
            text: textOf(d.content),
            time: ev.time,
            parts: attachPartsOf(d.content),
          };
        }        if (b.turn.startedAt === undefined) b.turn.startedAt = ev.time;
        current = b;
        break;
      }

      case 'step/start': {
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const stepNo = num(d.step) ?? (b.stepsByNumber.size + 1);
        ensureStep(b, stepNo);
        current = b;
        currentStepNo = stepNo;
        b.turn.running = true;
        break;
      }

      case 'assistant/message': {
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const stepNo = num(d.step) ?? currentStepNo ?? b.stepsByNumber.size ?? 1;
        const step = ensureStep(b, stepNo);

        const message = (d.message ?? {}) as Record<string, unknown>;
        const content = message.content;

        const t = textOf(content);
        if (t) step.blocks.push({ kind: 'text', text: t });

        const r = reasoningOf(content);
        if (r) step.blocks.push({ kind: 'reasoning', text: r });

        if (Array.isArray(content)) {
          for (const blk of content as ContentBlock[]) {
            if (blk?.type !== 'tool-call') continue;
            const { input, raw } = parseArguments((blk as { arguments?: unknown }).arguments);
            step.blocks.push({
              kind: 'tool',
              callId: (blk as { callId?: string }).callId ?? '',
              name: (blk as { name?: string }).name ?? 'tool',
              input,
              rawArguments: raw,
              pending: true,
            });
          }
        }
        current = b;
        currentStepNo = stepNo;
        break;
      }

      case 'tool/call': {
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const stepNo = num(d.step) ?? currentStepNo ?? 1;
        const step = ensureStep(b, stepNo);
        const callId = typeof d.callId === 'string' ? d.callId : '';

        // tool/call 可能与 assistant/message 里的 tool-call 重复，按 callId 合并
        const existing = callId
          ? step.blocks.find((x): x is ToolBlock => x.kind === 'tool' && x.callId === callId)
          : undefined;
        if (existing) {
          existing.pending = true;
        } else {
          const { input, raw } = parseArguments(d.arguments);
          step.blocks.push({
            kind: 'tool',
            callId,
            name: typeof d.name === 'string' ? d.name : 'tool',
            input,
            rawArguments: raw,
            pending: true,
          });
        }
        current = b;
        currentStepNo = stepNo;
        break;
      }

      case 'tool/result': {
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const message = (d.message ?? {}) as Record<string, unknown>;
        const callId =
          (typeof message.toolCallId === 'string' && message.toolCallId) ||
          (typeof d.toolCallId === 'string' ? d.toolCallId : '');

        // 在所有 step 里找对应工具块
        const target = b.turn.steps
          .flatMap((s) => s.blocks)
          .find((x): x is ToolBlock => x.kind === 'tool' && x.callId === callId);

        const output = textOf(message.content) || asText(message.content);
        if (target) {
          target.output = output;
          target.isError = message.isError === true;
          target.pending = false;
        } else if (callId) {
          // 找不到调用记录：单独建一个已完成的工具块
          const stepNo = num(d.step) ?? currentStepNo ?? 1;
          const step = ensureStep(b, stepNo);
          step.blocks.push({
            kind: 'tool',
            callId,
            name: 'tool',
            input: {},
            output,
            isError: message.isError === true,
            pending: false,
          });
        }
        current = b;
        break;
      }

      case 'turn/end': {
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const reason = d.reason as { kind?: string } | undefined;
        b.turn.running = false;
        b.turn.endedAt = ev.time;
        b.turn.reason = reason?.kind;
        if (current?.turn.turn === turnNo) current = undefined;
        currentStepNo = undefined;
        break;
      }

      default:
        // 其它事件（job/*、approval/*、team/*、todo/write…）暂不进入消息模型
        break;
    }
  }

  // 3. 收尾：排序 step，标记未结束的 turn
  const out = [...turns.values()]
    .map((b) => b.turn)
    .sort((a, b) => a.turn - b.turn);

  for (const t of out) {
    t.steps.sort((a, b) => a.step - b.step);
    if (t.endedAt === undefined) t.running = true;
  }
  return out;
}

/** 把一批 turn 拍平成可渲染的聊天气泡列表（用于 FlatList） */
export type ChatItem =
  | { kind: 'user'; key: string; turn: number; text: string; time: number; parts: AttachRef[] }
  | { kind: 'assistant'; key: string; turn: number; step: number; blocks: Block[] }
  | { kind: 'divider'; key: string; turn: number; reason?: string };

export function toChatItems(turns: Turn[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const t of turns) {
    if (t.user) {
      items.push({
        kind: 'user',
        key: `u-${t.turn}-${t.user.id ?? t.user.time}`,
        turn: t.turn,
        text: t.user.text,
        time: t.user.time,
        parts: t.user.parts,
      });
    }
    for (const s of t.steps) {
      if (s.blocks.length === 0) continue;
      items.push({
        kind: 'assistant',
        key: `a-${t.turn}-${s.step}`,
        turn: t.turn,
        step: s.step,
        blocks: s.blocks,
      });
    }
    if (!t.running && t.reason && t.reason !== 'completed') {
      items.push({ kind: 'divider', key: `d-${t.turn}`, turn: t.turn, reason: t.reason });
    }
  }
  return items;
}
