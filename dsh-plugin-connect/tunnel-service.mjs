/**
 * 隧道控制小服务。
 *
 * 为什么需要它：插件跑在浏览器里，没法直接启动本地进程。
 * DSH 的自定义 Remote 要生成 codec，纯 JS 插件接不进去
 * （commands/execute 也试过，它是「模拟用户敲斜杠命令」的通道，对不上）。
 *
 * 所以退一步用最朴素的方式：一个监听本机端口的 HTTP 服务，
 * 浏览器 fetch 它，它去调各 PowerShell 脚本。
 * 这条链路没有技术不确定性，也不依赖 DSH 内部接口，升级不会坏。
 *
 * 端点：
 *   GET  /tunnel/status  → 隧道状态 + 网络健康
 *   POST /tunnel/start   → 启动隧道（约 60-90 秒）
 *   POST /tunnel/stop    → 停止隧道
 *   POST /tunnel/repair  → IP 变了之后修好（重启 DSH + 隧道）
 *
 * 安全：只监听 127.0.0.1，且校验 Origin 必须是本机页面。
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.DSH_TUNNEL_PORT || 3199);

/**
 * 路径全部可配置，不写死。
 *
 * 原则：优先用环境变量，其次从本文件位置往上找。
 * 这样别人 clone 到任何盘符都能跑 —— 之前这里写死了 E:\work\dsBot
 * 和 E:\cloudflared，换台机器就废了。
 *
 * 环境变量：
 *   DSH_POCKET_ROOT   仓库根目录（默认：本文件的上两级）
 *   DSH_STATE_DIR     状态文件目录（默认：%LOCALAPPDATA%\dsh-pocket）
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.DSH_POCKET_ROOT || path.resolve(HERE, '..');

/**
 * 找一个 PowerShell 脚本的实际路径。
 *
 * ## 为什么不能只拼 REPO_ROOT（这是 P1-11 的根因）
 *
 * 这个服务有两种运行形态，脚本落点不同：
 *
 *   · **开发/插件**：本文件在 `dsh-plugin-connect/`，脚本在仓库根
 *     → `REPO_ROOT/start-tunnel.ps1` 成立
 *   · **打包的桌面助手**：本文件被 electron-builder 拷到
 *     `resources/tunnel-service.mjs`，两个 .ps1 也在 `resources/` 下
 *     （见 electron-builder.yml 的 extraResources）。
 *     此时 `REPO_ROOT` = `resources/..` = 安装根，拼出来是
 *     `<安装根>/start-tunnel.ps1` —— **不存在**。
 *
 * 结果是打包版面板上的「启动隧道 / 停止隧道 / 一键修复」全是死按钮。
 *
 * 现在按「最可能的位置」依次探测，返回第一个存在的；都不存在时返回
 * 首选路径，让报错信息能指出期望位置。
 */
