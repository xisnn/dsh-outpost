/**
 * 发送失败分类。
 *
 * 保守原则：fetch 阶段异常 / 超时 / 5xx / 响应损坏都可能是“服务端已经
 * 收到并执行，只是回执丢了”，归为 unknown；4xx 和结构化 rpc 拒绝归为
 * definite（确定没执行）。错误文案不包含消息正文。
 */

import { RpcError } from '../rpc-error';
import type { PendingSendError } from './types';

export function classifyPromptFailure(e: unknown): PendingSendError {
  const raw = e instanceof Error ? e.message : String(e);
  let classification: 'definite' | 'unknown' = 'definite';
  let code = 'send-error';

  if (e instanceof RpcError) {
    if (e.kind === 'network') {
      classification = 'unknown';
      code = /timeout|请求超时|AbortError/i.test(e.raw) ? 'timeout' : 'network';
    } else if (e.kind === 'malformed') {
      classification = 'unknown';
      code = 'malformed-response';
    } else if (e.kind === 'http') {
      const match = /HTTP (\d{3})/.exec(e.raw);
      const status = match ? Number(match[1]) : 0;
      if (status >= 500 || status === 408 || status === 429) {
        classification = 'unknown';
        code = `http-${status || 'server'}`;
      } else {
        classification = 'definite';
        code = `http-${status || 'client'}`;
      }
    } else {
      classification = 'definite';
      code = 'rpc-rejected';
    }
  } else if (/AbortError|timeout|请求超时|Network request failed|ECONN|ENOTFOUND/i.test(raw)) {
    classification = 'unknown';
    code = /timeout|请求超时|AbortError/i.test(raw) ? 'timeout' : 'network';
  } else {
    // 本地校验、未登录、持久化失败等 — 还未进入 prompt 或明确未被接受
    classification = 'definite';
    code = 'local-error';
  }

  return {
    classification,
    code,
    // 只保存短错误码/安全摘要，完整错误留在内存给 UI 判断
    message: raw.slice(0, 200),
  };
}

/**
 * prompt 返回成功之后，本地 accepted 状态写入失败。
 *
 * ⚠️ 这时**不能**对用户说“没发出去”：服务端已经受理，requestId 必须保留。
 * 记录仍停在 sending，重启 hydrate 会保守归类为 unknown；用户重试同 ID
 * 仍然安全。
 */
export class PendingSendPostAcceptError extends Error {
  readonly requestId: string;
  readonly cause?: unknown;

  constructor(requestId: string, cause?: unknown) {
    super('server accepted but local accepted-state write failed');
    this.name = 'PendingSendPostAcceptError';
    this.requestId = requestId;
    if (cause !== undefined) this.cause = cause;
  }
}

/** prompt 失败后，本地 failed/unknown 状态写入失败。 */
export class PendingSendFailurePersistError extends Error {
  readonly requestId: string;
  readonly cause?: unknown;

  constructor(requestId: string, cause?: unknown) {
    super('send failed but local failure-state write failed');
    this.name = 'PendingSendFailurePersistError';
    this.requestId = requestId;
    if (cause !== undefined) this.cause = cause;
  }
}

