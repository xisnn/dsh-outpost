# 07 · 回归保护：必须守住的现有功能与测试方案

审计基线：`E:\work\dsBot-opt` HEAD `2325d34`（分支 `opt/p1-phone-polish`，工作树干净）。
本轮**只审计、未修改任何业务代码**。

---

## 〇、本文档的用途

宪章指定 **DSH 通信与任务执行是重点保护区域**，并列出六个历史上修复过的行为：

1. 工具调用 ID 字段差异导致的异常
2. 重复工具调用块
3. pending 状态无法结束
4. 断线重连后的历史记录重复
5. unknown 状态下的安全重试
6. requestId 复用与幂等处理

要求：**检查当前实际代码与测试是否仍然覆盖这些行为**，且"**不得在没有完整回归测试依据的情况下建议替换这些稳定逻辑**"。

本文档因此分四部分：

- **§一** 六项行为逐一核查：修复代码**还在吗**？测试**是真的吗**？（含"故意改坏会不会被测出来"的判据）
- **§二** 14 项**不要重构**清单：每项写明它为什么承重、以及**当前唯一的守卫是什么**
- **§三** DSH 层**专门去找但没找到问题**的地方（防止后续误报或误改）
- **§四** 12 项**安全上不得简化删除**的控制

### 核查方法的说明

"测试是真的吗"用三个判据，不靠主观印象：

| 判据 | 含义 |
|---|---|
| **真实 import** | 测试 `import` 的是产品源文件，而不是自己重写一份 |
| **真实断言** | 断言的是**行为结果**（值、次数、状态），不是"某个字符串在源码里出现过" |
| **反向判据** | 如果**故意把修复回退**，这个测试**会不会失败**？——这是唯一能证明"测试真的在守"的问题 |

**特别标注：静态型测试。** 仓库里有一批 spec 是 `readFileSync` + 正则（不 import 产品代码）。它们**不能**检测行为回退，但**是若干 UI 层不变量的唯一守卫**。因此本文的结论是"**不要删，要改断言方式**"，而不是"这不是真测试所以删掉"。

---

## 一、六项受保护行为的核查结论

### 总览

| # | 行为 | 修复代码在 HEAD 里 | 测试覆盖判定 | 缺口 |
|---|---|---|---|---|
| 1 | 工具调用 ID 字段差异 | ✅ **在**（`e0216f9` 逐字节匹配 HEAD） | **PROTECTED-WEAKLY-COVERED** | `tool/result` 侧不对称 + 空 id 路径**零覆盖** → **BUG-03** |
| 2 | 重复工具调用块 | ✅ **在** | **PROTECTED-COVERED** | 一个**待验证假设**（跨 step 去重） |
| 3 | pending 状态无法结束 | ✅ **在**（传输/Store/UI 三层都清） | **PROTECTED-WEAKLY-COVERED** | 两条"永不终止"路径未覆盖 → **BUG-02**、**BUG-03** |
| 4 | 断线重连后历史重复 | ✅ **在** | **PROTECTED-COVERED** | **只有一个文件在守** |
| 5 | unknown 下的安全重试 | ✅ **在** | **PROTECTED-COVERED** | 无缺口（**未找到任何 unknown 触发自动副作用重试的路径**） |
| 6 | requestId 复用与幂等 | ✅ **在** | **PROTECTED-COVERED**（store/state/identity）<br>**PROTECTED-WEAKLY-COVERED**（ChatScreen 接线） | UI 层只有静态断言 |

---

### 行为 1 · 工具调用 ID 字段差异 —— **PROTECTED-WEAKLY-COVERED**

#### 修复代码

| 位置 | 接受的字段 |
|---|---|
| `core/fold/index.ts:402-406`（`assistant/message` 里的 `tool-call` 块） | `callId` \| `id` \| `toolCallId` |
| `core/fold/index.ts:434-438`（`tool/call` 事件） | `callId` \| `id` \| `toolCallId` |
| **`core/fold/index.ts:469-471`（`tool/result` 事件）** | **只认 `message.toolCallId` \| `d.toolCallId`** ← **不对称** |

代码里的注释明确记录了这个修复的理由：

> 真实 DSH 的 assistant/message content 里 tool-call 块用 id（部分路径用 callId / toolCallId），必须统一提取才能与紧随其后的 tool/call、tool/result 按同一个 callId 合并去重。

#### 全仓交叉验证（排除误报）

我 grep 了 snake_case 变体 `tool_call_id` / `tool_use_id` / `call_id`，命中**只在两个与 fold 无关的地方**：

| 位置 | 说明 |
|---|---|
| `android/agent-core/.../CloudModel.kt:303, 485, 533, 596` | **独立的端侧云模型协议**，不走 fold |
| `dsh-outpost-butler/lib/commands.js:117`、`local-approvals.js:81, 108` | butler 侧，不走 fold |

**→ 没有任何 snake_case 变体能到达 fold 路径。** 这一点很重要：它说明 fold 的三字段兼容**已经足够**，不需要再扩。

#### 测试是否为真

`tests/fold-spec.mjs:189-232` —— **GENUINE（真实）**：

| 判据 | 结果 |
|---|---|
| 真实 import | ✅ `import('../src/core/fold/index.ts')`，调真实 `foldEvents` |
| 真实数据 | ✅ 用的是**真实捕获的 id** `call_574864__tsk16___eK0ASYdfAikZ6ze`，分别作为 `id` / `callId` / `message.toolCallId` 三种形态喂进去 |
| 真实断言 | ✅ 断言 `tools.length === 1`（合并成功）且 `pending === false && output === 'export const port = 3095;'` |
| **反向判据** | ✅ **回退 `e0216f9` 会让 `tools.length === 2` → 测试失败** |

**并且：`git show e0216f9` 与 HEAD 逐字节匹配 —— 该修复未被回退。**

#### 缺口（→ BUG-03）

| 缺口 | 证据 |
|---|---|
| `tool/result` 侧不对称 | `:469-471` 只认两种字段，而调用侧认三种。若上游在 result 里也用 `id`，会**匹配不上** |
| 空 id 静默丢弃 | `:483` —— `callId === ''` 时**既不建块也不报错**，工具结果凭空消失 |
| `turn/end` 不清 pending | `:501-511` 只设 `running = false` / `endedAt` / `reason`，**从不遍历 blocks 清 `pending`** |
| 权威 override 不遍历 blocks | `:904-914` 的 `applyAuthoritativeRunningOverride` **只改 turn 级状态**，不下探到 ToolBlock |

**用户可见后果**：永不停止的工具转圈，并通过 `toChatItems:650-654` **抑制完成卡片**。

#### 回归测试方案（**必须先写，再改代码**）

在 `tests/fold-spec.mjs` 增加三个用例，**先确认它们当前失败**：

| 用例 | 输入 | 当前行为 | 期望行为 |
|---|---|---|---|
| **1-A** | `tool/result` 的 `message` 里用 `id`（而非 `toolCallId`）携带 callId | 产生**两个**工具块，其一永久 pending | 合并成一个，`pending === false` |
| **1-B** | `tool/result` 的 callId 为空串 | **静默丢弃** | 建一个已完成块（`name: 'tool'`），**不丢结果** |
| **1-C** | `turn/end` 到达时仍有 `pending: true` 的块 | **永久 pending** | 全部清为 `pending: false`（或标记为中断） |

**护栏**：改完后 `fold-spec.mjs:189-232` 的现有用例**必须仍然通过**（它用的是真实捕获的 id，是这个修复的原始证据）。

---

### 行为 2 · 重复工具调用块 —— **PROTECTED-COVERED**

#### 修复代码（四层去重）

| 层 | 位置 | 机制 |
|---|---|---|
| seq 去重 + 排序 | `core/fold/index.ts:265-274` | 按 seq 建 Map，重复 seq 覆盖 |
| callId 合并（assistant 侧） | `:407-410` | `step.blocks.find(x => x.kind === 'tool' && x.callId === callId)`，命中则 `continue` |
| callId 合并（tool/call 侧） | `:441-445` | 命中则只把 `pending` 置回 true（若尚无 output） |
| deliverables 路径去重 | `:526-527` | 按路径 |
| approval 去重 | `:546-547` | |
| Store 侧 | `core/store.ts:2306-2320`（`upsertStreamRecord`） | seq-keyed `Map` + `recordsNeedSort` 失效标记 |

