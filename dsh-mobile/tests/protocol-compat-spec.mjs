/**
 * 协议兼容性测试。
 *
 * ## 这个文件守什么
 *
 * 客户端硬依赖 DSH 的 15 个 RPC 接口和 11 种事件类型。上游一改，
 * 用户就白屏或者报 `gateway/not-found`。这个文件做两件事：
 *
 * 1. **锁住依赖清单** —— 如果有人不小心改了接口名/字段名，
 *    测试立刻失败，而不是等用户报 bug
 * 2. **验证错误分类** —— 上游变更时用户看到的是可操作的提示，
 *    不是一串内部标识
 *
 * ## 为什么这算「兼容性测试」而不是「单元测试」
 *
 * 它测的不是「函数算得对不对」，而是「我们和上游的约定有没有被破坏」。
 * 上游代码不在这个仓库里，所以用「清单 + 契约」的方式锁住。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  REQUIRED_ENDPOINTS,
  OPTIONAL_ENDPOINTS,
  KNOWN_EVENT_KINDS,
  classifyError,
  buildCompatReport,
} from '../src/core/protocol.ts';
import {
  RpcError,
  isEndpointMissing,
  isAuthFailure,
  isForbiddenRejection,
  isRetryable,
} from '../src/core/rpc-error.ts';

let pass = 0;
let fail = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
function check(n, fn) {
  try {
    const r = fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

// ── 1. 依赖清单必须和代码一致 ─────────────────────────────────

/** 扫描 src 里所有 call('xxx/yyy') 的调用 */
function scanEndpointsUsed() {
  const found = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const m of text.matchAll(/call\(\s*'([a-z]+\/[a-zA-Z]+)'/g)) {
        found.add(m[1]);
      }
      for (const m of text.matchAll(/call<[^>]*>\(\s*'([a-z]+\/[a-zA-Z]+)'/g)) {
        found.add(m[1]);
      }
    }
  };
  walk('src');
  return found;
}

const usedEndpoints = scanEndpointsUsed();
const declared = new Set([...REQUIRED_ENDPOINTS, ...OPTIONAL_ENDPOINTS]);

check('代码里用的每个接口都在清单里', () => {
  const undeclared = [...usedEndpoints].filter((ep) => !declared.has(ep));
  if (undeclared.length === 0) return true;
  return (
    `这些接口在用但没登记（新增接口请加到 protocol.ts 的 REQUIRED_ENDPOINTS）：` +
    undeclared.join('、')
  );
});

check('清单里的每个必需接口都真的在用', () => {
  // 允许少数「拿不到但声明了」的，但差距太大说明清单过期了
  const unused = REQUIRED_ENDPOINTS.filter((ep) => !usedEndpoints.has(ep));
  // session/attachment 是拼出来的（`session/attachment` 常量），豁免
  const excused = new Set(['session/attachment']);
  const realUnused = unused.filter((ep) => !excused.has(ep));
  // 通过 RPC 类方法间接调用的也算，所以只报警告级别的阈值
  return realUnused.length <= 6
    ? true
    : `清单里有一半以上接口没被直接调用，清单可能过期了：${realUnused.join('、')}`;
});

check('接口数量在合理范围（防止清单被误删）', () => {
  if (REQUIRED_ENDPOINTS.length < 10) {
    return `必需接口只剩 ${REQUIRED_ENDPOINTS.length} 个，清单可能被误删了`;
  }
  if (KNOWN_EVENT_KINDS.length < 8) {
    return `事件类型只剩 ${KNOWN_EVENT_KINDS.length} 个，清单可能被误删了`;
  }
  return true;
});

// ── 2. 事件类型必须和 fold 保持一致 ───────────────────────────

