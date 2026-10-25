/**
 * 设备列表「错误态 vs 空列表」的回归测试。
 *
 * ## 缺陷是什么
 *
 * `listPairedDevices()` 之前失败时返回 `[]`：
 *
 *   async function listPairedDevices(baseUrl, cookie) {
 *     try {
 *       ...
 *       if (res.status !== 200) return [];
 *       ...
 *     } catch {
 *       return [];            // ← 网络失败也返回空数组
 *     }
 *   }
 *
 * 于是设备管理页把「断网 / 401 / 服务端 500」全部显示成
 * **「还没有设备配对过」**。用户以为设备记录被清空了，
 * 实际上只是请求失败 —— 这是把「读不到」伪装成「没有」，
 * 在安全管理页面上属于误导。
 *
 * ## 现在的要求
 *
 * 五种状态必须区分：
 *
 *   loading       正在读
 *   success/empty 请求成功（有数据 / 确实没有）
 *   network       连不上
 *   unauthorized  登录态失效
 *   server        其它服务端错误
 *
 * 并且：错误**不能**清掉最后一次成功加载的数据（除非安全语义要求隐藏）。
 *
 * ## 测法
 *
 * 用一个可控的最小服务端，逐个状态验证 `listPairedDevices` 的返回类型，
 * 再验证页面的状态机（用静态断言检查关键分支都在，因为 RN 组件
 * 没法在 Node 里直接渲染 —— 项目没有 react-test-renderer 依赖）。
 */

import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { readFileSync } from 'node:fs';

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
  return origResolve.call(this, request, parent, ...rest);
};
void require;

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

/**
 * 起一个行为可编程的最小服务端。
 *
 * @param {(req, res) => boolean} handler 返回 true 表示已处理
 */
function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (handler(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        cookie: 'dsh-auth-test=v1',
        close: async () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

const { listPairedDevices, isSameDevice } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'deviceAuth.ts'),
);

// ══════════════════════════════════════════════════════════════
// 一、成功态
// ══════════════════════════════════════════════════════════════

await check('成功：有设备时 ok=true 并带上数据', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices: [{ id: 'uuid-1', name: '手机' }] }));
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (!r.ok) return `应该是 ok，实际 ${r.kind}`;
    return r.devices.length === 1 && r.devices[0].id === 'uuid-1' ? true : '数据不对';
  } finally {
    await srv.close();
  }
});

await check('成功：确实没有设备时 ok=true + 空数组（这才是真的空）', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ devices: [] }));
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (!r.ok) return `应该是 ok，实际 ${r.kind}`;
    return r.devices.length === 0 ? true : '应该是空数组';
  } finally {
    await srv.close();
  }
});

await check('成功：兼容 payload.devices 这种包一层的返回形状', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ payload: { devices: [{ id: 'uuid-p', name: '手机' }] } }));
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (!r.ok) return `应该是 ok，实际 ${r.kind}`;
    return r.devices.length === 1 ? true : '没解析出 payload.devices';
  } finally {
    await srv.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 二、错误态必须和空列表分开
// ══════════════════════════════════════════════════════════════

await check('网络不可达：ok=false + kind=network（不是空数组）', async () => {
  // 用一个关掉的端口
  const r = await listPairedDevices('http://127.0.0.1:1', 'cookie');
  if (r.ok) return '网络不通时却返回成功（会被显示成「没有设备」）';
  return r.kind === 'network' ? true : `kind 应为 network，实际 ${r.kind}`;
});

await check('401：ok=false + kind=unauthorized', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(401);
      res.end('unauthorized');
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (r.ok) return '401 却返回成功';
    return r.kind === 'unauthorized' ? true : `kind 应为 unauthorized，实际 ${r.kind}`;
  } finally {
    await srv.close();
  }
});

await check('403：ok=false + kind=unauthorized', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(403);
      res.end('forbidden');
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (r.ok) return '403 却返回成功';
    return r.kind === 'unauthorized' ? true : `kind 应为 unauthorized，实际 ${r.kind}`;
  } finally {
    await srv.close();
  }
});

