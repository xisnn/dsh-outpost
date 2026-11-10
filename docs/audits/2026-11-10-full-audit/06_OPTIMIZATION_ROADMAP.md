# 06 · 优化路线图

审计基线：`E:\work\dsBot-opt` HEAD `2325d34`（分支 `opt/p1-phone-polish`，工作树干净）。
本轮**只审计、未修改任何业务代码**。本文档是**建议**，不是执行记录。

---

## 〇、排序原则

按宪章要求"优先推荐低风险、高收益且可独立验证的改动"，每一项用四个维度打分：

| 维度 | 说明 |
|---|---|
| **收益** | 修好之后减少多少真实风险 |
| **实施成本** | 改动行数 / 涉及模块数 |
| **修改风险** | 改坏的概率与后果 |
| **可验证性** | 能否**独立**证明改对了（不依赖其它项先完成） |

**排序规则：** 可验证性优先 → 风险低优先 → 收益高优先 → 成本低的先做。

**一条硬约束：** 存在一个**必须先做的项**，否则后面所有项的"验证"都不可信 —— 见 §1 的 P0-1（BUG-01 / TEST-01）。**在它修好之前，"测试是绿的"不能作为任何改动的回归依据。**

---

## 一、前 10 项（建议优先实施）

### P0-1 · 修好测试链，让回归信号可信

| 项 | 内容 |
|---|---|
| 编号 | **BUG-01 / TEST-01 / TEST-02**（合并实施） |
| 严重程度 | **Critical** |
| 位置 | `dsh-mobile/package.json:18`（103-spawn `&&` 链）；`dsh-mobile/tests/support/component-harness.mjs:17-18` |
| 收益 | **极高** —— 这是所有其它项的前置条件。当前 `tsc --noEmit` 是链条**最后一环**，任何测试失败都会导致类型检查根本不跑；`component-harness` 的 `.ts` 硬编码会让过期 mock **abort 进程**并带走整条链（提交 `9c17dbd` 的结构性成因） |
| 成本 | 中（改 runner + 修 4 行解析） |
| 风险 | **低** —— 只改测试基础设施，不碰业务代码 |
| 可验证性 | **强** —— 故意在一个 spec 里制造失败，断言：(a) 其余 spec 仍然运行完；(b) 退出码非零；(c) 失败清单包含全部失败项而不是只有第一个 |
| 具体动作 | 1. 把 `&&` 链换成**收集失败**的 runner（`node --test tests/**/*-spec.mjs` + `--test-concurrency`）<br>2. 修 `component-harness.mjs:18`，按 `.ts` / `.tsx` / `/index.ts` / `/index.tsx` 依次尝试<br>3. 把 6 个孤儿 script 接进来：`test:localRuntime`、`test:p4`、`test:p3`、`test:e2e`、`test:perf`、`test:filesave`（当前 CI 只到达 92/107 个 script、122/142 个 spec） |
| **前置条件** | **无**（它是别人的前置条件） |
| **注意事项** | 并行化会暴露 `globalThis` 共享状态问题（**TEST-04** 的三个 cookie jar、**TEST-11**）。**分两步**：先做"收集失败 + 顺序执行"，确认可信后再开并行 |
| 本轮实施 | ✅ **是 —— 第 1 优先** |

---

### P0-2 · 把 gateway 补丁门禁接到 `start-tunnel.ps1`

| 项 | 内容 |
|---|---|
| 编号 | **SEC-01** |
| 严重程度 | **High（安全）** |
| 位置 | `start-tunnel.ps1`（对补丁门禁的引用数 = **0**）vs `start-dsh-web.ps1`（引用数 = **4**）；DSH 启动点在 `start-tunnel.ps1:444-476` |
| 收益 | **高** —— `start-tunnel.ps1` 会启动 DSH 并把它**发布到公网 cloudflared URL**，却**完全跳过**了 `start-dsh-web.ps1` 那道"补丁未应用就拒绝启动"的门禁 |
| 成本 | **极低** —— dot-source 已有的 `scripts/gateway-patch-gate.ps1`，在两处 DSH 启动前各调一次 |
| 风险 | **极低** —— **复用已经测好的代码**（`mobile-gateway-patch-spec.mjs` 是真实的强测试：应用补丁 → `node --check` → 执行打过补丁的路由断言 fail-closed 503/401/403 → 断言拒绝未知版本） |
| 可验证性 | **强** —— 断言 `start-tunnel.ps1` 里 `gateway-patch-gate` 的引用数 ≥ 2；把插件换成未打补丁的版本，`start-tunnel.ps1` **必须拒绝启动** |
| **宪章合规** | ✅ 这是**收紧**，不是简化删除。宪章明确"涉及安全的代码不得直接提出简化删除方案"——本项**扩展**了现有安全控制的覆盖面 |
| 本轮实施 | ✅ **是 —— 第 2 优先** |

---

### P0-3 · 补 React 错误边界

| 项 | 内容 |
|---|---|
| 编号 | **BUG-04** |
| 严重程度 | **High** |
| 位置 | 全仓 **0 个** error boundary（`componentDidCatch` / `getDerivedStateFromError` grep 零命中） |
| 收益 | **高** —— 当前任何一处渲染期抛错都会白屏整个 App，用户唯一能做的是杀进程重进。而 fold 层处理的是**上游 wire 数据**，形状变化是常态（见 `docs/protocol-compat.md` 场景 B/D） |
| 成本 | 低 —— 纯**新增**一个 `ErrorBoundary` 组件 + 在 3~4 个导航层挂载 |
| 风险 | **极低** —— **纯增量，零功能改动**。不改任何现有代码路径 |
| 可验证性 | **强** —— 写一个故意抛错的组件挂进去，断言：显示降级 UI 而不是白屏，且 `store` 状态未被破坏 |
| 建议挂载点 | (1) NavHost 的每个 stack entry（隔离单屏崩溃）；(2) `ChatScreen` 的消息行（隔离单条消息的渲染崩溃——这与 fold 的容错设计互补）；(3) App 根（兜底） |
| 本轮实施 | ✅ **是 —— 第 3 优先** |

---

### P0-4 · 给三个 memory `@ReactMethod` 补 `supported()` 守卫

