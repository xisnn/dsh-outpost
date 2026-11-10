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

> **⚠️ 第二方复核修订（2026-11-11）**：本路线图经第二方复核，**整体方向认可**，5 项意见**全部采纳**（逐条记录见 `08_EXECUTIVE_SUMMARY.md` §〇）。对本节的直接影响：
>
> | 变化 | 内容 |
> |---|---|
> | **优先级重排** | **P0-7（TEST-03，静默 skip）升为第 1 优先 + Critical** —— 它是**唯一真正的假绿通道**，已实测复现。P0-1 降为 High（`&&` 链**不产生假绿**，危害是诊断不完整） |
> | **P0-1 方案重写** | 撤回 `node --test tests/**/*-spec.mjs` glob 方案，改为**从 `package.json` 传递展开 + `spawnSync` 原样执行**的聚合器（Node 20 兼容、保留 tsx/node/npm-script 语义） |
> | **P0-2 加硬约束** | 公网路径**显式 `-Skip:$false`**、不新增 skip 参数、`Write-GatewayPatchRefusal -Public` 不广告旁路 |
> | **P0-3 移出本轮** | 风险 极低 → **中**，可验证性 强 → **弱**；前置条件是先具备真实渲染测试能力 |
> | **P0-9 语义收紧** | `turn/end` 清 `pending` 时**必须同时设 `isError = true`**，否则"结果未达"会被渲染成"完成"；新增负向用例 (d) 断言不产生重发 |
>
> **本轮实际获授权实施的只有 4 项**（其余 6 项 P0 一律 ❌，各项的"本轮实施"栏已逐条标注）：
>
> | 序 | 授权范围 | 对应条目 |
> |---|---|---|
> | 1 | 核实并修复 SEC-01 公网启动门禁缺口 | **P0-2** |
> | 2 | 建立 Node 20 兼容、能收集全部失败的测试聚合机制 | **P0-1** |
> | 3 | 修复 CI 中关键测试静默 skip | **P0-7** |
> | 4 | 接入已有 Android JVM 测试并验证 CI 可执行 | **TEST-17(1)**（见 §二） |
>
> **本轮硬约束**：不改动 fold / pendingSend / stream 核心业务逻辑；不新增功能；不做架构重构；不触碰正式签名材料；不自动发布版本；每个修复独立提交、可单独回滚；改动前先建立失败复现或负向测试；无法验证的结果标记待验证。

### P0-1 · 修好测试链，让失败诊断完整

| 项 | 内容 |
|---|---|
| 编号 | **BUG-01 / TEST-01 / TEST-02**（合并实施） |
| 严重程度 | **High**（↓ 原 Critical，按复核意见 1 下调 —— `&&` 链**不产生假绿**，见下方修订说明） |
| 位置 | `dsh-mobile/package.json:18`（103-spawn `&&` 链）；`dsh-mobile/tests/support/component-harness.mjs:17-18` |
| 收益 | **高** —— 当前 `tsc --noEmit` 是链条**最后一环**，任何测试失败都会导致类型检查根本不跑；`component-harness` 的 `.ts` 硬编码会让过期 mock **abort 进程**并带走整条链（提交 `9c17dbd` 的结构性成因）。修好后**一次运行即可看到全部失败**，而不是串行地"修一个、重跑、再看下一个" |
| 成本 | 中（新增一个聚合器脚本 + 修 4 行解析） |
| 风险 | **低** —— 只改测试基础设施，不碰业务代码，**不改任何被测 spec 的断言** |
| 可验证性 | **强** —— 故意在两个 spec 里制造失败，断言：(a) 其余 spec 仍然运行完；(b) 退出码非零；(c) 失败清单包含**两个**失败项而不是只有第一个；(d) `tsc --noEmit` **仍然执行** |
| **前置条件** | **无** |
| **注意事项** | 并行化会暴露 `globalThis` 共享状态问题（**TEST-04** 的三个 cookie jar、**TEST-11**）。**本轮保持串行**，不并行化 |
| 本轮实施 | ✅ **是 —— 复核授权范围第 2 项** |

> **⚠️ 第二方复核修订（2026-11-11）—— 复核意见 1 与 2，均已采纳**
>
> **(a) 标题与严重度**：原标题"让回归信号**可信**"、严重度 Critical，隐含"`&&` 链会造成假绿"。**这是错的**：`&&` 链失败时**退出码非零、CI 是红的**；一条完整跑通的链意味着 103 条命令全部通过，**绿色是真实的**。真实危害是**诊断能力**（一次只暴露第一个失败、`tsc` 可能从未执行）。标题改为"让失败诊断完整"，严重度降为 **High**。**真正的假绿通道是 P0-7（TEST-03），已升为 Critical 并提到第 1 优先。**
>
> **(b) 具体动作第 1 步已重写**：原文是"把 `&&` 链换成 `node --test tests/**/*-spec.mjs` + `--test-concurrency`"。**撤回。** 复核意见要求：必须兼容 CI 的 Node 20、保留 `tsx`/`node`/`npm script` 的原有执行语义、不得使用未经验证的 glob 替换整条链。**本人核实后确认原方案不可行**：
>
> | 约束 | 核实结果 |
> |---|---|
> | `tsx` 依赖 | 103 条命令中 **76 条**依赖 `tsx`（**68** 裸调用 + **8** `tsx --test`）来加载 `.ts`。`node --test` **不能直接跑 `.ts`**，需要额外 loader → 改变执行语义 |
> | Node 20 注入 | `test:node20` 的 5 条命令依赖 `--require ./tests/support/node20-sim.cjs`（删掉全局 `WebSocket` 以复现 Node 20 —— CI 的 Node 20 没有全局 WebSocket，21+ 才有）。聚合器**必须原样保留这个前缀** |
> | glob 支持 | `package.json` 的 `engines` 是 `>=20`，CI 四个 job 全部固定 `node-version: 20`。`--test` 的 glob 位置参数支持是**版本相关**的；**具体从哪个版本起支持，本轮无法在不访问外部资料的前提下确认 → 标记待验证**，因此方案**不得依赖**它 |
> | 命令种类 | 逐类计数（本人以脚本传递展开复核）：`tsx` 裸调用 **68**、`tsx --test` **8**、`node --test` **12**、裸 `node` **14**、`tsc --noEmit` **1** = **103**；`test:integration` 另 **5** 条、`test:node20` 另 **5** 条，合计 **113** 条叶子命令 |
>
> **修订后的方案（聚合器）**：
> 1. **不重新发明命令**：从 `package.json` 的 `scripts` 出发，按 `&&` 分割并**传递展开** `npm run X`，得到与今天**逐字相同**的叶子命令列表；
> 2. **原样执行**：用 `spawnSync` 逐条跑，`tsx` 解析到 `node_modules/.bin/tsx`，`--require` / `--test` 等前缀**逐字保留**，`cwd` 与 shell 环境不变；
> 3. **只改失败处理**：把"首个失败即停"改成"**跑完全部 → 收集每条的退出码与输出 → 汇总打印失败清单 → 以非零退出**"；
> 4. **不用 glob、不用 shell 通配**：文件枚举用 `fs.readdirSync`（Node 20 / 24 行为一致）；
> 5. **保证 `tsc --noEmit` 必跑**，不再因前置失败被跳过；
> 6. **自带等价性断言**：新增 spec 断言聚合器展开出的命令列表与旧 `&&` 链**逐字一致**（防止漏跑或多跑）。
> 7. 原第 2、3 步（修 `component-harness.mjs:18` 的 `.ts` 硬编码；接入 6 个孤儿 script `test:localRuntime`/`test:p4`/`test:p3`/`test:e2e`/`test:perf`/`test:filesave`）**保留不变**。

---

### P0-2 · 把 gateway 补丁门禁接到 `start-tunnel.ps1`（公网路径不得可跳过）

| 项 | 内容 |
|---|---|
| 编号 | **SEC-01** |
| 严重程度 | **High（安全，公网暴露）** |
| 位置 | `start-tunnel.ps1`（对补丁门禁的引用数 = **0**，本人 grep 复核）vs `start-dsh-web.ps1`（引用数 = **4**）；DSH 启动点有**两处**：`start-tunnel.ps1:262-280`（`$taskName0`）与 `:474-476`（`$taskName`） |
| 收益 | **高** —— `start-tunnel.ps1` 会启动 DSH 并把它**发布到公网 cloudflared URL**（`:340-359`），却**完全跳过**了 `start-dsh-web.ps1` 那道"补丁未应用就拒绝启动"的门禁。叠加 `setup-gateway.ps1` 已把 `adminLoopbackOnly` 写成 `false`（`:147`、`:160`）→ `/mgw/*` 管理面无认证地暴露在公网 |
| 成本 | **极低** —— dot-source 已有的 `scripts/gateway-patch-gate.ps1`，在两处 DSH 启动前各调一次 |
| 风险 | **低-中**（↑ 原"极低"，因需新增 `-Public` 文案分支）—— **门禁判定逻辑零改动**，`start-dsh-web.ps1` 行为完全不变 |
| 可验证性 | **强** —— 见下方验证清单 |
| **宪章合规** | ✅ 这是**收紧**，不是简化删除。宪章明确"涉及安全的代码不得直接提出简化删除方案"——本项**扩展**了现有安全控制的覆盖面，且**关闭**了一个旁路 |
| 本轮实施 | ✅ **是 —— 复核授权范围第 1 项（最高优先）** |

