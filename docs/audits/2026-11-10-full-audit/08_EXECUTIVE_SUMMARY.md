# 08 · 执行摘要

| 项 | 值 |
|---|---|
| 审计对象 | DSH Outpost（`E:\work\dsBot-opt`） |
| 审计基线 | HEAD `2325d34`，分支 `opt/p1-phone-polish`，工作树干净，主分支 `main`，git user `xisnn` |
| 仓库规模 | **559 个受版本控制的文件** |
| 审计角色 | 高级软件架构师 / 代码质量审计工程师 / 可靠性工程师 |
| 审计方式 | 阶段 A 摸底 → 阶段 B 七路只读子 Agent 并行（架构 / Android / 通信 / 安全 / 性能 / 测试 / 主机侧）→ 阶段 C 本人逐条复核 → 阶段 D 方案排序 |
| **业务代码修改** | **0 —— 本轮只审计，未修改任何业务代码**（唯一新增：`docs/audits/2026-11-10-full-audit/` 下 8 份文档） |
| 密钥/隐私 | **未读取、未输出、未上传任何密钥、Token、证书私钥或用户隐私数据** |
| 外部服务 | **未访问任何外部服务、未安装任何工具、未调用任何收费 API** |
| 执行的命令 | **仅只读检查**；真实执行过 4 个只读 spec（见 `05` §〇），未执行任何构建 / 安装 / gradlew / 完整测试链 |

---

## 一、项目整体代码质量评价

### 一句话结论

> **这是一份工程成熟度明显高于平均水平、但"验证层"存在系统性缺陷的代码库。**
> 它的债务是**结构性**的（模块边界、重复实现、测试可达性），**不是腐烂性**的。

### 支撑这个判断的客观事实

**卫生状况：极好（客观可验证）**

| 检查 | 结果 |
|---|---|
| 全仓 TODO / FIXME / HACK / deprecated 标记 | **0** |
| 全仓注释掉的代码 | **0** |
| 已提交的活跃密钥 | **0**（`debug.keystore` 是公开的 AOSP 默认，且因 `build.gradle:221-252` 的 taskGraph hook **无法用于签 release**） |
| 大小写不匹配的 import（Linux checkout 风险） | **0 / 665**（逐一与磁盘文件名比对） |
| 假绿测试（`xit` / `.skip` / `.todo` / `process.exit(0)`） | **0**（全树只有 1 处 `process.exit(0)`，在手工脚本里，不在任何链中） |
| lockfile 里的重复依赖版本 | **0**（恰好一个 react 19.1.0、一个 react-native 0.81.4） |

**设计纪律：罕见的强**

| 体现 | 证据 |
|---|---|
| **fail-closed 一致性** | 补丁缺 hook → 503；版本不符 → 拒绝启动；floor 缺失 → 抛错；证书变量缺失 → CI **硬失败**而非警告；损坏的 run JSON → FAILED + `requiresReconciliation`；畸形 SSE → protocol-error Failure（**永不是空 success**）；无限等待审批 → 默认 **REJECT** |
| **注释记录"为什么"而不是"是什么"** | `deviceRevocation.ts:30-36` 记录了为什么 `unknown` 永不意味着"未吊销"；`transport/index.ts` 记录了为什么必须有 `signal`；`fold/index.ts` 记录了为什么必须统一三种 callId 字段；`fingerprint.ts:8-9` 明确写"**不能用于自动复用 requestId**" |
| **有界性纪律** | 附件缓存 32 条 / 24MB / 128 失败（LRU）；banners 上限 3；`authoritativeApprovalAt` 200；`resolvedApprovalIds` 100；别名 200；回填安全上限 <10 / maxMessages 200；prune 把终态 run 压到 60；工具结果 16,000 字符裁剪 + 只留最近 4 条 |
| **无重试纪律** | `CloudModel.kt` / `Http.kt` **任何地方都没有重试逻辑** → 不会有重复的非幂等 POST；且**禁用重定向**（`:45`），所以 `Authorization` 永不跨 host 重放 |
| **写后读回校验** | `PendingSendStore.save`（写 → 读回 → 逐字节比对 → 才提交内存）；`RuntimeJournal`（读回校验的原子 journal）；四处凭据写入全部读回校验 |

**特别值得指出的两处工程亮点：**

1. **`RuntimeInstaller.java`** —— inventory-pinned 解包、archive + 逐文件 SHA-256、USTAR-only（禁 hardlink / device / PAX）、`O_NOFOLLOW|O_EXCL|O_CLOEXEC`、payload chmod 0555、`(mode & 0022)==0`、file + directory fsync、`installer.lock` FileLock、崩溃检查点语义、符号链接禁闭、不收养孤儿 release。**这是本轮审计中见过的加固程度最高的移动端安装器之一。**

2. **流式数据管线** —— 四层优化（60ms rebuild 合批 + 60ms emit 节流 + 增量 fold + 投影引用稳定化）都做了，而且**引用稳定化被真实测试测量过**（`streaming-perf-f03-spec.mjs:353-358` 断言内容未变的 Turn / ChatItem / WorkGroup 引用 100% `===` 复用）。

### 但存在一个系统性缺陷

> **"测试是绿的"在当前不是一个可信前提。**

三个独立缺陷叠加造成：

| 缺陷 | 后果 |
|---|---|
| **BUG-01 / TEST-01**：103-spawn `&&` 链 | 第一个失败即中断，后面的测试从不运行；**`tsc --noEmit` 是最后一环，任何测试失败都会导致类型检查根本不跑** |
| **TEST-02**：`component-harness.mjs:17-18` 硬编码 `+ '.ts'` | 一个过期的 `.tsx` mock → ENOENT → **进程 abort**（不是测试失败，是崩溃），结合上一条带走整条链。**这是提交 `9c17dbd` 的结构性成因** |
| **TEST-03**：CI 下 `skip` 不影响退出码 | 若干 spec 在 CI 里**静默跳过**，报告仍然绿 |

**再叠加两处"已有测试从不执行"：**

| 项 | 数量 |
|---|---|
| `:agent-core:test` 从未被 CI 调用 | **38 个已经写好的 JVM 单元测试**（`AgentLoopTest` 14、`CloudModelClientTest` 13、`FileRunStoreTest` 7、`RunRecoveryTest` 4） |
| `RuntimeInstallerChecks.java` 不是 JUnit | **约 40 项极好的失败注入检查**（9 个崩溃检查点 × 安装/回滚、6 条穿越路径、7 种禁止的 tar 类型、符号链接禁闭、损坏指针 fail-closed）**从不自动运行** |

**这是本次审计最可惜的发现：项目写出了高质量的原生测试，却没有把它们接进 CI。修法是加一行 `./gradlew :agent-core:test`。**

### 质量评级

