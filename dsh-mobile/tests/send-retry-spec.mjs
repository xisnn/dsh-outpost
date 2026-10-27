/**
 * 消息发送失败 / 重试的回归测试。
 *
 * ## 守什么
 *
 * 模拟器验收时发现：断网 → 发送失败 → 恢复网络 → 重试，
 * 聊天区会出现**两条相同内容**的用户消息。
 *
 * 根因：`store.send()` 先做**乐观插入**（本地立刻显示），
 * 但失败时只把 `running` 复位，**没有把插进去的那条删掉**。
 * 于是：
 *
 *   1. 断网发送 → 幽灵消息 stays
 *   2. 恢复重试 → 又插一条
 *   3. 两条一模一样
 *
 * 用户完全分不清哪条是真的发出去了。
 *
 * ## 这个文件怎么测
 *
 * 直接驱动真实的 `Store`，用一个可控的 api.prompt 制造成功/失败，
 * 检查 `getChat().items` 里到底有几条用户消息。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

register('./support/rn-module-hook.mjs', import.meta.url);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

const SHIM_DIR = path.join(__dirname, 'support');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(SHIM_DIR, '_async-storage-shim.cjs');
  }
  if (request === '@react-native-cookies/cookies') {
    return path.join(SHIM_DIR, '_cookie-manager-shim.cjs');
  }
  if (request === 'react-native-keychain') {
    return path.join(SHIM_DIR, '_keychain-shim.cjs');
  }
  if (request === 'react-native') {
    return path.join(SHIM_DIR, '_react-native-shim.cjs');
  }
  if (request === 'react-native-blob-util') {
    return path.join(SHIM_DIR, '_blob-util-shim.cjs');
  }
  return origResolve.call(this, request, parent, ...rest);
};

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
async function check(n, fn) {
  try {
    const r = await fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

const { DshConnection } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'transport', 'index.ts'),
);
const { Store } = await imp(path.join(__dirname, '..', 'src', 'core', 'store.ts'));

/**
 * 造一个 Store，prompt 行为可控。
 *
 * 不真的发网络请求 —— 只关心 store 内部状态怎么变。
 */
function makeStore({ promptImpl }) {
  const conn = new DshConnection({ baseUrl: 'http://127.0.0.1:1', cookie: 'dsh-auth-test=v1' });
  const store = new Store(conn);
  // 直接替换 api.prompt，绕开网络
  store.api.prompt = promptImpl;
  return store;
}

/** 取某个会话里的「用户消息」条数 */
function userMessageCount(store, sessionId) {
  const chat = store.getChat(sessionId);
  return (chat?.items ?? []).filter((it) => it && it.kind === 'user').length;
}

const SID = 'session-test-1';

// ══════════════════════════════════════════════════════════════
// 一、成功路径
// ══════════════════════════════════════════════════════════════

await check('发送成功 → 本地留 1 条用户消息', async () => {
  const store = makeStore({ promptImpl: async () => undefined });
  await store.send(SID, 'hello', [], 'queue');
  const n = userMessageCount(store, SID);
  return n === 1 ? true : `期望 1 条，实际 ${n} 条`;
});

await check('连续发送两条不同内容 → 2 条', async () => {
  const store = makeStore({ promptImpl: async () => undefined });
  await store.send(SID, 'first', [], 'queue');
  await store.send(SID, 'second', [], 'queue');
  const n = userMessageCount(store, SID);
  return n === 2 ? true : `期望 2 条，实际 ${n} 条`;
});

// ══════════════════════════════════════════════════════════════
// 二、失败路径（核心）
// ══════════════════════════════════════════════════════════════

await check('🔴 发送失败 → 不留幽灵消息', async () => {
  const store = makeStore({
    promptImpl: async () => {
      throw new Error('Network request failed');
    },
  });
  let threw = false;
  try {
    await store.send(SID, 'ghost', [], 'queue');
  } catch {
    threw = true;
  }
  if (!threw) return 'send 没有抛错';
  const n = userMessageCount(store, SID);
  return n === 0
    ? true
    : `失败后还留着 ${n} 条幽灵消息 —— 重试会产生重复`;
});

await check('🔴 失败后重试成功 → 只有 1 条（不重复）', async () => {
  // 第一次失败，第二次成功
  let call = 0;
  const store = makeStore({
    promptImpl: async () => {
      call += 1;
      if (call === 1) throw new Error('Network request failed');
      return undefined;
    },
  });
  try {
    await store.send(SID, 'retry-me', [], 'queue');
  } catch {
    /* 预期失败 */
  }
  await store.send(SID, 'retry-me', [], 'queue');
  const n = userMessageCount(store, SID);
  return n === 1
    ? true
    : `重试后变成 ${n} 条 —— 断网重试的重复消息缺陷仍在`;
});

await check('失败会复位 running（不会一直转圈）', async () => {
  const store = makeStore({
    promptImpl: async () => {
      throw new Error('boom');
    },
  });
  try {
    await store.send(SID, 'x', [], 'queue');
  } catch {
    /* 预期 */
  }
  const chat = store.getChat(SID);
  return chat?.running === false ? true : `running 仍是 ${chat?.running}`;
});

await check('失败会记录 error（界面能显示原因）', async () => {
  const store = makeStore({
    promptImpl: async () => {
      throw new Error('Network request failed');
    },
  });
  try {
    await store.send(SID, 'x', [], 'queue');
  } catch {
    /* 预期 */
  }
  const chat = store.getChat(SID);
  return chat?.error && /Network/.test(chat.error) ? true : `error=${chat?.error}`;
});

// ══════════════════════════════════════════════════════════════
// 三、不误删历史消息
// ══════════════════════════════════════════════════════════════

await check('失败只删自己那条，不误伤已有消息', async () => {
  let call = 0;
  const store = makeStore({
    promptImpl: async () => {
      call += 1;
      if (call === 2) throw new Error('boom'); // 第 2 次失败
      return undefined;
    },
  });
  // 第 1 条成功
  await store.send(SID, 'keep-me', [], 'queue');
  // 第 2 条失败
  try {
    await store.send(SID, 'drop-me', [], 'queue');
  } catch {
    /* 预期 */
  }
  const chat = store.getChat(SID);
  const items = (chat?.items ?? []).filter((it) => it && it.kind === 'user');
  if (items.length !== 1) return `期望剩 1 条，实际 ${items.length} 条`;
  return items[0].text === 'keep-me' ? true : `留下的是「${items[0].text}」`;
});

// ══════════════════════════════════════════════════════════════
// 四、静态校验：key 必须唯一
// ══════════════════════════════════════════════════════════════

const { readFileSync } = await import('node:fs');
const storeSrc = readFileSync('src/core/store.ts', 'utf8');

await check('乐观插入的 key 带随机后缀（避免同一毫秒撞车）', () => {
  const i = storeSrc.indexOf('optimisticKey = `local-');
  if (i < 0) return '找不到 optimisticKey 赋值';
  const seg = storeSrc.slice(i, i + 120);
  return /Math\.random\(\)/.test(seg)
    ? true
    : 'key 只有时间戳 —— 同一毫秒连发会撞 key，删除时可能误伤';
});

await check('失败分支按 key 过滤掉乐观插入的那条', () => {
  const i = storeSrc.indexOf('发送失败必须把 running 复位');
  if (i < 0) return '找不到失败分支';
  const seg = storeSrc.slice(i, i + 900);
  if (!/optimisticKey/.test(seg)) return '失败分支没用到 optimisticKey';
  return /filter\(\(it\) => it\.key !== optimisticKey\)/.test(seg)
    ? true
    : '没有按 key 过滤，可能没删或误删';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