> **⚠️ 第二方复核修订（2026-11-11）—— 复核意见 5，已采纳**
>
> 复核意见：**SEC-01 涉及公网暴露，应优先核实；公网隧道启动路径不得通过普通跳过参数绕过必要的鉴权门禁。**
>
> **本人核实：缺口确实存在，且原修复建议自己引入了旁路。** 原文写"沿用同一个显式 `-SkipGatewayPatchCheck` 退出口"，但：
> - `scripts/gateway-patch-gate.ps1:74-81`：`-Skip` 直接返回 `ShouldCheck = $false`，调用方随即**静默放行**；
> - `Write-GatewayPatchRefusal` 的**最后一行（`:156`）主动广告这个开关**：`确认不需要手机审批、想强行启动：加 -SkipGatewayPatchCheck`。
>
> 在**局域网**路径上这是经过权衡的 opt-out（`start-dsh-web.ps1:110` 注释写明"仅用于你确认不用手机审批时"，暴露面限于同网段）。搬到**公网隧道**上，等于在暴露面最大的入口提供"一行参数关闭鉴权门禁"的旁路，**而且拒绝提示自己会教用户怎么用它**。
>
> **修订后的实施约束（硬性）**：
> 1. `start-tunnel.ps1` **不得新增** `-SkipGatewayPatchCheck` 参数（该脚本当前没有 —— 保持这样）；
> 2. 调用门禁时**显式传 `-Skip:$false`**，使"公网路径永不跳过"成为**代码事实**而非约定；
> 3. 给 `Write-GatewayPatchRefusal` 增加 **`-Public`** 开关：公网路径**不打印** skip 提示，改为"公网隧道不提供跳过开关；请修复补丁，或改用局域网路径 `start-dsh-web.ps1`"；
> 4. **不改动 `Test-GatewayPatchApplied` 的判定逻辑** —— 三个 `ShouldCheck = $false` 分支（skip / plugin-not-installed / patch-script-missing）与 `CheckRunner` 语义**逐字保留**；
> 5. 门禁必须位于**两处** `schtasks /Create` 之前、且在"定位 dsh"之前（否则环境问题会掩盖门禁结果 —— 这正是 `gateway-patch-gate.ps1:11-19` 注释记录过的历史坑）。
>
> **验证清单**（扩展 `dsh-mobile/tests/gateway-startup-gate-spec.mjs`，它已在真实 PowerShell 下调用门禁函数，并遵循"CI 无 PowerShell 即 `bad()`"的 fail-closed 约定，见 `:98-100`）：
> - 静态：dot-source 门禁、调用 `Test-GatewayPatchApplied`、`ExitCode -ne 0` → `exit 1`、门禁位置在两处 `schtasks /Create` 之前；
> - **负向**：`start-tunnel.ps1` **不含** `SkipGatewayPatchCheck`（防止旁路被重新引入）；
> - 行为：真实 PowerShell 下 `Write-GatewayPatchRefusal -Public` 的输出**不含** `SkipGatewayPatchCheck`，但**仍含** `apply.mjs --apply` 与"拒绝启动"；不带 `-Public` 时**仍含** `SkipGatewayPatchCheck`（局域网 opt-out 不被削弱）；
> - 回归：该 spec 原有的 8 条静态断言 + 12 条行为断言 + §5 反证**必须仍绿**。

---

### P0-3 · 补 React 错误边界（**不得视为零风险**）

| 项 | 内容 |
|---|---|
| 编号 | **BUG-04** |
| 严重程度 | **High** |
| 位置 | 全仓 **0 个** error boundary（`componentDidCatch` / `getDerivedStateFromError` grep 零命中） |
| 收益 | **高** —— 当前任何一处渲染期抛错都会白屏整个 App，用户唯一能做的是杀进程重进。而 fold 层处理的是**上游 wire 数据**，形状变化是常态（见 `docs/protocol-compat.md` 场景 B/D） |
| 成本 | 低（代码量）—— 但**验证成本高**，见下 |
| 风险 | **中**（↑ 原"极低"，按复核意见 4 上调） |
| 可验证性 | ⚠️ **弱**（↓ 原"强"）—— **当前无法验证**，见下方修订说明 |
| 建议挂载点 | (1) NavHost 的每个 stack entry（隔离单屏崩溃）；(2) `ChatScreen` 的消息行（隔离单条消息的渲染崩溃——这与 fold 的容错设计互补）；(3) App 根（兜底） |
| **前置条件（新增）** | **必须先具备真实渲染测试能力**（TEST-12）：能真正 render 一棵子树、能让子树在渲染期抛错、能断言 fallback UI 出现且父级状态未损坏 |
| 本轮实施 | ❌ **否 —— 不在复核授权的 4 项范围内**（原列第 3 优先，现移出本轮） |

> **⚠️ 第二方复核修订（2026-11-11）—— 复核意见 4，已采纳**
>
> 复核意见：**ErrorBoundary 必须有真实渲染行为测试；不能将其定义为零风险修改。**
>
> **本人核实：原评级内部自相矛盾。** 原表写"风险 **极低** —— 纯增量，零功能改动"且"可验证性 **强** —— 写一个故意抛错的组件挂进去"。但同一份审计的 **TEST-12** 已证明：
> - **34 个 `.tsx` 从不真正渲染**；
> - `component-harness.mjs:28` 的 `useEffect() {}` 是**空实现** → effect 从不执行；
> - `useState` 的 setter **不触发重渲染**，`useMemo`/`useCallback` **丢弃依赖**。
>
> 而错误边界的**全部价值**恰好是"子树在**渲染期**抛错时被 `getDerivedStateFromError` 捕获并渲染 fallback"。**这正是当前 harness 无法观察的行为** —— "纯增量"只说明它不改现有代码路径，**不等于**它的行为正确性可以被验证。一个从未被渲染测试覆盖的 ErrorBoundary，可能因为挂载位置错误、fallback 自身抛错、或 `componentDidCatch` 里的 `store` 调用二次抛错而**完全不生效，且没有任何测试会变红**。
>
> **修订结论**：风险 **极低 → 中**；可验证性 **强 → 弱**；新增前置条件；**移出本轮实施范围**。后续实施时，"写一个故意抛错的组件挂进去"这条验证方法**必须在真实渲染器下**执行（`@testing-library/react-native` 或等价的真实 reconciler），不能用现有的 `component-harness.mjs`。

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
| 本轮实施 | ❌ **否 —— 不在复核授权的 4 项范围内**（原列第 4 优先） |

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
| 本轮实施 | ❌ **否 —— 不在复核授权的 4 项范围内**（原列第 5 优先） |

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
| 本轮实施 | ❌ **否 —— 不在复核授权的 4 项范围内**（原列第 6 优先）。**注意：本项与 P0-2 改同一个文件 `start-tunnel.ps1`，本轮实施 P0-2 时不得顺手夹带本项** |

---

### P0-7 · 让 CI 下的 `skip` 变成失败（**唯一的真·假绿通道**）

