/**
 * 超时与渲染节流的回归测试。
 *
 * ## 守什么
 *
 * 用户反馈：连接状态一直卡在「检测中…」、回消息很慢。
 *
 * 查下来是两个独立缺陷：
 *
 * 1. **HTTP RPC 完全没有超时**
 *    网络半死不活时（信号弱、切网、服务端卡住），fetch 会永久挂起 ——
 *    不报错、不返回、不重试。于是「检测中…」永远不结束。
 *
 * 2. **emit() 没有节流**
 *    流式输出时每个 token 都触发一次全量重渲染。一次快速回复能推
 *    几百次，手机上直接卡住。用户感觉「回消息慢」，其实模型早答完了，
 *    是界面渲染跟不上。
 */

import { readFileSync } from 'node:fs';

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

const transportSrc = readFileSync('src/core/transport/index.ts', 'utf8');
const storeSrc = readFileSync('src/core/store.ts', 'utf8');

// ══════════════════════════════════════════════════════════════
// 一、RPC 超时
// ══════════════════════════════════════════════════════════════

check('定义了 RPC 超时常量', () =>
  /const RPC_TIMEOUT_MS = \d/.test(transportSrc) ? true : '没有 RPC 超时常量',
);

check('探测类接口有更短的超时（不拖住界面）', () => {
  if (!/PROBE_TIMEOUT_MS/.test(transportSrc)) return '没有 PROBE_TIMEOUT_MS';
  const m = transportSrc.match(/PROBE_TIMEOUT_MS = ([\d_]+)/);
  if (!m) return '找不到定义';
  const probe = Number(m[1].replace(/_/g, ''));
  return probe > 0 && probe < 30000
    ? true
    : `探测超时 ${probe}ms 不够短（应该 < 30s）`;
});

/**
 * 取 call() 的完整函数体。
 *
 * 原先用 slice(i, i + 3000/3500) 这种固定窗口，函数一变长就会**静默截断**，
 * 于是断言检查看似通过、其实根本没看到后半段代码。改为切到下一个方法
 * （request()）为止，与函数长度无关。
 */
function callBody() {
  const i = transportSrc.indexOf('async call<T');
  if (i < 0) return null;
  const j = transportSrc.indexOf('async request<', i);
  return j > i ? transportSrc.slice(i, j) : transportSrc.slice(i);
}

check('call() 里用了 AbortController + signal', () => {
  const body = callBody();
  if (!body) return '找不到 call()';
  if (!body.includes('AbortController')) return '没有 AbortController';
  if (!body.includes('signal: ctrl.signal')) return '没有把 signal 传给 fetch';
  return true;
});

// 这条原先是「clearTimeout(timer) 出现次数 >= 2」。
//
// 那是把实现细节当契约：分散在成功/失败两处清理只是**当时**的写法，
// 而正确的修复恰恰是收敛成单一 finally（与 request() 对齐），次数会变成 1，
// 于是旧断言会反过来阻碍修复。真正要守的性质是：
//   1. 每条退出路径都清了定时器 → 用 finally 保证，且只此一处
//   2. 清理发生在**响应体读完之后** → 否则 res.json() 卡死时无人 abort
//
// ⚠️ 定位必须锚定到**真实语句**，不能用裸 indexOf：call() 的注释里也
// 出现了 `await res.json()`，裸 indexOf 会命中注释，导致检查范围退回
// 整个函数体、把 fetch 阶段的 AbortError 误当成响应体阶段的判别。
function callCodePositions(body) {
  const json = body.match(/^\s*parsed = \(await res\.json\(\)\)/m);
  const fin = body.match(/^\s*\} finally \{/m);
  const clear = body.match(/^\s*clearTimeout\(timer\);/m);
  return {
    jsonAt: json ? json.index : -1,
    finallyAt: fin ? fin.index : -1,
    clearAt: clear ? clear.index : -1,
  };
}

check('call() 用单一 finally 清定时器，且覆盖到响应体读完', () => {
  const body = callBody();
  if (!body) return '找不到 call()';
  const count = (body.match(/clearTimeout\(timer\)/g) || []).length;
  if (count !== 1) return `clearTimeout(timer) 出现 ${count} 处，应收敛为单一 finally`;
  const { jsonAt, finallyAt, clearAt } = callCodePositions(body);
  if (finallyAt < 0) return '没有 finally —— 无法保证每条退出路径都清定时器';
  if (clearAt < 0) return '找不到 clearTimeout(timer) 语句';
  if (clearAt < finallyAt) return 'clearTimeout 不在 finally 内';
  if (jsonAt < 0) return '找不到响应体读取语句 parsed = (await res.json())';
  if (jsonAt > clearAt) {
    return '定时器在读取响应体之前就被清掉了 —— body 卡死时会永久挂起（BUG-02）';
  }
  return true;
});