await check('500：ok=false + kind=server', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(500);
      res.end('boom');
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (r.ok) return '500 却返回成功';
    return r.kind === 'server' ? true : `kind 应为 server，实际 ${r.kind}`;
  } finally {
    await srv.close();
  }
});

await check('返回体不是 JSON：ok=false + kind=server', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>proxy error page</html>');
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (r.ok) return 'HTML 响应却当成成功了';
    return r.kind === 'server' ? true : `kind 应为 server，实际 ${r.kind}`;
  } finally {
    await srv.close();
  }
});

await check('返回体缺 devices 字段：ok=false + kind=server', async () => {
  const srv = await startServer((req, res) => {
    if (req.method === 'GET' && req.url === '/mgw/devices') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    return false;
  });
  try {
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    if (r.ok) return '缺字段却当成空列表了（会显示成「没有设备」）';
    return r.kind === 'server' ? true : `kind 应为 server，实际 ${r.kind}`;
  } finally {
    await srv.close();
  }
});

await check('超时：ok=false + kind=network（不能让界面一直转圈）', async () => {
  const srv = await startServer(() => {
    // 永不响应
    return true;
  });
  try {
    const started = Date.now();
    const r = await listPairedDevices(srv.baseUrl, srv.cookie);
    const elapsed = Date.now() - started;
    if (r.ok) return '超时却返回成功';
    if (r.kind !== 'network') return `kind 应为 network，实际 ${r.kind}`;
    // 超时设的是 5 秒，给一点余量
    return elapsed < 9000 ? true : `超时保护没生效（耗时 ${elapsed}ms）`;
  } finally {
    await srv.close();
  }
});

await check('空 baseUrl：ok=false，不发请求', async () => {
  const r = await listPairedDevices('', 'cookie');
  if (r.ok) return '空地址却返回成功';
  return r.kind === 'network' ? true : `kind 应为 network，实际 ${r.kind}`;
});

// ══════════════════════════════════════════════════════════════
// 三、错误信息可读且不含敏感内容
// ══════════════════════════════════════════════════════════════

await check('错误信息可读（有中文说明，不是裸错误码）', async () => {
  const r = await listPairedDevices('http://127.0.0.1:1', 'SECRET_COOKIE_VALUE');
  if (r.ok) return '前置条件不成立';
  if (!r.message || r.message.length < 4) return '没有可读的错误说明';
  if (r.message.includes('SECRET_COOKIE_VALUE')) {
    return '错误信息里带出了 Cookie（会进日志/界面）';
  }
  return true;
});

// ══════════════════════════════════════════════════════════════
// 四、页面状态机（静态检查关键分支）
// ══════════════════════════════════════════════════════════════

const screenSrc = readFileSync('src/screens/DevicesScreen.tsx', 'utf8');

await check('页面区分 loading / ready / error 三态', () => {
  if (!/type LoadState/.test(screenSrc)) return '没有显式的状态类型';
  const need = ["'loading'", "'ready'", "'error'"];
  const missing = need.filter((k) => !screenSrc.includes(k));
  return missing.length === 0 ? true : `状态缺项：${missing.join('、')}`;
});

await check('页面把 network / unauthorized / server 分开提示', () => {
  const need = ['network', 'unauthorized', 'server'];
  const missing = need.filter((k) => !screenSrc.includes(k));
  if (missing.length > 0) return `错误分类缺项：${missing.join('、')}`;
  return /ERROR_TEXT/.test(screenSrc) ? true : '没有错误文案表';
});