#### 测试是否为真

| 测试 | 判据 |
|---|---|
| `fold-spec.mjs:142, 150-152` | **GENUINE** —— `:150-152` 把 `[...records, ...records]`（**整个记录列表翻倍**）喂给 `foldEvents`，断言 turn / step 计数**不变** |
| `fold-spec.mjs:269-272, 296-297` | **GENUINE** —— 断言恰好 5 个块、去重生效、**且所有内容都保留**（去重不能吞内容） |
| `ws-reconnect-session-recovery-spec.mjs:159-249` | **GENUINE** —— 它的 `session/page` mock **故意重复包含 seq 2**，断言最终列表**恰好**是 `Msg-1..Msg-6` |
| `streaming-perf-f03-spec.mjs:655-724` | **GENUINE** —— 边界 2A/2B：增量结果与全量结果等价 |

**反向判据**：把 `:407-410` 的 `find` 去掉 → `fold-spec.mjs:150-152` 的块数翻倍 → **失败**。✅

#### 待验证假设（**不是已确认问题**）

**观察**：去重是**逐 `Step` 进行的**（`step.blocks.find(...)`）。

**假设**：如果 `assistant/message` 与紧随其后的 `tool/call` 携带**不同的 `data.step`** 值，就会创建**两个**块。

**为什么标记为待验证**：确认这一点需要一段**真实的、step 值不匹配的**事件轨迹。本轮没有抓取任何真实流量（宪章第 9 条），也**没有在仓库的 fixture 里找到 step 不匹配的样本**。

**不编造结论**：这条**不列为 bug**，只列为"如果将来出现重复工具卡片，这是第一个要查的地方"。

**若要验证**：加一个用例——同一个 callId 分别出现在 `step: 1` 的 `assistant/message` 和 `step: 2` 的 `tool/call` 里，断言最终块数。**先确认期望行为应该是什么**（合并到哪一个 step？），这是产品决策，不是纯技术问题。

---

### 行为 3 · pending 状态无法结束 —— **PROTECTED-WEAKLY-COVERED**

#### 修复代码（**所有清除点已逐一核查**）

**传输层（`core/transport/index.ts`）：**

| 位置 | 触发条件 |
|---|---|
| `failAllStreams:636-652` | socket 关闭时拒绝所有在途流 |
| socket `close:654-665` | |
| socket `error:667-670` | |
| `resetSocket:770-789` | |
| `close:791-797` | |

**Store 层（`core/store.ts`）：**

| 位置 | 清除内容 |
|---|---|
| `handleStreamDisconnect:2141-2142` | |
| `:2161-2162` / `:2201-2202` | `loading: false, running: false` |
| `connectChatStream:2000` / `:2079` | |
| `pump` 的 catch `:2254-2261` | **刷新挂起的 rebuild**（关键：错误路径也要把已收到的事件投影出去） |
| `rebuild:2384` | |
| `send` 的 catch `:2496-2511` | |
| `loadOlder:2288` / `:2293` | |
| `ping` 外部包 `withTimeout(..., PROBE_TIMEOUT_MS)` `:1610` | |

**fold 层：**

| 位置 | 情况 |
|---|---|
| `core/fold/index.ts:482` | **`ToolBlock.pending` 的唯一清除点** |
| `:501-511`（`turn/end`） | ❌ **不清 pending** → **BUG-03 的一部分** |

**UI 层（`screens/ChatScreen.tsx`）：**

| 位置 | |
|---|---|
| `:549-552`、`:565-567`、`:588-590` | **全部在 `finally` 里** ✅ |

#### 测试是否为真

| 测试 | 判据 |
|---|---|
| **`ws-disconnect-spec.mjs`（全 5 节）** | **GENUINE，且设计得很好** —— 用真实 `DshConnection` + 可控 `FakeWebSocket`；**断言方式是"有界时间"** `withTimeout(pending, 2000)`，所以**回退修复会导致挂起 → 超时 → 失败**，而不是静默通过。覆盖：close 1006、close 1000、`error`、两个并发流 |
| `send-retry-spec.mjs:173-186` | **GENUINE** —— "失败会复位 running" |
| `streaming-perf-f03-spec.mjs:510, 565, 583-601` | **GENUINE** |
| **`timeout-throttle-spec.mjs`** | ❌ **100% 静态** —— `readFileSync('src/core/transport/index.ts')` + 正则，**从不 import 那个类** |

#### 未覆盖的两条"永不终止"路径

| 路径 | 编号 | 说明 |
|---|---|---|
| **HTTP `call()` 的响应体阶段** | **BUG-02** | `transport/index.ts:398` 在 `res.json()`（`:440`）**之前**就 `clearTimeout` → 服务器接受请求但响应体永不完成时**永久挂起**。对照：`request()` 用 `finally`（`:536-538`），**正确写法就在同一个文件里** |
| **`ToolBlock.pending`** | **BUG-03** | 见行为 1 的缺口 |

**注意 `timeout-throttle-spec.mjs:72-77` 正在 actively 阻止 BUG-02 的修复**：它要求 `clearTimeout` 在源码里出现 **≥2 次**。把 `:398` 移进 `finally` 会改变计数。

→ **修 BUG-02 时必须同步改这条断言**，改法是"断言每个 `setTimeout` 都有配对的清理路径"（这才是真正想守的不变量），**而不是删掉这个 spec**（见 §二 第 14 条）。

#### 回归测试方案

| 用例 | 内容 | 判据 |
|---|---|---|
| **3-A** | mock 一个 `fetch`：resolve 出 `res.ok === true`，但 `res.json()` **永不 resolve** | `call()` 必须在 `timeoutMs` 内以 `RpcError(kind='network')` 拒绝。**当前会挂起 → 测试超时失败**（这正是我们要的"红"） |
| **3-B** | 见行为 1 的 1-C（`turn/end` 清 pending） | |
| **护栏** | `ws-disconnect-spec.mjs` 全 5 节必须仍绿 | 它的"有界时间"断言方式意味着任何新引入的挂起都会被它抓到 |

---

### 行为 4 · 断线重连后的历史记录重复 —— **PROTECTED-COVERED**

#### 修复代码

| 位置 | 机制 |
|---|---|
| `core/store.ts:1969-2083`（`connectChatStream`） | generation 递增（`:1977`）、`isCurrent()` 检查（`:1980-1983`）、快照 upsert（`:2003-2009`）、**缺口检测**（`:2012-2017`） |
| `core/store.ts:2088-2127`（`backfillReconnectGap`） | 安全上限 <10 次、单次 `maxMessages` 200 |
| `core/store.ts:2306-2320`（`upsertStreamRecord`） | **seq-keyed Map** —— 重复 seq 覆盖而非追加 |
| `core/fold/index.ts:265-274` | fold 层再做一次 seq 去重 |
| `core/store.ts:2189-2196` | **带抖动的退避**：`jitterFactor = 0.85 + Math.random() * 0.3` |

**双保险**：Store 层（seq Map）+ fold 层（seq 去重）。任何一层单独失效都不会导致重复。

#### 测试是否为真

**`ws-reconnect-session-recovery-spec.mjs:159-249`** —— **GENUINE，且是这一行为的唯一守卫**：

| 判据 | 结果 |
|---|---|
| 真实 import | ✅ 真实 `DshConnection`、真实 `Store`、真实 `PendingSendStore`；**只有 RPC 边界**（`api.follow` / `page` / `prompt` / `list`）被 stub |
| 真实断言 | ✅ `followCalls === 3`、`pageCalls.length === 1`、`throughSeq === 6`、`beforeSeq === 5`、`chat.error === undefined`、**以及精确的去重后条目列表** |
| 故意制造重复 | ✅ 它的 `session/page` mock **故意重复包含 seq 2** |
| **Check 1**（`:118-157`） | ✅ 证明并发 `openStream` 下**只有一个 socket**，且**迟到的 `ws1.close(1006)` 无法杀死 `ws2` 上的流** |