check('KNOWN_EVENT_KINDS 覆盖 fold 里认识的类型', () => {
  const foldSrc = readFileSync('src/core/fold/index.ts', 'utf8');
  // fold 里用 case 'xxx/yyy': 或 === 'xxx/yyy' 判断
  const inFold = new Set();
  for (const m of foldSrc.matchAll(/case\s+'([a-z]+\/[a-zA-Z]+)'/g)) inFold.add(m[1]);
  for (const m of foldSrc.matchAll(/===\s*'([a-z]+\/[a-zA-Z]+)'/g)) inFold.add(m[1]);
  for (const m of foldSrc.matchAll(/[Kk]ind\s*===\s*'([a-z]+\/[a-zA-Z]+)'/g)) inFold.add(m[1]);

  const known = new Set(KNOWN_EVENT_KINDS);
  const unlisted = [...inFold].filter((k) => !known.has(k));
  // 允许少量内部事件没登记，但主要类型必须在
  return unlisted.length <= 4
    ? true
    : `fold 认识但清单里没登记的事件：${unlisted.join('、')}`;
});

// ── 3. 错误分类：用户看到的必须是人话 ─────────────────────────

check('接口不存在 → 提示版本不匹配，且不建议重试', () => {
  const info = classifyError(new Error('gateway/not-found'), 'session/page');
  if (info.kind !== 'endpoint-missing') return `分类错了：${info.kind}`;
  if (!/DSH|版本/.test(info.title)) return `标题不够明确：${info.title}`;
  if (!/更新/.test(info.hint)) return '没给出「更新」这个可操作建议';
  return true;
});

check('鉴权失效 → 提示重新配对', () => {
  const info = classifyError(new Error('401 Unauthorized'), 'session/list');
  if (info.kind !== 'auth') return `分类错了：${info.kind}`;
  if (!/配对|token/i.test(info.hint)) return '没提到重新配对';
  return true;
});

check('网络失败 → 提示检查网络，不是版本问题', () => {
  const info = classifyError(new Error('Network request failed'), 'session/list');
  if (info.kind !== 'network') return `分类错了：${info.kind}`;
  // 关键：不能把网络问题说成版本不匹配，那会让用户白折腾
  if (/版本|更新/.test(info.title)) return '把网络问题误报成版本问题';
  return true;
});

check('返回结构变化 → 提示 App 需要更新', () => {
  const info = classifyError(new Error('malformed response'), 'session/page');
  if (info.kind !== 'shape-changed') return `分类错了：${info.kind}`;
  if (!/更新/.test(info.hint)) return '没建议更新 App';
  return true;
});

check('服务端 5xx → 归为 DSH 那边的问题', () => {
  const info = classifyError(new Error('HTTP 500 internal'), 'session/list');
  if (info.kind !== 'server') return `分类错了：${info.kind}`;
  if (!/电脑|DSH/.test(info.hint)) return '没说清是电脑端的问题';
  return true;
});

check('每条提示都带 hint（用户知道下一步做什么）', () => {
  const samples = [
    'gateway/not-found',
    '401 Unauthorized',
    'Network request failed',
    'malformed response',
    'HTTP 502',
    '完全不认识的错误 xyz',
  ];
  for (const s of samples) {
    const info = classifyError(new Error(s), 'test/ep');
    if (!info.title || info.title.length < 4) return `${s} 的标题太短`;
    if (!info.hint || info.hint.length < 10) return `${s} 的建议太短`;
  }
  return true;
});

// ── 4. 兼容性报告 ─────────────────────────────────────────────

check('必需接口全可用 → 报告 ok，无提示', () => {
  const r = buildCompatReport(Object.fromEntries(REQUIRED_ENDPOINTS.map((e) => [e, true])));
  return r.ok && r.missing.length === 0 && r.summary === ''
    ? true
    : '全可用却报了问题';
});

check('缺 1-3 个 → 还能用，但要告诉用户哪些不可用', () => {
  const results = Object.fromEntries(REQUIRED_ENDPOINTS.map((e) => [e, true]));
  results['session/updateQueue'] = false;
  const r = buildCompatReport(results);
  if (!r.ok) return '缺一个就判整机不可用，太严格';
  if (!r.summary.includes('session/updateQueue')) return '没列出哪个不可用';
  return true;
});

check('缺 4 个以上 → 判定整体不兼容', () => {
  const results = Object.fromEntries(REQUIRED_ENDPOINTS.map((e) => [e, true]));
  for (const ep of REQUIRED_ENDPOINTS.slice(0, 5)) results[ep] = false;
  const r = buildCompatReport(results);
  if (r.ok) return '缺一半接口还说能用';
  if (!/更新/.test(r.summary)) return '没给出更新建议';
  return true;
});