| 维度 | 评级 | 说明 |
|---|---|---|
| 代码卫生 | **A** | 零 TODO / 零注释代码 / 零假绿 / 零活跃密钥 |
| 设计纪律（fail-closed / 有界性 / 幂等） | **A** | 罕见的一致，且注释记录了理由 |
| 安全实现 | **A-** | 23 项已核实正确的控制；扣分项是覆盖面缺口（SEC-01 隧道绕过门禁）与几处未检查的返回值（SEC-06） |
| Android 原生 | **A-** | 六个历史修复全部在 HEAD 完整；生产代码无协程；Promise 单结算；扣分项是 BUG-05（API 级守卫缺失）与 BUG-10（缺 `onTimeout`） |
| DSH 通信核心 | **A-** | 六项历史修复全部在，四项有真实的强测试；扣分项是 fold 工具结果绑定的不对称（BUG-03） |
| 架构 / 模块边界 | **C+** | `Store` 上帝对象、三个 Agent 后端无共享接缝、wire 形状泄漏到传输层之外、四条凭据路径绕过统一入口 |
| 代码重复 | **C** | 13 组重复，**其中 4 组已经漂移出真实缺陷** |
| **测试可达性与广度** | **D** | 40% 的 `dsh-mobile/src` 文件未被证明执行过；桌面端 EXEC 0/3；34 个 `.tsx` 从不渲染；零覆盖率工具 |
| **CI 工程化** | **C-** | 发布门禁的密码学部分做得很好，但 `release-gate.mjs` 是死的、CI 不打 gateway 补丁、所有 `.ps1` 只在 pwsh 7 下验证过（产品跑在 5.1） |

---

## 二、已确认的问题数量及严重程度

### 总数

**71 个编号条目 → 68 项独立缺陷**（另有 17 项子条目）。

扣减过程（可复核）：71 个编号 − `ARCH-11`（可扩展性评估结论，非缺陷）− `CQ-09`（客观复杂度数据，非缺陷）− `TEST-01`（与 `BUG-01` 是同一问题的两个视角，不重复计数）= **68**。

| 类别 | 编号数 | 其中缺陷数 |
|---|---|---|
| ARCH（架构） | 11 | 10（`ARCH-11` 是评估结论，非缺陷） |
| CQ（代码质量） | 9 | 8（`CQ-09` 是客观数据，非缺陷）+ 7 个子项（`CQ-01a–e`、`CQ-03a/b`） |
| BUG | 18 | 18 + 10 个子项（`BUG-18a–j`） |
| SEC（安全） | 8 | 8 |
| PERF（性能） | 7 | 7 |
| TEST（测试/CI） | 18 | 17（`TEST-01 ≡ BUG-01`） |
| **合计** | **71** | **68** |

### 按严重程度

下表对 68 项缺陷逐条计数，**行内条目数相加 = 68**，与各文档标题上的严重度标签逐条核对一致（PERF 系列在 `04` 中不带严重度标签，其档位是本摘要按影响面做的归类，已在表中标明）。

| 严重程度 | 数量 | 条目 |
|---|---|---|
| **Critical** | **1** | BUG-01（≡ TEST-01）—— `&&` 链使回归信号不可信 |
| **High** | **16** | BUG-02/03/04/05/06/07/11（7）、SEC-01/02（2）、ARCH-01/02（2）、CQ-01（1）、TEST-02/03/06/14（4） |
| **Medium 档**（含 Medium-High 与 Low-Medium） | **43** | ARCH-03~07（5）、CQ-02~07（6）、BUG-08/09/10/12/13/14/15/16/17（9）、SEC-03~06（4）、TEST-04/05/07/08/09/10/11/12/13/15/16/17/18（13）、PERF-01/02/03/04/05/06（6，档位为本摘要归类） |
| **Low** | **8** | ARCH-08/09/10（3）、CQ-08（1）、SEC-07/08（2）、PERF-07（1，档位为本摘要归类）、BUG-18（1，其 10 个子项 BUG-18a–j 同为 Low） |
| **合计** | **68** | 1 + 16 + 43 + 8 |

> **按类别看 High 的分布**：BUG/SEC 类 **9** 项（BUG-02、03、04、05、06、07、11 + SEC-01、02）、架构类 **2** 项（ARCH-01、02）、质量类 **1** 项（CQ-01）、测试/CI 类 **4** 项（TEST-02、03、06、14）。四类互不重叠，合计 **16**。
>
> **Medium-High 单列（5 项，Medium 档中最该先看）**：TEST-04（三个互不同步的 Cookie jar）、TEST-12（34 个 `.tsx` 从未被渲染）、TEST-13（Android 构建可复现性缺口）、TEST-16（CI 无 timeout + PowerShell 版本错配）、TEST-17（原生测试覆盖严重偏斜）。

### 按证据强度（宪章要求的三分类）

| 分类 | 数量 | 说明 |
|---|---|---|
**注意：三分类标签只用于 ARCH / CQ / BUG / SEC 这 44 项**（它们的条目标题上带显式标签）。TEST 的 17 项与 PERF 的 7 项使用各自的证据格式，不套用这三分类，因此下表分开计数，**不把它们折算进 44**。

| 分类 | 数量 | 说明 |
|---|---|---|
| **已确认问题** | **34 项**（ARCH/CQ/BUG/SEC 内） | 均由本人直读代码复核，含具体文件路径与行号：ARCH-01~05/07~10（9）、CQ-01/02/04~08（7）、BUG-01~08/13/14/15/17/18（13）、SEC-01/04/05/06/08（5） |
| **高可信风险** | **8 项**（ARCH/CQ/BUG/SEC 内） | 机制已由代码确认，但未构造实际触发：ARCH-06、BUG-09、BUG-10、BUG-11、BUG-12、BUG-16、SEC-02、SEC-03 |
| **复合标签** | **2 项** | `CQ-03` = 已确认（CQ-03a）+ 待验证（CQ-03b）；`SEC-07` = 设置已确认 + 可修性高可信 |
| **待验证假设** | **7 项**（跨类别） | 见下表。其中 ARCH-06 与 CQ-03b 是**同一件事的两处记录**，不重复计为两个缺陷 |
| **TEST / PERF 的证据格式** | 17 + 7 项 | TEST 逐条标注"由 import-graph grep 证明未被加载"或"本轮未执行"；PERF 逐条标注**【已测量】**（指名测试文件与断言行）或**【静态怀疑】**。PERF 中【静态怀疑】的**全部代价数字**都归入上方待验证清单 |

### 待验证清单（**未编造任何结论**）