**反向判据**：把 `upsertStreamRecord` 的 Map 换成数组 push → 条目列表断言失败。✅

#### ⚠️ 更正一个子 Agent 的错误映射

子 Agent 曾报告 `integration-gateway-reconnect.mjs` 覆盖"重连历史去重"。

**这是错的。** 我核实过：`integration-gateway-reconnect.mjs` 驱动的是 **`ApprovalGateway`**（审批通道）against `fake-dsh.mjs`，与**聊天历史**无关。

**聊天历史去重的真实覆盖 = `ws-reconnect-session-recovery-spec.mjs:159-249`，仅此一个文件。**

（此更正已记录在 `03_BUG_AND_SECURITY_RISKS.md` §五。）

#### 回归测试方案

**这一行为的护栏已经很结实，不需要新增测试。需要的是"别把它弄丢"：**

| 动作 | 理由 |
|---|---|
| **不要**把 `ws-reconnect-session-recovery-spec.mjs` 并入其它 spec 或改动它的 mock | 它是**唯一**守卫。它的 mock 里"故意重复 seq 2"是这个测试的核心价值 |
| 若要改 `connectChatStream` / `backfillReconnectGap` / `upsertStreamRecord`，**先复制一份这个 spec 作为快照**，改完对比 | 单文件守卫意味着任何误改都无第二道防线 |
| 建议**加厚**（非必须）：增加一个"generation 检查"用例——在 `follow` 回调里制造一次迟到的旧 generation 事件，断言它被丢弃 | 当前 `isCurrent()`（`:1980-1983`）的正确性只在 Check 1 里被间接验证 |

---

### 行为 5 · unknown 状态下的安全重试 —— **PROTECTED-COVERED**

#### 核查结论（**最重要的一条**）

> **未找到任何一条路径，使得 `unknown` 状态触发自动的、有副作用的重试。**

这是逐项验证的结果，不是印象：

| 位置 | 机制 |
|---|---|
| `core/store.ts:2806-2833` | 通过 `classifyPromptFailure` 分类 → 持久化 `unknown-failure` **或** `definite-failure` → 然后 **`throw e`**。**没有重试** |
| `core/store.ts:2747-2750` | **重入守卫** |
| `core/pendingSend/state.ts:147-150` | `accept` 在已 `confirmed` 时是 **no-op** |
| `core/pendingSend/state.ts:163-173` | `unknown-failure` 在已 `confirmed` 时是 **no-op** |
| `core/pendingSend/state.ts:175-178` | **服务端证据（`confirm`）胜过迟到的本地结果** |
| `core/store.ts:2868-2908`（`reconcilePendingNow`） | **只做 confirm** |
| `recoverInternal` | 重启时把 `sending` → `unknown`，**从不重发** |

#### 测试是否为真

| 测试 | 判据 |
|---|---|
| **`pending-send-send-flow-spec.mjs:142-199, 202-227, 229-249, 289-296`** | **GENUINE** —— 真实 `Store` + 真实 `PendingSendStore`，`api.prompt` 被 stub 成 reject。`:168-189` 断言失败 → `unknown`，且**显式** `retryPending` 产生 `prompts[0].requestId === prompts[1].requestId`（幂等复用的直接证据）。`:229-249` 断言**并发** `retryPending` 是 single-flight：`prompts.length === before + 1` |
| `pending-send-store-spec.mjs:172-189, 272-290` | **GENUINE** |
| `ws-reconnect-session-recovery-spec.mjs:327-404` | **GENUINE** —— 前台恢复把状态 reconcile 到 `confirmed`，**requestId 不变，且没有额外的 prompt** |
| `send-retry-spec.mjs` | **GENUINE** |

**反向判据**：在 `:2810-2833` 的 catch 里加一次自动重试 → `pending-send-send-flow-spec.mjs:229-249` 的 `prompts.length` 断言失败。✅

#### ⚠️ 更正两个子 Agent 的错误映射

| 错误说法 | 实际情况 |
|---|---|
| "`revocation-unknown-spec.mjs` 覆盖发送的 unknown 重试" | ❌ 它覆盖的是**完全不同的 unknown** —— 设备吊销的 fail-closed（`deviceRevocation.ts` + `ApprovalGateway`），测试本身是**真实的**（`:180-266, :291-364`），但**与发送 unknown 无关** |
| "`transport-request-spec.mjs` 覆盖重试语义" | ❌ 它只跑 `request()`，**完全没有重试语义** |

（此更正已记录在 `03_BUG_AND_SECURITY_RISKS.md` §五。）

#### 回归测试方案

**覆盖已经充分，不需要新增。** 需要记住的是**不变量本身**：

> **在 `runPendingSend` 的 catch 里加自动重试，就是这一行为的回归。**

任何"提升发送成功率"的改动提案，都必须先回答：**它会不会在 `unknown` 时自动重发？** 如果会，**直接否决**——因为服务端可能已经执行过了。

---

### 行为 6 · requestId 复用与幂等 —— **PROTECTED-COVERED（store/state/identity）+ WEAKLY-COVERED（ChatScreen 接线）**

#### 修复代码

| 位置 | 机制 |
|---|---|
| `core/pendingSend/ids.ts:17-31` | **总是生成新的**；`counter = (counter + 1) % 0x7fffffff` |
| `core/pendingSend/fingerprint.ts:8-9` | 显式注释：**"不能用于自动复用 requestId"** |
| `core/pendingSend/store.ts:590-613`（`retry`） | **唯一的复用点**，受 `canUserRetry` + `evaluatePendingSendBinding` 双重门控 |
| `core/pendingSend/state.ts:64-75`（`patched()`） | **钉住 `requestId`** —— 状态转移永不改 id（不可变性不变量） |
| `core/store.ts:2493` | 透传 |
| `core/rpc/session.ts:101` | 回退生成 |
| `core/store.ts:2406-2419` | 服务端 `hasPromptRequest` 的去重语义**有文档记录** |

#### 测试是否为真

**store / state / identity 层 —— GENUINE：**

| 断言 | 内容 |
|---|---|
| `assert.equal(retried.requestId, created.requestId)` | 重试**复用** id |
| `notEqual` | 相同文本的两次创建 → **不同** id（id 不是内容的哈希） |
| 40 个并发创建 → 40 个唯一 id | |
| 四种 binding-mismatch 变体**全部被拒**，且记录**留在 `unknown`** | 绑定校验 fail-closed |

**ChatScreen 接线层 —— ❌ 静态：**

`send-idempotency-spec.mjs:135-148, 193-231, 237-249` 是 `readFileSync` + 正则，断言对象是 `ChatScreen.tsx` / `store.ts` / `rpc/session.ts` 的**源码文本**。

**后果**：**无法检测 UI 层的行为回退**。例如若有人在 `ChatScreen` 里改成"重试时创建新记录"，只要源码里那个字符串还在，测试仍然绿。

#### 回归测试方案

| 用例 | 内容 |
|---|---|
| **6-A** | 驱动真实 `Store`：`send()` → stub 的 `api.prompt` reject → `retryPending()` → 断言**服务端只看到一个 requestId，且被调用两次** |
| **6-B** | 断言 `patched()` 的不可变性：对每个状态转移，`requestId` **恒等** |
| **护栏** | **不要删** `send-idempotency-spec.mjs` 的静态断言（尤其 `!retryReq` 那条，见 §二 第 14 条）——在补上 6-A 之前，它是唯一守卫 |

---

## 二、不要重构清单（14 项）

> 每项格式：**目标 / 为什么承重 / 当前唯一的守卫**。
> "唯一的守卫"这一栏是本文档最重要的信息 —— 它标出了**改坏之后不会被发现**的地方。

### 1. `DshConnection.ensureSocket`

| 项 | 内容 |
|---|---|
| 位置 | `core/transport/index.ts:542-684`，尤其 **`:572-581` 的"`error` 不 reject"块**、`failAllStreams:636-652` |
| 为什么承重 | **Android OkHttp 通过 `close` 而不是 `error` 暴露握手期的 401/403。** 如果在 `error` 上 reject，认证失败会被重新分类成通用网络错误，**破坏 `authInvalidated` 终态** —— 用户看到的是"连不上"而不是"登录失效"，于是去折腾网络而不是重新配对 |
| 唯一守卫 | `ws-disconnect-spec.mjs`（**只覆盖 WS 侧**）。**握手拒绝的分类路径：什么都没有** |

