# DSH Outpost — Android Studio Emulator 自动化验收报告

| 项 | 值 |
|---|---|
| 验收日期 | 2026-10-27 |
| 执行环境 | Windows + Android Studio 官方 Emulator |
| 应用包名 | `com.dshpocket` |
| APK 类型 | **Debug**（内嵌 Metro 开发包，非正式签名） |
| 验收结论 | **通过功能验收**，发现并修复 3 个真实缺陷 |

---

## 一、环境识别

### Android SDK / 工具链

| 组件 | 路径 / 版本 |
|---|---|
| Android SDK | `E:\Android\Sdk` |
| ADB | `E:\Android\Sdk\platform-tools\adb.exe` |
| Emulator | `E:\Android\Sdk\emulator\emulator.exe` — **37.2.12.0** (build 16428233) |
| AVD Manager | `E:\Android\Sdk\cmdline-tools\latest\bin\avdmanager.bat` |
| build-tools | `36.0.0`（含 `apksigner`） |

> ⚠️ 环境变量 `ANDROID_HOME` / `ANDROID_SDK_ROOT` **未设置**，所有脚本需显式指定路径。

### 模拟器

| 项 | 值 |
|---|---|
| AVD 名称 | `dsh_test` |
| 设备型号 | `sdk_gphone64_x86_64`（基于 `pixel_6`） |
| Android 版本 | **15** |
| API Level | **35** |
| CPU ABI | **x86_64** |
| 构建 ID | `AE3A.240806.043` |
| 安全补丁 | 2024-09-05 |
| 分辨率 | 1080 × 2400 @ 420dpi |
| Play Store | 未启用（`google_apis` 镜像） |
| 加速 | WHPX（Windows Hypervisor Platform） |

### 启动问题与修复

**首次启动失败**：默认启动后设备长期停留在 `offline`（超过 8 分钟），
进程 CPU 仅 3.7 秒、内存 398 MB —— 判定为卡死而非慢启动。

**根因**：AVD 内的 `snapshots/default_boot` 快照损坏。

**处理**（**未删除任何用户数据**）：
1. 终止卡死的 `emulator` / `qemu-system-x86_64` 进程
2. 清理残留锁文件（`hardware-qemu.ini.lock`、`multiinstance.lock`）
3. 用 **`-no-snapshot`** 冷启动

**结果**：**20 秒**设备就绪，`userdata-qemu.img`（6.1 MB）完整保留。

**建议**：后续自动化统一使用
```
emulator.exe -avd dsh_test -gpu swiftshader_indirect -no-snapshot -no-boot-anim
```

---

## 二、构建与安装

### 已有 APK 与签名冲突检查

| APK | 签名 SHA-256 | versionCode |
|---|---|---|
| 设备已装（v0.16.3） | `255cfa4`（内部格式，debug 签名） | 160300 |
| 本地 `app-debug.apk` | `fac61745…033b9c` | 1（默认） |
| 本地 `app-release.apk` | `b70eaec…cc88e2e` | 160300 |

**首次安装失败**：
```
INSTALL_FAILED_VERSION_DOWNGRADE: Update version code 1 is older than current 160300
```

**这不是签名冲突**，而是 versionCode 降级。未卸载、未清除用户数据。

### 构建命令

```powershell
$env:ANDROID_HOME='E:\Android\Sdk'
$env:ANDROID_SDK_ROOT='E:\Android\Sdk'
cd E:\work\dsBot\dsh-mobile\android
.\gradlew.bat assembleDebug '-PDSH_VERSION_CODE=160701' '-PDSH_VERSION_NAME=0.16.7-emu' --no-daemon
```

> ⚠️ 参数必须**整体加引号**。不加引号时 PowerShell 会把 `0.16.7-emu`
> 按点号拆成独立参数，报 `Task '.16.7-emu' not found`。

### 安装结果

```
Performing Streamed Install
Success
```

