/**
 * 判断一个 cwd 是不是 DSH 自己产生的**临时工作区**。
 *
 * ## 为什么要过滤
 *
 * DSH 在跑某些内部任务（扫描、子代理、临时实验）时会用系统临时目录
 * 建工作区，路径形如：
 *
 *   C:\Users\xis\AppData\Local\Temp\dsh-prop-h2ony2ku
 *   C:\Users\xis\AppData\Local\Temp\dshsk4-fe1536f1...
 *
 * 这些不是用户的项目，但会出现在工作区列表里。实测一台机器上
 * **173 个会话里有 46 个是这种临时目录**，真实项目只剩 3 个，
 * 列表完全没法看。
 *
 * ## 判定规则（宁可漏，不可错杀）
 *
 * 同时满足「在系统临时目录下」+「名字像 DSH 生成的」，才认为是临时。
 * 只满足一条不拦——用户完全可能把自己的项目放在 Temp 下（少见但合法），
 * 也可能有个正常项目叫 dsh-prop-xxx（更少见但也有可能）。
 *
 * 另外**绝对不能**用「会话数量少」当判据：真实的新项目就是只有 1 个会话，
 * 那样会把用户刚建的项目藏起来。
 */

/** 系统临时目录的特征（Windows / macOS / Linux） */
const TEMP_DIR_PATTERNS = [
  /[\\/]appdata[\\/]local[\\/]temp[\\/]/i, // Windows
  /[\\/]temp[\\/]/i, // macOS / Linux
  /[\\/]tmp[\\/]/i, // Linux
  /^\/var\/folders\//i, // macOS 的另一种临时目录
];

/** 目录名本身就是临时目录根（`...\Temp`、`/tmp`、`/var/folders`） */
const IS_TEMP_ROOT = [
  /[\\/](temp|tmp)$/i,
  /^\/var\/folders(\/.*)?$/i,
];

/** DSH 自动生成的临时目录名前缀 */
const DSH_TEMP_PREFIX = /^dsh[-_]/i;

/** 取出路径最后一段（跨平台） */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * 这个 cwd 是不是 DSH 的临时工作区。
 *
 * @param cwd 工作区绝对路径
 */
export function isTempWorkspace(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const normalized = cwd.trim();
  if (!normalized) return false;

  // 临时目录根本身（`C:\Users\xis\AppData\Local\Temp`、`/tmp`）也不是项目。
  // 实测确实会冒出来一个叫「Temp」的工作区，里面就 1 个未命名会话。
  if (IS_TEMP_ROOT.some((re) => re.test(normalized))) return true;

  const inTempDir = TEMP_DIR_PATTERNS.some((re) => re.test(normalized));
  if (!inTempDir) return false;

  // 在临时目录下，再看名字：
  // - dsh-prop-xxx / dshsk4-xxx（DSH 生成的）
  // - 或者干脆是个裸目录（没有项目名特征）
  const name = basename(normalized);
  if (DSH_TEMP_PREFIX.test(name)) return true;

  // 兜底：临时目录下名字里带一长串十六进制/随机后缀的，也基本是工具生成的
  // 例：dshsk4-fe1536f1c9d64da4a40a2a28d7dd085b
  if (/^[a-z0-9]{1,12}[-_][0-9a-f]{16,}$/i.test(name)) return true;

  return false;
}

/**
 * 过滤掉临时工作区。
 *
 * 保持原顺序，不做其他改动 —— 只剔除，不排序不重排。
 */
export function dropTempWorkspaces<T extends { path: string }>(workspaces: T[]): T[] {
  return workspaces.filter((w) => !isTempWorkspace(w.path));
}
