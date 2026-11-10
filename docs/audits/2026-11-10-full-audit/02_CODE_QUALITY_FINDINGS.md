# 02 · 代码质量与冗余问题

> 审计基线：`opt/p1-phone-polish` @ `2325d34`。所有引用行号均已实读核对。
> 本文只收录**质量/冗余/一致性**类问题。Bug 与安全见 `03`，性能见 `04`，测试见 `05`。
> 编号规则：`CQ-nn`。严重度 = Critical / High / Medium / Low；置信度 = 已确认 / 高可信风险 / 待验证假设。

---

## CQ-01 · 跨模块重复逻辑 13 组，其中 4 组已经漂移出真实缺陷 · 严重度 High · 已确认

这是本项目**最主要的质量债**。它不是"看起来重复"，而是**已经产生了 Bug**：重复副本之间发生了漂移，且漂移方向是"少了一个分支"。

### 重复清单（按漂移风险排序，↔ 表示互为副本）

| # | 重复内容 | 副本位置 | 状态 |
|---|---|---|---|
| 1 | LAN IP 选择（网卡名正则 + 私网段回退） | `start-dsh-web.ps1:191-204` ↔ `start-tunnel.ps1:237-247` ↔ `tunnel-service.mjs:160,196,207-218` ↔ `dsh-outpost-desktop/src/main/main.js:552-565` | **已漂移** → CQ-01a |
| 2 | `Write-Step/Ok/Warn2/Err2` 日志助手 | `start-tunnel.ps1:131-134` ↔ `setup-gateway.ps1:39-42` ↔ `build-signed-apk.ps1:82-85` ↔ `setup-autostart.ps1:54-57` ↔ `start-dsh-web.ps1` ↔ `setup-butler.ps1` | **已漂移成崩溃** → `03` 报告 BUG-10 |
| 3 | 原生命令 EAP=Stop 防护 | 正确：`scripts/gateway-patch-gate.ps1:107-114`、`scripts/butler-installer.ps1:4-17` ↔ 缺失：`setup-gateway.ps1:87,112,115` | **已漂移** → `03` 报告 BUG-11 |
| 4 | token 脱敏正则 | `tunnel-service.mjs:363-365`（`[^&\s]+`）↔ `doctor.ps1:35-43`（`[^&\s''"<>]+` + 额外裸 token 规则） | **已漂移**：同一份数据两种遮蔽行为 |
| 5 | profile 路径 `%USERPROFILE%\.dsh\profiles\web` | 硬编码 ×5：`setup-gateway.ps1:35,58,87`、`gateway-patch-gate.ps1:64`、`patches/…/apply.mjs:57-68`、`doctor.ps1:178`、`docs/butler-tools.md:28` ↔ DSH_HOME 感知 ×3：`start-dsh-web.ps1:124`、`setup-butler.ps1:33`、`doctor.ps1:156` | **已漂移** → `03` 报告 BUG-12/BUG-13 |
| 6 | schtasks-bat 启动三元组（Delete/Create/Run） | `start-tunnel.ps1:268-280` ↔ `start-tunnel.ps1:466-476` ↔ `start-tunnel-service.ps1:100-102` | 未漂移，但注释块 265-267 ↔ 460-465 逐字重复 |
| 7 | ACL 收紧 | `start-tunnel.ps1:98-117 (Protect-StateFile)` ↔ `start-dsh-web.ps1:396-412` ↔ `start-dsh-web.ps1:456-493` | **一处缺口** → `03` 报告 SEC-05 |
| 8 | dsh 可执行文件候选列表 | `start-dsh-web.ps1:150-155` ↔ 死函数 `Get-DshPath` `start-dsh-web.ps1:72-82` ↔ `setup-gateway.ps1:75-79` ↔ `doctor.ps1:74-79` ↔ `start-tunnel.ps1:121+` | 顺序各不相同，且文档是第四种顺序 → CQ-04 |
| 9 | TCP 端口探测 | `tunnel-service.mjs:258-278 (canConnect)` ↔ `main.js:645-665 (probePort)` | 逻辑相同，超时不同 |
| 10 | BOM 剥离 JSON 读取 | `tunnel-service.mjs` readJson ↔ `main.js:529-549 (readPairing/readTunnel)` ↔ `patches/…/apply.mjs:76` | 未漂移 |
| 11 | token 提取正则 `[?&]token=([A-Za-z0-9_\-]+)` | `start-dsh-web.ps1:461` ↔ `start-tunnel.ps1:501` | 今日完全一致 |
| 12 | QR 生成 | `dsh-plugin-connect/client.js:24-2318`（内联 qrcode-generator，MIT）↔ `dsh-outpost-desktop` 的 `qrcode@^1.5.4` npm 依赖（`package.json:23` + `qr:make` IPC） | 两套实现，跨模块 |
| 13 | 端口字面量 | `3095` 出现在 ≥12 个代码文件；`3199` 出现在 6 个（含 **`client.js:2644` 硬编码、无 env 覆盖**）；`3081` 出现在 2 个 | → CQ-01b |

