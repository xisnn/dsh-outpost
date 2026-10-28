# P0-1 持久化发送请求身份与待发送消息 — 分阶段实施方案

| 项 | 值 |
|---|---|
| 目标版本 | v0.17.0 |
| 开发分支 | `feat/v0.17`（从 `06a33e1` 创建） |
| 基线代码 | `3349bbf`（运行时代码与当前 `v0.16.7` 一致） |
| 方案状态 | **评审后修订；阶段 0/1 已实施，待验收** |
| 范围 | 只做 P0-1；P0-2/P0-3/P1 不在本方案内 |
| 依赖边界 | 不复制 Cindy 源码；不引入 Cindy 云端服务；不修改 DSH 服务端 |

---

## 0.1 评审后修订（2026-10-28，优先级高于下文旧表述）

1. **禁止按指纹自动复用 requestId**：正常新发送永远生成新 `requestId`；只有用户明确点“重试”某条未决记录时，`PendingSendStore.retry()` 才复用记录里的旧 ID。指纹只用于 UI 冲突提示和测试。连续两次发送完全相同文本必须得到两个不同 ID。
2. **退出登录语义**：普通 `signOut`（断开连接、保留凭据）**保留**待发送记录；只有 `clearAuthorization`（彻底清除授权）才清除记录，并在清除未确认任务前向用户明确提示。
3. **记录绑定服务实例与授权上下文**：每条记录保存 `{baseUrl, gatewayId, authContextHash}`；重试前三者必须全部匹配，禁止跨服务端/跨服务实例/跨授权上下文重试。缺 `gatewayId` 视为不可验证，不允许重试。
4. **Android 安全存储先验证再依赖**：`accessible` 是 iOS/visionOS 参数，Android `react-native-keychain` 不读取它。Android 侧显式要求 `storage: KeystoreAESGCM_NoAuth` 并校验实际返回的 storage；实际加密、锁屏、备份、容量行为以 `docs/v0.17/ANDROID-SECURE-STORAGE-VERIFY.md` 的模拟器实测为准。
5. **存储方案与并发**：接受最多 20 条 / 256 KiB 的加密单文档方案；所有写入串行化（单 Promise 队列），写后回读必须与写入字节完全一致；阶段 1 必须做容量、读写性能、并发写入、进程终止/重启测试。
6. **`@noble/hashes`**：确认 MIT 许可证，锁定 `2.4.0`，并增加指纹测试。
7. **重启恢复不自动重发**：`sending` 重启后归为 `unknown`，`preparing` 归为 `failed`；`queued/ready/accepted` 保持原状态。任何未知结果都必须由用户明确触发安全重试。
8. **持久化/确认写入失败**：不生成新的 requestId、不改变内存状态、不执行网络请求；确认状态写入失败时保持 `accepted` 并保留原 ID。

---

## 0. 一句话目标

把“发送意图”从 `ChatScreen` 的 React state 迁移到**发送前落盘、带稳定 requestId 的本地 outbox**：App 被杀、页面退出、进程重启后仍能识别“这条消息可能已经送达”，重试时复用同一 `requestId`，内容或附件变化时生成新的请求身份，并且存储失败时**阻止发送而不是退回内存**。

---

## 1. 现状与缺陷定位（基线代码 `3349bbf`）

### 1.1 当前链路

```text
ChatScreen.send()                         ChatScreen.tsx:298-335
  → 生成 requestId：isRetry ? retryReq.id : `req-${Date.now()}-...`   :312-314
  → resolveDrafts()：图片读 base64 / 文件先上传                 :259-296
  → store.send(sessionId, text, attachments, mode, requestId)   :320
      → api.prompt({ ..., requestId })                           store.ts:1406-1484
          → session/prompt                                       rpc/session.ts:71-107
  → 成功 setRetryReq(undefined) / 失败 setRetryReq({id,text})    :321-330
```

### 1.2 五个具体缺口

| # | 缺口 | 证据 |
|---|---|---|
| 1 | `retryReq` 仅存在于组件内存 | `ChatScreen.tsx:117`；`NavHost` 卸载页面即丢 |
| 2 | `requestId` 在 `resolveDrafts()`（可能包含上传网络请求）之后才生成；网络请求前没有持久化 | `ChatScreen.tsx:313-320` |
| 3 | 没有持久化“待发送消息”本身；失败后只把草稿放回输入框 | `ChatScreen.tsx:324-330` |
| 4 | 失败只有内存错误提示，没有“确定失败/结果未知/已受理”的状态机 | `describeSendError` 仅做文案分类，`ChatScreen.tsx:879-902` |
| 5 | 附件不参与重试身份判定：只比较 `retryReq.text === text` | `ChatScreen.tsx:312`；附件-only 或改附件会错误复用/错误放弃 |

### 1.3 DSH 服务端已具备的幂等条件（本方案的前提）

已在本机 DSH 生产构建中核对：

- 构建：`E:\DSH\resources\app.asar`，`package.json` = `@deepseek-ai/dsh-desktop` **0.2.1-rc.2**。
- 控制器：`dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`
  - `async prompt(request, source)` 在真正入队前执行：
    ```js
    if (hasPromptRequest(agent, request.requestId)) return { accepted: true };
    ```
  - `hasPromptRequest(agent, requestId)` 的判据：
    ```js
    const matches = (message) => {
      const source = message.source;
      return source.kind === "user" && "rpcId" in source && source.rpcId === requestId;
    };
    if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true;
    return agent.session.snapshotEvents().some((event) => {
      if (event.type !== "user/message") return false;
      const source = event.data.source;
      return source.kind === "user" && "rpcId" in source && source.rpcId === requestId;
    });
    ```
