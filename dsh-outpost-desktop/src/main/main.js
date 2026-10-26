/**
 * DSH Outpost 桌面托盘助手 —— 主进程。
 *
 * ## 它解决什么问题
 *
 * 原来的「手机连接」是个 DSH 网页插件，藏在侧边栏最底下。每次要连手机
 * 都得：打开浏览器 → 找到 DSH 页面 → 展开侧边栏 → 滚到底 → 点按钮。
 * 路径太长，实际用起来很不方便。
 *
 * 这个 exe 把它独立出来：托盘常驻，点一下图标就出面板。
 *
 * ## 职责边界
 *
 * **只做连接管理**，不做聊天/会话（那是手机 App 的事）。
 * 具体是：看状态、出二维码、启停隧道、IP 变了修一下、管设备。
 *
 * ## 复用
 *
 * 状态和操作全部走 `dsh-plugin-connect/tunnel-service.mjs` 的 HTTP 接口
 * （GET /tunnel/status、POST /tunnel/start|stop|repair），
 * 不在主进程里重写一遍隧道逻辑 —— 那两个文件是同一份代码，
 * 插件和 exe 都调它，行为不会分叉。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

// ═══ 最早期自检：必须在用 app 之前 ═══════════════════════════════════
//
// ## 这个检查解决什么
//
// 如果环境里有 `ELECTRON_RUN_AS_NODE=1`，Electron 会以「纯 Node 模式」
// 启动：`require('electron')` 返回的不是 API 对象，而是 **exe 的路径字符串**。
//
// 于是下面这行会炸：
//
//     app.requestSingleInstanceLock()
//     // TypeError: Cannot read properties of undefined (reading '...')
//
// 崩溃发生在**模块加载阶段**，早于任何 app.whenReady、早于任何日志代码。
//
// 用户看到的症状：
//   · 双击 exe，一闪就没
//   · 没有窗口
//   · 没有托盘图标
//   · **崩溃日志是空的**（因为写日志的代码还没执行到）
//
// 这个变量通常来自：
//   · 某些 IDE / 终端（VS Code 的集成终端会设它）
//   · 之前跑过 `electron --version` 之类命令
//   · 其他人的脚本污染了系统环境
//
// ## 为什么要在这里硬处理
//
// 打包后的程序没有控制台，用户拿不到任何提示。与其让他对着
// 「一闪就没」猜，不如直接把问题说清楚。
if (typeof app === 'undefined' || app === null || typeof app !== 'object') {
  // 注意：此时 dialog 也不可用（同样来自 electron 模块），所以只能：
  //   1. 尽量写一份日志（用 node:fs，这个还能用）
  //   2. 用 Windows 的 msg 命令弹个提示（如果有）
  //
  // ⚠️ 写日志要**多路径兜底**：状态目录可能因为权限写不进去
  // （实测过 EPERM —— 某些环境下 %LOCALAPPDATA% 会被 ACL 限制）。
  // 之前只写一个位置，失败后被 catch 吞掉，用户什么都看不到。
  const logCandidates = [];
  try {
    const base = process.env.LOCALAPPDATA || os.homedir();
    logCandidates.push(path.join(base, 'dsh-pocket', 'logs', 'desktop-crash.log'));
  } catch {
    /* ignore */
  }
  try {
    logCandidates.push(path.join(os.tmpdir(), 'dsh-outpost-crash.log'));
  } catch {
    /* ignore */
  }
  try {
    logCandidates.push(path.join(path.dirname(process.execPath), 'dsh-outpost-crash.log'));
  } catch {
    /* ignore */
  }

  // ⚠️ 日志内容用**纯英文**。
  //
  // 原因：日志经常被用户用记事本/控制台打开，而这些地方对 UTF-8
  // 中文的显示取决于系统代码页 —— 中文 Windows 下很容易变乱码，
  // 反而让人看不懂。英文在哪都不会乱。
  const msgText =
    `\n===== ${new Date().toISOString()} [startup failed: pure Node mode] =====\n` +
    `ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE ?? '(not set)'}\n` +
    `require('electron') returned ${typeof app}, not the API object.\n` +
    `Cause: ELECTRON_RUN_AS_NODE is set, so Electron runs as plain Node.\n` +
    `Fix: remove that environment variable, then start again.\n` +
    `     Or just use START.bat in the same folder - it clears it for you.\n`;

  let logPath = '';
  for (const candidate of logCandidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.appendFileSync(candidate, msgText, 'utf8');
      logPath = candidate;
      break;
    } catch {
      // 这个位置写不了，试下一个
    }
  }

  // ═══ 自动重启：让用户什么都不用懂 ═══════════════════════════════
  //
  // 检测到「纯 Node 模式」时，与其弹窗让用户去设环境变量，
  // 不如直接**用干净环境把自己重启一次**。
  //
  // 做法：spawn 一个新的自己（删掉 ELECTRON_RUN_AS_NODE），然后退出。
  // 用户看到的效果是：双击 → 稍等一下 → 窗口出现。
  //
  // 用一个标记变量防止无限循环（万一重启后还是纯 Node 模式）。
  if (process.env.DSH_OUTPOST_RELAUNCHED !== '1') {
    try {
      const { spawn } = require('node:child_process');
      const env = { ...process.env, DSH_OUTPOST_RELAUNCHED: '1' };
      delete env.ELECTRON_RUN_AS_NODE;

      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      // 起来了就静默退出，用户不会看到任何报错
      process.exit(0);
    } catch {
      /* 重启失败，走下面的提示流程 */
    }
  }

  // 用 msg.exe 弹窗（Windows 自带，不依赖 Electron）
  //
  // 内容用英文：msg 的显示字体对中文支持不一定好，英文更保险。
  try {
    const { execFileSync } = require('node:child_process');
    const lines = [
      'DSH Outpost could not start.',
      '',
      'Cause: the environment variable ELECTRON_RUN_AS_NODE is set,',
      'which forces Electron to run as plain Node instead of a GUI app.',
      '',
      'Fixes (either one):',
      '1. Run START.bat from the same folder - it clears the variable',
      '2. Delete ELECTRON_RUN_AS_NODE from system environment variables',
    ];
    if (logPath) lines.push('', `Log: ${logPath}`);
    execFileSync('msg', ['*', '/TIME:60', lines.join('\r\n')], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
  } catch {
    /* 弹不出来也没关系，日志（如果能写）已经记录了 */
  }

  process.exit(1);
}
// ═══ 自检结束，下面可以安全使用 app ═════════════════════════════════

