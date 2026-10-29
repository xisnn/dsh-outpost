/**
 * RPC 错误：带分类、带可操作建议。
 *
 * ## 为什么要自定义错误类型
 *
 * 原来所有失败都抛 `new Error('session/page: gateway/not-found')`。
 * 用户看到的是一串内部标识 —— 既不知道严重程度，也不知道该做什么。
 *
 * 现在每个错误都带：
 *   · `kind`     —— 机器可判别的分类（界面按它决定显示样式）
 *   · `endpoint` —— 哪个接口失败的
 *   · `userTitle`/`userHint` —— 直接能给用户看的中文
 *   · `raw`      —— 原始信息，折叠在「详情」里
 *
 * ## 为什么不直接显示上游错误
 *
 * 上游错误是给开发者看的。用户需要的是「我该干什么」。
 * 两者都要保留：`message` 给日志和开发者，`userHint` 给界面。
 */

/** 错误分类 */
export type RpcErrorKind =
  /** 抓取阶段失败（网络不通、DNS、超时） */
  | 'network'
  /** HTTP 状态码非 2xx */
  | 'http'
  /** 响应结构不对（200 但没有 result） */
  | 'malformed'
  /** RPC 返回 ok:false */
  | 'rpc';

export class RpcError extends Error {
  readonly endpoint: string;
  readonly kind: RpcErrorKind;
  /** 原始错误码/信息（可能是上游的 gateway/not-found 之类） */
  readonly raw: string;
  /** 给用户看的一句话标题 */
  readonly userTitle: string;
  /** 给用户看的具体建议 */
  readonly userHint: string;
  /** 是否值得重试（网络类通常值得，接口不存在不值得） */
  readonly retryable: boolean;

  constructor(args: {
    endpoint: string;
    kind: RpcErrorKind;
    raw: string;
    userTitle: string;
    userHint: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    // message 保持「开发者格式」，日志里一眼能看出是哪个接口
    super(`${args.endpoint}: ${args.raw}`);
    this.name = 'RpcError';
    this.endpoint = args.endpoint;
    this.kind = args.kind;
    this.raw = args.raw;
    this.userTitle = args.userTitle;
    this.userHint = args.userHint;
    this.retryable = args.retryable;
    if (args.cause !== undefined) {
      (this as { cause?: unknown }).cause = args.cause;
    }
  }
}

/** 判断一个错误是不是「接口不存在」——意味着版本不匹配 */
export function isEndpointMissing(err: unknown): boolean {
  if (err instanceof RpcError) {
    return /not-?found|unknown\s+method|unimplemented/i.test(err.raw);
  }
  return false;
}

/**
 * 判断是不是**明确的凭据失效（401）** —— 需要重新配对（P0-3）。
 *
 * ⚠️ 注意区分 401 与 403：
 * DSH 服务端（`dsh-client-connection`）只在 Cookie/Token 无效或缺失时返回 401；
 * 而 403 来自 `isTrustedApiRequest()`（Host 不在 trustedHosts、跨源 Origin）或
 * 非 owner 权限限制，**此时 Cookie 本身是有效的**，绝不能把 403 当作 Cookie 失效
 * 或自动清除凭据。
 */
export function isAuthFailure(err: unknown): boolean {
  if (err instanceof RpcError) {
    if (err.kind === 'http') return /(^|[^0-9])401([^0-9]|$)/.test(err.raw);
    return /unauthor|invalid.*(token|cookie)/i.test(err.raw);
  }
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /(^|[^0-9])401([^0-9]|$)|unauthorized|not authenticated/i.test(text);
}

/** 判断是不是 403 访问被拒绝（如 Host 未受信任 / Origin 不匹配，凭据本身仍有效） */
export function isForbiddenRejection(err: unknown): boolean {
  if (err instanceof RpcError) {
    if (err.kind === 'http') return /(^|[^0-9])403([^0-9]|$)/.test(err.raw);
    return /forbidden/i.test(err.raw);
  }
  const text = err instanceof Error ? err.message : String(err ?? '');
  return /(^|[^0-9])403([^0-9]|$)|forbidden/i.test(text);
}

/** 是否值得自动重试 */
export function isRetryable(err: unknown): boolean {
  return err instanceof RpcError ? err.retryable : false;
}