- 协议文档：`docs/protocol-notes.md:561` 明确“`requestId` 由客户端生成并持久化在那条用户消息上，重试时要用同一个，避免重复入队”。

**结论**：requestId 是唯一去重键，且服务端**不比较内容**。因此客户端必须做到：

1. 同一条消息的所有重试使用同一 requestId；
2. 内容/附件改变时必须换新 requestId，否则服务端会把新内容当成重复丢弃；
3. requestId 必须在发送前持久化，且不能依赖 UI 生命周期。

---

## 2. 设计总览

### 2.1 模块划分（新增）

```text
dsh-mobile/src/core/pendingSend/
  types.ts        PendingSendRecord / PendingSendState / PendingAttachment
  fingerprint.ts  文本规范化 + 附件 SHA-256 + fingerprint 生成
  persistence.ts  KeychainPendingSendPersistence（Keychain 单文档，Android AES-GCM 校验）
  ids.ts          requestId 生成（每次正常发送新 ID）
  state.ts        纯状态机：transition(record, event) → record / 错误
  store.ts        PendingSendStore：load/list/create/update/retry/clear/prune/subscribe
```

并修改：

- `dsh-mobile/src/core/store.ts`：新增 `Store.sendPending()` 编排入口；保留现有 `send()` 作为底层 API（继续接收 requestId）。
- `dsh-mobile/src/screens/ChatScreen.tsx`：移除 `retryReq`；改为订阅 `PendingSendStore`，渲染待发送/未知/失败气泡。
- `dsh-mobile/src/App.tsx`：启动时 `hydrate()` + `prune()`；`signOut` **保留**待发送记录，`clearAuthorization` 在用户确认后调用 `clearAll()`，并把清理结果纳入 `ClearAuthorizationResult`。
- `dsh-mobile/package.json`：增加 `test:pendingSend` 等脚本并接入 `npm test`（不改变现有测试链语义）。

### 2.2 核心不变量

1. **任何网络请求之前**，`requestId` 与完整发送意图已经通过“写入 + 回读校验”。
2. **同一个 `PendingSendRecord` 的 requestId 永不重新生成**；只有新建记录才生成新 id。
3. **正常发送永远新建记录**；指纹只用于提示/校验，绝不因指纹相同自动复用 ID；旧记录不被覆盖、不被静默删除。
4. **持久化不可用 = 不发送**；不允许静默降级到内存/AsyncStorage 明文。
5. **服务端已受理（`accepted`）不等于会话已确认（`confirmed`）**；两者分别记录，确认后清理。
6. **发送状态只由纯状态机迁移**；UI 只渲染状态，不自行判断。

---

## 3. 数据模型

### 3.1 `PendingSendRecord`

```ts
type PendingSendState =
  | 'queued'      // 已落盘，尚未开始准备附件
  | 'preparing'   // 正在读取/上传附件
  | 'ready'       // 附件已就绪，尚未调用 session/prompt
  | 'sending'     // 已落盘“将发送”，prompt 可能已在途
  | 'accepted'    // session/prompt 已返回 accepted:true
  | 'unknown'     // 结果未知，可能已执行；重试必须复用 requestId
  | 'failed'      // 明确未送达/被拒绝，任务确定没执行
  | 'confirmed'   // 会话记录中已出现相同 rpcId 的 user/message
  | 'abandoned'   // 用户主动放弃；未发送过的记录可直接清理
  | 'expired';    // 超过保留期，payload 已清除（只留非敏感墓碑）

interface PendingAttachment {
  kind: 'image' | 'file';
  localUri: string;
  name: string;
  size: number;
  mime?: string;
  /** 文件内容 SHA-256；没有它不允许发送（fail closed） */
  contentSha256: string;
  /** 文件上传回执；仅 file 类型，重试时可复用 */
  receiptId?: string;
  attachmentId?: string;
}

interface PendingSendBinding {
  baseUrl: string;            // 归一化后的服务地址
  gatewayId: string | null;   // DSH 稳定实例标识；null = 老协议不可验证
  authContextHash: string;    // 服务端/客户端设备 id + 凭据上下文派生
  identityQuality: 'confirmed' | 'unverifiable';
}

interface PendingSendRecord {
  schema: 1;
  requestId: string;         // 稳定幂等键；正常发送每次新建
  sessionId: string;
  mode: 'queue' | 'steer';
  text: string;              // 原样保存；发送时 trim
  attachments: PendingAttachment[];
  fingerprint: string;       // 仅用于 UI 冲突提示/测试，禁止自动复用 ID
  state: PendingSendState;
  attemptCount: number;
  binding: PendingSendBinding;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;         // 默认 createdAt + 7 天
  acceptedAt?: number;
  confirmedAt?: number;
  lastError?: {
    classification: 'definite' | 'unknown';
    code: string;            // 机器码，如 timeout/network/http-500/auth
    message: string;         // 截断 200 字符，UI 只展示安全文案
  };
}
```

