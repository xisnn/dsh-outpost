/**
 * 文件上传与附件读取。
 *
 * 实测协议（见 probes/verify-upload*.mjs）：
 *
 *   POST /api/session/uploadFileBinary?sessionId=<id>&name=<文件名>
 *     Content-Type: application/octet-stream
 *     body: 原始字节
 *     → { ok:true, value:{ receiptId, file:{ attachmentId, name, bytes } } }
 *
 *   session/prompt 里引用： { type:'file', receiptId }
 *
 *   session/attachment { sessionId, attachmentId }
 *     → { attachment:{ attachmentId, mediaType, ... }, data:<base64> }
 *
 * 上传走 react-native-blob-util 的 wrap(path)，从磁盘直接流式发送，
 * 不把文件读进 JS 内存（手机上的原图可能十几 MB）。
 */
import ReactNativeBlobUtil from 'react-native-blob-util';
import type { DshConnection } from '../transport';

export interface UploadedFileRef {
  attachmentId: string;
  name: string;
  bytes: number;
}

export interface UploadReceipt {
  receiptId: string;
  file: UploadedFileRef;
}

/** 去掉 file:// 前缀，blob-util 要的是裸路径 */
export function barePath(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
}

export class UploadApi {
  constructor(private readonly conn: DshConnection) {}

  /** 上传原始字节，拿回执（只在同一会话里有效） */
  async uploadBinary(sessionId: string, filePath: string, name: string): Promise<UploadReceipt> {
    const cookie = this.conn.currentCookie;
    if (!cookie) throw new Error('未登录，无法上传');
    const url =
      `${this.conn.baseUrl}/api/session/uploadFileBinary` +
      `?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`;

    const res = await ReactNativeBlobUtil.fetch(
      'POST',
      url,
      { 'Content-Type': 'application/octet-stream', Cookie: cookie },
      ReactNativeBlobUtil.wrap(barePath(filePath)),
    );

    const text = await res.text();
    let parsed: {
      ok?: boolean;
      value?: UploadReceipt;
      error?: { code?: string; message?: string };
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`上传返回不是 JSON：${text.slice(0, 120)}`);
    }
    if (parsed.ok !== true || !parsed.value?.receiptId) {
      throw new Error(parsed.error?.message ?? parsed.error?.code ?? '上传失败');
    }
    return parsed.value;
  }

  /** 读回图片字节（Host 只对图片提供这个接口） */
  async readAttachment(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ mediaType: string; data: string }> {
    // ⚠️ 和 session/page 一样，这个方法的参数要包一层 `request`；
    // 平铺传 { sessionId, attachmentId } 会被 wire 校验拒绝（实测报
    // gateway/arguments-invalid: missing "request"）。
    const res = await this.conn.call<{
      attachment?: { mediaType?: string };
      data?: string;
    }>('session/attachment', { request: { sessionId, attachmentId } });
    if (!res?.data) throw new Error('附件读取失败');
    return { mediaType: res.attachment?.mediaType ?? 'image/png', data: res.data };
  }
}

/** 把本地文件读成 base64（图片内联发送用） */
export async function readFileBase64(uri: string): Promise<string> {
  return ReactNativeBlobUtil.fs.readFile(barePath(uri), 'base64');
}

/** 按扩展名猜 MIME（Host 只接受这几种图片） */
export function guessImageMime(name: string): string | undefined {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return undefined;
  }
}