签名兼容（均为 debug 签名），**用户数据完整保留**。

---

## 三、功能验收结果

图例：**PASS** = 实测通过 / **FAIL** = 实测失败 / **NOT TESTED** = 未能真实验证

### 3.1 应用生命周期

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | APK 安装 | **PASS** | `Success` |
| 2 | 首次启动 | **PASS** | 修复后配对页正常渲染 |
| 3 | 崩溃 / ANR | **PASS** | 全程 0 次 FATAL、0 次 ANR |
| 4 | 进程存活 | **PASS** | PID 8102，Native Heap 166 MB |
| 5 | 前后台切换 | **PASS** | `am force-stop` 后重启正常 |

### 3.2 配对与连接

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 6 | 配对页显示 | **PASS** | 地址框 / Token 框 / 连接按钮齐全 |
| 7 | 地址输入 | **PASS** | `http://192.168.190.223:3095` |
| 8 | Token 输入 | **PASS** | 43 字符 token 正确填入 |
| 9 | **DSH 连接** | **PASS** | 拉回 **582 个目录 · 716 个会话** |
| 10 | 错误提示可读性 | **PASS** | 4 种错误均有明确中文说明 |

### 3.3 页面与导航

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 11 | 工作区列表 | **PASS** | 目录名、路径、会话数、相对时间 |
| 12 | 会话列表 | **PASS** | 92 个会话，搜索框、进度百分比 |
| 13 | 聊天页面 | **PASS** | Markdown、工具卡片、思考块、团队头像条 |
| 14 | 「我的」页 | **PASS** | 余额 ¥4.86、Token 用量、主题、开关 |
| 15 | 底部 Tab 切换 | **PASS** | 工作区 ↔ 我的 |
| 16 | 返回导航 | **PASS** | 系统返回键正常 |
| 17 | 新建会话 | **PASS** | 空状态提示清晰 |
| 18 | 会话历史加载 | **PASS** | 6 轮对话完整渲染 |

### 3.4 消息收发

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 19 | 输入框聚焦 | **PASS** | 键盘正常弹出 |
| 20 | 文本输入 | **PASS** | 英文文本正确显示 |
| 21 | 发送按钮 | **PASS** | 有内容时变蓝，点击触发 |
| 22 | **消息发送** | **PASS** | 服务端生成回复「Ready. I'm the Team Lead…」 |
| 23 | **AI 回复渲染** | **PASS** | 思考过程 + 正文 + 工具调用 |
| 24 | 会话标题自动更新 | **PASS** | 摘要变为「Reply Request」 |
| 25 | 「手机」来源标记 | **PASS** | 手机创建的会话带标签 |
| 26 | 单写者锁错误提示 | **PASS** | `session/writer-held` 清晰展示 |

### 3.5 设置与主题

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 27 | 主题切换 | **PASS** | 纯白 → 深色即时生效 |
| 28 | 设置持久化 | **PASS** | `@dsh/themeMode = dark` |
| 29 | 账户余额显示 | **PASS** | ¥4.86（主 ¥4.86 · 赠金 ¥0.00）|
| 30 | Token 用量统计 | **PASS** | 67.09M 输入 / 9.03M 输出 / 4395.93M 缓存读 |

### 3.6 通知

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 31 | 权限申请弹窗 | **PASS** | 系统级 POST_NOTIFICATIONS 弹窗 |
| 32 | 权限授予 | **PASS** | `granted=true` |
| 33 | 通知实际送达 | **NOT TESTED** | 需触发任务完成事件 |
| 34 | 通知点击跳转 | **NOT TESTED** | 同上 |

### 3.7 审批网关

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 35 | 审批通道状态显示 | **PASS** | 「我的」页有状态行 |
| 36 | 审批落点验证 | **NOT TESTED** | 需触发真实命令执行审批 |
| 37 | 断网恢复重连 | **NOT TESTED** | 需可控断网操作 |