### 3.2 存储文档

```ts
interface PendingSendDocument {
  schema: 1;
  revision: number;
  updatedAt: number;
  records: PendingSendRecord[];
}
```

### 3.3 状态迁移表

| 当前状态 | 事件 | 下一状态 | 说明 |
|---|---|---|---|
| （无） | 用户发送（无论是否有相同文本/附件） | `queued` | **永远新建 requestId**；绝不按指纹自动复用 |
| `queued` | 开始附件准备 | `preparing` | 此时仍不会发送 prompt |
| `preparing` | 附件全部就绪 | `ready` | 回执/本地 URI 已写回 |
| `preparing` | 附件读取/上传失败 | `failed` | 确定未调用 prompt |
| `ready` | 即将调用 `session/prompt` | `sending` | **先持久化再发网络请求** |
| `sending` | `session/prompt` resolve | `accepted` | 服务端只保证入队 |
| `sending` | 明确拒绝（本地校验/4xx/结构化错误） | `failed` | 确定没执行 |
| `sending` | 超时/断网/5xx/响应损坏/进程退出 | `unknown` | 可能已执行；retry 同 id |
| `unknown`/`failed`/`queued`/`preparing`/`ready` | **用户明确点重试** | `preparing` | 唯一允许复用旧 requestId 的入口 |
| `accepted` | 会话记录出现 `user/message.source.rpcId === requestId` | `confirmed` | 强确认；随后删除 |
| `accepted` | 24h 仍未确认 | `accepted`（保留）/清理 | 不自动重发 |
| `queued`/`preparing`/`ready` | 用户取消 | `abandoned` | 未发送，可安全放弃 |
| `sending` | App 重启恢复 | `unknown` | 不自动重发 |
| `preparing` | App 重启恢复 | `failed` | prompt 一定没发 |
| 任意未决 | `now >= expiresAt` | `expired` | 删除 payload，写非敏感墓碑 |
| `confirmed`/`abandoned` | 清理 | 删除记录 | 不保留消息内容 |

非法迁移在开发环境抛错，在生产环境记录安全错误码并拒绝操作，不猜测。

---

## 4. 九个重点要求的落地方式

### 4.1 requestId 在网络请求前持久化

**顺序（严格）**：

1. 生成 requestId（`req-<timestamp>-<counter>-<random>`；测试可注入固定 id）。
2. 计算文本/附件指纹。
3. `PendingSendStore.create()`：写入 Keychain 文档 → 回读字符串必须与写入完全一致 → 才返回。
4. 进入 `preparing`，才允许读取附件/上传文件（上传也是网络请求）。
5. 附件就绪后写入 `ready`。
6. 写入 `sending` 并回读成功。
7. 才调用 `store.send(..., requestId)`。

**测试断言**：用操作日志记录 `keychain.write`、`uploadFileBinary`、`session/prompt` 的调用顺序；断言 `keychain.write(requestId)` 永远早于 `prompt`，且 `sending` 落盘早于 `prompt`。任何一步写失败都不能出现 `prompt` 调用。

### 4.2 发送成功、失败、结果未知的状态区分

**成功**分两级：

- `accepted`：`session/prompt` 返回成功（`accepted:true`）。这只代表服务端已受理，不保证已经出现在会话事件中。
- `confirmed`：`Store` 在会话记录中看到 `event.type === 'user/message'` 且 `event.data.source.rpcId === requestId`。这是最强的成功确认，确认后删除 outbox 记录。

**失败（definitely failed）**：

- 本地校验失败、未登录、附件读取/上传失败、URL 安全校验失败；
- 服务端明确拒绝（HTTP 4xx，或结构化 `result.ok === false` 且非“已受理”语义）；
- 上述错误都发生在 prompt 调用之前或服务端明确未接受，任务确定没执行。

**结果未知（unknown）**：

- fetch 超时/AbortError；
- `Network request failed`、连接重置、DNS/连接失败等 fetch 阶段异常（RN 无法可靠区分请求是否到达服务端，按最保守处理）；
- HTTP 5xx、响应不是合法 JSON、没有 `result` 字段；
- App 在 `sending` 状态被杀死/进程退出。

> 关键取舍：**宁可多显示一次“结果未知”，也不把可能已执行的请求标成“失败”**。用同一 requestId 重试是安全的；错误地告诉用户“没发出去”才会诱发重复执行。

### 4.3 App 被杀、页面退出和重启后的恢复

- **页面退出**：`PendingSendStore` 是 App 级单例，不随 `ChatScreen` 卸载；`ChatScreen` 只订阅渲染。`Store.sendPending()` 的异步流程不依赖组件生命周期。
- **App 被杀**：按状态恢复，不做“一刀切”：
  - `sending` 被杀死 → 下次 `hydrate()` 标成 `unknown`，UI 显示“上次发送结果未知，可能已在电脑执行”，重试复用 requestId；
  - `queued`/`preparing`/`ready` 被杀死 → prompt 一定尚未发出，恢复为可继续状态（继续准备或直接发送），requestId 不变；若用户已不想发送则标 `abandoned`；
  - `accepted` 被杀死 → 保持 `accepted`，进入会话时按 `rpcId` 对账；对不上也不自动重发。