### 2. `openWebSocket`

| 项 | 内容 |
|---|---|
| 位置 | `core/transport/index.ts:698-716` |
| 为什么承重 | **RN 的 OkHttp 不会把 cookie jar 附加到 WebSocket 上。** 去掉构造函数的**第 3 个参数**（headers）会让 `/api/remote.mux` **静默 401** —— 症状是"会话一直是空的"，完全不指向 cookie |
| 唯一守卫 | **无。没有任何 spec 断言那个 `headers.Cookie` 参数** |
| 建议 | 补一个静态断言（作为过渡）：`openWebSocket` 的第三个参数必须包含 `Cookie`。**这不是"假测试"——它是这个不变量当前唯一可能的守卫形式** |

### 3. `Store.connectChatStream` / `backfillReconnectGap` / `pump` / `upsertStreamRecord`

| 项 | 内容 |
|---|---|
| 位置 | `core/store.ts:1969-2320` |
| 为什么承重 | generation + identity 守卫 与 seq-keyed Map **就是** P0-2 的"无重复、无缺口"全部保证 |
| 唯一守卫 | **`ws-reconnect-session-recovery-spec.mjs` —— 单个文件** |

### 4. `handleStreamDisconnect`

| 项 | 内容 |
|---|---|
| 位置 | `core/store.ts:2134-2218`，尤其抖动 `:2189-2196`、RN 探针 `:2180-2187`、定时器复检 `:2213-2217` |
| 为什么承重 | 去掉抖动 → **重连风暴**；去掉探针 → **Android 401 检测再次失效**；去掉定时器复检 → **已关闭的会话复活重连** |
| 唯一守卫 | `ws-reconnect-session-recovery-spec.mjs` 的 Check 3-4 |

### 5. `foldEvents` 的 seq 去重与工具调用合并

| 项 | 内容 |
|---|---|
| 位置 | `core/fold/index.ts:265-274`（seq 去重）、`:396-499`（工具合并，提交 `e0216f9`） |
| 为什么承重 | 重复的 turn/step/工具卡片；永久 pending 的工具卡片 |
| 唯一守卫 | `fold-spec.mjs:142, 150-152, 189-232, 269-272` —— **覆盖良好** |

### 6. `foldEventsIncremental` 的缓存失效

| 项 | 内容 |
|---|---|
| 位置 | `core/fold/index.ts:946-993`（提交 `c8e9924`） |
| 为什么承重 | **同 seq 的内容更新**与**中途历史回填**必须让快路径失效，否则界面**静默显示过期内容** —— 这是最难查的一类 bug（不报错、不崩溃，只是内容不对） |
| 唯一守卫 | `streaming-perf-f03-spec.mjs:655-724`（边界 2A/2B）—— **只有小 fixture** |
| 关联 | **PERF-02(b)** 想优化这里的 O(N) 扫描。**必须先把 2A/2B 扩到 ≥5000 事件**，否则不要动 |

### 7. `transitionPendingSend`

| 项 | 内容 |
|---|---|
| 位置 | `core/pendingSend/state.ts:120-240`，尤其 `:148`、`:164`、`:175-178` |
| 为什么承重 | `from === 'confirmed'` 的 **no-op** 是让"**WS confirm 胜过 HTTP accept**"竞态安全的**唯一**机制。把它们"简化"掉会在**成功的发送**上重新引入 `PendingSendPostAcceptError` —— 用户看到"发送失败"，而消息其实已经发出去了 |
| 唯一守卫 | **这个特定交错没有直接测试**（`pending-send-store-spec.mjs` 测的是各个转移，不是这个竞态顺序） |
| 建议 | 补一个用例：先 `confirm`，再 `accept`，断言**不抛错**且状态仍是 `confirmed` |

### 8. `runPendingSend`

| 项 | 内容 |
|---|---|
| 位置 | `core/store.ts:2722-2862`，尤其 `begin-send` 在 prompt **之前**（`:2794`）、**不重试**的 catch（`:2810-2833`）、abandon 对账（`:2855-2861`） |
| 为什么承重 | `:2794` 的**顺序**是"崩溃时留下 `sending`（→ 重启变 `unknown`）而不是静默重复"的原因。在 catch 里加自动重试**就是行为 5 的回归** |
| 唯一守卫 | `pending-send-send-flow-spec.mjs`、`ws-reconnect-session-recovery-spec.mjs:327-404` —— **覆盖良好** |

### 9. `PendingSendStore.save` 与 `runExclusive`

| 项 | 内容 |
|---|---|
| 位置 | `core/pendingSend/store.ts:281-309`（save）、`:251-259`（runExclusive） |
| 为什么承重 | **写 → 读回 → 逐字节比对 → 才提交到内存**。这个顺序防止一份**损坏的文档被当作真相**。"简化"成写完就更新内存，会让一次失败的落盘变成永久的状态错乱 |
| 唯一守卫 | `pending-send-store-spec.mjs:149-189` |
| 关联 | **PERF-02** 提到这把锁与 `reconcilePendingNow` 争用。**性能优化的正确方向是让 `reconcilePendingNow` 少调用 `list()`，不是削弱这把锁** |

### 10. `PendingSendStore.retry` + `evaluatePendingSendBinding` + `patched()`

| 项 | 内容 |
|---|---|
| 位置 | `core/pendingSend/store.ts:590-613`、`state.ts:268-285`、`state.ts:64-75` |
| 为什么承重 | `retry` 是**唯一被授权的 requestId 复用点**；`patched()` 钉住 `requestId` 是**不可变性不变量** |
| 唯一守卫 | `pending-send-store-spec.mjs:129-147, 292-314` —— **覆盖良好**（四种 binding-mismatch 变体全测） |

### 11. `loginWithToken`

| 项 | 内容 |
|---|---|
| 位置 | `core/transport/index.ts:225-293`，尤其 `:236-244` 的"先清 cookie jar" |
| 为什么承重 | **它信任 cookie jar 而不是状态码，因为 303 重定向让状态码失去意义。** "清理这段逻辑"会重新打开认证绕过。而 `:236-244` 的顺序（**先清 jar 再用 token 登录**）去掉之后会复活"**任何 token 都能通过**"的陈旧 cookie 绕过 |
| 唯一守卫 | `integration-gateway-reconnect.mjs` 通过它来 seed，**但没有任何测试断言 303 这个情形** |
| 建议 | 补一个用例：mock 一个 303 响应，断言认证结果由 **cookie jar 的内容**决定，而不是由状态码决定 |

### 12. `reconcilePendingNow`

| 项 | 内容 |
|---|---|
| 位置 | `core/store.ts:2868-2908` |
| 为什么承重 | **"只做 confirm，不改状态、不重发"** —— 这是"服务端证据永不会导致重发"的保证 |
| 唯一守卫 | `ws-reconnect-session-recovery-spec.mjs:327-404` |
| 关联 | **PERF-02(a)** 建议给它加记忆化。**记忆化必须保持"只 confirm"的语义** —— 减少扫描范围可以，改变扫描结论不行 |

### 13. `extractAuthoritativeRunning` + `applyAuthoritativeRunningOverride`

| 项 | 内容 |
|---|---|
| 位置 | `core/fold/index.ts:154-181`、`:904-914`；调用点 `core/store.ts:2376-2377` |
| 为什么承重 | **重连错过 `turn/end` 之后，残留"进行中"的唯一防线。** 服务端权威状态覆盖本地推断 |
| 唯一守卫 | `streaming-perf-f03-spec.mjs:567-622` |
| 关联 | **BUG-03 的第四部分**：这个 override **从不遍历 blocks**，所以它能修好 turn 级的"进行中"，**修不好 ToolBlock 级的 pending**。**修 BUG-03 时应该扩展它，而不是替换它** |

### 14. 静态正则型 spec（**不要删**）

