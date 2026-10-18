# DSH Web 后端协议实测笔记

> 面向「原生 app 连接电脑上的 DSH Web 服务」这个场景。
> 本文内容全部来自**本机实测**（DSH `0.2.1-rc.2`，2026-10），不是读文档推测。
> 参考实现：[`probes/verify2.mjs`](../probes/verify2.mjs)（零依赖，约 260 行，可直接跑通全链路）。

---

## 0. 一句话流程

```
扫码/拿 token
  → GET /?token=xxx          换到 30 天有效的 cookie
  → POST /api/session/list   拿会话列表（含 cwd → 工作区）
  → WS  /api/remote.mux      open session/follow → 拿到 cursor + 历史 + 实时增量
  → POST /api/session/page   分页补更早的历史（用上一步的 cursor）
```

---

## 1. 认证

### 1.1 拿 cookie

```
GET /?token=<启动日志里的 token>
```

响应 **303**，`Set-Cookie` 里带：

```
dsh-auth-<32字符>=v2.<payload>.<sig>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
```

- cookie 名里的 hash 由 host:port 决定，**换端口会变成另一个名字**
- 有效期 **30 天**，`expiresAt` 是绝对时间戳，写在 payload 里
- 签名密钥持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session`

### 1.2 免扫码（重要）

**cookie 跨服务重启有效。** 实测：服务重启后旧 cookie 访问 `GET /` 仍返回 200。

对 app 的含义：**首次配对后把 cookie 存进 Keychain/Keystore，30 天内不用再扫码。**

### 1.3 不要用 `/connect`

文档说 `GET /connect?token=...&interactions=answer` 是"仅供 API 客户端"的入口，返回 302 + cookie + `location: ./api/remote.mux`。

**实测：`/connect` 的 cookie 单独发 HTTP 会 401（必须配合 WebSocket）；`GET /?token=` 的 cookie 可以直接用。**

→ **原生 app 走 `GET /?token=`，不要走 `/connect`。**

### 1.4 请求头要求

所有请求必须带：

```
Host: <ip>:<port>        ← 必须是监听地址本身，或 --trusted-host 里的条目
Cookie: <cookie>
```

Host 不匹配返回 **403**，未认证返回 **401**。

---

## 2. Unary RPC

### 2.1 形状

```
POST /api/<namespace>/<method>
Content-Type: application/json

{
  "type": "client-request",
  "rpcId": "<任意唯一字符串>",
  "method": "<namespace>/<method>",     ← 必须和 URL 路径一致
  "payload": { "args": { ... } }
}
```

响应：

```json
{ "type": "server-response", "rpcId": "...",
  "result": { "ok": true, "value": { ... } } }
```

失败时 `{ "ok": false, "error": { "code", "message", "details" } }`，**HTTP 仍是 200**，要判 `result.ok`。

### 2.2 四个实测后才发现的坑

| # | 问题 | 正确做法 |
|---|---|---|
| 1 | endpoint 分隔符 | **用斜杠** `session/list`，不是 `session.list` |
| 2 | 第一个参数名 | `session/list` 用 **`_request`**；其它方法用 **`request`** |
| 3 | `session/page` 的载荷 | 不是 `{sessionId, limit}`，见 §2.3 |
| 4 | `throughSeq` 越界 | 必须 ≤ 会话 cursor，否则 `past cursor` 错误 |

> 第 2 条是真实的不一致：`session/list` 的 descriptor 第一个参数叫 `_request`，其余叫 `request`。报错信息会直接告诉你缺哪个。

### 2.3 关键方法载荷

**`session/list`**

```json
{ "_request": {} }
```

返回 `{ items: [...] }`，每项：

```
sessionId, cwd?, updatedAt, running, blank, agentAvailable,
parentSessionId?, origin? ("subagent"),
projections: { kind, asOfSeq, values: { title, todos, inbox, tokenUsage,
                                        contextPressure, sessionStats, model } }
