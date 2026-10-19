/**
 * 版本号比较（纯函数，不依赖 React Native，方便单测）。
 *
 * 支持 v0.2.0 / 0.2.0 / v0.2.0-beta.1 等写法：
 * 只取前导数字段，忽略后缀（beta、rc 等按「不大于正式版」处理）。
 */

/** 把版本串拆成数字数组，遇到非数字后缀就停 */
export function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((p) => parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
}

/** a 是否比 b 新 */
export function isNewer(a: string, b: string): boolean {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i += 1) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
