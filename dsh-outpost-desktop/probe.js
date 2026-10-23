/**
 * 最小 Electron 探针。
 *
 * 用来确认「Electron 本身能不能在这台机器上跑起来」。
 * 它只做最小的事：写一行日志、显示一个窗口、3 秒后自动关。
 *
 * ## 怎么用
 *
 * 在 dsh-outpost-desktop 目录下：
 *
 *   set ELECTRON_RUN_AS_NODE=
 *   node_modules\electron\dist\electron.exe probe.js
 *
 * ## 看结果
 *
 *   · 弹出一个窗口 → Electron 正常，问题在程序代码
 *   · 什么都不弹，控制台报错 → Electron 环境问题
 *   · 完全不输出 → 更底层的问题
 */

const { app, BrowserWindow } = require('electron');

// 先把能写的信息都写出来 —— 如果后面崩了，至少知道到这一步是好的
console.log('[probe] electron 模块加载成功');
console.log('[probe] app 类型:', typeof app);
console.log('[probe] ELECTRON_RUN_AS_NODE:', process.env.ELECTRON_RUN_AS_NODE ?? '(未设置)');
console.log('[probe] Electron 版本:', process.versions.electron);
console.log('[probe] Node 版本:', process.versions.node);
console.log('[probe] 平台:', process.platform, process.arch);

if (!app) {
  console.error('[probe] ✗ app 是 undefined —— 说明以纯 Node 模式运行了');
  console.error('[probe]   原因：环境里有 ELECTRON_RUN_AS_NODE=1');
  process.exit(2);
}

app.whenReady().then(() => {
  console.log('[probe] app ready');

  const win = new BrowserWindow({
    width: 500,
    height: 300,
    title: 'DSH Outpost 探针',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`
        <html><body style="font-family:system-ui;padding:24px;background:#faf9f7">
          <h2 style="color:#16a34a">✓ Electron 正常运行</h2>
          <p>这个窗口能出现，说明：</p>
          <ul>
            <li>Electron 环境正常</li>
            <li>GPU/合成器能工作</li>
            <li>窗口能创建和显示</li>
          </ul>
          <p style="color:#666;font-size:13px">
            3 秒后自动关闭。如果主程序打不开，问题在程序代码而不是环境。
          </p>
        </body></html>
      `),
  );

  win.once('ready-to-show', () => {
    console.log('[probe] 窗口已显示');
    win.show();
  });

  setTimeout(() => {
    console.log('[probe] 3 秒到，退出');
    app.quit();
  }, 3000);
}).catch((e) => {
  console.error('[probe] ✗ whenReady 失败:', e);
  process.exit(3);
});

process.on('uncaughtException', (e) => {
  console.error('[probe] ✗ 未捕获异常:', e);
  process.exit(4);
});