- **重启恢复**：`App.tsx` 启动时：
  1. `PendingSendStore.hydrate()`（读取 + 校验 + `prune()`）；
  2. 启动后若用户进入会话，`ChatScreen` 调用 `listBySession(sessionId)`，把未决记录渲染在历史消息末尾；
  3. `Store.openChat()` 的首帧快照和后续 `rebuild()` 调用 `reconcile(sessionId, records)`：如果某条 `user/message` 的 `rpcId` 命中 outbox 的 requestId，则直接标 `confirmed` 并删除记录（避免重启后重复展示）。
- **草稿恢复**：失败时仍保留现有把草稿放回输入框的行为；同时 outbox 气泡保留一份可重试副本，避免用户改字后丢失原意图。

### 4.4 同一请求重试复用 requestId

- **只有用户明确重试** `PendingSendStore.retry(requestId, currentBinding)` 才允许复用旧 ID；普通 `create()` 永远生成新 ID。
- 允许重试的状态：`queued`/`preparing`/`ready`/`unknown`/`failed`；重试进入 `preparing`，不是直接 `sending`，以便重新校验附件。
- `attemptCount` 每次重试 +1；requestId 永远不重新生成。
- UI 的“重试（安全）”按钮直接调用 `retry(record.requestId, currentBinding)`，不经过 `ChatScreen` 重算 id。
- 服务端去重由 `hasPromptRequest` 保证：同 id 重试返回 `{accepted:true}`，不会二次执行。

### 4.5 修改文字或附件时生成新的请求身份

**指纹定义**：

```text
normalizedText = text.trim().replace(/\r\n/g, '\n')
attachmentDigest = SHA-256(file bytes)  // 每个附件
fingerprint = SHA-256(JSON.stringify({
  text: normalizedText,
  mode,
  attachments: attachments.map(a => ({
    kind: a.kind, name: a.name, size: a.size, mime: a.mime, sha256: a.contentSha256
  }))
}))
```

**规则**：

- **正常发送永远新建记录、新 requestId**，不管是否存在相同文本/附件的旧记录。
- 指纹只用于：UI 提示“当前输入与某条未决记录内容相同/不同”，以及测试证明改内容会换身份。
- 用户明确重试时，校验当前输入指纹与记录指纹一致；不一致则拒绝复用并提示先修改/确认。
- 旧记录不因新发送被覆盖：`queued|preparing|ready` 可标 `abandoned`；`unknown|accepted` 保留为未决证据，UI 提示“上一条结果未知，新消息使用新请求 ID；服务端不会把两条合并”。
- 附件内容哈希使用 `react-native-blob-util` 的 `fs.hash(path, 'sha256')`（依赖已存在，`index.d.ts:364-373`）；文本/JSON 的 SHA-256 使用已确认的纯 JS 依赖 `@noble/hashes@2.4.0`（MIT，无原生代码）。
- 文件名/大小相同但内容不同的附件，会因 `contentSha256` 不同而生成不同指纹；`localUri` 不参与指纹（同一文件移动路径不应改变身份）。
- 文件读取/哈希失败时 fail closed：提示“无法确认附件内容，已阻止发送，请重新选择附件”。

### 4.6 敏感内容的保护、过期清理和退出登录清理

**保护**：

- 待发送记录（文本、附件本地路径/回执、错误信息）统一存入 `react-native-keychain`，service 为 `com.dshpocket.pendingSends.v1`；不写 AsyncStorage、不写日志、不写 Android 通知。
- **Android 实测结论**：`react-native-keychain@10.0.0` 使用 `CipherStorageKeystoreAesGcm`（Android Keystore AES-256/GCM）+ `DataStorePrefsStorage`；`accessible` 是 iOS/visionOS 参数，Android 不读取。实现显式要求 `storage: KeystoreAESGCM_NoAuth` 并校验 `setGenericPassword` 返回的 storage；实际验证见 `docs/v0.17/ANDROID-SECURE-STORAGE-VERIFY.md`。
- `android:allowBackup="false"` 已存在（`AndroidManifest.xml:27`）；这是系统级备份控制，不把它误当成 Keychain 的锁屏认证保证。
- UI 错误只显示固定安全文案；`lastError.message` 截断且不进入控制台。
- 存储文档有硬上限：最多 20 条未决记录、单条文本 32 KiB、单条附件 8 个、文档总计 256 KiB。超限直接拒绝创建并提示，不丢旧记录、不静默截断。
- **所有写入串行化**：`PendingSendStore` 内部单 Promise 队列；每次写前生成完整文档、写后回读必须与写入字节一致，成功后才替换内存状态。

**过期清理**：

- 未决记录默认 `expiresAt = createdAt + 7 天`。
- App 启动与每次写入前执行 `prune(now)`：
  - `confirmed`：立即删除；
  - `abandoned`：保留 1 小时供撤回提示后删除；
  - `accepted` 超过 24 小时仍未 confirmed：删除记录（服务端已受理，重发无意义）；
  - `queued/preparing/ready/unknown/failed` 超过 7 天：删除 payload，写非敏感墓碑（`requestId/sessionId/createdAt/state/expiredAt`）到 AsyncStorage，保留 30 天，UI 只能提示“某条未决消息已过期清理”，看不到内容。
- 墓碑不含文本、附件名、文件名、回执。

**退出登录清理**：

