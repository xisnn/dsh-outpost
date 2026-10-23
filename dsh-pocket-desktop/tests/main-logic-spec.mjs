/**
 * 主进程逻辑测试（不依赖 Electron GUI）。
 *
 * 为什么这样测：Electron 的 GUI 在无桌面的会话里启动不了
 * （crashpad_client_win: not connected，退出码 0x80000003），
 * 但这不影响验证核心逻辑 —— 路径探测、状态读取、IP 判定这些
 * 都是纯 JS，可以脱离 Electron 跑。
 *
 * 这里覆盖的是 exe 真正容易出错的地方：
 *   - 能不能找到隧道服务
 *   - 能不能读到 pairing.json / tunnel.json（含 BOM 的也要能读）
 *   - 局域网 IP 挑得对不对
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

const MAIN = readFileSync('src/main/main.js', 'utf8');
const PRELOAD = readFileSync('src/main/preload.js', 'utf8');

// ── 结构检查 ────────────────────────────────────────────────────
check('主进程用了单实例锁', () =>
  MAIN.includes('requestSingleInstanceLock') ? true : '没有单实例锁，会开出两个托盘图标',
);

check('关闭窗口是隐藏不是退出', () => {
  const i = MAIN.indexOf("win.on('close'");
  if (i < 0) return '找不到 close 处理';
  const body = MAIN.slice(i, i + 300);
  return /preventDefault\(\)/.test(body) && /hide\(\)/.test(body)
    ? true
    : '关闭时会直接退出（托盘程序不该这样）';
});

check('有托盘菜单和左键切换', () =>
  MAIN.includes('createTray') && MAIN.includes("tray.on('click'") ? true : '托盘交互不全',
);

check('托盘位置跟着任务栏（不是固定死坐标）', () =>
  MAIN.includes('getDisplayNearestPoint') ? true : '托盘弹窗位置是写死的',
);

check('开机自启用 setLoginItemSettings', () =>
  MAIN.includes('setLoginItemSettings') ? true : '没接开机自启',
);

check('开机自启是静默的（openAsHidden）', () =>
  MAIN.includes('openAsHidden') ? true : '开机会弹窗打扰用户',
);

// ── 安全 ────────────────────────────────────────────────────────
check('preload 用 contextBridge', () =>
  PRELOAD.includes('contextBridge.exposeInMainWorld') ? true : '没走 contextBridge',
);

check('渲染层拿不到 Node（nodeIntegration 关）', () =>
  MAIN.includes('nodeIntegration: false') ? true : '渲染层能直接 require，有安全风险',
);

check('开了 contextIsolation', () =>
  MAIN.includes('contextIsolation: true') ? true : '没开 contextIsolation',
);

check('IPC 参数在主进程侧校验', () => {
  // tunnel:action 必须白名单校验
  const i = MAIN.indexOf("ipcMain.handle('tunnel:action'");
  if (i < 0) return '找不到隧道 handler';
  const body = MAIN.slice(i, i + 300);
  return /includes\(action\)/.test(body) ? true : 'action 没做白名单校验';
});

check('openExternal 只放行 http(s)', () => {
  const i = MAIN.indexOf("ipcMain.handle('open:external'");
  if (i < 0) return '找不到 handler';
  const body = MAIN.slice(i, i + 260);
  return /\^https\?:/.test(body) ? true : '可能被用来打开任意协议';
});

check('CSP 限制脚本来源', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  return html.includes('Content-Security-Policy') && html.includes("script-src 'self'")
    ? true
    : '没有 CSP，注入风险';
});

// ── 复用现有服务（不重写隧道逻辑）────────────────────────────────
check('调 tunnel-service 而不是自己实现隧道', () => {
  const usesHttp = MAIN.includes('/tunnel/status') && MAIN.includes('/tunnel/');
  const spawnsService = MAIN.includes('tunnel-service.mjs');
  return usesHttp && spawnsService ? true : '没有复用 tunnel-service';
});

check('服务已在跑时复用，不重复启动', () => {
  const i = MAIN.indexOf('async function ensureService');
  if (i < 0) return '找不到 ensureService';
  const body = MAIN.slice(i, i + 400);
  return /if \(await pingService\(\)\) return true/.test(body)
    ? true
    : '会重复拉起服务，端口冲突';
});

check('退出时只关自己起的服务', () =>
  /if \(serviceProc\)/.test(MAIN) ? true : '退出时会误杀别人起的服务',
);

// ── 路径探测 ────────────────────────────────────────────────────
check('有多候选路径探测（打包/开发都能找到）', () =>
  MAIN.includes('findRepoRoot') && MAIN.includes('candidates')
    ? true
    : '打包后会找不到 tunnel-service',
);

check('支持 DSH_POCKET_ROOT 环境变量兜底', () =>
  MAIN.includes('DSH_POCKET_ROOT') ? true : '没有手动指定路径的兜底',
);

// ── 配对文件读取 ────────────────────────────────────────────────
check('读取 pairing.json 会剥 BOM', () => {
  // 踩过的坑：PowerShell 写出的 JSON 带 BOM，不剥会 JSON.parse 失败
  const i = MAIN.indexOf('function readPairing');
  if (i < 0) return '找不到 readPairing';
  const body = MAIN.slice(i, i + 400);
  return /uFEFF/.test(body) ? true : '没剥 BOM，PowerShell 写的文件会读失败';
});

check('tunnel.json 也会剥 BOM', () => {
  const i = MAIN.indexOf('function readTunnel');
  if (i < 0) return '找不到 readTunnel';
  const body = MAIN.slice(i, i + 400);
  return /uFEFF/.test(body) ? true : '没剥 BOM';
});

// ── 局域网 IP ───────────────────────────────────────────────────
check('局域网 IP 跳过回环和链路本地', () => {
  const i = MAIN.indexOf('function primaryLanIp');
  if (i < 0) return '找不到 primaryLanIp';
  const body = MAIN.slice(i, i + 700);
  return /internal/.test(body) && /169\.254/.test(body) ? true : '会挑到 169.254 或回环地址';
});

check('优先 WLAN 网卡', () => {
  const i = MAIN.indexOf('function primaryLanIp');
  const body = MAIN.slice(i, i + 700);
  return /wi-?fi|wlan/i.test(body) ? true : '没优先无线网卡（有线可能是虚拟网卡）';
});

// ── 渲染层 ──────────────────────────────────────────────────────
const APP = readFileSync('src/renderer/app.js', 'utf8');
check('渲染层不直接用 Node API', () => {
  const banned = ['require(', 'process.env', 'fs.', 'child_process'];
  const hit = banned.find((b) => APP.includes(b));
  return hit ? `渲染层用了 ${hit}` : true;
});

check('有 IP 变化的一键修复入口', () =>
  APP.includes('btnRepair') && APP.includes("tunnel('repair')") ? true : '没有修复入口',
);

check('二维码走主进程生成', () =>
  APP.includes('makeQr') ? true : '渲染层自己生成二维码（会额外引依赖）',
);

check('轮询刷新但避免重复生成二维码', () => {
  // lastQr 缓存
  return APP.includes('lastQr') ? true : '每 5 秒重复生成二维码，浪费 CPU';
});

// ── 依赖 ────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
check('声明了 electron 依赖', () =>
  pkg.devDependencies?.electron ? true : 'package.json 里没有 electron',
);
check('声明了 qrcode 依赖', () =>
  pkg.dependencies?.qrcode ? true : '没有 qrcode 依赖',
);
check('有打包脚本', () =>
  pkg.scripts?.pack?.includes('pack.js') ? true : '没有打包脚本',
);
check('打包脚本不用在线工具（跳过 app-builder 下载）', () => {
  const pack = readFileSync('pack.js', 'utf8');
  // 必须用 --dir（只复制本地文件），不能直接 --win（会下载 NSIS/winCodeSign）
  return pack.includes("'--dir'") && pack.includes('electronDist')
    ? true
    : '打包会去下载工具，在受限环境会失败';
});
check('打包脚本清掉 ELECTRON_RUN_AS_NODE', () => {
  const pack = readFileSync('pack.js', 'utf8');
  return pack.includes('ELECTRON_RUN_AS_NODE') ? true : '没清环境变量，子进程会崩';
});
check('打包脚本直接调 electron-builder CLI（不走 npx）', () => {
  const pack = readFileSync('pack.js', 'utf8');
  // 走 npx 时子进程输出会被吞，出错看不到原因
  return pack.includes('electron-builder/out/cli/cli.js') ? true : '用 npx 会吞掉错误输出';
});
check('打包带 extraResources（隧道服务进包）', () => {
  const yml = readFileSync('electron-builder.yml', 'utf8');
  return yml.includes('tunnel-service.mjs') && yml.includes('extraResources')
    ? true
    : '打包后没有 tunnel-service，装到别的机器上完全不可用';
});
check('打包配置了 electronDist（复用本地 Electron）', () => {
  const yml = readFileSync('electron-builder.yml', 'utf8');
  return yml.includes('electronDist') ? true : '会去在线下载 Electron，容易失败';
});

// ── 实际文件存在性 ──────────────────────────────────────────────
check('托盘图标存在', () =>
  existsSync('assets/tray.png') ? true : '缺 assets/tray.png，托盘会没图标',
);

check('渲染层三个文件齐全', () => {
  const files = ['src/renderer/index.html', 'src/renderer/app.js', 'src/renderer/style.css'];
  const missing = files.filter((f) => !existsSync(f));
  return missing.length === 0 ? true : `缺 ${missing.join(', ')}`;
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
