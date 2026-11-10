# 03 · 潜在 Bug 与安全风险

> 审计基线：`opt/p1-phone-polish` @ `2325d34`。所有引用行号均已实读核对；子 Agent 报告中未通过复核的结论已被剔除或改写（见文末 §四）。
> 编号：`BUG-nn`（正确性）、`SEC-nn`（安全）。按严重度排序。
> 置信度：**已确认** = 实读代码且缺陷可推导；**高可信风险** = 代码路径明确存在、触发条件已推理但未执行验证；**待验证假设** = 需实测确认。
> 本轮**未执行**完整测试链、未构建、未联网、未跑模拟器。凡未观测到的结果一律不下结论。

---

## 一、Critical

### BUG-01 · `npm test` 的 `&&` 链在首个失败处截断后续全部套件与类型检查 · High · 已确认

> **⚠️ 第二方复核修订（2026-11-11）**：本条原标记为 **Critical**，理由是"它使『测试是绿的』这个前提不可靠"。**复核意见指出该表述错误，现已采纳并撤回。**
>
> `&&` 链的语义是**失败即截断**：任何一环非零退出，后续命令不再执行，**链整体以非零退出 → CI 显示红色**。因此**一条完整跑通的 `&&` 链不会产生假绿**；绿色确实意味着 103 条命令全部通过。原先把"失败截断"与"假绿"混为一谈，夸大了本条的风险性质。
>
> **真正的假绿向量是另外两件事，必须分开评价：**
> | 现象 | 是否造成假绿 | 归属 |
> |---|---|---|
> | **失败截断**（本条 BUG-01） | ❌ **不造成假绿** —— 退出码非零，CI 是红的。危害是**诊断信息不完整**：拿不到后续套件的结果，且链尾 `tsc --noEmit` 可能根本没跑 | BUG-01 · **High** |
> | **静默 skip** | ✅ **造成假绿** —— `skip` 不计入退出码，插件缺失时整组契约测试**零断言通过** | **TEST-03 · Critical**（已复现，见 `05`） |
> | **测试从未被 CI 执行** | ⚠️ **不造成假绿，但造成覆盖空洞** —— 绿色只代表"跑过的那部分通过" | TEST-17、6 个孤儿 npm script |
>
> **严重度调整**：BUG-01 **Critical → High**；**TEST-03 High → Critical**（Critical 名额转移，总数不变）。

**位置**：`dsh-mobile/package.json:18`（`test` 脚本）；结构性放大器 `dsh-mobile/tests/support/component-harness.mjs:18`

**证据**：`test` 脚本是 **89 个 `npm run` 链接、展开为 103 次进程 spawn** 的单条 `&&` 链（本人以脚本传递展开复核，逐类计数：**68 × `tsx` 裸调用、8 × `tsx --test`、12 × `node --test`、14 × 裸 `node`、1 × `tsc --noEmit`**；`test:integration` 另 5 条、`test:node20` 另 5 条，合计 **113** 条叶子命令）。任何非零退出都会截断其后所有内容——包括链尾的 `npm run typecheck`。

作者在 `git show 9c17dbd` 中**逐字记录了这件事已经发生过**：

> "npm test is an && chain, so these two failures stopped it before roughly 60 downstream suites and typecheck ever ran; the branch had no full green run."

结构性根因在 `component-harness.mjs:18`：
```js
return loadSource(path.posix.normalize(path.posix.join(path.posix.dirname(file), name)) + '.ts', modules);
```
相对 import 未命中 mock 表时**硬编码追加 `'.ts'`**。于是一个过期的 `.tsx` mock key 变成文件系统 ENOENT，**中断整个进程**，而不是失败一条断言。

**影响（修订后）**：
- **不是假绿**。失败时 CI 确实是红的。
- 真实危害是**诊断能力**：一次失败只报告第一个问题，其余约 60 个套件与 `tsc --noEmit` 的结果**完全未知**，修复必须串行地"修一个、重跑、再看下一个"。`9c17dbd` 的作者正是这样被拖慢的。
- 次生危害：因为链尾是 `tsc`，**类型检查在链上任何一处失败时都不会执行**，所以"红"的分支同时失去了类型信号。
- 因此本条是**工程效率与可诊断性**问题，不是**正确性信号被伪造**问题。后者的严重度更高，归 TEST-03。

**建议修复（修订后 —— 撤回原 glob 方案）**：

> **原建议 `node --test tests/**/*-spec.mjs` 已撤回。** 复核意见指出：必须兼容 CI 的 Node 20，必须保留 `tsx` / `node` / `npm script` 三种原有执行语义，不得使用未经验证的 glob 命令替换整条链。**采纳。** 撤回理由（本人核实）：
> 1. 103 条命令里有 **76 条依赖 `tsx`**（68 裸调用 + 8 `--test`）来加载 `.ts`。`node --test` 不能直接跑 `.ts`，需要额外 loader —— 这会改变执行语义。
> 2. `test:node20` 的 5 条命令依赖 `--require ./tests/support/node20-sim.cjs` 注入（删掉全局 `WebSocket` 以复现 Node 20）。统一 runner 必须原样保留这个前缀。
> 3. `--test` 的 glob 位置参数支持是**版本相关**的；`package.json` 的 `engines` 是 `>=20`，CI 固定在 **20**。**具体从哪个 Node 版本起支持，本轮无法在不访问外部资料的前提下确认 → 标记待验证**，因此不得依赖它。

**修订后的方案**：新增一个**聚合器脚本**，它
- **不重新发明命令**：仍然从 `package.json` 的 `scripts` 出发，按 `&&` 与 `npm run X` **传递展开**出与今天**逐字相同**的叶子命令，然后用 `spawnSync(file, args, { shell: false })` **原样执行**（`node --require …` / `--test` 等前缀原样透传）；
- **`tsx` 与 `tsc` 走各自的 JS 入口，而不是 `node_modules/.bin`**：`tsx` → `node_modules/tsx/dist/cli.mjs`、`tsc` → `node_modules/typescript/bin/tsc`，都用 `process.execPath` 启动。原因是 Node 20.12+ 出于 **CVE-2024-27980** 拒绝在没有 `shell: true` 时 spawn `.cmd`/`.bat`，而开 shell 就得自己处理引号注入。**这个坑在本轮开发中被真实触发过**（子进程全部返回 -1，而"非零退出"断言因此假通过，是靠"退出必须由守卫导致"那条标记断言抓出来的）；
- **只改失败处理**：把"首个失败即停"改成"**跑完全部、收集每一条的退出码与输出、最后汇总并以非零退出**"；
- **不使用 glob、不使用 shell 通配**：文件枚举用 `fs.readdirSync`（Node 20/24 行为一致），命令枚举用 `package.json` 解析；
- **保留 `tsc --noEmit` 必跑**：它不再因为前面失败而被跳过。

**修改风险**：**低-中**。聚合器**不改任何被测 spec 的断言**，因此不引入行为变化；风险在于 (a) 串行跑完全部会让原本被截断的失败**同时暴露**（这是预期的，但第一次跑会看到一批红）；(b) 若后续引入并行，可能暴露共享 `globalThis` shim 状态问题（见 `05` 报告 TEST-04）——**本轮保持串行**，不并行化。

**验证方法**：
- 负向测试：构造两个必定失败的假 spec，断言聚合器**报告了两个失败**且退出码非零（`&&` 链只会报告第一个）。
- 断言聚合器展开出的命令列表与旧链**逐字一致**（防止漏跑或多跑）。
- 断言 `tsc --noEmit` 在前置 spec 失败时**仍然执行**。

**本轮实施建议**：**已实施**（复核授权范围第 2 项，commit `9211da8`）。实施记录、设计与验证证据见 `06_OPTIMIZATION_ROADMAP.md` §八「补记 · 第 2 项」。要点：`package.json` 三条公开脚本名未改，声明式链条改名为 `*:chain` 原样保留并作为唯一真值来源；新增 `tests/run-suite.mjs` 传递展开后逐条 `spawnSync(shell:false)` 执行，跑完全部再汇总。

上面三条「验证方法」**全部落实**，其中第三条（`tsc --noEmit` 在前置失败时仍然执行）值得单独说明：这是 BUG-01 的**真正**危害所在，所以 `suite-runner-spec.mjs` §4 专门造了一条前置必失败的 fixture 链 `node f/fail1.mjs && tsc --noEmit`，断言 tsc 桩仍被调用、仍收到原样 `--noEmit`、且汇总单独报告了类型检查状态。**变异反证**：给聚合器的执行循环插入 `if (code !== 0) break;` 模拟 `&&` 截断后，该 spec 从 75 通过变成 **67 通过 / 8 失败**，新增的 3 条 tsc 断言**全部转红** —— 说明它们不是空断言。

本机实跑 **`npm test` 106 条命令 / 106 通过 / 0 失败 / 433.4s / exit 0**（含末条 `tsc --noEmit`，日志明确打印"类型检查（tsc --noEmit）：已执行且通过"）。**CI 上（Node 20 / ubuntu）仍未验证。**


---

## 二、High

### BUG-02 · `DshConnection.call()` 在读响应体之前就撤销了超时定时器 → 永久挂起 · High · 已确认（本人复核）

**位置**：`dsh-mobile/src/core/transport/index.ts:398` 与 `:440`（`call()`）；对照组 `request()` @ `:482`、`:523`、`:536-538`

**证据**：
```ts
// call()：定时器在**收到响应头**时就撤销
396:        signal: ctrl.signal,
397:      });
398:      clearTimeout(timer);          // ← 此处
...
439:      try {
440:        parsed = (await res.json()) as { result?: RpcResult<T> };   // ← 无保护
441:      } catch { parsed = undefined; }
```
兄弟方法 `request()` **把定时器保持到读完整体**：
```ts
482:    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
523:      const text = await res.text();
536:    } finally { clearTimeout(timer); }
```

项目自己已经认定"响应体阶段卡死"是真实故障模式：`tests/transport-request-spec.mjs:77-90` 的 fake `text()` 在 `init.signal` abort 之前永不 resolve，并断言 `/请求超时/`。**但 `call()` 没有对应测试。**

更糟：`tests/timeout-throttle-spec.mjs:72-77`（纯静态正则）要求 `call()` 内 `clearTimeout(timer)` 出现 **≥2 次**——**正确的单一 `finally` 修复会让这条检查失败**。也就是说现有测试 actively 阻碍修复。（附带事实：该 spec 目前**不在 CI 中**，见 TEST-02。）

**影响**：`call()` 承载 `session/prompt`（`__timeoutMs: 180_000`，`rpc/session.ts:117`）、`session/page`（60s）、`session/list`。服务端返回 200 响应头后卡住响应体时，Promise **永久挂起**：
- `runPendingSend` 到不了 :2810 也到不了 :2847 → 记录停留在 `sending`（不进 `unknown`，用户在重启 App 前得不到任何恢复手段）
- `ChatScreen` 的 `finally`（:549-552）永不执行 → `sending` 恒为 `true`，发送按钮死掉、spinner 永转
- `loadOlder` 的 `loadingOlder`（:2273）永不清除

这正是「pending 状态无法结束」这一历史故障类在 **HTTP 侧**的复现。

**建议修复**：把 `call()` 的 `clearTimeout(timer)` 移进包裹整个响应体读取的 `finally`，与 `request()` 对齐；或对 `res.json()` 再套一层有界 race。随后放宽 `timeout-throttle-spec.mjs:72-77`，改为断言"每条退出路径都清了定时器"而非统计出现次数。

**修改风险**：**低**，但位于受保护的 transport 文件内。加 `finally` 在正常路径上不改变任何行为；唯一行为差异是"慢响应体现在会在 `timeoutMs` 处 abort 而非永久挂起"——这正是意图。

**验证方法**：新增 `call()` 版本的 `transport-request-spec.mjs:77-90`：fake `fetchImpl` 返回 `{ ok:true, json: () => new Promise((_,rej)=> init.signal.addEventListener('abort', …)) }`，断言 `/请求超时/`。

**本轮实施建议**：**建议优先实施**（先补测试，再改一行位置）。

---

### BUG-03 · 工具结果绑定缺口 → 工具卡永久转圈 + 完成卡永久消失 · High · 已确认（本人复核，两个子 Agent 独立命中同一处）

这是本轮**证据最强**的功能缺陷：DSH 通信审计与 RN 客户端审计从两个方向独立定位到同一根因。

**位置**：`dsh-mobile/src/core/fold/index.ts:469-496`（`tool/result`）、`:501-511`（`turn/end`）、`:904-914`（`applyAuthoritativeRunningOverride`）；渲染侧 `src/components/ToolCard.tsx:152-157`