- `App.tsx` 的 `signOut()`（断开连接，保留凭据）**保留**待发送记录；只有 `clearAuthorization()`（彻底清除授权）调用 `PendingSendStore.clearAll()`。
- `clearAuthorization` 在清除前必须提示：本机有 N 条未确认/待发送记录，清除后无法再安全重试，请确认；用户确认后才执行。
- `clearAll()`：写空文档 → 回读校验为空；失败时返回 `{ok:false, error}`。
- `clearAuthorization` 的 `ClearAuthorizationResult.local` 增加 `pendingSends: 'cleared' | 'failed'`，与现有 `secureStorage`/`cookieJar` 一样如实展示，不把失败当成功。
- 清理后即使 Keychain 里有残留，下一次发送也不得复用旧记录；如果 `clearAll()` 失败，UI 明确提示“待发送缓存未清除”，并禁止发送直到恢复/再次清理。
- 记录本身带 `{baseUrl, gatewayId, authContextHash}` 绑定；即使记录未被清除，换服务端/换授权上下文后 `retry()` 也会被拒绝。

### 4.7 持久化写入失败时安全阻止发送

**原则**：发消息是“有副作用的远程执行”，不能以“先发出去再说”作为存储失败时的降级。

**实现**：

- `KeychainPendingSendPersistence.writeRaw()`：写 Keychain 后由 `PendingSendStore.save()` 立刻 `readRaw()`；**回读必须与写入字符串完全一致**，成功后才替换内存文档。以下任一情况抛错并保持旧内存状态：
  - `setGenericPassword` 抛错；
  - 回读为空/无法解析/与写入不一致；
  - Android 实际 storage 不是 `KeystoreAESGCM_NoAuth`；
  - 文档超出大小上限。
- 所有 `create/update/retry/clear/prune/recover` 都经过同一 Promise 队列，避免并发读改写丢更新。
- `Store.sendPending()` 一开始就 `await create()`；失败时：
  - 不调用 `uploadFileBinary`；
  - 不调用 `session/prompt`；
  - 恢复输入框草稿与附件选择；
  - 显示“无法安全保存待发送状态，已阻止发送（存储不可用）。请检查设备存储/锁屏状态后重试”。
- 若 `hydrate()` 读取失败或文档损坏：进入 `storageBlocked` 状态，禁止新发送与重试；提供“重试读取”和“清除待发送缓存”两个明确操作。损坏文档不会被静默覆盖。
- **不允许**：内存-only 继续发送、AsyncStorage 明文兜底、自动换新 requestId、静默丢弃记录。

### 4.8 与真实 DSH 服务端去重机制兼容

**已验证的契约**（见第 1.3 节）：

- `requestId` 是唯一键；服务端在入队前检查 `hasPromptRequest`；
- 检查范围覆盖 `inbox.nextTurn` / `inbox.nextStep`（排队）与 `session.snapshotEvents()` 的 `user/message.rpcId`（已执行）；
- 同一 requestId 的不同内容会被丢弃，因此客户端不能用同一 id 发送改过的内容。

**服务实例与授权上下文绑定**：

- 每条记录在创建时保存 `PendingSendBinding = {baseUrl, gatewayId, authContextHash, identityQuality}`。
- `gatewayId` 取 DSH 网关稳定实例标识；`authContextHash` 由服务端设备 UUID、客户端设备 id、凭据上下文派生，只存 hash。
- `PendingSendStore.retry()` 重试前调用 `evaluatePendingSendBinding()`：地址、`gatewayId`、`authContextHash` 必须全部匹配；任一缺失（尤其 `gatewayId=null`）都按 `server-identity-unverifiable` 拒绝，**绝不跨服务端重试**。

**客户端对齐点**：

| DSH 行为 | 客户端约束 |
|---|---|
| 同 requestId 重复提交返回 `accepted:true` 且不重复入队 | 重试永远复用 requestId，不生成新 id |
| 同 requestId、不同内容会被丢弃 | 内容/附件变化必须新 id |
| 去重按 session/agent 作用域 | requestId 仍然全局唯一生成，避免跨会话误用 |
| 返回 `accepted` 只代表入队 | 不把 accepted 当“会话已确认”，用 `rpcId` 事件做 confirmed |
| 旧版本可能没有该字段/行为 | 启动时做协议能力探测（`protocol-compat` 已有基础）；若目标 DSH 不支持 requestId 去重，明确提示“当前 DSH 版本不支持安全重试”，不静默降级 |

**兼容性验证**：

- 保留现有 `send-idempotency-spec.mjs` 12 项测试。
- 新增 `tests/e2e-pending-send.mjs`（手工/本地真实 DSH，CI 不跑）：
  1. `DSH_HOST`/`DSH_PORT`/`DSH_TOKEN` 登录；
  2. 同一 requestId 发送两次相同内容 → 服务端 `session/page` 只有一条 `user/message`；
  3. 同一 requestId 发送不同内容 → 第二次被丢弃；
  4. 新 requestId 发送改后内容 → 被接受且出现；
  5. 断言 `rpcId` 与消息 `source.rpcId` 一致。
- 目标 DSH 基线：`0.2.1-rc.2`（本机 `app.asar` 实测版本）。

### 4.9 故障注入与针对性自动化验收

#### 4.9.1 扩展 `tests/support/fake-dsh.mjs`

