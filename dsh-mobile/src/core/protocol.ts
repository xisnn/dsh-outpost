/**
 * 协议兼容性：DSH 接口清单、版本检测、友好错误。
 *
 * ## 要解决什么问题
 *
 * 客户端直接依赖 DSH 的 15 个 RPC 接口和 11 种事件类型。上游一改，
 * 用户看到的报错是：
 *
 *   session/page: gateway/not-found   ← 看不懂
 *   session/list: undefined undefined ← 更看不懂
 *
 * 用户既不知道「是我网络问题还是 App 过期了」，也不知道该怎么办。
 *
 * 这个文件做三件事：
 *   1. **记录依赖清单** —— 哪些接口、哪些字段是必需的
 *   2. **检测不兼容** —— 收到 not-found / 字段缺失时判定是哪类问题
 *   3. **给出可操作的建议** —— 升级 App / 升级 DSH / 报 issue
 *
 * ## 为什么不做「版本号协商」
 *
 * DSH 没有暴露协议版本号的接口（`account/getState` 里只有账户状态）。
 * 而且语义化版本号也不可靠 —— 上游可能 patch 版本里改接口。
 *
 * 所以采用**能力探测**：不猜版本，而是看「我需要的东西在不在」。
 * 这比版本号更准，也不会因为上游没更新版本号而误判。
 */

/** 客户端依赖的 RPC 接口（改这个列表要同步改 CONTRACT） */
export const REQUIRED_ENDPOINTS = [
  'session/list',
  'session/create',
  'session/page',
  'session/prompt',
  'session/cancel',
  'session/rename',
  'session/attachment',
  'session/modelCatalog',
  'session/selectModel',
  'session/updateQueue',
  'workspace/create',
  'workspace/archiveSession',
  'workspace/unarchiveSession',
  'account/getState',
  'account/getBalance',
] as const;

/** 可选接口：缺失只降级对应功能，不影响主流程 */
export const OPTIONAL_ENDPOINTS = ['approval/asked', 'approval/decided', 'deliverables/presented'] as const;

/**
 * 依赖的事件类型（来自 session/follow 的流式推送）。
 *
 * 少认识一种事件不会崩溃（fold 里会忽略未知类型），
 * 但会表现为「消息不显示」—— 所以列出来用于诊断。
 */
export const KNOWN_EVENT_KINDS = [
  'turn/start',
  'turn/end',
  'step/start',
  'assistant/message',
  'user/message',
  'tool/call',
  'tool/result',
  'approval/asked',
  'approval/decided',
  'deliverables/presented',
] as const;

/** 不兼容的类型 */
export type IncompatKind =
  /** 接口不存在 —— 上游删了或改名了 */
  | 'endpoint-missing'
  /** 接口存在但返回结构变了 */
  | 'shape-changed'
  /** 鉴权/权限问题 */
  | 'auth'
  /** 网络问题 */
  | 'network'
  /** 服务端内部错误 */
  | 'server'
  /** 认不出来 */
  | 'unknown';

export interface IncompatInfo {
  kind: IncompatKind;
  endpoint?: string;
  /** 给用户看的一句话 */
  title: string;
  /** 给用户看的具体建议 */
  hint: string;
  /** 原始错误码/信息，折叠在详情里 */
  raw: string;
}

/** 上游返回的错误码里，哪些意味着「接口不存在」 */
const MISSING_PATTERNS = [/not-?found/i, /unknown\s+method/i, /no\s+such\s+(method|endpoint)/i, /unimplemented/i];

/** 哪些意味着鉴权失效（401） */
const AUTH_PATTERNS = [/unauthor/i, /\b401\b/, /invalid.*(token|cookie|session)/i];

/** 哪些意味着 403 访问地址限制（trusted-host / Origin） */
const FORBIDDEN_PATTERNS = [/forbidden/i, /\b403\b/];

/** 哪些意味着网络问题 */
const NETWORK_PATTERNS = [/network request failed/i, /failed to fetch/i, /timeout/i, /econnrefused/i, /enotfound/i, /socket/i];

/**
 * 把原始错误归类成可操作的信息。
 *
 * 用法：在 catch 里调用，把结果直接显示给用户。
 */