| 文件 | 位置 |
|---|---|
| `timeout-throttle-spec.mjs` | **整个文件** |
| `send-idempotency-spec.mjs` | `:135-148, 193-231, 237-249` |
| `send-retry-spec.mjs` | `:237-254` |
| `fold-spec.mjs` | `:339-345` |
| `revocation-unknown-spec.mjs` | `:522-556` |

| 项 | 内容 |
|---|---|
| 为什么承重 | 它们是若干 **UI 层不变量的唯一守卫**（例如 `ChatScreen.tsx` 里的 `!retryReq`）。UI 层**从不真正渲染**（TEST-12），所以行为测试目前**写不出来** |
| 风险 | **把它们当作"不是真测试"删掉，等于删除覆盖而不补覆盖** |
| 正确做法 | **改断言方式，不删文件。** 例如 `timeout-throttle-spec.mjs:72-77` 从"数 `clearTimeout` 出现次数"改成"断言每个 `setTimeout` 都有配对的清理路径"——后者才是真正想守的不变量，而且不会阻止 BUG-02 的修复 |
| 长期方向 | 一旦 TEST-12 解决（引入 react-test-renderer），把这些静态断言**逐条替换**成行为测试，**替换一条删一条**，不要批量删 |

---

## 三、DSH 层已核查为干净的（**不是** finding）

> 本节的存在是为了**防止误报和误改**。以下每一项我都专门去找过问题，**没有找到**。

| 常见的怀疑 | 实际情况 | 证据 |
|---|---|---|
| "重连退避没有抖动" | ❌ **不成立 —— 有抖动** | `store.ts:2195-2196`，`jitterFactor = 0.85 + Math.random() * 0.3` |
| "可能同时有两个 socket 活着" | ❌ **不成立 —— 三重防护** | `connectingWs` single-flight（`:544`）+ `socketGeneration`（`:547`）+ **每个监听器都调 `isCurrent()`**（`:628, :637, :655, :668`）。**被 `ws-reconnect-session-recovery-spec.mjs:118-157` 实测验证** |
| "teardown 之后迟到的消息会污染状态" | ❌ **不成立** | 每个监听器与每个 Store 续体都**重新检查** generation/identity：`:628, :2231, :2253, :2140, :2215, :2182, :1990, :2026, :2078` |
| "`confirm` 与 `accept` 竞态未处理" | ❌ **不成立 —— 显式处理** | `state.ts:148, :164` 在已 confirmed 时 no-op，**理由写在 `:176` 的注释里** |
| "超时后的请求可能后来 resolve 进共享状态" | ❌ **不成立 —— 没有 pending-request map** | transport 里**不存在**在途请求表。每个 RPC 是**独立的 HTTP POST**，靠 `rpcId`（`:374`）在**单次请求/响应内**关联。所以超时的请求**无处可 resolve** |
| "`runExclusive` 可能死锁" | ❌ **不成立** | `pendingSend/store.ts:254-257` 在链接下一个之前**吞掉两种结果**（成功与失败） |
| "handler 在 apply 中途抛错会破坏状态" | ❌ **不成立 —— 三处防护** | `flushEmit:1575-1579` **包裹每个监听器**；`pump:2252-2262` 在断连处理**之前**刷新挂起的 rebuild；`reconcilePendingNow:2900-2902` **吞掉非法转移** |
| "`store.ts` 里有无界数组" | ❌ **不成立 —— 全部有界** | banners 上限 3（`:1176-1215`）、`authoritativeApprovalAt` 200（`:1304-1306`）、`resolvedApprovalIds` 100（`:1322-1324`）、`backfillReconnectGap` 安全上限 <10 / maxMessages 200（`:2088-2127`） |

---

## 四、安全上**不得简化删除**的 12 项控制

> 宪章："涉及安全的代码不得直接提出简化删除方案。"
> 本节列出**必须保留**的安全控制，以及**每一项堵的是哪个静默 fail-open**。
> **本审计对所有 12 项的建议都是"保留"或"扩展覆盖面"，无一项建议削弱。**

### 1. `assertSecureUrl` + 私网限定的明文策略

| 项 | 内容 |
|---|---|
| 位置 | `core/net-security.ts`（182 行）；调用点 `core/transport/index.ts:158`、`core/fileUrl.ts:55` |
| 为什么不能放宽 | `network_security_config.xml` 在 **OS 层**设了 `cleartextTrafficPermitted="true"`（LAN 场景必需），而按 `docs/known-issues.md` §3，**Android 的 network-security-config 无法表达 CIDR**（只支持具体域名、具体 IP 字面量、子域名通配）→ 这个应用层门禁是**唯一的明文流量边界** |
| 唯一守卫 | ⚠️ **TEXT-ONLY** —— 182 行只被 `readFileSync` + 正则断言（见 `05` §2.1） |
| 正确方向 | **加强**：写一个静态 spec 枚举所有网络原语（`fetch` / `new WebSocket` / blob util），断言它们都经过 `assertSecureUrl`。**关联 ARCH-04**（四条携带凭据的 HTTP 路径绕过了 `DshConnection`：`approvalGateway.ts:839`、`deviceAuth.ts:170, 258`、`serverIdentity.ts:217`、`updater.ts:58, 240`）——**修 ARCH-04 的方式是把它们收进门禁，不是放宽门禁** |

### 2. 多状态 fail-closed 结果联合类型

| 项 | 内容 |
|---|---|
| 涉及 | migration **7 态**、cookie **4 类**、binding **5 类**、revocation **3 态** |
| 为什么不能塌缩成 boolean | 任何一个塌缩都会重新引入"**unknown 被当作干净**" |
| 关键文档 | `core/deviceRevocation.ts:30-36` **明确记录了**为什么 `unknown` 永不意味着"未吊销"——**因为不会有 4003 来纠正它** |
| 关联 | `fake-dsh.mjs` **不模拟 4003**（见 `05` §4.1）→ 这条路径在测试里被抹掉了，所以**代码里的注释是唯一的设计记录，更不能删** |

### 3. 审批权威链

| 环节 | 位置 | 堵的哪个 fail-open |
|---|---|---|
| 单一 `ActionExecutor` 收口 | `android/agent-core/.../Tools.kt:55-108` | 绕过审批直接执行 |
| `decide(callId, digest)` 绑定 → `STALE_APPROVAL` | `AgentRuntime.kt:396-422` | **批准 A 却执行 B**（内容被换） |
| 首个决定胜出 | 同上 | 重复批准 / 决定翻转 |
| 无限等待默认 `REJECT` | `AgentRuntime.kt:622-632` | 等待超时被当作批准 |
| `unconfirmed` 提交锁 | `core/approvalDock.ts:375-380, 520-529` | 未确认的审批被提交 |

**这五环每一环堵一个独立的静默 fail-open。** 提交 `ebcc9a1` 的实质内容已核实。

**关联 BUG-12**：`PhoneTools.kt:207-216, 268-277` 的 tap/scroll **不绑定到已批准的快照** —— 这是**这条链上的一个缺口**，修法是**把绑定扩展到 tap/scroll**，不是放松其它环节。

### 4. 重试时的 requestId 复用

| 项 | 内容 |
|---|---|
| 位置 | `core/store.ts:2490-2493`、`core/pendingSend/fingerprint.ts` |
| 为什么承重 | `unknown` 的重试安全性**完全**依赖复用同一 requestId 让服务端去重。**换新 id 会把每一次模糊重试变成重复执行** |
| 关键推论 | `canUserRetry` 把 `unknown` 算作可重试，**只在"复用 id"这个不变量成立时才安全**。两者是**一对**，不能只改一个 |

### 5. RuntimeInstaller 信任链

| 环节 | 位置 |
|---|---|
| manifest **只**来自已签名 APK 的 assets | `LocalDshModule.kt:128-129` |
| archive + 逐文件 SHA-256 | `RuntimeInstaller.java:390-411` |
| inventory-pinned 解包 | `:413-493` |
| USTAR-only，**禁** hardlink / device / PAX | `:502-537` |
| `O_NOFOLLOW \| O_EXCL \| O_CLOEXEC` | 同上 |
| payload chmod 0555、`(mode & 0022) == 0` | 同上 |
| file + directory fsync | 同上 |
| `installer.lock` FileLock | 同上 |
| 崩溃检查点语义（安装/回滚） | 同上 |
| 符号链接禁闭 | 同上 |
| **不收养孤儿 release** | 同上 |

