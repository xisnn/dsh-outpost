# 04 · 性能审计

审计基线：`E:\work\dsBot-opt` 工作区 HEAD `2325d34`（分支 `opt/p1-phone-polish`，工作树干净）。
本轮**只审计、未修改任何业务代码**，未执行任何构建、未连接任何设备。

---

## 〇、结论先行

**这份代码的性能工程水平明显高于同类 RN 客户端的平均水平**，而且有一部分是**被真实测试测量过的**，不是纸面声称。

数据管线（wire 事件 → fold 投影 → Store 节流/合批 → 订阅 → React 渲染）的前半段设计得非常克制：

| 环节 | 实现 | 证据 |
|---|---|---|
| rebuild 合批 | `REBUILD_BATCH_MS = 60` | `dsh-mobile/src/core/store.ts:127` |
| emit 节流 | `EMIT_THROTTLE_MS = 60` | `store.ts:128` |
| 关键事件绕过合批 | user/message、turn/start、turn/end、approval/*、deliverables/* | `store.ts:139-148` |
| 增量 fold | `foldEventsIncremental` 尾部快路径 + 缓存失效 | `core/fold/index.ts:919-1026` |
| 投影引用稳定化 | Turn / ChatItem / WorkGroup 内容不变则 `===` 复用 | 被 `tests/streaming-perf-f03-spec.mjs:353-358` **实测断言** |
| 列表虚拟化 | `FlatList` + `windowSize=9` + `initialNumToRender=14` | `screens/ChatScreen.tsx:919-942` |
| 行级 memo | `React.memo` + 自定义浅比较器 | `ChatScreen.tsx:102-201`，被 `streaming-perf-f03-spec.mjs:625-632` 静态断言 |
| 重连退避带抖动 | `jitterFactor = 0.85 + Math.random() * 0.3` | `store.ts:2195-2196` |

**真正的性能缺口不在吞吐量上，而在三处：**

1. **`emit` 之后的渲染放大**（PERF-01 / PERF-04 / PERF-06）——全局订阅没有 selector，一次 emit 会拖动整棵 ChatScreen 子树重渲染；markdown 行内解析在 render 中未 memo；每帧新分配的数组/闭包让下游 memo 失效。**这一层没有任何现有测试能观察到**（组件从不真正渲染，见 `05_TEST_COVERAGE_GAPS.md`）。
2. **后台仍在跑的定时器**（PERF-03）——5 秒一次的通知扫描没有 AppState 门控，App 退到后台后仍然每 5 秒发一次 RPC。
3. **原生主线程的周期性磁盘读**（PERF-05）——两个 tick（700ms / 500ms）都在主线程上触发一次带锁的 run JSON 文件读。

**必须明确区分：**

- 下面每一条都标注了 **【已测量】**（指名具体测试文件与断言行）或 **【静态怀疑】**（仅由代码结构推断，未在设备上测量）。
- **本轮没有执行任何性能测量**。所有"毫秒数""帧率"都是推理，不是数据。
- 唯一的实测数据来自仓库自带的 `tests/streaming-perf-f03-spec.mjs`，它是 **Node 环境下的纯逻辑计时**（40 轮 / 120 事件规模），**不代表真机表现**，也**看不到规模增长曲线**。
- 文末给出 6 项**待执行**的真机测量计划（含工具与阈值）。**在测量之前，不得据本文任何一条"静态怀疑"立项做重构。**

---

## 一、PERF-01 · 全局订阅导致整屏重渲染

| 项 | 内容 |
|---|---|
| 严重程度 | **Medium** |
| 证据强度 | 渲染**次数**=【已测量】；单次渲染**代价**=【静态怀疑】 |
| 位置 | `dsh-mobile/src/screens/ChatScreen.tsx:271`；`dsh-mobile/src/App.tsx:1503`；`dsh-mobile/src/components/SharedInboxHost.tsx:50` |

### 具体证据

三个宿主都用同一种"无 selector 的全局订阅 + 强制自增"模式：

```ts
// ChatScreen.tsx:271
const [, force] = useState(0);
useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
```

`store.subscribe` 的回调在**每一次 `emit`** 时都被调用，不做任何"我这个视图关心的数据变了吗"的判断。因此一次 emit = 一次完整的 `ChatScreen` 函数体执行 = 整棵子树走一遍 reconcile。

放大因素：`App.tsx:757-766` 与 `App.tsx:781-790` 在**每次 emit** 时对全局状态做 `JSON.stringify`：

```ts
// App.tsx:757-766（节选）
store.subscribe(() => {
  const next = JSON.stringify(store.ownedList());
  if (next !== lastOwned) { /* ... */ }
});
```

也就是说：即便某次 emit 只改了一个会话里的一条流式文本，`App` 层也会把**整个会话列表**序列化一遍来做比对。会话越多，这个 stringify 越贵，而它跑在 JS 线程上、每个流式批次都跑一次。

### 已测量的部分

`tests/streaming-perf-f03-spec.mjs:353` 断言：120 个 wire 事件驱动的流式过程中，`optRebuilds <= 15`。

配合 `store.ts:127-128` 的 60ms 节流常量，可以**推算**（不是测量）emit 频率上限约 **16 次/秒**。由于没有 selector，这 16 次 emit 就对应最多 **16 次完整 ChatScreen 渲染 + 16 次 App 层 `JSON.stringify` 会话列表**，每秒。

### 未测量的部分

**单次渲染的真实耗时未知。** 原因：`component-harness.mjs` 从不真正渲染组件（组件被替换成字符串，`useEffect` 是空函数），所以**没有任何测试观察过 React 的 reconcile 成本**。上面这个"16 次/秒"是次数，不是毫秒。

### 影响范围

- 中低端 Android 机 + 长会话（几百条消息、含大量 markdown 与工具卡片）时，流式输出期间的掉帧。
- 会话列表越大，`App.tsx` 的 stringify 开销越与"当前正在流式输出的那条消息"无关地增长。
- 不影响正确性。

### 建议修复方式

1. 给 `Store` 增加**快照选择器订阅**：`subscribeToSelector(selector, isEqual, cb)`，emit 时先算 selector，只有结果变化才通知。`ChatScreen` 订阅 `getChat(sessionId)` 的**身份**（fold 已经做了引用稳定化，所以身份比较是有效的、廉价的）。
2. `App.tsx` 的两个 stringify 监听器前置一个廉价的身份/长度检查（例如先比 `store.ownedList().length` 与一个单调递增的 revision 计数），只有可能变化时才 stringify。
3. `SharedInboxHost.tsx:50` 同理，只订阅共享收件箱相关的键。

**注意**：fold 层的引用稳定化（`streaming-perf-f03-spec.mjs:353-358` 已实测）正是让这个 selector 方案可行的前提——内容不变则 `===`，所以身份比较不会漏更新。这是一个"已经打好基础、只差最后一步"的优化。

### 修改风险

**中。** selector 写错会导致**漏更新**（界面卡在旧内容），这是比慢更难查的 bug 类型。必须逐个订阅点迁移，不能一次性全改。

### 验证方法

1. 先在 Node 侧加一个断言：注入 120 事件，统计 `ChatScreen` 的订阅回调被触发次数 ≤ rebuild 次数（现在应该相等，改后应显著下降）。
2. 真机 React DevTools Profiler（或 `<Profiler>` 包裹）在 120 事件流式期间录制：
   - ChatScreen commit 次数应等于 rebuild 次数（≤15），而不是等于 emit 次数。
   - `GlobalNotices` / `SharedInboxHost` 在无相关变化时 commit 数应为 **0**。
3. RN Perf Monitor 观察 JS 帧时间 p95。

### 是否建议本轮实施

**不建议本轮实施。** 需要先有真机 Profiler 基线数据（见文末测量计划第 1、2 项）。当前只能说"结构上存在放大"，不能说"用户能感知"。

---

## 二、PERF-02 · 增量 fold 快路径实际仍是 O(N)

| 项 | 内容 |
|---|---|
| 严重程度 | **Low-Medium** |
| 证据强度 | 40 轮规模下【已测量】达标；规模增长后【静态怀疑】 |
| 位置 | `dsh-mobile/src/core/fold/index.ts:919`（文档声明）、`:947-957`（扫描循环）、`:1025-1026`（两次全量拷贝）；`store.ts:2390` + `store.ts:2872-2881`（`reconcilePendingNow` 重扫） |

### 具体证据

`fold/index.ts:919` 的注释声明了设计意图：

> 只对最后一轮的尾部事件切片调用 foldEvents，使单次 rebuild 复杂度从 O(N_total) 降至 O(N_tail)

但缓存失效检查的实现是：

```ts
// fold/index.ts:947-957（节选）
const minCommon = Math.min(len, cache.lastRecords.length);
for (let i = 0; i < minCommon; i += 1) {
  // 逐项比较 seq / event 身份
}
```

对于**追加型（append-only）流**——这正是流式输出的常态——前 `minCommon` 项**永远全部相等**，循环不会提前 break，于是每次 rebuild 都要走完整个 N。

紧接着：

```ts
// fold/index.ts:1025-1026
cache.lastRecords = sortedRecords.slice();
cache.lastEvents = sortedRecords.map((r) => r?.event);
```

**每次 rebuild 做两份完整的 N 元素拷贝。**

叠加项：`store.ts:2390` 在每次 rebuild 后触发 `void this.reconcilePendingNow(sessionId)`，而 `reconcilePendingNow`（`store.ts:2872-2881`）会重扫该会话的**全部** `entry.records`，随后调用 `pendingSends.list()`——这会取同一把 `runExclusive` 互斥锁（`pendingSend/store.ts:251-259`）并**深拷贝每一条待发送记录**（`pendingSend/store.ts:552-558`）。而这把锁正是 `runPendingSend` 写 `begin-send`（`store.ts:2794`）时需要的。

按 `REBUILD_BATCH_MS = 60` 计算，流式期间约 **16 个这样的周期/秒**。

### 已测量的部分

`tests/streaming-perf-f03-spec.mjs:353-355` 断言 40 轮 / 120 事件下 rebuild 次数 ≤15，`:232` 与 `:269` 断言增量路径相对全量路径有 **≥5 倍**加速。

**这个测量在 40 轮规模下是通过的、真实的。** 问题在于：40 轮的 N 太小，O(N) 的常数项完全被淹没，**这个测试在设计上无法观察到 N 增长后的退化**。

### 影响范围

超长会话（数千事件）+ 流式输出时的 JS 线程占用。**不是正确性问题**，fold 的输出是对的。

### 建议修复方式

分两块，风险差别很大：

**(a) `reconcilePendingNow` 记忆化 —— 低风险，建议做**
给每个 stream entry 维护一个"已见过的 `user/message` rpcId 集合"，`reconcilePendingNow` 只处理新增记录，不再全量重扫 + 全量 `list()`。这不触碰 fold 缓存语义。

**(b) fold 快路径的扫描与拷贝 —— 高风险，本轮不要动**
- 记录上次比较到的长度，追加型 rebuild 只从该长度开始比较（并保留一项身份抽查以防"同长度但内容被替换"）。
- `lastRecords` / `lastEvents` 改为共享的不可变快照，避免每次两份全量拷贝。

**为什么 (b) 高风险**：提交 `c8e9924` 存在的唯一理由就是——**同 seq 的内容更新**和**中途历史回填**必须让快路径失效，否则界面会静默显示过期内容。任何"跳过比较"的优化都在直接削弱这道防线。

### 修改风险

(a) 低。 (b) **高**——见上。

### 验证方法

**必须先扩测试，再改代码：**

1. 把 `streaming-perf-f03-spec.mjs` 的边界测试 2A / 2B（`:655-724`）从当前的小 fixture 扩到 **≥5000 事件**，断言：
   - 追加一条事件后，增量结果与全量 `foldEvents` 结果**逐字段相等**（这是 (b) 的安全网）。
   - 同 seq 更新一条历史事件后，快路径**必须**失效并产出正确结果。
2. 在同一 fixture 上记录单次 rebuild 墙钟时间，断言**斜率次线性**（或至少不随 N 线性增长）。
3. (a) 的验证：注入 120 事件，断言 `pendingSends.list()` 的调用次数从 O(rebuilds) 降到 O(有新 user/message 的次数)。

### 是否建议本轮实施

**(a) 建议排期，(b) 不建议本轮实施。** (b) 必须等第 1 步的 5000 事件等价性测试落地之后才谈。

---

## 三、PERF-03 · 后台仍在跑的 5 秒通知扫描（无 AppState 门控）

| 项 | 内容 |
|---|---|
| 严重程度 | **Medium** |
| 证据强度 | 行为【已确认】（代码直读）；耗电/流量代价【静态怀疑】 |
| 位置 | `dsh-mobile/src/core/store.ts:987-994`（`startNoticeScan`）、`:1015-1119`（`scanOnce`）、`:2960-2971`（`close`）；`App.tsx:1504-1508`（唯一启停点） |

### 具体证据

```ts
// store.ts:987-994（节选）
startNoticeScan(): void {
  if (this.scanTimer) return;
  this.scanTimer = setInterval(() => { void this.scanOnce(); }, 5000);
}
```

`scanOnce`（`:1015-1119`）每次都会调用 `listSessionProjections()` 之类的一次 RPC 级查询。`:1030-1033` 的注释明确写了**每次扫描都必须真的跑**：

> 踩过的坑：任务跑得比扫描间隔还快时……

这个注释是对的、不能删——问题不在"要不要跳过某次扫描"，而在"App 在后台时要不要扫描"。

启停只由 App 挂载/卸载控制（`App.tsx:1504-1508`），**没有任何 AppState 判断**。

**对照证据**——同一个代码库里，其它轮询器**都做了**门控：

| 位置 | 是否有 AppState 门控 |
|---|---|
| `components/useChatMetaPolling.ts:33-40` | ✅ 有 |
| `components/HostQueuePanel.tsx:56-61` | ✅ 有 |
| `store.ts:987-994`（本条） | ❌ **没有** |

这说明这是一处**遗漏**，不是设计选择。

### 影响范围

- App 退到后台后（在 Android 冻结进程之前），仍然每 5 秒发一次 RPC，持续耗电、耗流量、耗服务端资源。
- 回前台时 `handleAppForeground`（`store.ts:2935-2958`）自己还会做一次 `loadSessions`，与后台期间的扫描**语义重叠**——后台扫描拿到的结果在回前台那一刻就被覆盖了，等于白做。

### 建议修复方式

在 `Store` 里维护一个 `isActive` 标志（由已有的 AppState 监听器驱动，`App.tsx:1541-1556` 已经有监听），`scanOnce` 在非活跃时直接 return；**回前台时立即补跑一次**（catch-up scan），保证不漏通知。

这与 `:1030-1033` 的注释不冲突：注释要求的是"活跃期间每次都要跑"，不是"后台也要跑"。

### 修改风险

**低。** 最坏情况是通知延迟 ≤5 秒，且 catch-up scan 覆盖了回前台这个最重要的时刻。

### 验证方法

1. 服务端访问日志或 mitmproxy：App 退后台 5 分钟，期间有一个团队任务在跑。
   - 修复前基线：约 **60** 次扫描 RPC。
   - 修复后期望：**0** 次（回前台时 1 次 catch-up）。
2. Node 侧单测：mock AppState 为 `background`，推进虚拟时钟 30 秒，断言 RPC 调用数为 0；切回 `active`，断言恰好补跑 1 次。

### 是否建议本轮实施

**建议排期（高收益/低风险/可独立验证）。** 但因本轮只审计，不实施。

---

## 四、PERF-04 · 流式尾部的 markdown 行内重复解析

| 项 | 内容 |
|---|---|
| 严重程度 | **Medium** |
| 证据强度 | 【静态怀疑】 |
| 位置 | `dsh-mobile/src/components/MarkdownView.tsx:50`（块级已 memo）、`:102/:109/:135/:145`（行内未 memo）；`dsh-mobile/src/core/markdown.ts:205`（逐字符字符串拼接） |

### 具体证据

块级解析**已经**做了 memo：

```ts
// MarkdownView.tsx:50
const blocks = useMemo(() => parseMarkdown(text), [text]);
```

但行内解析在 **render 阶段直接调用**，没有 memo：

```ts
// MarkdownView.tsx:102 / 109 / 135 / 145（形态一致）
inlineText(parseInline(block.text), styles)
```

`parseInline` 因此会在**每一次渲染**时对**每一个块**重跑，包括那些文本完全没变的历史块。

叠加项：`markdown.ts:205` 用逐字符累加构造纯文本：

```ts
// markdown.ts:205（形态）
text += src[i];
```

对长行内片段这是**二次复杂度**。

流式输出时，尾部块的 `text` 每个批次都在变 → `parseMarkdown` 的 `useMemo` 依赖变化 → 整个块列表重算 → 所有块的 `parseInline` 在 render 中重跑。按约 16 Hz 的批次频率，累积代价约 **O(len²)**。

### 影响范围

长回复（尤其是长代码块、长表格）流式输出期间的 JS 线程占用。**不影响正确性。**

### 建议修复方式

1. 把行内解析结果按 `block.text` 做 memo（一个小的 `Map<string, InlineSegment[]>`，带 LRU 上限），或者在 `parseMarkdown` 里一次性把行内解析结果预计算进块对象。
2. `markdown.ts:205` 改用 `parts.push(...)` + `parts.join('')`。

### 修改风险

**低。** (2) 是纯等价改写。(1) 需要注意 memo key 的内存上限。

### 验证方法

1. Node 微基准：对一段 50KB 单段落文本反复调用 `parseInline`，改前/改后对比墙钟时间。
2. 真机 Hermes sampling profiler：长流式输出期间采样，确认 `parseInline` 不再占据 JS 线程热点。

### 是否建议本轮实施

**建议排期。** (2) 可以立刻做（零风险）；(1) 建议先做微基准确认收益量级。

---

## 五、PERF-05 · 原生主线程的周期性磁盘读

| 项 | 内容 |
|---|---|
| 严重程度 | **Medium** |
| 证据强度 | 机制【已确认】（代码直读）；实际耗时【未测量】 |
| 位置 | `dsh-mobile/android/app/src/main/java/com/dshpocket/agent/AgentService.kt:42-63`（`notificationTick`，700ms）；`.../agent/AgentOverlayController.kt:49-53`（tick，500ms）；`.../agent/AgentRuntime.kt:543-550`（`snapshot()` → `snapshotLocked()`）；`.../agent/FileRunStore.kt`（`@Synchronized snapshot`） |

### 具体证据

两条独立的周期链路都汇聚到同一个带锁的文件读：

```
AgentService.notificationTick   (每 700ms，handler.postDelayed(this, 700) @ AgentService.kt:63)
AgentOverlayController.tick     (每 500ms)
        ↓ 都在主线程