| 项 | 待验证什么 | 为什么本轮没验证 |
|---|---|---|
| **ARCH-06 / CQ-03b** | `index.js:14-17` 的 `__DEV__` require（`src/dev/P0Harness.tsx`，475 行）是否**真的进了 release bundle** | Metro 不做 tree-shaking，所以静态怀疑是它进了包；确认需要**构建 release bundle 并 grep**——本轮不执行构建。注：`android/app/src/debug/java/com/dshpocket/P0HarnessActivity.kt`（14 行）在 debug source set 里，**那部分确定不进 release**；待验证的只是 JS 侧 |
| **SEC-03** | `xlsx ^0.18.5` 是否有已知漏洞 | **需要访问外部 advisory DB**，宪章第 9 条禁止自动访问外部服务 |
| **TEST-08** | `ubuntu-latest` 是否仍自带 JDK + Android SDK，使 `release-signing-gates-spec.mjs` 的 5 个 Gradle dry-run **真的运行**而非 fail-open | 需要 CI 运行日志（无网络）或执行 gradlew（本轮不执行） |
| **TEST-13 兼容矩阵** | AGP 8.11.0 + Gradle 8.14.3 + Kotlin 2.1.20 + JDK 21 是否互相支持 | 需要访问外部版本兼容表 |
| **`07` §一 行为 2** | fold 的逐 `Step` 去重在 `assistant/message` 与 `tool/call` 携带**不同 `data.step`** 时是否产生两个块 | 需要一段**真实的、step 不匹配的**事件轨迹；本轮未抓取任何真实流量，仓库 fixture 里也没有这种样本 |
| **PERF 全部"静态怀疑"条目** | 单次渲染 / 单次解析的**真实毫秒数** | **本轮未执行任何真机性能测量**。`04` §九 给出了 6 项待执行的测量计划（含工具与阈值） |
| **测试套件当前是绿是红** | —— | **本轮未执行完整 `npm test` / `test:integration` / `test:node20` / `tsc --noEmit`，因此不做任何断言** |

---

## 三、最重要的架构问题

### ARCH-01 · `Store` 是上帝对象 —— **High**

| 项 | 内容 |
|---|---|
| 位置 | `dsh-mobile/src/core/store.ts:351`（类定义），全文 **2 972 行** |
| 证据 | **≥12 项互不相关的职责**集中在一个类里；**17 个 UI 文件**消费它的 **40+ 个成员** |
| 影响 | 任何改动的影响面都无法局部推理；单元测试必须构造整个 Store；**这是 ARCH-03（wire 形状泄漏）与 PERF-01（全局订阅）的共同根因** |
| **为什么现在不能拆** | 拆分需要**同时**改动 17 个 UI 消费方，而 **TEST-12 表明 34 个 `.tsx` 组件从不真正渲染**（`component-harness.mjs:28` 的 `useEffect` 是空函数）。**没有 UI 测试就拆 Store，等于闭眼开车** |
| 建议 | **本轮不动。** 先解决 TEST-12（引入 react-test-renderer），再评估 |

### ARCH-02 · 三个 Agent 后端并存但没有共享接缝 —— **High**

| 项 | 内容 |
|---|---|
| 三个后端 | (A) DSH 云端会话（`DshConnection`）；(B) 端侧云模型 Agent（`NativeModules.OutpostAgent`）；(C) 本地 proot DSH runtime（`NativeModules.OutpostLocalDsh`） |
| 最硬的证据 | **`core/localDsh.ts:3-31` 与 `core/localRuntime.ts:15-52` 的类型定义逐字节相同** —— 同一份契约被复制了两遍 |
| 其它证据 | 两套并行的 memory 系统；**唯一真正的适配器接口是 `butlerClient.ts:121-134` 的 `ButlerClient`**，而它只服务 butler |
| **可扩展性评估（宪章特别要求）** | **当前架构对"多个独立 Agent 后端"的支持度：低。** 三个后端各自从 UI 直达自己的传输层，没有共同的 `AgentBackend` 抽象。新增第四个后端意味着**再复制一遍**类型、memory、生命周期管理 |
| **但有一个可以立刻做的子项** | **合并 `localDsh.ts:3-31` ↔ `localRuntime.ts:15-52` 的逐字节重复类型** —— 只需 `tsc --noEmit` 验证，**零行为风险**，且**不实现新适配器、不改变现有 DSH 协议**（符合宪章约束） |
| 建议 | 真正的接缝抽取**本轮不做**（需要先有 agent 层契约测试）；类型合并可放入阶段 5 |

### ARCH-03 · DSH wire 形状泄漏到传输层之外 —— **Medium**

| 项 | 内容 |
|---|---|
| 证据 | `fold/index.ts:599` 的 `DELEGATING_TOOLS` 硬编码工具名；`toolDiff.ts:177, 193`；`butler.ts:97-116`；`ApprovalBanner.tsx:441` 硬编码字符串 `'allowed-once'`；`ModelSwitcher.tsx:101`；wire 类型被 `TeamBar.tsx:15`、`TeamSheet.tsx:13`、`TaskBoardScreen.tsx:15`、`WorkspacesScreen.tsx:19`、`ChatScreen.tsx:68` 直接 import |
| 影响 | **上游改一个字段名，需要在 10+ 个 UI 文件里找**。这与 `docs/protocol-compat.md` 场景 D 描述的"事件类型改名 → 内容不显示"是同一个风险面，但被放大了 |
| 建议 | **本轮不做**（同样被 TEST-12 阻塞） |

### ARCH-04 · 四条带凭据的 HTTP 路径绕过 `DshConnection` —— **Medium（安全相关）**

| 项 | 内容 |
|---|---|
| 矛盾点 | `core/transport/index.ts:155-158` **声称自己是单一入口**，但实际有四条旁路 |
| 四条旁路 | `approvalGateway.ts:839`、`deviceAuth.ts:170, 258`、`serverIdentity.ts:217`、`updater.ts:58, 240` |
| 为什么严重 | `net-security.ts` 的 `assertSecureUrl` 是**唯一的明文流量边界**（因为 `network_security_config.xml` 在 OS 层允许明文，而 Android 配置无法表达 CIDR）。旁路越多，这个边界越薄 |
| 建议 | **修法是收编，不是放宽门禁。** 且必须**先**给 `net-security.ts`（182 行，当前 TEXT-ONLY）补真实执行测试 |

---

## 四、最大的稳定性风险

### 风险 1 · 回归信号不可信（**Critical，压倒一切**）

**BUG-01 / TEST-01 / TEST-02 / TEST-03 的组合。**

这不是"某个功能有 bug"，而是"**我们无法知道任何改动是否安全**"。它使所有其它风险的修复都变得危险——因为你修完无法验证。

**这就是为什么 `06_OPTIMIZATION_ROADMAP.md` 的阶段 0 只做测试基础设施，不碰业务代码。**

### 风险 2 · 永久挂起的两条路径（**High**）

