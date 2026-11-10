# 01 · 架构总览与模块关系

> 审计基线：分支 `opt/p1-phone-polish`，HEAD `2325d34`，工作区干净。
> 本文所有行号均在该提交上实际读取并核对过。
> 本轮**只审计、不修改任何业务代码**。

---

## 一、系统全景

DSH Outpost 不是一个单体应用，而是**一套围绕 DSH Agent 后端的接入层**，由 4 个可独立部署的模块 + 一组 Windows 部署脚本组成。

```
                         ┌──────────────────────────────────────────────┐
                         │  宿主机（Windows）                            │
                         │                                              │
   ┌─────────────┐  WS   │  DSH Web (:3095)                             │
   │ dsh-mobile  │◄─────►│   ├─ dsh-plugin-mobile-gateway@0.10.3 (:3081)│
   │ (RN 0.81.4) │ HTTP  │   │    ↑ 被 patches/mobile-gateway-mgmt-auth │
   │  Android    │       │   │      注入鉴权（运行时文本补丁）           │
   │  + iOS 壳   │       │   └─ dsh-outpost-butler (cordis 插件)        │
   └──────┬──────┘       │        /api/outpost/butler/*                 │
          │              │                                              │
          │ cloudflared  │  tunnel-service.mjs (:3199, 仅 127.0.0.1)    │
          │ 快速隧道     │   └─ 子进程调用 start-tunnel.ps1             │
          ▼              │                                              │
     公网 URL            │  dsh-outpost-desktop (Electron)              │
   (trycloudflare)       │   └─ 子进程托管 tunnel-service.mjs           │
                         └──────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────────────────────┐
   │  手机端本地能力（不依赖宿主机）                                    │
   │  · P6 Kotlin Agent  → 直连 OpenAI/Anthropic/Gemini HTTPS          │
   │  · 本地 DSH Runtime → proot 内跑 guest DSH + butler               │
   └──────────────────────────────────────────────────────────────────┘
```

### 代码规模（git 跟踪文件，排除任意层级的 `node_modules/`、`build/`、`.gradle/`）

| 模块 | 源码行数 | 测试行数占比 | 主要语言 |
|---|---|---|---|
| `dsh-mobile` | 95 389（含测试，399 个 `.ts/.tsx/.js/.mjs/.kt/.java`） | 生产源码 45 492 行 / 188 文件；测试 142 个 spec | TS/TSX + Kotlin/Java |
| `dsh-plugin-connect` | 3 531 | 1 个（且已失效，见 CQ/TEST 报告） | JS/MJS |
| `dsh-outpost-butler` | 4 722 | 2 337 行测试 / 6 个 spec | JS (ESM) |
| `dsh-outpost-desktop` | 2 278 | 2 个 spec | JS (Electron) |
| 根 PowerShell + `scripts/` | ~2 500 | 由 mobile 的 spec 间接执行 | PS 5.1 |

---

## 二、模块清单与真实入口

### 2.1 `dsh-mobile` — React Native 客户端

| 层 | 入口文件 | 职责 |
|---|---|---|
| 启动 | `index.js` → `src/setup.ts` → `src/App.tsx` | `App.tsx:494-495` 创建 `DshConnection` + `Store`；`App.tsx:384` 提供 `AppContext`；`App.tsx:1594` 屏幕注册表 |
| 导航 | `src/nav/NavHost.tsx` | 自研栈导航（非 react-navigation），全部已挂载屏幕常驻 |
| 状态 | `src/core/store.ts`（2 972 行） | RPC 门面 + 流生命周期 + fold 投影 + 审批 + 通知扫描 + butler 门面 + pending-send 编排 |
| 投影 | `src/core/fold/index.ts`（1 083 行） | wire 事件 → 视图模型（Turn/Step/Block） |
| 出站 | `src/core/pendingSend/`（10 文件） | 持久化发件箱状态机（ids / fingerprint / state / store / staging / persistence / serviceBinding / errors / ui / types） |
| 屏幕 | `src/screens/`（17 个） | 最大：`ChatScreen.tsx` 1 486、`ProfileScreen.tsx` 1 031、`AgentButlerScreen.tsx` 1 029 |

