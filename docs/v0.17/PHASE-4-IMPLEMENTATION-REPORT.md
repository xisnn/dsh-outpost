# P0-1 阶段 4 实施报告：保活、过期清理与验收补齐

| 项 | 值 |
|---|---|
| 分支 | `feat/v0.17` |
| 阶段 3 实现提交 | `1daeb76` |
| 阶段 4 实现提交 | `e48b68a`（阶段 4 清理/过期语义与阶段 3 真实验收补记） |
| 基线 | `main` / `origin/main` = `06a33e1`；`v0.16.7` Tag 未移动 |
| 范围 | 阶段 3 真实验收补齐 + 阶段 4 有效期/清理/断开/清除授权/重启语义 |
| 正式发布 | 未合并 `main`、未创建 GitHub Release |

---

## 1. 阶段 3 验收补齐

### 1.1 真实 DSH 附件完整链路

使用真实 DSH `http://172.27.58.79:3095`、独立临时 cwd 会话，真实
`uploadFileBinary → session/prompt → session/page`：

```text
IMAGE_PROMPT={"accepted":true} USER_MESSAGES=1 SESSION=session-4d9f1a07-d318-4692-80c8-8b23ad153397
FILE_PROMPT={"accepted":true} UPLOAD_RECEIPT=true USER_MESSAGES=1 SESSION=session-d6936be6-eb2b-494b-9491-132d28cc5c7f
MIXED_PROMPT={"accepted":true} USER_MESSAGES=1 SESSION=session-6853bc67-9ed5-433c-8bb6-32db9b6f210a
ATTACH_LOSS_FIRST=simulated prompt response lost RETRY={"accepted":true} USER_MESSAGES=1 SESSION=session-299d7df5-cc86-47de-8784-a032e3c224c4
INVALID_RECEIPT_ERROR=prompt: {"code":"session/attachment-invalid","message":"File was not uploaded for this session.","details":{"reason":"FILE_NOT_STAGED"}} USER_MESSAGES=0 SESSION=session-eb9f280e-9b67-4c1b-9ecb-f402847fff8c
UPLOAD_ABORT_ERROR=simulated upload interruption: This operation was aborted RETRY_RECEIPT=true USER_MESSAGES=0 SESSION=session-3f4b7f22-0c71-48aa-8507-d4209e55e4e9
DEFINITE_FAIL_FIRST=prompt: {"code":"session/attachment-invalid","message":"Image upload is not canonical base64.","details":{"reason":"INVALID_IMAGE_BASE64"}} RETRY={"accepted":true} USER_MESSAGES=1 SESSION=session-80860fb7-934c-447f-803d-1fbf85db004e
REAL_DSH_ATTACHMENTS=PASS
```

结论：

- 图片、文件、混合均完成真实上传、prompt 和事件对账，各产生恰好 1 条 `user/message`。
- 上传成功但 prompt 回执丢失后，同 requestId 重试仍只有 1 条任务。
- 无效 receipt 明确返回 `session/attachment-invalid` / `FILE_NOT_STAGED`，没有产生任务。
- 上传中断后重新上传成功，没有产生 prompt 任务。
- 上传成功但 prompt 因非法图片 base64 明确失败后，同 requestId 修正重试成功，仍只有 1 条任务。

完整证据见 [PHASE-3-REAL-DSH-EVIDENCE.md](PHASE-3-REAL-DSH-EVIDENCE.md)。

### 1.2 真实 ChatScreen 用户操作

在本机模拟器、真实 DSH 配对和真实 ChatScreen 中输入并点击发送
`P0-1 real ChatScreen UI send probe`。实际结果：

- 待发送记录创建后，远端身份验证失败（`remote-identity-unavailable`）；
- ChatScreen 展示红色错误提示和「未发出」气泡；
- 气泡提供「安全重试（复用原 ID）」按钮；
- 这是实际用户操作产生的失败状态，不是 fixture。

截图：[PHASE-4-ACTUAL-CHATSCREEN-FAILED.png](PHASE-4-ACTUAL-CHATSCREEN-FAILED.png)。

同时保留了 fixture 注入的 `unknown / accepted` 视觉截图
[PHASE-3-CHATSCREEN-PENDING.png](PHASE-3-CHATSCREEN-PENDING.png)，但**不把它冒充为真实 prompt 的 accepted/confirmed 端到端结果**。

### 1.3 服务端附件回执失效与安全边界