| 路径 | 编号 | 用户可见症状 |
|---|---|---|
| `call()` 在读响应体**之前**就撤销超时定时器（`transport/index.ts:398` vs `res.json()` @ `:440`） | **BUG-02** | 服务器接受请求但响应体永不完成 → **永久挂起**：界面转圈、连接状态卡在"检测中"、发消息没反应。**这正是 `transport/index.ts` 里那段注释描述过的历史事故类型** |
| `ToolBlock.pending` 只有一处清除点（`fold/index.ts:482`），`turn/end`（`:501-511`）从不清、权威 override（`:904-914`）不下探 | **BUG-03** | **永不停止的工具转圈**，并通过 `toChatItems:650-654` **抑制完成卡片** |

**加重因素**：`timeout-throttle-spec.mjs:72-77` 要求 `clearTimeout` 出现 ≥2 次，**正在 actively 阻止 BUG-02 的修复**。

**讽刺之处**：`request()` 在同一个文件里用 `finally`（`:536-538`）—— **正确写法就在旁边。**

### 风险 3 · 白屏无兜底（**High**）

**BUG-04：全仓 0 个 React 错误边界**（`componentDidCatch` / `getDerivedStateFromError` grep 零命中）。

任何一处渲染期抛错 → **白屏整个 App** → 用户唯一能做的是杀进程重进。

**而 fold 层处理的是上游 wire 数据，形状变化是常态**（`docs/protocol-compat.md` 场景 B/D 明确记录了这一点）。

### 风险 4 · Android 7.0/7.1 必崩（**High**）

**BUG-05**：`AgentModule.kt:154-179` 的三个 memory 方法缺 `supported()` 守卫（该方法就定义在同文件 `:426`，`dismissRecovery` 正在用），而 `AgentMemoryStore.kt` 用 `java.nio.file`（**API 26+**），`minSdkVersion` 是 **24**。

→ 抛 `NoClassDefFoundError`（**Error，不是 Exception**），而 `catch (error: Exception)` **抓不到** → RN 桥接层崩溃。

**修法是 3 行。同文件已有正确范例。**

### 风险 5 · 公网暴露的路径缺少安全门禁（**High，安全**）

**SEC-01**：`start-tunnel.ps1` 对补丁门禁的引用数 = **0**，而 `start-dsh-web.ps1` 有 **4** 处。但 `start-tunnel.ps1:444-476` 会启动 DSH，**并把它发布到公网 cloudflared URL**。

**叠加 TEST-14(d)**：**没有任何 CI 步骤运行 `apply.mjs --apply`**，所以 CI 的集成测试跑的是**未打补丁的 gateway**。

**修法是 dot-source 已有的 `scripts/gateway-patch-gate.ps1`（P0-2）—— 复用已经测好的代码，风险极低。**

### 风险 6 · 三处"改坏了不会被发现"（**High**）

来自 `07_REGRESSION_PROTECTION.md` 的"唯一守卫"分析：

| 承重不变量 | 当前守卫 |
|---|---|
| `openWebSocket` 构造函数的第 3 个参数（headers）是 cookie 到 WebSocket 的**唯一通道**（RN OkHttp 不会自动附加 cookie jar）—— 去掉它会静默 401，症状是"会话一直是空的" | **零** |
| `loginWithToken` **信任 cookie jar 而非状态码**（303 重定向使状态码失去意义）+ **先清 jar 再登录**（`:236-244`）—— 去掉顺序会复活"任何 token 都能通过" | **零**（没有测试断言 303，也没有断言清理顺序） |
| `workspace-fs.js` 的整个沙箱边界（81 行：`inside()` / `verifyRoot()` dev-ino / `fresh()` TOCTOU 重解析 / 符号链接拒绝） | **零测试执行**（TEST-06）——**设计意图只存在于注释中** |

**以及一处守卫单薄：** 行为 4（断线重连历史去重）**全押在 `ws-reconnect-session-recovery-spec.mjs` 单个文件上**。

---

## 五、最值得优先实施的 10 项优化

> 完整分析见 `06_OPTIMIZATION_ROADMAP.md` §一。此处为摘要，按实施顺序排列。

| # | 编号 | 严重 | 一句话 | 成本 | 风险 | 可独立验证 |
|---|---|---|---|---|---|---|
| **1** | **BUG-01 / TEST-01 / TEST-02** | **Critical** | 把 103-spawn `&&` 链换成**收集失败**的 runner；修 `component-harness.mjs:18` 的 `.ts` 硬编码；接入 6 个孤儿 script | 中 | **低**（只改测试基础设施） | ✅ 强 |
| **2** | **SEC-01** | **High** | `start-tunnel.ps1` dot-source 已有的 `gateway-patch-gate.ps1`，在两处 DSH 启动前各调一次 | **极低** | **极低**（复用已测代码） | ✅ 强 |
| **3** | **BUG-04** | **High** | 补 React 错误边界（NavHost 每 entry + ChatScreen 消息行 + App 根） | 低 | **极低**（纯增量） | ✅ 强 |
| **4** | **BUG-05** | **High** | 给三个 memory `@ReactMethod` 补 `supported()` 守卫 —— **3 行**，同文件 `:426` 已有范例 | **极低** | **极低** | ⚠️ 中（需 API 24/25 设备） |
| **5** | **SEC-02** | **High** | `src/main/main.js:671, 691` 把 `pairing.port` 整数校验后再插进 PowerShell 命令串 | **极低** | **极低** | ✅ 强 |
| **6** | **BUG-06** | **High** | `start-tunnel.ps1:439` `Write-Warn`→`Write-Warn2`；`:306-308` `$dshLog`→`$dshLog0` | **极低** | **极低** | ✅ 强 |
| **7** | **TEST-03** | **High** | 把 gateway 插件目录加进 `CANDIDATES`；CI 下 `skip > 0` → **非零退出**（照抄 `gateway-startup-gate-spec.mjs:96-99`） | 低 | 低 | ✅ 强 |
| **8** | **BUG-02** | **High** | **先写测试**（`res.json()` 永不 resolve → 必须有界拒绝），**再**把 `clearTimeout` 移进 `finally`；同步把 `timeout-throttle-spec.mjs:72-77` 的断言从"数出现次数"改成"每个 `setTimeout` 都有配对清理" | 低 | **中**（有测试在阻止） | ✅ 强 |
| **9** | **BUG-03** | **High** | **先写 3 个 fold 测试并确认它们失败**，再修 `fold/index.ts:469-471`（对称提取）、`:483`（不静默丢弃）、`:501-511`（`turn/end` 清 pending）；护栏是 `fold-spec.mjs:189-232` 必须仍绿 | 中 | **中**（重点保护区） | ✅ 强 |
| **10** | **CQ-02 + CQ-04** | **Medium** | 删已证明零引用的死代码（`LocalButlerScreen.tsx` 801 行、4 个死 shim、`jest.config.js`、不可达的 `store.ts:1407`）；修 5 条最危险的文档漂移 | 低 | 低 | ✅ 强 |

