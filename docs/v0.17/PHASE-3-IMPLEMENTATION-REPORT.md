# P0-1 阶段 3 实施报告：附件持久化、安全重试与阶段 2 验收关闭

| 项 | 值 |
|---|---|
| 分支 | `feat/v0.17` |
| 阶段 2 实现提交 | `262b686` |
| 阶段 3 实现提交 | `1daeb76`（附件持久化、安全重试与阶段 2 验收关闭） |
| 基线 | `main` / `origin/main` = `06a33e1`；`v0.16.7` Tag 未移动 |
| 范围 | 阶段 2 剩余验收项 + 阶段 3 图片/文件/混合附件持久化与安全重试 |
| 正式发布 | 未合并 `main`、未创建 GitHub Release |

---

## 1. 阶段 2 剩余验收项

### 1.1 真实 DSH 服务验证（非 mock）

使用本机真实 DSH 服务 `http://172.27.58.79:3095`，从 `pairing.json` 取一次性 token（命令中未打印 token），完成：

- `GET /mgw/status`：HTTP 200，返回真实 `gatewayId = 99921c7e-74b7-4845-91ec-8d600675b55f`（与持久化 gateway state 文件一致）。
- 真实 `session/create` 创建临时会话，`session/prompt` 正常发送：`{"accepted":true}`。
- **accepted 但客户端丢失回执**：发送后由客户端主动丢弃响应；服务端已执行。同 requestId 重试返回 `{"accepted":true}`。
- **相同 requestId 不同内容**：服务端返回 accepted（去重语义），但会话事件中只有首条 `user/message`，不同内容被丢弃。
- 查询真实 `session/page`：正常 requestId 用户消息 1 条；回执丢失 requestId 用户消息 1 条；无第二条重复消息。

证据摘要见 [PHASE-3-REAL-DSH-EVIDENCE.md](PHASE-3-REAL-DSH-EVIDENCE.md)。使用的临时会话只存在于测试环境，不修改用户已有会话。

### 1.2 真实 ChatScreen UI

通过真实 DSH 配对后，在模拟器 `dsh_verify` 打开真实 ChatScreen；通过调试 UI fixture 向 `PendingSendStore` 写入两条可验证记录（unknown + accepted），确认：

- 待发送气泡展示文本与附件名；
- `结果未知，可能已在电脑执行` 状态；
- `重试（安全）` 按钮；
- `已受理，等待会话确认` 状态；
- 清除授权 ConfirmSheet 明确写出「尚未确认的待发送消息及其私有暂存附件」。

截图：

- [PHASE-3-CHATSCREEN-PENDING.png](PHASE-3-CHATSCREEN-PENDING.png)
- [PHASE-3-CLEAR-AUTH-CONFIRM.png](PHASE-3-CLEAR-AUTH-CONFIRM.png)

**诚实说明**：ChatScreen 是真实组件、真实 DSH 配对、真实会话列表；气泡中的两条记录由调试 fixture 注入（不是真实 prompt 产生的待发送记录）。真实 DSH 网络发送由 1.1 的独立探针验证。

### 1.3 `loadPendingSendBinding` 远端身份验证修复

审查确认原实现只读取 Keychain 本地缓存 `gatewayServerBinding`，不访问远端。

已做最小安全修复：

1. `loadPendingSendBinding(baseUrl, { cookie, requireRemote })`：
   - 默认 `requireRemote=true`；
   - 必须有当前登录 cookie；
   - 调用已认证的 `GET /mgw/status`，用实时返回的 `gatewayId` 与本机绑定比对；
   - 缺 cookie / 无远端响应 / gatewayId 不一致分别返回 `auth-context-missing` / `remote-identity-unavailable` / `remote-instance-mismatch`。
2. `verifyPendingSendBinding()`：retry 前同时验证本地地址、gatewayId、`authContextHash` 和**已认证远端 gatewayId**；失败不改变记录状态。
3. 新建发送：本地绑定用于创建/持久化记录；在 prompt 前再做已认证远端验证；验证失败记录转 `failed`，不调用 prompt。
4. 生产环境调用使用真实 `fetchServerGatewayId`（带 Cookie、Origin、Referer）；测试使用可注入 verifier，不把本地旧值冒充实时验证。

实际验证：

- 真实 DSH 上调用生产 `fetchServerGatewayId(baseUrl, cookie)`，返回 `99921c7e-74b7-4845-91ec-8d600675b55f` → PASS。
- 单元测试 `pending-send-service-binding-spec`：10/10 通过，覆盖远端 mismatch、缺 cookie、远端不可用、地址变化、gateway 变化、授权上下文变化。

### 1.4 accepted / confirmed 乱序

- `confirm` 事件现在允许从 `accepted`、`sending`、`unknown` 进入 `confirmed`；`accept` 从 `confirmed` 是幂等 no-op，不会把状态回退。
- `reconcilePendingNow()` 对 `accepted/sending/unknown` 中命中 `user/message.source.rpcId` 的记录执行 confirm。
- 新增测试：confirmed 先于 accepted 到达时保持 confirmed，迟到的 accept 不倒退；测试 9/9。