在现有 fake DSH 上增加：

| 能力 | 用途 |
|---|---|
| `handlers['session/prompt']` 默认实现，按 `sessionId + requestId` 去重，记录 `promptLog` | 模拟真实 `hasPromptRequest` |
| `promptLog()` → `{requestId, text, contentHash, attempt, accepted, deduped}` | 断言服务端收到几次、是否去重 |
| `dropResponseFor('session/prompt', n)`：执行 handler 后销毁 socket、不返回响应 | 模拟“服务端已接受但回执丢失” |
| `delayResponseFor('session/prompt', ms)` | 触发客户端 AbortError/超时 |
| `failNext('session/prompt', {status:500})` / `{status:400}` | 区分未知与明确失败 |
| `disconnectAfterAccept()`：接受后断开 mux WS | 模拟回执与事件同时丢失 |
| `promptMessageCount(sessionId)`：统计已落库的 user/message | 断言只执行一次 |

#### 4.9.2 新增测试文件

| 文件 | 覆盖 |
|---|---|
| `tests/pending-send-state-spec.mjs` | 状态机所有合法/非法迁移、`accepted` vs `confirmed` |
| `tests/pending-send-store-spec.mjs` | 创建/读取/更新/删除/回读校验/损坏文档/容量上限/过期/退出清理 |
| `tests/pending-send-identity-spec.mjs` | 指纹对文本/附件内容/顺序/模式敏感；连续两次同文同附件仍生成不同指纹但**不自动复用 ID**（由 store 测试断言） |
| `tests/pending-send-recovery-spec.mjs` | 模拟进程重启：`sending→unknown`、`queued/ready` 可继续、`accepted` 遇历史消息转 confirmed、页面卸载恢复 |
| `tests/pending-send-fault-spec.mjs` | Keychain 写失败/回读不一致/读失败/上传失败/超时/接受后丢回执/5xx/400 |
| `tests/pending-send-integration-spec.mjs` | 真实 `Store.sendPending()` + fake DSH，验证完整调用链 |

#### 4.9.3 必测场景清单（验收口径）

| # | 场景 | 期望 |
|---|---|---|
| 1 | Keychain 第一次写入失败 | 无 upload/prompt；草稿恢复；显示“已阻止发送” |
| 2 | 写入成功但回读与写入不一致 | 同上；旧记录不被覆盖 |
| 3 | 发送前杀进程（`sending`） | 重启显示“结果未知”；**不自动重发**；用户点重试才同 requestId |
| 4 | 服务端接受后丢 HTTP 回执 | 状态 `unknown`；**用户点重试**同 id；fake DSH `promptLog` 显示第二次 dedupe、`promptMessageCount=1` |
| 5 | prompt 超时 | 状态 `unknown`；重试同 id；不重复执行 |
| 6 | prompt 返回 400 明确拒绝 | 状态 `failed`；重试同 id |
| 7 | prompt 返回 500 | 状态 `unknown`（按可能已执行处理） |
| 8 | 上传附件阶段失败 | 状态 `failed`（prompt 未发）；重试同 id，不重复上传已成功附件 |
| 9 | 成功 → 会话出现 `user/message.rpcId` | 状态 `confirmed`，记录删除 |
| 10 | 成功但 24h 无事件 | 保留 `accepted`，不自动重发；24h 后清理 |
| 11 | 改文字后发送 | 新 requestId；旧 `queued` 记录 `abandoned`；旧 `unknown` 记录保留提示 |
| 12 | 改附件内容但同名同大小 | 指纹变化 → 新 id |
| 13 | App 重启后历史里已有原消息 | 不重复显示 outbox；记录自动 confirmed/清理 |
| 14 | 退出登录/清除授权 | Keychain 中 outbox 清空且回读为空；墓碑清空 |
| 15 | 文档损坏/不可读 | 禁止发送；提供“重试读取/清除缓存”；不静默覆盖 |
| 16 | 20 条/256 KiB 上限 | 拒绝新建，旧记录保留，提示明确 |

---

## 5. 分阶段实施计划

> 每个阶段单独提交/PR 到 `feat/v0.17`；每阶段结束必须通过 `npm test` 与 `npm run typecheck`，不直接碰 `main`。

### 阶段 0：契约与纯函数（0.5–1 天）✅ 已实施

- 新增 `pendingSend/types.ts`、`ids.ts`、`fingerprint.ts`、`state.ts` 的接口与纯函数。
- 固化状态迁移表、指纹定义、错误分类枚举、requestId 生成规则。
- 新增 `pending-send-state-spec.mjs`（10 项）、`pending-send-identity-spec.mjs`（11 项）。
- **退出标准**：状态机/指纹测试全部通过；不接 UI、不发网络。

### 阶段 1：安全持久化层（1–1.5 天）✅ 已实施，待 Android 实测验收