### 关于第 10 项的**最危险文档漂移**（本人已核实）

| 文件 | 说的是什么 | 代码实际是什么 |
|---|---|---|
| `docs/protocol-compat.md:42` | 子协议 `dsh-token.<token>` | ❌ |
| `docs/known-issues.md:11, 41` | 子协议 `dsh-token.<token>`，**并把它写成"正确做法"的修复建议** | ❌ |
| **实际代码** | **`dsh-auth.`** | ✅ |
| `core/approvalGateway.ts:546-548` | **有一段显式警告注释，说的正是相反的事** | ✅ |
| `docs/mobile-gateway.md:104`、`docs/security.md:151` | `dsh-auth.` | ✅ **正确** |

**危害**：任何照 `docs/known-issues.md` 去改 `approvalGateway.ts` 的人会**直接把重连改坏**，而且会认为自己在修 bug。

### ⚠️ 第 10 项的一个陷阱

`scripts/release-gate.mjs` **看起来是死代码（TEST-14），但不能删** —— 它应该被**接进 CI**，因为它承载 `apkBytesMax` / `runtimeArchiveBytesMax` / `knownGoodCertificateSha256` 三项门禁。

### 紧随其后的三项（收益/成本比同样极高，未进前 10 只因不属"问题修复"）

| 编号 | 一句话 | 成本 |
|---|---|---|
| **TEST-17(1)** | **CI 加一行 `./gradlew :agent-core:test`** → 38 个已写好的原生测试立刻生效 | **极低** |
| **PERF-03** | 5 秒通知扫描加 AppState 门控（同库 `useChatMetaPolling.ts:33-40` 与 `HostQueuePanel.tsx:56-61` **都做了**门控 → 这是遗漏不是设计） | 低 |
| **TEST-16(1)** | 给 `android.yml` 所有 job 加 `timeout-minutes`（当前只有 `signing-verify.yml:54` 设了 45） | **极低** |

---

## 六、是否适合开展较大范围重构

### 明确结论：**现在不适合。**

### 五条理由（按重要性排序）

**1. 回归信号当前不可信。**
在"第一个失败即中断、`tsc` 是最后一环、过期 mock 会 abort 进程、CI 下 skip 静默通过"的条件下，**任何重构都无法被验证**。这必须最先解决。

**2. UI 层完全没有测试。**
TEST-12：34 个 `.tsx` 从不真正渲染，`component-harness.mjs:28` 的 `useEffect() {}` 意味着 **effect 从不执行**、`useState` 的 setter **不触发重渲染**、`useMemo`/`useCallback` **丢弃依赖**。而最大的架构问题 ARCH-01（`Store` 上帝对象）需要**同时**改动 17 个 UI 消费方。

**3. 通信核心是重点保护区，且守卫单薄。**
"断线重连不重复历史"这个宪章点名的受保护行为，**全押在 `ws-reconnect-session-recovery-spec.mjs` 单个文件上**。`openWebSocket` 的 Cookie 参数与 `loginWithToken` 的 303/清 jar 顺序**零守卫**。

**4. 原生侧 `android/app` 覆盖率为零。**
`AgentModule` / `AgentRuntime` / `PhoneTools` / `OutpostAccessibilityService` / `BackgroundDisplayController` / `AgentService` / `ShareInbox` **没有任何自动化测试**，而它们是审批权威链与设备控制链的载体——**安全相关且不可简化**。

**5. 没有覆盖率度量。**
TEST-15：全仓无 c8 / nyc / istanbul / `--experimental-test-coverage` / jacoco / kover。所以"重构后覆盖率没降"这个基本判据**当前无法计算**。而且 `tsconfig.json` 把 `tests` 排除在类型检查外，**142 个测试文件完全不做类型检查**——这正是 SEC-06（keychain 返回值被标成 `Promise<unknown>` 而真实是 `Promise<false | Result>`）**在编译期不可见**的原因。

### 但有一个重要的正面因素

**代码卫生极好**（零 TODO / 零注释代码 / 零假绿），说明债务是**结构性**的而非**腐烂性**的。结构性债务**可以**分阶段偿还，而且**阶段 0~2 完全不需要重构**。

### 推荐的路线

> **阶段 0（让信号可信）→ 阶段 1~2（零风险修复 + 安全收紧）→ 阶段 4（补测试）→ 阶段 5（质量收敛）**
>
> **只有在阶段 4 完成、UI 层有了真实渲染测试之后，才重新评估阶段 6 的架构重构。**

**换句话说：先花力气把"能不能安全地改"这个问题解决，再谈"要不要改结构"。**

### 明确**不应该**现在重构的模块

完整清单（14 项 + 12 项安全控制）见 `07_REGRESSION_PROTECTION.md` §二 与 §四。摘要：

| 类别 | 模块 |
|---|---|
| **fold** | `foldEvents` 的 seq 去重与工具合并（`:265-274, 396-499`，提交 `e0216f9`）；`foldEventsIncremental` 缓存失效（`:946-993`，提交 `c8e9924`）；`extractAuthoritativeRunning` + `applyAuthoritativeRunningOverride` |
| **transport** | `ensureSocket`（尤其 `:572-581` 的"`error` 不 reject"）；`openWebSocket`；`loginWithToken`（尤其 `:236-244` 的先清 jar） |
| **store 流式核心** | `connectChatStream` / `backfillReconnectGap` / `pump` / `upsertStreamRecord` / `handleStreamDisconnect`（含抖动 `:2189-2196`、RN 探针 `:2180-2187`、定时器复检 `:2213-2217`）/ `runPendingSend`（尤其 `:2794` 的 `begin-send` 顺序与 `:2810-2833` 的**不重试** catch）/ `reconcilePendingNow` |
| **pendingSend** | `transitionPendingSend`（尤其 `:148, :164, :175-178` 的 confirmed no-op）；`save` 的写→读回→逐字节比对；`runExclusive`；`retry` + `evaluatePendingSendBinding` + `patched()` |
| **Android 原生** | `RuntimeInstaller` + `RuntimeManifest`；`RuntimeSupervisor` / `RuntimeWire` / `RuntimeJournal`；`DshRuntimeService`（**这是正确的 FGS 范例，BUG-10 的修法是把它抄进 `AgentService`**）；`FileRunStore` / `RunRecovery` / `AgentLoop` 裁剪；`AgentSettingsStore`；`CloudModel.kt` / `Http.kt`；`ShareInbox`；`BackgroundDisplayController` 帧路径；无障碍 fail-closed 链 |
| **主机侧** | `workspace-fs.js`（`fresh()` 的每次重解析）；`patches/mobile-gateway-mgmt-auth/`；`gateway-patch-gate.ps1`；`butler-installer.ps1`；`build-signed-apk.ps1` 的密钥卫生；`tunnel-service.mjs` 的 **loopback 绑定 + Origin 策略（这两者永远不能拆开）**；`net-security.ts` 的私网限定明文策略；四类多状态 fail-closed 结果联合；审批权威链五环；凭据读回校验；token 文件 ACL 纪律；重试时的 requestId 复用 |
| **测试** | **静态正则型 spec 不要删**（`timeout-throttle-spec.mjs` 全文、`send-idempotency-spec.mjs:135-148,193-231,237-249`、`send-retry-spec.mjs:237-254`、`fold-spec.mjs:339-345`、`revocation-unknown-spec.mjs:522-556`）—— 它们是若干 UI 层不变量的**唯一**守卫。**改断言方式，不删文件** |