| 项 | 内容 |
|---|---|
| 编号 | **TEST-03** |
| 严重程度 | **Critical**（↑ 原 High，按复核意见 1 上调；Critical 名额由 BUG-01 转移过来） |
| 位置 | **恰好 2 个 spec**：`dsh-mobile/tests/protocol-contract-spec.mjs`（11 处 `{ skip: … }` 返回）、`dsh-mobile/tests/crosscheck-revoke-self-spec.mjs`（5 处）。两者都是 `process.exitCode = fail === 0 ? 0 : 1` —— **`skip` 完全不参与退出码**，且**零** `process.env.CI` 引用 |
| 收益 | **极高** —— 这是本轮审计发现的**唯一一条真正让绿灯失真的通道**。一旦插件不可解析，DSH 审批协议契约（子协议前缀 `dsh-auth.`/`dsh-pair.`、Origin 同源校验、撤销语义、`clientDeviceId` 缺失时的自识别）会**全部失去守卫而 CI 仍然全绿** |
| **已实测复现** | 本地 Node v24.13.0，把 `HOME`/`USERPROFILE` 指向空临时目录、`DSH_GATEWAY_PLUGIN_DIR` 指向不存在路径：<br>· `protocol-contract-spec.mjs`：正常 **16 通过 / 0 跳过** → **6 通过 / 10 跳过 / 0 失败 / exit 0**<br>· `crosscheck-revoke-self-spec.mjs`：正常 **5 通过** → **0 通过 / 5 跳过 / 0 失败 / exit 0**（**整组零断言**） |
| **⚠️ 今天已在 CI 上发生** | `android.yml:54-57` 的 `test` job **设了** `DSH_GATEWAY_PLUGIN_DIR` → 那个 job 正常。**但 `signing-verify.yml` 没设**（`android.yml` 是唯一设置它的 workflow），而它在 `:147-149` 跑**完整 `npm test`**、runner 是 `ubuntu-latest`（`:53`）→ `USERPROFILE` 未定义、`$HOME/.dsh/…` 不存在 → **15 条契约断言全部 skip、两个 spec 均 exit 0、该 workflow 报绿**。**这不是"将来可能失效"，是"已经失效"** |
| 成本 | **极低**（每个 spec 加一个解析点守卫 + 退出码纳入 `skip`；`signing-verify.yml` 加一个 job 级环境变量） |
| 风险 | **低** —— 只在"CI 且插件不可解析"这个分支上改变退出码。**残余风险（需在交付说明中明确）**：补齐 `signing-verify.yml` 的环境变量后，该 workflow 会**第一次真正执行**这 15 条断言；若上游插件与客户端已漂移，它会**立刻变红**。这是**期望结果**（暴露真实缺陷），不是"改坏了" |
| 可验证性 | **强** —— 负向：`CI=1` + 插件不可解析 → **必须非零退出**；正向：插件可用 → **仍为 0 且 skip 为 0**；静态：两个 workflow 的 `DSH_GATEWAY_PLUGIN_DIR` 值一致 |
| **修复必须两部分同时做** | ① **spec 侧**：解析点加 fail-closed 守卫 + `skip > 0 && CI` → 非零退出；② **CI 侧**：给 `signing-verify.yml` 的 `verify-signing` job 补上与 `android.yml:54-57` **逐字相同**的 `DSH_GATEWAY_PLUGIN_DIR`。**只做 ① 会把 `signing-verify.yml` 弄红；只做 ② 则守卫缺失、下次仍会静默失效** |
| **仓库内已有的正确范例（两个）** | ① **`approval-gateway-f01-spec.mjs:60-63`** —— 同样消费该插件的**第三个** spec，**fail-closed**：`if (!pluginDir) { console.error('FAIL: 未找到真实 dsh-plugin-mobile-gateway 插件目录'); process.exit(1); }`。**三个 spec 对同一前置条件给出两种相反处理 → 这是内部不一致，不是设计选择。照抄它。**<br>② `gateway-startup-gate-spec.mjs:98-100` —— `if (process.env.CI) bad(...) else console.log('  SKIP  ...')` |
| **刻意排除** | `server-identity-binding-spec.mjs` 也有 skip 计数器，但其 skip 来自**端口复用竞态**（`:551,554,562`：`端口 ${oldPort} 没能复用`），属环境抖动而非依赖缺失。让它 `skip>0` 即失败会**引入 CI 抖动** → **排除在本项之外**，另行排期 |
| 本轮实施 | ✅ **是 —— 复核授权范围第 3 项；按严重度排第 1 优先** |

> **⚠️ 第二方复核修订（2026-11-11）**：原"位置"栏写"若干 spec 的 `CANDIDATES` 列表缺 `dsh-mobile/node_modules/dsh-plugin-mobile-gateway`"。**该表述不准确，已更正**：CI 通过 `android.yml:57` 的 `DSH_GATEWAY_PLUGIN_DIR` 指向的**正是**该路径，且它是 `CANDIDATES` 的**第一个**候选，所以**今天 CI 上插件能解析、测试确实在跑**。真正的问题不是"目录未登记"，而是**没有任何机制保证它一直能解析** —— 解析失败时两个 spec 会静默跳过全部断言并以 0 退出。修复重点因此从"加候选目录"改为"**在解析点加 fail-closed 守卫**"，并保留 `CANDIDATES` 原样（不改候选顺序，避免影响本地开发者的 `~/.dsh` 解析）。


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
| 本轮实施 | ❌ **否 —— 不在复核授权的 4 项范围内**（原列第 8 优先）。本项触碰 `transport/index.ts`，属本轮硬约束"不改动 stream 核心业务逻辑"的范围 |

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
| **实施顺序（重要）** | 1. **先**在 `tests/fold-spec.mjs` 加 4 个用例，**确认它们当前失败**：<br>&nbsp;&nbsp;(a) `tool/result` 用 `id`（而非 `toolCallId`）携带 callId → 当前会产生**两个**工具块<br>&nbsp;&nbsp;(b) `tool/result` 的 callId 为空串 → 当前**静默丢弃**<br>&nbsp;&nbsp;(c) `turn/end` 到达时仍有 `pending: true` 的块 → 当前**永久 pending**；修复后必须断言 `pending === false` **且 `isError === true` 且 `output` 非空**<br>&nbsp;&nbsp;(d) **负向**：上述场景**不得产生任何重发** —— 断言注入的 transport spy 调用次数为 **0**<br>2. 再改代码<br>3. 断言 `fold-spec.mjs:189-232` 的**现有**用例（真实捕获的 id `call_574864__tsk16___eK0ASYdfAikZ6ze`）**仍然通过** |
| **修复语义硬约束（复核意见 3）** | ⚠️ **缺失 `tool/result` 不得等同工具执行成功。** `ToolCard.tsx:152-158` 的状态推导是 `pending ? '执行中' : isError ? '失败' : '完成'` —— **成功是默认分支**。因此 `turn/end` 清扫时**只置 `pending = false` 而不设 `isError`，会把"结果未达"渲染成"完成" + success 配色**。正确写法：`pending = false` **且 `isError = true` 且 `output ??= '（未收到工具结果，轮次已结束）'`**。<br>**禁止**：只清 `pending`；把 `output` 留空；在 `turn/end` 里补发请求或重放事件。<br>**"不得自动重试"已核实成立**：`isError` 全仓仅 3 个消费点（`ToolCard.tsx:152-158`、`WorkGroupCard.tsx:46`、`workGroup.ts:114`）**全是展示层**；`grep -rniE "retry\|resend\|requeue"` 在 `workGroup.ts`/`WorkGroupCard.tsx` **零命中**；`store.ts` 唯一的 `retry` 是 `:2593` 的 `pendingSends.retry(requestId)`（持久化发件箱，以 `requestId` 为键，与工具块无耦合） |
| **需一并复核的副作用** | `workGroup.ts:114` 的 `const failed = toolBlocks.some((b) => b.isError)` 会让包含该工具的 WorkGroup 整体显示为失败。这是**期望的**（确实有工具没跑完），但会改变可见状态 |
| **保护区约束** | ✅ 本项是**补齐 `e0216f9` 的对称性**，不是替换它。`fold-spec.mjs:189-232` 是真实测试（真 import、真 `foldEvents`、真 id），改前改后都必须绿。**不得**改动 `:265-274` 的 seq 去重或 `:396-499` 的合并逻辑主干 |
| 本轮实施 | ❌ **否 —— 不在复核授权的 4 项范围内**。且本轮硬约束明确"**不改动 fold、pendingSend、stream 核心业务逻辑**"，本项正落在 fold 核心区。原列第 9 优先，现移出本轮 |

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