### 2.2 四条并存的传输通道（关键架构事实）

客户端**同时**维护四条独立通道，彼此不共享连接与鉴权逻辑：

| 通道 | 客户端实现 | 对端 | 协议 |
|---|---|---|---|
| A · DSH RPC / 流 | `src/core/transport/index.ts` — `DshConnection.call()` (:468 起为 `request()`，`call()` 在 :340-458)、`openStream()` (:721) | DSH Web `:3095/api/*` | HTTP POST + `session/follow` WS，Cookie 鉴权 |
| B · 审批网关 | `src/core/approvalGateway.ts`（1 146 行，自建第二套 WS 实现 :272、:604-611） | `dsh-plugin-mobile-gateway` `ws(s)://host:3095\|3081/ws/mobile` (:356-368) | 子协议 `dsh-mobile-v1` + `dsh-pair.<code>` / `dsh-auth.<token>` |
| C · P6 原生 Agent | `src/core/agent.ts` → `NativeModules.OutpostAgent`（`AgentModule.kt:22`，34 个 `@ReactMethod`） | `android/agent-core/` → 直连云模型 HTTPS（`CloudModel.kt:22-27`） | 自定义 Kotlin 契约 |
| D · 本地 DSH Runtime | `src/core/localDsh.ts` → `NativeModules.OutpostLocalDsh`（`LocalDshModule.kt:19`） | `RuntimeSupervisor.java` 在 proot 内运行 guest DSH+butler（`RuntimeSupervisor.java:128,300`） | `RuntimeWire` HMAC + 序号/代次 |

> **原生模块访问被收敛在 4 个文件**：`agent.ts`、`localDsh.ts`、`localRuntimeSupport.ts`、`shareIntake.ts`。这是本项目做得最好的一条边界。

### 2.3 宿主侧模块

| 模块 | 入口 | 说明 |
|---|---|---|
| `dsh-outpost-butler` | `index.js`（114 行，cordis 插件） | `lib/task-api.js:46-160` 注册 Fetch 路由 `/api/outpost/butler/*`；`lib/task-manager.js`（876 行）为任务状态机；`lib/task-store.js` 追加式日志 + 快照 |
| `dsh-plugin-connect` | `client.js`（2 887 行） | **注意**：1-2318 行是内联的第三方 `qrcode-generator`（Kazuhiko Arase, MIT），真实插件 UI 只有 2319-2887 行。`index.js` 是空壳 `export function apply() {}` |
| ↳ | `tunnel-service.mjs`（534 行） | 127.0.0.1:3199 HTTP 控制服务；:528 `server.listen`；子进程调用 `start-tunnel.ps1` |
| `dsh-outpost-desktop` | `src/main/main.js`（1 089 行） | Electron 托盘应用；:456 spawn `tunnel-service.mjs`；:571-888 `ipcMain.handle`；`preload.js` 暴露固定 13 个方法 |

### 2.4 任务状态机（butler）

```
created → preparing → running → ┬─ waiting_user ─┐
                                ├─ blocked ──────┤→ completed
                                └────────────────┘→ failed
                                                 → cancelled
```
串行执行由单条 lane 保证：`task-manager.js:680`（`if (this.disposed || this.activeTaskId) return`）、`:686` 取 lane、`:805-815` `finishLane()` 释放。

---

## 三、配置与版本来源