| 项 | 内容 |
|---|---|
| 编号 | **BUG-05** |
| 严重程度 | **High** |
| 位置 | `dsh-mobile/android/app/src/main/java/com/dshpocket/agent/AgentModule.kt:154-179`（`getMemory` / `saveMemory` / `deleteMemory`）；`supported()` 定义在 `:426`；`AgentMemoryStore.kt:7-9, 110, 115, 122` 用 `java.nio.file` |
| 收益 | **高** —— `java.nio.file` 是 **API 26+**，而 `minSdkVersion` 是 **24**。在 API 24/25 设备上会抛 `NoClassDefFoundError`（**Error，不是 Exception**），而 `catch (error: Exception)` **抓不到** → RN 桥接层崩溃 |
| 成本 | **极低 —— 3 行**（照抄同文件里其它方法的 `if (!supported()) { promise.reject("AGENT_UNSUPPORTED", ...); return }`） |
| 风险 | **极低** —— 同文件 `:426` 已有该模式，`dismissRecovery` 就在用 |
| 可验证性 | 中 —— 需要 API 24/25 设备或模拟器（**TEST-17** 说 CI 没有模拟器）。退一步：静态断言"所有触碰 `java.nio.file` 的 `@ReactMethod` 都有 `supported()` 守卫" |
| 本轮实施 | ✅ **是 —— 第 4 优先** |

---

### P0-5 · 校验 `pairing.port` 再插进 PowerShell 命令行

| 项 | 内容 |
|---|---|
| 编号 | **SEC-02** |
| 严重程度 | **High（安全）** |
| 位置 | `dsh-outpost-desktop/src/main/main.js:671, 691` |
| 收益 | **高** —— 未校验的 `pairing.port` 被**直接字符串插值**进 `powershell -Command`。`pairing` 来自配对响应，属于**外部输入** |
| 成本 | **极低 —— 1 个守卫**（`Number.isInteger(port) && port >= 1 && port <= 65535`，否则拒绝） |
| 风险 | **极低** —— 合法端口全部通过 |
| 可验证性 | **强** —— 单测：注入 `port = "3095; calc"`，断言命令未被执行/被拒绝 |
| **宪章合规** | ✅ 收紧，非简化 |
| 本轮实施 | ✅ **是 —— 第 5 优先** |

---

### P0-6 · 修 `start-tunnel.ps1` 的两处未定义符号

| 项 | 内容 |
|---|---|
| 编号 | **BUG-06** |
| 严重程度 | **High** |
| 位置 | `start-tunnel.ps1:439`（调用 `Write-Warn`，但文件里只定义了 `Write-Warn2` @ `:133`）；`:306-308`（读 `$dshLog`，但该分支定义的是 `$dshLog0` @ `:269`） |
| 收益 | **高** —— 第一处会在错误处理路径上**再抛一个 CommandNotFoundException**，把真正的错误信息吞掉；第二处让日志路径为空 |
| 成本 | **极低 —— 2 处改名** |
| 风险 | **极低** |
| 可验证性 | **强** —— 但**注意 TEST-16(b)**：现有 CI 只在 **pwsh 7 / Linux** 下验证 `.ps1`，而产品跑在 **PS 5.1 / Windows**。pwsh 7 对未定义函数的报错行为与 5.1 不同，所以**这个 bug 才能存在至今** |
| 本轮实施 | ✅ **是 —— 第 6 优先** |

---

### P0-7 · 让 CI 下的 `skip` 变成失败

| 项 | 内容 |
|---|---|
| 编号 | **TEST-03** |
| 严重程度 | **High** |
| 位置 | 若干 spec 的 `CANDIDATES` 列表缺 `dsh-mobile/node_modules/dsh-plugin-mobile-gateway`（而 CI 恰恰设了 `DSH_GATEWAY_PLUGIN_DIR` @ `android.yml:57`）；`skip > 0` 在 CI 下不影响退出码 |
| 收益 | **高** —— 当前这些 spec 在 CI 里**静默跳过**，报告仍是绿的 |
| 成本 | 低 |
| 风险 | 低 |
| 可验证性 | **强** —— 清空插件目录、设 `CI=1` 运行，**必须失败** |
| 现成的正确范例 | `gateway-startup-gate-spec.mjs:96-99` 已经做对了（CI 下失败，只本地跳过）——**照抄它** |
| 本轮实施 | ✅ **是 —— 第 7 优先** |

---

### P0-8 · 修 `call()` 的响应体阶段无超时

| 项 | 内容 |
|---|---|
| 编号 | **BUG-02** |
| 严重程度 | **High** |
| 位置 | `dsh-mobile/src/core/transport/index.ts:398`（在 `res.json()` @ `:440` **之前**就 `clearTimeout`）；对照 `request()` 用 `finally` @ `:536-538`（**正确写法就在同一个文件里**） |
| 收益 | **高** —— 服务器接受请求但**响应体永不完成**时，`call()` **永久挂起**。这正是 `transport/index.ts` 里那段注释描述过的历史事故类型（"界面一直转圈、连接状态卡在检测中"） |
| 成本 | 低 —— 把 `clearTimeout` 移进 `finally` |
| 风险 | **中** —— **有一个测试正在阻止这个修复**：`timeout-throttle-spec.mjs:72-77` 要求 `clearTimeout` 出现 **≥2 次**。移动之后计数会变 |
| 可验证性 | **强，但必须先写测试** |
| **实施顺序（重要）** | 1. **先**加"`call()` 响应体阶段超时"的测试，**确认它当前失败**<br>2. 再改代码<br>3. 同步放宽 `timeout-throttle-spec.mjs:72-77`——把"数 `clearTimeout` 出现次数"改成"断言每个 `setTimeout` 都有配对的清理路径"（后者才是真正想守的不变量） |
| **注意** | `timeout-throttle-spec.mjs` **整个文件是静态的**（`readFileSync` + 正则，从不 import 那个类）。它属于 `07_REGRESSION_PROTECTION.md` 的**不要删清单第 14 条**——它是若干 UI 层不变量的唯一守卫。**改它的断言方式，不要删它** |
| 本轮实施 | ✅ **是 —— 第 8 优先（测试先行）** |

---

### P0-9 · 修工具结果绑定缺口（三处）