| 本轮实施 | ❌ **否 —— 不在复核授权的 4 项范围内**（原列第 10 优先） |
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
| **TEST-17(1)** | **Medium-High** | **CI 加一行 `./gradlew :agent-core:test`** → **38 个已经写好的 JVM 测试立刻生效**（`AgentLoopTest` 14、`CloudModelClientTest` 13、`FileRunStoreTest` 7、`RunRecoveryTest` 4） | **极低** | **本次审计里收益/成本比最高的单项** · ✅ **本轮已授权实施（复核范围第 4 项）** |
| **TEST-06** | High | 给 butler 沙箱边界 `workspace-fs.js`（80 行，含 `inside()` / `verifyRoot()` / `fresh()` TOCTOU 重解析 / 符号链接拒绝）补测试 | 低 | 判据：把 `fresh()` 换成缓存版本，测试**必须失败** |
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
| 完整范围（原规划） | **P0-1**（测试链 + harness 解析 + 6 个孤儿 script）、**P0-7**（CI 下 skip 变失败）、**TEST-17(1)**（加 `:agent-core:test`）、**TEST-16(1)**（加 `timeout-minutes`）、**TEST-14(1)**（CI 打 gateway 补丁） |
| **本轮实际授权范围** | **P0-1**、**P0-7**、**TEST-17(1)**，另加**阶段 2 的 P0-2（SEC-01）**被提前到本轮第 1 优先。<br>**未授权、本轮不做**：`TEST-16(1)`（`timeout-minutes`）、`TEST-14(1)`（CI 打 gateway 补丁）、P0-1 里的"harness `.ts` 解析修复"与"接入 6 个孤儿 script"两项子动作**也未单独授权** —— 本轮只做聚合器本身，不夹带 |
| 触碰业务代码 | **否** —— 全部是测试/CI 基础设施（P0-2 触碰 `start-tunnel.ps1` 与 `scripts/gateway-patch-gate.ps1`，属**启动脚本与安全门禁**，不是 DSH 业务逻辑） |
| 回滚方式 | **每项一个独立 commit**，可单独 `git revert`（复核要求） |
| 完成判据 | (1) 故意制造 2 个失败，报告里**两个都在**；(2) `tsc --noEmit` 无论测试成败都跑；(3) CI 日志里能看到 38 个 agent-core 测试结果；(4) `CI=1` + 插件不可解析时两个契约 spec **非零退出**；(5) `start-tunnel.ps1` 在补丁未应用时**拒绝启动**且**不提供 skip 旁路** |
| 预期收益 | **首次获得可诊断的完整失败清单** + 关闭唯一的假绿通道 + 38 个已有原生测试生效 + 公网启动路径纳入门禁 |

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

## 八、本轮实施记录（2026-11-11，分支 `opt/p2-review-remediation`）

审计基线由提交 `ad2a6ab` 冻结（8 份文档的原始交付版本）；复核意见的采纳记录在 `20b65ba`。以下四项修复各自独立提交，可单独 `git revert`。

| 序 | 范围 | 对应条目 | commit | 改动的文件 | 验证 |
|---|---|---|---|---|---|
| 1 | 公网启动门禁 | **SEC-01** | `b302501` | `start-tunnel.ps1`、`scripts/gateway-patch-gate.ps1`、`dsh-mobile/tests/gateway-startup-gate-spec.mjs` | 负向测试先行（修前 **13 失败**）→ 修后 **51 通过 / 0 失败**；双向变异反证；PS 5.1 语法解析 OK；4 个相关 spec 无回归 |
| 2 | 测试聚合器 | **BUG-01 / TEST-01** | `9211da8` + `fe0b305` | `dsh-mobile/tests/run-suite.mjs`（新增）、`dsh-mobile/tests/suite-runner-spec.mjs`（新增）、`dsh-mobile/package.json` | 聚合器 spec **75 通过 / 0 失败**（fixture 用真实子进程 + marker 文件证明"失败之后的命令确实执行了"；`fe0b305` 补上"前置失败时 `tsc --noEmit` 仍执行"，含变异反证 75→**67 通过 / 8 失败**）；三条公开脚本**全部实跑通过**：`npm test` **106 条 / 106 通过 / 433.4s / exit 0**、`test:integration` **5/5 / 29.3s**（含 2 条真 `tsx`）、`test:node20` **5/5 / 7.0s** |
| 3 | 静默 skip | **TEST-03** | `f38d9e2` | `dsh-mobile/tests/protocol-contract-spec.mjs`、`crosscheck-revoke-self-spec.mjs`、`contract-skip-guard-spec.mjs`（新增）、`package.json`、`.github/workflows/signing-verify.yml` | 假绿已实测复现（`0 通过 / 5 跳过 / exit 0`）→ 修后守卫 spec **28 通过 / 0 失败**；变异反证；两个契约 spec 的正常路径仍 **16 / 5 通过、0 跳过** |
| 4 | Android JVM 测试接入 | **TEST-17(1)** | `6a83f2c` | `.github/workflows/android.yml`、`dsh-mobile/tests/android-jvm-tests-ci-spec.mjs`（新增）、`package.json` | **本人实跑** `./gradlew :agent-core:test` → BUILD SUCCESSFUL，**38 tests / 0 failures / 0 errors / 0 skipped**；CI 接线 spec 负向先行（修前 2 失败）→ 修后 **31 通过 / 0 失败**；三处变异反证 |

### 补记 · 第 2 项（测试聚合器）的设计与验证

**改动方式**：`package.json` 里三条公开脚本的名字**一个都没改**（CI 调的就是 `npm test` / `npm run test:integration` / `npm run test:node20`），只把「怎么跑」从 `&&` 串联换成聚合器；原来的声明式链条改名为 `test:chain` / `test:integration:chain` / `test:node20:chain` **原样保留**。

这样做的原因是：链条是「跑哪些命令」的**唯一真值来源**，聚合器读它并传递展开，因此**不存在第二份命令清单会漂移**。同时 `npm run test:chain` 仍是旧行为的逃生口。

| 复核约束 | 落实方式 | 证据 |
|---|---|---|
| **Node 20 兼容** | 只用 Node 20.0 就有的 API：`spawnSync` / `readFileSync` / `existsSync` / `path` / `fileURLToPath`（这五个就是 `run-suite.mjs` 的**全部** import）。**刻意不用 `import.meta.dirname`**（20.11+ 才有），改用 `path.dirname(fileURLToPath(import.meta.url))`；不用 `toSorted` / `findLast` / `Object.hasOwn` / `structuredClone` / `.at()` / `Array.fromAsync` | 静态扫描 `run-suite.mjs`：上述 API 在**代码里零命中**，4 处命中**全部在注释里**（`:24`、`:25`、`:32`、`:34`，都是在解释"为什么不用它们"）。新 spec 也刻意不引入比被测对象更强的版本要求 |
| **不用 glob** | 命令**全部**来自 `package.json` 的传递展开，不扫描文件系统；执行用 `spawnSync(file, args, { shell: false })`，不经 shell | `--dry-run test:chain` 输出 **106 条**（本轮新增 1 条 spec 后），与 spec 里**独立重写**的展开算法逐字逐序一致 |
| **保留 tsx / node / npm script 语义** | 只认三种可执行文件并各自解析到 **JS 入口**：`node` → `process.execPath`；`tsx` → `node_modules/tsx/dist/cli.mjs`；`tsc` → `node_modules/typescript/bin/tsc`。`--test` / `--require ./tests/support/node20-sim.cjs` 等前缀**逐字透传** | fixture 里用记录 argv 的桩证明：`tsx f/args.mjs --test` → 桩收到 `["f/args.mjs","--test"]`；`node f/args.mjs --test --require ./x.cjs` → argv 个数、顺序、内容全对。真实链的 5 条 `--require node20-sim.cjs` 命令在 `--dry-run` 里前缀完整 |
| **收集全部失败** | 跑完全部再汇总；每条失败保留**各自的**退出码；末尾单独报告 `tsc --noEmit` 是否执行 | fixture ①：`pass → fail1(1) → fail2(2) → after` 四条，`&&` 链会在 fail1 处截断；聚合器**四条全部执行**（marker 文件为证）、失败清单列出**两个**、保留 fail2 的退出码 2、自身退出码 1。fixture ②（`fe0b305` 补）：`node f/fail1.mjs && tsc --noEmit` —— 前置必失败时 **tsc 桩仍被调用**、仍收到原样 `--noEmit`、汇总单独打印类型检查状态。**变异反证**：给执行循环插入 `if (code !== 0) break;` 模拟 `&&` 截断，spec 从 75 通过变成 **67 通过 / 8 失败**，两条 fixture 的关键断言全部转红 |
| **不并行** | 保持串行 | 现有 spec 共享 `globalThis` shim 状态（TEST-04 的三个 cookie jar），并行会引入与本改动无关的失败 |
| **失败即拒绝，绝不静默** | 未知可执行文件、含 shell 元字符的命令、缺失 script、循环引用、展开为空 —— **全部在规划阶段抛错退出**，不跳过、不猜测 | 6 个响亮失败用例全部通过；并额外验证「坏命令混在好命令里」时**前面的好命令不会被执行**（规划阶段就拒绝，避免跑一半才炸）。前提已核实：106 条命令**零**引号、**零** shell 元字符、简单分词可逆，所以 `shell:false` 与旧链语义相同 |