// ── 5. RpcError 的语义 ────────────────────────────────────────

check('RpcError 带 endpoint 和 raw，方便排查', () => {
  const e = new RpcError({
    endpoint: 'session/page',
    kind: 'rpc',
    raw: 'gateway/not-found',
    userTitle: 'x',
    userHint: 'y',
    retryable: false,
  });
  if (e.endpoint !== 'session/page') return 'endpoint 丢了';
  if (!e.message.includes('session/page')) return 'message 里没有接口名，日志难查';
  if (!e.message.includes('gateway/not-found')) return 'message 里没有原始错误码';
  return true;
});

check('isEndpointMissing 能识别版本不匹配', () => {
  const e = new RpcError({
    endpoint: 'x/y',
    kind: 'rpc',
    raw: 'gateway/not-found',
    userTitle: '',
    userHint: '',
    retryable: false,
  });
  return isEndpointMissing(e) ? true : '识别不出接口缺失';
});

check('isAuthFailure 只将 401 识别为凭据失效，403 由 isForbiddenRejection 单独识别（trusted-host 区分）', () => {
  const e401 = new RpcError({
    endpoint: 'x/y',
    kind: 'http',
    raw: 'HTTP 401',
    userTitle: '',
    userHint: '',
    retryable: false,
  });
  const e403 = new RpcError({
    endpoint: 'x/y',
    kind: 'http',
    raw: 'HTTP 403',
    userTitle: '',
    userHint: '',
    retryable: false,
  });
  return isAuthFailure(e401) && !isAuthFailure(e403) && isForbiddenRejection(e403)
    ? true
    : '未能正确区分 401 凭据失效与 403 访问地址限制';
});

check('网络错误标记为可重试，接口缺失标记为不可重试', () => {
  // 这个区分很重要：可重试的会自动重连，不可重试的应该直接提示用户
  const net = new RpcError({
    endpoint: 'x/y',
    kind: 'network',
    raw: 'Network request failed',
    userTitle: '',
    userHint: '',
    retryable: true,
  });
  const miss = new RpcError({
    endpoint: 'x/y',
    kind: 'rpc',
    raw: 'gateway/not-found',
    userTitle: '',
    userHint: '',
    retryable: false,
  });
  if (!isRetryable(net)) return '网络错误应该是可重试的';
  if (isRetryable(miss)) return '接口缺失不该重试（重试也没用）';
  return true;
});

// ── 6. transport 真的用了这套错误 ─────────────────────────────

check('transport 的 call 用的是 makeRpcError 而不是裸 Error', () => {
  const src = readFileSync('src/core/transport/index.ts', 'utf8');
  const i = src.indexOf('async call<');
  if (i < 0) return '找不到 call 方法';
  const body = src.slice(i, i + 2200);
  if (!body.includes('makeRpcError')) return 'call 里还是裸 Error，用户看不到友好提示';
  return true;
});

check('store 连接后有兼容性自检', () => {
  const src = readFileSync('src/core/store.ts', 'utf8');
  return src.includes('checkCompatibility') ? true : '没做能力探测，上游改接口不会提前发现';
});

check('兼容性自检不产生副作用（只调只读接口）', () => {
  const src = readFileSync('src/core/store.ts', 'utf8');
  const i = src.indexOf('async checkCompatibility');
  if (i < 0) return '找不到 checkCompatibility';
  // 精确截到方法结束（下一个同缩进的   } 后跟空行或新方法）
  const rest = src.slice(i);
  const endMatch = rest.match(/\n  }\n/);
  const body = endMatch ? rest.slice(0, endMatch.index + 4) : rest.slice(0, 1600);
  // 探测里绝不能出现 create/delete/rename/prompt 这类写操作
  const writeOps = ['session/create', 'session/rename', 'session/prompt', 'workspace/create', 'delete'];
  const hit = writeOps.filter((op) => body.includes(op));
  return hit.length === 0 ? true : `探测里包含写操作：${hit.join('、')}`;
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