| 项 | 内容 |
|---|---|
| 编号 | **BUG-03** |
| 严重程度 | **High** |
| 位置 | `dsh-mobile/src/core/fold/index.ts:469-471`（`tool/result` 的 id 提取**不对称**：只认 `message.toolCallId` \| `d.toolCallId`，而 `:402-406` 和 `:434-438` 认三种）；`:483`（`callId === ''` 时**静默丢弃**）；`:501-511`（`turn/end` **从不清 pending**）；`:904-914`（权威 override **从不遍历 blocks**） |
| 收益 | **高** —— 用户可见症状是"**永不停止的工具转圈**"，并且会通过 `toChatItems:650-654` **抑制完成卡片** |
| 成本 | 中 —— 4 处小改 |
| 风险 | **中 —— `fold/index.ts` 是重点保护区**（宪章明确列出"工具调用 ID 字段差异""重复工具调用块""pending 状态无法结束"三个历史修复） |
| 可验证性 | **强，但必须先写测试** |
| **实施顺序（重要）** | 1. **先**在 `tests/fold-spec.mjs` 加 3 个用例，**确认它们当前失败**：<br>&nbsp;&nbsp;(a) `tool/result` 用 `id`（而非 `toolCallId`）携带 callId → 当前会产生**两个**工具块<br>&nbsp;&nbsp;(b) `tool/result` 的 callId 为空串 → 当前**静默丢弃**<br>&nbsp;&nbsp;(c) `turn/end` 到达时仍有 `pending: true` 的块 → 当前**永久 pending**<br>2. 再改代码<br>3. 断言 `fold-spec.mjs:189-232` 的**现有**用例（真实捕获的 id `call_574864__tsk16___eK0ASYdfAikZ6ze`）**仍然通过** |
| **保护区约束** | ✅ 本项是**补齐 `e0216f9` 的对称性**，不是替换它。`fold-spec.mjs:189-232` 是真实测试（真 import、真 `foldEvents`、真 id），改前改后都必须绿。**不得**改动 `:265-274` 的 seq 去重或 `:396-499` 的合并逻辑主干 |
| 本轮实施 | ✅ **是 —— 第 9 优先（测试先行）** |

---

### P0-10 · 清死代码 + 修最危险的文档漂移

| 项 | 内容 |
|---|---|
| 编号 | **CQ-02 + CQ-04**（合并实施） |
| 严重程度 | **Medium** |
| 收益 | **中-高** —— 文档漂移会**直接导致错误的修复**（见下） |
| 成本 | 低 |
| 风险 | **低**（前提：只删已证明零引用的） |
| 可验证性 | **强** —— 删除后跑全链 + `tsc`；文档改动可人工核对代码 |

**最危险的一条漂移（我亲自核实过）：**

| 文件 | 说的是什么 | 代码实际是什么 |
|---|---|---|
| `docs/protocol-compat.md:42` | 子协议 `dsh-token.<token>` | ❌ |
| `docs/known-issues.md:11, 41` | 子协议 `dsh-token.<token>`，还给出了"正确做法"的建议 | ❌ |
| **实际代码** | **`dsh-auth.`** | ✅ |
| `core/approvalGateway.ts:546-548` | **有一段显式警告注释，说的正是相反的事** | ✅ |
| `docs/mobile-gateway.md:104`、`docs/security.md:151` | `dsh-auth.` | ✅ **正确** |

**危害**：`docs/known-issues.md` 把 `dsh-token.` 描述成**修复建议**。任何照文档去改 `approvalGateway.ts` 的人会**直接把重连改坏**，而且会认为自己在修 bug。

**其余 4 条建议同批改的漂移：**

| # | 文件 | 漂移 |
|---|---|---|
| 2 | `docs/configuration.md:20-23` | 说 dsh 查找顺序是 env→PATH→LOCALAPPDATA→ProgramFiles；实际 `start-dsh-web.ps1:149-162` 是 `$env:DSH_CLI` → `E:\DSH\...` → LOCALAPPDATA → ProgramFiles → **PATH 最后**（`Get-Command dsh`） |
| 3 | `docs/security.md:140` | 声称 token 日志不落盘；实际 `start-tunnel.ps1:269, 415, 469` 把含 token 的 DSH 日志写到 `%TEMP%`（关联 **SEC-05**） |
| 4-5 | 见 `02_CODE_QUALITY_FINDINGS.md` 的 CQ-04 18 行表 | |

**建议删除的死代码（均已证明零引用）：**

| 项 | 证据 |
|---|---|
| `screens/LocalButlerScreen.tsx`（801 行） | **ARCH-07** 零 importer |
| `butlerClient.ts:559` `createButlerClient` | **ARCH-08** |
| `butler.ts:148` `withModeTag`、`:169` `isModeSwitch` | **ARCH-08** |
| `store.ts:1407` `markApprovalDecided` | **CQ-02** —— **不可达**：`ChatItem` 的 assistant 变体没有 `approvals` 字段（审批挂在 `Turn` 上，`fold/index.ts:97`） |
| `jest.config.js` | **TEST-10** —— jest 不在任何 package.json、不在 node_modules |
| `tests/support/cookie-manager-stub.mjs`（88 行） | **TEST-11** 零引用 |
| `tests/support/local-runtime-app.js`（28 行） | **TEST-11** 零引用 |
| `scripts/release-gate.mjs` | **TEST-14** —— **⚠️ 不要删！** 应该**接进 CI**，不是删掉 |

**⚠️ 删除前的强制检查（宪章第 6 条：不允许根据文件名认定）：**
每一项都必须重新 grep 一次确认零引用，**并且**跑一遍全链 + `tsc --noEmit`。`scripts/release-gate.mjs` 属于"看起来死、实际应该复活"的类别，**不能删**。

| 本轮实施 | ✅ **是 —— 第 10 优先** |
|---|---|

---

## 二、第二梯队（建议排期，非本轮）

### 安全类（全部是**收紧**，无一项建议简化删除）

| 编号 | 严重 | 一句话 | 成本 | 风险 | 可验证性 |
|---|---|---|---|---|---|
| **SEC-04** | Medium | `credentialMigration.ts:629-637` 清 4 个键，`secureStore.ts:201-209` 清 5 个（多一个 `gatewayServerBinding`）→ 迁移后残留绑定 | 极低 | 低 | 强：断言两处清理的键集合**相等** |
| **SEC-05** | Medium | 含 token 的 DSH 日志写到 `%TEMP%`（`start-tunnel.ps1:269, 415, 469`）+ `:566` 裸 `catch {}`；`docs/security.md:140` 声称不落盘 | 低 | 低 | 中：需要检查 TEMP 文件的 ACL |
| **SEC-06** | Medium | `secureStore.ts:50-54, 150-162` 把 keychain 结果标成 `Promise<unknown>` 且**从不检查**；真实 API 是 `Promise<false \| Result>`（写入失败返回 `false`） | 低 | **中** —— 检查返回值后需要决定 `false` 怎么处理（重试？报错？），这是行为变更 | 强：shim 返回 `false`，断言产品代码不再当成功 |
| **SEC-03** | **待验证** | `xlsx ^0.18.5` 的已知漏洞 | —— | —— | **需要访问外部 advisory DB → 宪章第 9 条禁止自动访问外部服务，故本轮标记待验证，不编造结论** |

