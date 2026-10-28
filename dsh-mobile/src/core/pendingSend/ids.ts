/**
 * requestId 生成。
 *
 * ⚠️ 正常新发送**永远**生成新 ID；只有用户明确重试某条未决记录时，
 * 才由 PendingSendStore.retry() 复用记录里的旧 ID。
 *
 * 这里不是安全令牌，不依赖密码学随机；要求是足够高的碰撞阻力：
 * 毫秒时间戳 + 进程内单调计数 + 两段随机后缀。测试可注入 now/random。
 */

let counter = 0;

export interface RequestIdFactory {
  (): string;
}

export function createRequestId(
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  counter = (counter + 1) % 0x7fffffff;
  const ts = Math.floor(now()).toString(36);
  const seq = counter.toString(36);
  const r1 = Math.floor(random() * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  const r2 = Math.floor(random() * 0x100000000)
    .toString(36)
    .padStart(7, '0');
  return `req-${ts}-${seq}-${r1}${r2}`;
}

/** 测试用：重置进程内计数器（生产代码不应调用）。 */
export function __resetRequestIdCounterForTest(): void {
  counter = 0;
}
