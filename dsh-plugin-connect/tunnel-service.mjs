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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
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

const TUNNEL_SCRIPT = path.join(REPO_ROOT, 'start-tunnel.ps1');
const DSH_SCRIPT = path.join(REPO_ROOT, 'start-dsh-web.ps1');
const TUNNEL_STATE = path.join(STATE_DIR, 'tunnel.json');
const PAIRING_FILE = path.join(STATE_DIR, 'pairing.json');

/** DSH Web 的端口 */
const DSH_PORT = Number(process.env.DSH_WEB_PORT || 3095);

/** 只允许这些来源访问（本机页面） */
const ALLOWED_ORIGIN =
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|172\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/;

/** 虚拟网卡，检测 IP 时要跳过 */
const VIRTUAL_NIC =
  /vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Mihomo|Clash|TUN|TAP|Tailscale|ZeroTier|WSL|Bluetooth|蓝牙|Npcap/i;

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGIN.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
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

/** DSH 当前绑在哪个地址上（查询端口监听） */
async function dshListenIp() {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-NetTCPConnection -LocalPort ${DSH_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalAddress`,
      ],
      { timeout: 8000, windowsHide: true },
    );
    const ip = stdout.trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : '';
  } catch {
    return '';
  }
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
    lanUrl: pair?.url || (dshIp ? `http://${dshIp}:${DSH_PORT}` : ''),
    token: pair?.token || '',
  };

  if (!tun || !tun.url) return { ...base, running: false };

  return {
    ...base,
    running: true,
    url: tun.url,
    domain: tun.domain,
    pairUrl: tun.pairUrl || tun.url,
    token: tun.token || pair?.token || '',
    startedAt: tun.startedAt,
    // 隧道指向的地址和当前 IP 不一致，说明隧道也失效了
    tunnelStale: Boolean(currentIp && tun.target && !tun.target.includes(currentIp)),
  };
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
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // 浏览器请求必须是本机页面；非浏览器（无 Origin）放行
  if (origin && !ALLOWED_ORIGIN.test(origin)) {
    res.writeHead(403, headers);
    res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
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
