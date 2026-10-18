/**
 * 配对信息的解析（纯逻辑，不依赖 React Native，方便单测）。
 *
 * 手机端接受三种输入：
 *   1. 完整链接：http://host:port/?token=xxx（扫码 / 剪贴板 / 手填）
 *   2. 裸 token：URL-safe base64 字符（A-Z a-z 0-9 - _）
 *   3. 带引号/空白的粘贴内容（用户从终端复制时常见）
 */

export interface PairingInfo {
  /** 只在链接里带了地址时才有 */
  baseUrl?: string;
  token: string;
}

const URL_WITH_TOKEN = /^(https?:\/\/[^\s?#]+)[^\s]*[?&]token=([^\s&]+)/i;
const BARE_TOKEN = /^[A-Za-z0-9_-]{16,}$/;

/** 去掉首尾空白和包裹的引号（单/双/中文引号） */
function clean(text: string): string {
  return text
    .trim()
    .replace(/^["'“”‘’]+/, '')
    .replace(/["'“”‘’]+$/, '')
    .trim();
}

export function normalizeBaseUrl(text: string): string {
  return text.trim().replace(/\/+$/, '');
}

/**
 * 从一段文本里认出配对信息；认不出返回 null。
 */
export function parsePairingText(text: string): PairingInfo | null {
  const t = clean(text);
  if (!t) return null;

  const m = URL_WITH_TOKEN.exec(t);
  if (m) {
    return { baseUrl: normalizeBaseUrl(m[1]), token: decodeURIComponent(m[2]) };
  }
  if (BARE_TOKEN.test(t)) {
    return { token: t };
  }
  return null;
}