**为什么绕开 `node_modules/.bin`**：Node 20.12+ 出于 CVE-2024-27980 拒绝在没有 `shell: true` 时 spawn `.cmd`/`.bat`，而开 shell 就得自己处理引号注入。走 JS 入口在 Windows 与 Linux 上行为一致。**这个坑是在本轮开发中被真实触发的** —— 守卫 spec 最初用 `.bin/tsx.cmd`，子进程全部返回 -1，而"非零退出"那条断言因此**假通过**；是"退出必须由守卫导致、而非别的崩溃"那条标记断言把它抓出来的。

**关于命令条数（避免与审计正文的"103"冲突）**：审计报告里的 **103** 是 **2026-11-10 审计基线**的真实数字，历史准确。实施轮往链上**新增了 3 条**，所以现在逐次是：

| 时点 | `test:chain` 叶子命令数 | 变化 |
|---|---|---|
| 审计基线 `2325d34` | **103** | —— |
| + `test:contractSkipGuard`（`f38d9e2`，TEST-03 守卫） | 104 | +1 |
| + `test:agentCoreCi`（`6a83f2c`，CI 接线守卫） | 105 | +1 |
| + `test:suiteRunner`（聚合器自身的 spec，置于链首，`9211da8`） | **106** | +1 —— **本机实跑的就是这 106 条** |

链首是聚合器自己的 spec，链尾仍是 `tsc --noEmit`：**聚合器坏了就不必再跑后面 105 条**，而类型检查不再因前置失败被跳过。

**完整链实跑结果（本地 Node v24.13.0 / Windows，非 CI 环境）**：

```
── [106/106] tsc --noEmit ──

套件汇总：106 条命令，106 通过，0 失败，耗时 433.4s

全部通过。
类型检查（tsc --noEmit）：已执行且通过
NPM_TEST_EXIT=0
```

跑的是 CI 调用的**同一条命令** `npm test`（不是直接调聚合器），因此 `package.json` 的脚本改写路径也被覆盖了。

**最终状态已二次确认**：上表是 `9211da8` 时的结果；补上 `fe0b305`（tsc-after-failure 用例）后**重跑了整条链**，结果一致 ——

```
套件汇总：106 条命令，106 通过，0 失败，耗时 380.4s
类型检查（tsc --noEmit）：已执行且通过
NPM_TEST_FINAL_EXIT=0
```

即两次独立完整运行（433.4s / 380.4s）均为 **106/106 通过、exit 0**，且两次都确认 `tsc --noEmit` 真实执行并通过。

**三条公开脚本全部实跑（本机 Node v24.13.0 / Windows，均为 exit 0）**：

| 脚本 | 命令数 | 结果 | 耗时 | 这条覆盖了什么 |
|---|---|---|---|---|
| `npm test` | 106 | **106 通过 / 0 失败** | 433.4s | 全链，含链尾 `tsc --noEmit`（日志明确打印"已执行且通过"） |
| `npm run test:integration` | 5 | **5 通过 / 0 失败** | 29.3s | 含 **2 条真 `tsx`**（`integration-product` / `integration-gateway-reconnect`），证明 tsx 走 JS 入口在真实场景可用，不只是 fixture 桩 |
| `npm run test:node20` | 5 | **5 通过 / 0 失败** | 7.0s | 含 **5 条 `--require ./tests/support/node20-sim.cjs`**（3 条 `node`、2 条 `tsx`）。这是"前缀在 `shell:false` 下仍然生效"的**硬证据**：若该前缀被丢弃或相对路径解析失败，Node 会以 `MODULE_NOT_FOUND` 非零退出，而实际 exit 0 |

**注意 `test:node20` 的局限**：它是用 `node20-sim.cjs` 在 **Node 24 上模拟** Node 20 的环境（主要是抹掉 Node 21+ 才有的全局 API），**不是真的 Node 20**。真 Node 20 的行为仍然只能在 CI 上验证 —— 见下方"仍待验证"。

这同时解决了原审计的一个**待验证项**：「测试套件当前是绿是红」——在本机上是**绿的**，且 `tsc --noEmit` 确实执行并通过。**但这不能推断 CI 结果**：CI 是 Node 20 / ubuntu-latest，本机是 Node 24 / Windows，两者在 `WebSocket` 全局对象、路径语义、PowerShell 版本（5.1 vs pwsh 7）上都有差异 —— 这正是仓库自带 `test:node20` 链的原因。

### 未触碰的区域（本轮硬约束的落实情况）

| 约束 | 落实 |
|---|---|
| 不改动 fold / pendingSend / stream 核心业务逻辑 | ✅ `src/core/fold/`、`src/core/store.ts`、`src/core/transport/`、`pendingSend*` **零改动**（`git diff --stat` 可验证） |
| 不新增功能、不做架构重构 | ✅ 四项全部是测试/CI/启动脚本层面的改动；`src/` 下**零文件改动** |
| 不触碰正式签名材料、不自动发布版本 | ✅ 未改 keystore / 证书 / `release-signing.json`；`release` job 的 `if: startsWith(github.ref, 'refs/tags/v')` 与 job 级 `permissions: contents: write` **原样保留**；新增的 `jvm-tests` job **不引用任何 secrets、不含任何发布动作、不声明 job 级 permissions**（由 spec §4 断言守住） |
| 每项独立提交、可单独回滚 | ✅ 见下方"回滚顺序"，每个 commit 只承载一项修复 |
| 改前先建立失败复现或负向测试 | ✅ 四项**全部**先有红：SEC-01 **13 失败** → `b302501`；TEST-03 **12 失败**（且假绿本身已实测复现：`0 通过 / 5 跳过 / exit 0`）→ `f38d9e2`；JVM 接线 **2 失败** → `6a83f2c`。聚合器一项**没有"改动前的红"**（它不是修 bug，是新增基础设施），改用**变异反证**：给执行循环插入 `&&` 式截断后 spec 从 75 通过变成 **67/8 失败**（`fe0b305`） |
| 无法验证的标记待验证 | ✅ 见下方"仍待验证"清单 |

### 仍待验证（本轮无法确认，未编造结论）

| 项 | 待验证什么 | 为什么无法验证 |
|---|---|---|
| **CI 上 `jvm-tests` job 是否真的通过** | 本地 `./gradlew :agent-core:test` 已实跑通过（38/0），但 **CI 的 ubuntu-latest 上是否同样通过未验证** —— 特别是 `:agent-core:test` 是否需要 NDK 才能完成 Gradle 配置（`configure-on-demand` 未开启 → 会配置 Android 模块 `:app`，而 `app/build.gradle:86` 声明了 `ndkVersion`）。已采取保守做法：照抄 `build-test` 的 NDK/SDK 准备步骤 | 需要真的触发一次 workflow（tag push 或 `workflow_dispatch`），本轮不推送、不发布 |
| **`signing-verify.yml` 补上环境变量后是否变红** | 那 15 条契约断言在该 workflow 里**从未真正执行过**；补上后它们会第一次运行。如果上游插件与客户端已经漂移，该 workflow 会**立刻变红** —— 这是期望结果（暴露真实缺陷），但**本轮无法预知** | 同上，需要真的跑一次 |
| **完整 `npm test` 链在 CI 上是绿是红** | **部分解决**：本机（Node v24.13.0 / Windows）**两次独立完整实跑**均 **106 条 / 106 通过 / 0 失败 / exit 0**（433.4s 与 380.4s），含 `tsc --noEmit`。**但 CI（Node 20 / ubuntu-latest）上仍未验证** —— 两者在 `WebSocket` 全局对象、路径语义、PowerShell 版本（5.1 vs pwsh 7）上有差异 | 需要真的触发一次 workflow，本轮不推送 |
| **Node 20 的 `--test` glob 支持起始版本** | 聚合器**刻意不依赖** glob，所以这个未知项不阻塞实施；仅记录为原审计建议被撤回的理由之一 | 需要查外部版本资料，本轮不访问外部服务 |

### 回滚顺序

下列 6 个 commit 可单独 `git revert`。**这一点是实测的，不是推断的** —— 用 `git show <c> | git apply --check -R --3way`（`--3way` 与 `git revert` 的合并策略一致，`--check` 只校验、不改动工作区）逐个验证：

| commit | 单独反向应用 | 说明 |
|---|---|---|
| `b302501` | ✅ 干净 | 不碰 `package.json` |
| `f38d9e2` | ✅ 干净 | 碰 `package.json`，但插入点上下文仍可三方合并 |
| `6a83f2c` | ✅ 干净 | 同上 |
| `fe0b305` | ✅ 干净 | 只改 `suite-runner-spec.mjs` |
| `9211da8` | ❌ **必须先回退 `fe0b305`** | 它**新建**了 `suite-runner-spec.mjs`，而 `fe0b305` 又**修改**了该文件 → 单独 revert 时删除操作撞上下游修改，报 `patch failed: dsh-mobile/tests/suite-runner-spec.mjs:1` |
| `20b65ba` | ✅ 干净 | 纯文档 |