**已核查干净、同样不需要动的：** `dsh-outpost-butler/index.js`（114 行，memory 域失败隔离 + 有序释放）、`lib/commands.js`、`lib/local-approvals.js`、`lib/memory-store.js`（有 journal 压缩）、`lib/domain.js`/`contracts.js`/`deliverables.js`；`preload.js`；`setup-butler.ps1`；`pack.js`；`core/attachment-cache.ts`；`04` §八列出的全部有界 map 与配对清理的监听器。

**文档已核实准确（无漂移）：** `butler-tasks.md`、`runtime-compat.md`、`release-verification.md`、`mobile-gateway.md`、acceptance-guide 的证书指纹、`CONTRIBUTING.md`、`SECURITY.md`。

---

## 七、分阶段、可回滚的实施建议

> 完整版见 `06_OPTIMIZATION_ROADMAP.md` §五。此处为决策摘要。

| 阶段 | 内容 | 触碰业务代码 | 回滚方式 | 完成判据 |
|---|---|---|---|---|
| **0** | 让信号可信：P0-1（测试链 + harness + 6 个孤儿 script）、P0-7（CI 下 skip 变失败）、TEST-17(1)（加 `:agent-core:test`）、TEST-16(1)（加 timeout）、TEST-14(1)（CI 打 gateway 补丁） | **否** | 单个 commit，`git revert` | 故意制造 2 个失败 → 报告里**两个都在**；`tsc` 无论成败都跑；CI 日志出现 38 个原生测试结果；CI 日志出现补丁被应用 |
| **1** | 零/极低风险的确定性修复：P0-3（error boundary）、P0-4（3 行 `supported()`）、P0-5（端口校验）、P0-6（2 处改名）、SEC-04（键集合对齐）、BUG-17、CQ-07、PERF-04(2)（`push`+`join`）、PERF-05(1)（终态降频） | 是，**每处 ≤5 行且互相独立** | **每项一个 commit**，可单独 revert | 每项都有独立的可执行验证 |
| **2** | 安全收紧（**全部是扩展覆盖面，无一项简化删除**）：P0-2、TEST-14(3)（`apksigner` 缺失 fail-closed）、SEC-05（TEMP 日志 ACL）、TEST-13（AGP 显式版本 + `distributionSha256Sum` + 缺 `DSH_VERSION_CODE` 时失败） | 是（脚本 + gradle） | 每项一个 commit | 负向测试：未打补丁 → 拒绝启动；无 `apksigner` → 失败；缺版本参数 → Gradle 失败 |
| **3** | **测试先行**的行为修复：P0-8（BUG-02）、P0-9（BUG-03） | 是（**触碰保护区**） | 测试与修复分两个 commit；修复 commit 可单独 revert 而测试保留（此时测试变红，**正确地指出问题回来了**） | 新测试在修复前**红**、修复后**绿**；且 `fold-spec.mjs:189-232`、`ws-disconnect-spec.mjs`、`ws-reconnect-session-recovery-spec.mjs`、`pending-send-send-flow-spec.mjs` **全部仍绿** |
| **4** | 补测试（**不改业务代码**）：TEST-06（butler 沙箱）、TEST-04（cookie jar 合并）、TEST-15(1)（覆盖率数字）、TEST-07（win32 路径）、TEST-16(2)（PS 5.1 leg）、PERF-02 的 5000 事件等价性测试、`04` §九 的 6 项真机测量 | **否** | 纯新增 | 每个新测试都能通过"**故意改坏产品代码 → 测试必须失败**"的验证 |
| **5** | 质量收敛（**依赖阶段 0/4 的信号**）：P0-10、CQ-01a–e（**优先已漂移的 4 组**）、CQ-06、PERF-03、PERF-06、PERF-02(a)、BUG-10、BUG-15、BUG-16、SEC-06 | 是 | 每组一个 commit | —— |
| **6** | 架构演进（**本轮明确不建议启动**）：ARCH-01（Store 拆分）、ARCH-02（多后端接缝）、ARCH-03（wire 收回）、ARCH-04（四条旁路收编）、ARCH-10（App.tsx 拆分） | 是 | —— | **阻塞条件：TEST-12 未解决前不得启动** |

### 阶段 5 的一条硬约束（宪章第 4 条）

> "不为了减少代码行数而牺牲可读性、稳定性或扩展性。"

**CQ-01 的 13 组重复里，只收敛已经漂移的 4 组**：

| 组 | 已经造成的真实缺陷 |
|---|---|
| **CQ-01a** LAN-IP 正则 ×4 | `main.js:563` 那份**缺 `Wireless`** 网卡名 → 在只有无线网卡的机器上**取不到 LAN IP** |
| **CQ-01b** 日志 helper ×6 | **已经漂移成一个崩溃**（关联 BUG-06） |
| **CQ-01c** EAP 守卫 | **2 处正确 / 3 处缺失** |
| **CQ-01d** profile 路径 | **5 处硬编码 vs 3 处 DSH_HOME-aware**（关联 BUG-14）；`doctor.ps1:156` 尊重 DSH_HOME 但 `:178` 硬编码 |

**其余 9 组重复暂不动** —— 三份相似的代码好过一个过早的抽象。

---

## 八、审计质量自查（宪章 §五 的完成条件）

### 1. 复查是否存在重复或矛盾的审计结论

**已做。** 跨 8 份文档提取全部编号并交叉比对：