| 配置项 | 真实来源 | 备注 |
|---|---|---|
| 网关地址 / token | 用户扫码 → `pairing.ts:36 parsePairingText` → Cookie 交换 → `secureStore.ts`（Keychain） | 宿主侧由 `start-dsh-web.ps1:433,452-454` 从 DSH 启动日志写出 `%LOCALAPPDATA%\dsh-pocket\pairing.json` |
| 端口 | 3095（DSH Web）、3081（网关直连回退，`approvalGateway.ts:356-383`）、3199（隧道服务） | `DSH_WEB_PORT` / `DSH_TUNNEL_PORT` / `DSH_POCKET_ROOT` 为环境变量覆盖 |
| 客户端版本 | `src/core/version.ts:7`（读 package.json） | 更新轮询 GitHub Releases（`updater.ts:33`） |
| 能力门控 | `HostLocation` `'desktop'\|'local'`（`hostLocation.ts:20-23`）、`entryGate.ts:17 shouldEnterApp`、`protocol.ts:29-49` 端点探测 | 无远程 feature flag |
| `release-floor.json` | `scripts/version-code.mjs:66` + `.github/workflows/android.yml:296`、`signing-verify.yml:201-212` | **CI 已强制执行** |
| `release-budgets.json`、`release-signing.json` | 仅 `dsh-mobile/scripts/release-gate.mjs:31,35` | **该脚本无任何调用方 → 两个门禁实际失效**（见 05 报告 TEST-14） |

---

## 四、架构发现

> 字段说明：`本轮实施建议` 指**下一阶段**是否应立刻动手（本轮为纯审计，不改任何业务代码）。

### ARCH-01 · `Store` 是上帝对象 · 严重度 High · 已确认

**位置**：`dsh-mobile/src/core/store.ts:351`（`class Store`，文件止于 :2972）

**证据**：约 65 个非私有成员，横跨至少 12 项职责：

| 职责 | 位置 |
|---|---|
| RPC 门面 | :352-358 |
| pending-send 网络管线 | `runPendingSend` :2722-2911 |
| 流生命周期 / 重连 / 补洞 | :1908-2300 |
| fold 投影 | `rebuild` :2351 |
| 审批网关生命周期 | `connectApprovals` :1273、`answerApproval` :1392 |
| 后台队伍通知扫描 + butler 唤醒 | `scanOnce` :1015、`wakeButler` :1466 |
| butler 任务/记忆门面 | :800-848 |
| 回复分叉 | :502-610 |
| 归档 / 自定义工作区持久化 | :1771-1866 |
| 兼容性探测 | :1628-1682 |
| Cookie / 吊销同步 | :1158、:1258 |
| 订阅发射节流 | :1515-1575 |

17 个 UI 文件通过 `useApp().store` 消费它，触及 40+ 个不同成员（包括 `fileCookie`、`gatewayStatus`、`resolvedApprovalIds` 等传输内部状态）。

**影响**：任何协议变更都要穿过同一个 3k 行类；无法单元测试单项职责；屏幕直接耦合到传输内部。

**建议修复**：按职责抽出控制器（审批、扫描/通知、流、butler 门面），复用已有的 `subscribe/emit`；`Store` 保留为组合根。

**修改风险**：**高**。触及每个屏幕。必须增量进行，建议从「审批控制器」开始（边界最清晰，且 `approvalGateway.ts` 已是独立类）。

**验证方法**：`tests/conversation-store-spec.mjs`、`tests/streaming-perf-f03-spec.mjs` 已存在；每抽出一个控制器补一个 spec。

**本轮实施建议**：暂不实施。属于「需先补测试再动」的大范围重构。

---

### ARCH-02 · 三个 Agent 后端并存但没有共享接缝 · 严重度 High · 已确认

**位置**：
- `dsh-mobile/src/core/localDsh.ts:3-31` 与 `src/core/localRuntime.ts:15-52`
- `src/core/agent.ts:100`（`AgentMemoryEntry`）与 `src/core/butlerMemory.ts`（`ButlerMemoryEntry`）
- `src/screens/AgentMemoryScreen.tsx`（249 行）与 `src/screens/ButlerMemoryScreen.tsx`（426 行）
- `src/screens/LocalProfileScreen.tsx:65`、`src/screens/HomeScreen.tsx:102-104`