若要全部回退，按**逆序**执行 —— 这也不是形式要求：`9211da8` 把三个公开脚本改成了调聚合器、并把原链改名为 `test:chain` 等，而 `6a83f2c` / `f38d9e2` 各自往**当时的** `test` 链里插过脚本名。先退聚合器，`package.json` 回到旧形状，后面两个 revert 才能干净落地。

```
git revert 0b76e97   # P2.2：ExitCodeProvided + ShouldCheck 严格布尔（纯门禁模块 + 测试）
git revert 5f11964   # P2.1：公网门禁 fail-closed 决策函数
git revert fe0b305   # 聚合器 spec 的 tsc-after-failure 用例（纯测试）
git revert 9211da8   # 测试聚合器（纯测试基础设施，src/ 零改动）
git revert 6a83f2c   # CI: agent-core JVM 测试接入
git revert f38d9e2   # 契约测试静默 skip 守卫
git revert b302501   # 公网隧道门禁
git revert 20b65ba   # 审计文档的复核修订（可选，纯文档）
```

> **⚠️ P2.2 之后新增的一条顺序依赖**（`git apply --check -R --3way` 实测）：`5f11964` **不再能单独回退**了 —— `0b76e97` 改了同一批文件（`scripts/gateway-patch-gate.ps1`、`gateway-public-gate-spec.mjs`），实测报 `Applied patch to 'scripts/gateway-patch-gate.ps1' with conflicts`。**必须先退 `0b76e97`**。`0b76e97` 自身可单独干净回退。（§九 记载的"演练 B：只 revert `5f11964` 干净"是**当时 HEAD 下**的事实，仍然准确，只是不再适用于当前 HEAD。）

`ad2a6ab`（审计基线冻结）**不要回滚** —— 它是原始审计版本的唯一存档。

**回滚后的已知后果**：

| revert | 后果 | 严重度 |
|---|---|---|
| `b302501` | 公网隧道重新绕过鉴权门禁 → 配对码铸造对**整个互联网**可达 | **高**，应视为临时回退 |
| `f38d9e2` | 同时移除 `signing-verify.yml` 的 `DSH_GATEWAY_PLUGIN_DIR`，该 workflow 回到"契约断言静默跳过"的假绿状态 | **高**，应视为临时回退 |
| `5f11964` | 公网门禁退回 `if ($gate.ShouldCheck)` 判定 → patch-script-missing / plugin-not-installed / 探测假阴性三条"无法确认"路径重新静默放行；行为测试也被一并删除 | **高**，只应临时回退 |
| `0b76e97` | 检查器没给退出码时重新被读成"通过"（`[int]$null`→0），且 `ShouldCheck` 非布尔值可绕过 → 公网放行。同时移除 LAN 承重行为（转换异常）的守卫 | **高**，只应临时回退 |
| `6a83f2c` | `release` job 的 `needs` 退回 `[test, desktop]`，38 个 JVM 测试重新不被 CI 执行 | 中 |
| `9211da8` | 测试链退回 `&&` 串联，第一个失败之后的结果全部丢失（回到 BUG-01 描述的行为） | 中 |
| `fe0b305` | 仅移除一条 spec 用例；聚合器行为不变，但"tsc 在前置失败时仍执行"失去回归保护 | 低 |
| `20b65ba` | 仅文档；三条被复核推翻的审计结论会恢复成原样 | 低 |

---

## 九、P2.1 交付验收修正（2026-11-11，第二方复核驳回后）

第二方复核认可 P2 主要成果，但**暂不允许合并**，理由是 SEC-01 的公网门禁留了一条未覆盖的放行路径。**复核意见成立**，且比它描述的更严重一点。

### 缺口的真实形态

`Test-GatewayPatchApplied` 有**四条**返回路径，其中三条是 `ShouldCheck = $false`：

| # | 触发条件 | ShouldCheck | ExitCode | Reason | P2 的隧道脚本怎么处理 |
|---|---|---|---|---|---|
| 1 | `$Skip` | false | 0 | `SkipGatewayPatchCheck` | 隧道显式传 `-Skip:$false`，理论不可达 |
| 2 | `-not $PluginInstalled` | false | 0 | `plugin-not-installed` | **静默放行** |
| 3 | `-not (Test-Path $PatchScript)` | false | 0 | `patch-script-missing` | **静默放行** |
| 4 | 其余 | true | 检查器退出码 | `''` | 非 0 才拒绝 ✅ |

P2 写的判定是 `if ($gate.ShouldCheck) { ... }`，所以第 2、3 条**直接跳过门禁**，脚本继续走到 `schtasks /Create` 并启动 DSH、发布到公网 cloudflared URL —— 而此时**没有任何人确认过 `/mgw/*` 是否有认证**。

### 为什么 `plugin-not-installed` 是最危险的一条

它来自一次**路径探测**，而三处路径来源互不一致（均已实读确认）：

| 位置 | 插件目录来源 |
|---|---|
| `start-tunnel.ps1:238` | `$env:DSH_HOME`，否则 `%USERPROFILE%\.dsh` |
| `setup-gateway.ps1:35,58` | **硬编码** `%USERPROFILE%\.dsh` |
| `apply.mjs:57-67` | `os.homedir()` |

一旦 `DSH_HOME` 指向别处，探测就**假阴性**：插件其实装着、`/mgw/*` 其实开着且无认证，门禁却判定"不适用"而放行。

关于「插件未安装时是否仍有可访问的管理接口」（复核任务一.5 要求先确认）：`/mgw/*` 由**上游插件独家提供**，仓库内没有 DSH 核心实现（证据：`patches/mobile-gateway-mgmt-auth/patch.mjs:6`「上游 `dsh-plugin-mobile-gateway`（0.10.3 / 0.11.1 均如此）把 `/mgw/*` …」）。所以"插件真的没装"时确实没有管理接口。**但"探测不到"不等于"真的没装"** —— 按复核要求采取默认拒绝，不允许未经验证就静默放行。

### 修法

新增 `Resolve-PublicTunnelGatewayGate`（`scripts/gateway-patch-gate.ps1`），**只有一条放行路径**：`ShouldCheck = $true` 且 `ExitCode` 严格为整数 `0`。其余全部拒绝：

| 输入 | Reason | 结果 |
|---|---|---|
| `ShouldCheck=true` + `ExitCode=0` | `patch-verified` | ✅ **唯一放行** |
| `ShouldCheck=true` + `ExitCode≠0` | `patch-not-applied` | ❌ |
| `ShouldCheck=true` + `ExitCode` 非整数 | `exit-code-unknown` | ❌ |
| `ShouldCheck=false` + `SkipGatewayPatchCheck` | `skip-not-allowed-on-public` | ❌ |
| `ShouldCheck=false` + `plugin-not-installed` | `plugin-probe-inconclusive` | ❌ |
| `ShouldCheck=false` + `patch-script-missing` | `patch-script-missing` | ❌ |
| `ShouldCheck=false` + `Reason` 为空或未识别 | `unknown-state` | ❌ |
| gate 缺 `ShouldCheck`/`ExitCode`/`Reason` 任一字段 | `gate-result-malformed` | ❌ |
| gate 为 `$null`（检查器抛异常） | `gate-result-missing` | ❌ |

两个实现细节值得记录：

1. **退出码判定用类型检查而不是强制转换**。`[int]$null` 在 PowerShell 里等于 `0` —— 若直接 `[int]$Gate.ExitCode`，"检查器没给退出码"就会被折叠成"检查通过"。这个折叠是**实测到的**：注入一个只返回 `@{ Output = ... }` 的检查器，模块返回 `GATE|True|0|`。
2. **`Test-GatewayPatchApplied` 的语义逐字未改**。收紧只发生在公网侧的翻译层，因此局域网路径 `start-dsh-web.ps1` 的行为、`-SkipGatewayPatchCheck` opt-out、以及拒绝文案**全部保持不变**（文案的新分支一律 gated 在 `-Public` 之内）。

`start-tunnel.ps1` 另加 `try/catch`：检查器抛异常时得到 `$gate = $null` → 显式拒绝，而不是让未捕获错误"顺便"充当拒绝理由（那既不可测也说不清原因）。

### 验证：为什么是「提取代码块执行」而不是「跑整个脚本」

复核要求"测试必须执行实际门禁函数…不能仅依赖源码字符串匹配"，同时"使用隔离测试环境，不启动真实公网隧道"。**跑整个 `start-tunnel.ps1` 做不到第二点**，已实测确认两条危险路径：

