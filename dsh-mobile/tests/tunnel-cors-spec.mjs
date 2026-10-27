/**
 * 隧道服务 CORS / token 暴露回归测试。
 *
 * ## 守什么
 *
 * `dsh-plugin-connect/tunnel-service.mjs` 是桌面助手和网页插件共用的
 * 本地控制服务（绑 127.0.0.1:3199）。它的 `GET /tunnel/status` 返回
 * **明文 DSH token**，而旧版的 CORS 允许列表放行整段私网
 * （`10/8`、`172.16/12`、`192.168/16`）里的**任意** origin，并把它
 * 回显到 `Access-Control-Allow-Origin`。
 *
 * 后果：同网段内任何网页（被入侵的 IoT、同事本机起在 0.0.0.0 的 dev
 * server、NAS 管理页……）都能用一条 fetch 读走 token。而且
 * `POST /tunnel/stop` 这类「简单请求」不触发预检，浏览器会直接发出去 ——
 * 那是 CSRF，只有服务端能拦。
 *
 * ## 怎么测
 *
 * 起一个**真实的服务进程**（隔离端口、隔离状态目录），然后用带不同
 * Origin 的请求打它：
 *   · DSH 自己的 origin  → 允许
 *   · 同网段其它 origin  → 403
 *   · 公网 origin        → 403
 *   · 无 Origin（本机进程）→ 允许（服务只绑回环，能连上的就是本机）
 *
 * 只绑 127.0.0.1、只用临时目录，不碰用户的状态文件。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

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
function check(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

// 这个 spec 从 dsh-mobile/ 里跑，但被测服务在仓库根的 dsh-plugin-connect/。
const repo = path.resolve(import.meta.dirname, '..', '..');
const servicePath = path.join(repo, 'dsh-plugin-connect', 'tunnel-service.mjs');

// 隔离环境：临时状态目录 + 空闲端口 + read-only 权限模式
const stateDir = mkdtempSync(path.join(tmpdir(), 'dsh-tunnel-cors-'));
const DSH_PORT = 39195;
const SVC_PORT = 39199;

// 造一个 pairing.json，让允许列表能算出「这台机器的地址」
writeFileSync(
  path.join(stateDir, 'pairing.json'),
  JSON.stringify({ url: `http://127.0.0.1:${DSH_PORT}/?token=x`, token: 'x', host: '127.0.0.1', port: DSH_PORT }),
  'utf8',
);

function waitPort(port, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

async function req(pathname, origin) {
  const headers = {};
  if (origin) headers.Origin = origin;
  const res = await fetch(`http://127.0.0.1:${SVC_PORT}${pathname}`, { headers });
  const acao = res.headers.get('access-control-allow-origin');
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return { status: res.status, acao, body };
}

const child = spawn(process.execPath, [servicePath], {
  env: {
    ...process.env,
    DSH_STATE_DIR: stateDir,
    DSH_WEB_PORT: String(DSH_PORT),
    DSH_TUNNEL_PORT: String(SVC_PORT),
    DSH_POCKET_ROOT: repo,
  },
  stdio: 'ignore',
  windowsHide: true,
});

try {
  const up = await waitPort(SVC_PORT);
  if (!up) {
    bad('隧道服务没能启动（无法继续）');
  } else {
    ok('隧道服务在隔离端口启动');

    // ── 1. 公网 origin 必须被拒 ──
    {
      const r = await req('/tunnel/status', 'https://evil.example.com');
      check(r.status === 403, '公网 origin 被 403', `实际 ${r.status}`);
      check(r.acao !== 'https://evil.example.com', '公网 origin 未被回显到 ACAO');
    }

    // ── 2. 同网段其它私网 origin 必须被拒（旧版会放行）──
    for (const o of [
      'http://192.168.1.99:8080',
      'http://10.0.0.55:3000',
      'http://172.16.5.5:8000',
    ]) {
      const r = await req('/tunnel/status', o);
      check(r.status === 403, `私网 origin ${o} 被 403（旧版会放行）`, `实际 ${r.status}`);
    }

    // ── 3. DSH 自己的 origin 允许 ──
    {
      const r = await req('/tunnel/status', `http://127.0.0.1:${DSH_PORT}`);
      check(r.status === 200, 'DSH 自身 origin（127.0.0.1:DSH_PORT）被允许', `实际 ${r.status}`);
      check(
        r.acao === `http://127.0.0.1:${DSH_PORT}`,
        'DSH 自身 origin 被正确回显（页面能读到响应）',
        `实际 ACAO=${r.acao}`,
      );
    }

    // ── 4. 无 Origin（本机进程）允许 ──
    {
      const r = await req('/tunnel/status', undefined);
      check(r.status === 200, '无 Origin 的本机进程请求被允许', `实际 ${r.status}`);
    }

    // ── 4.5 响应体里不能出现明文 token（第二轮加固）──
    //
    // 第一轮只收紧了 CORS，token 仍在响应体里 —— 同源策略成了唯一防线。
    // 第二轮直接把 token 从 /tunnel/status 移除：
    //   · 网页插件从自己页面的 ?token= 取
    //   · 桌面助手直接读 pairing.json
    {
      const r = await req('/tunnel/status', undefined);
      let body = {};
      try {
        body = JSON.parse(r.body);
      } catch {
        /* ignore */
      }
      check(!('token' in body), '/tunnel/status 不再返回 token 字段');
      check(
        !/[?&]token=(?!\*\*\*)/.test(r.body || ''),
        '响应体里没有任何未打码的 token 查询参数',
        r.body ? r.body.slice(0, 120) : '',
      );
      // 地址类字段仍然要有（面板靠它们显示 IP 变化）
      check(typeof body.lanUrl === 'string', '仍返回 lanUrl（面板功能不退化）');
      check('ipChanged' in body, '仍返回 ipChanged（诊断功能不退化）');
    }

    // ── 5. 恶意 origin 不能用简单 POST 触发动作（CSRF）──
    {
      const res = await fetch(`http://127.0.0.1:${SVC_PORT}/tunnel/stop`, {
        method: 'POST',
        headers: { Origin: 'http://192.168.1.99:8080' },
      });
      check(res.status === 403, '跨站 POST /tunnel/stop 被 403（CSRF 挡住）', `实际 ${res.status}`);
    }
  }
} finally {
  child.kill();
  // 给进程一点时间退出，再清临时目录
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