```

**`session/page`**

```json
{ "request": {
    "address": { "kind": "session", "sessionId": "..." },
    "throughSeq": 2163,
    "beforeSeq": 1200,
    "maxMessages": 200,
    "turnWindow": { "minMessages": 10, "minTurns": 2 }
} }
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `address` | 是 | `{kind:"session", sessionId}` 或 `{kind:"subagent", parentSessionId, childSessionId, mode}` |
| `throughSeq` | 是 | **包含**的日志切口，**必须来自 follow 首帧的 cursor** |
| `beforeSeq` | | 往前翻页的锚点 |
| `maxMessages` | | 消息数上限 |
| `turnWindow` | | 按 turn 截断（两个最小值都满足后停在下一个 turn 起点） |

返回 `{ records: [{ type:"event", event:{ type, seq, time, data } }], hasMore }`。

**`session/create`**

```json
{ "request": {
    "cwd": "C:\\work\\demo",        // 或 workspaceId（二者互斥）
    "sessionId": "可选，复用空白会话",
    "agentPreset": "可选"
} }
```

**`session/prompt`**

```json
{ "request": {
    "requestId": "<客户端自造的唯一 id>",
    "sessionId": "...",
    "mode": "queue" | "steer",        ← steer = 中途插话
    "content": [
      { "type": "text", "text": "..." },
      { "type": "image", "mediaType": "image/png", "data": "<base64>", "name": "可选" },
      { "type": "file", "receiptId": "..." }
    ],
    "clientTimeZone": "Asia/Tokyo"    // 可选
} }
```

返回 `{ accepted: true }`。

**`session/cancel`**（打断当前轮）

```json
{ "request": { "sessionId": "..." } }
```

返回 `{ accepted: true }`。只传 sessionId，不需要轮次 id。

**`session/updateQueue`**（管理排队中的消息）

```json
{ "request": {
    "sessionId": "...",
    "itemId": "<排队消息的 id>",
    "action": { "kind": "remove" }
           |  { "kind": "steer" }
           |  { "kind": "edit", "content": [{ "type":"text", "text":"..." }] }
} }
```

返回 `{ accepted: true }`。

> 这条是「排队消息可单独操作」的关键：用户连发三条，可以只删第二条、把第三条改成插话，而不必打断整轮。排队项的 id 来自 `projections.values.inbox`（`next-turn` / `next-step` 数组）。

### 2.4 附件上传与读取（2026-10-18 实测）

**上传字节** —— 这是**独立的 HTTP 路由**，不是 unary RPC：

```http
POST /api/session/uploadFileBinary?sessionId=<会话id>&name=<文件名>
Content-Type: application/octet-stream
Cookie: <dsh-auth cookie>
<原始字节>
```

```json
{ "ok": true, "value": {
    "receiptId": "<uuid>",
    "file": { "attachmentId": "sha256:…", "name": "pixel.png", "bytes": 70 }
} }
```
失败是 `{ "ok": false, "error": { "code", "message" } }`。

- 只接受 `application/octet-stream`，别的内容类型返回 **415**
- 缺 `sessionId` 返回 **400**
- 回执只对**那一个会话**有效，且不能跨会话复用

**发消息带附件**（`session/prompt` 的 `content`）：

| 片段 | 形状 | 说明 |
|---|---|---|
| 文本 | `{ "type":"text", "text":"…" }` | |
| 图片 | `{ "type":"image", "mediaType":"image/png", "data":"<base64>", "name":"可选" }` | **必须内联 base64** |
| 文件 | `{ "type":"file", "receiptId":"<上传回执>" }` | **必须用回执**，没有内联形式 |

> ⚠️ `{ "type":"image", "receiptId":"…" }` 会被 wire 校验拒绝
> （`gateway/input-invalid: wire field "request" failed boundary validation`），
> 图片只能内联、文件只能走回执，两条路不能互换。

**会话里存下来的形状**（`user/message` 的 `data.content`）—— 注意**和输入不一样**：