### Bug 类

| 编号 | 严重 | 一句话 | 前置 |
|---|---|---|---|
| **BUG-07** | Medium | `test-qr.mjs` 三处坏：`:13-14` 的锚点（`const QR_CAPACITY_L`、`/** 把矩阵画成 SVG path`）在 `client.js` 里 grep **命中 0** → `slice(-1,-1) === ''`；`:44` 有 `\|\| true`；`:71` `m2[6][i] !== i % 2 === 0` **优先级 bug** | 无 |
| **BUG-11** | Medium | setup-gateway 的 EAP=Stop + 原生 stderr 混用 | 无 |
| **BUG-13 / BUG-14** | Medium | 补丁门禁静默跳过 + `DSH_HOME` 未贯穿 | 与 **P0-2** 同批 |
| **BUG-17** | Low | `scripts/android-chatscreen-nav.ps1:41` `$home = Get-Ui ...` **给只读自动变量赋值** | 无 |
| **BUG-10** | Medium | `AgentService` 没有 `onTimeout`；**正确范例就在同项目里** —— `DshRuntimeService.java:88-89` 两个 override 都有。**照抄它，不要重新设计** | 无 |
| **BUG-15** | Low-Med | `tunnel-service.mjs` 没有 `server.on('error')`；start 缺少 repair 里已有的去重（`:511-514`） | 无 |
| **BUG-16** | Low-Med | 桌面端 `ensureService` 双 spawn；`main.js:462` 的 `serviceProc.on('exit', () => { serviceProc = null; })` **不辨身份** | 无 |
| **BUG-18a–j** | Low | 10 项低危，见 `03` | 无 |

### 测试类

| 编号 | 严重 | 一句话 | 成本 | 备注 |
|---|---|---|---|---|
| **TEST-17(1)** | **Medium-High** | **CI 加一行 `./gradlew :agent-core:test`** → **38 个已经写好的 JVM 测试立刻生效**（`AgentLoopTest` 14、`CloudModelClientTest` 13、`FileRunStoreTest` 7、`RunRecoveryTest` 4） | **极低** | **本次审计里收益/成本比最高的单项** |
| **TEST-06** | High | 给 butler 沙箱边界 `workspace-fs.js`（81 行，含 `inside()` / `verifyRoot()` / `fresh()` TOCTOU 重解析 / 符号链接拒绝）补测试 | 低 | 判据：把 `fresh()` 换成缓存版本，测试**必须失败** |
| **TEST-16(1)** | Medium | 给 `android.yml` 所有 job 加 `timeout-minutes`（当前只有 `signing-verify.yml:54` 设了 45） | 极低 | |
| **TEST-16(2)** | Medium-High | 加一条 `windows-latest` leg，用 **`powershell.exe`(5.1)** 校验每个 `.ps1` | 中 | **BUG-06 之所以存在，正是因为这个盲区** |
| **TEST-14(1)** | High | CI 在集成测试**之前**跑 `apply.mjs --apply` 并校验 `state.json` | 低 | 当前 CI 跑的是**未打补丁**的 gateway |
| **TEST-14(3)** | High | `build-signed-apk.ps1:150, 308` 在 `apksigner` 缺失时从 `Write-Warn2` 改为 **fail-closed** | 低 | 保留显式的 `-AllowUnsignedLocal`，不要静默降级 |
| **TEST-13** | Medium-High | 显式声明 AGP 版本（当前 `android/build.gradle:15` 无版本 → 传递解析到 8.11.0）；加 `distributionSha256Sum`；缺 `DSH_VERSION_CODE` 时让 Gradle **失败**（当前默认 `'1'`/`'1.0'`，而 `build-signed-apk.ps1:66` 默认 `916204` → **三个真值来源**） | 低-中 | |
| **TEST-15(1)** | Medium | 加一个 CI 步骤跑 `node --test --experimental-test-coverage` 并公布数字 | 低 | **唯一能量化"缺口地图"的手段** |
| **TEST-04** | Medium-High | 三个 cookie jar 合并成一个（用 AsyncStorage 已经做对的 `globalThis.__dshTestAsyncStorageState__` 模式，`_async-storage-shim.cjs:19-26`）；`clearByName` 参数个数改对 | 中 | **是 TEST-09 并行化的前置条件** |
| **TEST-07** | Medium | Windows 路径语义：显式用 `path.win32.isAbsolute` 测，或加 `windows-latest` leg | 低 | 产品是 Windows 宿主，但 `C:\…` / `\\server\share` 的接受性**无处验证** |

### 质量类

| 编号 | 严重 | 一句话 |
|---|---|---|
| **CQ-01a** | Medium-High | **LAN-IP 正则重复 4 份且已经漂移**：`main.js:563` 那份**缺 `Wireless`** 网卡名 → 在只有无线网卡机器上取不到 LAN IP。这是"重复代码已经造成真实 bug"的确证案例 |
| **CQ-01b** | Medium | **日志 helper 重复 6 份且已经漂移成一个崩溃**（关联 **BUG-06**） |
| **CQ-01c** | Medium | **EAP 守卫：2 处正确 / 3 处缺失** |
| **CQ-01d** | Medium | **profile 路径：5 处硬编码 vs 3 处 DSH_HOME-aware**（关联 **BUG-14**）；`doctor.ps1:156` 尊重 DSH_HOME 但 `:178` 硬编码 |
| **CQ-01e** | Low-Med | 其余 8 组：token 脱敏正则 ×2、schtasks-bat ×3、ACL ×3+1 缺口、dsh-exe 候选 ×4+1 死、`canConnect`↔`probePort`、BOM JSON reader ×3、token 正则 ×2、QR ×2、端口字面量（含 `client.js:2644` 硬编码 3199） |
| **CQ-07** | Medium | `renderer/app.js:49` 读一个**不存在**的 `st.tunnelRunning` → 桌面端隧道状态永远显示错误 |
| **CQ-06** | Medium | butler 无界增长：`task-manager.js:69-80` 的 **4 个 Map 从不删除**；`task-store.js:352-362` 每次更新写全量快照且**无压缩**——而**兄弟模块 `memory-store.js` 有 `JOURNAL_COMPACT_AT = 256`**（现成范例） |

