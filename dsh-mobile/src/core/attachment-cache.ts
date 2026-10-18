/**
 * 历史图片的字节缓存。
 *
 * 会话记录里只存 `attachmentId`，图片本体要用 `session/attachment` 再取一次（base64）。
 * 这里做三件事：
 *  1. 结果按 `sessionId|attachmentId` 缓存，同一张图只取一次
 *  2. 同一张图并发请求合并（列表重渲染时会同时触发很多次）
 *  3. 失败也记住，避免坏图无限重试
 */
import type { UploadApi } from './rpc/upload';

const uris = new Map<string, string>();
const failed = new Set<string>();
const inflight = new Map<string, Promise<string | undefined>>();

const keyOf = (sessionId: string, attachmentId: string) => `${sessionId}|${attachmentId}`;

/** 同步取缓存（有就直接用，避免首帧闪烁） */
export function cachedImageUri(sessionId: string, attachmentId: string): string | undefined {
  return uris.get(keyOf(sessionId, attachmentId));
}

export function imageFailed(attachmentId: string, sessionId: string): boolean {
  return failed.has(keyOf(sessionId, attachmentId));
}

/** 取图片的 data URI；失败返回 undefined */
export function loadImageUri(
  api: UploadApi,
  sessionId: string,
  attachmentId: string,
): Promise<string | undefined> {
  const key = keyOf(sessionId, attachmentId);
  const hit = uris.get(key);
  if (hit) return Promise.resolve(hit);
  if (failed.has(key)) return Promise.resolve(undefined);
  const running = inflight.get(key);
  if (running) return running;

  const p = api
    .readAttachment(sessionId, attachmentId)
    .then(({ mediaType, data }) => {
      const uri = `data:${mediaType};base64,${data}`;
      uris.set(key, uri);
      return uri;
    })
    .catch(() => {
      failed.add(key);
      return undefined;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}
