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
/** 切换闲聊/计划模式时补发的短指令 */
export const BUTLER_MODE_MARK = '〔模式切换〕';

export function isButlerPrime(text: string): boolean {
  return text.trimStart().startsWith(BUTLER_PRIME_MARK);
}

/** 界面上不该出现的「注入消息」：管家初始化 + 系统通知 + 模式切换 + DSH 运行时上下文 */
export function isInjectedMessage(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith(BUTLER_PRIME_MARK) ||
    t.startsWith(SYSTEM_NUDGE_MARK) ||
    t.startsWith(BUTLER_MODE_MARK) ||
    // DSH 每轮注入的运行时上下文，纯噪音，不该显示成用户发言
    t.startsWith('Current runtime context.') ||
    t.startsWith('Time sampled while preparing turn') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('[model changed:')
  );
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

/** 交付物：助手通过 present 工具发给用户的文件（图片/PDF 等） */
export interface FileBlock {
  kind: 'file';
  /** 电脑上的绝对路径 */
  path: string;
  /** 展示用描述 */
  description?: string;
}

export type Block = TextBlock | ReasoningBlock | ToolBlock | FileBlock;

export interface Step {
  step: number;
  blocks: Block[];
}

export interface Turn {
  turn: number;
  /** 这一轮里待处理的审批请求（权限不够时会出现，需要在电脑上确认） */
  approvals?: Array<{ id: string; toolName: string; reason?: string; decided?: string }>;
  user?: {
    id?: string;
    text: string;
    time: number;
    /** 附件（图片/文件），按出现顺序 */
    parts: AttachRef[];
  };
  steps: Step[];
  /** 队员汇报 / subagent 通知。DSH 把它们记成 user/message，实际不是用户说的 */
  teammates?: Array<{ id: string; from: string; text: string; notice: boolean; time: number }>;
  /** 这一轮是否派过活（调用过 spawn_teammate / team_task_create） */
  delegated?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** completed / aborted / error / 未结束 */
  reason?: string;
  running: boolean;
}

const EMPTY = '';

/**
 * 模式标记：附在用户消息末尾告诉管家当前处于哪个模式，
 * 显示前会被 stripModeTag 剥掉，用户看不到。
 * 用行内标记而不是单独发一条消息，这样切换模式不会产生额外对话。
 */
export const MODE_TAG_RE = /\s*〔模式:(闲聊|计划)〕\s*$/;

export function stripModeTag(text: string): string {
  return text.replace(MODE_TAG_RE, '').trimEnd();
}

/**
 * 识别「队员汇报」和「subagent 完成通知」。
 *
 * DSH 把这两类消息记成 user/message，导致 App 把它们显示成用户发言。
 * 实际上它们是 teammate 发来的，应该单独渲染（折叠卡片）。
 *
 * 两种形态（实测）：
 *   "Team message from weather-scout: 大连天气..."
 *   "Background subagent 87e6f420-... finished ... Its closing message: ..."
 */