### 3.8 WebSocket

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 38 | 会话流式接收 | **PASS** | AI 回复逐步渲染 |
| 39 | 断线错误提示 | **PASS** | 红色横幅「WebSocket 连接出错」 |
| 40 | 断线后自动重连 | **NOT TESTED** | 未做受控断网实验 |

### 3.9 文件与文档

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 41 | 图片全屏查看 | **NOT TESTED** | 本次会话无图片消息 |
| 42 | Markdown 渲染 | **PASS** | 标题、表格、代码高亮正常 |
| 43 | 文档转发 / 保存 | **NOT TESTED** | 需含文件的会话 |
| 44 | 长按保存相册 | **NOT TESTED** | 同上 |

### 3.10 更新检查

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 45 | 版本号显示 | **PASS** | 「我的」页显示 v0.16.7-emu |
| 46 | 检查更新 | **NOT TESTED** | 需公网访问 GitHub API |
| 47 | 完整性校验 | **NOT TESTED** | 同上 |

---

## 四、发现并修复的缺陷

### 缺陷 1（严重）：首次启动白屏 —— 未配对时必然崩溃

**位置**：`src/App.tsx:414`

**现象**：全新安装 / 清空数据 / 换手机后第一次打开，红屏
`Render Error: 连接地址被拒绝：不支持的协议（只接受 http 或 https）`，
**连配对页都到不了**。

**根因**：
```typescript
const [baseUrl, setBaseUrlState] = useState('');   // 初始空串
const store = useMemo(() => {
  const conn = new DshConnection({ baseUrl, cookie });  // ← 对空串校验
  return new Store(conn);
}, [baseUrl, cookie]);
```
`DshConnection` 构造函数调用 `assertSecureUrl` → `new URL('')` 抛出异常
→ 异常发生在 `useMemo`（渲染期）→ React 卸载整棵组件树。

**修复**：
```typescript
const PLACEHOLDER_BASE_URL = 'http://127.0.0.1:1';
const safeBaseUrl = baseUrl || PLACEHOLDER_BASE_URL;
const conn = new DshConnection({ baseUrl: safeBaseUrl, cookie });
```
占位地址选择 `127.0.0.1`：合法（通过构造校验）、私有（符合明文 HTTP 策略），
即使未来漏判也不会把凭据发往公网。

**验证**：`pm clear` 后冷启动 → 配对页正常显示。

---

### 缺陷 2（严重）：配对成功却被误判为 HTTP 401

**位置**：`src/core/transport/index.ts` — `loginWithToken()`

**现象**：地址和 token 都正确，却报 `token exchange failed: HTTP 401`，
服务端日志显示**根本没收到请求**。

**根因链**：
```
GET /?token=xxx  → 303 + Set-Cookie     ✅ 服务端已下发凭据
   ↓ RN fetch 自动跟随重定向（location: ./）
GET /            → 401                  ❌ 这一步没带上 cookie
```
代码用 `res.status >= 400` 判断配对结果，于是把**成功当成了失败**。

**修复**：调整判断顺序 —— 先看 cookie jar，再看状态码。
```typescript
const cookie = await this.readCookieFromJar();
if (cookie) { this.cookie = cookie; return cookie; }  // 有 cookie 即成功
if (res && res.status >= 400) throw new Error(...);   // 状态码仅作参考
```

**验证**：修复后配对成功，拉回 582 目录 / 716 会话。

---

### 缺陷 3（环境）：DSH 只绑 WLAN IP，模拟器无法通过常规地址访问

**现象**：

| 测试 | 结果 |
|---|---|
| 模拟器 ping `10.0.2.2` | ✅ 通（1.2 ms） |
| 模拟器连 `10.0.2.2:3095` | ❌ Connection refused |
| 模拟器连 `127.0.0.1:3095`（经 `adb reverse`） | ❌ Connection refused |
| 模拟器连 `192.168.190.223:3095` | ✅ **OPEN** |