### CQ-01a · LAN IP 正则已漂移（具体证据）

`main.js:563` 使用 `/wi-?fi|wlan|无线/i`，**缺少 `Wireless`**；而三个兄弟副本（`start-dsh-web.ps1:204`、`start-tunnel.ps1:247`、`tunnel-service.mjs:209`）都使用 `WLAN|Wi-?Fi|无线|Wireless`。`main.js` 还缺少 `tunnel-service.mjs:207-218` 里那层私网段回退。

**影响**：网卡名形如 "Wireless LAN Adapter" 时，桌面端「一键修复」会选错/选到虚拟网卡，而隧道服务选对了 → 修复动作反复抖动。

**为什么现有测试抓不到（追加证据）**：`dsh-outpost-desktop/tests/main-logic-spec.mjs:163-167` 的「优先 WLAN 网卡」用例是**纯文本断言**——它把 `main.js` 当字符串读进来（`MAIN.indexOf('function primaryLanIp')` + `slice(i, i+700)`），然后断言 `/wi-?fi|wlan/i.test(body)`。这条正则比生产代码里的 `/wi-?fi|wlan|无线/i` **更弱**，也弱于三个兄弟副本的 `WLAN|Wi-?Fi|无线|Wireless`。因为 `wi-?fi` 必然命中，无论 `Wireless` 这一分支存在与否，断言**永远为真**。也就是说，这条测试把漂移**固化**了下来，而不是发现它。这与 `05_TEST_COVERAGE_GAPS.md` 把 `main.js` 归类为 **TEXT-ONLY**（1089 行里只有一个函数被 `vm.runInNewContext` 真正执行）是同一个根因。

**建议修复**：单一来源——由 `tunnel-service.mjs` 暴露 `/tunnel/lanip`，桌面端改为调用它；或至少把正则与回退层级逐字对齐。
**修改风险**：低。**验证方法**：在 `dsh-outpost-desktop/tests/network-repair-spec.mjs` 增加一个 `Wireless` 别名的用例；同时把 `main-logic-spec.mjs:166` 的断言收紧到与单一来源逐字一致，否则它会继续掩盖后续回归。
**本轮实施建议**：建议优先实施。

### CQ-01b · `client.js:2644` 硬编码服务端口

```js
const SERVICE_BASE = 'http://127.0.0.1:3199';
```
其他所有组件都尊重 `DSH_TUNNEL_PORT`（`tunnel-service.mjs:30`、`start-tunnel-service.ps1:42`、`main.js:231`、`doctor.ps1:132`），只有插件面板不尊重。**改端口会静默只弄坏插件面板**。

**建议修复**：从配置槽读取，或探测两个默认值。**修改风险**：低。**本轮实施建议**：排期。

**CQ-01 总体验证方法**：为「LAN IP 选择」和「日志助手」各建一个单一来源模块，然后加一条静态 spec 断言不存在第二份实现。
**CQ-01 总体修改风险**：中（PowerShell 脚本无 CI 保护，PS 5.1 与 pwsh 7 行为差异见 `05` 报告 TEST-16）。
**本轮实施建议**：分组实施，先做 #1（已产生缺陷、影响用户可见功能），其余排期。

