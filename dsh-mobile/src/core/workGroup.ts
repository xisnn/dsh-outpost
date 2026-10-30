/**
 * 「执行过程组」的纯计算层（F-02）。
 *
 * ## 要解决什么
 *
 * 一轮回答里，模型往往先思考 → 调工具 → 再思考 → 再调工具，最后才给结论。
 * 这些中间过程在手机上很占地方；但执行中又必须让用户看到进度。
 *
 * 所以把「最终回答之前的全部内容」折叠成一个组：
 *   · 执行中：组头显示运行状态 + 最近一次工具动态；
 *   · 执行完：默认折叠成「已执行 N 步 · 耗时 X 秒」；
 *   · 点开：按原始顺序展示思考与工具记录。
 *
 * ## 边界（非常重要）
 *
 * - **只在一轮内聚合**：Turn 是天然边界，绝不跨轮合并；
 * - **最终回答永远独立**：取「最后一个非文本块之后的所有块」作为最终回答，
 *   它们不进入组；
 * - **单工具不折叠**：一个工具调用且没有思考时返回 null，让 ToolCard 直接展示，
 *   避免「为了折叠而折叠」；
 * - **不改事件**：本模块只读 Turn（fold 的产物），不触碰 EventRecord / Store。
 */
import type { Block, Turn } from './fold';

export interface WorkGroupItem {
  /** 在整轮里第几段（从 1 开始，用于 key） */
  index: number;
  step: number;
  block: Block;
}

export interface WorkGroupView {
  turn: number;
  /** 最终回答之前的全部块（思考 / 工具 / 中间说明 / 交付物），保持原始顺序 */
  items: WorkGroupItem[];
  /** 最终回答的块（最后一个非文本块之后的内容） */
  finalBlocks: Block[];
  toolCount: number;
  reasoningCount: number;
  /** 是否还有工具在跑（pending） */
  hasPendingTool: boolean;
  /** 是否有工具失败 */
  failed: boolean;
  running: boolean;
  /** 最近一次工具调用（用于「正在执行」时展示动态） */
  latestTool?: Extract<Block, { kind: 'tool' }>;
  startedAt?: number;
  endedAt?: number;
  /** 耗时（秒，四舍五入；未知为 undefined） */
  durationSec?: number;
}

/**
 * 从一轮构建执行过程组。
 *
 * @returns 不需要分组时返回 null（单工具 / 单段思考 / 纯文本回答）
 */
export function buildWorkGroup(turn: Turn): WorkGroupView | null {
  const flat: WorkGroupItem[] = [];
  let index = 0;
  for (const step of turn.steps) {
    for (const block of step.blocks) {
      index += 1;
      flat.push({ index, step: step.step, block });
    }
  }
  if (flat.length === 0) return null;

  // 最后一个「非文本块」（思考或工具）之后的内容 = 最终回答
  let lastNonText = -1;
  for (let i = 0; i < flat.length; i += 1) {
    const k = flat[i].block.kind;
    if (k === 'reasoning' || k === 'tool') lastNonText = i;
  }
  if (lastNonText < 0) return null; // 纯文本回答，不需要组

  const items = flat.slice(0, lastNonText + 1);
  const finalBlocks = flat.slice(lastNonText + 1).map((x) => x.block);

  const toolBlocks = items
    .map((x) => x.block)
    .filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool');
  const reasoningCount = items.filter((x) => x.block.kind === 'reasoning').length;
  const toolCount = toolBlocks.length;

  // 单个工具调用：直接展示单张 ToolCard（及其思考面板），不再外包一层「已执行 1 步」的折叠组
  if (toolCount === 1) return null;
  // 没有工具、且只有一段思考：交给现有的 ThinkingAccordion，不必再包一层
  if (toolCount === 0 && reasoningCount <= 1) return null;

  const hasPendingTool = toolBlocks.some((b) => b.pending);
  const failed = toolBlocks.some((b) => b.isError);
  const running = !!turn.running || hasPendingTool;

  let durationSec: number | undefined;
  if (typeof turn.startedAt === 'number' && typeof turn.endedAt === 'number') {
    durationSec = Math.max(1, Math.round((turn.endedAt - turn.startedAt) / 1000));
  }

  return {
    turn: turn.turn,
    items,
    finalBlocks,
    toolCount,
    reasoningCount,
    hasPendingTool,
    failed,
    running,
    latestTool: toolBlocks.length > 0 ? toolBlocks[toolBlocks.length - 1] : undefined,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    durationSec,
  };
}

/** 每轮一个组，供聊天页按 turn 取用（不跨轮合并） */
export function buildWorkGroupMap(turns: Turn[]): Map<number, WorkGroupView> {
  const map = new Map<number, WorkGroupView>();
  for (const t of turns) {
    const g = buildWorkGroup(t);
    if (g) map.set(t.turn, g);
  }
  return map;
}

/**
 * 折叠态摘要。
 * 例：「已执行 8 步 · 耗时 25 秒」/「执行失败 · 已执行 3 步 · 耗时 6 秒」
 */
export function workGroupSummary(group: WorkGroupView): string {
  const parts: string[] = [];
  if (group.failed) parts.push('执行失败');
  if (group.toolCount > 0) parts.push(`已执行 ${group.toolCount} 步`);
  else if (group.reasoningCount > 0) parts.push(`已思考 ${group.reasoningCount} 段`);
  if (group.durationSec !== undefined) parts.push(`耗时 ${group.durationSec} 秒`);
  return parts.join(' · ');
}