- `-Stop` 分支（`start-tunnel.ps1:151`）执行 `Get-Process -Name cloudflared | Stop-Process -Force` —— **杀掉全机所有 cloudflared 进程**，包括用户正在用的隧道。
- 门禁之后第一个动作是 `Get-DshPath`（`:120-130`），其候选里有硬编码的 `E:\DSH\resources\runtime\cli\bin\dsh.cmd`，而**该文件在本机真实存在**。于是 `if (-not $dshExe) { exit 1 }`（`:315`）不会触发，脚本会继续走到 `schtasks /Create` + `/Run`（`:333-335`），**真的建计划任务并启动真实 DSH**。

所以 `gateway-public-gate-spec.mjs` 的做法是：从 `start-tunnel.ps1` 里**原样提取**门禁代码块（锚点 `:220` 与 `:257`，均已核实唯一），在 fixture 环境中执行。它跑的是**真实生产代码文本**，但物理上到不了 schtasks / cloudflared。配套断言确保提取没有跑偏：代码块长度 > 200、必须含 `Test-GatewayPatchApplied`、且**不得含** `schtasks` / `Start-Process` / `cloudflared`。

fixture 用**真实的** `apply.mjs` + `patch.mjs`（一起复制，因为前者 import 后者），所以 `--check` 的判定逻辑是真的，不是桩。

### 测试结果

| 阶段 | `gateway-public-gate-spec` | 说明 |
|---|---|---|
| **修复前** | **51 通过 / 29 失败** | 三条"无法验证"场景真实跑过门禁：`exit=0` 且打印 `GATE_PASSED` |
| **修复后** | **89 通过 / 0 失败** | 全部 8 个要求场景 + 反向对照 |
| **变异反证**（决策函数改成恒 `Allow=$true`） | **55 通过 / 34 失败** | 所有"拒绝"断言转红、"放行"断言仍绿 → 双向非恒真 |

覆盖的场景（复核任务二的 7 项全部命中）：补丁正常→放行；补丁未生效→拒绝；检查脚本缺失→拒绝；插件文件不完整→拒绝；检查器异常退出（`exit 7` 与未捕获异常两种）→拒绝；检查状态未知（`$null` gate、缺字段、`Reason` 为空/未识别、非整数退出码共 14 例）→拒绝；`-Status` 真实执行 exit 0 未被拦、`-Stop` 顺序断言。

**反向对照**：检查器只往 stderr 写东西但退出 0 时**仍应放行** —— 守的是 `gateway-patch-gate.ps1:102-114` 记载的坑（调用方是 `$ErrorActionPreference='Stop'`，若 runner 没临时改回 `Continue`，stderr 会变成终止错误，把"通过"误判成"异常"）。本 spec 开发时独立地又踩了一遍同一个坑，可见那段注释不是多余的。

既有 `gateway-startup-gate-spec` 同步收紧：把匹配旧写法的 `if ($gate.ExitCode -ne 0)` 断言换成匹配新接线，并新增**反向断言**「隧道脚本不得再用 `if ($gate.ShouldCheck)`」，防止旁路被重新引入。该 spec **54 通过 / 0 失败**（回滚 `5f11964` 后为 50/4）。

### 回滚演练（真实执行，非推断）

在 `git worktree` 临时副本里做了两轮真实演练：

**演练 A —— 全量回退**：按逆序 `git revert` 六个代码 commit（`5f11964 → fe0b305 → 9211da8 → 6a83f2c → f38d9e2 → b302501`），**六个全部干净落地**，随后 `git diff --stat 2325d34 HEAD -- . ':(exclude)docs/audits'` **输出为空** —— 回滚精确复原到审计基线。

**演练 B —— 单项回退**：只 `git revert 5f11964`，确认 (a) revert 干净；(b) 决策函数从模块里消失（出现次数 0）；(c) `start-tunnel.ps1` 里 `if ($gate.ShouldCheck)` **复活**（出现次数 1）；(d) 把 HEAD 版的两个 spec 拷回副本执行，`gateway-public-gate-spec` **转红且症状与修复前一致**（`exit=0` + `GATE_PASSED`），`gateway-startup-gate-spec` **50 通过 / 4 失败**。

结论：**回滚确实会移除保护，而测试确实能检出这种移除**。两个演练副本已用 `git worktree remove` 清理并 `prune`，主工作区未受影响（`git status` 干净）。

### 本轮完整链结果

| 命令 | 结果 |
|---|---|
| `npm test` | **107 条 / 107 通过 / 0 失败 / 483.5s / exit 0**（含 `tsc --noEmit`：已执行且通过） |
| `npm run test:integration` | **5 / 5 通过，23.7s** |
| `npm run test:node20` | **5 / 5 通过，6.6s** |
| `./gradlew :agent-core:test` | **BUILD SUCCESSFUL in 52s**；原始 XML：AgentLoopTest 14 + CloudModelClientTest 13 + FileRunStoreTest 7 + RunRecoveryTest 4 = **38 testcase，0 failures，0 errors，0 skipped**。本次**零网络拉取**（junit 已缓存） |

链命令数 106 → **107**（新增 `test:publicGate`，插在 `test:startupGate` 之后，即第 7 位）。

### Node 20 兼容性复核（逐行扫描，区分代码与注释）

本机只有 Node v24.13.0，**无 nvm、无第二个 Node**，因此无法真实执行 Node 20 —— 这点必须标明。改为逐行静态扫描 8 个新增/修改文件：

| API | 最低版本 | 代码级命中 |
|---|---|---|
| `import.meta.dirname` | **20.11** | 3 处：`android-jvm-tests-ci-spec.mjs:49`、`contract-skip-guard-spec.mjs:55`、`gateway-startup-gate-spec.mjs:56`（**既有**） |
| `run-suite.mjs` / `suite-runner-spec.mjs` | — | **代码级 0 命中**，只在注释里出现（解释为什么不用） |
| `gateway-public-gate-spec.mjs`（本轮新增） | — | **0 命中**，用 `fileURLToPath(import.meta.url)` |
| `toSorted` / `Array.fromAsync` / `Object.groupBy` / `Promise.withResolvers` / `process.getBuiltinModule` / `node:sqlite` / `navigator.` / `fs.glob` | 20~22+ | **全部 0 命中** |

**结论**：聚合器本身（`run-suite.mjs`）兼容 **Node 20.0**；但**测试套件整体的事实下限是 Node 20.11**，因为全仓有 **16 个**测试文件在代码里用 `import.meta.dirname`（其中 14 个是 P2 之前就存在的）。这是**既有状态，不是 P2 引入的**：我新增的两个 spec 只是沿用了仓库惯例。

残余不一致：`package.json` 的 `engines` 写 `>=20`，而事实下限是 `>=20.11`。CI 的 `node-version: 20` 会被 setup-node 解析成最新的 20.x（≥20.11），所以**CI 上不会出问题**；只有在 Node 20.0~20.10 上手动跑才会炸。**本轮未改 `engines`**（改它属于超出授权范围的声明变更），仅记录在此。

### 只能在 GitHub Actions 上完成的验证

已用 YAML 解析器（`yaml`，仅作一次性校验用，**未**写进任何提交的 spec —— 它只是传递依赖）确认两个 workflow 的触发器：

```
android.yml        on: { push: { tags: ['v*'] }, workflow_dispatch: {...} }
signing-verify.yml on: { workflow_dispatch: {...} }
```

即：**没有 PR 触发，没有分支 push 触发**。因此以下各项**在本轮约束下（不推送、不建 tag、不发布）无法验证**：

| 待验证项 | 为什么只能在 CI 上做 | 触发它需要什么 |
|---|---|---|
| `jvm-tests` job 在 ubuntu-latest 上是否通过 | 本机是 Windows + 本地 SDK（`E:/Android/Sdk`）；CI 要现装 SDK/NDK。`configure-on-demand` 未开启 → 会配置 `:app`，而 `app/build.gradle:86` 声明了 `ndkVersion`，故 `:agent-core:test` 是否需要 NDK 才能完成配置阶段**只有 CI 能回答** | push tag `v*`，或手动 `workflow_dispatch`（且分支需先推到远端） |
| `signing-verify.yml` 补 `DSH_GATEWAY_PLUGIN_DIR` 后是否变红 | 那 15 条契约断言在该 workflow 里**从未真正执行过**；补上后会第一次运行。若上游插件与客户端已漂移就会立刻变红 —— 这是期望结果，但无法预知 | 该 workflow **只有** `workflow_dispatch`，永不自动运行 |
| 完整链在 Node 20 / ubuntu-latest 上是绿是红 | 本机是 Node 24 / Windows，两者在 `WebSocket` 全局对象、路径语义、PowerShell 版本（5.1 vs pwsh 7）上有差异。`test:node20` 只是**模拟**（删掉 Node 21+ 全局 API），不是真 Node 20 | `test` job 随 tag push 或 dispatch 运行 |
| 新增门禁在 Linux + pwsh 7 上的行为 | `gateway-public-gate-spec` 依赖 PowerShell；本机是 Windows PowerShell 5.1。`findPowerShell()` 在 Linux 上会选 `pwsh`，但**脚本是写给 5.1 的**（TEST-16 已记录这个既存风险） | 同上 |

