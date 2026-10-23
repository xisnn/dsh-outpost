/**
 * 运行环境兼容性测试。
 *
 * ## 为什么需要这个文件
 *
 * CI 用 Node 20，本地开发用 Node 24。这两者有几个致命差异，
 * 已经踩过一次：
 *
 *   **Node 20 没有全局 `WebSocket`**（21+ 才有）
 *   → 集成测试本地全过，推到 CI 后 5 项 WS 测试全红，
 *     报 `WebSocket is not defined`
 *
 * 这类「本地跑得过、CI 挂掉」的问题最难排查，因为开发者看不出来。
 *
 * ## 这个文件守什么
 *
 * 1. **不依赖 Node 21+ 才有的全局 API**
 *    （或者确保有兼容层兜底）
 * 2. **兼容层本身能用**（在删掉全局 WebSocket 的情况下）
 * 3. **ws 库的参数处理正确**（第二参数是 options 时不能当 protocols）
 *
 * ## 怎么模拟 Node 20
 *
 * 删掉 `globalThis.WebSocket` 就够了 —— 那是 20 和 21 之间
 * 对测试影响最大的差异。其他差异（如 `structuredClone`）本测试不涉及。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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

// ── 1. 扫一遍测试文件，找出依赖 Node 21+ 全局 API 的用法 ──────

/** 列出所有测试文件（含 support/） */
function listTestFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(mjs|cjs|js)$/.test(name)) out.push(full);
    }
  };
  walk('tests');
  return out;
}

const testFiles = listTestFiles();