### 性能类（**必须先有真机数据**，见 `04` 第九节）

| 编号 | 严重 | 证据强度 | 备注 |
|---|---|---|---|
| **PERF-03** | Medium | 行为**已确认** | 5 秒通知扫描无 AppState 门控（`store.ts:987-994`），而同库 `useChatMetaPolling.ts:33-40` 和 `HostQueuePanel.tsx:56-61` **都做了**门控 → 这是遗漏不是设计。**低风险高收益，可独立验证** |
| **PERF-06** | Low-Med | 机制**已确认** | `ChatScreen.tsx:747` 每次渲染新建 approvals 数组，击穿 `ApprovalBanner.tsx:97-112` 的 memo。全部是等价改写 |
| **PERF-04(2)** | Medium | 静态怀疑 | `markdown.ts:205` 的 `text += src[i]` 改 `push` + `join` —— **零风险等价改写，可以先做** |
| **PERF-05(1)** | Medium | 机制**已确认** | `AgentService.kt:42-63`（700ms）+ `AgentOverlayController.kt:49-53`（500ms）都在主线程触发带锁文件读。**方案 1（终态时降频）零风险** |
| **PERF-01** | Medium | 次数已测量 / 代价静态怀疑 | **不建议本轮** —— 需要真机 Profiler 基线 |
| **PERF-02(b)** | Low-Med | 静态怀疑 | **本轮不要动 fold 缓存** —— 提交 `c8e9924` 存在的唯一理由就是同 seq 更新与中途回填必须让快路径失效。**必须先把 `streaming-perf-f03-spec.mjs` 的边界 2A/2B（`:655-724`）扩到 ≥5000 事件** |
| **PERF-02(a)** | Low-Med | 静态怀疑 | `reconcilePendingNow` 记忆化 —— **低风险，可以做**，不触碰 fold 语义 |

---

## 三、必须先补测试才能动的项

**这些项的代码可能确实有问题，但当前的测试网不足以安全地修改它们。**

| 编号 | 严重 | 为什么不能直接改 | 先补什么测试 |
|---|---|---|---|
| **BUG-08** | Medium | `store.ts:2911-2926` 的 `closeChat` 从 `streams` 删但不从 `chats` 删。可能是有意的缓存保留，也可能是遗漏 | 断言关闭会话后 `chats` 的预期状态；确认内存是否随开关次数增长 |
| **BUG-09** | Medium | butler 的 cancel/execute 竞态（`goalId` 变体）。**注意 `finishLane:812` 提供了部分缓解**；提交 `2325d34` 修的是**兄弟 `sessionId` 变体**（注释在 `task-manager.js:695-701`），**没修 `goalId`** | 需要一个能确定性重现交错的测试；但ler 现有测试（2,337 行）对竞态覆盖已经很深，应该在同样的框架里加 |
| **BUG-12** | Medium | `PhoneTools.kt:207-216, 268-277` 的 tap/scroll **不绑定到已批准的快照**。这是安全相关（审批权威链，见 `07` 第 3 条），**不能简化** | 需要 androidTest 或 JVM 层可测的抽象——**当前 `android/app` 覆盖率为零（TEST-17）** |
| **CQ-06** | Medium | butler 无界增长。压缩逻辑写错会**丢任务历史** | 先加"压缩后重放等价"的测试（照抄 `memory-store.js` 的 `JOURNAL_COMPACT_AT` 已有测试） |
| **PERF-02(b)** | Low-Med | fold 缓存失效是 **P0 级正确性防线** | `streaming-perf-f03-spec.mjs` 边界 2A/2B 扩到 ≥5000 事件 |
| **ARCH-01** | Medium | `Store` 是 god object（`store.ts:351`，≥12 项职责，17 个 UI 文件消费 40+ 成员）。拆分需要**同时**改动 17 个消费方 | 需要 UI 层测试（**TEST-12：34 个 `.tsx` 从不渲染**）——**当前无法安全拆分** |
| **ARCH-02** | Medium | 三个 agent 后端无共享接缝。**例外**：类型合并子项（`localDsh.ts:3-31` ↔ `localRuntime.ts:15-52` **逐字节相同**）可以独立做 | 类型合并只需 `tsc` 验证；接缝抽取需要先有 agent 层的契约测试 |

---

## 四、需要先验证再决定的项

| 编号 | 待验证什么 | 为什么本轮没验证 |
|---|---|---|
| **ARCH-06** | `index.js:14-17` 的 `__DEV__` require（`P0Harness`）是否**真的进了 release bundle** | Metro 不做 tree-shaking，所以**静态怀疑是它进了包**；但确认需要**构建一个 release bundle 并 grep**——本轮不执行构建 |
| **SEC-03** | `xlsx ^0.18.5` 是否有已知漏洞 | **需要访问外部 advisory DB**，宪章第 9 条禁止自动访问外部服务 |
| **TEST-08** | `ubuntu-latest` 是否仍自带 JDK + Android SDK，使 `release-signing-gates-spec.mjs` 的 5 个 Gradle dry-run **真的运行**而非 fail-open | 需要访问 CI 运行日志（无网络）或执行 gradlew（本轮不执行） |
| **TEST-13 的兼容矩阵** | AGP 8.11.0 + Gradle 8.14.3 + Kotlin 2.1.20 + JDK 21 是否互相支持 | 需要访问外部版本兼容表 |

---

## 五、分阶段、可回滚的实施建议

### 阶段 0 · 让信号可信（**必须最先做，其它阶段的前置**）