**为什么不能简化**：接受**任何**下载方提供的 sidecar manifest 会让整个方案崩塌——校验和由被校验方提供就等于没有校验。

**⚠️ 守卫状态**：约 **40 项失败注入检查**写在 `RuntimeInstallerChecks.java` 里，**但它不是 JUnit，从不自动运行**（TEST-17）。**这是本次审计里最可惜的一处：极好的测试，零执行。**

### 6. 发布签名门禁

| 项 | 内容 |
|---|---|
| 位置 | `app/build.gradle:221-252`（`taskGraph.whenReady` hook）、`release-signing.json` 的证书钉住 |
| 为什么承重 | 仓库里**已提交** `debug.keystore`（公开的 AOSP 默认）。**它之所以无害，唯一原因是这个门禁存在** —— hook 会在 `assembleRelease` / `bundleRelease` / `packageRelease*` 缺少 `DSH_STORE_FILE` 时**抛错** |
| CI 侧的独立防线 | `android.yml:400-410` **独立地**把公开 debug 指纹列入黑名单（不依赖 `EXPECTED_CERT_SHA256` 变量）；`:432-440` 在该变量缺失时**硬失败**而非警告 |
| 绕过路径（**需收紧，不是删除门禁**） | `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true`（`:167, 232, 247`）。`:151` 的注释断言"CI 永不传"。**它确实不能通过 CI 发布**（有上面的黑名单），**但可以被构建出来手工分发** → **TEST-14(b)** |

### 7. Gateway 补丁 + 启动拒绝

