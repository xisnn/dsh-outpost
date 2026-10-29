/**
 * 「回到底部」按钮与「有新内容」提示的判定逻辑（纯函数，可单测）。
 *
 * ## 为什么单独抽一个文件
 *
 * 聊天页的滚动状态是三条不同来源的事实叠在一起：
 *   1. **离底距离**（用户在读历史 → 不该被自动滚走，但要给一条回得去的路）
 *   2. **列表尾部有没有新增**（新内容提示只该由「末尾增长」触发）
 *   3. **加载更早**（头部增长，属于往回翻，绝不能被当成「有新内容」）
 *
 * 三者的判据都在这里写成纯函数：滚动相关的 bug 在模拟器上很难稳定复现，
 * 只能靠对数值的断言保证。
 *
 * ## 两个阈值 + 迟滞
 *
 * 按钮「出现」和「消失」用不同阈值（160 / 96）。同一个阈值会让按钮在
 * 手指刚好停在边界时反复闪 —— 迟滞区间是这类浮动控件的基本要求。
 */

/** 距底部超过这个距离才浮出「回到底部」按钮 */
export const AWAY_FROM_BOTTOM_PX = 160;

/**
 * 迟滞下界：已经显示的按钮，回到底部附近（<96px）才收起。
 *
 * 必须严格小于 AWAY_FROM_BOTTOM_PX —— 否则「显示阈值」和「隐藏阈值」
 * 颠倒，按钮要么永不显示、要么永不隐藏。
 */
export const RETURN_TO_BOTTOM_PX = 96;

/** 「贴底」阈值：内容增长时是否自动跟随到底（沿用 v0.17 原值） */
export const NEAR_BOTTOM_PX = 80;

/** 列表尾部签名：只取判定需要的三样，避免把整个 ChatItem 拖进纯函数 */
export interface ScrollItemLike {
  key: string;
  kind: string;
  /** user / teammate 项的正文 */
  text?: string;
  /** assistant 项的块（结构未知，只按需读 text 字段） */
  blocks?: readonly unknown[];
}

export interface ListTail {
  /** 首项 key：头部变了说明往前面插了东西（加载更早） */
  firstKey: string;
  /** 末项 key：尾部变了说明末尾新增了内容 */
  lastKey: string;
  length: number;
  /** 末项的内容长度：同一项内流式增长时 key 不变，只能靠它判断「还在长」 */
  lastSize: number;
}

/** 一项内容的粗略长度（只用于「有没有增长」的比较，不需要精确） */
function itemSize(item: ScrollItemLike): number {
  if (typeof item.text === 'string') return item.text.length;
  if (Array.isArray(item.blocks)) {
    let n = 0;
    for (const b of item.blocks) {
      if (!b || typeof b !== 'object' || !('text' in b)) continue;
      const t = (b as { text?: unknown }).text;
      if (typeof t === 'string') n += t.length;
    }
    return n;
  }
  return 0;
}

/** 取列表尾部签名。空列表返回空签名（后续 change 一律判定为 none） */
export function tailOf(items: readonly ScrollItemLike[]): ListTail {
  if (items.length === 0) return { firstKey: '', lastKey: '', length: 0, lastSize: 0 };
  const first = items[0];
  const last = items[items.length - 1];
  return {
    firstKey: first.key,
    lastKey: last.key,
    length: items.length,
    lastSize: itemSize(last),
  };
}

/**
 * 列表变化的类型。
 *
 * - `appended`  末尾多了新项（新一轮 / 新的助手步骤）→ 值得提示「有新内容」
 * - `grew`      末项没变但内容变长了（流式输出继续）→ 同样值得提示
 * - `prepended` 头部多了旧项（加载更早）→ **不是**新内容，绝不能提示
 * - `replaced`  头尾都变了（换会话 / 整体重载）→ 不提示
 * - `none`      没变
 */
export type ListChange = 'none' | 'appended' | 'grew' | 'prepended' | 'replaced';

export function classifyListChange(prev: ListTail | null, next: ListTail): ListChange {
  if (!prev) return 'none';
  // 空列表参与比较没有意义（首次加载完成、或清空）
  if (prev.length === 0 || next.length === 0) return 'none';

  const tailMoved = prev.lastKey !== next.lastKey;
  const headMoved = prev.firstKey !== next.firstKey;

  if (tailMoved && headMoved) return 'replaced';
  if (tailMoved) return 'appended';
  if (headMoved) return 'prepended';
  // 头尾都没变：可能是末项在流式增长，也可能是中间项被更新
  if (next.lastSize > prev.lastSize) return 'grew';
  return 'none';
}

/**
 * 现在该不该显示「回到底部」按钮。
 *
 * @param distance  距底部像素（负数/NaN 视为贴底）
 * @param wasVisible 上一帧是否已显示 —— 用来做迟滞
 */
export function shouldShowJumpToBottom(distance: number, wasVisible: boolean): boolean {
  if (!Number.isFinite(distance) || distance <= 0) return false;
  return wasVisible ? distance > RETURN_TO_BOTTOM_PX : distance > AWAY_FROM_BOTTOM_PX;
}

/**
 * 这次变化要不要亮「有新内容」圆点。
 *
 * 判据是「末尾真的长了」且「用户确实不在底部」：
 *   · 贴底时（<=NEAR_BOTTOM_PX）内容会自己跟到底，提示是多余的；
 *   · 加载更早（prepended）不是新内容。
 */
export function shouldMarkNewContent(change: ListChange, distance: number): boolean {
  if (change !== 'appended' && change !== 'grew') return false;
  if (!Number.isFinite(distance)) return false;
  return distance > NEAR_BOTTOM_PX;
}

/** 由一次 onScroll 的三个度量算出离底距离（永不为负） */
export function distanceFromBottom(metrics: {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
}): number {
  const d = metrics.contentHeight - metrics.offsetY - metrics.viewportHeight;
  if (!Number.isFinite(d)) return 0;
  return d > 0 ? d : 0;
}