export function classifyError(err: unknown, endpoint?: string): IncompatInfo {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  const lower = raw.toLowerCase();
  const ep = endpoint ? `（${endpoint}）` : '';

  if (MISSING_PATTERNS.some((re) => re.test(lower))) {
    return {
      kind: 'endpoint-missing',
      endpoint,
      title: `这个版本的 DSH 不支持该功能${ep}`,
      hint:
        'DSH 可能更新过接口，或者你装的是较老的 DSH。\n' +
        '建议：① 把 DSH 更新到最新版；② 或者把 App 更新到最新版（两者要匹配）。',
      raw,
    };
  }

  if (AUTH_PATTERNS.some((re) => re.test(lower))) {
    return {
      kind: 'auth',
      endpoint,
      title: '登录状态失效了',
      hint:
        'DSH 服务可能重启过（token 每次启动都会换），或者 cookie 过期了。\n' +
        '建议：回到配对页，用新的 token 重新连一次。',
      raw,
    };
  }

  if (FORBIDDEN_PATTERNS.some((re) => re.test(lower))) {
    return {
      kind: 'auth',
      endpoint,
      title: '服务地址未被允许访问（HTTP 403）',
      hint:
        '当前登录凭据仍保留，但 DSH 拒绝了该访问地址（Host 未列入 trustedHosts）。\n' +
        '建议：检查服务地址是否为 DSH 监听的局域网 IP / 127.0.0.1，或在 DSH 配置中添加 trustedHosts。',
      raw,
    };
  }

  if (NETWORK_PATTERNS.some((re) => re.test(lower))) {
    return {
      kind: 'network',
      endpoint,
      title: '连不上电脑上的 DSH',
      hint:
        '检查：① 电脑上 DSH 还在运行吗；② 手机和电脑在同一个网络吗；\n' +
        '③ 如果换了 WiFi，电脑的局域网地址可能变了，需要重新扫码。',
      raw,
    };
  }

  if (/malformed response|undefined|unexpected token/i.test(lower)) {
    return {
      kind: 'shape-changed',
      endpoint,
      title: `DSH 返回的数据格式变了${ep}`,
      hint:
        'App 按旧协议解析不了新数据。\n' +
        '建议：把 App 更新到最新版。如果已经是最新版，说明上游改得太快，欢迎报 issue。',
      raw,
    };
  }

  if (/\b5\d\d\b|internal/i.test(lower)) {
    return {
      kind: 'server',
      endpoint,
      title: 'DSH 那边出错了',
      hint: '这是电脑端 DSH 内部的问题，不是手机 App 的。\n建议：看看电脑上的 DSH 日志，或者重启一下 DSH 服务。',
      raw,
    };
  }

  return {
    kind: 'unknown',
    endpoint,
    title: '出了点问题',
    hint: '把下面的原始信息发出来，方便定位。',
    raw,
  };
}

/**
 * 判断整体连接是否「基本可用」。
 *
 * 用于首次连接后的自检：如果连核心接口都调不通，
 * 就没必要让用户继续操作了，直接给出明确提示。
 */
export interface CompatReport {
  ok: boolean;
  /** 哪些必需接口不可用 */
  missing: string[];
  /** 一句话结论 */
  summary: string;
}

/**
 * 根据一组探测结果生成兼容性报告。
 *
 * @param results endpoint → 是否可用
 */
export function buildCompatReport(results: Record<string, boolean>): CompatReport {
  const missing = REQUIRED_ENDPOINTS.filter((ep) => results[ep] === false);
  if (missing.length === 0) {
    return { ok: true, missing: [], summary: '' };
  }
  // 只缺一两个 ：可能是那个功能被去掉了，还能用
  // 缺一大半：基本不兼容
  if (missing.length >= 4) {
    return {
      ok: false,
      missing,
      summary:
        '这个 DSH 版本和 App 差得比较多，大部分功能都会失效。\n' +
        '建议把 DSH 更新到最新版，或者装一个和它匹配的 App 版本。',
    };
  }
  return {
    ok: true,
    missing,
    summary:
      `有 ${missing.length} 个功能在你当前的 DSH 版本上不可用：${missing.join('、')}。\n` +
      '其他功能不受影响。',
  };
}