---

## CQ-02 · 死代码清单 · 严重度 Medium · 已确认（逐项 grep 复核）

| 位置 | 内容 | 消费者数 | 备注 |
|---|---|---|---|
| `dsh-mobile/src/screens/LocalButlerScreen.tsx` | 整个屏幕，**801 行** | **0** | `HomeScreen.tsx:103` 已改渲染 `AgentButlerScreen`；仅剩 `tests/local-butler-placement-spec.mjs:29` 一个过期 mock |
| `dsh-mobile/src/core/butlerClient.ts:559` | `createButlerClient` | **0** | 屏幕直接构造实现 |
| `dsh-mobile/src/core/butler.ts:148,169` | `withModeTag`、`isModeSwitch` | **0** | 自身文档注释 :133-147 已写明"为什么不推荐用了" |
| `dsh-mobile/src/core/store.ts:1407` | `markApprovalDecided` | **1**（:1330 调用，但**永远不生效**） | `ChatItem` 的 assistant 变体（`fold/index.ts:600-616`）**没有 `approvals` 字段**——审批挂在 `Turn`（`fold/index.ts:97`）上，`toChatItems` 从不复制它。因此 :1412-1413 的 `list` 恒为 `undefined`，循环恒 `continue`。:1328 的注释「让聊天记录里那张卡片也进入已决状态」描述的意图**未达成** |
| `dsh-mobile/tests/support/cookie-manager-stub.mjs` | 88 行 | **0** | 第三个 Cookie jar（见 `05` 报告 TEST-04） |
| `dsh-mobile/tests/support/local-runtime-app.js` | 28 行 | **0** | |
| `dsh-mobile/tests/support/node-ts-bootstrap.mjs` | 48 行 | **0**（仅 `tests/README.md:179` 提及） | 且不注册任何 RN shim，按其自身 docstring 会触发 Flow 解析错误 |
| `dsh-mobile/tests/support/ws-with-headers.mjs` | 181 行 | 1（`runtime-compat-spec.mjs`） | 已被 `ws-compat.mjs` 取代 |
| `dsh-mobile/jest.config.js` | `preset: 'react-native'` | **0** | jest / react-test-renderer / @testing-library 均**不在任何 package.json 也不在 node_modules**；无 `__tests__` 目录、无 `*.test.ts(x)` 文件 |
| `dsh-plugin-connect/client.js` `readLocalJson`（:2362-2373） | | **0** | 自 :2492 注释所述的文件读取回退被移除后即为死代码 |
| `start-dsh-web.ps1:72-82` | `Get-DshPath` 函数 | **0** | :149-162 有一份内联重复 |
| `dsh-mobile/src/dev/P0Harness.tsx` | 475 行 | dev-only | 见 CQ-03 |

**影响**：`LocalButlerScreen` 801 行仍在被 `tsc --noEmit` 检查、仍被一个 spec mock——这是 CI 脆性的直接来源（`9c17dbd` 那一类"过期 mock 中断整条链"）。`markApprovalDecided` 更值得注意：它是**看起来在做事、实际完全不生效**的代码，未来若 `ChatItem` 真的加上 `approvals` 字段，它会静默开始原地修改已渲染状态且不触发重渲染。

**建议修复**：删除 `LocalButlerScreen.tsx` 并重写其 placement spec；删除 4 个零消费者的测试 support 文件；删除 `jest.config.js` 或真正引入 jest（见 `05` 报告 TEST-10）；`markApprovalDecided` 要么删除、要么改为作用于 `chat.turns[].approvals` 并补 `this.emit()`。

**修改风险**：低（删除）；`markApprovalDecided` 改写为 low。
**验证方法**：删除后跑全量测试链；`grep -rn markApprovalDecided dsh-mobile` 应只剩 0 或 2 处一致的结果。
**本轮实施建议**：**建议优先实施**。这是本轮性价比最高的一类改动——零功能风险、直接降低 CI 脆性、减少 `tsc` 与 Metro 的无效工作量。