**证据**：`localDsh.ts:3-31` 与 `localRuntime.ts:15-52` 定义了**逐字节相同**的 `LocalRuntimePhase` / `LocalRuntimeSnapshot` / `LocalRuntimeEvents`，以及一对孪生信封（`LocalDshCommandEnvelope` @ `localDsh.ts:23` vs `LocalCommandEnvelope` @ `localRuntime.ts:46`）。记忆系统有两套，屏幕有两个，靠 `LocalProfileScreen.tsx:65` 的能力探测二选一；butler UI 靠 `HomeScreen.tsx:102-104` 的 `location` 字段分叉。

代码库中**唯一真正的适配器接口**是 `ButlerClient`（`butlerClient.ts:121-134`，含 `LocalButlerClient` :281 / `DesktopButlerClient` :493）。

**影响**：每一个横切功能（审批、通知、记忆）都要实现 2-3 次。P6 Kotlin Agent 已经付出了这个代价——`AgentButlerScreen` + `AgentMemoryScreen` + `BackgroundDisplayScreen` 就是重复实现的结果。

**建议修复**：把 `ButlerClient` 风格的接口提升为后端 trait（sessions / tasks / memory / approvals / notifications），让 `location` 成为策略而非屏幕分叉。**第一步成本极低**：合并重复的 local-runtime 类型定义为单一来源并 re-export。

**修改风险**：整体高；类型合并这一步风险低。

**验证方法**：`tests/butler-client-spec.mjs` 已覆盖现有接口；每个后端补契约测试。

**本轮实施建议**：仅实施「合并重复类型定义」这一子项（低风险、可独立验证）。其余排期。

---

### ARCH-03 · DSH wire 形状泄漏到传输层之外 · 严重度 Medium · 已确认

**证据**（逐条实读）：

| 泄漏点 | 位置 | 内容 |
|---|---|---|
| 工具名硬编码 | `src/core/fold/index.ts:599` | `const DELEGATING_TOOLS = new Set(['spawn_teammate', 'team_task_create']);` |
| 工具名硬编码 | `src/core/toolDiff.ts:177,193` | `if (name === 'write') … if (name === 'edit')` |
| 工具名进入提示词 | `src/core/butler.ts:97-116` | persona prompt 内联 `wait_agent/list_agents/send_message/spawn_teammate` |
| 网关 wire 字面量进入 UI | `src/components/ApprovalBanner.tsx:441` | `press('allowed-once')` |
| 模型选择 wire 形状进入 UI | `src/components/ModelSwitcher.tsx:101` | `store.selectModel(sessionId, { provider, model: model.id, reasoningEffort: effort })` |
| UI 直接 import wire 类型 | `TeamBar.tsx:15`、`TeamSheet.tsx:13`、`TaskBoardScreen.tsx:15`、`WorkspacesScreen.tsx:19`、`ChatScreen.tsx:68` | `AgentTeam` / `TeamMember` / `TeamTask` / `SessionAddress` / `SessionSummary` |
| 端点名作为兼容契约 | `src/core/protocol.ts:29-45` | 15 个 DSH 端点名 |

**影响**：见 ARCH-11（多后端可扩展性结论）。

**建议修复**：把 `fold` 扩展为完整的视图模型边界——team / tool-diff / approval-outcome 的映射全部搬进 `fold`/`core`，UI 只 import 视图类型。

**修改风险**：Medium，机械性改动但面广。

**验证方法**：`tests/fold-*-spec.mjs` 系列已存在；新增一条 lint/spec：`src/screens` 与 `src/components` 下不得 import `core/types`。

**本轮实施建议**：排期。先加「禁止 import」的守卫测试（零风险），再逐步搬迁。

---