---

## 十、P2.2 边界修正（2026-11-11，`[int]$null` 折叠）

P2.1 报告 §1.2 里记录过这条残余风险，但当时**只在模块层做了诊断，没有在公网决策层堵住**。本轮把它关掉。

### 缺口

`[int]$null` 在 PowerShell 里等于 **0**。所以检查器"什么都没说"时，`Test-GatewayPatchApplied` 返回的 `ExitCode` 是 0 —— 与"检查通过"**完全无法区分**，而 `Resolve-PublicTunnelGatewayGate` 拿到的已经是折叠后的值，无从识别。

用**两个真实函数在同一个 PowerShell 进程里串起来**复现（不是重新实现任何一端）：

```
COMP|True|patch-verified
```

即：检查器没给退出码 → 公网隧道**放行**。

实测到的折叠形态有 6 种：缺 `ExitCode` 键、`ExitCode=$null`、`ExitCode=''`、返回字符串而非哈希表、什么都不返回、以及 `ExitCode=$false`（`[int]$false = 0`，**最隐蔽的一条**）。

另有 1 种**不折叠而是抛异常**：`ExitCode='not-a-number'` → `[int]` 转换失败。

### 顺带发现并一并堵住的第二个缺口

`Resolve-PublicTunnelGatewayGate` 原先写的是 `if ($Gate.ShouldCheck)`。而 PowerShell 里 **`if ('false')` 为真**（非空字符串一律 truthy），所以 `ShouldCheck = 'false'`（字符串）会被当成"需要检查"，再配上 `ExitCode = 0` 就**放行**。同类还有 `ShouldCheck = 1`、`'true'`。

### 修法（最小范围）

1. `Test-GatewayPatchApplied` 在 `[int]` 转换**之前**把事实记下来，作为**纯附加字段** `ExitCodeProvided`（bool）。四条返回路径都带这个字段，使 gate 对象形状统一。
2. `Resolve-PublicTunnelGatewayGate` 增加两道严格类型检查：
   - `ShouldCheck -isnot [bool]` → 拒绝（`shouldcheck-not-boolean`）
   - `ExitCodeProvided` 必须**存在且严格为 `$true`** → 否则拒绝（缺失算 `gate-result-malformed`，为 `$false` 算 `exit-code-not-provided`）

放行路径因此收紧为三个条件同时成立：`ShouldCheck` 严格布尔 `$true`、`ExitCodeProvided` 严格布尔 `$true`、`ExitCode` 严格整数 `0`。

### 为什么 `[int]$result.ExitCode` 那行**必须原样保留**

它对局域网是**承重**的。`start-dsh-web.ps1` 没有 `try/catch`，所以 `ExitCode='not-a-number'` 时的转换异常会让脚本非零退出 —— **崩溃即拒绝**。若把这行改成"安全地回退成 0"，局域网就会从"拒绝"变成"`ExitCode=0` 即放行"，那是把 LAN 改坏。

这一点由变异 C 实测证明：把该行改成 `$(if ($codeProvided) { [int]$rawCode } else { 0 })` 后，spec 从 136/0 变成 **135 通过 / 1 失败**，失败的正是"模块抛转换异常（刻意保留）"那条，模块输出从 `THREW|...` 变成 `GATE|True|0|`。

### 局域网行为未变的**差分证明**

不靠推理，靠执行：把修复前的模块（`git show HEAD:scripts/gateway-patch-gate.ps1`）与修复后的模块，用同一个驱动器跑**同样的 9 个场景**，比较局域网会读到的四个字段：

```
场景           修复前                                 修复后
skip           SC=False|EC=0|RS=SkipGatewayPatchCheck|OL=0     （相同）
no-plugin      SC=False|EC=0|RS=plugin-not-installed|OL=0      （相同）
no-script      SC=False|EC=0|RS=patch-script-missing|OL=0      （相同）
code-0         SC=True|EC=0|RS=|OL=2                           （相同）
code-1         SC=True|EC=1|RS=|OL=10                          （相同）
no-code        SC=True|EC=0|RS=|OL=7                           （相同 ← 折叠仍然发生，LAN 语义不变）
null-result    SC=True|EC=0|RS=|OL=0                           （相同）
str-result     SC=True|EC=0|RS=|OL=0                           （相同）
bad-str-code   THREW                                           （相同 ← 崩溃即拒绝被保留）
```

`diff -u` 输出为**空** → 9/9 场景逐字相同。

### 测试结果

| 阶段 | `gateway-public-gate-spec` |
|---|---|
| **修复前** | **101 通过 / 31 失败** |
| **修复后** | **136 通过 / 0 失败 / 0 跳过** |

新增覆盖：§4b 六种折叠形态各自断言 `ExitCodeProvided=False`；四种**给了合法整数码**的形态（0 / 1 / `'0'` / −1）断言 `=True`（否则"收紧"会退化成"永远拒绝"，把正常启动也挡掉）；§4c 真实组合验证 8 条必定拒绝 + 2 条反向对照（给 0 → 放行、给 1 → 拒绝）；§5 决策函数新增 `ExitCodeProvided` 三态、`ExitCode` 为 `$null`/`'abc'`/`''`/`$true`/`0.0`、`ShouldCheck` 为 `'false'`/`'true'`/`$null`/`1`/`0` 共 13 条负向用例。

**三个变异反证**（全部语法有效）：

| 变异 | 结果 | 失败的正是 |
|---|---|---|
| A：去掉 `ExitCodeProvided` 检查 | **129 / 7** | 6 条组合验证 + 1 条决策用例，全部显示 `COMP\|True\|patch-verified`（放行） |
| B：去掉 `ShouldCheck` 严格布尔检查 | **133 / 3** | `'false'` / `'true'` / `1` 三条，全部 `DEC\|True\|patch-verified` |
| C：把 `[int]` 转换改成安全回退 | **135 / 1** | "模块抛转换异常（刻意保留）" —— 即上文所述 LAN 回归 |

### 开发中被测试自己纠正的两处预期错误

1. 最初把 `ExitCode='not-a-number'` 归入"折叠成 0"类，实测发现它是**抛异常**（`Cannot convert value "not-a-number" to type "System.Int32"`）。已按真实行为改为断言 `THREW`，并把它变成 LAN 承重行为的守卫。
2. 最初把 `ExitCode=$true` 也归入抛异常类，实测 `[int]$true = 1`，**不抛**。已改归入折叠类，并补上 `$false`（`[int]$false = 0`）这条最危险的形态。

两处都是"先按想象写断言、被真实执行纠正"，已写进 spec 注释。

### 既有测试无回归

`gateway-startup-gate-spec` **54/0**、`mobile-gateway-patch-spec` **24/0**、`desktop-packaging-spec` **31/0**、`butler-installer-spec` **23/0**。三个 `.ps1` PS 5.1 解析 PARSE_OK、BOM 完好。

**完整链**（CI 调用的同一条命令 `npm test`）：

```
套件汇总：107 条命令，107 通过，0 失败，耗时 371.4s
全部通过。
类型检查（tsc --noEmit）：已执行且通过
P22_NPM_TEST_EXIT=0
```

链命令数仍为 **107**（本轮没有新增 spec 文件，只是扩充了 `gateway-public-gate-spec.mjs`：89 → 136 条断言）。

### 未触碰

`start-dsh-web.ps1` **零改动**（局域网行为完全不变，已由差分证明）；`start-tunnel.ps1` **零改动**（P2.1 的接线已经会把新的拒绝原因透传给 `Write-GatewayPatchRefusal -Public -Reason`）；门禁架构未重构（只是在既有函数上加了一个附加字段与两道类型检查）；Android 核心业务代码零改动。

---

*§一~§七 由只读审计产生，未修改任何业务代码；所有引用位置均来自真实读取的代码，标注为"待验证"的项已说明未能验证的原因。*
*§八 是 2026-11-11 复核后实施轮（P2）的记录。§九 是同日 P2.1 交付验收修正的记录。§十 是同日 P2.2 边界修正的记录。三轮都改动了测试、CI 与启动脚本，但 `dsh-mobile/src/` 下始终零文件改动。原始审计版本由 `ad2a6ab` 冻结，全部修订发生在独立分支 `opt/p2-review-remediation` 上。*