- 真实 DSH 对无效 receipt 的返回是 **明确错误** `session/attachment-invalid` / `FILE_NOT_STAGED`，不是 accepted；
- 代码不会在 prompt 结果未知时自动替换 receipt 重试；
- `classifyPromptFailure` 将网络失败/超时归为 unknown，将结构化 RPC 拒绝（含 `attachment-invalid`）归为 definite；
- 单元测试覆盖：无效 receipt 明确失败、上传成功但 prompt 失败后保留回执、prompt 已 accepted 但回执丢失、上传中断后恢复。

### 1.4 阶段 3 尚未完全关闭的项

- **真实 ChatScreen 的 accepted/confirmed 用户操作截图未完成**：当前模拟器上实际发送被远端身份验证安全阻断（已如实截取 failed 状态）；没有用 fixture 冒充。
- **真实 DSH 附件上传已在脚本层完成**；但尚未通过 App ChatScreen 的附件选择器完成同一链路。

---

## 2. 阶段 4 实现

### 2.1 未决任务有效期与过期提示

- `DEFAULT_PENDING_SEND_TTL_MS` 仍为 7 天；新增 `DEFAULT_EXPIRED_TTL_MS = 1h`。
- `PendingSendStore.prune()` 对到期未决记录执行 `expire`：
  - 记录变为 `expired` 并保留 1h 供 UI 显示；
  - 立即清理该记录的暂存附件；
  - 1h 后真正删除记录。
- `PendingSendBubble` 显示 `已过期，未发送（附件已清理）`，不可重试。
- `ChatScreen` 每次刷新会执行 `pendingSends.prune()`，过期任务能在当前 UI 看到提示。

### 2.2 已确认、已放弃任务清理

- `confirmed` 记录在 `prune()` 时立即删除并清理附件。
- `abandoned` 记录保留 1h（供 UI 撤回提示）后删除并清理附件。
- 共享同一 `stagedUri` 的仍活跃记录不会被误删附件：清理前计算 keep 集合中的活跃引用。

### 2.3 暂存目录与孤儿文件

- 生产目录：`DocumentDir/dsh-pending-send`（应用私有目录，Android `allowBackup=false`）。
- 启动 `hydrate()` 执行 `cleanupOrphans(referencedStagedUris)`：
  - 清理崩溃/记录创建失败留下的孤儿；
  - 不删除仍被任何记录引用的文件。
- `PendingSendStore.clearAll()` 清空 Keychain 记录后清理整个暂存目录。
- 清理失败不虚报：`clearAll()` 在记录已清除但暂存目录清理失败时返回
  `{records:'cleared', staging:'failed'}`；App 将 `pendingSends` 标记为 `partial`，
  提示「记录已清除，但附件暂存目录没能确认清空」，不会显示全部成功。

### 2.4 断开连接 vs 清除授权

- `signOut` 只设置登录意图/断开连接，不触碰 `pendingSends`，未决任务保留。
- `clearAuthorization` 先清服务端授权，再清本地凭据、派生状态、`pendingSends.clearAll()` 和私有暂存目录。
- 清除授权确认弹层明确列出：
  - 登录 Cookie
  - 审批网关设备凭据
  - 管家会话等关联状态
  - 尚未确认的待发送消息及其私有暂存附件
  - 结果未知任务清除后无法安全重试

截图：[PHASE-3-CLEAR-AUTH-CONFIRM.png](PHASE-3-CLEAR-AUTH-CONFIRM.png)（阶段 4 仍使用同一确认弹层）。

### 2.5 重启与 UI 文案

- 重启恢复：`sending→unknown`、`preparing→failed`、`queued/ready` 保持原状态；不自动发送。
- `PendingSendBubble` 文案：
  - 新消息待发送：`待发送（新消息）`；
  - 继续发送：`继续发送`；
  - unknown/failed：`安全重试（复用原 ID）`；
  - `expired`：`已过期，未发送（附件已清理）`。
- 普通新发送与显式安全重试在 UI/Store 路径上分开。

### 2.6 暂存上限与磁盘不足

- 单文件上限 50MiB；总暂存上限 256MiB（`ReactNativePendingSendStaging`）。
- 复制/哈希/磁盘空间不足统一转为 `PendingSendStagingError`（`attachment-too-large` / `staging-full` / `attachment-copy-failed`），发送路径不调用 prompt。
- 真实磁盘填满注入未在模拟器上执行；当前行为由异常映射和 Node 故障注入测试覆盖，报告不声称已完成真实磁盘满测试。

---

## 3. 专项安全边界核查