### 1.5 阶段 2 遗留项记录

- 真实 DSH 文本发送/重试：已完成（1.1）。
- ChatScreen UI：已完成（截图；fixture 限制见 1.2）。
- 远端身份验证：已实现并真实 DSH 验证（1.3）。
- accepted/confirmed 乱序：已测试（1.4）。
- 仍存在的限制：阶段 4 已补齐真实 DSH 附件上传 e2e（见阶段 4 报告 1.1）；真实 ChatScreen accepted/confirmed 用户操作仍未完成（阶段 4 报告 1.2）。

---

## 2. 阶段 3 实现

### 2.1 附件类型与私有暂存

| 文件 | 内容 |
|---|---|
| `dsh-mobile/src/core/pendingSend/types.ts` | `AttachmentDraft`；`PendingAttachment` 增加 `stagedUri`；Keychain 只存元数据/引用，不存文件字节 |
| `dsh-mobile/src/core/pendingSend/staging.ts` | `ReactNativePendingSendStaging`：复制到 `DocumentDir/dsh-pending-send`；真实字节 SHA-256；单文件 50MiB、总暂存 256MiB 上限；`verify()`、`removeAttachments()`、`clearAll()`、`cleanupOrphans()` |
| `dsh-mobile/src/core/pendingSend/store.ts` | `stageDrafts()`、`discardStaged()`、`verifyAttachments()`、`updateAttachments()`；`create()` 校验 `stagedUri`/SHA-256；prune/clear 清理暂存文件；启动时清理孤儿 |
| `dsh-mobile/src/core/store.ts` | `sendPending(sessionId, text, attachmentDrafts)`；附件先暂存→持久化→上传→prompt；上传回执逐条写回；single-flight/身份验证/accepted 对账保留 |
| `dsh-mobile/src/screens/ChatScreen.tsx` | 文本/图片/文件/混合统一走 `store.sendPending`；删除旧 `resolveDrafts`/`retryReq` 本地重试路径 |
| `dsh-mobile/src/components/PendingSendBubble.tsx` | 展示附件名、状态、重试按钮 |
| `dsh-mobile/src/App.tsx` | `PendingSendStore` 注入真实 `ReactNativePendingSendStaging`；清除授权同时清 Keychain + 暂存目录 |

### 2.2 发送状态机

```text
queued
  → preparing（复制/校验暂存文件，逐文件上传；每条回执立即持久化）
  → ready（全部附件就绪，尚未 prompt）
  → sending（先持久化并回读，再 prompt）
  → accepted（prompt accepted:true，等待服务端真实 rpcId）
  → confirmed（收到 user/message.source.rpcId）
```

失败分支：

- 上传失败 / 暂存文件失效 / 身份验证失败：`failed`（确定未 prompt），保留记录与已成功回执；
- prompt 失败且结果不确定：`unknown`，不自动重发；
- accepted 状态写失败：保留 requestId，记录停在 sending，重启恢复时转 unknown，可安全重试；
- 重启时 `sending→unknown`，`preparing→failed`；`queued/ready` 保持等待用户显式操作；**绝不自动重发**。

### 2.3 附件身份与回执复用

- SHA-256 由暂存副本真实字节计算，不使用文件名的简单摘要。
- 重试顺序：校验 `stagedUri` 存在、大小一致、SHA-256 一致 → 才复用 `receiptId`；
- 内容/大小/文件是否存在任一变化 → 拒绝，不静默复用旧 requestId；
- 正常新发送 `PendingSendStore.create` 永远生成新 ID；只有 `retryPending` 复用旧 ID；
- 上传回执按附件逐条保存；上传中断后，已成功的回执保留，重试只补失败附件；
- 临时 URI 失效后仍使用私有暂存副本（Android harness 已验证）。

### 2.4 清理与授权

- 暂存目录为应用私有 `DocumentDir/dsh-pending-send`，Android `allowBackup=false`。
- 记录确认/过期/prune 时删除对应暂存文件；启动 `cleanupOrphans` 清理崩溃残留。
- `clearAuthorization` → `pendingSends.clearAll()`：清 Keychain 记录 + 暂存目录；失败会在结果中显示「待发送记录或附件暂存目录没能确认清除」。
- `signOut`（断开连接）保留记录，不清理；符合阶段 2 语义。

---

## 3. 测试证据

### 3.1 Node 测试