### ARCH-04 · 四条带凭据的 HTTP 路径绕过 `DshConnection` · 严重度 Medium · 已确认

**位置**：`approvalGateway.ts:839`（`fetch ${base}/mgw/pair`）、`deviceAuth.ts:170,258`（`/mgw/devices`）、`serverIdentity.ts:217`（`/mgw/status`）、`updater.ts:58,240`（GitHub API + APK 下载）

**证据**：`transport/index.ts:155-158` 的注释明确声称自己是「带凭据请求的唯一出口」——该断言现在已不成立。审批网关 WS 本身还是第二套完整 socket 实现（`approvalGateway.ts:272`，自定义构造器 :604-611）。

部分绕过是合理的（mgw 插件说的是另一套协议），但代价是：Cookie 策略与 URL 安全策略（`assertSecureUrl`、`setCookie` 轮换 :181-194）必须在每个调用点各自重新实现，存在漂移风险。

**影响**：新增网络调用点若忘记调用 `assertSecureUrl`，会静默继承 OS 层明文许可（`network_security_config.xml` 全局允许明文，见 `docs/known-issues.md` §3）。

**建议修复**：抽一个薄的 `GatewayAdminClient`，与 transport 共享 Cookie / URL 策略；协议帧仍各自独立。

**修改风险**：Medium。

**验证方法**：`tests/approval-gateway-spec.mjs`、`tests/cookie-auth-state-consistency-spec.mjs`。建议新增一条枚举所有网络原语调用点的静态 spec。

**本轮实施建议**：排期。先加静态枚举守卫。

---

### ARCH-05 · 生产核心静态 import 开发模块 · 严重度 Medium · 已确认（本人复核）

**位置**：`src/core/store.ts:80-87` → `from '../dev/p0Verify'`；`src/core/store.ts:2548-2553`

**证据**：`p0Verify.ts:2` 自称「Debug-only…每个调用点都有 `__DEV__` 守卫」，但 **import 语句本身是无条件的**，因此该模块会进入 release 包。此外生产发件箱管线里存在魔法字符串测试钩子：

```ts
// store.ts:2548-2553（runPendingSend 内部）
trimmed.includes('[P0_BLOCK]')  →  armP0TestRequest
```

所有调用点确实都有 `IS_DEV` 守卫（:2548、:2800、:2835），release 行为是惰性的。但**开发专用分支永久驻留在整个代码库最安全关键的方法 `runPendingSend` 里**。

**影响**：包体污染、认知负担，以及「哪天守卫漏掉一个」的隐患。

**建议修复**：把钩子检查移到可注入的 `StoreOptions.testHooks`，仅 dev 填充。

**修改风险**：**低**（不改任何 release 行为）。

**验证方法**：现有 `tests/p0-verify*-spec.mjs`；新增一条 release 包体 grep 测试。

**本轮实施建议**：建议排期优先（低风险、收益明确）。注意 `p0-verify-spec.mjs` 与 `p0-verify-behavior-spec.mjs` 当前**不在 CI 中**（TEST-02），需一并接入。

---

### ARCH-06 · `P0Harness`（475 行）被收进 release 包 · 严重度 Medium · 高可信风险

**位置**：`dsh-mobile/index.js:14-17`

**证据**：
```js
if (__DEV__) {
  const P0Harness = require('./src/dev/P0Harness').default;
  AppRegistry.registerComponent('P0Harness', () => P0Harness);
}
```
`metro.config.js` 内容为空（`config = {}`）。Metro 会把 `__DEV__` 内联为 `false`，但**依赖收集仍会登记这个 `require`，且 Metro 不做 tree-shaking**。`P0Harness.tsx` 引入的 Store / transport / secureStore 本来就已打包，所以增量主要是它自身的 475 行。

`android/app/src/debug/java/com/dshpocket/P0HarnessActivity.kt` 位于 debug source set，**这部分是正确的**。