```json
{ "type": "image",
  "attachment": { "attachmentId": "sha256:…", "mediaType": "image/png",
                  "width": 1, "height": 1, "bytes": 70, "name": "pixel.png" } }

{ "type": "file",
  "attachment": { "attachmentId": "sha256:…", "name": "pixel.png", "bytes": 70 } }
```

- 输入时的 `receiptId` **不会**保留，只剩 `attachment`
- 图片的 `width` / `height` 是 Host 解析出来的，排版可直接用

**读回附件字节**（只有图片提供这个接口）：

```
session/attachment
{ "request": { "sessionId": "…", "attachmentId": "sha256:…" } }
→ { "attachment": { "attachmentId":"…", "mediaType":"image/png", … }, "data": "<base64>" }
```

> ⚠️ 参数要包一层 `request`（和 `session/page` 一样）。平铺传
> `{ sessionId, attachmentId }` 会报 `gateway/arguments-invalid: missing "request"`。
> 另外它只对**本会话引用过的图片**放行，别的会话的 attachmentId 会被拒。

**用 Node 复现这三个接口**：[`../probes/verify-upload.mjs`](../probes/verify-upload.mjs)、
[`../probes/verify-upload2.mjs`](../probes/verify-upload2.mjs)、
[`../probes/verify-attachment-read.mjs`](../probes/verify-attachment-read.mjs)

### 2.5 工作区注册表：会话有两份清单（重要）

DSH 里「会话」有两个独立的来源，**不要混用**：

| 来源 | 接口 | 内容 |
|---|---|---|
| 磁盘扫描 | `session/list` | 扫 `~/.dsh/sessions/`，返回**全部**会话 |
| 工作区注册表 | `workspace/follow` 的首帧 baseline | 每个工作区**登记**了哪些会话（存 `~/.dsh/storages/workspace.json`） |

**桌面端按注册表渲染，手机 App 之前只读了 `session/list`** —— 这就是
「手机上建的会话，电脑上看不到」的根因。

`session/create` 的两个参数语义不同（实测）：

```jsonc
// ❌ 只传 cwd：会话落盘，但**不登记**进注册表 → 桌面端看不到
{ "request": { "cwd": "C:\\work\\demo" } }

// ✅ 传 workspaceId：落盘 + 登记进注册表 → 桌面端能看到
{ "request": { "workspaceId": "866e0b64-…" } }
```

用 `workspaceId` 建出来的会话，`session/list` 里的 `cwd` 仍然正确
（来自工作区的 `path`），所以按 cwd 分组的逻辑不受影响。

**按路径拿 workspaceId**（幂等，已存在时 `created:false`）：

```json
workspace/create { "request": { "path": "C:\\work\\demo" } }
→ { "workspace": { "workspaceId": "866e0b64-…", "path": "C:\\work\\demo",
                   "title": "dsBot", "sessionIds": [...] },
    "created": false }
```

**补登记不行**（都实测过，别浪费时间）：

| 尝试 | 结果 |
|---|---|
| `session/create { workspaceId, sessionId: <已有> }` | 返回**新的** sessionId，只是又建了一个空白会话，不会接管旧的 |
| `workspace/insertSessionBefore { workspaceId, sessionId }` | `workspace/move-invalid: … the session is not accounted` |

所以注册必须发生在**创建时**；已经漏登记的历史会话没有补救接口。

复现脚本：[`../probes/exp-create-workspace-session.mjs`](../probes/exp-create-workspace-session.mjs)、
[`../probes/exp-workspace-create.mjs`](../probes/exp-workspace-create.mjs)、
[`../probes/exp-adopt-session.mjs`](../probes/exp-adopt-session.mjs)、
[`../probes/exp-insert-session.mjs`](../probes/exp-insert-session.mjs)、
[`../probes/check-workspaces.mjs`](../probes/check-workspaces.mjs)

### 2.6 Agent Teams 怎么判断「有没有」，以及团队投影

**Agent Teams 是 profile 级开关**，不是按会话开关：
`@deepseek-ai/dsh-experimental-agent-team-profile` 这个 bundle 装进 profile 就全都有。
本项目里 web / desktop 两个 profile 的 `package.json` 都列了它。