| 命令 | 结果 |
|---|---|
| `npm run test:pendingSendAttachments` | **15/15 通过**（纯图片、纯文件、混合、同文件名同大小不同内容、上传失败/中断、单回执复用、preparing 重启、原 URI 失效、文件删除、内容变化、Keychain 写失败、暂存失败、clearAll） |
| `npm run test:pendingSendServiceBinding` | **10/10 通过**（含远端身份不匹配/不可用/缺 cookie） |
| `npm run test:pendingSendFlow` | **9/9 通过**（含 accepted/confirmed 乱序） |
| `npm run test:pendingSendWiring` | 4/4 通过 |
| `npm run test:pendingSendStore` / `State` / `Persistence` / `Perf` | 阶段 1 既有测试全部通过 |
| `npm run test:idem` / `test:retry` | 12/12、9/9 |
| `npm run test:mgwPatch` | 24/24（独立 fixture，不修改真实插件） |

### 3.2 Android 真实暂存/Keychain harness

模拟器 `dsh_verify`（Android 15 / API 35 / x86_64），debug-only `P0HarnessActivity` + 真实 `react-native-keychain` + 真实 `ReactNativePendingSendStaging`：

```text
P0HARNESS PASS service-binding-cookie-rotation
P0HARNESS PASS attachment-pure-image
P0HARNESS PASS attachment-pure-file-and-mixed
P0HARNESS PASS attachment-same-name-size-different-content
P0HARNESS PASS attachment-source-uri-gone-staged-survives
P0HARNESS PASS first-persist
P0HARNESS PASS same-text-new-id
P0HARNESS PASS retry-same-id
P0HARNESS PASS accepted-response-lost-dedupe
P0HARNESS PASS page-exit-reenter
P0HARNESS PASS keychain-capacity-perf count=20 bytes=173935 totalMs=4368
P0HARNESS PASS injected-write-readback-failure-blocked
P0HARNESS PASS force-stop-restart-recovery
```

- 20×8KiB：实际 Keychain 写入 4.4s 量级；文档 173,935 bytes；另一次 4.5s 量级，作为设备实测记录。
- force-stop：`adb shell am force-stop com.dshpocket` 后重启，sending → unknown，显式 retry 同 ID。
- 写/回读失败是 JS 存储边界注入；原生 Keychain 成功路径是真实路径。

### 3.3 真实 DSH 验证

见 [PHASE-3-REAL-DSH-EVIDENCE.md](PHASE-3-REAL-DSH-EVIDENCE.md)：正常 accepted、模拟回执丢失重试、同 requestId 不同内容去重，均通过真实 `session/prompt` / `session/page`。

### 3.4 完整回归

- **`npm test`：PASS（exit 0）**。最终工作树包含 `test:pendingSendAttachments`、阶段 1/2 全部测试、`test:mgwPatch` 与 `typecheck`。
- **`npm run test:integration`：61/61 通过**：
  - `integration-transport.mjs`：15/15
  - `integration-gateway.mjs`：14/14
  - `integration-long-session.mjs`：10/10
  - `integration-product.mjs`：16/16
  - `integration-gateway-reconnect.mjs`：6/6
- 未发现 P0-1 相关失败。

---

## 4. 剩余风险与未完成项

1. ~~**真实 DSH 附件上传 e2e 未做**~~：阶段 4 已补齐真实 `uploadFileBinary → prompt → page`（图片/文件/混合、回执丢失、非法 receipt、上传中断、prompt 明确失败）。
2. **ChatScreen UI fixture 不是真实发送产生的待发送记录**：阶段 4 已补实际用户操作触发 failed 状态（见 `PHASE-4-ACTUAL-CHATSCREEN-FAILED.png`）；accepted/confirmed 仍未完成。
3. **Android 原生 Keychain 故障注入**：写失败/回读失败在 JS 持久化边界注入；未强行制造 Keystore 原生错误。原生成功路径已实测。
4. **附件上传回执的服务端有效性**：复用条件是本地暂存 SHA-256 + 保存的 receipt；没有做服务端 receipt 有效性查询（服务端没有单独查询接口）；若服务端已清理 receipt，当前行为是 prompt 收到 attachment 错误后标记失败，不自动重发。
5. **附件暂存上限**：单文件 50MiB / 总 256MiB，目录位于 DocumentDir；未来可在设置中调整。
6. **真实 DSH 测试会话**：验证过程中创建了临时会话；不影响现有用户会话，但会话记录会保留，属于测试痕迹。

---

## 5. 是否可以进入阶段 4

**有条件通过，可以进入阶段 4**：阶段 3 的附件持久化、字节级 SHA-256、私有暂存、回执复用、上传失败/中断/prompt 失败/回执丢失分流、重启不自动重发、授权清除清理均已通过 Node 与 Android 模拟器真实接线测试；阶段 2 的真实 DSH 文本发送/重试/去重和远端身份验证已关闭。

进入阶段 4 前必须补：
1. 真实 DSH `uploadFileBinary` 的图片/文件/混合 e2e（真实网络，不接受 mock 冒充）；
2. 真实 ChatScreen 中由用户实际操作产生的 accepted/confirmed 状态截图验收；failed 状态已由阶段 4 补测。
3. 服务端 receipt 失效时的错误码识别与可控重传验证。

---

*报告生成：2026-10-28 · 阶段 3 · 实现提交 `1daeb76`*