**待验证**：需要构建一次 release bundle 并 grep `P0Harness` / `p0HarnessPhase` 才能确认。本轮未构建（只读约束）。

**建议修复**：把 harness 注册移到 dev 专用入口，或用 Metro 能剔除的方式门控。

**修改风险**：低。

**本轮实施建议**：先验证（构建 release bundle 检查），再决定是否实施。

---

### ARCH-07 · `LocalButlerScreen.tsx`（801 行）是孤儿死代码 · 严重度 Medium · 已确认（本人复核）

**证据**：全仓 grep `LocalButlerScreen` 只有两处命中：
- `src/screens/LocalButlerScreen.tsx:173`（自身定义）
- `tests/local-butler-placement-spec.mjs:29`（一个**过期 mock**）

`src/` 与 `index.js` 中**零 import**。`HomeScreen.tsx:103` 现在对 `location === 'local'` 渲染的是 `AgentButlerScreen`。

**影响**：801 行易漂移的死 UI 仍在被维护、被 `tsc --noEmit` 检查；测试在 mock 一个生产已不再使用的模块——这正是 `9c17dbd`（"repair two stale component mocks"）那一类问题的温床。

**建议修复**：删除，或显式隔离；同时重写 `local-butler-placement-spec.mjs` 断言当前 `HomeScreen` 的真实行为。

**修改风险**：低。

**本轮实施建议**：建议优先实施（低风险、直接减少 CI 脆性）。

---

### ARCH-08 · 死导出 · 严重度 Low · 已确认（本人复核）

| 位置 | 内容 | 消费者 |
|---|---|---|
| `src/core/butlerClient.ts:559` | `createButlerClient` | **0**（屏幕直接构造实现：`ButlerTasksScreen.tsx:102`、孤儿 `LocalButlerScreen.tsx:177`） |
| `src/core/butler.ts:148` | `withModeTag` | **0**（其自身文档注释 :133-147 就写着「为什么不推荐用了」） |
| `src/core/butler.ts:169` | `isModeSwitch` | **0** |

**建议修复**：删除或标记 internal。风险 trivial。可在 CI 加一条 grep 门禁。

---

### ARCH-09 · 会话 Cookie 暴露在 Store 公共表面并进入屏幕渲染逻辑 · 严重度 Low · 已确认

**位置**：`src/core/store.ts:662-665`（`get fileBaseUrl()` / `get fileCookie()`）→ `src/screens/ChatScreen.tsx:282-284`

**证据**：`ChatScreen.tsx:282-284` 执行 `withdrawalScope(store.fileBaseUrl, store.fileCookie)`，:360 还用它比较归一化 URL。**会话 Cookie 是 bearer 凭据，却经由 React context 流进屏幕渲染逻辑**，并成为 memo key 的一部分。

**影响**：任何屏幕都能泄漏/误用该 Cookie；memo key 依赖凭据身份。

**建议修复**：屏幕应拿到一个不透明的文件下载 token / 服务，而非原始 Cookie。

**修改风险**：Medium（文件预览/下载路径）。

**本轮实施建议**：排期。

---

### ARCH-10 · `App.tsx`（1 686 行）把组合根与业务流程混在一起 · 严重度 Low · 已确认

**证据**：`App()`（:462）同时处理凭据迁移（:608-621）、遗留未登录证据窥探（:427-440）、主题、host-location 回退（:585）、butler 会话生命周期**以及 persona 注入**（`primeButler` :1236-1242 通过 `store.send` 发送 `buildButlerPrime()`）、审批接线（:1522-1533），外加屏幕注册表 `renderScreen`（:1594-1656）和含 25+ 字段的 `AppContextValue`（:210-275）。

严重度低于 ARCH-01（大部分是生命周期接线），但 butler 会话管理与屏幕注册表是两个可独立抽出的单元。

**建议修复**：抽出 `useButlerSession` hook 与 `screens/registry.ts`。风险 low-medium。