| 检查 | 结果 |
|---|---|
| 暂存目录私有性/备份 | `DocumentDir/dsh-pending-send`，应用私有；Android `allowBackup=false`（阶段 1 Android 验证报告亦确认） |
| 暂存成功、record 写入失败 | `Store.sendPending` catch 后 `discardStaged()`；测试断言暂存文件为 0、无 prompt |
| 多记录共享附件 | prune 只删除不再被活跃记录引用的 `stagedUri`；新增共享引用测试 |
| accepted/confirmed 乱序/并发 | `confirm` 可从 accepted/sending/unknown 进入；迟到 accept 幂等；single-flight/乱序测试通过；确认记录清理前不误删仍被活动记录引用的文件 |
| Keychain/目录非原子清理 | 记录写入失败时不碰目录；目录清理失败时返回 `partial`，App 不显示“全部清除成功”；下次启动 `cleanupOrphans` 继续清理残留 |
| 256 MiB/磁盘不足 | 上限检查和异常映射存在；未做真实磁盘填满注入，见 2.6 |

---

## 4. 测试

### 4.1 Node

| 测试 | 结果 |
|---|---|
| `pending-send-attachment-flow-spec` | **19/19 通过**（新增共享引用、已确认/放弃清理、清理失败、孤儿回收） |
| `pending-send-store-spec` | **13/13 通过**（含过期提示与最终清理） |
| `pending-send-service-binding-spec` | 10/10 |
| `pending-send-send-flow-spec` | 9/9 |
| `pending-send-wiring-spec` | 5/5（新增断开连接/彻底清除区分） |
| `test:idem` / `test:retry` | 12/12、9/9 |
| `npm run test:integration` | 61/61（最终需本报告提交前确认） |

### 4.2 Android 模拟器真实组件

- 阶段 3 Android harness（`P0HarnessActivity`）真实 Keychain + `ReactNativePendingSendStaging`：图片、文件、混合、同名同大小不同内容、原 URI 失效、20×8KiB 性能、force-stop 恢复均 PASS。
- 真实 ChatScreen 实际用户发送：产生 `未发出` 状态并显示安全重试；截图见 1.2。
- 真实 DSH 附件脚本：图片/文件/混合上传→prompt→page、回执丢失、非法 receipt、上传中断、prompt 明确失败全部 PASS。

### 4.3 Mock / fixture

- Node 附件编排使用 `MemoryStaging` + mock `uploadBinary`/`session/prompt`；用于故障注入和状态机，不宣称真实 DSH 网络。
- `PHASE-3-CHATSCREEN-PENDING.png` 的 unknown/accepted 气泡是 fixture 注入，不是真实 prompt。
- `PHASE-4-ACTUAL-CHATSCREEN-FAILED.png` 是实际用户操作 + 真实 ChatScreen，但发送被远端身份验证阻断。

### 4.4 完整回归

- **`npm test`：PASS（exit 0）**，最终工作树（含阶段 3/4 新增测试与 `typecheck`）全部通过。
- **`npm run test:integration`：61/61 通过**：
  - `integration-transport.mjs`：15/15
  - `integration-gateway.mjs`：14/14
  - `integration-long-session.mjs`：10/10
  - `integration-product.mjs`：16/16
  - `integration-gateway-reconnect.mjs`：6/6
- `npm run typecheck`：PASS。
- `npm run test:pendingSendAttachments`：19/19；`npm run test:pendingSendStore`：13/13；`npm run test:pendingSendWiring`：5/5。

---

## 5. 已知限制

1. **真实 ChatScreen accepted/confirmed 用户操作**仍未完成；当前只验证了实际 failed 状态和 fixture accepted 状态。
2. **真实 App ChatScreen 附件选择器上传**尚未完成真实 DSH e2e；真实附件链路已在独立脚本验证。
3. **真实磁盘满注入**未执行；仅覆盖异常映射和 mock 故障。
4. **服务端 receipt 有效性查询**不存在；invalid receipt 已确认为明确 `attachment-invalid`，不会自动改 receipt 重试。
5. 真实 DSH 测试创建了独立临时会话；未触碰已有用户会话。

---

## 6. 阶段 5 结论

**阶段 4 代码与本地/模拟器测试已完成，但阶段 3 的“真实 ChatScreen accepted/confirmed 用户操作”验收项仍未关闭。**

因此结论是：

- **阶段 5 暂不允许以“全部验收关闭”为由开始**；
- 若阶段 5 只做互不影响的新功能开发，可带着上述明确限制推进；
- 进入阶段 5 发布前必须补完：真实 ChatScreen accepted/confirmed、App 附件选择器真实上传、真实磁盘满/暂存上限注入。

---

*报告生成：2026-10-28 · 阶段 4*
