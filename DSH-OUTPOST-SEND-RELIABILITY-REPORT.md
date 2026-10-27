# 消息发送可靠性检查报告（发布前）

| 项 | 值 |
|---|---|
| 检查日期 | 2026-10-28 |
| 检查范围 | 提交 `5d4ee48` 及其后继修复 |
| 代码冻结基准 | **`3349bbf`**（已推送，工作区干净） |
| 结论 | **发现真实缺陷并已最小修复；需要最后一次 `build-signed-apk.ps1`** |

---

## 结论摘要（对应你的 7 个问题）

| # | 问题 | 结论 |
|---|---|---|
| 1 | `5d4ee48` 是否只解决 UI 重复？ | **是。确认只修了本地列表，服务端重复执行完全没管。** |
| 2 | `session/prompt` 是否支持幂等键？ | **支持。`requestId` 就是幂等键，服务端有去重实现。** |
| 3 | 响应丢失时重试会不会重复执行？ | **会。修复前每次重试都生成新 requestId。** |
| 4 | 是否区分「未发送」与「结果不确定」？ | **修复前不区分；现已区分并给出明确提示。** |
| 5 | UI 乐观清理会不会误删真实消息？ | **不会。key 前缀不重叠，且成功时 fold 整体替换。** |
| 6 | 是否新增针对性回归测试？ | **是，12 项。** |
| 7 | 是否做了最小修复？ | **是，改动限定在 `store.send` / `ChatScreen` / 一条 API 透传。** |

---

## 一、`5d4ee48` 的实际作用范围（问题 1）

### 它做了什么

```typescript
// store.ts，失败分支
items: optimisticKey
  ? c.items.filter((it) => it.key !== optimisticKey)
  : c.items,
```

失败时把**本地**乐观插入的那条从 `items` 数组里删掉。

### 它没做什么

- 没有改变发出去的请求
- 没有改变 `requestId`
- **对服务端是否重复执行没有任何影响**

**所以你的判断是对的：那次修复只解决了 UI 重复。**

---

## 二、服务端确实有幂等机制（问题 2）

### 证据来源

从 DSH 生产构建 `E:\DSH\resources\app.asar`（174 MB，v0.2.1-rc.2）里
提取到的实现：

### 2.1 `session/prompt` 的 request 定义

```
"requestId": {
  "type": "string",
  "description": "Client-minted identity persisted on the exact accepted user message."
}
```

注意措辞：**客户端铸造的身份，持久化在那条被接受的消息上**。

### 2.2 服务端的去重判断

```js
async prompt(request, source) {
  const agent = await this.resolveAgent(request.sessionId);
  if (hasPromptRequest(agent, request.requestId)) return { accepted: true };
  ...
}
```

### 2.3 去重的判据（关键）

```js
function hasPromptRequest(agent, requestId) {
  const matches = (message) => {
    const source = message.source;
    return source.kind === "user"
        && "rpcId" in source
        && source.rpcId === requestId;
  };
  // ① 还在排队的
  if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches))
    return true;
  // ② 已经执行过的
  return agent.session.snapshotEvents().some((event) => {
    if (event.type !== "user/message") return false;
    const source = event.data.source;
    return source.kind === "user" && "rpcId" in source && source.rpcId === requestId;
  });
}
```

**同时覆盖「已排队」和「已执行」** —— 这正是解决「响应丢失」场景的关键：
即使任务已经跑完，用同一个 requestId 重试也只会拿到 `{accepted:true}`。

### 2.4 协议文档也写明了这个契约

`docs/protocol-notes.md` §7.4：

> `session/prompt` 的 `requestId` 由**客户端生成**并持久化在那条用户消息上，
> **重试时要用同一个，避免重复入队**

---

## 三、修复前的真实缺陷（问题 3）

### 调用链

```
ChatScreen.send()
  → store.send(sessionId, text, attachments, 'queue')      // 没有 requestId
    → api.prompt({ sessionId, text, parts, mode })          // 也没有
      → requestId: params.requestId ?? `req-${Date.now()}-${随机}`   // 每次新生成
```

**每一次重试都是一次全新的 requestId** → 服务端 `hasPromptRequest` 返回
false → **重新入队 → 任务真的执行第二遍**。

### 危险场景（你点出的那个）

1. 请求已送达，服务端开始执行（比如让 AI 写文件、跑命令）
2. 回执在网络上丢了 / 客户端 30 秒超时 / 突然断网
3. 用户看到「发送失败」，点重试
4. **同一件事在电脑上被执行了两次**

