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

## 开发

```bash
npm install
npm start          # 开发模式
npm run dev        # 开发模式 + DevTools
```

> **注意**：如果终端里有 `ELECTRON_RUN_AS_NODE=1`，Electron 会以纯 Node 模式启动，
> 报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
> 先 `$env:ELECTRON_RUN_AS_NODE=$null` 再启动。

---

## 打包

```bash
npm run build       # 出 NSIS 安装包 + 免安装版
npm run build:dir   # 只出目录（调试用）
```

产物在 `release/`：

| 文件 | 说明 |
|---|---|
| `DSHPocket-Desktop-0.1.0-x64.exe` | 安装包（可选安装目录） |
| `DSHPocket-Desktop-0.1.0-portable.exe` | 免安装，双击即用 |

打包时会把 `../dsh-plugin-connect/tunnel-service.mjs` 一起拷进 `resources/`，
所以装到任何一台机器上都自带隧道服务，不依赖仓库结构。

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