所以 App 通过 `session/create`（`preset=standard`）建出来的会话**同样具备团队工具**。
验证方法不需要花模型额度：会话的 `request/header` 事件里带完整工具 schema：

```
工具数 37，其中团队 8 个：
spawn_teammate, send_message, list_agents, interrupt_agent,
wait_agent, team_task_create, team_task_get, team_task_list, team_task_update
```

脚本：[`../probes/list-session-tools.mjs`](../probes/list-session-tools.mjs)（纯读，不需要模型额度）

**团队状态从会话投影拿，不需要额外 RPC**：

```jsonc
// session/list 或 follow 快照的 projections.values.agentTeam
{
  "members": [
    { "id": "...", "name": "ui-theme-a", "role": "lead|teammate",
      "phase": "active|provisioning|failed", "error": "可选" }
  ],
  "tasks": [
    { "id": "...", "subject": "...", "status": "pending|in_progress|completed|deleted",
      "ownerName": "ui-theme-a", "blockedBy": [], "writeScopes": [], "ready": true }
  ],
  "failure": "可选"
}
```

只有「有队伍」的会话才有这个字段；有队伍时即使没有任务也会返回（members 里至少有 lead）。
事件流里另有 `team/member`、`team/task`、`team/message/*` 增量事件，做实时推送时可用。

> ⚠️ **实测补充（重要）**：`team/member` / `team/task` 这些事件**不在会话日志里**。
> 对已有队伍的会话做 `session/follow` 拿到的 records 里一条 `team/*` 都没有
> （`probes/dump-team-events.mjs` 可复现），只有 `projections.values.agentTeam` 有数据。
> 所以客户端要「实时」只能**轮询 `session/list` 读投影**，拿不到增量推送。

---

## 3. 流式 RPC（WebSocket）

### 3.1 连接

```
WS /api/remote.mux
Cookie: <cookie>
Host: <ip>:<port>
```

升级成功后收发 **JSON 文本帧**。

### 3.2 帧格式

客户端 → 服务端：

```json
{ "type": "open",   "streamId": "<uuid>", "endpoint": "session/follow",
  "payload": { "args": { "request": { "address": { "kind": "session", "sessionId": "..." } } } } }

{ "type": "item",   "streamId": "...", "value": <上行数据> }
{ "type": "end",    "streamId": "..." }
{ "type": "cancel", "streamId": "..." }
```

服务端 → 客户端：

```json
{ "type": "item",  "streamId": "...", "value": { ... } }
{ "type": "error", "streamId": "...", "error": { "code", "message", "details" } }
```

### 3.3 `session/follow` 的首帧是完整快照

**这是最重要的发现。** 打开 `session/follow` 后收到的第一条 `item` 包含：

```
{ type, header, cursor, records, hasMore, projections }
```

- `records` —— 当前历史（事件数组，格式同 `session/page`）
- `cursor` —— 当前序列号，**就是 `session/page` 要的 `throughSeq`**
- `hasMore` —— 是否还有更早的历史
- `projections` —— 会话状态（title、token 用量等）

**对 app 的含义：打开会话只需一次 follow，就能同时拿到历史 + 状态 + 后续增量，不用先 page 再 follow。**

### 3.4 正确调用顺序

```
1. WS open session/follow
2. 收首帧 → 保存 cursor，渲染 records
3. 若 hasMore === true
     POST /api/session/page { request: { address, throughSeq: cursor, beforeSeq: <最早seq>, maxMessages: 200 } }
   拿到更早的记录，插到列表前面
4. 继续收 follow 的后续 item（增量）
```

---

## 4. 事件类型与 fold 规则

### 4.1 实测的事件分布（一个 1240 条记录的会话）

```
182  tool/call          182  tool/result
179  assistant/message  179  step/end       178  step/start
130  job/registered     130  job/settled
 32  agent/inbox/spliced
 21  user/message
 12  turn/start         12  turn/end
  2  workspace/changes
  1  deliverables/presented
```

### 4.2 fold 成消息模型