| 检查 | 结果 |
|---|---|
| 编号冲突 | **无** —— ARCH-01~11、CQ-01~09、BUG-01~18、SEC-01~08、PERF-01~07、TEST-01~18 各自唯一 |
| **刻意的别名（已标注，不重复计数）** | **TEST-01 ≡ BUG-01** —— 同一问题（`&&` 链）的"Bug 视角"与"测试视角"，`05` §三 明确写了"完整分析见 `03` 的 BUG-01" |
| 子 Agent 编号合并 | **SEC-05 合并了子 Agent 的 SEC-04 与 MOD-03**（`03:686` 已注明） |
| 矛盾结论 | **发现并已修正 1 处**：本文档 §二 的严重度表原先写"High **13**"却在同一行列举了 16 个条目，且 Medium/Low 的计数（33 / 15）与逐条枚举不符。**修正方法**：从 6 份文档的条目标题上逐条抽取严重度标签重新计数（`grep -nE "^#+ (BUG\|SEC\|ARCH\|CQ)-"` 与 TEST 的 `—— **X**` 格式），得到 **Critical 1 / High 16 / Medium 档 43 / Low 8 = 68**，并在表内写明扣减过程与相加校验。**PERF-01~07 在 `04` 中不带严重度标签**，其档位是本摘要的归类，已在表中显式标注，不再冒充原始标签。<br>除此之外**无矛盾** —— 但有三处"表面矛盾"需要澄清，见下 |

**三处需要澄清的表面矛盾：**

| 表面矛盾 | 澄清 |
|---|---|
| `04` 说 fold 增量快路径"设计得很好"，又说它"实际仍是 O(N)" | **不矛盾。** `04` §〇 明确区分了"数据管线设计优秀"与"PERF-02 的扫描实现未达其注释声称的复杂度"。而且 `04` 把 PERF-02 拆成了 (a) 低风险可做 与 (b) **高风险本轮不要动** |
| `07` 说 `timeout-throttle-spec.mjs` 是"100% 静态、不能检测行为回退"，又说"不要删" | **不矛盾，这是刻意的结论。** 它是若干 UI 层不变量的**唯一**守卫，而 UI 层目前**写不出行为测试**（TEST-12）。正确做法是**改断言方式**（从"数 `clearTimeout` 出现次数"改成"每个 `setTimeout` 都有配对清理"），这样既保住守卫又不阻止 BUG-02 的修复 |
| `06` 说 `scripts/release-gate.mjs` 是死代码，又说"不要删" | **不矛盾。** 它属于"看起来死、实际应该**复活**"的类别 —— 应接进 CI（TEST-14），而不是删掉 |

### 2. 核对所有引用的文件和函数是否真实存在

**已做。** 全部引用来自本轮真实读取，并在写完后做了一次逐条路径/行数复核。**下表列出复核中更正的全部错误 —— 前 3 行是子 Agent 的，后 2 行是我自己的：**

| # | 错误来源与内容 | 更正 |
|---|---|---|
| 1 | "25 个 spec 文件从未执行" | 根因：只与 `test` 链比对，而链条引用的是 **`npm run test:xyz` 子脚本**，不是文件名。**修正方法**：从 CI 根（`test`、`test:integration`、`test:node20`）出发**传递展开** `npm run X` 引用。**正确结果：20 / 142 个 spec 从未运行；6 个孤儿 npm script；CI 到达 92 / 107 个 script** |
| 2 | butler 竞态机制：" `task.goalId` 只在 `await persist` 之后才持久，所以那个窗口里的 cancel 会跳过 pause；更糟的是 persist 丢掉了 patch，所以 goalId 永不被记录" | **我重新推导**：`cancel()` 的决策（`task-manager.js:211-218`）**完全同步**发生在它的第一个 await 之前，所以它读到 `goalId === undefined` 是因为**goal 还没被创建**；`:712` 的同步守卫使大多数交错是安全的；`:827-829` 的 patch 丢弃是真的，但只是**后半段**。另外我发现 `finishLane:812` 提供了子 Agent 漏掉的**部分缓解**，且提交 `2325d34` 修的是**兄弟 `sessionId` 变体**（注释在 `:695-701`）而**没修 `goalId`**。重写为 **BUG-09，Medium / 高可信风险** |
| 3 | "`integration-gateway-reconnect.mjs` 覆盖重连历史去重" | ❌ 它驱动的是 **`ApprovalGateway`**（审批通道）against `fake-dsh.mjs`，与聊天历史无关。**真实覆盖 = `ws-reconnect-session-recovery-spec.mjs:159-249`，仅此一个文件** |
| 4 | **我自己的错误** | 我最初的孤儿 spec 脚本检查链条里是否出现 spec **文件名字面量**，得出"136 / 142 从未运行"的错误结论。**修正后为 20 / 142**（方法同上） |
| 5 | **我自己的引用错误（本轮自查发现）** | 我对 8 份文档做了一次逐条路径/行数复核，用 `find` 定位真实文件、用 `awk 'END{print NR}'` 取真实行数。**共 20 处编辑：更正了 9 个错误的目录前缀/文件名与 14 个错误的行数计数（3 处同时涉及两者）。** 典型例子：把 `src/hooks/useChatMetaPolling.ts` 更正为 `src/components/useChatMetaPolling.ts`；把 `dsh-outpost-desktop/src/main.js` 更正为 `src/main/main.js`；把 `scripts/build-signed-apk.ps1` 更正为仓库根的 `build-signed-apk.ps1`；`dsh-mobile/src` 行数 45 420 → **45 492**（188 文件），`dsh-mobile` 总计 95 969 → **95 389**（399 个 git 跟踪源文件），`dsh-plugin-connect` 3 535 → **3 531**，`dsh-outpost-desktop/src` 1 136 → **1 464**，`dsh-outpost-butler/lib` 2 282 → **2 271**。**根因**：我按记忆写了目录前缀，而不是先验证。**所有结论的方向与严重度未受影响** —— 这些是定位精度问题，不是判断错误 |

**另一处更正（子 Agent 报告的假阳性）：** `integration-gateway-reconnect.mjs:183, 199-203` 有一个**空洞断言** —— `pairsAfter >= pairsBefore` 在一个**单调递增的计数器**上**永远为真**，应该是 `===`。已记录在 `03` §五。

### 3. 确认没有修改任何业务代码

**已确认。** 见下方 `git status` 验证结果（§九）。

### 4. 总结最值得优化的前 10 个问题

**已完成** —— 见 §五。

### 5. 明确指出哪些模块暂时不应该重构

**已完成** —— 见 §六，完整版在 `07_REGRESSION_PROTECTION.md` §二（14 项）与 §四（12 项安全控制）。

### 6. 给出分阶段、可回滚的优化实施建议

**已完成** —— 见 §七，完整版在 `06_OPTIMIZATION_ROADMAP.md` §五。

---

## 九、本轮新增/修改的文件

### 新增（8 份审计文档，全部在 `docs/audits/2026-11-10-full-audit/`）