---

## CQ-03 · 开发专用代码进入 release 产物 · 严重度 Medium · 已确认 / 部分待验证

### CQ-03a · `store.ts` 无条件 import dev 模块（已确认）

`src/core/store.ts:80-87` → `from '../dev/p0Verify'`。`p0Verify.ts:2` 自称"Debug-only，每个调用点都有 `__DEV__` 守卫"，但 **import 本身无条件**，模块必然进入 release 包。

更值得注意的是**魔法字符串测试钩子驻留在最安全关键的方法里**：

```ts
// store.ts:2548-2553，位于 runPendingSend 内部
trimmed.includes('[P0_BLOCK]')  →  armP0TestRequest
```

调用点 :2548、:2800、:2835 确实都有 `IS_DEV` 守卫，release 行为惰性。但 `runPendingSend`（:2722-2911）正是 `07_REGRESSION_PROTECTION.md` 列为「不得重构」的第 8 项——把开发钩子永久嵌在这里，等于给最关键的路径增加了一个"守卫漏掉一个就出事"的失败面。

### CQ-03b · `P0Harness` 被 Metro 收进 release 包（待验证）

`index.js:14-17` 在 `if (__DEV__)` 内 `require('./src/dev/P0Harness')`。`metro.config.js` 为空配置。Metro 会内联 `__DEV__=false`，但**依赖收集仍登记该 require，且 Metro 不做 tree-shaking**。

`android/app/src/debug/java/com/dshpocket/P0HarnessActivity.kt` 位于 debug source set，**这部分正确**。

**待验证**：需构建一次 release bundle 并 grep `P0Harness`。本轮受只读约束未构建。

**建议修复**：钩子改为可注入的 `StoreOptions.testHooks`（仅 dev 填充）；harness 注册移到 dev 专用入口。
**修改风险**：低（不改 release 行为）。
**验证方法**：release bundle grep；新增一条 spec 断言 `src/dev` 不被非 dev 模块 import。
**本轮实施建议**：CQ-03a 排期优先；CQ-03b 先验证再决定。

---

## CQ-04 · 文档与代码漂移 18 处 · 严重度 Medium · 已确认（逐条双向核对）

**最严重的一条**：文档在教一个**代码明确警告不要用**的协议值。