```
turn/start         → 开一个新 turn
user/message       → turn.user = { text, time }
step/start         → 开一个新 step（一个 turn 可以有多个 step）
assistant/message  → 按 content[].type 追加 block：
                       "text"      → { kind:'text', text }
                       "reasoning" → { kind:'reasoning', text }       ← 思考面板
                       "tool-call" → { kind:'tool', name, input, id } ← 工具卡
tool/result        → 按 id 回填到对应 tool block 的 output / isError
turn/end           → 关闭当前 turn
```

实测：1240 条事件 → **13 个 turn**，结构正确。

> 注意 `content` 里的 `reasoning` 块的字段名可能是 `text` 或 `reasoning`，要都兼容。

### 4.3 常见事件对照

| 事件 | 用途 |
|---|---|
| `turn/start` / `turn/end` | 一轮问答的边界 |
| `step/start` / `step/end` | 一次模型调用（含工具往返） |
| `user/message` | 用户输入 |
| `assistant/message` | 助手输出（含 text / reasoning / tool-call） |
| `tool/call` / `tool/result` | 工具执行 |
| `job/registered` / `job/settled` | 后台任务（可折叠展示） |
| `agent/inbox/spliced` | 补充上下文 |
| `session/title` | 标题更新 |
| `todo/write` | todo 快照 |
| `workspace/changes` | 文件改动（对应 diff 查看器） |
| `deliverables/presented` | 产物 |

---

## 5. 会话状态（projections）

`session/list` 的每项、`session/follow` 的首帧都带 `projections.values`，**直接可用来做 token 量表**：

```json
{
  "title": "设计DS团队协作Bot方案",
  "tokenUsage": {
    "uncachedInputTokens": 295449,
    "outputTokens": 153569,
    "cacheReadTokens": 44159744,
    "cacheWriteTokens": 0
  },
  "contextPressure": {
    "pressureTokens": 287375,
    "projectedTokens": 287900,
    "contextWindow": 1000000
  },
  "sessionStats": {
    "turns": 15, "steps": 260,
    "llmMs": 1870909, "toolMs": 2279788,
    "ttftMs": 1166739, "ttftSteps": 260,
    "decodeMs": 704170, "decodeTokens": 153569
  },
  "inbox": { "next-turn": [], "next-step": [] },
  "todos": null,
  "model": { }
}
```

`contextPressure.pressureTokens / contextWindow` 就是上下文占用比例。

---

## 6. 三层导航的数据映射

```
工作区列表        ← session/list 按 cwd 分组（无需额外存储）
  └─ 会话列表     ← 同一 cwd 下的会话，按 updatedAt 排序
       └─ 聊天    ← session/follow → records → fold
```

实测本机：

```
[C:\work\demo]                                             40 个会话
[C:\Users\<you>\Documents\deepseek-harness\default-workspace]   1 个会话
```

**子 agent 会话**在列表里带 `origin: "subagent"` 和 `parentSessionId`，建议默认折叠或过滤，避免主列表被污染。

---

## 7. 输入交互约定（app 端）

### 7.1 连发两条：默认排队

```
用户发消息 A（轮次正在跑）
  → session/prompt { mode: "queue" }
  → 消息进 inbox，等当前轮 turn/end 之后才开始
```

**不要**默认用 `steer`。`steer` 是在"最近步骤边界"插入，会打断模型当前的连续动作——对普通输入来说太激进了。

### 7.2 打断：用户显式点击才发生

```
用户点「打断」
  → session/cancel { sessionId }        ← 停当前轮
  → inbox 里排队的消息保留，继续按队列执行
```

`session/cancel` 只传 `sessionId`，不针对某一条消息。

### 7.3 排队中的消息可以单独操作

这是比"打断"更细的一档，建议在 UI 里把排队消息显示成可操作的小卡片：

| 用户动作 | 调用 |
|---|---|
| 删掉某条排队消息 | `session/updateQueue { action: {kind:"remove"} }` |
| 把某条改成立即插话 | `session/updateQueue { action: {kind:"steer"} }` |
| 改某条的内容 | `session/updateQueue { action: {kind:"edit", content:[...]} }` |

