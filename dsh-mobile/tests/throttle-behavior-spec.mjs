/**
 * 实测节流效果。
 *
 * ## 为什么这样测
 *
 * 直接在测试里重新实现一遍节流逻辑是没有意义的（测的是复制品，
 * 不是产品代码）。所以分两步：
 *
 *   1. **静态校验**：确认 store.ts 的 emit 真的按预期结构实现
 *   2. **行为模拟**：用同样的算法跑一遍，验证「几百次 emit 合并成
 *      几十次渲染」这个数学结论成立
 *
 * 第 1 步保证「实现是对的」，第 2 步保证「这个实现确实能解决问题」。
 * 两步都过才可信 —— 只做第 2 步就变成自欺欺人了。
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

const src = readFileSync('src/core/store.ts', 'utf8');
const throttleMs = Number(
  (src.match(/const EMIT_THROTTLE_MS = (\d+)/) || [])[1] || 0,
);

// ── 第一步：确认产品代码的结构 ────────────────────────────────

const emitStart = src.indexOf('private emit(): void');
const flushStart = src.indexOf('private flushEmit(): void');

if (emitStart < 0 || flushStart < 0) {
  bad('找不到 emit/flushEmit');
} else {
  const emitBody = src.slice(emitStart, flushStart);
  const flushBody = src.slice(flushStart, flushStart + 400);

  if (/this\.emitTimer === null/.test(emitBody) && /flushEmit\(\)/.test(emitBody)) {
    ok('首次 emit 走同步 flush（交互无延迟）');
  } else {
    bad('首次 emit 没有立即 flush');
  }

  if (/setTimeout\(/.test(emitBody) && /emitPending = true/.test(emitBody)) {
    ok('窗口内标记 pending，不重复通知');
  } else {
    bad('没有 pending 机制，窗口内的更新会丢');
  }

  if (/if \(this\.emitPending\)[\s\S]{0,100}this\.emit\(\)/.test(emitBody)) {
    ok('窗口结束时尾随补发');
  } else {
    bad('没有尾随补发 —— 持续输出时会看起来卡住');
  }

  if (/for \(const fn of this\.listeners\)/.test(flushBody) && /catch/.test(flushBody)) {
    ok('flushEmit 遍历订阅者且单个失败不影响其它');
  } else {
    bad('flushEmit 结构不对');
  }
}

// ── 第二步：用同样算法验证数学结论 ────────────────────────────

/**
 * 复刻 emit 的算法（与 store.ts 的实现一一对应）。
 * 只用来验证「这个算法能把 N 次 emit 压到多少次渲染」。
 */
function makeThrottledEmitter(intervalMs) {
  let timer = null;
  let pending = false;
  let renders = 0;

  function flush() {
    renders += 1;
  }

  function emit() {
    if (timer === null) {
      flush();
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          pending = false;
          emit();
        }
      }, intervalMs);
      return;
    }
    pending = true;
  }

  return {
    emit,
    get renders() {
      return renders;
    },
    done: () => new Promise((r) => setTimeout(r, intervalMs + 60)),
  };
}

async function run(tokenCount, tokenIntervalMs) {
  const e = makeThrottledEmitter(throttleMs);
  const startedAt = Date.now();
  for (let i = 0; i < tokenCount; i += 1) {
    e.emit();
    if (tokenIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, tokenIntervalMs));
    }
  }
  const elapsed = Date.now() - startedAt;
  await e.done();
  return { renders: e.renders, elapsed };
}

if (throttleMs > 0) {
  // 场景 1：流式输出，300 个 token，每 2ms 一个
  const burst = await run(300, 2);
  const ideal = Math.ceil(burst.elapsed / throttleMs) + 1;
  console.log(
    `  300 次 emit（${burst.elapsed}ms 内）→ ${burst.renders} 次渲染（理论上限 ${ideal}）`,
  );
  if (burst.renders <= ideal + 3) {
    ok(`节流生效：渲染次数减少 ${Math.round((1 - burst.renders / 300) * 100)}%`);
  } else {
    bad(`渲染 ${burst.renders} 次，超出预期上限 ${ideal + 3}`);
  }

  // 场景 2：零散事件（间隔 > 窗口）应该每次都渲染
  const sparse = await run(5, throttleMs + 30);
  if (sparse.renders === 5) {
    ok('零散事件不被合并（每次更新都立即可见）');
  } else {
    bad(`5 次零散 emit 只渲染 ${sparse.renders} 次 —— 会漏更新`);
  }

  // 场景 3：单次 emit 同步渲染
  const e3 = makeThrottledEmitter(throttleMs);
  const t0 = Date.now();
  e3.emit();
  const syncDelay = Date.now() - t0;
  await e3.done();
  if (e3.renders >= 1 && syncDelay < 10) {
    ok(`单次 emit 同步渲染（${syncDelay}ms）`);
  } else {
    bad(`单次 emit 延迟 ${syncDelay}ms —— 点击会迟钝`);
  }

  // 场景 4：连续 emit 时最后一个不丢
  const e4 = makeThrottledEmitter(throttleMs);
  for (let i = 0; i < 20; i += 1) e4.emit();
  await e4.done();
  if (e4.renders >= 2) {
    ok('连续 emit 后尾随补发一次（最后一个更新不丢）');
  } else {
    bad(`只渲染 ${e4.renders} 次，尾随补发失效`);
  }
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
