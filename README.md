# DSH Pocket

**DeepSeek Harness 的非官方 Android 客户端。**

在手机上跟你的 DSH 对话：看会话、发消息带附件、切模型和思考强度，还有「管家模式」——你只跟管家说话，它把活派给队员，主界面只留对话。

> ⚠️ 本项目是第三方客户端，**不隶属于 DeepSeek**。它连的是你自己电脑上运行的 DSH 服务，
> 不包含、也不分发 DSH 本体。

---

## 它长什么样

| 配对页 | 连接帮助 | 管家首页 |
|---|---|---|
| ![配对页](docs/screenshots/25-pair-screen.png) | ![帮助](docs/screenshots/26-pair-help.png) | ![管家](docs/screenshots/12-butler-home.png) |
| 扫码 / 粘贴 / 手填 | 三种网络方式都写清楚 | tab 变成「管家 / 我的」 |

| 模型 + 思考强度 | 扫码配对 | 启动页 |
|---|---|---|
| ![模型](docs/screenshots/27-model-effort.png) | ![扫码](docs/screenshots/23-scan-qr.png) | ![启动页](docs/screenshots/21-splash.png) |

---

## 5 分钟上手

### 1. 电脑上装 DSH

去 [DeepSeek Harness 官网](https://www.deepseek.com/harness/) 下载安装桌面端。
装好后终端里应该能用 `dsh` 命令。

### 2. 启动 Web 服务

**Windows（PowerShell）**

```powershell
cd <本仓库目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-dsh-web.ps1
```

脚本会自动挑一个手机能访问的地址（装了 Tailscale 就用 tailnet IP，否则用局域网 IP），
启动服务，并打印一条带 token 的链接和二维码。

**如果走局域网，脚本会检查 Windows 防火墙**：没放行时会打印提示和一条命令，
照着在管理员 PowerShell 里执行一次即可（或加 `-AllowFirewall` 让脚本自己加）。
不放行的话手机端会一直「连接失败」，这个坑很难自己想到。

常用参数：

```powershell
.\start-dsh-web.ps1 -Bind lan         # 强制局域网（同一 WiFi）
.\start-dsh-web.ps1 -Bind tailscale   # 强制 Tailscale（人在外面时）
.\start-dsh-web.ps1 -Host 0.0.0.0     # 自己配了 frp / 隧道时
.\start-dsh-web.ps1 -AllowFirewall    # 局域网模式下自动放行防火墙（需管理员）
.\start-dsh-web.ps1 -Port 3095 -NoQr
```

> macOS / Linux 用户：直接用 `dsh --profile web --host <你的IP> --port 3095`，
> 然后把终端打印的 URL 拿到手机上。一键脚本目前只有 Windows 版。

### 3. 手机上装 APK

从 [Releases](../../releases) 下载最新的 `app-release.apk`，允许「安装未知来源应用」后装上。

### 4. 配对

打开 App，三种方式任选：

| 方式 | 说明 |
|---|---|
| **扫码**（推荐） | 点「扫码」，对准电脑终端里的二维码 |
| **粘贴整行链接** | 复制终端打印的那一行贴到 Token 框，地址会自动识别 |
| **只粘 token** | 地址手动填 |

配对一次，**30 天内免登录**。服务重启换了 token 也不用重新配对。

---

## 网络怎么选

App 只认一个 URL，所以局域网、Tailscale、你自己的公网都能用：

| 场景 | 地址 | 前提 |
|---|---|---|
| **同一个 WiFi** | `http://192.168.x.x:3095` | 什么都不用装，最简单（**需要放行防火墙**） |
| **在外面也要用** | `http://100.x.x.x:3095` | 电脑和手机都装 [Tailscale](https://tailscale.com/download)，登录同一账号 |
| **自己的公网** | `https://你的域名` | 自己配 frp / Cloudflare Tunnel 等反向代理 |

脚本默认优先 Tailscale（有就用），没有就用局域网。用 `-Bind` 可以强制指定。

---

## 安全提醒

- **token 就是这台服务的钥匙**，拿到它就能操作你电脑上的 DSH。只发给自己的手机。
- 服务绑定 `0.0.0.0` 或局域网 IP 时，**同一 WiFi 下的其他人也可能访问到**。
  在不信任的网络里，建议用 Tailscale（端到端加密）而不是直接开局域网。
- 启动脚本的 `-PermissionMode` 默认是 `workspace-write`。
  `danger-full-access` 会关闭审批，**不建议在开放网络上使用**。
- App 走的是明文 HTTP（Tailscale 内部已是 WireGuard 加密）。
  如果你用自己的公网，请务必套一层 HTTPS。

---

## 已知限制

| 项 | 说明 |
|---|---|
| **协议无版本协商** | 用的是逆向出来的 DSH 内部 RPC（见 [docs/protocol-notes.md](docs/protocol-notes.md)）。DSH 升级后某些功能可能失效 |
| **只支持 Android** | iOS 需要 Mac + 签名，暂未提供 |
| **管家模式依赖 Agent Teams** | 需要 DSH 装了 agent-team 相关 profile |
| **无推送通知** | 需要 App 在前台才能看到新消息 |

---

## 开发

```bash
cd dsh-mobile
npm install
npm test              # fold + cwd + pairing 单测 + typecheck
npm run android       # 需要 Android SDK + JDK 21
```

- 应用代码在 [`dsh-mobile/`](dsh-mobile/)，架构与实现细节见 [dsh-mobile/README.md](dsh-mobile/README.md)
- DSH 内部协议（RPC 形状、投影字段、踩过的坑）见 [docs/protocol-notes.md](docs/protocol-notes.md)

### 目录

```
.
├── dsh-mobile/           # React Native App（TypeScript）
│   ├── src/
│   │   ├── core/         # 协议层：transport / rpc / fold / store（不依赖 UI）
│   │   ├── screens/      # 页面
│   │   ├── components/   # 组件
│   │   └── design/       # 主题 token
│   └── tests/            # Node 单测
├── docs/                 # 协议笔记、设计文档、截图
└── start-dsh-web.ps1     # Windows 一键启动脚本
```

---

## 许可

[MIT](LICENSE)

DeepSeek Harness 及其相关商标归杭州深度求索人工智能有限公司所有。
本项目与该公司无隶属关系，也未获得其背书。
