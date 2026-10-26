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

// ── DSH 服务启停（用户要求「一键启动服务」）─────────────────────

const preload = readFileSync('src/main/preload.js', 'utf8');
const rendererApp = readFileSync('src/renderer/app.js', 'utf8');
const rendererHtml = readFileSync('src/renderer/index.html', 'utf8');
const tunnelSvc = readFileSync('../dsh-plugin-connect/tunnel-service.mjs', 'utf8');

check('主进程有 dsh:action 处理器', () =>
  MAIN.includes("ipcMain.handle('dsh:action'") ? true : '没有启动/停止 DSH 的能力',
);

check('dsh:action 校验 action 白名单', () => {
  const i = MAIN.indexOf("ipcMain.handle('dsh:action'");
  if (i < 0) return '找不到处理器';
  const body = MAIN.slice(i, i + 400);
  return /includes\(action\)/.test(body) ? true : 'action 没做白名单校验';
});

check('启动 DSH 复用仓库脚本，不重写逻辑', () =>
  MAIN.includes('start-dsh-web.ps1') ? true : '自己实现了一遍启动逻辑，行为会和脚本分叉',
);

check('启动前先探测端口，避免重复启动', () => {
  const i = MAIN.indexOf("if (action === 'start')");
  if (i < 0) return '找不到 start 分支';
  const body = MAIN.slice(i, i + 400);
  return body.includes('probePort') ? true : '不检查端口就启动，容易冲突';
});

check('停止只杀监听该端口的进程（不按名字批量杀）', () => {
  const i = MAIN.indexOf("if (action === 'stop')");
  if (i < 0) return '找不到 stop 分支';
  const body = MAIN.slice(i, i + 900);
  if (/taskkill[\s\S]{0,80}\/IM/.test(body)) return '按映像名批量杀，会误伤别的 DSH 实例';
  return body.includes('OwningProcess') ? true : '没有按 PID 精确定位';
});

check('主进程用 net 探端口（不用 PowerShell）', () => {
  if (!MAIN.includes('function probePort')) return '没有 probePort';
  // 端口探测不能用外部进程 —— 会慢且超时
  const i = MAIN.indexOf('function probePort');
  const body = MAIN.slice(i, i + 700);
  return /require\('node:net'\)|from 'node:net'/.test(body) ? true : '还在用外部进程查端口';
});

check('status:get 带上自己探测的 portListening', () => {
  const i = MAIN.indexOf("ipcMain.handle('status:get'");
  if (i < 0) return '找不到';
  const body = MAIN.slice(i, i + 900);
  return body.includes('portListening') ? true : '状态里没带实时探测结果';
});

check('preload 暴露 dsh(action)', () =>
  preload.includes('dsh:') && preload.includes("'dsh:action'")
    ? true
    : '渲染层拿不到启停能力',
);

check('界面有启动/停止按钮', () => {
  if (!rendererHtml.includes('btnStartDsh')) return '没有启动按钮';
  return rendererHtml.includes('btnStopDsh') ? true : '没有停止按钮';
});

check('按钮状态跟随服务状态（没跑时启动最显眼）', () => {
  if (!rendererApp.includes('syncServiceButtons')) return '没有状态同步';
  const i = rendererApp.indexOf('function syncServiceButtons');
  const body = rendererApp.slice(i, i + 700);
  if (!/start\.disabled\s*=\s*running/.test(body)) return '启动按钮没跟着禁用';
  return /start\.className\s*=/.test(body) ? true : '启动按钮没做视觉强调';
});

check('渲染层优先用 portListening 判断（不用隧道服务的旧值）', () => {
  const i = rendererApp.indexOf('const dshOk');
  if (i < 0) return '找不到 dshOk';
  const body = rendererApp.slice(i, i + 400);
  return body.includes('portListening') ? true : '还在依赖隧道服务的 dshRunning（会误报）';
});

// ── 隧道服务的端口检测改法 ──────────────────────────────────────

