/**
 * 更新包完整性校验的纯逻辑。
 *
 * 单独抽出来是为了能直接单测 —— `updater.ts` 顶层 import 了
 * `react-native`（Linking / Platform），Node 侧没法加载。
 *
 * 这里只有「从文本里取哈希」「比较哈希」这类纯函数，没有 IO、没有平台依赖。
 */

/** 一个 release 里可用的哈希来源 */
export interface IntegrityExpectation {
  /** SHA256SUMS.txt 的内容（可能是 undefined：资产不存在 / 拉取失败） */
  sumsText?: string;
  /** release body 里内联的哈希（可能是 undefined） */
  notesHash?: string;
  /** APK 在 release 里的文件名 */
  apkFileName: string;
}

export interface ExpectedHash {
  sha256: string;
  source: 'sums' | 'notes';
}

/**
 * 从 SHA256SUMS.txt 里取出指定文件名的哈希。
 *
 * 格式是 `sha256sum` 的标准输出：
 *   `<64 hex>  <filename>`   ← 文本模式（两个空格）
 *   `<64 hex> *<filename>`   ← 二进制模式
 *
 * 容忍：CRLF、注释行、`./` 前缀、文件名带目录前缀。
 * 不容忍：哈希位数不对、文件名不匹配 —— 一律返回 undefined，
 * 让上层当成「拿不到期望值」处理（**不能**退化成「随便拿一个」）。
 *
 * @returns 小写 hex；找不到或格式不对返回 undefined
 */
export function parseSumsFile(text: string, apkFileName: string): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const want = String(apkFileName ?? '').trim().toLowerCase();
  if (!want) return undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-fA-F0-9]{64})\s+[* ]?(\S.*)$/.exec(line);
    if (!m) continue;
    const name = m[2].trim().replace(/^\.\//, '').toLowerCase();
    if (name === want || name.endsWith('/' + want)) return m[1].toLowerCase();
  }
  return undefined;
}

/**
 * 决定「应该期望的哈希是什么、来自哪里」。
 *
 * 优先 SHA256SUMS.txt（独立文件，能发现「只换了 APK」）；
 * 没有再退到 release body 里内联的哈希。
 *
 * ## 为什么两者都没有时必须失败
 *
 * 旧实现只比文件大小。大小相同、内容不同的替换能直接过。
 * 所以「拿不到期望哈希」不能退化成「跳过校验」—— 那等于把门禁默认关掉。
 * 返回 undefined，由调用方拒绝安装。
 */
export function resolveExpectedHash(exp: IntegrityExpectation): ExpectedHash | undefined {
  const fromSums = exp.sumsText ? parseSumsFile(exp.sumsText, exp.apkFileName) : undefined;
  if (fromSums) return { sha256: fromSums, source: 'sums' };

  const note = String(exp.notesHash ?? '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(note)) return { sha256: note, source: 'notes' };

  return undefined;
}

/**
 * 比较实际哈希与期望哈希。
 *
 * 只接受 64 位 hex；任何异常输入都判定为不匹配（fail-closed）。
 */
export function hashMatches(actual: string, expected: string): boolean {
  const a = String(actual ?? '').trim().toLowerCase();
  const e = String(expected ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(e)) return false;
  return a === e;
}

/** 从 URL 里取最后一段作为文件名（GitHub 的下载链接会 302 到 CDN） */
export function fileNameOfUrl(url: string): string {
  try {
    const p = new URL(url).pathname;
    const last = p.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return String(url ?? '').split('/').pop() ?? '';
  }
}