// ── 路径探测 ──────────────────────────────────────────────────────

/**
 * 定位 tunnel-service.mjs。
 *
 * 两种情况路径不同，必须都覆盖：
 *
 *   **打包后**：electron-builder 把 tunnel-service.mjs 拷到 resources/ 下
 *   （见 electron-builder.yml 的 extraResources），
 *   实际位置是 `process.resourcesPath/tunnel-service.mjs`。
 *
 *   **开发时**：它是仓库里 dsh-plugin-connect/tunnel-service.mjs，
 *   跟这个 exe 项目同级。
 *
 * 之前只找了仓库结构，打包后会直接找不到服务、整个面板点不动 ——
 * 所以这里先把 resourcesPath 放最前面。
 */
function findTunnelService() {
  const candidates = [
    // 打包后（extraResources 拷过来的）
    process.resourcesPath ? path.join(process.resourcesPath, 'tunnel-service.mjs') : '',
    // 开发时：从 dsh-outpost-desktop/src/main 往上找仓库根
    path.join(__dirname, '..', '..', '..', 'dsh-plugin-connect', 'tunnel-service.mjs'),
    path.join(__dirname, '..', '..', 'dsh-plugin-connect', 'tunnel-service.mjs'),
    // 环境变量兜底
    process.env.DSH_TUNNEL_SERVICE || '',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // 全都没找到：返回第一个候选，让后续报错信息能指出期望位置
  return candidates[0] || '';
}

/** 仓库根（给服务进程的 cwd 用） */
function findRepoRoot() {
  const candidates = [
    process.resourcesPath ? path.resolve(process.resourcesPath, '..') : '',
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..'),
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    process.env.DSH_POCKET_ROOT || '',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'dsh-plugin-connect', 'tunnel-service.mjs')) ||
      (process.resourcesPath &&
        fs.existsSync(path.join(process.resourcesPath, 'tunnel-service.mjs')))
    ) {
      return dir;
    }
  }
  return process.env.DSH_POCKET_ROOT || process.cwd();
}

