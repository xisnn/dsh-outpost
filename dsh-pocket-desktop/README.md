# DSH Pocket 桌面助手

Windows 托盘程序，替代原来的 DSH 网页插件「手机连接」按钮。

**只做连接管理**：看状态、出二维码、启停隧道、修 IP、管设备。
不做聊天（那是手机 App 的事）。

---

## 为什么做这个

原来的「手机连接」是 DSH 网页插件，藏在侧边栏最底下。每次连手机都得：

```
打开浏览器 → 找到 DSH 页面 → 展开侧边栏 → 滚到底 → 点「📱 手机连接」
```

路径太长。这个 exe 把它独立成托盘程序：**点一下托盘图标就出面板**。

---

## 功能

| 功能 | 说明 |
|---|---|
| **托盘常驻** | 开机自启（静默，不弹窗），左键点图标切换面板 |
| **状态一览** | DSH 服务、局域网地址、隧道状态，三个绿点就是一切正常 |
| **双二维码** | 局域网 / 隧道并排，扫哪个都行，一键复制链接 |
| **隧道管理** | 启动 / 停止，不用记 PowerShell 命令 |
| **IP 变化一键修复** | 检测到 IP 变了会弹黄条，点一下自动重启 DSH + 隧道 |
| **设备管理** | 看哪些手机配对过、最后活跃时间 |
| **失焦自动隐藏** | 像系统托盘菜单一样，点别处自动收起（可关） |

---

## 验证状态

### ✅ 已验证（本机实测）

| 项 | 结果 |
|---|---|
| `npm install` | 405 个包，成功 |
| 语法检查 | 3 个 JS 文件全部通过 |
| 逻辑测试 | 30 项全过 |
| **打包** | `npm run pack` 成功，产物 260 MB |
| **包结构** | 解压后 269 MB，关键文件齐全 |
| **asar 内容** | 5 个源文件 + qrcode 依赖，288 个文件 |
| **隧道服务** | `resources/tunnel-service.mjs` 正确拷入 |
| **托盘图标** | asar 内 `assets/tray.png` 存在，路径解析正确 |
| **tunnel-service 接口** | 实测 `GET /tunnel/status` 返回 200，数据完整 |

### ⚠️ 未验证

**GUI 实际渲染** —— 当前开发会话无法启动任何 Electron 进程：

```
electron.exe --version   → 退出码 -2147483645 (0x80000003)
官方 hello world         → 同样崩溃
crashpad_client_win.cc   → not connected
```

连官方 Electron 的最基础命令都跑不起来，**确认是环境限制不是代码问题**。

需要你在有桌面的 Windows 上解压 zip、双击 `DSH Pocket.exe` 确认界面。

---

## 开发

```bash
npm install
npm start          # 开发模式
npm run dev        # 开发模式 + DevTools
npm test           # 逻辑测试（30 项）
```

> **注意**：如果终端里有 `ELECTRON_RUN_AS_NODE=1`，Electron 会以纯 Node 模式启动，
> 报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
> 先 `$env:ELECTRON_RUN_AS_NODE=$null` 再启动。

---

## 打包

```bash
npm run pack        # 推荐：出可直接分发的 zip
```

产物：`release/DSHPocket-Desktop-0.1.0-win-x64.zip`（260 MB）

解压即用，双击 `DSH Pocket.exe` 运行，不需要安装。

### 为什么不用 `npm run build:nsis`

试过了，在受限环境里必然失败，卡点依次是：

| 阶段 | 报错 |
|---|---|
| 下载 Electron | `Open ...electron\Cache\850102735.zip.part: Access is denied.` |
| 下载 winCodeSign | `mkdir ...electron-builder\Cache\winCodeSign: Access is denied.` |
| 下载 NSIS | `mkdir ...electron-builder\Cache\nsis: Access is denied.` |

根因是 `app-builder.exe` 会**分 8 段并发下载**并在 `%LOCALAPPDATA%` 下并发建目录，
这个环境不允许。

`pack.js` 绕开了全部下载：用 `electron-builder --dir`（只复制本地文件，
零网络请求）生成目录，然后自己用 Node 的 zlib 打 zip。

**想要 NSIS 安装包**：在普通 Windows 机器上跑 `npm run build:nsis` 即可。

### 关于体积

260 MB 主要是 Electron 本体（`DSH Pocket.exe` 180 MB + dll/pak 约 80 MB）。

Electron 的 exe/dll 已经高度压缩过，再压只能省 9 MB（269 → 260），
所以 `pack.js` 对二进制用 store、对 asar/js 用 deflate。

---

## 架构

```
dsh-pocket-desktop/
├── src/
│   ├── main/
│   │   ├── main.js       # 主进程：托盘、窗口、IPC、隧道服务管理
│   │   └── preload.js    # contextBridge 桥接（渲染层唯一入口）
│   └── renderer/
│       ├── index.html    # 面板结构
│       ├── app.js        # 面板逻辑（只做显示，不做系统操作）
│       └── style.css     # 样式（对齐手机 App 的暖白主题）
├── assets/tray.png       # 托盘图标
├── tests/main-logic-spec.mjs
└── electron-builder.yml
```

### 安全边界

渲染层**没有 Node 权限**：

- `nodeIntegration: false`
- `contextIsolation: true`
- 只通过 `preload.js` 暴露 8 个方法
- 所有 IPC 参数在主进程侧二次校验（隧道 action 白名单、`openExternal` 只放行 http(s)）
- HTML 有 CSP，`script-src 'self'`

### 复用而不是重写

隧道逻辑**一行没重写**，全部走 `dsh-plugin-connect/tunnel-service.mjs` 的 HTTP 接口：

```
GET  /tunnel/status
POST /tunnel/start | stop | repair
```

好处：插件和 exe 共用同一份实现，行为不会分叉。

服务已在跑时直接复用（不重复拉起）；退出时只关自己启动的那个。

---

## 测试

```bash
npx tsx tests/main-logic-spec.mjs
```

30 项，覆盖：单实例锁、关闭隐藏、托盘交互、开机自启、
安全边界（contextBridge / CSP / IPC 校验）、路径探测、BOM 处理、局域网 IP 挑选。

**不覆盖 GUI 渲染** —— 那部分需要真实桌面环境手动验证。

---

## 已知限制

| 项 | 说明 |
|---|---|
| **必须在有桌面的会话里运行** | Electron 需要 GUI。在纯 SSH / 服务会话里会崩（`crashpad_client_win: not connected`），这是 Electron 的固有限制 |
| **只支持 Windows** | 目前只打 win32 包。代码是跨平台的，以后加 macOS 配置就行 |
| **不显示会话内容** | 有意为之 —— 那是手机 App 的职责，这里只负责「连得上」 |

---

## 许可

[MIT](../LICENSE)