AgentRuntime.snapshot() → snapshotLocked()   (ReentrantLock @ AgentRuntime.kt:543-550)
        ↓
FileRunStore.snapshot()   (@Synchronized，从磁盘重读 run JSON)
```

被读的 run JSON 会随对话增长（工具结果每条裁剪到 16KB、最多保留最近 12 步）。而**同一把锁**上，worker 线程正在做带 fsync 的写入。

合计约 **3 次/秒**的主线程文件读，在服务存活的整个生命周期内持续。

### 影响范围

- 存储慢 + IO 竞争时可能出现掉帧，极端情况有 ANR 风险。
- **不是正确性 bug。** 快照数据是对的，锁也是对的（`FileRunStore` 的原子写设计见 `07_REGRESSION_PROTECTION.md`，属于"不要动"清单）。

### 建议修复方式

三条可选，按侵入性递增：

1. **降低空转频率**：run 处于终态（completed/failed/cancelled）时把 tick 间隔拉长或停掉。改动最小。
2. **内存缓存**：`AgentRuntime` 持有最近一次快照，由 run 变更事件失效，两个 tick 读缓存而不是读磁盘。
3. **移出主线程**：把快照读放到后台 executor，只把结果 post 回主线程用于更新通知/浮层。

**推荐 1 + 2 组合。** 方案 3 改动面最大，且通知更新本来就必须回主线程，收益/成本比不如前两者。

**注意**：`FileRunStore` 的原子写 + fsync + `ATOMIC_MOVE`（提交 `2a27192`）是"不要动"清单里的内容，本条修复**不得**触碰 `FileRunStore` 的写入路径，只在读取侧加缓存。

### 修改风险

**低-中。** 通知文案最多陈旧一个 tick 周期（≤700ms），用户可接受。缓存失效逻辑写错会导致通知显示过期状态——需要覆盖测试。

### 验证方法

1. Debug 构建开启 StrictMode `detectDiskReads()`，跑一个 agent 任务，统计主线程磁盘读次数：修复前约 3 次/秒，修复后接近 0。
2. systrace / Perfetto 抓取一次 run 的主线程 IO 段。

### 是否建议本轮实施

**建议排期（方案 1 优先，零风险）。**

---

## 六、PERF-06 · ChatScreen 内联分配击穿下游 memo

| 项 | 内容 |
|---|---|
| 严重程度 | **Low-Medium** |
| 证据强度 | 机制【已确认】；实际代价【静态怀疑】 |
| 位置 | `dsh-mobile/src/screens/ChatScreen.tsx:741-761`（尤其 `:747`、`:754`、`:759`）、`:146`、`:166`、`:182`、`:732-739`；`components/ApprovalBanner.tsx:97-112`、`:186`；`components/SharedInboxHost.tsx:64` |

### 具体证据

**(a) 每次渲染都新建数组**

```tsx
// ChatScreen.tsx:747
approvals={(store.pendingApprovals ?? []).map((a) => ({ ...a, id: a.rpcId }))}
```

`.map` 在 render 中执行 → **每次渲染产生新身份**。而下游：

```ts
// ApprovalBanner.tsx:97-112
const serverPendingIds = useMemo(/* ... */, [approvals]);
```

`useMemo` 的依赖是新身份 → 每次都重算 → 紧随其后的 reconcile `useEffect` **每次渲染都跑**。`:754` 与 `:759` 的内联闭包同理。

**(b) 每行的额外工作**

| 位置 | 代价 |
|---|---|
| `ChatScreen.tsx:146` | `displayScope={JSON.stringify([sessionId, item.key])}` —— 每行每次渲染一次 stringify |
| `ChatScreen.tsx:166` / `:182` | `buildAssistantCopyText(...)` —— 在 render 中构造完整复制文本，即使用户从不长按复制 |

**(c) 每批次重算的全列表扫描**

```tsx
// ChatScreen.tsx:732-739
const firstAssistantKey = useMemo(() => {
  // 遍历 chat.items 找第一条 assistant
}, [chat.items]);
```

`chat.items` 在每次 rebuild 后是新数组身份 → 这个 memo **每个流式批次都重算一遍全列表**。

**(d) SharedInboxHost**

```tsx
// SharedInboxHost.tsx:64
store.sessions.filter(/* ... */)
```

每次渲染一次 filter（叠加 PERF-01 的全局订阅 → 每次 emit 一次）。

### 影响范围

与 PERF-01 相乘：PERF-01 决定了"渲染多少次"，PERF-06 决定了"每次渲染做多少无用功"。

### 建议修复方式

1. `:747` 的 approvals 映射用 `useMemo`，依赖 `store.pendingApprovals` 的身份。
2. `:754`/`:759` 的闭包用 `useCallback`。
3. `:166`/`:182` 的 copyText 改为**按需计算**（长按时才构造）。
4. `:146` 的 displayScope 改为传原始值，在需要时再 stringify（或直接传 `[sessionId, item.key]` 的稳定引用）。
5. `:732-739` 的 `firstAssistantKey` 改为从 `chat.turns`（引用已稳定化）派生，而不是从每次新建的 `chat.items`。

### 修改风险

**低。** 全部是等价改写，不改行为。第 3 项需要注意长按复制的时序。

### 验证方法

1. Dev 模式下加一个 effect 运行计数器，或用 `<Profiler>`：在**没有审批事件**的流式过程中，`ApprovalBanner` 的 commit 数应为 **0**（当前 = 每次渲染）。
2. Profiler 火焰图中 `buildAssistantCopyText` 应从渲染热点中消失。

### 是否建议本轮实施

**建议排期（1、2、5 项低风险高收益）。**

---

## 七、PERF-07 · 轻微的资源/上下文抖动簇

| 项 | 内容 |
|---|---|
| 严重程度 | **Low** |
| 证据强度 | 【已确认】（代码直读），代价可忽略 |

| 位置 | 问题 | 影响 |
|---|---|---|
| `core/notify.ts:203` | `const lastAtByBucket = new Map<string, number>()` 从不清理 | 每个 `kind + sessionId` 一条，**缓慢**增长。会话数有限，实际不会成为问题 |
| `components/ApprovalBanner.tsx:186` | `press()` 里的 `setTimeout` 未在卸载时清除 | 卸载后仍会触发一次，读 `latestStateRef` → 良性空操作 |
| `nav/NavHost.tsx:515-516` | 每个 stack entry 每次渲染都新建 `{...value, column}` context | context 身份变化 → 所有消费者重渲染 |
| `nav/NavHost.tsx:239-250` + `:491` | 键盘 `ime` 状态变化会重渲染 NavHost，而**所有 stack entry 保持挂载** | **每次键盘弹出/收起，所有已挂载屏幕都重渲染一遍** |

最后一条（NavHost 键盘）是这一簇里唯一有实际感知可能的：在聊天界面点开输入框时，背后所有栈内屏幕都会走一次 reconcile。

### 建议修复方式

NavHost 的 context value 用 `useMemo`；键盘状态改为**只影响当前可见 entry**（或把 `ime` 状态下沉到需要它的屏幕，不放在 NavHost 的 render 依赖里）。其余三条可以不动。

### 修改风险

低。NavHost 是导航核心，改动需谨慎但范围可控。

### 验证方法

Profiler：在栈里有 3 个屏幕时弹出键盘，观察 commit 数。修复前 = 3，修复后 = 1（只有可见屏幕）。

### 是否建议本轮实施

**不建议。** 收益不明确，等真机数据。

---

## 八、已核查为干净的区域（不需要动）

以下是本轮**专门去找问题但没有找到**的地方，列出来是为了防止后续重复审计或误改：

### 缓存与内存边界

| 项 | 证据 |
|---|---|
| 附件缓存**有界** | `core/attachment-cache.ts:8-13`：32 条 / 24MB / 128 次失败，LRU 淘汰；`:108` 只存 data-URI；`:124-127` inflight map 用完即清 |
| 无 `createObjectURL` | 全仓 `src` 内 grep 命中 **0** 次（RN 里这是常见的 blob 泄漏源） |
| 审批时间戳 map 有界 | `store.ts:1304-1306` `authoritativeApprovalAt` 上限 200；`:1322-1324` `resolvedApprovalIds` 上限 100 |
| 别名 map 有界 | `ApprovalBanner.tsx:131` 上限 200 |
| Banner 有界 | `store.ts:1176-1215` 上限 3 条 |
| 回填有界 | `store.ts:2088-2127` 安全上限 <10 次、单次 maxMessages 200 |
| WorkGroup 用 WeakMap | `core/workGroup.ts:55` |

### 重连与前台恢复

| 项 | 证据 |
|---|---|
| 退避**带抖动** | `store.ts:2195-2196`，`jitterFactor = 0.85 + Math.random() * 0.3`。**"退避无抖动"不是本项目的 finding** |
| `handleAppForeground` 有界 | `store.ts:2935-2958`：connectApprovals + resetSocket + 每条打开的流重连（retryAttempt 归零）+ 一次 `loadSessions`。**没有刷新风暴、没有监听器累积** |

### 监听器/定时器泄漏排查（全部有配对清理）

| 类别 | 已核查位置 |
|---|---|
| AppState | `ChatScreen.tsx:377-382`、`App.tsx:1541-1556`、`CredentialText.tsx:25-31`、`HostQueuePanel.tsx:56-61`、`LocalExportPanel.tsx:40-44`、`PairScreen.tsx:54-57`、`AgentSettingsScreen.tsx:99-103`、`ButlerTasksScreen.tsx:216-224`、`useLocalRuntime.ts:55-57`、`SharedInboxHost.tsx:53-60`、`useChatMetaPolling.ts:41-43` |
| Keyboard / Dimensions | `useChatScroll.ts:109`、`NavHost.tsx:249` |
| BackHandler | `NavHost.tsx:352`、`TaskDetailSheet.tsx:66-71` |
| 原生 emitter | `localDsh.ts:88-89` + `useLocalRuntime.ts:200-208`；`shareIntake.ts:39-40` + `SharedInboxHost.tsx:52-60` |
| interval | `LocalButlerScreen.tsx:219-221`、`AgentButlerScreen.tsx:153-161`、`store.ts:991`（**唯一无门控的是本条，见 PERF-03**） |
| AbortController 超时 | 全部在 `finally` 里 `clearTimeout`：`approvalGateway.ts:852-854`、`deviceAuth.ts:181-183`、`serverIdentity.ts:231-233` |
| 动画 | `ToolCard.tsx:75`、`Thinking.tsx:52`、`JumpToBottomFab.tsx:59` |
| 搜索控制器 | `useContentSearch.ts:23` 有 dispose |

### 纯函数 / 无副作用模块

`core/scrollFollow.ts`、`core/sessionSearch.ts`、`core/contentSearch.ts`（纯函数 + generation 守卫）、`design/motion.tsx`、`design/useReduceMotion`。

### 已实测的投影稳定性

`tests/streaming-perf-f03-spec.mjs:353-358` 断言：内容未变的 Turn / ChatItem / WorkGroup 在增量 rebuild 后**引用 100% 复用**（`===`）。这是 PERF-01 的 selector 方案可行的基础，**已经建好了**。

### 唯一的"固有增长"（非缺陷）

`store.ts:2306-2320`：`sortedRecords` 会为每条**打开的**会话保留全部事件。这是 fold 增量投影的必要输入，且在 `close()` 时释放。**属于设计代价，不是泄漏。**

### 渲染路径无同步存储 IO

`pendingSends` 的加载是 effect 驱动的，带 generation 守卫（`ChatScreen.tsx:385-429`）。**render 阶段没有 AsyncStorage 同步读。**

### 虚拟化配置已核查

`ChatScreen.tsx:919-942` 是**真实的虚拟化 FlatList**（不是 ScrollView 铺全量）：`initialNumToRender=14`、`maxToRenderPerBatch=12`、`windowSize=9`、`removeClippedSubviews={false}`、`anchorReady` 时启用 `maintainVisibleContentPosition`（`:935`）、`scrollEventThrottle={100}`。

**未使用 inverted**（合理——需要维持历史滚动位置与锚点语义）。
**未提供 `getItemLayout`**（合理——markdown 动态高度无法预知；代价是每行都要实测，这是 PERF-06 里行内工作的放大器，但不是配置错误）。

---

## 九、待执行的真机测量计划（本轮未执行）

> **重要声明：以下 6 项本轮均未执行。** 列出是为了给出可验证的立项依据，
> **在拿到数据之前，本文所有"静态怀疑"级别的条目都不应被当作已确认的性能问题处理。**

| # | 目标 | 环境 | 方法 / 工具 | 通过阈值 |
|---|---|---|---|---|
| 1 | 流式渲染节奏与 JS 帧时间（PERF-01） | 中端 Android（如 Pixel 6a）、**release + Hermes**、40 轮会话 | 用 f03 的 fixture 通过 fake gateway 回放 120 事件；RN Perf Monitor + systrace / Hermes sampling profiler | emit 突发期间 **JS 帧 p95 < 16ms**；ChatScreen commit ≤ 17 次/秒 |
| 2 | 行级重渲染收敛度（PERF-01 / PERF-06） | 同上 | React DevTools Profiler 或内置 `<Profiler>` | 每批次**只有尾部轮次的行**发生 commit；历史行 commit = **0** |
| 3 | 后台轮询耗电（PERF-03） | 同上，App 退后台 5 分钟，期间有团队任务在跑 | 服务端访问日志或 mitmproxy | 修复后扫描 RPC = **0**（基线约 60） |
| 4 | 会话切换内存（泄漏复核） | 同上 | Android Studio Memory Profiler，打开/关闭 20 个长会话 + 手动 GC | JS 堆回到基线 **±10%** 以内 |
| 5 | 长会话 fold 规模曲线（PERF-02） | 先 Node，后真机 debug 计时 | 把 f03 harness 扩到 200 / 500 轮 | 单次 rebuild 墙钟**斜率次线性**；真机 500 轮时单次 rebuild **< 8ms** |
| 6 | 工具卡片终态回归（关联 BUG-03） | 真机 + 可控 gateway | 确定性 fold 测试 + 真机复现：工具调用中途杀掉 gateway → 回前台 → 等 `refreshChatMeta` | 一旦权威 `running === false`，**不允许**存在 `pending: true` 的 ToolBlock |

第 6 项虽然属于正确性（见 `03_BUG_AND_SECURITY_RISKS.md` 的 BUG-03），但它的用户可见症状是"永不停止的转圈动画"，会持续触发重渲染，因此也列入性能测量。

---

## 十、总评

| 维度 | 评价 |
|---|---|
| 数据管线（wire → fold → store） | **优秀，且部分已实测**。节流、合批、增量投影、引用稳定化四层都做了，还有专门的性能规格测试守着 |
| 渲染层（emit → React） | **最薄弱的一环**。没有 selector、render 内有未 memo 的解析与新建分配。**且这一层完全没有测试可观测** |
| 后台行为 | 一处遗漏（PERF-03），同库其它轮询器都做对了 |
| 原生性能 | 主线程周期磁盘读（PERF-05）；写入路径的原子性/锁设计是正确的，不要动 |
| 内存管理 | **干净**。所有缓存有界，所有监听器有配对清理，无 `createObjectURL`，无 render 期同步 IO |
| 测量基础设施 | **不足以支撑性能决策**。f03 是唯一实测点，规模小（40 轮）、且在 Node 而非真机 |

**一句话结论：** 这个项目的性能问题不是"写得慢"，而是"**看不见**"——数据层已经优化到位并且被测过，渲染层没有任何观测手段，所以真实代价目前**无人知晓**。因此本轮的正确动作是**先建测量（第九节 6 项），再谈优化**，而不是按静态怀疑去改渲染层。

---

*本文档由只读审计产生，未修改任何业务代码。所有【已测量】标注均指名具体测试文件与断言行号；所有【静态怀疑】标注均未在设备上验证。*