await check('空列表只在请求成功时显示（不能掩盖错误）', () => {
  // 「还没有设备配对过」必须挂在 devices.length === 0 上，
  // 而 devices 只在 kind === 'ready' 或 lastGood 时才有值
  if (!/devices && devices\.length === 0/.test(screenSrc)) {
    return '空态判断不是基于「成功拿到的空数组」';
  }
  // 不能出现「error 时也渲染空态」的写法
  if (/error\s*\?\s*null\s*:\s*\([\s\S]{0,200}还没有设备配对过/.test(screenSrc)) {
    return '错误态和空态混在一起';
  }
  return true;
});

await check('网络失败时有可理解的错误提示 + 重新加载入口', () => {
  if (!/重新加载/.test(screenSrc)) return '没有重新加载按钮';
  if (!/连不上电脑/.test(screenSrc)) return '没有可理解的错误文案';
  return /onPress=\{[\s\S]{0,200}void load\(\)/.test(screenSrc) || /void load\(\)/.test(screenSrc)
    ? true
    : '重试按钮没接上 load()';
});

await check('错误不清空最后一次成功的数据', () => {
  // 必须有 lastGood 之类的保留机制
  if (!/lastGood/.test(screenSrc)) return '没有保留上次成功的数据';
  // 失败分支里不能 setDevices([]) 或 setLastGood(null)
  const errIdx = screenSrc.indexOf("kind: 'error'");
  if (errIdx < 0) return '找不到错误分支';
  const body = screenSrc.slice(errIdx, errIdx + 400);
  if (/setLastGood\(\s*null\s*\)/.test(body)) return '失败时清掉了上次成功的数据';
  if (/setLastGood\(\s*\[\s*\]\s*\)/.test(body)) return '失败时把数据换成了空数组';
  return true;
});

await check('有上次数据时错误以「条」呈现，列表仍可见', () => {
  // 错误条 + 保留列表
  return /errorBar/.test(screenSrc) && /下面是上次读到的结果/.test(screenSrc)
    ? true
    : '错误时没有「保留旧数据 + 提示」的形态';
});

await check('不使用虚假的「操作成功」提示', () => {
  // 撤销失败分支必须是「撤销失败」，不能是成功文案
  const i = screenSrc.indexOf("outcome === 'failed'");
  if (i < 0) return '没有处理撤销失败';
  const body = screenSrc.slice(i, i + 700);
  if (!/撤销失败/.test(body)) return '撤销失败时没有明确提示';
  if (/撤销成功|已撤销/.test(body.split('Alert.alert')[0] ?? '')) {
    return '失败分支里出现了成功文案';
  }
  return true;
});

await check('撤销本机时区分服务端结果与本地清理结果', () => {
  // 撤销自己之后必须调用本地清理（revokeOwnApproval），
  // 否则服务端删了记录、本地还在自动重连
  if (!/revokeOwnApproval/.test(screenSrc)) {
    return '撤销本机后没有做本地清理（会立刻自动重新配对）';
  }
  return /localOk/.test(screenSrc) ? true : '没有区分本地清理是否成功';
});

// ══════════════════════════════════════════════════════════════
// 五、isSameDevice 纯函数
// ══════════════════════════════════════════════════════════════

await check('isSameDevice：clientDeviceId 匹配算自己', () => {
  const d = { id: 'uuid-server', clientDeviceId: 'dsh-outpost-abc' };
  return isSameDevice(d, 'dsh-outpost-abc') ? true : '没认出自己（撤销时会误判为别人）';
});

await check('isSameDevice：服务端 UUID 匹配也算自己', () => {
  const d = { id: 'uuid-server', clientDeviceId: 'dsh-outpost-abc' };
  return isSameDevice(d, 'uuid-server') ? true : 'UUID 形式认不出';
});

await check('isSameDevice：不相关设备不算自己', () => {
  const d = { id: 'uuid-other', clientDeviceId: 'dsh-outpost-xyz' };
  return isSameDevice(d, 'dsh-outpost-abc') === false ? true : '把别的设备认成了自己';
});

await check('isSameDevice：没有本机 id 时不认任何设备', () => {
  const d = { id: 'uuid-a', clientDeviceId: 'dsh-outpost-a' };
  return isSameDevice(d, undefined) === false ? true : '没有本机 id 却认出了自己';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