export function parseTeammateMessage(
  text: string,
): { from: string; text: string; notice: boolean } | null {
  const t = text.trimStart();

  // 1. 队员主动发的汇报（旧格式）
  const m = /^Team message from\s+([^:\n]+):\s*([\s\S]+)$/.exec(t);
  if (m) {
    return { from: m[1].trim(), text: m[2].trim(), notice: false };
  }

  // 2. 队员汇报（新格式）："Agent <sessionId> sent a message: ..."
  //    DSH 换过措辞，两种都要认，否则这类消息会漏成「用户发言」。
  const a = /^Agent\s+([0-9a-zA-Z_-]{6,})\s+sent a message:\s*([\s\S]+)$/i.exec(t);
  if (a) {
    return { from: a[1].slice(0, 8), text: a[2].trim(), notice: false };
  }

  // 3. subagent 完成通知
  const n = /^Background subagent\s+([0-9a-f-]{8,})[\s\S]*?closing message:\s*([\s\S]+)$/i.exec(t);
  if (n) {
    return { from: n[1].slice(0, 8), text: n[2].trim(), notice: true };
  }

  return null;
}

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
        // 剥掉尾部的模式标记（〔模式:计划〕），用户不该看到它
        const raw = textOf(d.content);
        const body = stripModeTag(raw);
        if (!body) break;
        // turn 号有时缺失，挂到当前 turn；否则按 seq 造一个
        const turnNo = num(d.turn) ?? current?.turn.turn ?? ev.seq;
        const b = ensureTurn(turnNo);

        // 队员汇报 / subagent 完成通知：DSH 把它们记成 user/message，
        // 但它们不是用户说的，单独记成 teammate，UI 上折叠成一行。
        const tm = parseTeammateMessage(body);
        if (tm) {
          b.turn.teammates = [
            ...(b.turn.teammates ?? []),
            { id: `tm-${ev.seq}`, from: tm.from, text: tm.text, notice: tm.notice, time: ev.time },
          ];
          // 不设置 turn.user，避免被当成用户发言
          if (b.turn.startedAt === undefined) b.turn.startedAt = ev.time;
          current = b;
          break;
        }

        if (!b.turn.user) {
          b.turn.user = {
            id: typeof d.id === 'string' ? d.id : undefined,
            text: body,
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

        // 顺序很重要：思考发生在正文之前，所以先 push reasoning 再 push text。
        // 反过来的话，界面上会出现「回复在前、思考在后」的怪顺序。
        const r = reasoningOf(content);
        if (r) step.blocks.push({ kind: 'reasoning', text: r });

        const t = textOf(content);
        if (t) step.blocks.push({ kind: 'text', text: t });

        if (Array.isArray(content)) {
          for (const blk of content as ContentBlock[]) {
            if (blk?.type !== 'tool-call') continue;
            // 真实 DSH 的 assistant/message content 里 tool-call 块用 id（部分路径用 callId / toolCallId），
            // 必须统一提取才能与紧随其后的 tool/call、tool/result 按同一个 callId 合并去重。
            const rawBlk = blk as Record<string, unknown>;
            const callId =
              (typeof rawBlk.callId === 'string' && rawBlk.callId) ||
              (typeof rawBlk.id === 'string' && rawBlk.id) ||
              (typeof rawBlk.toolCallId === 'string' && rawBlk.toolCallId) ||
              '';
            const existing = callId
              ? step.blocks.find((x): x is ToolBlock => x.kind === 'tool' && x.callId === callId)
              : undefined;
            if (existing) continue;
            const { input, raw } = parseArguments((blk as { arguments?: unknown }).arguments);
            const toolName = (blk as { name?: string }).name ?? 'tool';
            step.blocks.push({
              kind: 'tool',
              callId,
              name: toolName,
              input,
              rawArguments: raw,
              pending: true,
            });
            if (DELEGATING_TOOLS.has(toolName)) b.turn.delegated = true;
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
        const callId =
          (typeof d.callId === 'string' && d.callId) ||
          (typeof d.id === 'string' && d.id) ||
          (typeof d.toolCallId === 'string' && d.toolCallId) ||
          '';

        // tool/call 可能与 assistant/message 里的 tool-call 重复，按 callId 合并
        const existing = callId
          ? step.blocks.find((x): x is ToolBlock => x.kind === 'tool' && x.callId === callId)
          : undefined;
        if (existing) {
          if (existing.output === undefined) existing.pending = true;
        } else {
          const { input, raw } = parseArguments(d.arguments);
          const toolName = typeof d.name === 'string' ? d.name : 'tool';
          step.blocks.push({
            kind: 'tool',
            callId,
            name: toolName,
            input,
            rawArguments: raw,
            pending: true,
          });
          // 记下「这一轮派过活」，UI 用来决定是否把管家回复折叠成「已完成」卡片
          if (DELEGATING_TOOLS.has(toolName)) b.turn.delegated = true;
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

      case 'deliverables/presented': {
        // 助手用 present 工具交付文件（图片/PDF 等）。
        // 这些文件不会出现在 markdown 里，必须单独收集，
        // 否则用户只看到「图就在上面那张卡片里」却找不到卡片。
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const stepNo = num(d.step) ?? currentStepNo ?? b.stepsByNumber.size ?? 1;
        const step = ensureStep(b, stepNo);
        const files = Array.isArray(d.files) ? (d.files as Array<Record<string, unknown>>) : [];
        for (const f of files) {
          const path = typeof f.path === 'string' ? f.path : '';
          if (!path) continue;
          // 同一路径只加一次（重新 follow 会重放事件）
          const exists = step.blocks.some((x) => x.kind === 'file' && x.path === path);
          if (exists) continue;
          step.blocks.push({
            kind: 'file',
            path,
            description: typeof f.description === 'string' ? f.description : undefined,
          });
        }
        current = b;
        currentStepNo = stepNo;
        break;
      }

      case 'approval/asked': {
        // 工具需要用户授权。当前 App 没有审批响应通道（找不到对应 RPC），
        // 所以只记录，由 UI 提示用户「去电脑上确认」或调高权限。
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const id = typeof d.id === 'string' ? d.id : '';
        if (id) {
          b.turn.approvals = [
            ...(b.turn.approvals ?? []).filter((a) => a.id !== id),
            {
              id,
              toolName: typeof d.toolName === 'string' ? d.toolName : 'tool',
              reason: typeof d.reason === 'string' ? d.reason : undefined,
            },
          ];
        }
        current = b;
        break;
      }

      case 'approval/decided': {
        // 审批有结果了，标记掉，横幅随之消失
        const turnNo = num(d.turn) ?? current?.turn.turn ?? 0;
        const b = ensureTurn(turnNo);
        const id = typeof d.id === 'string' ? d.id : '';
        const outcome = typeof d.outcome === 'string' ? d.outcome : 'unknown';
        b.turn.approvals = (b.turn.approvals ?? []).map((a) =>
          a.id === id ? { ...a, decided: outcome } : a,
        );
        current = b;
        break;
      }

      default:
        // 其它事件（job/*、team/*、todo/write…）暂不进入消息模型
        break;
    }
  }

  // 2.5 清掉已决的审批（横幅只该显示「还在等」的）
  for (const b of turns.values()) {
    const t = b.turn;
    if (!t.approvals) continue;
    t.approvals = t.approvals.filter((a) => !a.decided);
    if (t.approvals.length === 0) delete t.approvals;
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

/** 会派活的工具名：调用过就说明这一轮是「计划模式」在执行 */
const DELEGATING_TOOLS = new Set(['spawn_teammate', 'team_task_create']);

/** 把一批 turn 拍平成可渲染的聊天气泡列表（用于 FlatList） */
export type ChatItem =
  | { kind: 'user'; key: string; turn: number; text: string; time: number; parts: AttachRef[] }
  // 队员汇报 / 系统通知：不是用户说的话，单独一种类型，UI 上折叠成一行
  | { kind: 'teammate'; key: string; turn: number; from: string; text: string; notice: boolean }
  | {
      kind: 'assistant';
      key: string;
      turn: number;
      step: number;
      blocks: Block[];
      /** 这一轮派过活，UI 可以折叠成「已完成」卡片 */
      delegated?: boolean;
    }
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
    // 队员汇报插在 assistant 之前（它们是对这一轮的输入）
    for (const tm of t.teammates ?? []) {
      items.push({
        kind: 'teammate',
        key: tm.id,
        turn: t.turn,
        from: tm.from,
        text: tm.text,
        notice: tm.notice,
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
        delegated: t.delegated,
      });
    }
    if (!t.running && t.reason && t.reason !== 'completed') {
      items.push({ kind: 'divider', key: `d-${t.turn}`, turn: t.turn, reason: t.reason });
    }
  }
  return items;
}

// ── F-03：历史轮次与列表项引用稳定化 + 增量尾轮折叠 ────────────────

function areBlocksEqual(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
  if (a.kind === 'reasoning' && b.kind === 'reasoning') return a.text === b.text;
  if (a.kind === 'file' && b.kind === 'file') {
    return a.path === b.path && a.description === b.description;
  }
  if (a.kind === 'tool' && b.kind === 'tool') {
    const argsEqual =
      a.rawArguments !== undefined || b.rawArguments !== undefined
        ? a.rawArguments === b.rawArguments
        : a.input === b.input || JSON.stringify(a.input) === JSON.stringify(b.input);
    return (
      a.callId === b.callId &&
      a.name === b.name &&
      argsEqual &&
      a.output === b.output &&
      a.isError === b.isError &&
      a.pending === b.pending
    );
  }
  return false;
}

export function areAttachRefsEqual(a: readonly AttachRef[], b: readonly AttachRef[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa === pb) continue;
    if (
      pa.kind !== pb.kind ||
      pa.attachmentId !== pb.attachmentId ||
      pa.name !== pb.name ||
      pa.bytes !== pb.bytes ||
      pa.localUri !== pb.localUri
    ) {
      return false;
    }
    if (pa.kind === 'image' && pb.kind === 'image') {
      if (
        pa.mediaType !== pb.mediaType ||
        pa.width !== pb.width ||
        pa.height !== pb.height
      ) {
        return false;
      }
    }
  }
  return true;
}

function areBlockArraysEqual(a: readonly Block[], b: readonly Block[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!areBlocksEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

export function areTurnsStructurallyEqual(a: Turn, b: Turn): boolean {
  if (a === b) return true;
  if (
    a.turn !== b.turn ||
    a.running !== b.running ||
    a.startedAt !== b.startedAt ||
    a.endedAt !== b.endedAt ||
    a.reason !== b.reason ||
    a.delegated !== b.delegated
  ) {
    return false;
  }
  if (Boolean(a.user) !== Boolean(b.user)) return false;
  if (a.user && b.user) {
    if (
      a.user.id !== b.user.id ||
      a.user.text !== b.user.text ||
      a.user.time !== b.user.time ||
      !areAttachRefsEqual(a.user.parts, b.user.parts)
    ) {
      return false;
    }
  }
  const tmA = a.teammates ?? [];
  const tmB = b.teammates ?? [];
  if (tmA.length !== tmB.length) return false;
  for (let i = 0; i < tmA.length; i += 1) {
    if (
      tmA[i]!.id !== tmB[i]!.id ||
      tmA[i]!.text !== tmB[i]!.text ||
      tmA[i]!.from !== tmB[i]!.from ||
      tmA[i]!.notice !== tmB[i]!.notice
    ) {
      return false;
    }
  }
  const apA = a.approvals ?? [];
  const apB = b.approvals ?? [];
  if (apA.length !== apB.length) return false;
  for (let i = 0; i < apA.length; i += 1) {
    if (
      apA[i]!.id !== apB[i]!.id ||
      apA[i]!.toolName !== apB[i]!.toolName ||
      apA[i]!.reason !== apB[i]!.reason ||
      apA[i]!.decided !== apB[i]!.decided
    ) {
      return false;
    }
  }
  if (a.steps.length !== b.steps.length) return false;
  for (let i = 0; i < a.steps.length; i += 1) {
    const sa = a.steps[i]!;
    const sb = b.steps[i]!;
    if (sa.step !== sb.step || !areBlockArraysEqual(sa.blocks, sb.blocks)) {
      return false;
    }
  }
  return true;
}

export function areChatItemsStructurallyEqual(a: ChatItem, b: ChatItem): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key || a.turn !== b.turn) return false;
  if (a.kind === 'user' && b.kind === 'user') {
    return (
      a.text === b.text &&
      a.time === b.time &&
      areAttachRefsEqual(a.parts, b.parts)
    );
  }
  if (a.kind === 'teammate' && b.kind === 'teammate') {
    return a.from === b.from && a.text === b.text && a.notice === b.notice;
  }
  if (a.kind === 'divider' && b.kind === 'divider') {
    return a.reason === b.reason;
  }
  if (a.kind === 'assistant' && b.kind === 'assistant') {
    return (
      a.step === b.step &&
      a.delegated === b.delegated &&
      areBlockArraysEqual(a.blocks, b.blocks)
    );
  }
  return false;
}

/**
 * 复用未变化的历史 Turn 引用（prevTurn === nextTurn）。
 */
export function stabilizeTurns(prevTurns: readonly Turn[], nextTurns: Turn[]): Turn[] {
  if (prevTurns.length === 0) return nextTurns;
  const prevByTurn = new Map<number, Turn>();
  for (const t of prevTurns) prevByTurn.set(t.turn, t);
  let allSame = prevTurns.length === nextTurns.length;
  const out = nextTurns.map((next, idx) => {
    const prev = prevByTurn.get(next.turn);
    if (prev && areTurnsStructurallyEqual(prev, next)) {
      if (prevTurns[idx] !== prev) allSame = false;
      return prev;
    }
    allSame = false;
    return next;
  });
  return allSame ? (prevTurns as Turn[]) : out;
}

/**
 * 复用未变化的历史 ChatItem 引用（prevItem === nextItem）。
 */
export function stabilizeChatItems(prevItems: readonly ChatItem[], nextItems: ChatItem[]): ChatItem[] {
  if (prevItems.length === 0) return nextItems;
  const prevByKey = new Map<string, ChatItem>();
  for (const item of prevItems) prevByKey.set(item.key, item);
  let allSame = prevItems.length === nextItems.length;
  const out = nextItems.map((next, idx) => {
    const prev = prevByKey.get(next.key);
    if (prev && areChatItemsStructurallyEqual(prev, next)) {
      if (prevItems[idx] !== prev) allSame = false;
      return prev;
    }
    allSame = false;
    return next;
  });
  return allSame ? (prevItems as ChatItem[]) : out;
}

export interface IncrementalFoldCache {
  /** 已冻结的完成态前缀在 sortedRecords 中的起始切片长度 */
  prefixRecordCount: number;
  /** tail 切片首个事件（最后一轮 turn/start）的 seq */
  tailStartSeq: number;
  /** tail 起始轮次号 */
  tailTurnNo: number;
  /** 上一次处理过的总记录数与最大 seq */
  lastRecordCount: number;
  lastMaxSeq: number;
  /** 上一次输入记录与事件对象的浅快照（用于检测同 seq 事件原地更新与断线历史回填插入） */
  lastRecords: EventRecord[];
  lastEvents: Array<EventRecord['event'] | undefined>;
  /** 已冻结的历史已完成 Turn 与 ChatItem 前缀 */
  prefixTurns: Turn[];
  prefixItems: ChatItem[];
  /** 上一次完整输出的 Turn[] 与 ChatItem[]（用于引用稳定化对比） */
  lastTurns: Turn[];
  lastItems: ChatItem[];
}

export function createIncrementalFoldCache(): IncrementalFoldCache {
  return {
    prefixRecordCount: 0,
    tailStartSeq: -1,
    tailTurnNo: -1,
    lastRecordCount: 0,
    lastMaxSeq: -1,
    lastRecords: [],
    lastEvents: [],
    prefixTurns: [],
    prefixItems: [],
    lastTurns: [],
    lastItems: [],
  };
}

function applyAuthoritativeRunningOverride(
  turns: Turn[],
  authoritativeRunning?: boolean,
): Turn[] {
  if (authoritativeRunning !== false || turns.length === 0) return turns;
  const last = turns[turns.length - 1]!;
  if (!last.running) return turns;
  const copy = turns.slice();
  copy[copy.length - 1] = { ...last, running: false };
  return copy;
}

/**
 * 增量折叠（F-03）：
 *   - 当流式事件仅追加在当前活跃最后一轮（tail）时，跳过全部已完成历史轮次（prefixTurns），
 *     只对最后一轮的尾部事件切片调用 `foldEvents`，使单次 rebuild 复杂度从 O(N_total) 降至 O(N_tail)；
 *   - 当发生历史回填、加载更早消息或跨轮次变更时，自动回退全量 `foldEvents` 并通过
 *     `stabilizeTurns` / `stabilizeChatItems` 保持所有未变历史对象的引用严格相等（`===`）。
 */
export function foldEventsIncremental(
  sortedRecords: readonly EventRecord[],
  cache: IncrementalFoldCache,
  opts?: { authoritativeRunning?: boolean },
): { turns: Turn[]; items: ChatItem[]; usedFastPath: boolean } {
  const len = sortedRecords.length;
  if (len === 0) {
    cache.prefixRecordCount = 0;
    cache.tailStartSeq = -1;
    cache.tailTurnNo = -1;
    cache.lastRecordCount = 0;
    cache.lastMaxSeq = -1;
    cache.lastRecords = [];
    cache.lastEvents = [];
    cache.prefixTurns = [];
    cache.prefixItems = [];
    cache.lastTurns = [];
    cache.lastItems = [];
    return { turns: [], items: [], usedFastPath: false };
  }

  const maxSeq = sortedRecords[len - 1]?.event?.seq ?? -1;

  // 查找与上一次记录快照首个不一致的位置（检测同 seq 更新、原地替换或断线历史回填插入）
  const minCommon = Math.min(len, cache.lastRecords.length);
  let firstDiffIdx = minCommon;
  for (let i = 0; i < minCommon; i += 1) {
    if (
      sortedRecords[i] !== cache.lastRecords[i] ||
      sortedRecords[i]?.event !== cache.lastEvents[i]
    ) {
      firstDiffIdx = i;
      break;
    }
  }

  // 检查是否可以走增量尾轮折叠快路径：
  //   1. 已冻结的前缀 [0 .. prefixRecordCount - 1] 必须完全未被修改或位移（firstDiffIdx >= prefixRecordCount）；
  //   2. 尾轮起始锚点 seq 未变；
  //   3. 尾部所有事件均不指向更早轮次，且不含无 turn 号的 approval/decided。
  let canUseFastPath =
    cache.prefixRecordCount > 0 &&
    cache.tailTurnNo >= 0 &&
    len > cache.prefixRecordCount &&
    firstDiffIdx >= cache.prefixRecordCount &&
    sortedRecords[cache.prefixRecordCount]?.event?.seq === cache.tailStartSeq;

  if (canUseFastPath) {
    const checkStart = Math.max(cache.prefixRecordCount, firstDiffIdx);
    const prevSeqBeforeCheck =
      checkStart > 0 ? (sortedRecords[checkStart - 1]?.event?.seq ?? -1) : -1;
    let prevSeq = prevSeqBeforeCheck;
    for (let i = checkStart; i < len; i += 1) {
      const ev = sortedRecords[i]?.event;
      if (!ev || typeof ev.seq !== 'number' || ev.seq <= prevSeq) {
        canUseFastPath = false;
        break;
      }
      prevSeq = ev.seq;
      const d = (ev.data ?? {}) as Record<string, unknown>;
      const evTurn = num(d.turn) ?? num(d.turnNo);
      if (evTurn !== undefined && evTurn < cache.tailTurnNo) {
        canUseFastPath = false;
        break;
      }
      if (ev.type === 'approval/decided' && evTurn === undefined) {
        canUseFastPath = false;
        break;
      }
    }
  }

  let turns: Turn[];
  let items: ChatItem[];
  let usedFastPath = false;

  if (canUseFastPath) {
    const tailSlice = sortedRecords.slice(cache.prefixRecordCount) as EventRecord[];
    const rawTailTurns = applyAuthoritativeRunningOverride(
      foldEvents(tailSlice),
      opts?.authoritativeRunning,
    );
    const prevTailTurns = cache.lastTurns.slice(cache.prefixTurns.length);
    const stableTailTurns = stabilizeTurns(prevTailTurns, rawTailTurns);
    const prevTailItems = cache.lastItems.slice(cache.prefixItems.length);
    const stableTailItems = stabilizeChatItems(prevTailItems, toChatItems(stableTailTurns));

    turns = cache.prefixTurns.concat(stableTailTurns);
    items = cache.prefixItems.concat(stableTailItems);
    usedFastPath = true;
  } else {
    const rawTurns = applyAuthoritativeRunningOverride(
      foldEvents(sortedRecords as EventRecord[]),
      opts?.authoritativeRunning,
    );
    turns = stabilizeTurns(cache.lastTurns, rawTurns);
    items = stabilizeChatItems(cache.lastItems, toChatItems(turns));
  }

  // 更新检查点：若倒数第二轮及之前均已结束且无未决审批，将前缀冻结到最后一轮的 turn/start 位置
  cache.lastRecordCount = len;
  cache.lastMaxSeq = maxSeq;
  cache.lastRecords = sortedRecords.slice();
  cache.lastEvents = sortedRecords.map((r) => r?.event);
  cache.lastTurns = turns;
  cache.lastItems = items;

  let checkpointUpdated = false;
  if (turns.length >= 2) {
    const lastTurn = turns[turns.length - 1]!;
    const prefixAllCompleted = turns
      .slice(0, -1)
      .every((t) => !t.running && t.endedAt !== undefined && (!t.approvals || t.approvals.length === 0));
    if (prefixAllCompleted) {
      // 从后往前找最后一轮的 turn/start 且在那之后没有任何属于更早轮次的事件
      let startIdx = -1;
      for (let i = len - 1; i >= 0; i -= 1) {
        const ev = sortedRecords[i]?.event;
        if (!ev) continue;
        const d = (ev.data ?? {}) as Record<string, unknown>;
        const tNo = num(d.turn) ?? num(d.turnNo);
        if (ev.type === 'turn/start' && tNo === lastTurn.turn) {
          startIdx = i;
          break;
        }
      }
      if (startIdx > 0) {
        let tailClean = true;
        for (let i = startIdx; i < len; i += 1) {
          const ev = sortedRecords[i]?.event;
          const d = (ev?.data ?? {}) as Record<string, unknown>;
          const tNo = num(d.turn) ?? num(d.turnNo);
          if (tNo !== undefined && tNo < lastTurn.turn) {
            tailClean = false;
            break;
          }
        }
        if (tailClean) {
          const prefixTurns = turns.slice(0, -1);
          const prefixItems = items.filter((item) => item.turn < lastTurn.turn);
          cache.prefixRecordCount = startIdx;
          cache.tailStartSeq = sortedRecords[startIdx]!.event.seq;
          cache.tailTurnNo = lastTurn.turn;
          cache.prefixTurns = prefixTurns;
          cache.prefixItems = prefixItems;
          checkpointUpdated = true;
        }
      }
    }
  }

  if (!checkpointUpdated) {
    cache.prefixRecordCount = 0;
    cache.tailStartSeq = -1;
    cache.tailTurnNo = -1;
    cache.prefixTurns = [];
    cache.prefixItems = [];
  }

  return { turns, items, usedFastPath };
}