**证据 A — id 提取不对称**：
```ts
// assistant/message 里的 tool-call 块（:402-406）接受三种拼写
const callId = (typeof rawBlk.callId === 'string' && rawBlk.callId)
            || (typeof rawBlk.id === 'string' && rawBlk.id)
            || (typeof rawBlk.toolCallId === 'string' && rawBlk.toolCallId) || '';
// tool/call（:434-438）同样接受三种拼写
// 但 tool/result（:469-471）只接受两种：
const callId = (typeof message.toolCallId === 'string' && message.toolCallId)
            || (typeof d.toolCallId === 'string' ? d.toolCallId : '');
```
**没有 `callId` / `id` 回退。**当结果两种拼写都不带时：
- 若之前没有块的 `callId === ''` → `target` 为 `undefined`，而 `else if (callId)`（:483）为假 → **结果被静默丢弃**，原块 `pending` 永为 `true`
- 若确实有块的 `callId === ''` → `find`（:474-476）返回**第一个**（无 `pending`/`output` 守卫）→ N 个结果全部覆写 1 号块，2..N 号块永久 `pending`

同一个 `''` 还会**在上游禁用去重**：:407-409 与 :441-443 都是 `callId ? find(…) : undefined`，所以一个无 id 的 `assistant/message` tool-call 加一个无 id 的 `tool/call` 会产出**两个块**（即历史上修过的"重复工具调用块"回归）。

**证据 B — `turn/end` 从不清理 pending**：
```ts
501:      case 'turn/end': {
505:        b.turn.running = false;
506:        b.turn.endedAt = ev.time;
507:        b.turn.reason = reason?.kind;
```
无 `blocks[].pending` 清扫。`pending` 在整个文件中**只有一处**被清除：`:482`。

**证据 C — 权威恢复也不清理块**：`applyAuthoritativeRunningOverride`（:904-914）只做 `copy[copy.length-1] = { ...last, running: false }`，**从不遍历 blocks**。

**影响链**：`toChatItems:650-654` 要求 `!t.steps.some(s => s.blocks.some(b => b.kind==='tool' && b.pending))`。因此**单个卡住的 `pending` 会永久压制完成卡**，并在一个 `reason:'completed'` 的轮次里留下永久 spinner（`ToolCard.tsx:152-157` 的状态**只**由 `block.pending` / `isError` 推导）。fold 对已持久化事件是确定性的，所以**重连/重放不会自愈**。

触发场景（任一）：证据 A 的 id 缺失；`backfillReconnectGap`（`store.ts:2088-2127`）的安全上限放弃补洞；WS 中断/轮次中止发生在 tool-call 之后；服务端对被取消的工具从不发 `tool/result`。

**注**：轮次级 `running` 的修复**是已测量覆盖的**（`tests/streaming-perf-f03-spec.mjs:585-610` 断言 `running===false` 且 `turns.at(-1).running===false`）。**但没有任何测试断言块级 pending**，而代码可证明不处理它。

**建议修复（第 3 项已按第二方复核意见重写）**：
1. 给 :469-471 补上与 :402-406 / :434-438 相同的 `message.callId` / `message.id` / `d.callId` / `d.id` 回退；
2. 当解析出的 `callId` 为 `''` 时，只匹配仍处于 `pending && output === undefined` 的块（**绝不**盲取首个），否则追加独立块而非丢弃；
3. **`turn/end` 时把剩余 `pending` 工具块标记为「结果未达 / 异常终止」，而不是「完成」。**

> **⚠️ 第二方复核修订（2026-11-11）**：第 3 项原文是"`pending = false` 且 `output ??= '（未收到工具结果）'`"。**复核意见指出：缺失 `tool/result` 不能自动等同工具执行成功，必须保留未知状态或异常终止语义，且不得产生自动重试。采纳 —— 原写法确实会造成"等同成功"，证据如下（本人核实）。**
>
> `ToolCard.tsx:152-158` 的状态是**三态推导**，且**成功是默认分支**：
> ```js
> const statusColor = block.pending ? tv.colors.textTertiary
>                   : block.isError ? tv.colors.danger
>                   : tv.colors.success;
> const statusText  = block.pending ? '执行中' : block.isError ? '失败' : '完成';
> ```
> 所以只把 `pending` 置 `false` 而**不动 `isError`**，卡片会渲染成 **"完成" + success 配色** —— 一个从未收到结果的工具被显示为成功执行。这正是复核意见要禁止的语义。
>
> **修订后的第 3 项**：`turn/end` 时对仍 `pending` 的工具块同时设置
> - `pending = false`（停止永久 spinner，解除 `toChatItems:650-653` 对完成卡的压制 —— 该判定**只看 `pending`，不看 `isError`**，已核实）；
> - **`isError = true`**（渲染为"失败" + danger 配色，即**异常终止**语义，而非成功）；
> - `output ??= '（未收到工具结果，轮次已结束）'`（明确说明是**未知**，不是空成功）。
>
> **不得产生自动重试 —— 已核实成立**：`isError` 在全仓的消费点只有三处，**全部是展示层**：`ToolCard.tsx:152-158`、`WorkGroupCard.tsx:46`（同样的 `执行中/失败` 三态文案）、`workGroup.ts:114`（`const failed = toolBlocks.some((b) => b.isError)`，只写入纯视图对象 `WorkGroupView`）。`grep -rniE "retry|resend|requeue"` 在 `workGroup.ts` 与 `WorkGroupCard.tsx` 中**零命中**；`store.ts` 里唯一的 `retry` 是 `:2593` 的 `pendingSends.retry(requestId)`，属**持久化发件箱**、以 `requestId` 为键，与工具块无任何耦合。**因此标记 `isError = true` 不会触发任何重发。**
>
> **需要一并复核的副作用**：`workGroup.ts:114` 的 `failed` 会让包含该工具的 WorkGroup 整体显示为失败。这是**期望的**（确实有工具没跑完），但会改变可见状态，属于第 4 节"必须先用测试固定当前行为"的范围。
>
> **禁止的写法**（明确记录，防止后续实施走偏）：不得只清 `pending` 而不设 `isError`；不得把 `output` 留空（空 output + `isError=false` = 看起来像成功的空结果）；不得在 `turn/end` 里补发任何请求或重放事件。


**修改风险**：**中**。:469-496 正是提交 `e0216f9` 改过的函数，且 `07_REGRESSION_PROTECTION.md` 将 `foldEvents` 的工具合并逻辑列为不得重构区。**任何改动必须先补 fold-spec 用例。**第 3 项会改变可见的完成卡行为，需一并复核 `ebcc9a1` 时期的审批/完成语义。

**验证方法**：新增 `fold-spec.mjs` 用例：
- (i) `tool/result` 携带 `data.callId`；
- (ii) 两个无 id 的 `tool/call` + 两个无 id 的 `tool/result` → 断言 2 个块、都 `pending === false`、output 各不相同；
- (iii) `tool/call` 无匹配 `tool/result`，随后 `turn/end reason:{kind:'completed'}` → 断言无块 `pending === true`、完成卡未被压制，**且该块 `isError === true`、`output` 非空**（即渲染为"失败"而非"完成"）。
- **(iv)（复核后新增）负向断言：上述场景不得产生任何重发** —— 断言 fold 是纯函数、`turn/end` 处理后没有任何出站请求被排队（可通过断言注入的 transport spy 调用次数为 0 实现）。
真机：在工具调用中途杀掉网关 → 前台化 → 观察卡片在一个轮询周期内到达终态，**且显示为"失败"而不是"完成"**。

**本轮实施建议**：**本轮不实施**（不在第二方复核授权的 4 项范围内）。后续实施时**必须先补测试**（用例 (i)(ii)(iii)(iv) 先落地并确认当前失败，再改代码），且必须遵守上方"禁止的写法"。


---

### BUG-04 · 全应用无任何 React 错误边界 → 任一渲染期抛错白屏 · High · 已确认（本人 grep 复核）

**位置**：全应用；根组件 `src/App.tsx`、`src/nav/NavHost.tsx:491-516`

**证据**：`grep -rnE 'componentDidCatch|getDerivedStateFromError|ErrorBoundary' dsh-mobile/src/` → **零命中**。完整读过 `App.tsx`（1 686 行）与 `NavHost.tsx`（534 行）确认无边界。`NavHost` 直接渲染每个屏幕、无包装；`App.tsx` 直接渲染 `NavHost`。

`store.ts` 的 `flushEmit`（:1575-1579，由 `timeout-throttle-spec.mjs:141-146` 断言）对每个 listener 做了 try/catch——但那**只保护订阅回调，不保护渲染**。

**影响**：流式过程中一个畸形事件/块（意外的 `item.kind`、坏 markdown 结构、未预期的工具载荷）会卸载整个 React 根 → release 构建下**白屏且无任何恢复入口**。`NavHost.tsx:491` 让所有已挂载屏幕常驻，因此**整个栈共享同一命运**。

**建议修复**：在 `NavHost` 每个栈条目外包一层 class ErrorBoundary，应用根再包一层；fallback = 错误卡片 + "重试/返回"并重置状态；通过既有 notify 通道上报。

**修改风险**：**中**（↑ 原评"低（纯增量）"，按第二方复核意见 4 上调）。
**验证方法**：dev-only 开关强制 ChatScreen 渲染期抛错，断言兄弟屏幕存活且 fallback 显示。

> **⚠️ 第二方复核修订（2026-11-11）—— 复核意见 4，已采纳**
>
> 复核意见：**ErrorBoundary 必须有真实渲染行为测试，不能将其定义为零风险修改。**
>
> **本人核实：原评级内部自相矛盾。** 原文同时声称"风险 **低**（纯增量）"与"验证方法：断言兄弟屏幕存活且 fallback 显示"。但同一份审计的 **TEST-12** 已证明：
> - **34 个 `.tsx` 从不真正渲染**；
> - `component-harness.mjs:28` 的 `useEffect() {}` 是**空实现** → effect 从不执行；
> - `useState` 的 setter **不触发重渲染**，`useMemo`/`useCallback` **丢弃依赖**。
>
> 错误边界的**全部价值**恰好是"子树在**渲染期**抛错时被 `getDerivedStateFromError` 捕获并渲染 fallback"。**这正是当前 harness 无法观察的行为。** "纯增量"只说明它不改现有代码路径，**不等于**它的行为正确性可被验证：一个从未被真实渲染测试覆盖的 ErrorBoundary，可能因为挂载位置错误、fallback 自身抛错、或 `componentDidCatch` 里的 `store` 调用二次抛错而**完全不生效，且没有任何测试会变红**。
>
> **新增前置条件**：必须先具备真实渲染测试能力（真正的 reconciler，如 `@testing-library/react-native` 或等价物），能 render 一棵子树、让它在渲染期抛错、并断言 fallback 出现且父级状态未损坏。**现有的 `component-harness.mjs` 不能用于验证本项。**

**本轮实施建议**：❌ **本轮不实施**（不在第二方复核授权的 4 项范围内；原为"建议立即实施"，现移出本轮，等 TEST-12 的渲染测试能力就位后再做）。

---

### BUG-05 · 记忆相关 bridge 方法缺少 API 级别守卫 → Android 7.0/7.1 必崩 · High · 已确认（本人复核）

**位置**：`dsh-mobile/android/app/src/main/java/com/dshpocket/agent/AgentModule.kt:154-179`（`getMemory` / `saveMemory` / `deleteMemory`）；`AgentMemoryStore.kt:7-9,110,115,122`；`android/build.gradle:4`（`minSdkVersion = 24`）

**证据**：同文件的兄弟方法都有守卫——`AgentModule.kt:426` 定义 `private fun supported() = Build.VERSION.SDK_INT >= 26`，且例如 `dismissRecovery`（:183）第一行就是 `if (!supported()) { promise.reject("AGENT_UNSUPPORTED", …); return }`。**但三个记忆方法没有**：
```kotlin
154:    @ReactMethod
155:    fun getMemory(promise: Promise) {
156:        try {
157:            promise.resolve(AgentMemoryStore(react).list().toString())
158:        } catch (error: Exception) {
159:            fail(promise, error)
160:        }
161:    }
```
`AgentMemoryStore` 使用 `java.nio.file`：
```kotlin
7:  import java.nio.file.AtomicMoveNotSupportedException
8:  import java.nio.file.Files
110:        Files.createDirectories(directory.toPath())
115:                Files.move(
122:                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
```
`java.nio.file` **自 API 26 起才存在**。在 API 24/25 上抛的是 `NoClassDefFoundError`——它是 `Error` 而非 `Exception`，**`catch (error: Exception)` 抓不到**，会击穿 native-modules 线程，且 **Promise 永不 settle**。

JS 侧无门控直达：`src/core/agent.ts:223-226`、`src/screens/AgentMemoryScreen.tsx:25,50,70`。