| 项 | 内容 |
|---|---|
| 位置 | `patches/mobile-gateway-mgmt-auth/`（`patch.mjs` / `apply.mjs`）、`scripts/gateway-patch-gate.ps1`、`start-dsh-web.ps1:140-144` |
| fail-closed 设计 | 缺少拒绝 hook 时补丁**返回 503**；锚点必须**恰好匹配一次**；`--apply` **拒绝**未知插件版本（`apply.mjs:155-169`）；`--check` 退出 1 → `start-dsh-web` **拒绝启动** |
| opt-out（**仅局域网路径**） | `-SkipGatewayPatchCheck`（`start-dsh-web.ps1:114-118`），其存在性被 `gateway-startup-gate-spec.mjs:79` 断言、"门禁默认启用"被 `:80` 断言。**⚠️ 2026-11-11 实施轮后：这个 opt-out 只属于局域网路径。公网隧道路径刻意没有 opt-out** —— `start-tunnel.ps1` 不声明该参数、调用门禁时显式传 `-Skip:$false`，且用 `Write-GatewayPatchRefusal -Public` 变体（**不打印**那句"想强行启动：加 -SkipGatewayPatchCheck"）。理由：`gateway-patch-gate.ps1` 的拒绝文案本来会主动广告这个开关，在暴露面最大的入口等于教用户怎么关掉鉴权。**两条约束都由 `gateway-startup-gate-spec.mjs` §8/§9 断言守住**（含负向断言"`start-tunnel.ps1` 的代码里不含 SkipGatewayPatchCheck"，防止旁路被重新引入）。<br>**不得削弱**：局域网路径的 opt-out 与其文案必须保留（`gateway-startup-gate-spec.mjs:217` 断言提示 3 存在）；`Test-GatewayPatchApplied` 的三个 `ShouldCheck = $false` 分支与 `CheckRunner` 语义**逐字未改** |
| **本轮已只读核查（本机）** | 插件 **0.10.3** 装在 `%USERPROFILE%\.dsh\profiles\web\node_modules\`；`lib/index.mjs` **恰好 1 个锚点 + 1 个** `DSH_OUTPOST_MGW_AUTH_PATCH` 标记；`index.mjs.orig` 备份存在；`state.json` 哈希与 `apply.mjs:47` 的 `KNOWN_SOURCES` **匹配** ✅ |
| **必须扩展的地方** | ✅ **SEC-01 已于 2026-11-11 实施轮修复**（commit `b302501`）—— 门禁已扩展到 `start-tunnel.ps1`，**且没有从 `start-dsh-web.ps1` 移除任何东西**。门禁在隧道脚本里**只调用一次**，位置在 cloudflared 检查之后、两处 `schtasks /Create`（`:334`、`:530`）与「定位 dsh」之前，单点即覆盖两处 DSH 启动点；`-Stop` / `-Status` 在此之前已早退，只读操作不受影响 |
| **⚠️ P2.1 修正（复核驳回 `b302501` 后）** | `b302501` 的接线是 `if ($gate.ShouldCheck) { ... }`，而 `Test-GatewayPatchApplied` 有**四条**返回路径、其中**三条** `ShouldCheck = $false`（skip / `plugin-not-installed` / `patch-script-missing`）—— 那三条**静默放行**，公网隧道会在**从未确认 `/mgw/*` 有认证**的情况下发布到公网。`plugin-not-installed` 最危险：它来自路径探测，而三处路径来源不一致（`start-tunnel.ps1:238` 用 `DSH_HOME ?? USERPROFILE`、`setup-gateway.ps1:35,58` 硬编码 `USERPROFILE`、`apply.mjs:57-67` 用 `os.homedir()`），`DSH_HOME` 一旦指向别处就**假阴性**。<br>**修法**（commit `5f11964`）：新增 `Resolve-PublicTunnelGatewayGate`，**只有一条放行路径**（`ShouldCheck=$true` 且 `ExitCode` 严格为整数 0），其余含 `$null` gate、缺字段、非整数退出码、未识别 Reason 全部拒绝；`start-tunnel.ps1` 另加 `try/catch` 使检查器抛异常变成显式拒绝。**`Test-GatewayPatchApplied` 与局域网路径逐字未改**。<br>**守卫**：新增 `gateway-public-gate-spec.mjs`（**真实执行**门禁代码块与真实 `apply.mjs`，不做字符串匹配），修前 **51/29**、修后 **89/0**、变异反证 **55/34**；`gateway-startup-gate-spec` 增加反向断言「不得再用 `if ($gate.ShouldCheck)`」，**54/0**。详见 `06` §九 |
| **⚠️ P2.2 边界修正** | `[int]$null` 在 PowerShell 里等于 **0**，所以检查器没给退出码时 `Test-GatewayPatchApplied` 返回 `ExitCode=0`，与"检查通过"无法区分，而 P2.1 的决策函数拿到的是**折叠后**的值 → 公网放行。用两个真实函数组合复现：`COMP\|True\|patch-verified`。<br>**修法**（commit `0b76e97`）：在转换**之前**记录纯附加字段 `ExitCodeProvided`，决策函数要求它存在且严格为 `$true`；顺带堵住第二个缺口——`if ('false')` 在 PowerShell 里为真，故 `ShouldCheck` 必须是严格布尔。放行条件收紧为三者同时成立。<br>**`[int]$result.ExitCode` 那行原样保留**：它对局域网是承重的（LAN 无 try/catch，转换异常 = 崩溃即拒绝；改成"安全返回 0"会让 LAN 从拒绝变成放行，已由变异 C 实测证明）。<br>**局域网行为差分证明**：修复前后两个模块跑同样 9 个场景，LAN 可见的 `ShouldCheck`/`ExitCode`/`Reason`/`Output` **`diff -u` 输出为空**。spec 修前 **101/31** → 修后 **136/0**；三个变异反证 129/7、133/3、135/1。详见 `06` §十 |
| **测试状态** | `mobile-gateway-patch-spec.mjs` 是**真实的强测试**（应用补丁 → `node --check` @ `:133` → 执行打过补丁的路由断言 fail-closed 503/401/403 @ `:211-242` → 断言拒绝未知版本 @ `:310`）。**但没有任何 CI 步骤运行 `apply.mjs --apply`** → CI 的集成测试跑的是**未打补丁的 gateway**（TEST-14(d)） |

### 8. `loginWithToken` 前清 cookie jar

| 项 | 内容 |
|---|---|
| 位置 | `core/transport/index.ts:236-244` |
| 堵的 fail-open | 去掉这个**顺序**会复活"**任何 token 都能通过**"的陈旧 cookie 绕过 |
| 唯一守卫 | ⚠️ **无** —— `integration-gateway-reconnect.mjs` 通过它 seed，但没有测试断言这个顺序，也没有测试断言 303 情形 |

### 9. 凭据写入/删除后的读回校验

| 项 | 内容 |
|---|---|
| 涉及 | `secureStore`、`credentialMigration`、`serverIdentity`、`loginIntent` |
| 为什么承重 | 把**静默的存储失败**变成**可发现的状态** |
| **关联 SEC-06（需修，但修法是"真的去检查"）** | `secureStore.ts:50-54` 把 keychain 结果标成 `Promise<unknown>`，`:156-161` **从不检查**；真实 API 是 `Promise<false \| Result>`（`react-native-keychain/lib/typescript/index.d.ts:17`），`false` 表示**写入失败**。而 shim（`_keychain-shim.cjs:41-45`）**永不返回 `false`** → **这条路径在测试里不可能被发现**。**修 SEC-06 = 让这个读回校验真的生效**，不是删掉它 |
| **关联 SEC-04** | `credentialMigration.ts:629-637` 清 **4** 个键，`secureStore.ts:201-209` 清 **5** 个（多一个 `gatewayServerBinding`）→ 迁移后残留绑定。**修法是让两个集合相等** |

### 10. Token 文件 ACL 纪律

| 项 | 内容 |
|---|---|
| 位置 | `Protect-StateFile`、`start-dsh-web.ps1:383-412` |
| **必须扩展（SEC-05）** | `start-tunnel.ps1:269, 415, 469` 把**含 token 的 DSH 日志**写到 `%TEMP%`，而 `:566` 是裸 `catch {}`。`docs/security.md:140` **声称不落盘**（文档漂移，CQ-04）。**修法是把 ACL 纪律扩展到 TEMP 日志，不是在任何地方删掉它** |
| 已知的重复实现（CQ-01） | ACL 逻辑重复 **3 份 + 1 处缺口**。**收敛时要"补齐缺口"，不是"取最宽松的那份"** |

### 11. 隧道服务姿态

| 环节 | 位置 |
|---|---|
| **loopback-only 绑定** | `tunnel-service.mjs:528`（`127.0.0.1:3199`） |
| Origin 白名单，**403 before action** | `:454-458` |
| token 剥离 | `:312-326` |

**⚠️ 关键的耦合关系：**

> **"无 Origin 时放行"之所以安全，完全依赖 loopback-only 绑定。这两者永远不能拆开。**

如果将来有人为了某个场景把绑定改成 `0.0.0.0`，**必须同时**把"无 Origin 放行"改成拒绝。

**关联 BUG-15**：`tunnel-service.mjs` 没有 `server.on('error')`；start 缺少 repair 里已有的去重（`:511-514`）。**修 BUG-15 时不得触碰绑定地址与 Origin 策略。**

### 12. Butler 的 `fresh()` 重解析 + "持久化队列不是授权"

| 项 | 内容 |
|---|---|
| 位置 | `dsh-outpost-butler/lib/workspace-fs.js:34-39`（`fresh()`）、`:20-23`（`inside()`）、`:24-27`（`verifyRoot()` 的 dev/ino）、`:14-16`（符号链接拒绝）；`lib/task-manager.js:89-94`（队列规则） |
| 为什么承重 | **缓存已解析的路径会重新打开"祖先符号链接交换"的 TOCTOU** —— 设计注释里明确写了这一点。同理，"持久化的队列**不是**授权"意味着重启后不能因为队列里有记录就当作已批准 |
| 唯一守卫 | ⚠️ **零测试** —— `workspace-fs.js` 的 81 行**从未被任何测试执行**（TEST-06）。**这是整个"不可简化"清单里守卫最薄弱的一项：设计意图只存在于注释中** |
| 建议 | **优先补测试**（TEST-06），判据是"把 `fresh()` 换成缓存版本，测试必须失败" |

---

## 五、Android 原生：六个历史修复已在 HEAD 验证完整

我逐一核查了六个原生侧修复提交，**全部在 HEAD 里完整存在，无回退**：

| 提交 | 内容 | 核查结论 |
|---|---|---|
| **`946e291`** | 把 background-display 的等待移出 RN native-modules 队列 | ✅ **完整** —— `AgentModule.kt:25-27` 创建 daemon 单线程 `startExecutor`；`startCloud`（`:75-96`）在队列**之外**跑 `startAndWait(5_000, …)`；队列上**没有其它多秒级阻塞**；残留的队列工作都是短的（memory 方法的磁盘 IO `:154-179`、Keystore 操作、`backgroundFrame:303-309` 的 PNG 压缩+base64、Shizuku binder 调用、首次 `AgentRuntime.get` 时的一次性 `RunRecovery` 扫描 @ `AgentRuntime.kt:71`）；`PhoneBridge.kt:207-240` 与 `OutpostAccessibilityService.type():213-242` 的 `Thread.sleep` 循环**只跑在 agent worker 线程** |
| **`9028d26`** | 阻止 phone `type()` 盲写进已改变的屏幕 | ✅ **完整** —— `type()` 中途**复检包名**，以 `SCREEN_CHANGED_DURING_TYPE` 中止（`:221-227`） |
| **`9727238`** | `keyOutput` 的回退范围 | ✅ **完整** —— **只**对 `ACCESSIBILITY_NO_ACTIVE_WINDOW` 回退到空屏（`PhoneTools.kt:64-85`） |
| **`2a27192`** | `FileRunStore` 原子性 | ✅ **完整** —— temp + fsync + `ATOMIC_MOVE`（含回退，`RunStore.kt:276-307`）；损坏 → FAILED + `requiresReconciliation`（`:215-257`）；逐 run `runCatching`；16,000 字符裁剪 + 只留最近 4 条工具结果（`AgentLoop.kt:94-126, 146, 149`）；**审批从不恢复**；prune 把终态 run 上限压到 60（`:131-138`） |
| **`9cef57e`** | 阻止已保存的 API key 跟随 provider 变更 | ✅ **完整** —— `AgentSettingsStore`：Keystore AES/GCM 包裹（`:110-147`）、endpoint-identity 密钥失效（`:57-85`）、`clear()` 同时清 prefs 与 alias、**密钥从不跨桥**（JS 只拿到 `hasKey`） |
| **`ebcc9a1`** | 审批权威链 | ✅ **实质内容已核实**（见 §四 第 3 条的五环） |

**另外两个提交不属于 Android 原生：**
- **`d4c0869`**（让 runtime host 熬过瞬时心跳探测失败）—— 修复在 **`runtime/host.mjs:262-284`**，已核实：一个卡住的 `WIRE_BACKPRESSURE` tick 被**跳过而非致命**；Java 侧仍然是 15s 无心跳 / 20s 调度间隔就停（`RuntimeSupervisor.java:59-67`）。**这个组合是安全的**：健康的 host 现实中不可能静默 15s，而死掉的 host 在停止序列进行到 7s 时就被 SIGKILL 了。
- **`2325d34`**（记录一个在 create 中途被取消的任务已分配的 session）—— **只改 butler JS**。

### 原生侧其它已核查为正确的设计

| 项 | 证据 |
|---|---|
| **生产原生代码里没有协程** | grep 验证。并发用 Executors / Handler / Thread / `ReentrantLock` + `Condition`（`AgentRuntime.kt:622-680`，**仅 worker 线程**）。唯一的协程使用是**测试专用**（`KeychainStorageValidationTest.kt:111`，在 `tearDownClass:126` 取消）→ **无 GlobalScope / runBlocking 风险** |
| **Promise 单次结算** | 所有 `@ReactMethod` 都用 try/catch 包裹并以单个 `fail()` 结算（`AgentModule.kt:430-434`）；`LocalDshModule.install():121-145` 与 `stop():68-88` 在私有 worker 上有单结算路径 |
| **资源释放** | `AgentModule.invalidate():418-424` 关闭 executor 并 close `BackgroundDisplayController`；`LocalDshModule.invalidate():43`  detach observer |
| **无障碍 fail-closed** | **没有** `recycle()` 调用，并有显式注释说它已是 deprecated no-op（`:146-151`，可接受——工具已按 SDK ≥31 门控）；`rootFor` 捕 `Throwable` → null（`:398-414`） |
| **API 级门控** | 除 memory 路径（**BUG-05**）外**处处都有**：`AgentModule.kt:426`、`AgentService.kt:69-73, 81-86`、工具门控 SDK ≥31、`windowsOnAllDisplays`（API 33）在 try/catch 里、`RuntimeSupervisor` 门控 SDK <28（`:123`） |
| **构建矩阵自洽** | minSdk 24 / compile+target 36 / buildTools 36.0.0 / NDK 27.1.12297006 / Kotlin 2.1.20 / Gradle 8.14.3；AGP 通过 RN 的 gradle-plugin includeBuild 引入。`jdk21.init.gradle` 在 JDK 21 上编译、字节码 17（Java 与 Kotlin 都是）。release 里 `minifyEnabled=false`，所以空的 `proguard-rules.pro` **无害**。release 回退到 `signingConfigs.debug`（`app/build.gradle:191`），**但** `taskGraph.whenReady` hook（`:221-252`）会在缺 `DSH_STORE_FILE` 时抛错 |
| **FGS 正确范例** | `DshRuntimeService.java`：3 参 `startForeground` + `FOREGROUND_SERVICE_TYPE_DATA_SYNC`（API 29+，`:64-65`）、带 15 分钟超时的 WakeLock（`:69-70`）且在 `finish():87` 与 `onDestroy:90` **都释放**、**两个** `onTimeout` override（`:88-89`）、null-intent → `interrupt("user-stop")`（`:41`） |
| **BUG-10 的正确修法** | `AgentService` 缺 `onTimeout`。**把上面这个模式抄过去，不要重新设计** |
| **CloudModel / Http** | `Http.kt:10-11` connect 15s / read 120s；`:45` **禁用重定向**（所以 `Authorization` 永不跨 host 重放）；**任何地方都没有重试逻辑** → 不会有重复的非幂等 POST；`CloudModel.kt:92-93` API key 脱敏；`:968-979` 强制 HTTPS-or-loopback；畸形 SSE → protocol-error Failure（**永不是空 success**）；`:890` UUID 合成 call id |
| **ShareInbox** | 有界 executor + AbortPolicy、size/deadline 双界拷贝、原子记录、`.use` 游标（`:188-190`）、`hasActiveReactInstance` 守卫（`:45-51`） |
| **BackgroundDisplayController 帧路径** | 锁内**身份校验**的 bitmap 回收（`:714-756`）、监听器移除、`frameThread.quitSafely()`（`:816-824`） |

---

## 六、回归测试方案汇总（按"改这里之前必须先有什么"组织）

| 想改的地方 | 必须先补的测试 | 判据（怎么证明测试有效） |
|---|---|---|
| `transport/index.ts` 的 `call()` 超时（**BUG-02**） | **3-A**：`res.json()` 永不 resolve | 当前**挂起 → 超时失败**（红），修后绿 |
| `fold/index.ts` 的工具结果绑定（**BUG-03**） | **1-A / 1-B / 1-C**（见 §一 行为 1） | 三个用例当前**全部红**，修后绿；且 `fold-spec.mjs:189-232` **仍绿** |
| `foldEventsIncremental` 的扫描/拷贝（**PERF-02(b)**） | 把 `streaming-perf-f03-spec.mjs:655-724` 的边界 2A/2B 扩到 **≥5000 事件**，断言增量 ≡ 全量**逐字段相等** | 故意让缓存不失效 → **必须失败** |
| `reconcilePendingNow` 记忆化（**PERF-02(a)**） | 断言 `pendingSends.list()` 调用次数从 O(rebuilds) 降到 O(有新 user/message) | 去掉记忆化 → 次数上升 → 失败 |
| `workspace-fs.js`（**TEST-06**） | 真实临时目录 + 符号链接 fixture：越界拒绝、dev/ino 变化检出、祖先符号链接交换被 `fresh()` 拦下 | 把 `fresh()` 换成缓存版本 → **必须失败** |
| `pendingSend/state.ts` 的 confirm/accept 竞态（§二 第 7 条） | 先 `confirm` 再 `accept` | 去掉 `:148`/`:164` 的 no-op → **必须抛 `PendingSendPostAcceptError`** |
| `loginWithToken` 的 303 与清 jar 顺序（§二 第 11 条） | mock 303；断言结果由 cookie jar 决定 | 去掉 `:236-244` → **必须失败** |
| `openWebSocket` 的 Cookie 参数（§二 第 2 条） | 静态断言第三参含 `Cookie`（过渡）；理想是断言握手请求头 | 删掉第三参 → **必须失败** |
| Store 拆分（**ARCH-01**） | **前置是 TEST-12**：引入 react-test-renderer，让 34 个 `.tsx` 真的渲染 | 写一个故意泄漏 effect 的组件 → **必须失败** |
| `net-security.ts` 收编四条旁路（**ARCH-04**） | 把 182 行从 TEXT-ONLY 变成 EXEC；枚举网络原语的静态 spec | 加一个新的裸 `fetch` → **必须失败** |
| `.ps1` 脚本任何改动（**BUG-06 / TEST-16(b)**） | 一条 `windows-latest` leg，用 **`powershell.exe`(5.1)** 做语法校验 | 写一个 `Write-Warn` → **必须失败**（这正是 BUG-06 至今存在的原因） |
| CI 打 gateway 补丁（**TEST-14(1)**） | 断言 CI 日志里出现补丁应用；校验 `state.json` | 把插件换成未打补丁版本 → 集成测试**必须失败或拒绝启动** |

---

## 七、总评

| 维度 | 结论 |
|---|---|
| **六项历史修复是否还在** | ✅ **全部在**，`e0216f9` 逐字节匹配 HEAD，六个原生提交全部核实完整 |
| **六项是否有真实测试** | **4 项 COVERED**（行为 2、4、5、6 的 store/state 层）；**3 项 WEAKLY-COVERED**（行为 1、3、6 的 UI 层） |
| **最强的测试** | `ws-disconnect-spec.mjs` —— 用**有界时间**断言（`withTimeout(pending, 2000)`），所以回退修复会**挂起 → 失败**而不是静默通过。这是设计得最好的一种断言方式 |
| **最单薄的守卫** | 行为 4（断线重连去重）**押在单个文件**上；`openWebSocket` 的 Cookie 参数**零守卫**；`loginWithToken` 的 303 与清 jar 顺序**零守卫**；`workspace-fs.js` **零守卫** |
| **最可惜的一处** | `RuntimeInstallerChecks.java` 里约 **40 项极好的失败注入检查**，但它不是 JUnit，**从不自动运行**（TEST-17）。**加一行 `./gradlew :agent-core:test` 就能让 38 个已写好的测试生效** |
| **静态型测试的处置** | **不要删。** 它们是若干 UI 层不变量的唯一守卫，而 UI 层目前**写不出行为测试**（TEST-12）。正确做法是**改断言方式**，长期随 TEST-12 的解决**逐条替换** |

**一句话结论：** 六项历史修复**都还在，而且大部分有真实的、设计良好的测试守着**。真正的风险不是"修复被回退了"，而是**三处守卫单薄到"改坏了不会被发现"**（`openWebSocket` 的 Cookie 参数、`loginWithToken` 的 303/清 jar 顺序、`workspace-fs.js` 的整个沙箱边界），以及**一批已经写好却从不执行的测试**（38 个 agent-core JVM 测试 + 约 40 项 RuntimeInstaller 检查）。

**因此本文档的核心建议是：在做任何重构之前，先把"改坏了会不会被发现"这个问题的答案从"不知道"变成"会"。**

---

*本文档由只读审计产生，未修改任何业务代码。所有"测试是否为真"的判定均基于对测试源文件的直读（是否真实 import、断言的是行为还是文本、回退修复是否会失败）；标注为"待验证假设"的项已说明未能验证的原因。*