const REPO_ROOT = findRepoRoot();
const TUNNEL_SERVICE = findTunnelService();
const STATE_DIR =
  process.env.DSH_STATE_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'dsh-pocket');
const SERVICE_PORT = Number(process.env.DSH_TUNNEL_PORT || 3199);
const SERVICE_BASE = `http://127.0.0.1:${SERVICE_PORT}`;

function writeCrashLog(kind, err) {
  try {
    const dir = path.join(STATE_DIR, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'desktop-crash.log');
    const when = new Date().toISOString();
    const detail =
      err instanceof Error ? `${err.stack ?? err.message}` : String(err);
    fs.appendFileSync(
      file,
      `\n===== ${when} [${kind}] =====\n${detail}\n`,
      'utf8',
    );
    return file;
  } catch {
    return null;
  }
}

// ── 单实例 ────────────────────────────────────────────────────────
//
// 托盘程序重复启动会出两个图标。第二个实例应该唤起第一个，而不是
// 自己再开一份。
//
// ⚠️ 这里踩过一个坑：如果直接
//
//     if (!gotLock) { app.quit(); return; }
//
// 而恰好有一个**残留进程**（上次崩溃没退干净、或托盘退出失败）还持有锁，
// 那用户双击 exe 的效果就是「窗口一闪就没了，托盘也没有」——
// 因为新进程立刻退出，而老进程可能是个没有界面的僵尸。
//
// 所以现在：
//   1. 拿不到锁 → 通知老实例显示窗口（second-instance 事件）
//   2. 同时**记一条日志**，方便排查「为什么启动后什么都没出现」
//   3. 不直接 quit —— 让 Electron 自己处理完再退出
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  writeCrashLog(
    'single-instance',
    '已有实例在运行，本进程将退出。' +
      '如果看不到窗口或托盘，说明那个实例可能卡住了 —— ' +
      '请在任务管理器里结束所有 "DSH Outpost" 进程后重试。',
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    // 第二次启动：把已有实例的窗口叫出来
    showWindow();
  });
}

// ── 窗口 ──────────────────────────────────────────────────────────

let win = null;
let tray = null;
/** 用户点了「关闭」是隐藏到托盘，不是退出 */
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#faf9f7',
    title: 'DSH Outpost',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 页面加载失败也要能看到 —— 白屏比报错更让人困惑。
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    writeCrashLog('did-fail-load', `${code} ${desc}\nurl=${url}`);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    writeCrashLog('render-process-gone', JSON.stringify(details));
  });

  // 点关闭 → 隐藏到托盘
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('blur', () => {
    // 失焦自动隐藏，像系统托盘菜单一样（可用设置关掉）
    if (!quitting && autoHideOnBlur) win.hide();
  });

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function showWindow() {
  if (!win) return;
  // 跟着托盘图标弹出（右下角）
  const trayBounds = tray?.getBounds?.();
  if (trayBounds && trayBounds.width) {
    const { screen } = require('electron');
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const [w, h] = win.getSize();
    const x = Math.round(trayBounds.x + trayBounds.width / 2 - w / 2);
    // 任务栏在下面时向上弹，在上面时向下弹
    const y =
      trayBounds.y > display.workArea.y + display.workArea.height / 2
        ? Math.round(trayBounds.y - h - 8)
        : Math.round(trayBounds.y + trayBounds.height + 8);
    win.setPosition(
      Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - w)),
      Math.max(display.workArea.y, y),
    );
  }
  win.show();
  win.focus();
}