await check('用 WS 的测试都装了兼容层', () => {
  const offenders = [];
  for (const f of testFiles) {
    const src = readFileSync(f, 'utf8');
    // 用了 new WebSocket( 但没 import 兼容层
    const usesWs = /new WebSocket\(/.test(src);
    const hasCompat =
      src.includes('ws-compat') || src.includes('ws-with-headers') || src.includes("from 'ws'");
    if (usesWs && !hasCompat) {
      offenders.push(path.relative('tests', f));
    }
  }
  if (offenders.length === 0) return true;
  return (
    `这些文件用了 new WebSocket 但没有兼容层（Node 20 会崩）：` + offenders.join('、')
  );
});

await check('没有裸用 Node 21+ 才有的全局 API', () => {
  // 这几个是 Node 21+ 或更新的全局，在 Node 20 上 undefined
  const risky = [
    { name: 'WebSocket', re: /(?<![\w.])new WebSocket\(/ },
    { name: 'structuredClone', re: /(?<![\w.])structuredClone\(/ },
  ];
  const offenders = [];
  for (const f of testFiles) {
    const src = readFileSync(f, 'utf8');
    // 跳过兼容层自己
    if (f.includes('ws-compat') || f.includes('ws-with-headers')) continue;
    for (const r of risky) {
      if (r.re.test(src) && !src.includes('ws-compat')) {
        offenders.push(`${path.relative('tests', f)} 用了 ${r.name}`);
      }
    }
  }
  return offenders.length === 0 ? true : offenders.join('；');
});

// ── 2. 兼容层本身在「没有全局 WebSocket」时能用 ──────────────

await check('删掉全局 WebSocket 后，兼容层能装上', async () => {
  const original = globalThis.WebSocket;
  try {
    delete globalThis.WebSocket;
    if (typeof globalThis.WebSocket !== 'undefined') {
      return '删不掉 globalThis.WebSocket（环境异常）';
    }

    const mod = await import('./support/ws-compat.mjs');
    const kind = mod.ensureWebSocket();
    if (typeof globalThis.WebSocket !== 'function') {
      return '装了兼容层但 globalThis.WebSocket 还是不是函数';
    }
    return kind === 'ws-shim' ? true : `返回值不对：${kind}`;
  } finally {
    globalThis.WebSocket = original;
  }
});

await check('兼容层：第二参数是 options 时不报 subprotocol 错', async () => {
  const mod = await import('./support/ws-compat.mjs');
  // 这正是踩过的坑：new WebSocket(url, { headers }) —— 第二参数是 options
  // ws 库会把它当 protocols 数组 → "An invalid or duplicated subprotocol"
  let threw = null;
  try {
    const ws = new mod.CompatWebSocket('ws://127.0.0.1:1/test', { headers: { 'X-T': '1' } });
    ws.close();
  } catch (e) {
    threw = e?.message ?? String(e);
  }
  if (threw && /subprotocol/i.test(threw)) {
    return '第二参数被当成 protocols 了（这是以前的 bug）';
  }
  return true;
});

await check('兼容层：标准写法（protocols + options）也能用', async () => {
  const mod = await import('./support/ws-compat.mjs');
  let threw = null;
  try {
    const ws = new mod.CompatWebSocket(
      'ws://127.0.0.1:1/test',
      ['proto-a'],
      { headers: { 'X-T': '1' } },
    );
    ws.close();
  } catch (e) {
    threw = e?.message ?? String(e);
  }
  if (threw && /subprotocol|invalid/i.test(threw)) return `标准写法报错了：${threw}`;
  return true;
});

await check('兼容层：只传 url 也能用', async () => {
  const mod = await import('./support/ws-compat.mjs');
  let threw = null;
  try {
    const ws = new mod.CompatWebSocket('ws://127.0.0.1:1/test');
    ws.close();
  } catch (e) {
    threw = e?.message ?? String(e);
  }
  if (threw && /subprotocol|invalid/i.test(threw)) return `只传 url 报错了：${threw}`;
  return true;
});

// ── 3. CI 配置和 engines 要一致 ──────────────────────────────

await check('package.json engines 声明了 Node >= 20', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const node = pkg.engines?.node;
  if (!node) return '没声明 engines.node，CI 用什么版本全靠猜';
  return /20|>=/.test(node) ? true : `engines.node 看起来不对：${node}`;
});

await check('CI 的 node-version 和 engines 不矛盾', () => {
  const wf = readFileSync('../.github/workflows/android.yml', 'utf8');
  const m = /node-version:\s*['"]?(\d+)/.exec(wf);
  if (!m) return 'CI 里找不到 node-version';
  const ciNode = Number(m[1]);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const engineMin = Number((/>=?\s*(\d+)/.exec(pkg.engines?.node ?? '') ?? [])[1] ?? 0);
  if (engineMin && ciNode < engineMin) {
    return `CI 用 Node ${ciNode}，但 engines 要求 >=${engineMin}`;
  }
  return true;
});

// ── 4. 启动方式必须匹配文件的 import 类型 ──────────────────────
//
// 踩过的坑：integration-product.mjs 里 `import` 了 .ts 源文件，
// 但 package.json 里写的是 `node tests/integration-product.mjs`。
//
//   Node 24 → 原生支持 .ts（类型剥离），跑得过
//   Node 20 → ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"
//
// 又是「本地过、CI 挂」。这个检查直接读 package.json 的脚本，
// 确认「import 了 .ts 的测试」必须用 tsx 启动。

await check('import .ts 的测试必须用 tsx 启动', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const scripts = pkg.scripts ?? {};
  const offenders = [];

  for (const [name, cmd] of Object.entries(scripts)) {
    if (typeof cmd !== 'string') continue;
    // 找出这条命令里通过 node 直接跑的测试文件
    for (const m of cmd.matchAll(/node\s+(?:--require\s+\S+\s+)?(tests\/[\w.-]+\.mjs)/g)) {
      const file = m[1];
      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // 这个文件有没有 import ../src/**/*.ts
      const importsTs = /from\s+['"][^'"]*\/src\/[^'"]*\.ts['"]/.test(src);
      if (importsTs) {
        offenders.push(`${name}: ${file}（用了 node，但 import 了 .ts）`);
      }
    }
  }

  return offenders.length === 0
    ? true
    : `这些脚本在 Node 20 上会挂（改用 tsx）：\n  ` + offenders.join('\n  ');
});

await check('TEST_TS_IMPORT 守卫：本文件检测逻辑本身有效', () => {
  // 自检：确认上面的正则真能识别出 import .ts 的写法
  const sample = `import x from '../src/core/transport/index.ts';`;
  const re = /from\s+['"][^'"]*\/src\/[^'"]*\.ts['"]/;
  return re.test(sample) ? true : '检测逻辑失效了（正则匹配不到 import .ts）';
});

// ── 5. 集成测试能在这个 Node 版本上真跑 ──────────────────────

await check('本进程的 Node 能跑集成测试（冒烟）', async () => {
  // 模拟集成测试的启动流程：先装兼容层，再检查关键 API
  const mod = await import('./support/ws-compat.mjs');
  mod.ensureWebSocket();

  const missing = [];
  if (typeof fetch !== 'function') missing.push('fetch');
  if (typeof globalThis.WebSocket !== 'function') missing.push('WebSocket（兼容层装失败）');
  if (typeof URL !== 'function') missing.push('URL');
  return missing.length === 0 ? true : `缺少：${missing.join('、')}`;
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
