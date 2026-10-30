/**
 * F-01 通知按 kind + sessionId 分桶去重纯逻辑（不依赖 React Native，可直接单测）。
 *
 * 核心目标：
 *   - 按 `kind + sessionId` 独立冷却（3000ms）；
 *   - `done`（任务完成）通知绝不能吞掉紧随其后的 `approval`（待审批）通知；
 *   - 不同会话之间的通知互不阻塞。
 */

export type NotifyKind = 'done' | 'fail' | 'ask' | 'approval';

export const NOTIFY_MIN_GAP_MS = 3000;

export function notifyBucketKey(kind: NotifyKind = 'done', sessionId?: string): string {
  const sid = sessionId && sessionId.trim() ? sessionId.trim() : '__global__';
  return `${kind}:${sid}`;
}

/**
 * 判断本次通知是否应被节流拦截；若放行则同步更新对应桶的时间戳。
 */
export function shouldThrottleNotify(
  buckets: Map<string, number>,
  opts: {
    kind?: NotifyKind;
    sessionId?: string;
    now: number;
    force?: boolean;
    minGapMs?: number;
  },
): boolean {
  const kind = opts.kind ?? 'done';
  const minGapMs = opts.minGapMs ?? NOTIFY_MIN_GAP_MS;
  const key = notifyBucketKey(kind, opts.sessionId);
  const lastAt = buckets.get(key);
  if (!opts.force && lastAt !== undefined && opts.now - lastAt < minGapMs) return true;
  buckets.set(key, opts.now);
  return false;
}
