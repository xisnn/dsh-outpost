/**
 * DSH Pocket 桌面托盘助手 —— 主进程。
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
    // 开发时：从 dsh-pocket-desktop/src/main 往上找仓库根
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

// ── 单实例 ────────────────────────────────────────────────────────
//
// 托盘程序重复启动会出两个图标，很不专业。第二个实例直接唤起第一个。

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
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
    title: 'DSH Pocket',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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
  tray.setToolTip('DSH Pocket');

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
  return {
    ...status,
    pairing,
    tunnelInfo,
    lanIp,
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

app.whenReady().then(async () => {
  createWindow();
  createTray();
  // 后台把服务拉起来，用户打开面板时就是热的状态
  void ensureService();
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