### 实测验证（真实 DSH 服务端）

用同一个 requestId 连发两次不同内容：

```
send#1 (attempt1)              → {"accepted": true}
send#2 (attempt2, 同 requestId) → {"accepted": true}
session/list:  attempt1 = true, attempt2 = false
```

**第二次被服务端丢弃** —— 证明幂等键生效。

> 这个测试同时暴露一个副作用：**同一 requestId 下，改了内容会被丢弃**。
> 所以客户端必须按「文字是否变化」决定要不要换新 id（见下）。

---

## 四、修复内容（问题 4、7）

### 4.1 `store.send()` 透传 requestId

```typescript
async send(
  sessionId: string,
  text: string,
  attachments: OutgoingAttachment[] = [],
  mode: 'queue' | 'steer' = 'queue',
  requestId?: string,          // ← 新增
): Promise<void> {
  ...
  await this.api.prompt({ sessionId, text, parts: content, mode, requestId });
}
```

### 4.2 `ChatScreen` 失败后记住 requestId，重试复用

```typescript
const [retryReq, setRetryReq] = useState<{ id: string; text: string }>();

const isRetry = retryReq !== undefined && retryReq.text === text;
const requestId = isRetry
  ? retryReq.id
  : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

try {
  await store.send(sessionId, text, attachments, 'queue', requestId);
  setRetryReq(undefined);              // 成功 → 清掉，下次是新消息
} catch (e) {
  setRetryReq({ id: requestId, text }); // 失败 → 记住，重试复用
  setSendError(describeSendError(e));
}
```

**为什么要比较 `text`**：实测证明同一 requestId 下服务端会丢弃不同内容。
只按「是不是重试」判断，用户改完内容再发就永远发不出去。

### 4.3 错误提示区分「未知」与「失败」

| 情况 | 文案 |
|---|---|
| **超时**（请求可能已送达） | 「发送结果未知：请求已发出但没收到回执，电脑上可能已经开始执行了。\n直接点发送重试即可 —— 会复用同一个消息 ID，服务端自动去重，不会重复执行。」 |
| **网络不通** | 「消息没发出去（网络不通）。\n检查网络后点发送重试即可。」 |
| **凭据失效** | 「登录凭据失效了，请回到「我的」重新连接后再发送。」 |

修复前统一显示「发送失败」，用户可能以为没发出去，**去电脑上手动再跑一遍
—— 那才是真的重复**。

### 4.4 关于「查询服务端状态」这一条

你建议「对发送结果不确定的请求，应尽量查询服务端状态」。

**当前实现没有加额外的状态查询**，理由：

- 服务端已经用 `requestId` 做了幂等去重，**重试本身就是最可靠的状态查询**
  —— 如果已经入队/执行，服务端返回 `accepted` 且不重复；如果没到，正常入队
- 额外再查一次 `session/page` 或 inbox，在弱网下会**延长等待**，且可能
  查到「还没写入」的中间态而误导用户
- 幂等重试的语义更简单、更不容易出错

如果你希望更保守（比如先查再决定），可以再讨论，但那不是当前缺陷的一部分。

---

## 五、UI 乐观消息清理的安全性复查（问题 5）

### 5.1 会不会误删真实消息？

**不会。key 空间不重叠。**

| 消息类型 | key 格式 | 来源 |
|---|---|---|
| 真实用户消息 | `u-{turn}-{id}` | `fold/index.ts:586` |
| 真实助手消息 | `a-{turn}-{step}` | `fold/index.ts:608` |
| 分隔线 | `d-{turn}` | `fold/index.ts:616` |
| 队员消息 | `{tm.id}` | `fold/index.ts:597` |
| **乐观消息** | **`local-{ts}-{rand}`** | `store.ts:1440` |

过滤条件 `it.key !== optimisticKey` 只可能命中 `local-` 开头的那条。

### 5.2 会不会造成顺序错误？

**不会。**

- 乐观消息永远 **append 在末尾**（`[...cur.items, 新消息]`）
- 成功后被 fold 的完整结果**整体替换**：
  ```typescript
  this.chats.set(sessionId, { ...cur, ...patch, turns, items, running, loading });
  ```
  `items` 直接赋值，顺序由事件 `seq` 排序决定
- 失败时按 key 删除，不重排其余元素

### 5.3 key 冲突风险

原有实现只用 `Date.now()` 作 key —— 同一毫秒连发两条会撞 key，
删除时可能误伤。已加随机后缀：