| 文件 | 内容 |
|---|---|
| `01_ARCHITECTURE_OVERVIEW.md` | 系统全景、代码规模、模块清单、四条传输通道、butler 任务状态机、配置/版本真值来源、**ARCH-01~11** |
| `02_CODE_QUALITY_FINDINGS.md` | **CQ-01**（13 组重复，4 组已漂移）、**CQ-02**（死代码）、**CQ-03**（dev 代码进 release）、**CQ-04**（18 处文档漂移）、**CQ-05**（测试工具链不一致）、**CQ-06**（butler 无界增长）、**CQ-07**（桌面渲染进程读不存在的字段）、**CQ-08/09** |
| `03_BUG_AND_SECURITY_RISKS.md` | **BUG-01~18**（含 BUG-18a–j）、**SEC-01~08**、23 项已核实正确的安全控制、子 Agent 错误更正记录 |
| `04_PERFORMANCE_REVIEW.md` | **PERF-01~07**（每项标注【已测量】或【静态怀疑】）、已核查干净的区域、**6 项待执行的真机测量计划**（含工具与阈值） |
| `05_TEST_COVERAGE_GAPS.md` | CI 矩阵、覆盖缺口地图（**方法：import-graph grep，非覆盖率工具**）、harness 与真实 gateway 的 13 项差异、**TEST-01~18**、"本轮未执行"声明 |
| `06_OPTIMIZATION_ROADMAP.md` | 前 10 项、第二梯队、"必须先补测试才能动"的 7 项、4 项待验证、**7 阶段可回滚实施计划**、"不应重构"清单 |
| `07_REGRESSION_PROTECTION.md` | 宪章点名的**六项受保护行为**逐一核查、**14 项不要重构清单**（含每项的"唯一守卫"）、DSH 层已核查干净的 8 项、**12 项安全上不得简化的控制**、六个原生修复提交的完整性核查、回归测试方案汇总 |
| `08_EXECUTIVE_SUMMARY.md` | 本文档 |

### 修改

**无。零个业务文件被修改。** 审计交付时的实测证据：

```
$ git rev-parse HEAD
2325d344392fec496a5d5cdb8f64d959b66afd5e        # 与审计开始时完全一致

$ git status --short
?? docs/audits/                                  # 唯一条目：新增的审计目录

$ git diff --stat HEAD -- . ':(exclude)docs/audits'
（空输出）                                        # 排除审计文档后无任何差异
```

8 份文档合计 **4 426 行**。

---

## 十、最终声明

### 本轮**执行过**的（全部只读）

| 命令 | 结果 |
|---|---|
| `node tests/cwd-spec.mjs` | exit 0，0.173s |
| `./node_modules/.bin/tsx tests/updater-spec.mjs` | exit 0，0.828s |
| `tsx tests/teammate-spec.mjs` | exit 0，0.743s |
| `node tests/version-code-spec.mjs` | **25 pass / 0 fail**，`duration_ms 31`，exit 0 |
| 大量 Read / Grep / Glob | 只读 |
| `git status` / `git show` / `git log` | 只读 |

**环境声明**：以上 4 次执行在**本地 Node v24.13.0 / Windows**，**不是** CI 的 Node 20 / ubuntu-latest。**因此不能据此推断 CI 结果。**

### 本轮**未执行**的（宪章第 7、9 条）

- ❌ 完整 `npm test` 链、`test:integration`、`test:node20`
- ❌ `tsc --noEmit`
- ❌ 任何 `gradlew`（含 `:agent-core:test`）
- ❌ 任何 `npm ci` / 依赖安装 / 构建
- ❌ 任何模拟器 / instrumented 测试
- ❌ 任何真机性能测量
- ❌ 任何覆盖率工具（**仓库里根本不存在**）
- ❌ 任何外部服务 / advisory DB / 网络访问
- ❌ 任何 CI 运行日志 / 产物 / 历史通过失败数据

### 因此本轮**不包含**以下断言

- "测试套件当前是通过还是失败"
- "完整套件耗时多少秒"（`05` 里的 ≈66s 是**标注过的算术外推**，非测量）
- 任何百分比形式的**语句/分支覆盖率**（`05` 的缺口地图是**文件级 import-graph grep**，回答"是否被加载"，不是"覆盖了多少语句"）
- 任何真机性能数字（`04` 的每一条都标注了【已测量】或【静态怀疑】）
- AGP / Gradle / Kotlin / JDK 的兼容矩阵结论

### 审计约束遵守情况

| 宪章约束 | 遵守情况 |
|---|---|
| **本轮只审计，不修改任何业务代码** | ✅ 零个业务文件被修改 |
| 不添加新功能、不重构、不修改依赖 | ✅ |
| 不为了减少代码行数而牺牲可读性/稳定性/扩展性 | ✅ CQ-01 的 13 组重复**只建议收敛已漂移的 4 组**，其余 9 组明确"暂不动" |
| 所有问题必须提供文件路径、函数、具体原因 | ✅ 每条均含行号级证据 |
| 不允许根据文件名或主观推测认定 Bug | ✅ 明确区分"已确认 / 高可信风险 / 待验证假设"，7 项标为待验证并说明**为什么无法验证** |
| 只运行不修改业务文件或外部状态的检查 | ✅ 仅 4 个只读 spec + git 只读命令 |
| **不读取、输出或上传任何密钥、Token、证书私钥及用户隐私数据** | ✅ 未读取任何凭据内容；提到 `debug.keystore` 时**只讨论它的公开指纹是否在黑名单里**，未输出任何私钥材料 |
| **不自动安装工具、访问外部服务或调用收费 API** | ✅ SEC-03 因此标为**待验证**而非编造结论 |
| 可以使用只读子 Agent 并行审计，但需统一去重和交叉验证 | ✅ 7 路子 Agent；**本人复核约 20 条高危断言，更正了 3 处子 Agent 错误 + 2 处自己的错误（含 20 处引用精度更正）+ 1 处假阳性** |
| **不得在没有完整回归测试依据的情况下建议替换稳定逻辑** | ✅ `07` 的 14 项"不要重构"清单 + 12 项"安全上不得简化"清单；**BUG-02 / BUG-03 的修法都是"测试先行 + 补齐对称性"，不是替换** |
| **涉及安全的代码不得直接提出简化删除方案** | ✅ 全部 12 项安全控制的建议都是"**保留**"或"**扩展覆盖面**"，**无一项建议削弱** |
| 性能问题区分"已测量确认"与"静态分析怀疑" | ✅ `04` 每一条都显式标注，并给出 6 项待执行的真机测量计划 |
| 无法验证的明确标记待验证，**禁止编造测试结果或性能收益** | ✅ 见上方"因此本轮不包含以下断言" |
| **完成后停止，不得自动进入代码修改阶段** | ✅ **本文档交付后停止** |

---

*本审计由只读操作产生。8 份文档全部位于 `docs/audits/2026-11-10-full-audit/`。*
*审计到此结束，不进入代码修改阶段。*