| 内容 | 项 |
|---|---|
| 范围 | **P0-1**（测试链 + harness 解析 + 6 个孤儿 script）、**P0-7**（CI 下 skip 变失败）、**TEST-17(1)**（加 `:agent-core:test`）、**TEST-16(1)**（加 `timeout-minutes`）、**TEST-14(1)**（CI 打 gateway 补丁） |
| 触碰业务代码 | **否** —— 全部是测试/CI 基础设施 |
| 回滚方式 | 单个 commit，`git revert` 即可 |
| 完成判据 | (1) 故意制造 2 个失败，报告里**两个都在**；(2) `tsc --noEmit` 无论测试成败都跑；(3) CI 日志里能看到 38 个 agent-core 测试结果；(4) CI 日志里能看到补丁被应用 |
| 预期收益 | **首次获得可信的回归信号** + 38 个已有原生测试生效 |

### 阶段 1 · 零风险/极低风险的确定性修复

| 内容 | 项 |
|---|---|
| 范围 | **P0-3**（error boundary，纯增量）、**P0-4**（3 行 `supported()` 守卫）、**P0-5**（端口整数校验）、**P0-6**（2 处改名）、**SEC-04**（键集合对齐）、**BUG-17**、**CQ-07**、**PERF-04(2)**（`push`+`join`）、**PERF-05(1)**（终态降频） |
| 触碰业务代码 | 是，但**每处 ≤5 行**且互相独立 |
| 回滚方式 | **每项一个 commit**，可单独 revert |
| 完成判据 | 每项都有独立的可执行验证（见各自条目） |

### 阶段 2 · 安全收紧（**全部是扩展覆盖面，无一项简化删除**）

| 内容 | 项 |
|---|---|
| 范围 | **P0-2**（`start-tunnel.ps1` 接补丁门禁）、**TEST-14(3)**（`apksigner` 缺失 fail-closed）、**SEC-05**（TEMP 日志 ACL，**扩展** `Protect-StateFile` 的覆盖面）、**TEST-13**（AGP 显式版本 + `distributionSha256Sum` + 缺 `DSH_VERSION_CODE` 时失败） |
| 触碰业务代码 | 是（脚本 + gradle） |
| 回滚方式 | 每项一个 commit |
| **⚠️ 特别注意** | `start-tunnel.ps1` 与 `build-signed-apk.ps1` 都在 `07_REGRESSION_PROTECTION.md` 的"不要动"清单里——**但那里的含义是"不要简化/删除其中的安全逻辑"，不是"不要扩展覆盖"**。本阶段全部是扩展 |
| 完成判据 | 负向测试：未打补丁 → 拒绝启动；无 `apksigner` → 失败；缺版本参数 → Gradle 失败 |

### 阶段 3 · 测试先行的行为修复

| 内容 | 项 |
|---|---|
| 范围 | **P0-8**（`call()` 体阶段超时）、**P0-9**（fold 工具结果绑定） |
| 顺序 | **严格测试先行**：先加测试 → **确认失败** → 再改代码 → 确认通过 |
| 触碰保护区 | **是**（`transport/index.ts`、`fold/index.ts`） |
| 回滚方式 | 测试与修复分成两个 commit；修复 commit 可单独 revert 而测试保留（此时测试变红，正确地指出问题回来了） |
| 完成判据 | (1) 新测试在修复前**红**、修复后**绿**；(2) `fold-spec.mjs:189-232`、`ws-disconnect-spec.mjs`、`ws-reconnect-session-recovery-spec.mjs`、`pending-send-send-flow-spec.mjs` **全部仍绿** |

### 阶段 4 · 补测试（不改业务代码）

| 内容 | 项 |
|---|---|
| 范围 | **TEST-06**（butler 沙箱边界）、**TEST-04**（cookie jar 合并）、**TEST-15(1)**（覆盖率数字）、**TEST-07**（win32 路径）、**TEST-16(2)**（PS 5.1 leg）、**PERF-02 的 5000 事件等价性测试**、`04` 第九节的 6 项真机测量 |
| 触碰业务代码 | **否**（TEST-04 只改测试支撑件） |
| 回滚方式 | 纯新增 |
| 完成判据 | 每个新测试都能通过"故意改坏产品代码 → 测试必须失败"的验证 |

### 阶段 5 · 质量收敛（依赖阶段 0/4 的信号）

| 内容 | 项 |
|---|---|
| 范围 | **P0-10**（死代码 + 文档漂移）、**CQ-01a–e**（重复代码收敛，**优先已漂移的 4 组**）、**CQ-06**（butler 无界增长）、**PERF-03**、**PERF-06**、**PERF-02(a)**、**BUG-10**、**BUG-15**、**BUG-16**、**SEC-06** |
| 触碰业务代码 | 是 |
| 回滚方式 | 每组重复代码一个 commit |
| **⚠️ CQ-01 的约束** | 宪章第 4 条"不为了减少代码行数而牺牲可读性、稳定性或扩展性"。**只收敛已经漂移的 4 组**（LAN-IP 正则、日志 helper、EAP 守卫、profile 路径）——它们已经造成真实 bug。**其余 9 组重复暂不动**：三份相似的代码好过一个过早的抽象 |

### 阶段 6 · 架构演进（**本轮明确不建议启动**）

| 内容 | 项 | 阻塞条件 |
|---|---|---|
| `Store` 拆分 | **ARCH-01** | 被 **TEST-12**（34 个 `.tsx` 从不渲染）阻塞——17 个消费方无法安全改动 |
| 多 Agent 后端接缝 | **ARCH-02** | **例外**：`localDsh.ts:3-31` ↔ `localRuntime.ts:15-52` 的**逐字节相同类型**可以在阶段 5 合并（只需 `tsc` 验证）。真正的接缝抽取需要先有 agent 层契约测试 |
| wire 形状收回 transport 层 | **ARCH-03** | 涉及 10+ 个 UI 文件的 import 改动，同样被 TEST-12 阻塞 |
| 四条凭据 HTTP 路径收进 `DshConnection` | **ARCH-04** | **安全相关**（`07` 的不可简化清单第 1 条）。必须先给 `net-security.ts` 补真实执行测试（当前是 TEXT-ONLY，182 行） |
| `App.tsx` 拆分组合根与业务流 | **ARCH-10** | 被 TEST-12 阻塞 |

---

## 六、明确**不应该**现在重构的模块

> 详细理由与"唯一现存守卫"见 `07_REGRESSION_PROTECTION.md`。此处是决策清单。

### 通信与任务执行（宪章指定的重点保护区）