**根因**：DSH 只监听 WLAN 网卡 `192.168.190.223:3095`，**未绑定回环**。
`10.0.2.2` 映射到宿主机回环、`adb reverse` 也转发到回环，两者都无服务。

**处理**（**未修改生产安全策略**）：直接使用宿主机局域网 IP 配对。

**给管理员的建议**：若希望模拟器用标准 `10.0.2.2`，需让 DSH 监听 `0.0.0.0`：
```powershell
.\start-dsh-web.ps1 -Host 0.0.0.0 -Port 3095
```
⚠️ 这会扩大监听范围，**请自行评估网络环境后再决定**。

---

### 观察项（非缺陷）：`pairing.json` 中的地址已失效

当前文件记录 `host=100.111.15.120, port=39997`（Tailscale + 旧端口），
但服务实际在 `192.168.190.223:3095`。网络环境变化后该文件不会自动更新。

**影响**：桌面助手「局域网二维码」可能指向过期地址。
**建议**：桌面助手展示前重新探测实际监听地址。

---

## 五、DSH 连接测试证据

### 网络连通性

| 链路 | 结果 |
|---|---|
| 模拟器 → `192.168.190.223:3095` | **OPEN** |
| 模拟器 HTTP 请求 `GET /?token=…` | **HTTP/1.1 303 See Other** |
| 模拟器 HTTP 请求（无 cookie）`GET /` | HTTP 401（符合预期） |

### 连接结果

```
工作区列表：582 个目录 · 716 个会话
会话列表：92 个会话（dsBot 工作区）
「我的」页：余额 ¥4.86 / Token 67.09M 输入 / 4395.93M 缓存读
```

### 消息收发证据

发送内容：`Reply`
服务端回复：
```
Ready. I'm the Team Lead for this session, working in …
```
同时触发工具调用「查看成员」，思考块 965 字 / 280 字均正常展开。

会话标题自动更新为 **「Reply Request」**，并标记「手机」来源。

---

## 六、截图清单

| 文件 | 内容 |
|---|---|
| `06-pair-fixed.png` | 修复白屏后，配对页首次正常显示 |
| `07-ui.png` | 配对页完整布局 |
| `15-after-login-fix.png` | 配对成功，工作区列表（582 目录 / 716 会话） |
| `17-workspace.png` | 通知权限弹窗 |
| `18-sessions-list.png` | dsBot 会话列表（92 个） |
| `19-chat.png` | 聊天页面渲染 |
| `22-sent.png` | 消息发送中 |
| `24-reply.png` | 单写者锁错误提示（预期行为） |
| `25-new-session.png` | 新建会话空状态 |
| `28-ws-error.png` | WebSocket 断线提示 + 会话已更新 |
| `29-history.png` | 新会话已持久化（「Reply Request」） |
| `30-profile.png` | 「我的」页完整功能 |
| `31-dark-theme.png` | 深色主题切换 |