| # | 文档断言 | 代码事实 | 类别 |
|---|---|---|---|
| **1** | `docs/protocol-compat.md:42`：子协议 `dsh-mobile-v1` + `dsh-pair.<code>` / **`dsh-token.<token>`**；`docs/known-issues.md:11,41` 同样写 `dsh-token.` | 代码用的是 **`dsh-auth.`**，且 `src/core/approvalGateway.ts:546-548` 有显式警告注释：「⚠️ token 的子协议是 `dsh-auth.`，不是 `dsh-token.`。插件 `extractCredential()` 只认 dsh-auth. / dsh-pair.」。`docs/mobile-gateway.md:104` 与 `docs/security.md:151` 是**对的** | **已确认（危险）** |
| 2 | `docs/mobile-gateway.md:26,39-40`：`adminLoopbackOnly: true` 是默认值，opt-in 参数 `-AllowLanManagement` | `setup-gateway.ps1` **没有 `-AllowLanManagement` 参数**（:28-31）；打完补丁门禁后**总是**写 `false`（:147、:160） | 已确认 |
| 3 | `docs/mobile-gateway.md:42-56`：「/mgw/pair 无鉴权…本仓库闭合不了」，未提补丁 | 补丁存在且在每次启动时被门禁检查（`patches/…/patch.mjs:89-158`、`start-dsh-web.ps1:127-146`） | 已确认 |
| 4 | `docs/mobile-gateway.md:89-92`：`curl /mgw/status` 返回 200 即验证通过 | 打补丁后未鉴权请求**按设计返回 401**（`patch.mjs:137-147`） | 已确认 |
| 5 | `docs/security.md:140`：DSH 日志「现在在 `%LOCALAPPDATA%\dsh-pocket\logs\`」 | 隧道路径仍写 `%TEMP%\dsh-web-$Port.log`（`start-tunnel.ps1:269,415`）→ 即 `03` 报告 SEC-05 | 已确认 |
| 6 | `docs/configuration.md:3`、`README.md:363`：「代码里**没有写死任何盘符**」 | `start-dsh-web.ps1:79,152`、`setup-gateway.ps1:78`、`start-tunnel.ps1:73,127` 均含 `E:\DSH\…` / `E:\cloudflared\…`（`configuration.md:29` 自己也列了 `E:\cloudflared`）。客观说这些是**候选回退项**而非硬依赖，但 :3 的绝对化表述不成立 | 已确认 |
| 7 | `docs/configuration.md:20-23`：dsh 查找顺序 = env → **PATH** → LOCALAPPDATA → ProgramFiles | 实际（`start-dsh-web.ps1:149-162`）= `$env:DSH_CLI` → **`E:\DSH\…`** → LOCALAPPDATA → ProgramFiles → **PATH 最后**（`Get-Command dsh`）。**这条会造成真实误判**：PATH 上有新版 dsh、`E:\DSH` 有旧版时，代码选旧版而文档预测选新版 | 已确认 |
| 8 | `docs/configuration.md:14`、`README.md:373`：`DSH_WEB_PORT` = DSH Web 端口 | 只有 `doctor.ps1:131` 与 `tunnel-service.mjs:101` 读它；启动器用字面量 `-Port 3095`（`start-dsh-web.ps1:49`、`start-tunnel.ps1:37`） | 已确认 |
| 9 | `docs/configuration.md:16`：`DSH_PERMISSION_MODE` 是可配置环境输入 | 被**故意忽略/覆写**（`start-tunnel.ps1:425-436`、`start-dsh-web.ps1:372`）。这个设计是对的（防止静默继承危险模式），但文档没说 | 已确认 |
| 10 | `docs/configuration.md:98`：打印 `LOCALAPPDATA\dsh-outpost` | 状态目录是 `dsh-pocket`（`configuration.md:11`、`known-issues.md:112-115` 与全部代码）。`known-issues.md` §4 明确说明这是**有意保留** | 已确认 |
| 11 | `dsh-outpost-desktop/README.md:44-46`：「搜 fetch 只有两处」 | 实测 `main.js` 有 **5** 处（:478、:494、:512、:813、:841）。实质结论（只访问本机/已配对主机）成立 | 已确认 |
| 12 | `docs/desktop-download.md:3-6`：当前 release v0.18.2 | 仓库为 v0.18.3（`dsh-outpost-desktop/package.json`、`README.md:461`） | 已确认 |
| 13 | `docs/desktop-download.md:60-71`：`[IO.File]::AppendAllBytes`「需要 PS7+」 | **该 .NET API 根本不存在**——PS 5.1 反射只显示 `AppendText/AppendAllText/AppendAllLines`。该代码片段在任何版本上都失败 | 已确认(5.1) / 高可信(PS7) |
| 14 | `ANDROID-ACCEPTANCE-GUIDE.md:167`：`npm run dist` | `dsh-outpost-desktop/package.json` **无 `dist` 脚本**（只有 `start`/`pack`/`test`） | 已确认 |
| 15 | `ANDROID-ACCEPTANCE-GUIDE.md:53`：`ConvertFrom-SecureString -AsPlainText` | 该参数在 PS 5.1 不存在（本机验证），PS7+ 专有，文档未注明 | 高可信 |
| 16 | `docs/protocol-notes.md:580,623`：引用 `probes/verify2.mjs`、`start-web-tailnet.ps1` | 两者均不存在（`probes/` 被 gitignore；无此脚本） | 已确认 |
| 17 | `README.md:278`：setup-gateway「做三件事」 | 实际有第四步——补丁检查/应用 + fail-closed（`setup-gateway.ps1:95-133`） | 已确认 |
| 18 | `doctor.ps1:155` 注释标 butler 为「(v0.19)」；`docs/device-checklist.md:1` 标「v0.16.3」且被 `README.md:433` 当作当前版本链接 | butler `package.json:3` 为 `0.1.0`；项目为 v0.18.3 | 已确认（轻微） |

**已核对为准确、无漂移的文档**（明确记录，避免夸大）：`docs/butler-tasks.md`（TaskApi 表 / health 载荷 / Idempotency-Key 对照 `task-api.js:111-113,141`、`task-store.js:6`）、`docs/runtime-compat.md`（引用的脚本/文件对照 `dsh-mobile/package.json:100-107` 与 `tests/support`）、`docs/release-verification.md`（对照 `.github/workflows/android.yml:393-437`）、`docs/mobile-gateway.md` 的协议帧章节（对照已安装插件）、`ANDROID-ACCEPTANCE-GUIDE.md` 的证书指纹（对照 `build-signed-apk.ps1:77,80`）。

**影响**：第 1 条最危险——`docs/protocol-compat.md` 与 `docs/known-issues.md` 是排障时最先被翻的文档，而它们教的子协议名会让排障者得出「客户端实现错了」的**反向结论**，代码里的警告注释反而看起来像 Bug。第 7 条会造成真实的选错可执行文件。

**建议修复**：第 1、5、7、13、14 条立即改（纯文档，零代码风险）；其余排期。建议为「文档中出现的命令/脚本名/参数名」加一条静态 spec（`docs/*.md` 中 `npm run X` 必须存在于某个 package.json；`.ps1` 文件名必须存在）。
**修改风险**：文档改动为零风险；静态 spec 为低风险。
**本轮实施建议**：**建议立即实施文档修正**（尤其第 1 条），静态 spec 排期。

---

## CQ-05 · 测试工具链内部不一致 · 严重度 Medium · 已确认

| 位置 | 问题 |
|---|---|
| `tests/support/rn-module-hook.mjs:45` vs `tests/support/ts-resolve.mjs:27-36` | 两套 TS 扩展名解析器共存：前者试 6 个扩展名，后者试 8 个（多 `.cjs`、`/index.js`）。**tsx 路径与 node 原生路径的模块解析行为不同** |
| `tests/support/ws-compat.mjs:142-149` | `fire()` **吞掉所有 handler 异常**；:153 把所有消息数据 `String(data)` 化 → 二进制帧与产品代码在 WS handler 内抛出的异常都不可见 |
| `tests/support/ws-compat.mjs:56` | `send()` 在 `readyState !== OPEN` 时**不抛错**；真实 WebSocket 会抛 `InvalidStateError` |
| `tests/support/node20-sim.cjs` vs `ws-compat.mjs:224-227` | `node20-sim` 唯一动作是 `delete globalThis.WebSocket`（:18）；而 `ws-compat.ensureWebSocket()` 又**无条件替换** `globalThis.WebSocket`。两者同时加载时**互相矛盾** |
| `tests/support/component-harness.mjs:18` | 相对 import 未命中 mock 表时**硬编码追加 `'.ts'`** → 一个过期的 `.tsx` mock key 变成 ENOENT，**中断整个进程而非失败一条断言**。这是 `9c17dbd` 的结构性根因，也是 `05` 报告 TEST-01 之所以是 Critical 的原因 |
| `tests/support/component-harness.mjs:54,58` | `nodes()` 在遍历中**调用函数型 children**，而 `render()` 结束后 `cursor` 非零 → 任何使用 hooks 的嵌套组件会读到父组件的 slot 数组，**hook 顺序被破坏** |
| `tests/support/hook-harness.mjs:15` | `while(dirty)` 渲染循环**无迭代上限** |

**影响**：测试工具链本身成为不确定性来源。`component-harness.mjs:18` 那条尤其关键——它把「一条断言失败」升级为「整条 103 段测试链中断」。

**建议修复**：统一两套解析器；`loadSource` 尝试 `['.ts','.tsx','/index.ts','/index.tsx']`；`fire()` 在文档化容忍度之外重新抛出；`send()` 匹配真实 `InvalidStateError` 语义；删除 `node20-sim.cjs` 或让它与 `ws-compat` 互斥；给 `hook-harness` 加迭代上限。
**修改风险**：中（10+ 个 spec 依赖这些 shim，改动会一次性暴露大量既有失败——但这正是收益）。
**验证方法**：全量链跑通；故意在某个 handler 内抛错，确认测试**失败**而非静默通过。
**本轮实施建议**：`component-harness.mjs:18` 的扩展名修复**建议优先实施**（它是 TEST-01 的直接放大器，且改动极小）。其余与 TEST-01 一起做。

---

## CQ-06 · butler 无界增长 · 严重度 Medium · 已确认

**位置**：`dsh-outpost-butler/lib/task-manager.js:69-80`、`lib/task-store.js:352-362`

**证据**：
- 构造函数中的 4 个 Map——`writeChains`、`eventChains`、`lastText`、`sessionToTask`——全仓 grep **无任何 `.delete` / `.clear`**。butler 是宿主进程内长期存活的插件，每个任务永久增加条目。
- `task-store.js:352-362` **每次 update 追加一份完整任务快照**，全文件无压缩逻辑；而**兄弟模块 `memory-store.js` 有**（`JOURNAL_COMPACT_AT=256` @ :5，`compact()` @ :257-267）。
- `receipts` Map（`task-manager.js:173`）同样从不裁剪。

**影响**：内存与日志文件增长 ∝ 生命周期内任务总数；重启回放越来越慢。这是典型的"跑一周才显现"的退化。

**建议修复**：在终态迁移时删除对应 Map 条目；把 `memory-store.js` 的压缩机制移植到 `task-store.js`。

**修改风险**：**中**。日志是权威数据源，压缩必须保留 receipt / generation 不变量（`task-store.js` 已有 generation fencing，改动需配合它）。

**验证方法**：新增长期运行测试——创建 N 个任务，断言压缩后日志大小与 Map 大小有界。

**本轮实施建议**：排期。需先补测试。

---

## CQ-07 · 桌面渲染进程读取后端从不发送的字段 · 严重度 Medium · 已确认

**位置**：`dsh-outpost-desktop/src/renderer/app.js:49`

**证据**：
```js
const tunnelRunning = Boolean(st.tunnelRunning ?? tunnelUrl);
```
`main.js` 与 `tunnel-service.mjs` **都不返回 `tunnelRunning`**（服务的 status handler 返回的是 `running`）。因此该表达式**永远回退到 `tunnelInfo.url`**，而后者在隧道进程死掉后可能是过期值。

同一文件另有两处质量问题：
- `:240-257` / `:259-268` 的 start/stop handler 用 try/**finally** 但**没有 catch** → IPC 拒绝变成 unhandled rejection，用户看不到任何反馈。
- `:328-330` `setInterval(…, 5000)` **从不清除**，窗口隐藏时仍在轮询。

**影响**：UI 显示"隧道运行中"而实际已崩溃；按钮点击静默失败。

**建议修复**：改用 `st.running`（或让 `main.js` 做映射）；补 catch + 状态行提示；`document.hidden` 时暂停轮询。
**修改风险**：低。**验证方法**：手动杀掉 cloudflared，面板应在 5s 内翻转为已停止；在 devtools 里让一个 IPC 拒绝，应看到提示。
**本轮实施建议**：建议排期优先（用户可见、改动小）。

---

## CQ-08 · `dsh-plugin-connect/client.js` 文件结构问题 · 严重度 Low · 已确认

- **2 887 行中 1-2318 行是内联的第三方 `qrcode-generator`**（Kazuhiko Arase, MIT），真实插件 UI 只有 2319-2887 行。文件头注释 `:12` 声称「不引第三方库，用纯函数生成」，与 :24-31 的内联来源说明**自相矛盾**。
- `serviceCall`（:2646-2650）与 `readLocalJson`（:2362-2373）的 `fetch` **无 timeout / AbortSignal**；而 `main.js:478` **有** signal——跨模块漂移。
- 未清除的定时器：`:2516-2519`（`setOpen(false); setTimeout(→setOpen(true), 60)`）、`:2679`（`setTimeout(onRefresh, 2500)`）。
- `index.js` 是空壳 `export function apply() {}`。
- 该模块**没有 `test` 脚本**，也**不出现在任何 workflow 中**（见 `05` 报告 TEST-18）。

**影响**：服务停顿时面板挂死；快速重挂载时定时器泄漏；来源注释误导后续维护者对许可证与升级路径的判断。

**建议修复**：修正头注释并注明 vendored 来源与版本；`fetch` 加 `AbortSignal.timeout`；保存 timer id 并在卸载时清除。
**修改风险**：低。**验证方法**：停掉 3199 服务，面板应在约 3s 内报错而非挂死。
**本轮实施建议**：排期。

---

## CQ-09 · 复杂度集中点（客观数据，非缺陷断言）

| 文件 | 行数 | 说明 |
|---|---|---|
| `dsh-mobile/src/core/store.ts` | 2 972 | 见 ARCH-01，≥12 项职责 |
| `dsh-plugin-connect/client.js` | 2 887 | 其中 2 295 行为 vendored QR，真实逻辑 592 行 |
| `dsh-mobile/src/App.tsx` | 1 686 | 见 ARCH-10 |
| `dsh-mobile/src/screens/ChatScreen.tsx` | 1 486 | 见 `04` 报告 PERF-01/PERF-06 |
| `dsh-mobile/src/core/approvalGateway.ts` | 1 146 | 第二套完整 WS 实现，见 ARCH-04 |
| `dsh-outpost-desktop/src/main/main.js` | 1 089 | Electron 主进程，见 `03` 报告 SEC-02 |
| `dsh-mobile/src/core/fold/index.ts` | 1 083 | **不得重构区**，见 `07` |
| `dsh-mobile/android/agent-core/…/CloudModel.kt` | 979 | 四个云模型协议适配器 |
| `dsh-mobile/android/…/install/RuntimeInstaller.java` | 939 | 安全评估为**优秀**，见 `03` 报告 §"正确的控制" |
| `dsh-outpost-butler/lib/task-manager.js` | 876 | 任务状态机，见 CQ-06 与 `03` 报告 BUG-09（cancel/execute 交错） |
| `dsh-mobile/android/…/background/BackgroundDisplayController.kt` | 825 | |
| `dsh-mobile/src/screens/LocalButlerScreen.tsx` | 801 | **死代码**，见 CQ-02 |

**注意**：行数本身不是缺陷。`fold/index.ts` 与 `RuntimeInstaller.java` 都是大文件但质量高，且前者被 `07` 列为不得重构区。真正需要拆分的是 `store.ts`（职责数）与 `App.tsx`（业务流程混入组合根）。

---

## 十、质量总评

**优点（有据）**：
1. **零 TODO/FIXME/HACK 堆积**，零注释掉的代码块（全仓 grep）。
2. **注释质量异常高**：关键不变量旁边几乎都有"踩过的坑"说明（如 `store.ts:1030-1033` 解释为什么不能用"有没有会话在跑"决定扫描、`fold/index.ts:399-400` 解释 callId 三拼写、`task-manager.js:695-701` 解释为什么 sessionId 补丁故意不带 status）。这类注释是防止回归的有效资产。
3. **原生模块访问收敛在 4 个文件**，`pendingSend/` 与 `butler*` 的拆分是真实分解而非碎片化。
4. **依赖注入到位**：`DshConnection` 注入 fetch/WS，`gateway-patch-gate.ps1` 可注入 CheckRunner，`component-harness` 可注入 mock 表。

**主要债务**：
1. **跨模块重复（CQ-01）已经产生真实缺陷**——4 组漂移，其中 2 组直接导致崩溃或安全缺口。这是最应该优先偿还的质量债，因为它**已经在付利息**。
2. **文档漂移（CQ-04）中有一条是危险的**：文档教的子协议名与代码里的显式警告相反。
3. **死代码（CQ-02）直接放大 CI 脆性**。