| 模块 | 位置 | 为什么不能动 |
|---|---|---|
| `foldEvents` 的 seq 去重与工具调用合并 | `core/fold/index.ts:265-274, 396-499` | 提交 `e0216f9` 的产物；重复工具卡片与永久 pending 的防线 |
| `foldEventsIncremental` 缓存失效 | `core/fold/index.ts:946-993` | 提交 `c8e9924` 的产物；同 seq 更新与中途回填必须失效，否则界面静默显示过期内容 |
| `ensureSocket` / `openWebSocket` / `loginWithToken` | `core/transport/index.ts:542-684, 698-716, 225-293` | Android OkHttp 通过 `close` 而非 `error` 暴露握手 401/403；WS 构造的第 3 个参数是 cookie 的唯一通道；303 重定向使状态码不可信 |
| `connectChatStream` / `backfillReconnectGap` / `pump` / `upsertStreamRecord` | `core/store.ts:1969-2320` | generation + identity 守卫 + seq-keyed Map 是 P0-2 无重复/无缺口的**全部**保证 |
| `handleStreamDisconnect` | `core/store.ts:2134-2218` | 抖动退避、RN 探针、定时器复检——去掉任何一个都会复活一个已修 bug |
| `transitionPendingSend` | `core/pendingSend/state.ts:120-240` | `from === 'confirmed'` 的 no-op 是让"WS confirm 胜过 HTTP accept"竞态安全的**唯一**机制 |
| `runPendingSend` | `core/store.ts:2722-2862` | `begin-send` 在 prompt **之前**（`:2794`）是崩溃时留下 `sending`（→重启变 `unknown`）而不是静默重复的原因；catch 里**不能**加自动重试 |
| `PendingSendStore.save` / `runExclusive` / `retry` | `core/pendingSend/store.ts:281-309, 251-259, 590-613` | 写→读回→逐字节比对；`retry` 是**唯一**被授权的 requestId 复用点 |
| `reconcilePendingNow` | `core/store.ts:2868-2908` | "只做 confirm，不改状态、不重发"是服务端证据永不导致重发的保证 |
| `extractAuthoritativeRunning` / `applyAuthoritativeRunningOverride` | `core/fold/index.ts:154-181, 904-914` | 重连错过 `turn/end` 后残留"进行中"的唯一防线 |
| **静态正则型 spec** | `timeout-throttle-spec.mjs` 全文；`send-idempotency-spec.mjs:135-148, 193-231, 237-249`；`send-retry-spec.mjs:237-254`；`fold-spec.mjs:339-345`；`revocation-unknown-spec.mjs:522-556` | 它们是若干 UI 层不变量的**唯一**守卫。**当作"不是真测试"删掉，等于删覆盖而不补覆盖**。（P0-8 是**改断言方式**，不是删） |

### Android 原生（六个历史修复已在 HEAD 验证完整）

| 模块 | 为什么不能动 |
|---|---|
| `RuntimeInstaller.java` + `RuntimeManifest.java` | inventory-pinned 解包、archive SHA-256、USTAR-only（禁 hardlink/device/PAX）、`O_NOFOLLOW\|O_EXCL\|O_CLOEXEC`、payload chmod 0555、`(mode & 0022)==0`、file+dir fsync、`installer.lock` FileLock、崩溃检查点语义；约 40 项失败注入检查支撑（虽然它们从不自动运行——见 TEST-17） |
| `RuntimeSupervisor` / `RuntimeWire` / `RuntimeJournal` | 逐帧 `submit(…).get()` 背压、1.5s/4s/7s/10s 分级 kill + uid 校验的进程组信号、HMAC wire（sequence + generation）、读回校验的原子 journal + 有界环 |
| `DshRuntimeService.java` | **这是正确的 FGS 范例**：3 参 `startForeground` + `FOREGROUND_SERVICE_TYPE_DATA_SYNC`、带 15 分钟超时的 WakeLock 且在 `finish():87` 与 `onDestroy:90` 都释放、**两个** `onTimeout` override、null-intent → `interrupt("user-stop")`。**BUG-10 的正确修法是把这个模式抄进 `AgentService`，不是重新设计** |
| `FileRunStore` / `RunRecovery` / `AgentLoop` 的裁剪 | 提交 `2a27192`：temp+fsync+`ATOMIC_MOVE`（含回退）、损坏→FAILED+`requiresReconciliation`、逐 run `runCatching`、16,000 字符裁剪 + 只留最近 4 条工具结果、审批从不恢复、prune 把终态 run 上限压到 60 |
| `AgentSettingsStore` | 提交 `9cef57e`：Keystore AES/GCM 包裹、endpoint-identity 密钥失效、`clear()` 同时清 prefs 与 alias、**密钥从不跨桥**（JS 只拿到 `hasKey`） |
| `CloudModel.kt` / `Http.kt` | connect 15s / read 120s、**禁用重定向**（`:45`，所以 `Authorization` 永不跨 host 重放）、**任何地方都没有重试逻辑**（→ 不会有重复的非幂等 POST）、API key 脱敏、HTTPS-or-loopback 强制、畸形 SSE → protocol-error Failure（永不是空 success）、UUID 合成 call id |
| `ShareInbox` | 有界 executor + AbortPolicy、size/deadline 双界拷贝、原子记录、`.use` 游标、`hasActiveReactInstance` 守卫 |
| `BackgroundDisplayController` 帧路径 | 锁内身份校验的 bitmap 回收、监听器移除、`frameThread.quitSafely()` |
| 无障碍 fail-closed 链 | `rootFor` 捕 `Throwable`→null；`keyOutput` **只**对 `ACCESSIBILITY_NO_ACTIVE_WINDOW` 回退到空屏（提交 `9727238`）；`type()` 中途复检包名并以 `SCREEN_CHANGED_DURING_TYPE` 中止（提交 `9028d26`） |

### 主机侧脚本与服务