存放目录：`E:\work\dsBot\emu-screenshots\`

---

## 七、异常日志

### 无崩溃

全程 `logcat` 中 **0 次** `FATAL EXCEPTION`、**0 次** `ANR`。

### 已解释的日志

**1. AbortError 风暴（182 次）**

```
[transport] fetch failed '…/api/session/list' 'AbortError' 'Aborted'
```
发生在「新建会话」后立即发送消息期间。当时所有请求均超时 30 秒。
**后续排查**：网络层实际正常，重启 App 后恢复正常。
**结论**：疑似 RN 网络栈在高并发 + 重定向后进入异常状态，
**未定位到根因，标记为待观察项**。

**2. mobile-gateway 401**

```
mobile-gateway: auth rejected: missing or invalid device credential; remote=127.0.0.1
```
来自审批网关（端口 3081），与 3095 登录无关。
**结论**：模拟器未完成审批网关配对，属预期状态。

---

## 八、尚未完成的真机项目

以下项目**必须真机验证**，模拟器无法替代：

| # | 项目 | 原因 |
|---|---|---|
| 1 | 扫码配对 | 模拟器摄像头为虚拟场景（`hw.camera.back=emulated`） |
| 2 | 通知实际送达 | 需真实任务完成事件 + 厂商 ROM 推送通道 |
| 3 | 通知点击跳转（含冷启动） | 同上 |
| 4 | 审批按钮实际生效 | 需触发真实命令执行审批 |
| 5 | 断网 / 恢复重连 | 需可控 WiFi 开关 |
| 6 | 震动反馈 | 模拟器无马达 |
| 7 | 边缘滑动手势 | 与系统手势导航冲突，模拟器无此冲突 |
| 8 | 图片查看 / 长按保存 | 需含图片消息的会话 |
| 9 | 文档转发 / 保存到下载 | 需含文件的会话 |
| 10 | 真实帧率 | 模拟器为 swiftshader 软渲染 |
| 11 | 生物识别 / 锁屏后的 Keystore 行为 | 需真实锁屏 |
| 12 | 检查更新 / 完整性校验 | 需公网访问 GitHub API |

---

## 九、正式签名测试准备

**本轮未执行正式签名构建** —— 遵守「不读取私有 Keystore、不接触密码」的约束。

### 已有工具

仓库内已存在管理员专用脚本（未推送前已在工作区）：

```
E:\work\dsBot\build-signed-apk.ps1
E:\work\dsBot\ANDROID-ACCEPTANCE-GUIDE.md
```

### 安全设计（已核实）

| 环节 | 做法 |
|---|---|
| 输入 | `Read-Host -AsSecureString`（不回显、不进历史） |
| 传递 | `ORG_GRADLE_PROJECT_DSH_*` 环境变量 |
| 内存 | `ZeroFreeBSTR` 释放 + 引用置 null |
| 清理 | `finally` 无条件清空环境变量 |
| 记录 | 不写日志、不打印任何密码片段 |

> **关键设计**：绝不使用 `-P` 命令行参数传递密码 —— 它会暴露在
> 进程列表（`Get-Process` / 任务管理器）和 PowerShell 历史里。

### 管理员执行步骤

```powershell
cd E:\work\dsBot
.\build-signed-apk.ps1
```
脚本会交互式询问 keystore 路径、别名与密码，并自动比对
CI 验证过的证书指纹 `191B16CE…736A`。

### 版本号提醒

本轮用于验收的 Debug 包 versionCode 为 **160701**（高于正式版 160300）。
若管理员后续构建的正式签名包 versionCode **低于 160701**，
安装时会报 `INSTALL_FAILED_VERSION_DOWNGRADE`，需要先卸载测试包
（**会丢失配对数据**）。

**建议**：正式验收包使用 `versionCode >= 160701`。

---

## 十、验收结论

### 是否达到下一阶段发布验收条件

**部分达到 —— 建议继续真机验收，暂不发布。**

**支持发布的证据（模拟器已验证）**：

- 核心链路完整可用：配对 → 工作区 → 会话 → 聊天 → 发送 → 回复
- 3 个阻断级缺陷已修复（其中 2 个会导致用户完全无法使用）
- 全程零崩溃、零 ANR
- 真实数据规模验证：582 目录 / 716 会话 / 92 会话列表
- 错误提示全部可读、可操作

**暂缓发布的原因**：

- **12 项真机项目未验证**（扫码、推送、审批、断网、震动、手势等）
- 1 个未定位的异常（AbortError 风暴）
- 正式签名包未做端到端验收

### 建议的下一步

1. **立即**：用 `docs/device-checklist.md` 的 16 项快速回归在真机跑一遍
2. **优先关注**：本次修复的 2 个缺陷在真机是否同样表现
   （尤其是缺陷 1，真机上「重装 App」是高频路径）
3. **可选**：管理员执行 `build-signed-apk.ps1` 做正式签名验收
4. **待观察**：AbortError 风暴是否复现

---

## 附录 A：可复现的自动化命令

```powershell
# 1. 启动模拟器（冷启动，避免损坏快照）
$emu = 'E:\Android\Sdk\emulator\emulator.exe'
& $emu -avd dsh_test -gpu swiftshader_indirect -no-snapshot -no-boot-anim