```typescript
`local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
```

---

## 六、新增回归测试（问题 6）

`tests/send-idempotency-spec.mjs` —— **12 项**

| # | 测试 | 守住什么 |
|---|---|---|
| 1 | `store.send` 把 requestId 透传给 prompt | 幂等键不能丢在中间层 |
| 2 | 不传时 SessionApi 生成默认值 | 注入消息（模式切换等）仍可用 |
| 3 | 🔴 **重试复用同一个 requestId** | **核心：服务端才能去重** |
| 4 | 🔴 若换新 id → 服务端会当成两条 | 反证「为什么必须复用」 |
| 5 | ChatScreen 保存失败请求的 requestId | UI 层不能丢 |
| 6 | ChatScreen 重试时复用 | 不是重新生成 |
| 7 | ChatScreen 成功后清掉 retryReq | 下次发同样内容是**新消息** |
| 8 | 改了文字必须换新 requestId | 否则被服务端丢弃 |
| 9 | store.send 把 requestId 传给 api.prompt | 端到端透传 |
| 10 | SessionApi.prompt 支持 requestId 参数 | API 层契约 |
| 11 | 超时提示「结果未知」 | 不能误导用户 |
| 12 | 网络不通要说清「没发出去」 | 区分两类失败 |

### 关于「有副作用的工具任务」的保障

第 3、4 两项是直接针对你担心的场景：

- 第 3 项证明**修复后同一意图只有一个 requestId**
- 第 4 项是反证：如果换 id，服务端会当成两条（所以绝不能换）

加上实测证据（同一 requestId 第二次被丢弃），可以确认：
**同一意图无论重试多少次，服务端最多执行一次。**

---

## 七、验证结果

| 项 | 结果 |
|---|---|
| typecheck | ✅ 通过 |
| 单测（含新增 12 项） | ✅ 全过 |
| 集成测试 | ✅ 61 项全过 |
| 服务端去重实测 | ✅ 生效（attempt2 被丢弃） |

---

## 八、代码冻结

**冻结基准：`3349bbf`**

```
3349bbf  fix: 重试复用 requestId，避免服务端重复执行任务
b51ffd5  docs: 正式签名 APK 最终验收报告
5d4ee48  fix: 发送失败后重试会产生重复消息
```

- 已推送到 `main`
- 工作区干净（只有 `emu-screenshots/` 未跟踪，不参与构建）

---

## 九、是否需要最后一次 `build-signed-apk.ps1`

### **需要。**

当前验收用的 APK（`...-234510.apk`）构建于 `95a43b5`，
**不包含**这两个修复：

| 提交 | 内容 | 在当前 APK 里？ |
|---|---|---|
| `5d4ee48` | 失败重试产生重复 UI 消息 | ❌ |
| `3349bbf` | **重试复用 requestId（防重复执行）** | ❌ |

在重新构建之前：
- 断网重试仍会出现两条本地消息（UI 重复）
- **更严重的是：重试仍可能让服务端重复执行同一个任务**

所以请再运行一次：

```powershell
cd E:\work\dsBot
.\build-signed-apk.ps1
```

构建完成后告诉我 APK 路径，我会在 `dsh_release` 模拟器上验证：

1. 消息发送（正常路径）
2. 失败重试（重点：**不产生重复消息，且不重复执行**）
3. 完整 AI 回复
4. 断线恢复

---

## 十、未完成的真机测试（不重复已通过的基础项）

以下 10 项**模拟器无法覆盖**，仍需真机：

| # | 项目 | 原因 |
|---|---|---|
| 1 | 扫码配对 | 模拟器摄像头为虚拟场景 |
| 2 | 通知实际送达（后台/锁屏） | 需厂商推送通道 |
| 3 | 通知点击跳转（含冷启动） | 同上 |
| 4 | 审批按钮实际生效 | 需触发真实命令执行审批 |
| 5 | 震动反馈 | 无马达 |
| 6 | 边缘滑动手势 | 需与系统手势导航共存 |
| 7 | 图片查看 / 长按保存相册 | 需含图片消息的会话 |
| 8 | 文档转发 / 保存到下载 | 需含文件消息的会话 |
| 9 | 真实帧率与流畅度 | swiftshader 软渲染 |
| 10 | 锁屏后 Keystore 读取 | 需真实锁屏 |

> 建议真机时**额外重点测一次「断网发送 → 恢复 → 重试」**，
> 确认在真实网络抖动下不会重复执行任务（这是本轮修复的核心场景）。

---

*报告生成：2026-10-28 · 代码 `3349bbf`*