- 实现 `KeychainPendingSendPersistence`：Keychain 单文档 `com.dshpocket.pendingSends.v1`、Android `KeystoreAESGCM_NoAuth` 校验、写后回读、大小上限、损坏隔离。
- 实现 `PendingSendStore`：`hydrate/list/create/get/apply/retry/clearAll/prune/recoverAfterRestart/stats`，全部写操作串行化。
- 新增 `pending-send-store-spec.mjs`（13 项）、`pending-send-persistence-spec.mjs`（6 项）、`pending-send-storage-perf.mjs`。
- 新增 Android 仪器测试 `androidTest/.../KeychainStorageValidationTest.kt`（加密、KeyInfo、DataStore、备份、240 KiB/20 次重写）。
- **退出标准**：不改 UI 也能证明“发送前可持久化、失败可阻断、并发不丢更新”；Android 实测报告见 `docs/v0.17/ANDROID-SECURE-STORAGE-VERIFY.md`。

### 阶段 2：发送编排与恢复（1.5–2 天）

- `Store.sendPending()`：串联 `create → preparing → ready → sending → accepted/unknown/failed`；发送前 `sending` 必须落盘。
- `Store.openChat/rebuild` 调用 `reconcile`，按 `rpcId` 转 `confirmed`。
- `ChatScreen` 移除 `retryReq`；新增 `PendingSendBubble`（待发送/发送中/结果未知/失败/已受理/已过期），重试按钮调用 `pendingStore.retry(id)`。
- `App.tsx` 启动 `hydrate + prune`；页面卸载不影响 outbox。
- 新增 `pending-send-recovery-spec.mjs`、`pending-send-integration-spec.mjs`。
- **退出标准**：文本-only 发送在“杀进程/返回再进/重启”后仍可见、可重试、同 id；无重复用户消息。

### 阶段 3：附件身份与重试（1 天）

- `resolveDrafts` 迁入发送编排；文件 SHA-256、图片哈希、回执保存与复用。
- 指纹接入附件；附件-only、改附件、同名同大小换内容测试。
- 上传失败分类：prompt 前失败 = `failed`；已上传回执可复用。
- **退出标准**：附件场景与文本场景同等恢复；附件改变必换新 id。

### 阶段 4：清理策略与产品化（0.5–1 天）

- 7 天 TTL、24h accepted 清理、1h abandoned 清理、30 天墓碑。
- `clearAuthorization` 接入 `clearAll()` 并纳入清理结果（`signOut` 保留记录）。
- UI 文案、设置页说明、无网络/存储不可用状态。
- **退出标准**：退出登录后 Keychain/墓碑均无残留；过期记录不可见内容；存储失败阻断提示可操作。

### 阶段 5：故障注入与真实 DSH 验收（1–1.5 天）

- 扩展 fake DSH 的 prompt 去重、丢回执、延迟、5xx/400 注入。
- 完成 `pending-send-fault-spec.mjs` 与全部 16 项场景。
- 真实 DSH `0.2.1-rc.2` 手工 e2e；模拟器做“飞行模式→杀 App→恢复→重试”与“杀 App 后重进”。
- 输出 `docs/v0.17/P0-1-ACCEPTANCE.md`（测试记录、APK/commit、失败项）。
- **退出标准**：第 7 节全部验收标准通过，才允许合并到 v0.17 发布分支。

### 总工作量

| 阶段 | 估计 |
|---|---|
| 0 契约/纯函数 | 0.5–1 天 |
| 1 安全持久化 | 1–1.5 天 |
| 2 发送编排/恢复 | 1.5–2 天 |
| 3 附件身份 | 1 天 |
| 4 清理/产品化 | 0.5–1 天 |
| 5 故障注入/验收 | 1–1.5 天 |
| **合计** | **5.5–8 人日** |

> 文本-only 的最小闭环可在阶段 2 结束（约 3–4.5 天）先做模拟器验证；但含附件的完整 P0-1 必须完成阶段 3–5 才能宣称可发布。
>
> 相比研究报告里“3–4 天”的粗估，本计划多出的时间主要用于：Keychain 安全存储与写后回读、附件内容哈希、16 项故障注入与真实 DSH 手工 e2e。若只求文本-only 的临时版本，可按阶段 0–2 压缩到约 3 天，但不能满足本方案的完整验收标准。

---

## 6. 关键实现约束与回滚

### 6.1 不变量检查（实现时写成测试）

- `create()` 返回之前，`prompt` 调用次数必须为 0。
- `sending` 的 `updatedAt` 必须早于 `prompt` 的请求时间。
- 同一 `requestId` 的 `attemptCount` 可增长，但 `requestId` 不可变。
- 同一记录一旦 `confirmed`，不得再次进入 `sending`。
- 任何 `failed/unknown` 重试不得创建新 requestId。
- 任何指纹变化不得复用旧 requestId。

### 6.2 回滚策略

- 每个阶段是独立提交；P0-1 全量回滚 = revert 阶段 2–5 的合并提交，保留阶段 1 的只读存储不影响旧路径。
- 不做数据迁移：旧版本没有 `dsh.pendingSends.v1`，忽略即可；新版本遇到 legacy/损坏文档按“损坏隔离”，不自动删除用户数据。
- **不提供“存储失败时退回内存发送”的运行时开关**；如果 P0-1 出现问题，只能回滚版本，不能在生产里静默降级。