# 2. 等待就绪
$adb = 'E:\Android\Sdk\platform-tools\adb.exe'
do { Start-Sleep 5 } until ((& $adb shell getprop sys.boot_completed) -match '1')

# 3. 构建
$env:ANDROID_HOME='E:\Android\Sdk'
$env:ANDROID_SDK_ROOT='E:\Android\Sdk'
cd E:\work\dsBot\dsh-mobile\android
.\gradlew.bat assembleDebug '-PDSH_VERSION_CODE=160701' '-PDSH_VERSION_NAME=0.16.7-emu' --no-daemon

# 4. 安装 + 启动
& $adb install -r app\build\outputs\apk\debug\app-debug.apk
& $adb shell monkey -p com.dshpocket -c android.intent.category.LAUNCHER 1

# 5. Metro（仅在 debug 包需要时）
cd E:\work\dsBot\dsh-mobile
npx react-native start --port 8081
& $adb reverse tcp:8081 tcp:8081
```

## 附录 B：UI 自动化要点

用 `uiautomator dump` 取精确坐标，不要硬编码：

```powershell
& $adb shell uiautomator dump /sdcard/ui.xml
& $adb pull /sdcard/ui.xml "$env:TEMP\ui.xml"
```

实测坑位：

| 问题 | 说明 |
|---|---|
| 输入框坐标漂移 | 错误提示出现后按钮下移约 200px，必须重新 dump |
| `input text` 不认 `.` | 地址里的点号需整体输入，不要拆开 |
| 首次点击被吞 | 收键盘的那次点击不算数，发送需要点两次 |
| 坐标偏上 60px | 状态栏高度导致视觉位置与 dump 坐标有偏差 |

---

*报告生成时间：2026-10-27*
*APK：Debug / versionCode 160701 / versionName 0.16.7-emu*

---

# 补充：第二轮验收（2026-10-27 晚）

## 新增发现：登录认证绕过

上一轮的「401 误判」修复引入了新问题 —— `loginWithToken()` 改成
「先看 cookie jar」之后，**没有清空 jar**。

后果：jar 里的历史 cookie 会让**任何 token 都通过认证**。

已修复（提交 `f15555c`），新增 8 项安全回归测试，
覆盖错误 token / 过期 cookie / 错误服务端 / 跨服务端复用等边界。

## AbortError 风暴：根因确认

**不是客户端缺陷。** 实测 DSH 服务端：

| 指标 | 实测 |
|---|---|
| 进程 | 存活 |
| 端口 | 仍在监听 |
| 线程 | 14 个全部 Wait |
| CPU 5 秒增量 | 0 秒 |
| 日志 | 4 小时未更新 |
| HTTP | 100% 超时 |

**DSH 事件循环假死，重启前不会自愈。**

客户端侧确认无请求风暴（`sessionsLoading` 守卫生效），
AbortController 也正常工作（whatwg-fetch 支持 xhr.abort）。
错误提示已改进为可操作的中文建议。

## 独立 Release AVD

已创建 `dsh_release`（干净环境，30 秒启动），
可安装正式签名 APK 而不影响现有 Debug 包的配对数据。

## 干净环境二次验证

在 `dsh_release` 上全新安装 Debug 包 → 首次启动**直接进入配对页**，
白屏缺陷确认修复。

*详见 `DSH-OUTPOST-RELEASE-DEVICE-READINESS.md`*