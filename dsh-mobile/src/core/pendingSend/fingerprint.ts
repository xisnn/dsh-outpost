/**
 * 发送意图指纹。
 *
 * 指纹只用于：
 *   · UI 提示“这条未决记录和当前输入内容是否一致”
 *   · 测试证明改文字/改附件会得到不同身份
 *
 * ⚠️ **不能用于自动复用 requestId**。正常发送永远新建记录、新 requestId；
 * 只有用户明确点“重试”某条未决记录，才允许复用该记录的 ID。
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface FingerprintAttachment {
  kind: 'image' | 'file';
  name: string;
  size: number;
  mime?: string;
  /** 文件内容 SHA-256（十六进制小写） */
  contentSha256: string;
}

/** 规范化待比较的文本：与发送时的 trim 保持一致，统一换行。 */
export function normalizeSendText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/** UTF-8 字节数（不依赖 Buffer/TextEncoder，RN Hermes 可用）。 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** UTF-8 编码（不依赖 TextEncoder，RN Hermes 也可用）。 */
export function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes.push(cp);
    else if (cp <= 0x7ff) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8Encode(value)));
}

/**
 * 计算发送意图指纹。
 *
 * 附件顺序也算身份的一部分：同一组附件换顺序就是不同意图。
 * `localUri` 不参与指纹 —— 同一文件移动路径不应改变身份；
 * 真正的内容身份由 `contentSha256` 决定。
 */
export function computeSendFingerprint(
  text: string,
  mode: 'queue' | 'steer',
  attachments: FingerprintAttachment[],
): string {
  const canonical = JSON.stringify({
    v: 1,
    text: normalizeSendText(text),
    mode,
    attachments: attachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      size: a.size,
      mime: a.mime ?? null,
      sha256: a.contentSha256.toLowerCase(),
    })),
  });
  return sha256Hex(canonical);
}

/** 两个附件数组在身份意义上是否相同（供测试/UI 冲突检测）。 */
export function sameAttachmentIdentity(
  a: FingerprintAttachment[],
  b: FingerprintAttachment[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return (
      item.kind === other.kind &&
      item.name === other.name &&
      item.size === other.size &&
      (item.mime ?? null) === (other.mime ?? null) &&
      item.contentSha256.toLowerCase() === other.contentSha256.toLowerCase()
    );
  });
}