check('超时错误和普通网络错误分开提示', () => {
  const body = callBody();
  if (!body) return '找不到 call()';
  if (!/AbortError/.test(body)) return '没有识别超时';
  return /请求超时/.test(body) ? true : '超时提示不明确';
});

// 响应体阶段的 abort 也必须说「超时」。
// call() 的 catch 会把解析失败一律降级成 malformed，如果不判别 abort，
// 超时就会被说成「上游改了返回格式」，两者的可操作建议完全不同。
check('call() 响应体阶段判别 abort，不把超时误报成 malformed', () => {
  const body = callBody();
  if (!body) return '找不到 call()';
  const { jsonAt } = callCodePositions(body);
  if (jsonAt < 0) return '找不到响应体读取语句';
  // 只看真实语句之后的代码，且去掉注释行，避免注释里的词造成假通过
  const after = body
    .slice(jsonAt)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  if (!/ctrl\.signal\.aborted/.test(after) && !/AbortError/.test(after)) {
    return '响应体的 catch 没有判别 abort —— 超时会落到 malformed 分支';
  }
  return true;
});

check('__timeoutMs 不会发给服务端', () => {
  const body = callBody();
  if (!body) return '找不到 call()';
  // 必须把内部参数摘掉，用 realArgs 发请求
  if (!/__timeoutMs/.test(body)) return '没有 __timeoutMs 支持';
  return /\.\.\.realArgs|args: realArgs/.test(body)
    ? true
    : '内部参数会被发给服务端（有些接口会因此报错）';
});

check('ping() 用短超时，不会卡在「检测中」', () => {
  const i = storeSrc.indexOf('async ping()');
  if (i < 0) return '找不到 ping()';
  const body = storeSrc.slice(i, i + 900);
  if (!/withTimeout/.test(body)) {
    return 'ping 没有超时保护 —— 网络卡住时「检测中…」永远不结束';
  }
  return /PROBE_TIMEOUT_MS/.test(body) ? true : '没有用探测专用超时';
});

// ══════════════════════════════════════════════════════════════
// 二、emit 节流
// ══════════════════════════════════════════════════════════════

check('定义了节流窗口常量', () =>
  /const EMIT_THROTTLE_MS = \d/.test(storeSrc) ? true : '没有节流常量',
);

check('emit() 实现了节流（不是每次都全量通知）', () => {
  const i = storeSrc.indexOf('private emit(): void');
  if (i < 0) return '找不到 emit()';
  const body = storeSrc.slice(i, i + 1600);
  if (!/emitTimer/.test(body)) return 'emit 里没有定时器，说明没节流';
  if (!/emitPending/.test(body)) return '没有 pending 标记（窗口内的更新会丢）';
  return true;
});

check('节流是「尾随」的：窗口结束会补发一次', () => {
  const i = storeSrc.indexOf('private emit(): void');
  const body = storeSrc.slice(i, i + 1600);
  // 必须有「窗口结束时如果还有 pending 就再 emit」的逻辑
  return /if \(this\.emitPending\)[\s\S]{0,80}this\.emit\(\)/.test(body)
    ? true
    : '只在窗口结束时丢弃更新 —— 持续输出时会看起来卡住';
});

check('第一次调用立即通知（交互不能有延迟）', () => {
  const i = storeSrc.indexOf('private emit(): void');
  const body = storeSrc.slice(i, i + 1600);
  // 首次进入时必须立刻 flush，不能等 60ms
  return /if \(this\.emitTimer === null\)[\s\S]{0,120}flushEmit\(\)/.test(body)
    ? true
    : '首次也延迟了，点击/输入会感觉迟钝';
});

check('flushEmit 保证单个订阅者失败不影响其它', () => {
  const i = storeSrc.indexOf('private flushEmit(): void');
  if (i < 0) return '找不到 flushEmit';
  const body = storeSrc.slice(i, i + 500);
  return /try\s*\{[\s\S]{0,80}\}\s*catch/.test(body) ? true : '一个订阅者抛错会打断其它订阅者';
});

check('节流窗口足够短（60ms 量级，肉眼无感）', () => {
  const m = storeSrc.match(/EMIT_THROTTLE_MS = (\d+)/);
  if (!m) return '找不到常量';
  const ms = Number(m[1]);
  if (ms > 200) return `${ms}ms 太长了，流式输出会明显卡顿`;
  if (ms < 16) return `${ms}ms 太短，起不到节流作用`;
  return true;
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