**影响**：任何运行 Android 7.0/7.1 的受支持设备上，用户打开记忆屏幕或 Agent 保存记忆时**必然崩溃**（不只是功能失效）。`minSdkVersion 24` 声明支持这些设备。

**建议修复**：给三个记忆方法加 `supported()` 守卫（以清晰错误码 reject）；**或**把 `AgentMemoryStore` 里的 `java.nio.file` 换成 `File.renameTo` + `FileOutputStream.fd.sync()`（API 24 可用）。同时审计其余未加守卫的 `@ReactMethod` 是否还触及别的 API 26+ 类。

**修改风险**：低（加守卫）/ 低-中（改写存储；`renameTo` 跨文件系统不保证原子，但 temp 与目标同目录）。
**验证方法**：新增 SDK 24 下的 Robolectric 或 instrumented 测试调用 `saveMemory`；或一个 JVM 反射测试，断言每个触达 `AgentMemoryStore`/`AgentThreadStore` 的 `@ReactMethod` 要么检查 `supported()`、要么其存储不使用 `java.nio.file`。
**本轮实施建议**：**建议立即实施**（加守卫是三行改动）。
**备选方案说明**：也可以把 `minSdkVersion` 提到 26——但那是产品决策（放弃 Android 7.x 用户），且 `.github/release-floor.json` 与 `docs/device-checklist.md` 都需同步。**不建议在审计轮替用户做这个决定。**

---

### SEC-01 · 隧道路径完全绕过网关鉴权补丁门禁，却把 DSH 暴露到公网 · High · 已确认（本人 grep 复核）

**位置**：`start-tunnel.ps1`（DSH 启动在 :262-280 与 :444-476）；对照 `start-dsh-web.ps1:114-127`；`scripts/gateway-patch-gate.ps1`