function findScript(name) {
  const candidates = [
    path.join(REPO_ROOT, name), // 开发：仓库根
    path.join(HERE, name), // 打包：与本文件同目录（resources/）
    path.resolve(HERE, '..', name),
    path.resolve(HERE, '..', '..', name),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return candidates[0];
}

/** 状态目录：存 tunnel.json / pairing.json / 日志 */
const STATE_DIR =
  process.env.DSH_STATE_DIR ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-pocket');

// 主动创建，别等第一次写文件才发现目录不存在
try {
  mkdirSync(STATE_DIR, { recursive: true });
} catch {
  /* 建不了就算了，后面写文件时会报具体错 */
}

const TUNNEL_SCRIPT = findScript('start-tunnel.ps1');
const DSH_SCRIPT = findScript('start-dsh-web.ps1');
const TUNNEL_STATE = path.join(STATE_DIR, 'tunnel.json');
const PAIRING_FILE = path.join(STATE_DIR, 'pairing.json');

/** DSH Web 的端口 */
const DSH_PORT = Number(process.env.DSH_WEB_PORT || 3095);

/**
 * 允许的来源（本机页面）。
 *
 * ## 为什么不能放行整段私网
 *
 * 旧实现把 `10/8`、`172.16/12`、`192.168/16` 里**任意** origin 都当自己人，
 * 并且把这个 origin 回显到 `Access-Control-Allow-Origin`。而这个服务的
 * `GET /tunnel/status` 会返回**明文 DSH token**（能操作整台电脑的钥匙）。
 *
 * 于是同网段内任何网页（被入侵的 IoT、同事本机起在 0.0.0.0 的 dev server、
 * NAS 管理页）都能用一条 fetch 把 token 读走 —— 这不是理论问题，是可以
 * 直接复现的。
 *
 * ## 判据
 *
 * 只认「DSH 自己的页面」：回环地址，以及 pairing.json 里记录的这台机器的
 * 局域网地址。两者都必须是 DSH 的端口。
 */
function allowedOrigins() {
  const port = DSH_PORT;
  const list = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  // pairing.json 记录的地址 = DSH 正在绑的那个地址（DSH 只接受具体 IP，不接受 0.0.0.0）
  const host = (cachedPairing && cachedPairing.host) || '';
  if (host) list.add(`http://${host}:${port}`);
  // 兜底：pairing.json 还没生成时，用当前网卡地址，否则 DSH 自己的页面会被挡掉
  const lan = primaryLanIp();
  if (lan) list.add(`http://${lan}:${port}`);
  return list;
}

/** 每 5 秒刷新一次的 pairing 缓存，避免每个请求都读磁盘 */
let cachedPairing = null;
let pairingReadAt = 0;
async function refreshPairingCache() {
  const now = Date.now();
  if (now - pairingReadAt < 5000 && pairingReadAt !== 0) return;
  pairingReadAt = now;
  cachedPairing = await readJson(PAIRING_FILE);
}

/**
 * 这个 origin 是否受信任。
 *
 * 注意：这里返回 false 的浏览器请求会在**执行任何动作之前**被 403 掉，
 * 所以它同时挡住了「跨站读取 token」和「跨站触发 start/stop/repair」
 * （后者是 CSRF：简单请求不触发预检，服务端仍会执行）。
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return allowedOrigins().has(origin);
}

/** 虚拟网卡，检测 IP 时要跳过 */
const VIRTUAL_NIC =
  /vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Mihomo|Clash|TUN|TAP|Tailscale|ZeroTier|WSL|Bluetooth|蓝牙|Npcap/i;

function corsHeaders(origin) {
  const ok = isAllowedOrigin(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

async function readJson(path) {
  try {
    let txt = await readFile(path, 'utf8');
    // PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，
    // JSON.parse 遇到 \uFEFF 直接报 "Unexpected token"。
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * 当前可用网卡的 IPv4 列表。
 *
 * 为什么不调 PowerShell：os.networkInterfaces() 是同步的、零进程开销，
 * 而这个要频繁调用（每次状态查询）。PowerShell 一次要 300-800ms，太慢。
 */
function lanCandidates() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_NIC.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      out.push({ ip: a.address, nic: name });
    }
  }
  return out;
}

/** 挑最可能给手机用的地址：优先 WLAN，其次内网段 */
function primaryLanIp() {
  const cands = lanCandidates();
  const wifi = cands.find((c) => /WLAN|Wi-?Fi|无线|Wireless/i.test(c.nic));
  if (wifi) return wifi.ip;
  const priv = cands.find(
    (c) =>
      c.ip.startsWith('192.168.') ||
      c.ip.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(c.ip),
  );
  return (priv || cands[0] || {}).ip || '';
}

/**
 * DSH 是否在监听（以及绑在哪个地址）。
 *
 * ## 为什么改了实现
 *
 * 原来用 `execFileAsync('powershell.exe', ...)` 跑 Get-NetTCPConnection。
 * 每次要启动一个 PowerShell 进程 —— 实测 1~3 秒，8 秒超时下经常超时返回空，
 * 于是桌面助手把「DSH 明明在跑」误报成「服务未启动」。
 *
 * 现在直接用 Node 的 net 模块探 TCP：毫秒级，不依赖外部进程。
 *
 * ## 怎么判断「绑在哪个地址」
 *
 * 依次尝试 0.0.0.0（绑所有网卡）、局域网 IP、127.0.0.1。
 * 第一个连得上的，就是 DSH 在监听的形态。
 */
async function dshListenIp() {
  const candidates = [
    // DSH 默认绑 0.0.0.0（所有网卡）—— 这时用局域网 IP 连它
    { host: primaryLanIp(), reported: primaryLanIp() },
    // 可能只绑了回环
    { host: '127.0.0.1', reported: '127.0.0.1' },
  ].filter((c) => c.host);

  for (const c of candidates) {
    if (await canConnect(c.host, DSH_PORT, 600)) {
      return c.reported;
    }
  }
  return '';
}

/**
 * TCP 连通性探测。
 *
 * 超时给 600ms —— 本机回环/局域网，正常都是几毫秒。
 * 超时短是为了不拖慢整体状态查询（面板每 5 秒刷一次）。
 */
function canConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * 完整状态。
 *
 * 返回里除了隧道信息，还带网络健康：
 *   currentIp   —— 现在网卡上的地址
 *   dshIp       —— DSH 实际监听地址（空 = 没在跑）
 *   ipChanged   —— 三者不一致，需要修复
 *
 * 为什么需要这个：这台机器的 WiFi 是 DHCP，IP 会漂
 * （已经出现过 172.27.56.253 → 192.168.151.223）。
 * IP 一变，DSH 就 bind 不上（EADDRNOTAVAIL），手机也连不上，
 * 而用户看到的只是「连不上」，完全不知道原因。
 */
async function getStatus() {
  const tun = await readJson(TUNNEL_STATE);
  const pair = await readJson(PAIRING_FILE);

  const currentIp = primaryLanIp();
  const dshIp = await dshListenIp();

  const recordedIp = pair?.host || '';
  const ipChanged = Boolean(
    currentIp && recordedIp && currentIp !== recordedIp,
  ) || Boolean(currentIp && dshIp && currentIp !== dshIp);

  const base = {
    currentIp,
    dshIp,
    recordedIp,
    ipChanged,
    dshRunning: Boolean(dshIp),
    dshPort: DSH_PORT,
    // ⚠️ 这里**不再返回明文 token**。
    //
    // 第一轮把 CORS 收紧到「只认 DSH 自己的 origin」，挡住了跨站读取；
    // 但 token 一旦出现在响应体里，浏览器的同源策略就是唯一防线 ——
    // 任何同源 XSS、或将来放松 CORS 的改动，都会直接泄漏这把「能操作
    // 整台电脑的钥匙」。
    //
    // 需要 token 的调用方本来就能自己拿到：
    //   · 网页插件：当前页面 URL 里就有 `?token=`（DSH 打开时就带着）
    //   · 桌面助手：直接读 pairing.json（它本来就在读）
    //
    // 所以这里只给「不含凭据」的地址，token 由调用方各自解决。
    lanUrl: dshIp ? `http://${dshIp}:${DSH_PORT}` : '',
    recordedUrl: pair?.url ? stripTokenFromUrl(pair.url) : '',
  };

  if (!tun || !tun.url) return { ...base, running: false };

  return {
    ...base,
    running: true,
    url: tun.url,
    domain: tun.domain,
    // pairUrl 同样去掉 token
    pairUrl: stripTokenFromUrl(tun.pairUrl || tun.url),
    startedAt: tun.startedAt,
    // 隧道指向的地址和当前 IP 不一致，说明隧道也失效了
    tunnelStale: Boolean(currentIp && tun.target && !tun.target.includes(currentIp)),
  };
}

/**
 * 去掉 URL 里的凭据查询参数。
 *
 * 只保留协议/主机/端口/路径。用于 `/tunnel/status` 这类可能被浏览器
 * 读到的地方 —— 地址本身（用于判断 IP 是否变了）不是秘密，token 是。
 */
export function stripTokenFromUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(String(raw));
    for (const k of [...u.searchParams.keys()]) {
      if (/^(token|key|secret|password|auth|code)$/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    // 不是合法 URL：按字符串粗剥一层，避免原样回传
    return String(raw).replace(/([?&](?:token|key|secret|password|auth|code)=)[^&\s]+/gi, '$1***');
  }
}

/** 跑 PowerShell 脚本 */
async function runScript(script, args, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    return { ok: true, stdout, stderr };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      error: e.message,
    };
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  // 先把 pairing.json 读进缓存 —— 允许的 origin 里要包含这台机器的局域网地址
  await refreshPairingCache();

  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) };

  // ── 来源判定 ────────────────────────────────────────────────────
  //
  // ⚠️ 顺序很重要：必须在**执行任何动作之前**拒绝，否则 POST /tunnel/stop
  // 这类简单请求（不触发预检）会被跨站页面直接触发 —— 那是 CSRF，
  // 浏览器拦不住，只有服务端能拦。
  //
  // 有 Origin = 浏览器发起，只认 DSH 自己的页面。
  // 无 Origin = 本机进程（curl / 插件 / 桌面助手），服务只绑 127.0.0.1，
  //            能连上它的本来就只有本机进程，放行。
  if (origin && !isAllowedOrigin(origin)) {
    res.writeHead(403, headers);
    res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

  try {
    // ── 状态 ──
    if (url.pathname === '/tunnel/status' && req.method === 'GET') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, ...(await getStatus()) }));
      return;
    }

    // ── 启动隧道 ──
    if (url.pathname === '/tunnel/start' && req.method === 'POST') {
      const cur = await getStatus();
      if (cur.running && !cur.tunnelStale) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, already: true, ...cur }));
        return;
      }
      const r = await runScript(TUNNEL_SCRIPT, [], 200000);
      const after = await getStatus();
      res.writeHead(200, headers);
      res.end(
        JSON.stringify({
          ok: r.ok && after.running,
          ...after,
          log: (r.stdout || '').slice(-1500),
          error: r.ok ? undefined : r.error || r.stderr,
        }),
      );
      return;
    }

    // ── 停止隧道 ──
    if (url.pathname === '/tunnel/stop' && req.method === 'POST') {
      const r = await runScript(TUNNEL_SCRIPT, ['-Stop'], 40000);
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: r.ok, stopped: true }));
      return;
    }

    // ── 修复（IP 变了之后）──
    //
    // 做两件事：用当前 IP 重启 DSH，如果隧道之前开着就重新拉起来。
    // 顺序必须是先 DSH 后隧道 —— 隧道要指向一个真的在监听的地址。
    if (url.pathname === '/tunnel/repair' && req.method === 'POST') {
      const before = await getStatus();
      const hadTunnel = before.running;

      // 1. 重启 DSH（脚本自己会挑当前 WLAN 地址）
      const dshRun = await runScript(DSH_SCRIPT, ['-Bind', 'lan', '-Port', String(DSH_PORT), '-NoQr'], 180000);

      // 2. 如果之前有隧道，重新拉起来
      let tunRun = { ok: true, skipped: true };
      if (hadTunnel) {
        tunRun = await runScript(TUNNEL_SCRIPT, [], 200000);
      }

      const after = await getStatus();
      res.writeHead(200, headers);
      res.end(
        JSON.stringify({
          ok: dshRun.ok && after.dshRunning,
          hadTunnel,
          ...after,
          log: (dshRun.stdout || '').slice(-1200),
          error: dshRun.ok ? undefined : dshRun.error || dshRun.stderr,
        }),
      );
      return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    res.writeHead(500, headers);
    res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dsh-tunnel] listening on 127.0.0.1:${PORT}`);
  console.log(`[dsh-tunnel] lan ip: ${primaryLanIp() || '(none)'}`);
  console.log(
    '[dsh-tunnel] endpoints: GET /tunnel/status, POST /tunnel/start|stop|repair',
  );
});