| 模块 | 为什么不能动 |
|---|---|
| `workspace-fs.js` | `fresh()` 的**每次重解析**是防祖先符号链接交换 TOCTOU 的关键；缓存解析结果会重新打开它（设计注释里明确写了）。同样，"持久化队列不是授权"规则（`task-manager.js:89-94`）不能简化 |
| `patches/mobile-gateway-mgmt-auth/`（`patch.mjs` / `apply.mjs`） | 锚点唯一性 + SHA-256 白名单 + fail-closed 503 + 幂等；版本不符时 `--apply` **拒绝** |
| `scripts/gateway-patch-gate.ps1` | 唯一阻止未打补丁 gateway 启动的门禁（P0-2 是**扩展**它到 `start-tunnel.ps1`） |
| `scripts/butler-installer.ps1` | 严格 YAML 校验 + 字节级回滚 |
| `build-signed-apk.ps1`（仓库根）的密钥卫生 | SecureString、凭据只走环境变量、`finally` 清理（`:249-263`）。（TEST-14(3) 只改 `apksigner` 缺失时的 fail-open） |
| `tunnel-service.mjs` 的姿态 | loopback-only 绑定（`:528`）+ Origin 白名单 403-before-action（`:454-458`）+ token 剥离（`:312-326`）。**"无 Origin 时放行"之所以安全，完全依赖 loopback 绑定——这两者永远不能拆开** |
| `net-security.ts` 的私网限定明文策略 | `network_security_config.xml` 在 OS 层设了 `cleartextTrafficPermitted="true"`（LAN 必需，且 Android 配置无法表达 CIDR，见 `docs/known-issues.md` §3），使这个应用层门禁成为**唯一**的明文边界。**只能加强（枚举网络原语的静态 spec），绝不放宽私网检查** |
| 多状态 fail-closed 结果联合类型 | migration 7 态、cookie 4 类、binding 5 类、revocation 3 态。**塌缩成 boolean 会重新引入"unknown 被当作干净"**。`deviceRevocation.ts:30-36` 明确记录了为什么 `unknown` 永不意味着"未吊销"（等不到 4003 来纠正） |
| 审批权威链 | 单一 `ActionExecutor` 收口（`Tools.kt:55-108`）、`decide(callId, digest)` 绑定 → `STALE_APPROVAL`（`AgentRuntime.kt:396-422`）、首个决定胜出、无限等待默认 `REJECT`（`:622-632`）、`unconfirmed` 提交锁（`approvalDock.ts:375-380, 520-529`）。**每一环都堵一个独立的静默 fail-open** |
| `loginWithToken` 前清 cookie jar | `transport/index.ts:236-244`。去掉这个顺序会复活"任何 token 都能通过"的陈旧 cookie 绕过 |
| 凭据写入/删除后的读回校验 | `secureStore`、`credentialMigration`、`serverIdentity`、`loginIntent`。它把静默的存储失败变成可发现的状态 |
| token 文件 ACL 纪律 | `Protect-StateFile`、`start-dsh-web.ps1:383-412`。**SEC-05 是把它扩展到 TEMP 日志，不是在任何地方删掉它** |
| `requestId` 复用（重试时） | `store.ts:2490-2493`、`fingerprint.ts`。`unknown` 的重试安全性**完全**依赖复用同一 requestId 让服务端去重；换新 id 会把每次模糊重试变成重复执行。`canUserRetry` 把 `unknown` 算作可重试，**只在这个不变量下才安全** |

### 其它已核查干净、不需要动的

`dsh-outpost-butler/index.js`（114 行：memory 域失败隔离 @ `:49-59`、有序释放 @ `:95-110`）、`lib/commands.js`、`lib/local-approvals.js`、`lib/memory-store.js`（有 journal 压缩）、`lib/domain.js`/`contracts.js`/`deliverables.js`；`preload.js`；`setup-butler.ps1`；`pack.js` 的 ZIP 结构；`cordis.patch.yml` / `locale/*.json`；`core/attachment-cache.ts`（有界 LRU）；所有 `04` 第八节列出的有界 map 与配对清理的监听器。

**文档已核实准确（无漂移，不需要改）：** `butler-tasks.md`（TaskApi 表 / health payload / Idempotency-Key vs `task-api.js:111-113, 136-141`、`task-store.js:6`）、`runtime-compat.md`、`release-verification.md`（vs `android.yml:393-437`）、`mobile-gateway.md` 的协议帧（vs 已安装插件）、acceptance-guide 的证书指纹（vs `build-signed-apk.ps1:77, 80`）、`CONTRIBUTING.md`、`SECURITY.md`。

---

## 七、是否适合开展较大范围重构

**明确结论：现在不适合。**

理由（按重要性排序）：

1. **回归信号当前不可信**（BUG-01 / TEST-01 / TEST-02 / TEST-03）。在"第一个失败即中断、`tsc` 是最后一环、过期 mock 会 abort 进程、CI 下 skip 静默通过"的条件下，**任何重构都无法被验证**。这必须最先解决。

2. **UI 层完全没有测试**（TEST-12：34 个 `.tsx` 从不渲染；`useEffect` 是空函数）。而最大的架构问题 **ARCH-01**（`Store` god object）需要**同时**改动 17 个 UI 消费方。**没有 UI 测试就拆 Store，等于闭眼开车。**

3. **通信核心是重点保护区且守卫单薄**。`ws-reconnect-session-recovery-spec.mjs` 是"断线重连不重复历史"的**唯一**守卫文件；`connectChatStream` / `backfillReconnectGap` / `pump` / `upsertStreamRecord` / `handleStreamDisconnect` 全押在它一个文件上。重构前必须先把这层测试加厚。

4. **原生侧 `android/app` 覆盖率为零**（TEST-17）。而 `AgentModule` / `AgentRuntime` / `PhoneTools` / `OutpostAccessibilityService` / `BackgroundDisplayController` 是审批权威链与设备控制链的载体——**安全相关且不可简化**。

5. **没有覆盖率度量**（TEST-15），所以"重构后覆盖率没降"这个基本判据**当前无法计算**。

**但有一个重要例外：**

代码的**卫生状况极好**——全仓 **零** TODO / FIXME / HACK / deprecated 标记，**零**注释掉的代码。这说明债务是**结构性**的（模块边界、重复实现、验证层缺失），不是**腐烂性**的。结构性债务**可以**分阶段偿还，而且阶段 0~2 完全不需要重构。

**因此推荐的路线是：**

> **阶段 0（让信号可信）→ 阶段 1~2（零风险修复 + 安全收紧）→ 阶段 4（补测试）→ 阶段 5（质量收敛）→ 只有在阶段 4 完成、UI 层有了真实渲染测试之后，才重新评估阶段 6 的架构重构。**

**换句话说：先花力气把"能不能安全地改"这个问题解决，再谈"要不要改结构"。**

---

*本文档由只读审计产生，未修改任何业务代码。所有引用位置均来自本轮真实读取的代码；标注为"待验证"的项已说明未能验证的原因。*
