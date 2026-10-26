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

check('call() 里用了 AbortController + signal', () => {
  const i = transportSrc.indexOf('async call<T');
  if (i < 0) return '找不到 call()';
  const body = transportSrc.slice(i, i + 3000);
  if (!body.includes('AbortController')) return '没有 AbortController';
  if (!body.includes('signal: ctrl.signal')) return '没有把 signal 传给 fetch';
  return true;
});

check('call() 在成功/失败路径都 clearTimeout', () => {
  const i = transportSrc.indexOf('async call<T');
  const body = transportSrc.slice(i, i + 3500);
  const count = (body.match(/clearTimeout\(timer\)/g) || []).length;
  return count >= 2 ? true : `只清了 ${count} 处，有路径会泄漏定时器`;
});

check('超时错误和普通网络错误分开提示', () => {
  const i = transportSrc.indexOf('async call<T');
  const body = transportSrc.slice(i, i + 3500);
  if (!/AbortError/.test(body)) return '没有识别超时';
  return /请求超时/.test(body) ? true : '超时提示不明确';
});

check('__timeoutMs 不会发给服务端', () => {
  const i = transportSrc.indexOf('async call<T');
  const body = transportSrc.slice(i, i + 2000);
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
