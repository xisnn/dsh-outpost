#!/usr/bin/env node
/**
 * 从发布 Tag 推导 Android versionCode / versionName，并做**单调递增门禁校验**。
 *
 * ## 为什么需要这个脚本，而不是继续写在 workflow 的 bash 里
 *
 * 旧实现是 workflow 里一段内联 bash：
 *
 *   CODE=$(( MAJ * 1000000 + MIN * 1000 + ${PAT:-0} ))
 *
 * 它有两个真实问题：
 *
 * 1. **公式容量不够**：`minor*1000 + patch` 里 patch 只有 0–999，
 *    但 `v0.16.3` 会得到 `16003` —— 而上一轮已交付的验收测试包是
 *    `versionCode=16200`。也就是说**新版本号反而比用户手上那个包装得早**，
 *    Android 会拒绝覆盖安装（`INSTALL_FAILED_VERSION_DOWNGRADE`）。
 *
 * 2. **无法本地复现/测试**：内联 bash 只能在 CI 里跑，改公式没有任何
 *    测试保护。这里抽成纯 Node 脚本，配 `tests/version-code-spec.mjs`
 *    做单元测试，公式变更会被测试挡住。
 *
 * ## 新公式
 *
 *     CODE = MAJ * 1000000 + MIN * 10000 + PAT * 100
 *
 * | Tag | versionCode | 说明 |
 * |---|---|---|
 * | v0.16.2 | 160200 | 已发布（当时旧公式算出 16002） |
 * | v0.16.3 | 160300 | 本轮候选 |
 * | v0.17.0 | 170000 | |
 * | v1.0.0  | 1000000 | |
 *
 * 位宽：major 不限；minor 0–99；patch 0–99。
 * 因为 minor 最大 990000、patch 最大 9900，合计 999900 < 1000000，
 * **永远不会进位污染 major**。每个 minor 有 100 个 patch 位置，
 * 每个 major 有 100 个 minor 位置 —— 对一个移动端项目足够长期使用。
 *
 * ## 单调递增门禁
 *
 * 只算对公式还不够。已发布的 versionCode 是**历史事实**，公式怎么改都
 * 不能让它变小。所以这里还读一个仓库内的「已发布水位线」文件
 * `.github/release-floor.json`，要求：
 *
 *     算出的 CODE 必须 **严格大于** 水位线
 *
 * 水位线只增不减（发布后手工抬高，或由发布流程自动更新）。
 * 这样「改了公式导致新版本号比线上还小」这类事故会在 CI 里立刻失败，
 * 而不是等用户装不上才发现。
 *
 * ## 用法
 *
 *   node scripts/version-code.mjs --tag v0.16.3
 *   node scripts/version-code.mjs --tag v0.16.3 --github-output
 *   node scripts/version-code.mjs --tag v0.16.3 --json
 *
 * 退出码：0 成功；1 参数/格式错误；2 单调性校验失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（脚本在 dsh-mobile/scripts/ 下） */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FLOOR_FILE = path.join(REPO_ROOT, '.github', 'release-floor.json');

/** 版本号的位宽约束 */
export const VERSION_LIMITS = {
  minorMax: 99,
  patchMax: 99,
};

export class VersionError extends Error {
  constructor(message, kind = 'format') {
    super(message);
    this.name = 'VersionError';
    this.kind = kind; // 'format' | 'monotonic'
  }
}

/**
 * 解析 `vX.Y.Z` 形式的 Tag。
 *
 * 只接受带 `v` 前缀的三段式版本。**不接受**预发布后缀（`-beta` 等）：
 * 那会让 versionName 与 tag 不一致，应用内更新比较也容易出错。
 * 如果将来需要，必须同时定义清楚 versionName 的规范化规则。
 *
 * @param {string} rawTag
 * @returns {{ tag: string, version: string, major: number, minor: number, patch: number }}
 */
export function parseTag(rawTag) {
  const tag = String(rawTag ?? '').trim();
  if (!tag) throw new VersionError('缺少 tag');
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new VersionError(
      `tag 格式必须是 vX.Y.Z（三段数字），收到：${tag}`,
    );
  }
  const version = tag.slice(1);
  const [major, minor, patch] = version.split('.').map((n) => Number(n));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    throw new VersionError(`tag 里有非整数段：${tag}`);
  }
  if (major < 0 || minor < 0 || patch < 0) {
    throw new VersionError(`tag 里有负数段：${tag}`);
  }
  if (minor > VERSION_LIMITS.minorMax) {
    throw new VersionError(
      `minor 段 ${minor} 超出上限 ${VERSION_LIMITS.minorMax}（会与 major 位冲突）`,
    );
  }
  if (patch > VERSION_LIMITS.patchMax) {
    throw new VersionError(
      `patch 段 ${patch} 超出上限 ${VERSION_LIMITS.patchMax}（会与 minor 位冲突）`,
    );
  }
  return { tag, version, major, minor, patch };
}