check('隧道服务用 net 探端口（不再 execFile PowerShell）', () => {
  const i = tunnelSvc.indexOf('async function dshListenIp');
  if (i < 0) return '找不到 dshListenIp';
  const body = tunnelSvc.slice(i, i + 900);
  if (/execFileAsync\(\s*'powershell\.exe'/.test(body)) {
    return '还在用 PowerShell 查端口 —— 1-3 秒且会超时，导致误报「未启动」';
  }
  return body.includes('canConnect') ? true : '没有用 TCP 探测';
});

check('隧道服务的端口探测有超时保护', () => {
  const i = tunnelSvc.indexOf('function canConnect');
  if (i < 0) return '找不到 canConnect';
  const body = tunnelSvc.slice(i, i + 800);
  return /setTimeout\(/.test(body) ? true : '没有超时，可能挂住';
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

// ── 启动健壮性（用户反馈「打开后一闪就没、托盘也没有」）──────────
//
// 这组测试守的是：程序启动失败时，用户至少能得到一条线索，
// 而不是「什么都没有」。
//
// 打包后的 Electron 没有控制台，异常信息完全看不到 —— 所以
// 任何启动路径上的失败都必须落盘。

check('有崩溃日志机制', () => {
  return MAIN.includes('writeCrashLog') ? true : '没有崩溃日志，启动失败时用户无从排查';
});

check('崩溃日志写到状态目录（不是临时目录）', () => {
  const i = MAIN.indexOf('function writeCrashLog');
  if (i < 0) return '找不到 writeCrashLog';
  const body = MAIN.slice(i, i + 600);
  if (!body.includes('STATE_DIR')) return '日志没写到状态目录，用户找不到';
  if (!body.includes('desktop-crash.log')) return '日志文件名不明确';
  return true;
});

check('捕获 uncaughtException 和 unhandledRejection', () => {
  const hasUncaught = MAIN.includes("process.on('uncaughtException'");
  const hasRejection = MAIN.includes("process.on('unhandledRejection'");
  return hasUncaught && hasRejection ? true : '没有全局异常兜底';
});

check('createWindow 和 createTray 各自 try（一个失败不拖累另一个）', () => {
  const i = MAIN.indexOf('app.whenReady()');
  if (i < 0) return '找不到 whenReady';
  const body = MAIN.slice(i, i + 2200);
  const hasWindowTry = /try\s*\{\s*createWindow\(\)/.test(body);
  const hasTrayTry = /try\s*\{\s*createTray\(\)/.test(body);
  if (!hasWindowTry) return 'createWindow 没有单独 try，抛错会跳过托盘创建';
  if (!hasTrayTry) return 'createTray 没有单独 try，抛错会让整个启动流程中断';
  return true;
});

check('启动时主动显示窗口（双击 exe 必须有反应）', () => {
  const i = MAIN.indexOf('app.whenReady()');
  const body = MAIN.slice(i, i + 2600);
  // 必须有 win.show() 或 showWindow()，否则用户双击后什么都看不到
  const showsOnStart = /win\?\.show\(\)|win\.show\(\)|showWindow\(\)/.test(body);
  return showsOnStart
    ? true
    : '启动时没显示窗口 —— 用户双击 exe 会以为「一闪就没了」';
});

check('托盘建不起来时至少显示窗口', () => {
  const i = MAIN.indexOf('app.whenReady()');
  const body = MAIN.slice(i, i + 2200);
  const trayCatch = /createTray\(\)[\s\S]{0,400}catch[\s\S]{0,300}win\?\.show\(\)/.test(body);
  return trayCatch ? true : '托盘失败时窗口也不显示，用户什么都看不到';
});

check('单实例拿不到锁时会记日志', () => {
  const i = MAIN.indexOf('const gotLock = app.requestSingleInstanceLock()');
  if (i < 0) return '找不到单实例锁';
  const body = MAIN.slice(i, i + 800);
  // 拿不到锁直接 quit 而不记日志 → 用户看到「一闪就没」却不知道为什么
  return body.includes('writeCrashLog') ? true : '拿不到锁时静默退出，无从排查';
});

check('writeCrashLog 定义在首次调用之前', () => {
  const defIdx = MAIN.indexOf('function writeCrashLog');
  const firstCallIdx = MAIN.indexOf('writeCrashLog(');
  if (defIdx < 0) return '找不到定义';
  // 第一次调用不能早于定义（否则 TDZ 报错）
  return defIdx <= firstCallIdx ? true : 'writeCrashLog 用在了定义之前（会 TDZ 报错）';
});

check('渲染进程崩溃会被记录', () => {
  const hasFailLoad = MAIN.includes('did-fail-load');
  const hasGone = MAIN.includes('render-process-gone');
  return hasFailLoad && hasGone ? true : '页面加载失败/渲染进程崩溃时没有记录，白屏无从排查';
});

check('窗口关闭是隐藏到托盘（不是退出）', () => {
  const i = MAIN.indexOf("win.on('close'");
  if (i < 0) return '找不到 close 处理';
  const body = MAIN.slice(i, i + 300);
  return /preventDefault\(\)/.test(body) && /hide\(\)/.test(body)
    ? true
    : '关闭窗口会直接退出，托盘程序不该这样';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