**证据**：`start-dsh-web.ps1:114` 定位门禁脚本、:127 调用 `Test-GatewayPatchApplied`，未打补丁时**拒绝启动**。而在 `start-tunnel.ps1` 中 grep `patch|gate|mgmt|requireAuth` → **0 命中**（本人复核：`start-tunnel.ps1` 对 `gateway-patch-gate` / `Test-GatewayPatchApplied` 的引用计数为 **0**，`start-dsh-web.ps1` 为 **4**）。但 `start-tunnel.ps1` **自己启动 DSH**：
```powershell
444: $dshArgs = @('--profile','web','--no-open','--host',$bindIp,'--port',"$Port",'--trusted-host',$domain)
475: $null = cmd /c "schtasks /Create /TN `"$taskName0`" /TR `"`"`"$batPath`"`"`" /SC ONCE /ST 00:00 /F >nul 2>&1"
```
随后把它发布到公网 `trycloudflare.com` URL（:340-359）。而 `setup-gateway.ps1` 已经把 `adminLoopbackOnly` 写成 `false`（:147、:160）。门禁 spec 的头部注释把保证范围**只**限定在 `start-dsh-web.ps1`。

**失败场景**：
1. DSH 升级/重装 → 网关包文件被替换 → mgmt-auth 补丁静默失效（`patches/…/state.json` 为 0.10.3 钉住了 pristine/patched SHA-256，升级即失效）
2. 用户运行 `start-tunnel.ps1`（从不重跑被门禁保护的脚本）
3. 未打补丁的 DSH 启动并暴露到公网，`adminLoopbackOnly: false`
4. `/mgw/*` 管理端点在无注入的 `requestRejection` 下运行 → **任何找到隧道 URL 的人都能访问管理面**

**影响**：这正是补丁 + 门禁存在所要关闭的风险，却出现在**暴露面最大**的启动路径上。

**建议修复（已按第二方复核意见重写 —— 撤回"沿用 `-SkipGatewayPatchCheck` 退出口"）**：

> **⚠️ 第二方复核修订（2026-11-11）**：原文建议"沿用同一个显式 `-SkipGatewayPatchCheck` 退出口"。**复核意见指出：SEC-01 涉及公网暴露，应优先核实；公网隧道启动路径不得通过普通跳过参数绕过必要的鉴权门禁。采纳。**
>
> **为什么原建议是错的（本人核实）**：`scripts/gateway-patch-gate.ps1:74-81` 里 `-Skip` 直接返回 `ShouldCheck = $false`，调用方随即静默放行；而 `Write-GatewayPatchRefusal` 的**最后一行（:156）主动把这个开关广告给用户**：
> ```
> 确认不需要手机审批、想强行启动：加 -SkipGatewayPatchCheck
> ```
> 在**局域网**路径上这是一个经过权衡的 opt-out（暴露面限于同网段，`start-dsh-web.ps1:110` 的注释也写明"仅用于你确认不用手机审批时"）。但把它照搬到**公网隧道**路径上，等于在暴露面最大的入口提供一个"一行参数即可关闭鉴权门禁"的旁路，而且**拒绝提示自己会教用户怎么用这个旁路**。这与门禁存在的目的直接冲突。

**修订后的修复方案**：

1. `start-tunnel.ps1` **不新增 `-SkipGatewayPatchCheck` 参数**（该脚本当前没有这个参数 —— 保持这样）；调用门禁时**显式传 `-Skip:$false`**，使"公网路径永不跳过"成为代码事实而非约定。
2. 在**两处** DSH 启动（`:262-280` 的 `$taskName0`、`:474-476` 的 `$taskName`）**之前**、且在"定位 dsh"之前 dot-source `scripts/gateway-patch-gate.ps1` 并调用 `Test-GatewayPatchApplied`；`ShouldCheck -and ExitCode -ne 0` → `exit 1`（fail-closed）。缺门禁文件本身也 `exit 1`（照抄 `start-dsh-web.ps1:115-121`）。
3. **拒绝文案必须区分公网场景**：给 `Write-GatewayPatchRefusal` 增加一个 `-Public` 开关，在公网路径上**不打印** `-SkipGatewayPatchCheck` 那一行，改为明确说明"公网隧道不提供跳过开关；请修复补丁，或改用局域网路径 `start-dsh-web.ps1`"。这样既保住"提示文案集中一处、可被测试断言措辞"的原有契约，又不在公网入口广告旁路。
4. **不改动门禁的判定逻辑**：`Test-GatewayPatchApplied` 的三个 `ShouldCheck = $false` 分支（skip / plugin-not-installed / patch-script-missing）与 `CheckRunner` 语义**逐字保留**，`start-dsh-web.ps1` 的行为**完全不变**（其现有 spec 的 8 条静态断言与 12 条行为断言必须仍绿）。

**修改风险**：**低-中**（原评"低"，因新增 `-Public` 文案分支而上调）。缓解：门禁判定逻辑零改动，只增加调用点与一条文案分支；`start-dsh-web.ps1` 不受影响。**残余风险**：`start-tunnel.ps1` 是用户日常入口，加门禁后**未打补丁的用户会被挡住** —— 这是预期行为（fail-closed），但需在拒绝文案里给出可执行的修复命令（`apply.mjs --apply` / `setup-gateway.ps1`，两者门禁模块已打印）。

**验证方法**：扩展 `dsh-mobile/tests/gateway-startup-gate-spec.mjs`（它已在真实 PowerShell 下调用门禁函数，并遵循"CI 无 PowerShell 即 `bad()`"的 fail-closed 约定，见 `:98-100`）：
- **静态**：`start-tunnel.ps1` dot-source 门禁、调用 `Test-GatewayPatchApplied`、`ExitCode -ne 0` → `exit 1`、门禁位于两处 `schtasks /Create` **之前**；
- **负向**：断言 `start-tunnel.ps1` **不含** `SkipGatewayPatchCheck` 参数声明（防止旁路被重新引入）；
- **行为**：真实 PowerShell 下调用 `Write-GatewayPatchRefusal -Public`，断言输出**不含** `SkipGatewayPatchCheck`、但**仍含** `apply.mjs --apply` 与"拒绝启动"；同时断言不带 `-Public` 时**仍含** `SkipGatewayPatchCheck`（局域网路径的 opt-out 不被削弱）；
- **反证**：沿用该 spec §5 的既有手法，构造坏门禁确认断言不是恒真。

**本轮实施建议**：✅ **已实施**（复核范围第 1 项，commit `b302501`）。门禁在 `start-tunnel.ps1` 里**只调用一次**，位置在 cloudflared 检查之后、两处 `schtasks /Create`（`:334`、`:530`）与「定位 dsh」之前 —— 单点调用即覆盖两处启动点，避免把门禁逻辑复制两份（那正是 CQ-01 的债务类型）。`-Stop` / `-Status` 在此之前已早退，只读操作不受影响。**`Test-GatewayPatchApplied` 的判定逻辑零改动**，`start-dsh-web.ps1` 行为完全不变。负向测试先行（修前 13 失败 → 修后 51 通过 / 0 失败），双向变异反证，PS 5.1 语法解析通过。详见 `06` §八。


---

### SEC-02 · Electron 主进程把未校验的 `pairing.port` 插值进 PowerShell 命令串 · High · 高可信风险（本人复核代码，未构造利用）

**位置**：`dsh-outpost-desktop/src/main/main.js:574`、`:671`、`:691`

**证据**：
```js
671:  const port = pairing?.port || 3095;      // 无整数校验
...
691:            `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`,
```
该字符串作为 `powershell.exe -NoProfile -Command` 的参数执行（`execFile`，:684-690）。`pairing.json` 是**用户可写**的——ACL 收紧限制的是*其他*用户，不限制同用户下的篡改或恶意软件。构造 `"port": "3095; <payload>"` 即可在桌面应用的权限下执行任意命令。

**对照**：`doctor.ps1:131` 对同一个值做了 `[int]` 强转，说明项目已知这类输入需要校验。

**影响**：本地权限持久化向量；抵消 ACL 加固的成果。注意这**不是**远程可利用——需要先能写 `pairing.json`。

**建议修复**：加 `Number.isInteger(port) && port > 0 && port < 65536` 守卫；或改用 `-File` + 参数数组传递（不经 shell 解析）。

**修改风险**：**低**。
**验证方法**：单元测试守卫函数；在测试 profile 里篡改 `pairing.json`，确认被拒绝而非执行。
**本轮实施建议**：**建议立即实施**（一行守卫）。

---

### BUG-06 · `start-tunnel.ps1` 调用未定义的 `Write-Warn` 与未定义的 `$dshLog` · High · 已确认（本人 grep 复核）

**位置**：`start-tunnel.ps1:439`、`:306-308`；`$ErrorActionPreference='Stop'` @ `:44`

**证据**：
- `:133` 只定义了 `function Write-Warn2($msg){…}`。`:439` 调用的是 `Write-Warn`：
  ```powershell
  439:    Write-Warn '[!] 权限模式 = danger-full-access：DSH 的审批将被关闭。'
  ```
  在 EAP=Stop 下抛 `CommandNotFoundException`，**恰好在传入 `-PermissionMode danger-full-access` 时**中断隧道重启，且发生在 DSH 启动（:444-476）**之前**。也就是说：**用户选择最危险的模式时，脚本崩溃在一个本该是警告的地方，而 DSH 根本没起来。**
- `:306-308` 在首次启动的诊断分支里读 `"$dshLog"`，但该分支定义的是 `$dshLog0`（`:269`）；`$dshLog` 直到 `:415` 才定义 → 空串绑定错误，**"DSH 启动失败"的诊断路径自己崩掉**。

**影响**：两个用户可见的失败路径变成崩溃而非警告/诊断。第二个尤其糟糕——它正好在最需要诊断信息的时刻失效。

**建议修复**：`:439` 改为 `Write-Warn2`；`:306-308` 改用 `$dshLog0`。

**修改风险**：**trivial**。
**验证方法**：`powershell -NoProfile -File start-tunnel.ps1 -PermissionMode danger-full-access -Status` 式干跑；引入 PSScriptAnalyzer（可静态检出未定义命令与未定义变量）。
**本轮实施建议**：**建议立即实施**。附带建议：把 PSScriptAnalyzer 接进 CI（见 `05` 报告 TEST-16）。

---

### BUG-07 · `test-qr.mjs` 根本无法执行，2 条断言恒真 · High · 已确认（本人 grep 复核）

**位置**：`dsh-plugin-connect/test-qr.mjs:13-14`、`:44`、`:71`

**证据**：
```js
13: const start = src.indexOf('const QR_CAPACITY_L');
14: const end = src.indexOf('/** 把矩阵画成 SVG path');
15: const qrCode = src.slice(start, end);
```
本人 grep 确认：`client.js` 中 `const QR_CAPACITY_L` 命中数 **0**，`把矩阵画成 SVG path` 命中数 **0**。因此 `start === end === -1`，`src.slice(-1,-1) === ''`，`new Function` 的函数体退化为 `return { buildQrMatrix };` → 调用时 `ReferenceError`。

即便它能跑，另有两处断言恒真：
```js
44:  check('定位图形中心是白的', !m1[2][2] || m1[2][2] === false || true); // ← || true
71:    if (m2[6][i] !== i % 2 === 0) timingOk = false;   // ← 优先级错误：(m2[6][i] !== i) % 2 === 0 → 恒假
```

**影响**：`client.js` 中 2 295 行 vendored QR 生成路径**零有效测试覆盖**，而仓库看起来是有测试的。QR 是配对流程的入口——生成错误意味着用户扫不出码。

**建议修复**：把抽取锚点改为 `client.js` 2319+ 区域中真实存在的符号（如 `buildQrMatrix` 的实际定义），或通过模块接缝导出；删除 `|| true`；给 `:71` 加括号。

**修改风险**：**低**。
**验证方法**：`node test-qr.mjs` 退出 0 且断言非恒真（故意破坏 QR 生成应导致失败）。同时需要给该模块加 `test` 脚本并接入 CI（TEST-18）。
**本轮实施建议**：**建议优先实施**。

---

### TEST-08 · `npm test` 在 CI 中调用 Gradle 最多 5 次（每次 600s 超时），且核心否定断言 fail-open · High · 已确认

**位置**：`dsh-mobile/tests/release-signing-gates-spec.mjs:82,118-127,149,154,164,170,176,187`；`.github/workflows/android.yml:52-90`

**证据**：
- `:82` 只在 `gradlew` **文件**不存在时跳过——该文件已提交，所以**永不跳过**。
- `:118-127` 设 `timeout: 600000`；`run()` 在 `:154,164,170,176,187` 被调用 **5 次**。
- `test` job（`android.yml:52-90`）**没有 `setup-java`、没有 `sdkmanager` 步骤、没有 `actions/cache`**——这些只存在于 `build-test`/`release` job（:138-164、:224-284）。`android.yml` 的任何 job 都**没有 `timeout-minutes`**（只有 `signing-verify.yml:54` 有）。
- 判定函数 fail-open：
  ```js
  149: const isFailure = (r) => r.code !== 0 || /BUILD FAILED/.test(r.output);
  154: check(isFailure(r), 'assembleRelease 缺签名材料时拒绝构建');
  ```
  **任何** Gradle 环境失败（无 JDK、无 SDK、EACCES）都满足 `isFailure` → 断言通过。该 spec 自己的注释（:93-98）记录了**这个假阳性以前就发生过**。`:170,176` 的正向 `isSuccess` 断言只部分缓解。

**影响**：「单元测试」步骤成了 CI 中最慢、最不封闭的部分（5 × 600s 上限，无 job 超时），而它的核心否定断言可能因为**完全错误的原因**通过。

**建议修复**：把 Gradle 行为 spec 移到已经准备 JDK+SDK+缓存的 job；`isFailure` 改为要求 `/BUILD FAILED/` **且**包含门禁专属消息；给 `android.yml` 四个 job 都加 `timeout-minutes`。

**修改风险**：中（CI 结构调整）。
**验证方法**：破坏 `JAVA_HOME`，确认否定断言**失败**而非通过。
**本轮实施建议**：建议排期优先。

---

### TEST-02 · 142 个 spec 中有 20 个从不在 CI 运行 · High · 已确认（本人程序化复核）

**方法**：从 CI 实际执行的根脚本（`test`、`test:integration`、`test:node20`，见 `android.yml:73,83,90` 与 `signing-verify.yml:149,153`）出发，**传递展开**所有 `npm run X` 引用，再与 `tests/*.mjs` 求差。结果：CI 触达 92/107 个脚本；**20 个 spec 文件从不执行**。

**从不运行的 spec**（完整列表）：
```
butler-client-spec.mjs            local-butler-placement-spec.mjs   local-runtime-profile-spec.mjs
butler-memory-spec.mjs            local-butler-state-spec.mjs       login-security-spec.mjs
e2e.mjs                           local-butler-ui-spec.mjs          p0-verify-behavior-spec.mjs
entry-gate-spec.mjs               local-only-entry-spec.mjs         p0-verify-spec.mjs
file-save-share-spec.mjs          local-profile-spec.mjs            throttle-behavior-spec.mjs
host-location-spec.mjs            local-runtime-client-spec.mjs     timeout-throttle-spec.mjs
                                  local-runtime-host-spec.mjs       version-code-spec.mjs
```
**CI 永不触达的 npm 脚本**：`test:localRuntime`、`test:p4`、`test:p3`、`test:e2e`、`test:perf`、`test:filesave`（另 6 个 `test:integration:*` 只是别名，其父脚本 `test:integration` 是被执行的）。

**其中最要紧的四组**：
1. **`version-code-spec.mjs`** —— 它守护的 `scripts/version-code.mjs` 正是 CI release job 的 **Gate 2**（`android.yml:301`）。**发布版本号门禁自己没有门禁。**
2. **`timeout-throttle-spec.mjs` + `throttle-behavior-spec.mjs`** —— transport 超时/节流守卫，与 BUG-02 直接相关。
3. **`local-runtime-host-spec.mjs` + `local-runtime-profile-spec.mjs`** —— 覆盖 `dsh-mobile/runtime/host.mjs`，也就是提交 `d4c0869`（心跳容错）的修复所在。**该修复在 CI 中无守卫。**
4. **`login-security-spec.mjs`** —— 一个安全 spec 从不运行。

**注**：本人实际执行了其中一个孤儿（`node tests/version-code-spec.mjs` → **25 通过 / 0 失败**，`duration_ms 31`，退出码 0，本机 Node v24 / Windows——**不是** CI 的 Node 20 / ubuntu）。这是观测结果，非推断。执行后仓库未变更。

**影响**：约 14% 的测试资产是装饰品；其中包含发布门禁与安全 spec。

**建议修复**：把这 6 个脚本并入 `test` 链，或明确删除。若并入，需先解决 BUG-01（否则只是增加链长）。

**修改风险**：**低**（但可能立即暴露既有失败——这是收益而非风险）。
**验证方法**：重跑上述传递展开脚本，要求孤儿数为 0。
**本轮实施建议**：**建议立即实施**（与 BUG-01 一起做）。

---

### TEST-03 · 真实网关契约套件静默跳过且仍退出 0 · **Critical**（↑ 原 High） · 已确认（本人复核 + **本轮实测复现**）

**位置**：`dsh-mobile/tests/protocol-contract-spec.mjs:46-49,60-85,417`；`tests/crosscheck-revoke-self-spec.mjs:82-102,315`；对照 `tests/approval-gateway-f01-spec.mjs:60-63`；CI 侧 `.github/workflows/signing-verify.yml:52-53,147-149` vs `.github/workflows/android.yml:54-57`

**证据 A —— 退出码不含 skip**：
```js
46: function skipped(n, why) {
47:   skip += 1;                       // ← 只增 skip
48:   console.log('  SKIP  ' + n + (why ? ' — ' + why : ''));
49: }
...
417: process.exitCode = fail === 0 ? 0 : 1;    // ← skip 不参与退出码
```

**证据 B —— 本轮实测复现（本地 Node v24.13.0 / Windows）**：把 `HOME`、`USERPROFILE` 指向空临时目录、`DSH_GATEWAY_PLUGIN_DIR` 指向不存在路径后运行：

| spec | 正常（插件可解析） | 复现（插件不可解析） | 退出码 |
|---|---|---|---|
| `protocol-contract-spec.mjs` | **16 通过 / 0 跳过** | **6 通过 / 10 跳过 / 0 失败** | **0** |
| `crosscheck-revoke-self-spec.mjs` | **5 通过 / 0 跳过** | **0 通过 / 5 跳过 / 0 失败**（**整组零断言**） | **0** |

**证据 C —— 这在今天的 CI 里正在发生（不是假设）**：
- `pluginDir` 的候选列表（`protocol-contract-spec.mjs:65-83`）只有三项：`DSH_GATEWAY_PLUGIN_DIR`、`%USERPROFILE%\.dsh\profiles\web\node_modules\…`、`$HOME/.dsh/profiles/web/node_modules/…`。**不含 `dsh-mobile/node_modules/dsh-plugin-mobile-gateway`**，而那正是 `npm ci` 实际安装的位置。
- `android.yml:54-57` 在 `test` job 上设了 `DSH_GATEWAY_PLUGIN_DIR: ${{ github.workspace }}/dsh-mobile/node_modules/dsh-plugin-mobile-gateway` → **那个 job 上能解析、测试确实在跑**。
- **但 `signing-verify.yml` 没有设**（本人 grep 确认 `android.yml` 是**唯一**设置它的 workflow），而它在 `:147-149` 跑的是**完整的 `npm test`**（含 `test:contract` 与 `test:crosscheck`），runner 是 `ubuntu-latest`（`:53`）→ `USERPROFILE` 未定义、`$HOME/.dsh/…` 不存在 → **`pluginDir === undefined` → 15 条契约断言全部 skip → 两个 spec 均 exit 0 → 该 workflow 报绿**。
- **结论：`signing-verify.yml` 里的网关契约交叉检查，当前是一个"报告成功的空操作"。**

**证据 D —— 仓库内已有正确范式，三个 spec 处理同一前置条件却给出两种相反结果**：
```js
// approval-gateway-f01-spec.mjs:60-63 —— fail-closed（正确）
if (!pluginDir) {
  console.error('FAIL: 未找到真实 dsh-plugin-mobile-gateway 插件目录');
  process.exit(1);
}
```
同样消费该插件的另外两个 spec 却是 fail-open。**这是内部不一致，不是设计选择。** 另一处对照：`gateway-startup-gate-spec.mjs:98-100` 的 `if (process.env.CI) bad(...) else console.log('  SKIP  ...')`。

**影响**：这是**唯一**能自动防御 `fake-dsh.mjs` 与真实网关漂移的机制（漂移清单见 `05` 报告 §四）。它可以在毫无信号的情况下消失 —— 而且在 `signing-verify.yml` 上**已经消失了**。所守的契约包括：子协议前缀 `dsh-auth.` / `dsh-pair.`、非 GET 管理请求的同源 Origin 校验、撤销语义、`clientDeviceId` 缺失时的设备自识别。

> **⚠️ 第二方复核修订（2026-11-11）**：
> - **严重度 High → Critical**（按复核意见 1，Critical 名额由 BUG-01 转移过来）。理由：这是本轮审计发现的**唯一一条真正让绿灯失真的通道**，且证据 C 表明它**当前正在 CI 上发生**。
> - **原"建议修复"第 1 步（把 node_modules 路径加入 `CANDIDATES`）已降级为可选**：`android.yml` 已通过环境变量覆盖了该路径，加候选并不解决 `signing-verify.yml` 缺环境变量的问题，反而会改变本地开发者的解析顺序。**修复重点改为"在解析点加 fail-closed 守卫"+"补齐缺失的环境变量"。**
> - **`server-identity-binding-spec.mjs` 明确排除**：它的 skip 来自端口复用竞态（`:551,554,562`），属环境抖动而非依赖缺失；让它 `skip>0` 即失败会**引入 CI 抖动**。原条目把它并列进来是不准确的。

**建议修复（两部分必须同时做，否则会把 `signing-verify.yml` 弄红）**：
1. **spec 侧（fail-closed 守卫）**：在两个 spec 的插件解析点照抄 `approval-gateway-f01-spec.mjs:60-63` —— `process.env.CI` 下解析失败即记一条 `FAIL`；并把 `skip > 0 && process.env.CI` 计入非零退出，覆盖"目录解析成功但单个文件缺失"的残余漏洞。**本地无插件时保留 SKIP 行为**（否则没有插件的开发者会被挡在门外）。**不动任何一条断言的判定逻辑，不动 `CANDIDATES` 的候选顺序。**
2. **CI 侧（补齐环境变量）**：给 `signing-verify.yml` 的 `verify-signing` job 加上与 `android.yml:54-57` **逐字相同**的 `DSH_GATEWAY_PLUGIN_DIR`，使契约套件在该 workflow 里**第一次真正执行**。

**修改风险**：**低**。第 1 部分只在"CI 且插件不可解析"这个分支上改变退出码；第 2 部分是新增一个 job 级环境变量，与 `android.yml` 已验证过的写法一致。**残余风险**：第 2 部分生效后，`signing-verify.yml` 会**第一次真正执行**这 15 条契约断言 —— 如果上游插件与客户端已经漂移，它会**立刻变红**。这是**期望的结果**（暴露真实缺陷），但需在交付说明里明确指出，不能当成"改坏了"。

**验证方法**：
- 负向：`CI=1` + `DSH_GATEWAY_PLUGIN_DIR` 指向空目录 → 两个 spec **必须非零退出**（修复前为 0，已实测）。
- 正向：插件可用 → **仍为 exit 0 且 skip 为 0**（防止修复弄坏正常路径）。
- 静态：`signing-verify.yml` 含 `DSH_GATEWAY_PLUGIN_DIR`，且与 `android.yml` 的值一致。
- 反证：把守卫去掉，负向测试必须重新变绿（证明守卫是被测对象，不是恒真断言）。

**本轮实施建议**：✅ **已实施**（复核范围第 3 项，commit `f38d9e2`）。两个 spec 各加**两层**守卫：解析点 fail-closed（照抄 `approval-gateway-f01-spec.mjs:60-63`）+ `CI && skip > 0` 计入失败（覆盖"目录解析成功但单个文件缺失"的残余漏洞）。`signing-verify.yml` 补上与 `android.yml` **逐字相同**的 `DSH_GATEWAY_PLUGIN_DIR`。新增 `tests/contract-skip-guard-spec.mjs` 以**真实子进程**驱动两个 spec 做负向/正向验证（修前 12 失败 → 修后 28 通过 / 0 失败）。**断言逻辑与 `CANDIDATES` 顺序零改动**，本地无插件仍 SKIP。**CI 上补了环境变量后那 15 条断言会第一次真正执行 —— 若上游已漂移，`signing-verify.yml` 会立刻变红，这是期望结果，但本轮无法预知（待验证）。**

---

### TEST-06 · butler 的文件系统沙箱零测试且根本无法被 import · High · 已确认（本人复核）

**位置**：`dsh-outpost-butler/lib/workspace-fs.js:1-10`；`dsh-outpost-butler/package.json`

**证据**：
```js
3: import {SandboxedFileSystem} from '@deepseek-ai/dsh-fs-sandbox';
4: import {FsError} from '@deepseek-ai/dsh-fs';
```
但 `dsh-outpost-butler/package.json` **完全没有 `dependencies` 字段**（本人 cat 确认）。因此在 DSH 宿主之外**无法 import 该模块**。该文件 81 行，包含全部路径遏制逻辑：`inside()`（:20-23）、`verifyRoot()` 的 dev/ino 身份校验（:24-27）、`fresh()` 的 TOCTOU 重解析（:34-39）、symlink 拒绝（:14-16）。

butler 的 `test` 脚本列出 6 个文件（`task-store`、`task-manager`、`task-api`、`deliverables`、`local-commands`、`memory-store`），**没有 workspace-fs**。`lib/domain.js`（139 行）与 `lib/contracts.js`（35 行）同样未被执行。

**影响**：面向模型的文件能力的**全部逃逸防御**未被验证。注意这是"无测试"而非"有缺陷"——安全审计（`03` §四）实读后认为其设计是**正确**的（`fresh()` 重解析确实防住了祖先 symlink 交换 TOCTOU）。但正确的、零测试的安全边界在一次重构后可能静默失效。

**建议修复**：把纯谓词（`inside`、root 身份比较）抽到无依赖模块，用**显式的** `path.win32` 与 `path.posix` 分别单测。

**修改风险**：**低**。
**验证方法**：新增 `test/workspace-fs.test.mjs` 并加入 butler 的 `test` 脚本。
**本轮实施建议**：**建议优先实施**。

---

### BUG-11 · `setup-gateway.ps1` 的原生 stderr 在 EAP=Stop 下杀死自动打补丁流程 · High · 高可信风险

**位置**：`setup-gateway.ps1:33`（`$ErrorActionPreference='Stop'`）、`:87`、`:112`、`:115`

**证据**：`:112` 为 `& node $patchScript --check 2>&1 | ForEach-Object …`。而 `patches/…/apply.mjs` 的 `--check` 把「补丁未应用」分支写到 **stderr**（`apply.mjs:141-143` 经 `console.error`）。在 Windows PowerShell 5.1 下，EAP=Stop 时被重定向的原生 stderr 会抛 `NativeCommandError` → 脚本**恰好死在它被设计来处理的那个分支上**（check 失败 → :115 自动应用）。

**项目自己已知这个陷阱并在别处防住了**：`scripts/gateway-patch-gate.ps1:107-114` 与 `scripts/butler-installer.ps1:4-17` 都把 EAP 切到 Continue 并读 `$LASTEXITCODE`。这是 CQ-01 重复清单第 #3 组的漂移后果。

**影响**：干净 profile 上的首次网关配置可能崩溃而非打补丁；`ANDROID-ACCEPTANCE-GUIDE.md:90` 的验收第 4 步随后以令人困惑的方式失败。

**建议修复**：把 `:87/:112/:115` 包进同样的 EAP-Continue + `$LASTEXITCODE` 模式（或 dot-source `Invoke-ButlerCli`）。

**修改风险**：低。
**验证方法**：PS 5.1 + 未打补丁插件 → `.\setup-gateway.ps1` 应走到"正在应用补丁"。
**置信度说明**：标为高可信风险而非已确认，因为本轮未在 PS 5.1 下执行该脚本。触发条件（EAP=Stop + 重定向原生 stderr）是 PS 5.1 的已知行为，且仓库内已有两处注释明确指出该陷阱。
**本轮实施建议**：**建议优先实施**。

---

## 三、Medium

### BUG-08 · `closeChat` 释放了流但泄漏整棵折叠聊天树 · Medium · 已确认（本人复核）

**位置**：`src/core/store.ts:2911-2926`；调用方 `src/screens/ChatScreen.tsx:275`（卸载时）

**证据**：
```ts
2924:    entry.handle?.close();
2925:    this.streams.delete(sessionId);
2926:  }                      // ← this.chats 仍保留 { turns, items, banners, … }
```
`chats` 的**唯一**另一处删除是 `archiveSession`（`store.ts:1844`）。`close()`（:2960-2971）也只遍历 `streams`。

**影响**：`this.chats` 按访问过的不同会话数单调增长，进程存活期间不释放；每份都持有全部 `Turn`/`Step`/`Block`（含工具的 `input`/`output`/`rawArguments` 字符串）。在手机上浏览多个长会话（`docs/protocol-notes.md:413` 记录过一个真实的 1240 事件会话）会形成**无驱逐的内存爬坡**。

**建议修复**：在 `entry.handle?.close()` 之后删除（或截断为小型 LRU）`chats` 条目。`getChat`（:1890-1901）会从 `{ sessionId, ...EMPTY_CHAT }` 惰性重建，所以移除对重入是安全的——但需确认没有屏幕在没有 `streams` 条目时读 `chats`。

**修改风险**：**中**。`chats` 被多个屏幕读取；过于激进的删除可能在导航转场期间让聊天变空白。
**验证方法**：spec——`openChat` → 灌事件 → `closeChat` → 断言 `store.chats.has(id) === false`（或有界）→ 再 `openChat` → 断言重连并重新折叠。
**本轮实施建议**：排期，需先补测试。

---

### BUG-09 · butler `cancel` / `execute` 交错可遗留一个无人暂停的活跃 goal · Medium · 高可信风险（本人重推交错，机制与子 Agent 报告不同）

**位置**：`dsh-outpost-butler/lib/task-manager.js` — `execute()` :692-726、`cancel()` :210-239、`persist()` 终态守卫 :826-829、`finishLane()` :805-815

**证据（本人实读并重推）**：
`execute()` 的关键序列：
```js
712:    if (this.disposed || this.store.get(id)?.status !== 'preparing') return;   // 同步守卫
714:    const goal = this.goals.create(agent, { … });                              // 同步
719:    await this.persist(id, { goalId: goal.id, …, status: 'running', … });      // 异步
```
`cancel()` 的判定**全部同步**发生在它的第一个 await（:236 `persist`）之前：
```js
211:    let task = this.get(id);                       // 同步快照
217:    const agent = task.sessionId ? this.agents.get(task.sessionId) : undefined;
218:    if (agent && task.goalId) { …goals.pause…; agent.cancel({kind:'user'}) }   // ← goalId 此刻可能还不存在
```
`persist()` 的终态守卫会丢弃**整个补丁**：
```js
827:        if (TERMINAL_STATUSES.has(current.status) && resolved.status && resolved.status !== current.status) {
828:          return current;
829:        }
```

**精确交错**：`cancel()` 在 `execute()` 挂起于 :712 之前的某个 await（如 :707 `resolveAgentCold`）时进入 → 同步读到 `task.goalId === undefined` → **跳过 `goals.pause` 与 `agent.cancel`** → 排队自己的 persist。若 `cancel` 的 persist 在 `execute` 的 :712 守卫之前提交，守卫会看到 `cancelled` 并安全返回；**但若尚未提交**，`execute` 继续到 :714 创建 goal（同步，无法被打断），再到 :719 persist —— 此时 `current.status === 'cancelled'`（终态）而 `resolved.status === 'running'`，**整个补丁被丢弃，包括 `goalId`**。

结果：goal 已创建并在运行，任务记录却是 `cancelled` 且**没有 goalId**，永远不会有任何东西去暂停它。

**部分缓解**：`finishLane`（:812）的 `if (agent?.status === 'running' && this.activeTaskId === id) return;` 会**不释放 lane**，从而阻止启动下一个任务。这限制了爆炸半径，但**不会停止孤儿 goal 消耗轮次**。

**旁证**：紧邻的注释（:695-701）显示团队**已经修过这一类问题的兄弟变体**——提交 `2325d34`「record a session allocated for a task cancelled mid-create」正是为了让 `sessionId` 补丁故意不带 status 从而不被终态守卫丢弃。**同一手法未应用到 `goalId`。**

**影响**：取消后仍有算力消耗与幽灵活动。

**建议修复**：与 `sessionId` 的处理保持一致——把 `goalId`/`goalRevision`/`goalPhase` 拆成一个**不带 status** 的独立补丁先写入，再单独写 `status:'running'`；或在 `cancel()` 中当 `goalId` 缺失时置一个标志，让 `execute()` 在 `goals.create` 之后立即检查并暂停/解除该新 goal。

**修改风险**：**中**（状态机改动；journal 语义必须保持追加式；终态守卫的语义是有意的，不能简单放宽）。
**验证方法**：新增测试——在 `goals.create` 的 await 窗口内 cancel，断言 goal 被暂停且不再消耗轮次。现有 `test/task-manager.test.mjs:153` 覆盖了 sessionId 变体，可作为模板。
**置信度说明**：机制已由本人逐行推导确认；但**是否真的能在生产中命中该窗口**未执行验证，故标为高可信风险。
**本轮实施建议**：排期，**必须先补上那个测试**（测试本身也能确认或推翻该窗口）。

---

### BUG-10 · `AgentService` 的 dataSync 前台服务没有 `onTimeout` · Medium · 高可信风险

**位置**：`android/app/src/main/java/com/dshpocket/agent/AgentService.kt`（全文 152 行，无 `onTimeout` 覆写）；`AndroidManifest.xml`（`foregroundServiceType="dataSync"`）；`app/build.gradle`（`targetSdkVersion 36`）

**证据**：`:74` `startForeground(NOTIFICATION_ID, notification("Agent 运行中"))`，类型为 `dataSync`。Android 15 对 `dataSync` FGS 强制约 6h/24h 运行上限并回调 `Service.onTimeout`；**未覆写时系统抛 `ForegroundServiceDidNotStopInTimeException` 并杀死应用**。

**正确范式就在同一代码库里**：`DshRuntimeService.java:88-89` 同时覆写了 `onTimeout(int,int)` 与 `onTimeout(int)`。

**可达性**：运行可以合法地在 `waiting_user` 空闲数小时（审批/交接门 @ `AgentRuntime.kt:622-680`），所以上限是**可触及的**。

**影响**：Android 15+ 上长时间 Agent 会话期间**应用崩溃**（不只是服务停止）。

**建议修复**：在 `AgentService` 覆写 `onTimeout`——持久化运行状态、按 `RunRecovery` 语义标记为中断、立即 `stopForeground`/`stopSelf`。

**修改风险**：低；需要先决定运行语义（中断 vs 交接提示）。
**验证方法**：Android 15 设备/模拟器手测；短期可在评审中与 `DshRuntimeService` 做一致性检查（现有测试完全不覆盖服务生命周期，见 TEST-17）。
**本轮实施建议**：建议排期优先（照抄同仓库已有范式，风险低）。

---

### BUG-12 · `phone_tap` / `phone_scroll` 作用于未经核验的屏幕 · Medium · 高可信风险

**位置**：`android/app/.../agent/PhoneTools.kt:207-216`（`PhoneTapTool.execute`）、`:268-277`（`PhoneScrollTool`）；`OutpostAccessibilityService.kt:167-186`（`tap`）

**证据**：
```kotlin
override fun execute(call: ToolCall): ToolOutput {
    guard(handoff)?.let { return it }
    val element = stringArgument(call, "element") …
    val result = OutpostAccessibilityService.instance?.tap(element, PhoneBridge.currentDisplayId())
```
位置型 id（`nK`）是在**执行时**的控件树上解析的。`guard()` 会重新检查锁屏/敏感屏幕，但**没有任何东西把动作绑定到模型看到、用户批准的那份快照**。

提交 `9028d26`（"stop phone type() from writing blind into a changed screen"）**恰好为 `type()` 修了这一类问题**（:221-227 的包名重检查 + `SCREEN_CHANGED_DURING_TYPE` 中止），`9727238` 加固了 background-display 的 fail-closed 路径——**但 tap/scroll 没有得到同等待遇**。在 `phone_screen`/审批与执行之间发生异步外部屏幕变化（通知、对话框、自动跳转）时，tap 会落到此刻占据该索引的任意控件上。

**影响**：用户批准的"点发送"可能执行为点击另一个控件。这是 phone-tool 路径上**残留的最强 fail-open**。注意它不是远程可利用，而是"批准语义被削弱"。

**建议修复**：快照时记录每元素签名（package + text/contentDescription/class + path）；执行时重解析并比对；不一致则以 `SCREEN_CHANGED_BEFORE_ACTION` 中止（沿用 `9028d26` 的词汇）。

**修改风险**：**中**——动态屏幕上会产生误中止；缓解方式是只比对稳定属性。
**验证方法**：新增单元测试，用一个在批准与执行之间改变控件树的 fake accessibility service（扩展 `AgentLoopTest` 的 veto 模式）；当前无法测试仅仅因为不存在这个 fake。
**本轮实施建议**：排期。**这属于 `07` 报告所述"必须先补测试"的安全相关区域，不得直接简化。**

---

### BUG-13 · 补丁门禁的静默跳过路径 + 修复提示在非默认 DSH_HOME 下指向错误的树 · Medium · 已确认

**位置**：`start-dsh-web.ps1:140`；`scripts/gateway-patch-gate.ps1:82-97,153`；`patches/…/apply.mjs:57-68`

**证据**：
- `start-dsh-web.ps1:140` 只在 `if ($gate.ShouldCheck)` 时动作，而 `gateway-patch-gate.ps1:82-97` 对 `plugin-not-installed` 与 `patch-script-missing` 两种情况返回 `ShouldCheck=false` **且零输出**。门禁*文件*本身是 fail-closed 的（`start-dsh-web.ps1:115-121`），但**一个缺失 `apply.mjs` 的部署会静默以未打补丁的网关启动**。
- 拒绝时的修复提示（`gateway-patch-gate.ps1:153`：`node patches\…\apply.mjs --apply`，**无 `--path`**）与 `apply.mjs` 的 `defaultPluginPath()`（:57-68，硬编码 `os.homedir()/.dsh/profiles/web`）都**忽略 `DSH_HOME`/`$Profile`**；而门禁自身检查的是 DSH_HOME 感知的 `$gatewayIndex`（`start-dsh-web.ps1:124-128,134`）。**在自定义 DSH_HOME 下，文档给出的修复命令会去补另一棵树，门禁继续拒绝 → 无法赢的修复循环。**

**影响**：安全门禁可以静默空转；用户陷入死循环。与 SEC-01 相邻但独立（SEC-01 是"路径没调用门禁"，本条是"门禁调用了但可能空转/提示错误"）。

**建议修复**：跳过时打印 Reason；让 `apply.mjs` 尊重 DSH_HOME/profile 环境变量，或让提示带上 `--path=$gatewayIndex`。

**修改风险**：低。
**验证方法**：用一个 DSH_HOME 测试 profile（A 处已打补丁），跑门禁 + 按提示修复。
**本轮实施建议**：建议与 SEC-01 一起实施（同一门禁体系）。

---

### BUG-14 · `setup-gateway.ps1` 与 `doctor.ps1` 硬编码 profile 路径，与 DSH_HOME 感知的兄弟脚本矛盾 · Medium · 已确认

**位置**：`setup-gateway.ps1:35,58,87`；`doctor.ps1:178`（对照 :156 尊重 DSH_HOME）

**证据**：`setup-gateway.ps1:35` `$ProfileFile = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'`，:58 插件目录同理，:87 `--profile web`；而 `start-dsh-web.ps1:124` 与 `setup-butler.ps1:33` 都尊重 `DSH_HOME` 与 `-Profile`。`doctor.ps1` **自身内部就不一致**：:156 尊重 DSH_HOME，:178 硬编码。

**影响**：设置了 DSH_HOME 时，`setup-gateway` 会去配置一个**没人运行的 profile**；随后 `start-dsh-web` 的门禁（针对正确目标）要么拒绝、要么让未配置的网关跑起来。`doctor` 会对它刚刚检测到的 DSH_HOME 安装报告"butler 未安装"。

**建议修复**：采用与 `setup-butler.ps1` 相同的 DSH_HOME/`-Profile` 解析。风险低。
**验证方法**：`DSH_HOME=D:\x .\setup-gateway.ps1` 应写出 `D:\x\profiles\web\cordis.patch.yml`。
**本轮实施建议**：排期（与 CQ-01 第 #5 组合并处理）。

---

### BUG-15 · `tunnel-service.mjs` 无 `server.on('error')`，且 `/tunnel/start` 缺少 `/tunnel/repair` 已有的并发去重 · Medium · 已确认

**位置**：`dsh-plugin-connect/tunnel-service.mjs:528`（listen）、`:477-496`（start）、`:511-514`（repair）

**证据**：`:528` `server.listen(PORT,'127.0.0.1',…)` **没有 error 监听器** → EADDRINUSE（残留实例）会以未处理异常崩溃进程，随后 schtasks/autostart 的重启静默竞争。`/tunnel/repair` 有并发去重：
```js
511:  if (!repairPromise) { repairPromise = repairNetwork().finally(…) }
```
`/tunnel/start`（:477-496）**没有等价机制** → 双击会 spawn 两个 `start-tunnel.ps1`，互相争抢 `tunnel.json` 与 cloudflared。

**影响**：服务死掉且无诊断；重复的隧道启动。

**建议修复**：加 `server.on('error')` 记录日志 + 退出码；用同样的单 Promise 模式包裹 start。风险低。
**验证方法**：并发启动两次，观察只有一次运行；占用 3199，观察 EADDRINUSE 被记录。
**本轮实施建议**：排期优先（改动小）。

---

### BUG-16 · 桌面端 `ensureService` 双 spawn 竞争 + 身份盲的 exit 处理 → 孤儿服务占用 3199 · Medium · 高可信风险

**位置**：`dsh-outpost-desktop/src/main/main.js:448-472`、`:1079-1081`

**证据**：spawn tunnel-service 时**无 in-flight 守卫**；exit 处理不检查身份：
```js
462:    serviceProc.on('exit', () => { serviceProc = null; });
```
两次 `ensureService` 重叠时，第二次的赋值稍后被第一次的 exit 事件置空 → 退出清理（:1079-1081）**什么也没杀**，一个服务进程成为孤儿并持有 3199 端口（进而触发 BUG-15 的 EADDRINUSE 崩溃）。

**建议修复**：exit 处理中做身份检查（`if (serviceProc === proc)`），并加 starting-promise 守卫。风险低。
**验证方法**：在 spawn 落定前调用 `ensureService` 两次，断言只有单个子进程且退出时被清理。
**本轮实施建议**：排期。

---

### BUG-17 · `scripts/android-chatscreen-nav.ps1` 给只读自动变量 `$home` 赋值 · Medium · 已确认（本人 grep 复核）

**位置**：`scripts/android-chatscreen-nav.ps1:41-42`；`$ErrorActionPreference='Stop'` @ `:9`

**证据**：
```powershell
41: $home = Get-Ui 'p0-nav-home.xml'
42: Tap-Node $home $WorkspaceName
```
`$HOME` 是 PowerShell **只读自动变量**；赋值抛 "Cannot overwrite variable HOME because it is read-only or constant"，在 EAP=Stop 下终止脚本。即便继续，`Tap-Node $home …` 会拿一个目录路径去做正则匹配。**该脚本永远到不了它的 `NAV_OK` 输出（:61）。** 另外 `:20` 把 dump 写进仓库根目录（`Join-Path $PSScriptRoot "..\_$Name"`）。

**影响**：一个死的导航检查辅助脚本；对"ChatScreen 导航已验证"的虚假信心。

**建议修复**：改名 `$homeUi`；临时文件写到 `$env:TEMP`。风险 trivial。
**验证方法**：对模拟器运行，期望 `NAV_OK`。
**本轮实施建议**：建议实施（trivial）。

---

### SEC-03 · `xlsx@^0.18.5` 是 npm 上无法修复的版本线，却在手机上解析服务端提供的工作簿 · Medium · 高可信风险（**需联网核对 advisory 后确认**）

**位置**：`dsh-mobile/package.json`（`"xlsx": "^0.18.5"`）；`dsh-mobile/src/components/DocumentViewer.tsx:125-127`

**证据**：
```ts
125:  const XLSX = await import('xlsx/dist/xlsx.mini.min.js');
126:  const lib = (XLSX as { default?: unknown }).default ?? XLSX;
127:  const wb = (lib as typeof import('xlsx')).read(String(b64), { type: 'base64' });
```
npm 上发布的 `xlsx` 线止于 0.18.5；SheetJS 后续版本（修复了该线的原型污染与 ReDoS advisory）迁到了自有 registry，因此 **`^0.18.5` 永远无法从 npm 解析到已修复版本**。manifest 中**没有 `resolutions`/`overrides`**。

**攻击场景**：(1) 任务过程中 Agent 把恶意 `.xlsx` 下载/生成到会话工作区（内容源自互联网）；(2) 用户在手机 DocumentViewer 中预览；(3) `XLSX.read` 解析攻击者控制的字节，已知缺陷在 RN 的 JS 上下文内触发。**解析运行在应用主 JS 上下文，不是沙箱。**

**影响**：最坏情况 `Object.prototype` 污染影响全应用逻辑（含安全相关比较）；现实情况 UI 挂死/DoS。附带事实：二进制预览**没有**等同于 `FILE_PREVIEW_MAX_BYTES` 的字节上限。

**建议修复**：vendor 一个已修复的 SheetJS 版本（上游 CDN 的 0.20.x），或用 `overrides` 钉到 vendored tarball；在 Hermes 下重新验证 mini build（项目已为 mammoth shim 了 `TextDecoder`，兼容路径是已知的）。或者：给表格预览加大小上限 + 用户确认步骤。

**修改风险**：中（依赖来源变更；import 路径与 Hermes 行为需重测）。
**验证方法**：目前无 spec 覆盖 DocumentViewer 解析——需新增带 fixture 工作簿的 spec；联网许可后在 CI 加 `npm audit`。
**本轮实施建议**：**先在允许联网时核对 advisory 数据库确认**，再排期。不基于猜测实施。

---

### SEC-04 · `clearAllCredentialStorage()` 漏掉 `gatewayServerBinding` · Medium · 已确认（本人复核）

**位置**：`src/core/credentialMigration.ts:629-637` vs `src/core/secureStore.ts:201-209`

**证据**：
```ts
// credentialMigration.ts:629-637
export async function clearAllCredentialStorage(): Promise<void> {
  await clearLegacyCredentialStorage();
  await Promise.all([
    clearCredential(CredentialKey.cookie),
    clearCredential(CredentialKey.gatewayToken),
    clearCredential(CredentialKey.gatewayDeviceId),
    clearCredential(CredentialKey.gatewayServerDeviceId),
  ]);                                    // ← 4 个键
}
```
```ts
// secureStore.ts:201-209
export async function clearAllCredentials(): Promise<void> {
  await Promise.all([ …同上 4 个…,
    clearCredential(CredentialKey.gatewayServerBinding),
  ]);                                    // ← 5 个键
}
```

**影响**：经迁移助手发起的擦除会留下 server binding。今天残留物是惰性元数据（没有 deviceId 的 binding 不授予任何东西，`serverIdentity` 会在下次配对时重新推导），但**"clear-all 就是 clear-all"这个不变量已被破坏**：将来任何一侧新增键都会静默从另一侧泄漏；而一个过期 binding 可能让后续解析在用户以为已擦除的状态上读出 `confirmed`/`assumed`。

**建议修复**：让 `clearAllCredentialStorage` 委托给 `secureStore.clearAllCredentials`（单一真相源），或补上缺失的键并加一条断言两个键集合相同的 spec。

**修改风险**：**极低**。
**验证方法**：扩展既有 `tests/credential-*-spec.mjs`，加键集合相等断言。
**本轮实施建议**：**建议立即实施**（低风险、防止未来复合）。

---

### SEC-05 · 含配对 token 的 DSH 日志在隧道路径上写入未收紧 ACL 的 `%TEMP%` · Medium · 已确认（本人复核，合并子 Agent 的 SEC-04 与 MOD-03）

**位置**：`start-tunnel.ps1:269,273`、`:415,469`、`:482-503`（token 提取正则 @ `:501`）、`:553-566`

**证据**：DSH 的 stdout（其中含带 `?token=` 的配对链接）经 schtasks bat 重定向到 `$env:TEMP\dsh-web-$Port.log`：
```powershell
269:    $dshLog0 = Join-Path $env:TEMP "dsh-web-$Port.log"
469:    "`"$dsh`" $argString > `"$dshLog0`" 2>&1"
501:  [?&]token=([A-Za-z0-9_\-]+)      # 从该日志中收割 token
```
同一个 token 在别处被小心保护——`:549-550` 注释写着「tunnel.json 含明文 token —— 和 pairing.json 是同一把钥匙，必须同样收紧」→ `Protect-StateFile $StateFile`；`:565` → `Protect-StateFile $pairFile`。**但包含同一 token 的 TEMP 日志既没有 ACL 收紧、也从不删除**（成功路径与 `-Stop` 路径都不删），只会在下次运行时被截断（:417）。

对照：`start-dsh-web.ps1:383-412` **故意把同一份日志移到了 `%LOCALAPPDATA%\dsh-pocket\logs\` 并收紧了 ACL**，而 `docs/security.md:140` 声称「现在在 `%LOCALAPPDATA%\dsh-pocket\logs\`」。**隧道路径重新制造了这个安全修复所移除的暴露。**

另外：整个 pairing.json 重写以一个**裸 `} catch { }`** 结束（`:566`），无任何警告——而 `Protect-StateFile` 自己在失败时是会警告的（:112-116）。若 `Set-Content` 抛错，插件的 QR 会保留旧 token 而控制台打印新 token，用户对着过期状态配对且**没有任何诊断**。

**影响**：`%TEMP%` 在多用户机器上对本机其他用户可读；窗口受 `pairingTtlMs: 300000`（5 分钟）限制，因此严重度为 Medium 而非 High。但它破坏了脚本自己声明的 token 文件保护不变量。

**建议修复**：捕获 `$newToken` 后删除该日志或对其应用 `Protect-StateFile`；把 `:566` 的裸 catch 换成警告（并说明插件 QR 可能已过期）。

**修改风险**：低——需确认重启后的诊断（`:508` 读的是 `$dshLog.err`，另一个文件）不需要这个 stdout 日志。
**验证方法**：目前无 spec 覆盖 `start-tunnel.ps1` 的 token 处理（`tunnel-cors-spec.mjs` 覆盖的是服务）。新增 spec 断言日志被保护/删除；或在 `doctor.ps1` 加一项检查 `%TEMP%\dsh-web-*.log` 的 token 残留。
**本轮实施建议**：**建议优先实施**（同时修掉 `docs/security.md:140` 的文档漂移 CQ-04 #5）。

---

### SEC-06 · Keychain 写入结果从不检查 → 凭据"看起来已保存"而实际未落盘 · Medium · 已确认

**位置**：`src/core/secureStore.ts:50-54,150-162`；shim `tests/support/_keychain-shim.cjs:41-45`

**证据**：产品侧把返回类型标为 `Promise<unknown>` 并**从不检查结果**：
```ts
// secureStore.ts:50-54  →  Promise<unknown>
// secureStore.ts:150-162 → await setGenericPassword(...)，无返回值检查
```
而真实 API 的签名是 `setGenericPassword(): Promise<false | Result>`（`node_modules/react-native-keychain/lib/typescript/index.d.ts:17`）——**失败时返回 `false`，不抛异常**。shim 则**总是**返回 `{service, storage:'keystore-stub'}`（`_keychain-shim.cjs:41-45`）且从不抛错。

**影响**：真机上 Keystore 拒绝写入时（无锁屏、StrongBox 不可用、不支持 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`），`saveCredential()` **成功 resolve 而什么都没持久化**，且不浮现任何错误。没有测试、也没有 `tsc` 能看见这个问题（部分原因是 `tsconfig.json` 把 `tests` 排除在类型检查之外，见 TEST-12）。失败模式是"用户以为配对成功了，重启后又要重新配对"。

**建议修复**：把 shim 与生产接口都定型为 `Promise<false | Result>`；在 `saveCredential` 中检查 `false`；给 shim 加失败注入开关（如 `__failNext`）。

**修改风险**：**低**。
**验证方法**：新增一个开启注入的 spec，必须能观测到失败。
**本轮实施建议**：**建议优先实施**（fail-open 的凭据保存，改动小）。

---

### SEC-07 · Electron 渲染进程 `sandbox:false`，而 preload 只需要沙箱兼容 API · Low · 已确认（设置） / 高可信（可修复性）

**位置**：`dsh-outpost-desktop/src/main/main.js:309`；`src/main/preload.js:10-45`

**证据**：`main.js:307-313` 设了 `contextIsolation:true`、`nodeIntegration:false`，然后 `sandbox:false`，只加载本地文件。`preload.js:10` 仅使用 `const { contextBridge, ipcRenderer } = require('electron');`——**两者对沙箱化 preload 都可用**；QR 生成也故意放在主进程（`qr:make` IPC）。

**影响**：今天渲染进程只执行可信的本地 HTML/JS，因此利用需要一个既有渲染进程 Bug（例如状态渲染中对服务端提供字符串——隧道域名、设备名——的 XSS）。有 `sandbox:false` 时，这样一个 Bug 加上任何 preload/主上下文泄漏，会让被攻陷的渲染进程直接获得 OS 进程访问权，而不是撞在沙箱墙上。**这是纵深防御的一层缺失，不是已知的当前绕过路径。**

**建议修复**：设 `sandbox: true`，验证全部 13 个 preload 方法仍工作（应该可以——未使用 Node API）。保持 `contextIsolation` 与主进程侧参数复校验不动。

**修改风险**：低；需要对每个 IPC 动作做一次冒烟（隧道/DSH 启停、autolaunch、剪贴板）。
**验证方法**：`dsh-mobile/tests/desktop-packaging-spec.mjs` 已在检查桌面主进程设置——扩展它，与 `contextIsolation` 一起断言 `sandbox: true`。
**本轮实施建议**：排期。

---

### SEC-08 · 配对 token 走 URL 查询串 · Low（可接受风险候选） · 已确认行为 / 部分属上游协议固有

**位置**：`src/core/transport/index.ts:246`；`start-tunnel.ps1:515,525,574`

**证据**：
```ts
246: const url = `${this.baseUrl}/?token=${encodeURIComponent(token)}`;
```
```powershell
515: $pairUrl = if ($newToken) { "$url/?token=$newToken" } else { $url }
525: $resp = $client.GetAsync($pairUrl).GetAwaiter().GetResult()
```

**影响**：URL 查询串中的 token 会进入服务端访问日志、代理日志，以及——对 `:525` 的隧道验证 GET 而言——第三方（Cloudflare edge）请求日志。任何在 token TTL 内能读到这些日志的人都能配对设备。**已被以下机制部分限制**：token 的一次性/短 TTL 特性、客户端错误上的 `redactUrl`、`doctor.ps1` 脱敏、`Protect-StateFile`。上游 DSH 的配对流程本身就是 URL-token 式的（`start-tunnel.ps1:456` 注释「没有 API 能查」），因此**完全消除不在本仓库控制范围内**。

**建议修复（仅加固）**：在本仓库控制的那个请求上（`:525` 的验证 GET）改为对裸 `$url` 验证，把 401/200 都当作可达性证明——**token 对连通性检查毫无贡献**，去掉它可把第三方日志暴露降为零。手机端配对 URL 行为保持（协议要求），并继续在已有位置使用 `redactUrl`。

**修改风险**：**低**——验证器已经接受 401 为成功（`:527`），而这正是 `requireAuth` 下无 token GET 应有的返回。
**验证方法**：手测 `start-tunnel.ps1`，确认请求中无 `?token=` 仍报告"隧道连通"。
**本轮实施建议**：排期（低收益但零风险）。

---

### BUG-18 · 其余已确认的低严重度缺陷（合并列出）

| 编号 | 位置 | 证据与影响 | 建议 | 风险 |
|---|---|---|---|---|
| **BUG-18a** | `transport/index.ts:554-558` vs `:622-624` | 握手超时 `reject`（:556）在 :554 的 await 处展开 async IIFE，导致 :622-673 **永不执行**——包括唯一的 `ws.close()`。`this.ws` 在 :672 才赋值，所以 `resetSocket`(:775-788) 与 `close()`(:795-796) 也够不到它。**若 socket 在 t>15s 完成握手，它会在进程存活期内一直开着且无 message/close/error 监听器**——每次超时泄漏一个 socket + 服务端一个幽灵设备。无功能损坏（无监听器），故 Low | 在 reject 路径上关闭 `ws` 并移除握手监听器（抽一个 `abandon()` 助手，供 15s 定时器、`close` handler、`unexpected-response` 共用）。**注意：不要重构 :577-581 那段"`error` 不 reject"的 Android OkHttp 401 变通逻辑** | 低 |
| **BUG-18b** | `rpc/session.ts:195-196` | `const first = await iterator.next(); if (first.done) throw new Error('session/follow closed before snapshot');` —— 此路径从不调用 `handle.close()`（`transport/index.ts:759-764`，它才做 `streams.delete`）。`streamId` 会留在 `DshConnection.streams` 直到 socket 死亡。有界且小，但在重连频繁的路径上是 map 泄漏 | 在 :195-197 外包 `try { … } catch (e) { handle.close(); throw e; }` | 极低 |
| **BUG-18c** | `BackgroundDisplayUserService.kt:112-115` | `wm` 回退路径 `ProcessBuilder(...).start().waitFor()` **不读 stdout/stderr**，而所有兄弟方法（`launchComponent`、`injectKey`、`injectText`）都正确用了 `redirectErrorStream(true)` + `readText()` 再 `waitFor`。若 `wm` 填满 64KB 管道缓冲，Shizuku binder 线程会死锁。**待验证假设**（`wm` 输出通常极小） | 与兄弟方法一致地排空或丢弃输出（`Redirect.DISCARD`） | trivial |
| **BUG-18d** | `RunStore.kt:131-138,252-257` | prune **跳过** `requiresReconciliation` 的文件，60 个文件上限只裁剪健康的终态运行。单个损坏文件的保留策略是正确的（`FileRunStoreTest` 有"an unreadable run file survives pruning"用例），但**反复损坏（存储不稳定）时文件无界累积** | 给损坏文件保留加上限（如保留最新 N 个），或在 UI 浮现对账后删除。**触及有意的数据保留语义，需先定产品策略** | 低 |
| **BUG-18e** | `AgentRuntime.kt:568`（`streamText` StringBuilder），:348 每运行清空 | 单次运行期间流式追加**无上限**。一个病态的 12 步运行 + 超长模型输出会把全文留在内存。现实最坏情况是低 MB 级，仅内存压力 | 给缓冲加上限（为 UI 流视图保留最后 N KB） | 极低 |
| **BUG-18f** | `notify.ts:203` | `const lastAtByBucket = new Map<string, number>();` **从不裁剪**（每 kind+sessionId 一条；增长缓慢） | 加 LRU 或大小上限 | 低 |
| **BUG-18g** | `ApprovalBanner.tsx:186` | `press()` 内的 `setTimeout` **从不在卸载时清除**（卸载后触发，读一个 ref，无害空操作） | 存入 ref 并在卸载时清除 | trivial |
| **BUG-18h** | `main.js:448-472` | 见 BUG-16 | — | — |
| **BUG-18i** | `renderer/app.js:49,240-268,328-330` | 见 CQ-07 | — | — |
| **BUG-18j** | `store.ts:2471-2486` 与 `:2496-2511` | `send()` 失败时**无条件**把 `running` 置 false（:2499 注释「发送失败必须把 running 复位，否则界面会一直显示「思考中」转圈」）。若一个轮次真的在跑（`'queue'` 模式允许排队在其后）而**新**提示失败，派生状态上的 `running` 被强制为 false。`rebuild`（:2376-2377）会在下一个流事件时从 `last?.running` 恢复，所以窗口受模型思考时间限制。**待验证假设** | 只在"本次 send 才是设置 running 的那一次"时复位，或让复位走 `rebuild` 使服务端真相胜出。**注意：`send-retry-spec.mjs:173-186` 明确断言了当前的无条件复位（"失败会复位 running"），任何改动都必须有意地更新该 spec** | 中 |

---

## 四、安全控制中**正确**的部分（明确记录，避免夸大风险）

以下均由子 Agent 实读代码确认，本人抽查复核了其中 4 项（审批链、Cookie 清空顺序、release 签名门禁、debug.keystore）。**这些不是发现，请勿在后续优化中"简化"掉。**

1. **仅 Keychain 的凭据存储，无明文回退** —— `secureStore.ts` 全文；失败被浮现而非静默降级。
2. **fail-closed 的 7 态凭据迁移** —— `credentialMigration.ts`：`shouldBlockAutoLogin` 在全部四种失败态上都阻塞；每次安全删除后都有读回校验。
3. **Cookie jar 卫生** —— `cookieJar.ts`（4 种结果联合：cleared/unavailable/partial/unverified；仅枚举名字）与 `transport/index.ts:236-244`：**token 登录前先清空 jar**，杀死了过期 Cookie 的鉴权绕过。
4. **出口 URL 策略** —— `net-security.ts`：明文 HTTP 只允许私有 IPv4/localhost/::1；`assertSecureUrl` 在我追踪到的每个带凭据请求点都被调用（`transport/index.ts:158`、`fileUrl.ts:55`）；`redactUrl` 从错误中剥离查询参数与 43+ 字符 token；`doctor.ps1:38-41` 对诊断应用同样脱敏。
5. **服务端身份绑定** —— `serverIdentity.ts`：5 种 `BindingResolution`；revoke 时的 404 只在 `confirmed` 时被信任；`mayUseStoredDeviceId` 排除 `foreign`/`unverifiable`；写入经读回校验。
6. **吊销：`unknown` ≠ `not-revoked`** —— `deviceRevocation.ts:30-36,190,403-424`：双通道标记（AsyncStorage + Keystore 回退），`unknown` 从不缓存，读失败从不被当作干净。有回归 spec。
7. **审批权限链（提交 `ebcc9a1` 的声明经核实为真）** —— `agent-core/…/Tools.kt:55-108`：`ActionExecutor` 是唯一执行收口；任何 risk ≠ READ 都过 `approvals.decide`；门禁异常产生 ERROR "approval unavailable"（fail-closed）。`AgentRuntime.kt:396-422`：`decide()` 把 `callId`/`digest` 不匹配判为 `STALE_APPROVAL`，首个决定胜出；`:622-632`：`awaitApproval` **无限等待且默认 `REJECT`**——**代码库中不存在任何超时自动批准**。
8. **arm-then-commit 提交** —— `approvalDock.ts:375-380,520-529`：缺 `sessionId` 时 fail-closed；`unconfirmed` 锁定重提交直到收到权威 `approval-resolved` 或比 `sentAt` 更新的重放；session 未知的审批进入只读桶，**从不并入当前会话**。
9. **幂等发送** —— `store.ts:2490-2493` + `rpc/session.ts:101`：重试复用同一 `requestId`，服务端去重；新发送总是拿新 ID（`pendingSend/fingerprint.ts` 显式禁止复用）；重启恢复把 `sending` 映射为 `unknown` 且**不自动重发**（`store.ts:330`）。
10. **Runtime 安装信任链（本人评估：这是本项目工程质量最高的部分）** —— `RuntimeInstaller.java:407,440,463`（归档 SHA-256、每文件可信清单、摘要校验）、`RuntimeManifest.java`（词法 + 分量级 symlink 遏制，`(rawMode & 0022)==0`）、`LocalDshModule.kt:128-129`：清单**只从已签名 APK 的 assets 读取**——注释写明"信任来自已签名 APK，绝不来自随下载提供的 sidecar"。zip-slip 在结构上不可能：每个 tar 成员必须匹配可信清单（路径/类型/模式/大小/sha256，`RuntimeInstaller.java:413-493`）；仅允许 USTAR，硬链接/设备/PAX 类型被禁（:502-537）；`O_NOFOLLOW|O_EXCL|O_CLOEXEC`；载荷 chmod 0555；文件**与目录**都 fsync；`installer.lock` FileLock。
11. **release 签名门禁（本人复核）** —— `android/app/build.gradle:221-252`：`taskGraph.whenReady` 对任何缺 `DSH_STORE_FILE` 的 release 任务抛错；被跟踪的 `debug.keystore`（公开密码、众所周知的 AOSP 证书，**不是密钥泄漏**）无法签 release；逃逸标志是显式的且 CI 从不传它（`DSH_ALLOW_DEBUG_RELEASE_SIGNING`）。`.github/release-signing.json` 钉住 `knownGoodCertificateSha256` 并把 debug 证书标为 test-only。
12. **更新完整性 fail-closed** —— `update-integrity.ts`：无期望哈希 → `undefined` → 调用方拒绝安装；`updater.ts` 在哈希不匹配时**先删除 APK** 再有任何安装意图；同通道限制被诚实记录，Android 签名才是真正的锚。
13. **网关 mgmt-auth 补丁 + 启动门禁** —— `patch.mjs`（锚点必须恰好出现一次；注入的拒绝 fail-closed 503；幂等）、`gateway-patch-gate.ps1`（结构化结果、"拒绝启动"）、接线于 `start-dsh-web.ps1:114-127`。
14. **隧道控制服务** —— `tunnel-service.mjs:528` **只绑 127.0.0.1**；Origin 白名单在任何动作**之前** 403（:454-458）；允许无 Origin 请求是安全的，**正因为**有回环绑定（浏览器 JS 够不到它，本地进程已经以用户身份运行）；`/tunnel/status` 剥离 token（:312-326）；PowerShell 参数做单引号转义（:370-379）。
15. **Electron 桌面（除 SEC-07 外）** —— `main.js:307-313` `contextIsolation:true`、`nodeIntegration:false`、只 `loadFile` 本地文件；`open:external` 限制为 `^https?://`（:893-894）；IPC 动作白名单（:605,668）；`preload.js` 暴露固定 13 方法、无通用 IPC 桥、"所有参数在主进程侧再校验一次"。
16. **Butler** —— 仅所有者的 TaskApi（非所有者在 handler 前 403，`task-api.js:40-43`）；`workspace-fs.js`：以 dev/ino 校验根身份、`fresh()` 在每次操作**前**重解析（防住祖先 symlink TOCTOU）、根外元数据被伪装为不存在；**无 `child_process`**、无监听器；持久化队列在进程丢失后**明确不被当作授权**（`task-manager.js:89-94`）；单个串行 `activeTaskId`。
17. **PowerShell 纪律（除已列出的缺陷外）** —— `$ErrorActionPreference='Stop'` 存在于 `build-signed-apk.ps1:70`、`start-dsh-web.ps1:83`、`setup-gateway.ps1:33`、`start-tunnel.ps1:44`、`setup-butler.ps1:28`、`setup-autostart.ps1:33`、`start-tunnel-service.ps1:27`（`doctor.ps1:13` 有意为 `Continue`，因为是诊断）。密码只经 `Read-Host -AsSecureString` → `ORG_GRADLE_PROJECT_*` 环境变量，**从不落盘**。含 token 的文件被收紧 ACL（当前用户 + SYSTEM + Administrators，切断继承），失败时大声警告。防火墙暴露是 opt-in（`-AllowFirewall`、`-Profile Private`、指定端口）。autostart 只用用户启动文件夹的 `.lnk`，**不写注册表**，支持 `-Remove`。`setup-butler.ps1`：安装锁、带时间戳备份、回滚、校验已安装包名、拒绝回退到 symlink。
18. **隧道模式权限加固** —— `start-tunnel.ps1:425-443`：`DSH_PERMISSION_MODE` **不再静默从环境继承**；默认 `workspace-write`；`danger-full-access` 触发显式公网暴露警告（尽管 BUG-06 让这个警告目前会崩）。
19. **设备端工具面** —— `PhoneTools.kt`：**无短信工具、无坐标点击、只用枚举键、密码字段被阻止、敏感屏幕强制交接**（`OutpostAccessibilityService.kt:77,196,232`）；工作区路径归一化 + `startsWith(root)`（`Tools.kt`）。accessibility service XML 能力最小化（**无截屏捕获、无 `canControlSystemGestures`**）——不过度授权。
20. **密钥扫描** —— `git ls-files` + 模式 grep（AKIA/ghp_/sk-/PEM/Bearer 等）：**无live 提交密钥**；只有 `tests/credential-display-spec.mjs` 中的假 fixture 与众所周知的公开 `debug.keystore`。
21. **文件下载通道** —— `gatewayFiles.ts:80-83,101-103,86,135`：每块 `maxBytes` 强制并可取消、缓存文件名消毒（`[^\w.\-]`→`_`）、任何失败都显式取消；`filePreview.ts` 只渲染惰性的有界文本摘录；`fileUrl.ts` **拒绝打开 APK**（关闭第二条安装路径）。
22. **CloudModel / Http（Kotlin）** —— 超时齐备（连接 15s、读 120s，`Http.kt:10-11`）；**禁用重定向**因此 `Authorization` 不会跨主机重放（:45）；**完全无重试逻辑** → 不存在重复的非幂等 POST；畸形 SSE → protocol-error Failure，**绝不是空成功**；API key 从失败消息中脱敏（`CloudModel.kt:92-93`）且从不记日志；base URL 限制为 HTTPS 或回环（:968-979）；合成 call id 是 UUID（:890）。
23. **`AgentSettingsStore`（提交 `9cef57e` 经核实完整）** —— Keystore AES/GCM 包裹（:110-147）、端点身份变化时使 key 失效（:57-85）、`clear()` 同时移除 prefs 与 alias、**key 从不跨 bridge**（JS 只拿到 `hasKey`）。

---

## 五、被子 Agent 报告但**未通过本人复核**的结论（已剔除或改写）

审计流程要求交叉验证并排除误报。以下三条被修正：

| 原结论 | 复核结果 | 处理 |
|---|---|---|
| 「25 个 spec 文件从不被 `npm test` 或 CI 执行」 | **不成立**。该结论只与 `test` 链做了差集，未考虑 `test:p3`/`test:p4`/`test:perf`/`test:filesave`/`test:localRuntime`/`test:e2e` 等**存在但不在链中**的脚本，也把这些脚本覆盖的 spec 误计为孤儿。本人以传递展开重算：**142 个 spec 中 20 个从不运行**，6 个脚本 CI 永不触达 | 改写为 TEST-02，附完整列表与方法 |
| butler `execute()` 中「`task.goalId` 只在 `await persist` 之后才持久化，cancel 落在窗口内会跳过 pause；更糟的是 `persist` 在任务已终态时丢弃整个补丁，所以晚到的 `goalId` 永不被记录」 | **方向对、机制不准**。本人重推：`goalId` 补丁**确实**被终态守卫丢弃（:827-829），但被跳过 pause 的原因不是"goalId 未持久化"，而是 **`cancel()` 的判定在它的第一个 await 之前全部同步完成**，此刻 goal 尚未创建；且 :712 的同步守卫在多数交错下会安全返回。窗口比原描述窄得多，但**确实存在**。另发现 `finishLane`(:812) 提供部分缓解（不释放 lane），原报告未提 | 改写为 BUG-09，降级为 Medium / 高可信风险，附精确交错与旁证（`2325d34` 修了兄弟变体） |
| 「`integration-gateway-reconnect.mjs` 覆盖了断线重连后的历史记录重复」 | **不成立**。该文件驱动的是真实 `ApprovalGateway`（通道 B，另一条 WS）对 `fake-dsh.mjs`，守的是配对码复用与 401 自愈，**与会话历史无关**。历史去重的覆盖来自且仅来自 `ws-reconnect-session-recovery-spec.mjs:159-249`（该 spec 本人确认为真实覆盖：真 `DshConnection` + 真 `Store` + 真 `PendingSendStore`，只桩 RPC 边界） | 在 `07` 报告中更正映射 |

另有一处**测试自身缺陷**值得单独记录（已确认，本人复核）：

**`tests/integration-gateway-reconnect.mjs:183,199-203` 的核心断言恒真**
```js
183:    const pairsBefore = srv.pairCalls;
199:    // 关键：重连用的是 token，不该再申请新配对码
201:    return pairsAfter >= pairsBefore ? true : `pairCalls 异常：…`;
```
`srv.pairCalls` 是**单调递增计数器**，因此 `pairsAfter >= pairsBefore` **恒为真**。注释声明的不变量**没有被断言**。该回归仍被 `:196-198` 的 `onlineCount < 2` 间接捕获（复用一次性码会无法重新上线），所以文件并非无用——但**以该缺陷命名的那条检查没有测它**。后果：一次"重连成功但每次都烧掉一个新配对码"的回归（正是 `docs/known-issues.md` §1 描述的缺陷）会通过。
**建议修复**：改为断言 `pairsAfter === pairsBefore`。**风险极低，但可能立即暴露一个真实的当前失败——合入前需先检查。**