/**
 * 由版本段算出 versionCode（纯函数）。
 *
 * @param {{ major: number, minor: number, patch: number }} v
 * @returns {number}
 */
export function computeVersionCode(v) {
  const code = v.major * 1000000 + v.minor * 10000 + v.patch * 100;
  if (!Number.isSafeInteger(code)) {
    throw new VersionError(`versionCode 溢出：${code}`);
  }
  return code;
}

/**
 * 读已发布水位线。
 *
 * 文件缺失视为严重错误：**没有水位线就没有单调性保证**，
 * 宁可让发布失败，也不要在不知道线上版本的情况下发出去。
 *
 * @returns {{ minVersionCode: number, note?: string }}
 */
export function readFloor(floorFile = FLOOR_FILE) {
  let raw;
  try {
    raw = fs.readFileSync(floorFile, 'utf8');
  } catch {
    throw new VersionError(
      `读不到已发布水位线文件：${floorFile}\n` +
        `这是发布门禁的必需输入，缺失时不能发布（否则无法保证 versionCode 单调递增）。`,
      'monotonic',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VersionError(`水位线文件不是合法 JSON：${floorFile}`, 'monotonic');
  }
  const min = parsed?.minVersionCode;
  if (!Number.isSafeInteger(min) || min < 0) {
    throw new VersionError(
      `水位线文件缺少合法的 minVersionCode（整数）：${floorFile}`,
      'monotonic',
    );
  }
  return parsed;
}

/**
 * 完整推导 + 校验。
 *
 * @param {string} tag
 * @param {{ floorFile?: string }} [opts]
 */
export function deriveVersion(tag, opts = {}) {
  const parsed = parseTag(tag);
  const code = computeVersionCode(parsed);
  const floor = readFloor(opts.floorFile ?? FLOOR_FILE);

  if (code <= floor.minVersionCode) {
    throw new VersionError(
      `versionCode 没有递增：本次算出 ${code}，而已发布水位线是 ${floor.minVersionCode}。\n` +
        `新版本必须严格大于水位线，否则已安装用户无法覆盖升级。\n` +
        `（Tag ${parsed.tag}。如果公式或 tag 选错了，请修正后再发布。）`,
      'monotonic',
    );
  }

  return {
    tag: parsed.tag,
    version: parsed.version,
    code,
    floor: floor.minVersionCode,
  };
}

/** 把结果写成 GitHub Actions 的 `GITHUB_OUTPUT` 格式 */
export function formatGithubOutput(result) {
  const lines = [
    `version=${result.version}`,
    `code=${result.code}`,
    `tag=${result.tag}`,
  ];
  // 多行输出需要 heredoc；这里都是单行，直接逐行即可
  return lines.join('\n');
}

// ── CLI ────────────────────────────────────────────────────────────
function main(argv) {
  const args = argv.slice(2);
  const getFlag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const hasFlag = (name) => args.includes(name);

  // 支持从 $GITHUB_REF_NAME 回退，方便 CI 里少传一个参数
  const tag = getFlag('--tag') ?? process.env.GITHUB_REF_NAME;
  if (!tag) {
    console.error('用法: node scripts/version-code.mjs --tag vX.Y.Z [--json|--github-output]');
    process.exit(1);
  }

  let result;
  try {
    result = deriveVersion(tag, { floorFile: getFlag('--floor') });
  } catch (e) {
    if (e instanceof VersionError) {
      console.error(`::error::${e.message}`);
      process.exit(e.kind === 'monotonic' ? 2 : 1);
    }
    throw e;
  }

  if (hasFlag('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (hasFlag('--github-output')) {
    process.stdout.write(formatGithubOutput(result) + '\n');
  } else {
    console.log(`tag         : ${result.tag}`);
    console.log(`versionName : ${result.version}`);
    console.log(`versionCode : ${result.code}  (水位线 ${result.floor}，严格大于 ✓)`);
  }
}

// 只在被直接执行时跑 CLI（被 import 时不要执行）
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv);