// ── 托盘 ──────────────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // 图标缺失时用一个 16x16 的临时画面，别让托盘炸掉
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip('DSH Outpost');

  const menu = Menu.buildFromTemplate([
    { label: '打开面板', click: showWindow },
    { type: 'separator' },
    {
      label: '复制手机连接链接',
      click: async () => {
        const st = await getStatus();
        if (st?.pairUrl) {
          require('electron').clipboard.writeText(st.pairUrl);
          notify('已复制', '把链接发给手机，或直接用面板里的二维码');
        } else {
          notify('还没配对信息', '先确保 DSH 服务已启动');
        }
      },
    },
    {
      label: '启动隧道',
      click: async () => {
        await tunnelAction('start');
        notify('隧道启动中', '大约需要 60-90 秒，启动后二维码会刷新');
      },
    },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: isAutoLaunchEnabled(), click: (item) => setAutoLaunch(item.checked) },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);

  // 左键点托盘 → 显示面板
  tray.on('click', () => {
    if (win?.isVisible()) win.hide();
    else showWindow();
  });
}

// ── 开机自启 ──────────────────────────────────────────────────────

const AUTO_LAUNCH_KEY = 'DSHPocketDesktop';

function isAutoLaunchEnabled() {
  try {
    const s = app.getLoginItemSettings();
    return Boolean(s.openAtLogin);
  } catch {
    return false;
  }
}

function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true, // 开机只进托盘，不弹窗打扰
      name: AUTO_LAUNCH_KEY,
    });
    return true;
  } catch {
    return false;
  }
}

// ── 隧道服务 ──────────────────────────────────────────────────────

let serviceProc = null;

/**
 * 确保 tunnel-service 在跑。
 *
 * 它是独立进程（node），插件和这个 exe 共用同一份。
 * 已经有人在跑（端口被占）就直接复用，不重复启动。
 */
async function ensureService() {
  if (await pingService()) return true;

  if (!fs.existsSync(TUNNEL_SERVICE)) {
    return false;
  }

  const nodeExe = process.env.DSH_NODE || 'node';
  serviceProc = spawn(nodeExe, [TUNNEL_SERVICE], {
    cwd: REPO_ROOT,
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  serviceProc.on('exit', () => {
    serviceProc = null;
  });

  // 最多等 5 秒
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    if (await pingService()) return true;
  }
  return false;
}

async function pingService() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${SERVICE_BASE}/tunnel/status`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function getStatus() {
  const ok = await ensureService();
  if (!ok) {
    return { serviceDown: true, error: '隧道服务没能启动' };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${SERVICE_BASE}/tunnel/status`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { serviceDown: true, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { ...json, serviceDown: false };
  } catch (e) {
    return { serviceDown: true, error: e instanceof Error ? e.message : String(e) };
  }
}

async function tunnelAction(action) {
  const ok = await ensureService();
  if (!ok) return { ok: false, error: '隧道服务没能启动' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), action === 'start' ? 120000 : 15000);
    const res = await fetch(`${SERVICE_BASE}/tunnel/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, ...json };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── 配对信息 ──────────────────────────────────────────────────────

function readPairing() {
  try {
    const p = path.join(STATE_DIR, 'pairing.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readTunnel() {
  try {
    const p = path.join(STATE_DIR, 'tunnel.json');
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 网络接口里的局域网地址（优先 WLAN） */
function primaryLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: a.address });
    }
  }
  const wifi = candidates.find((c) => /wi-?fi|wlan|无线/i.test(c.name));
  return (wifi || candidates[0])?.address || '';
}

// ── IPC ───────────────────────────────────────────────────────────

const { ipcMain, clipboard } = require('electron');

ipcMain.handle('status:get', async () => {
  const [status, pairing, tunnelInfo] = [await getStatus(), readPairing(), readTunnel()];
  const lanIp = primaryLanIp();
  const port = pairing?.port || 3095;
  const token = pairing?.token || '';

  // 自己探一次端口 —— 不依赖隧道服务的判断。
  //
  // 隧道服务那边原来用 PowerShell 查端口，慢且会超时，导致
  // 「DSH 明明在跑」被报成「服务未启动」。这里用 net 直接探，
  // 毫秒级且可信。两个结果都带上，renderer 优先用自己的这个。
  const portListening = await probePort(port);

  return {
    ...status,
    pairing,
    tunnelInfo,
    lanIp,
    /** 我们自己探测的结果（比隧道服务的更可靠） */
    portListening,
    /** DSH 是否在跑：优先用本进程的探测 */
    dshRunning: portListening || status?.dshRunning === true,
    // 现算的局域网二维码内容（pairing.json 里的可能是旧 IP）
    lanUrl: token && lanIp ? `http://${lanIp}:${port}/?token=${token}` : pairing?.url || '',
    pairUrl: token && lanIp ? `http://${lanIp}:${port}/?token=${token}` : pairing?.url || '',
    autoLaunch: isAutoLaunchEnabled(),
  };
});