**推荐的消息状态机**：

```
[输入框] --发送--> [排队中 queue]
                      ├─ 用户点 ×        → updateQueue remove
                      ├─ 用户点 插队     → updateQueue steer
                      └─ 轮到执行         → 变成 [执行中]
                                            └─ 用户点「打断」 → session/cancel
```

**这样做的原因**：用户连发三条消息时，最常见的诉求是"删掉我刚才说错的那条"或"把第三条急事提前"，而不是"把整轮都停掉"。默认 `queue` + 点击才 cancel，能覆盖绝大多数情况，且不会误伤。

### 7.4 消息处理的边界

- `session/prompt` 的 `requestId` 由**客户端生成**并持久化在那条用户消息上，重试时要用同一个，避免重复入队
- 排队项没有独立的"发送成功"回执，只有 `{accepted:true}`；真正的执行要等 `turn/start`
- `projections.values.inbox` 里的 `next-turn` / `next-step` 就是当前排队的条目，可用于渲染"待发送"列表

---

## 8. 已知限制

1. **无真流式** —— 所有事件都是"步骤提交"粒度。助手输出在 `assistant/message` 提交时一次性到达，不是逐 token。app 要做打字机效果只能前端重放。
2. **协议无版本协商** —— 类型从 Host 代码生成，DSH 升级可能变。关键方法（list/page/follow/prompt/cancel/updateQueue）相对稳定。
3. **单写者** —— 同一个 session 同时只能有一个进程持有。app 和桌面 GUI 不能同时对同一会话写入。
4. **`throughSeq` 必须来自 follow** —— 自己猜一个值会报 `past cursor`。
5. **`session/page` 无 `limit` 字段** —— 用 `maxMessages` 或 `turnWindow`。
6. **`session/cancel` 不含轮次 id** —— 它停的是"当前这一轮"，无法指定取消某次具体调用。

---

## 9. 可复用代码

[`probes/verify2.mjs`](../probes/verify2.mjs) 是一个零依赖参考实现，包含：

- `getCookie()` —— token 换 cookie
- `rpc()` —— unary 调用封装
- `WS` —— 手写 WebSocket 客户端（约 80 行，可换成 `ws` 库）
- `fold()` —— 事件 → turn 模型
- 完整演示：分组工作区 → 拉历史 → 建流

跑法：

```powershell
$env:DSH_TOKEN = '<从 dsh web 启动日志复制>'
$env:DSH_HOST  = '192.168.1.10'
$env:DSH_PORT  = '3095'
node probes/verify2.mjs
```

---

## 10. 对 RN app 的直接影响

| 需求 | 做法 |
|---|---|
| 首次配对 | 扫码 → `GET /?token=` → cookie 存 Keychain |
| 30 天免登录 | 直接复用存下的 cookie |
| 工作区列表 | `session/list` 按 `cwd` 分组 |
| 打开会话 | WS `session/follow`（一次拿全） |
| 往上翻历史 | `session/page` + `beforeSeq` |
| 发消息 | `session/prompt`，默认 `mode: "queue"` |
| 打断 | 用户点击 → `session/cancel` |
| 管理排队 | `session/updateQueue` remove / steer / edit |
| token 量表 | `projections.values.tokenUsage` / `contextPressure` |
| 思考面板 | fold 出的 `reasoning` block |
| 工具卡 | fold 出的 `tool` block（含 output 回填） |
| diff 查看 | `workspace/changes` 事件 |
| 会话列表拖拽排序 | 本地存顺序（DSH 不管排序） |

---

## 附：本机服务启动

```powershell
# 手机可达，需要绑定 tailnet IP（不是 127.0.0.1）
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-web-tailnet.ps1
```

桌面端 GUI 的 `127.0.0.1:57925` **手机连不上**（只监听回环），且桌面 profile 被 Electron 独占、不能传 `--host`。所以手机端要连的是 `dsh --profile web --host <tailnet-ip>` 起的那个服务。