---

### ARCH-11 · 多后端可扩展性结论（重点交付项）

**现状**：应用**已经有三个后端**（桌面 DSH 宿主、遗留的设备内 DSH guest、P6 Kotlin Agent），并且正在没有接缝的地方付出代价。

**已存在且有效的接缝**：
- `DshConnection` 的依赖注入（`transport/index.ts:81-92` 注入 fetch / WS）
- `fold`（wire → 视图模型，但不完整）
- `ButlerClient`（唯一的跨后端接口，`butlerClient.ts:121`）
- `localRuntimeBridge` 的显式操作白名单（好模式）

**缺失的接缝**：**没有任何东西统一「会话/聊天」这一层**。`ChatScreen` 与 `Store`+DSH 焊死（`ChatScreen.tsx:68` 的 `SessionAddress`、`session/follow` 的流语义、`types.ts:78-125` 中注明「全部字段名来自本机实测采样」的 `Projections`），而 `AgentButlerScreen` 与 `agentClient` 快照焊死。

**诚实的规模评估**：今天要接入第二个**具备聊天能力的**后端，需要：新传输客户端 + 新投影/fold 等价物 + 新 Store 职责或平行 store + 新屏幕（当前模式）+ 重新接审批（网关 WS 协议是 DSH 插件专有的）。**这基本就是 P6 已经付出的成本**——`AgentButlerScreen` + `AgentMemoryScreen` + `BackgroundDisplayScreen` 就是重复实现的结果。

**干净的适配器边界应长什么样**（仅评估，不设计、不实现）：
1. 一个覆盖 sessions / stream-view-models / tasks / memory / approvals / notifications 的后端 trait，泛化现有的 `ButlerClient`；
2. `fold` 被提升为**唯一**允许出现 wire 形状的地方，UI 只 import 视图类型；
3. 用能力描述符取代 `p6AgentAvailable()` / `location` 的屏幕分叉。

**结论**：积木已经存在（`ButlerClient`、`fold`、transport 注入），只是**没有被强制当作边界**。因此建议路径是「先立守卫（lint/spec 禁止 UI import wire 类型）→ 再收敛 fold → 最后抽 trait」，而**不是**现在就写适配器。

---

## 五、边界评估中「干净」的部分（有据，不作为发现）

- **`butler*` 8 文件拆分是真实分解，不是碎片化**：persona prompt（`butler.ts`）、wire 客户端（`butlerTasks.ts`，REST 到 `/api/outpost/butler/*`）、location 策略接口（`butlerClient.ts:121`）、活动差分（`butlerActivity.ts:17`）、审批作用域（`butlerApprovalScope.ts:12`）、归属守卫（`butlerSessionOwnership.ts:8`）、UI 词汇（`butlerTaskList.ts`）、记忆客户端（`butlerMemory.ts`）。唯一瑕疵：`Store.listButlerTasks`（:800-829）纯粹为了喂 `butlerOwnership.remember()` 而包一层，`DesktopButlerClient` 又包一层 Store，形成「屏幕→client→store→fn→conn」四跳透传链；可容忍但很薄。
- **`pendingSend/` 10 文件拆分干净**：每个文件单一职责，且带头部契约说明（`pendingSend/store.ts:1-9`）。
- **原生模块访问收敛在 4 个文件**（见 §2.2）。
- **历史债标记为零**：全仓 grep `TODO/FIXME/HACK/XXX/@deprecated/@legacy` 在所有 TS/TSX/JS/MJS/PS1/KT/Java 中**零命中**，注释掉的代码块也是零。`"legacy"` 在 mobile src 中出现 93 次，但全部指活跃的兼容路径（凭据迁移、遗留本地 runtime），不是债务标记。

> 这一条值得强调：**这个代码库没有常见的「TODO 堆积」型腐化**。它的债务是结构性的（ARCH-01/02/03），而不是卫生性的。