ipcMain.handle('tunnel:action', async (_e, action) => {
  if (!['start', 'stop', 'repair'].includes(action)) return { ok: false, error: 'bad action' };
  return tunnelAction(action);
});

// ── DSH 服务本身的启停 ────────────────────────────────────────────
//
// 为什么桌面助手要管这个：用户打开面板最常见的情形就是「手机连不上」，
// 而相当一部分是 DSH 服务压根没开。让人再去开一个终端跑脚本太绕了。
//
// 复用仓库里现成的 start-dsh-web.ps1 —— 那里面已经处理了：
//   · 端口占用
//   · token 生成与日志位置
//   · 绑定地址选择
//   · 前台/后台模式
// 不在主进程里重写一遍，行为才不会分叉。

/** 定位启动脚本 */
function findStartScript() {
  const candidates = [
    // 打包后 extraResources 拷过来的
    process.resourcesPath ? path.join(process.resourcesPath, 'start-dsh-web.ps1') : '',
    // 开发时：仓库根
    path.join(REPO_ROOT, 'start-dsh-web.ps1'),
    path.join(__dirname, '..', '..', '..', 'start-dsh-web.ps1'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/** 探测 DSH 端口是否在监听（毫秒级，不用 PowerShell） */
function probePort(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = new (require('node:net').Socket)();
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

ipcMain.handle('dsh:action', async (_e, action) => {
  if (!['start', 'stop'].includes(action)) return { ok: false, error: 'bad action' };

  const pairing = readPairing();
  const port = pairing?.port || 3095;

  // 已在跑就不再启动，避免端口冲突
  if (action === 'start') {
    if (await probePort(port)) {
      return { ok: true, already: true, message: 'DSH 已经在运行了' };
    }
  }

  if (action === 'stop') {
    // 停止只能杀进程 —— 我们没有 DSH 的优雅关闭通道。
    // 只杀监听那个端口的进程，按 PID 精确处理，不按名字批量杀。
    try {
      const { execFile } = require('node:child_process');
      const pids = await new Promise((resolve) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`,
          ],
          { timeout: 15000, windowsHide: true },
          (err, stdout) => resolve(err ? [] : String(stdout).trim().split(/\s+/).filter(Boolean)),
        );
      });
      if (pids.length === 0) return { ok: true, already: true, message: 'DSH 本来就没在跑' };
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          try {
            const { execFileSync } = require('node:child_process');
            execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          } catch {
            /* 杀不掉就算了，下面会如实返回 */
          }
        }
      }
      // 等端口释放（最多 5 秒）
      for (let i = 0; i < 25; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        if (!(await probePort(port))) {
          return { ok: true, message: `已停止（PID ${pids.join(', ')}）` };
        }
      }
      return { ok: false, error: `端口 ${port} 仍被占用，可能需要在任务管理器里手动结束` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 启动：跑 start-dsh-web.ps1
  const script = findStartScript();
  if (!script) {
    return {
      ok: false,
      error: '找不到 start-dsh-web.ps1。请确认它和 exe 在同一目录，或仓库根目录存在。',
    };
  }

  try {
    const { spawn } = require('node:child_process');
    // 用 PowerShell 起脚本。stdio ignore：脚本自己会写日志，
    // 而且它会 fork 出 dsh 进程（不能等它退出）。
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(port)],
      {
        cwd: path.dirname(script),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();

    // 等端口起来（最多 90 秒 —— DSH 启动确实要一会儿）
    for (let i = 0; i < 90; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await probePort(port)) {
        return { ok: true, message: `DSH 已启动（端口 ${port}）` };
      }
    }
    return {
      ok: false,
      error: `等了 90 秒还没起来。看看日志：%TEMP%\\dsh-web-${port}.log`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('devices:list', async () => {
  const pairing = readPairing();
  if (!pairing?.host) return { ok: false, devices: [] };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`http://${pairing.host}:${pairing.port}/mgw/devices`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { ok: false, devices: [], error: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, devices: json?.payload?.devices ?? json?.devices ?? [] };
  } catch (e) {
    return { ok: false, devices: [], error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle('qr:make', async (_e, text) => {
  try {
    const QRCode = require('qrcode');
    const value = String(text ?? '');
    if (!value) return null;
    // margin 1 + 纠错 M：平衡识别率和模块数，扫得快也不会太大
    return await QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#1a1a1a', light: '#ffffff' },
    });
  } catch {
    return null;
  }
});

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('autolaunch:set', (_e, enabled) => setAutoLaunch(Boolean(enabled)));

ipcMain.handle('autohide:set', (_e, enabled) => {
  autoHideOnBlur = Boolean(enabled);
  return true;
});

ipcMain.handle('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

ipcMain.handle('window:hide', () => {
  win?.hide();
  return true;
});

ipcMain.handle('app:quit', () => {
  quitting = true;
  app.quit();
  return true;
});

/** 失焦自动隐藏（默认开） */
let autoHideOnBlur = true;

function notify(title, body) {
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* 通知失败不影响主流程 */
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────


/** 全局兜底：任何未捕获异常都记下来，并尽量弹个对话框 */
process.on('uncaughtException', (err) => {
  const file = writeCrashLog('uncaughtException', err);
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'DSH Outpost 出错了',
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        (file ? `详细信息已写入：\n${file}` : ''),
    );
  } catch {
    /* 对话框都弹不出来就算了 */
  }
});

process.on('unhandledRejection', (reason) => {
  writeCrashLog('unhandledRejection', reason);
});

app.whenReady().then(async () => {
  // 每一步单独 try：托盘失败不该导致窗口也不显示，反之亦然。
  // 之前的写法是整段一个 promise，任何一步抛错就全部跳过 ——
  // 表现出来就是「什么都没出现」。
  try {
    createWindow();
  } catch (e) {
    writeCrashLog('createWindow', e);
  }

  try {
    createTray();
  } catch (e) {
    writeCrashLog('createTray', e);
    // 托盘建不起来时，至少把窗口显示出来，别让用户什么都看不到
    try {
      win?.show();
    } catch {
      /* ignore */
    }
  }

  // 如果连托盘都没建成，又没有窗口可看，就真的什么都没了 ——
  // 这种情况下弹个错误框，告诉用户去哪看日志。
  if (!tray && !win) {
    try {
      const { dialog } = require('electron');
      dialog.showErrorBox(
        'DSH Outpost 启动失败',
        `无法创建窗口和托盘。\n\n日志：${path.join(STATE_DIR, 'logs', 'desktop-crash.log')}`,
      );
    } catch {
      /* ignore */
    }
  }

  // ⚠️ 用户双击 exe 后必须看到东西，否则会以为「一闪就没了」。
  //
  // 之前 createWindow 用的是 show:false，又只在托盘点击时才 show，
  // 于是双击 exe 的效果是：**什么都不出现**（托盘图标还容易被折叠）。
  //
  // 现在：启动就显示面板。用户点关闭/失焦才收进托盘。
  try {
    win?.show();
  } catch (e) {
    writeCrashLog('show-on-start', e);
  }

  // 后台把服务拉起来，用户打开面板时就是热的状态
  void ensureService();
}).catch((e) => {
  // whenReady 本身失败（极罕见，但要有兜底）
  const file = writeCrashLog('whenReady', e);
  try {
    const { dialog } = require('electron');
    dialog.showErrorBox('DSH Outpost 启动失败', `${e?.message ?? e}\n\n${file ?? ''}`);
  } catch {
    /* ignore */
  }
});

// 全部窗口关闭也不退出（托盘程序）
app.on('window-all-closed', () => {
  /* 什么都不做，靠托盘「退出」 */
});

app.on('before-quit', () => {
  quitting = true;
  // 顺手把我们自己拉起来的服务关掉（复用别人起的不动）
  if (serviceProc) {
    try {
      serviceProc.kill();
    } catch {
      /* ignore */
    }
  }
});