### 6.3 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| Keychain 存较大 JSON 的性能/容量 | 中 | 单文档限 256 KiB/20 条；超限拒绝；阶段 1 在目标 ROM 实测 |
| 附件哈希耗时 | 中 | 只对发送中的附件哈希；显示“准备附件”；大文件上限 50 MB |
| 状态与真实会话事件不一致 | 中 | `rpcId` 作为唯一确认键；`accepted` 不自动重发；24h 保守清理 |
| App 被杀在 `sending` 边界 | 中 | `sending` 先落盘；恢复统一转 `unknown`；重试同 id |
| 用户改内容后旧 `unknown` 记录混淆 | 中 | UI 分开展示“旧：结果未知/新：新请求”；旧记录不覆盖 |
| DSH 版本差异导致去重失效 | 中 | 协议能力探测 + 真实 e2e；不支持时明确提示，不静默 |

---

## 7. 验收标准（P0-1 完成定义）

### 7.1 功能验收

1. **发送前持久化**：任何发送路径（文本/图片/文件/混合）在第一个 `uploadFileBinary` 或 `session/prompt` 之前，均已完成 `requestId` 与发送意图的 Keychain 写入 + 回读校验。
2. **状态正确**：UI 能区分并展示 `待发送 / 发送中 / 结果未知 / 未发出 / 已受理 / 已确认`；`accepted` 不显示成“发送失败”。
3. **杀进程恢复**：在 `queued/preparing/ready/sending/accepted` 各阶段杀 App，重启后记录可见且状态合理；`sending` 转 `unknown`，不丢记录。
4. **页面退出恢复**：发送中返回上一页/切 tab 再进，记录仍在；不依赖组件内存。
5. **重试幂等**：同内容重试 100 次，服务端 `promptMessageCount` 始终为 1；`promptLog` 显示同一 requestId。
6. **内容变更换 id**：改文字/改附件（含同名同大小不同内容）后生成新 requestId；旧 `unknown` 记录不被覆盖。
7. **成功确认**：`accepted` 后在会话事件中看到同一 `rpcId` 的 `user/message`，记录转 `confirmed` 并清理；历史加载不会重复显示。
8. **存储失败阻断**：Keychain 写失败/回读不一致/文档损坏时 `session/prompt` 与 `uploadFileBinary` 均零调用；UI 有明确阻断提示；恢复存储后可重试。
9. **安全存储**：AsyncStorage dump 中不含消息文本、附件名、附件路径、回执；Keychain 文档为唯一 payload 存储；日志不打印内容。
10. **过期与退出清理**：7 天未决记录 payload 清除、仅留非敏感墓碑；`clearAuthorization` 前有未确认任务提示，清除后读取 outbox 为空、墓碑为空，清理失败可见；`signOut` 不清除记录。

### 7.2 兼容性验收

- 真实 DSH `0.2.1-rc.2`：
  - 同 requestId 两次 → `accepted:true` 两次，服务端只有一条 `user/message`；
  - 同 requestId 不同内容 → 第二次不产生消息；
  - 新 requestId 改后内容 → 正常接受并出现。
- 现有 `send-idempotency-spec` 12 项、`send-retry-spec` 9 项继续全绿。
- `npm test`、`npm run typecheck`、`test:integration` 全绿；Node 20 CI 语义（`--no-experimental-websocket`）通过。

### 7.3 故障注入验收

第 4.9.3 节 16 项场景全部 PASS；其中 1、2、3、4、5、7、9、14 为**发布阻断项**，任一失败不得合并。

### 7.4 真机/模拟器验收

- 模拟器 `dsh_release`（Android 15/API 35/x86_64）：
  - 正常发送 + 完整回复；
  - 飞行模式发送失败 → 恢复 → 重试：1 条消息、同一 rpcId；
  - 杀 App（`adb shell am force-stop`）在发送中/发送后：重进恢复 outbox；
  - 页面返回/切换 tab 后恢复；
  - 零崩溃/零 ANR。
- 真机至少补测：扫码配对后的真实网络抖动、锁屏/解锁后的 Keychain 读取、真实网络切换（Wi‑Fi ↔ 移动数据）。
- 验收报告：`docs/v0.17/P0-1-ACCEPTANCE.md`，记录 APK SHA-256、commit、每项 PASS/FAIL 与证据。

---

## 8. 评审确认结果（编码前决策已解决）

1. **存储形态**：已确认“Keychain 单文档 + 256 KiB 上限 + 最多 20 条”；阶段 1 增加了容量、读写性能、并发写入和重启恢复测试。若后续需要更多记录，再评估“Keychain 索引 + 分片 payload”。
2. **文本哈希依赖**：已确认新增 `@noble/hashes@2.4.0`（MIT，`package-lock.json` 锁定）；附件哈希继续用 `react-native-blob-util.fs.hash`。
3. **退出登录语义**：已确认 `signOut`（断开连接、保留凭据）**保留**待发送记录；只有 `clearAuthorization` 清除，且清除前必须提示未确认任务。

---

## 9. 明确不做

- 不改 DSH 服务端、不新增服务端表、不引入 Cindy relay/云端。
- 不复制 Cindy 的 `durableOutbox` 代码；只按本方案在 Outpost 现有架构内重写。
- 不做多设备 outbox、跨账号同步、后台无感重发。
- 不在本阶段做 P0-2 WebSocket 自动重连、P0-3 Cookie/Jar 校验、P1 审批中心/草稿持久化。
- 不创建新的 GitHub Release，不在 `main` 上直接实现。

---

*方案版本：2026-10-28 · 待评审 · 基线 `3349bbf` / 分支 `feat/v0.17`*
