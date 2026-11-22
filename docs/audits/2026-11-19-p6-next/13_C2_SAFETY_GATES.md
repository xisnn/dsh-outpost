# 13 — Rurea C2：安全门完整闭环（三层动作策略 + 支付硬禁 + #17/#23/#25 闭环）

日期：2026-11-22 · 分支：`opt/p1-phone-polish` · 触发：用户批准（完整 C2 闭环 + 保守白名单自主边界）。
性质：**敏感改动**（审批策略、支付硬禁、Run 超时与取消边界、无障碍/手机工具控制；经第二方逐项确认后实施）。

## 一、核心落地内容

### 1. Rurea 三层动作安全策略（`ActionSafetyPolicy` + 双层执行校验）
- **Tier 1 · 支付/金融硬禁止（`HARD_DENY`，无批准通道）**：
  - `ActionSafetyPolicy.kt` 覆盖中/英文支付动作词（`立即支付`、`确认付款`、`转账`、`发红包`、`去结算`、`checkout`、`purchase`、精确词边界 `pay`/`buy` 等，通过 `SensitiveWordMatch.matchesExactWord` 避免 `payload`/`display`/`repayment` 误杀）与专用支付/银行包名（支付宝、云闪付、PayPal、Google Wallet、主流银行客户端；通用通讯/购物 App 保留浏览入口，仅在元素或屏幕触发支付特征时硬拒）。
  - 在 `ActionExecutor`（`safetyPolicy` 门）与 `AgentRuntime` 的 `preExecute` 回调实现**双层硬拒**：命中直接返回 `ToolStatus.DENIED`（`PAYMENT_HARD_DENIED`），**绝不弹出审批卡片、绝不执行工具**；同时明确豁免 `phone_handoff`，确保用户接管通道不被阻断。
- **Tier 2 · 保守白名单信息收集自主（`AUTONOMOUS`）**：
  - `workspace_read`、`workspace_list`、`phone_screen`、`phone_apps`、`phone_handoff`、`phone_scroll`、`phone_key`（仅 `back`/`home`/`recents`），以及非敏感且非支付应用的 `phone_open` 自主执行；
  - 保留全部 5 个手机操作工具的 `ToolRisk.PHONE` 标记，确保 `BACKGROUND_DISPLAY_LOST` 与 `requiresReconciliation` 不因自主放行而被绕过，且 `preExecute` 对自主工具依然生效。
- **Tier 3 · 外发/未知动作严格 fail-closed 走审批（`REQUIRE_APPROVAL`）**：
  - `phone_tap`（含无文字纯图标控件、常规点击以及显式标注 `OUTWARD_ACTION_APPROVAL` 的发送/发布/提交/分享/删除类按钮）、`phone_type`、`workspace_write`、系统/安全敏感包 `phone_open` 及任何未分类工具一律要求用户单次审批。

### 2. `#17` 审批 TTL（300s）自动过期与双端倒计时
- `ApprovalTtl.kt` 新增 `remainingMs`；`AgentRuntime.awaitApproval` 改用有界 `approvalChanged.await(waitMs, MILLISECONDS)`，到期自动清理 pending 状态、记录 `approval_expired` 事件并按 `REJECT` 退出，不再无限阻塞卡片。
- `AgentRuntime.decide` 在过期或不可验证时同步唤醒等待线程并返回 `APPROVAL_EXPIRED` / `APPROVAL_TTL_UNVERIFIABLE`。
- RN（`agentApproval.ts`、`AgentButlerScreen.tsx`、`AgentDemoScreen.tsx`）与原生悬浮窗（`AgentOverlayController.kt`）统一消费 `expiresAt`：每秒刷新剩余倒计时，超时后立即禁用「允许一次」并展示警示。

### 3. `#23` 有界 `RunDeadline`（30min）与系统超时区分
- `RunDeadline.kt` 新增 `remainingMs`；`AgentRuntime` 对 `beforeStep()`（含 `paused` 状态）、`awaitApproval()`、`awaitHandoff()` 全量等待均施加 `RunDeadline` 上限，超限触发 `stopInternalLocked("run-deadline-exceeded")`。
- `AgentService.onTimeout()` 显式传参 `"fgs-system-timeout"`，与用户手动停止 `"stopped-by-user"`、应用层超时 `"run-deadline-exceeded"` 清晰区分并写入对话记录与 RunStore。

### 4. `#25` 在途取消闭环与 `RunStore` 持久化修复
- `AgentRuntime` 引入 `TrackedModelClient` 与 `observer` 生命周期，向 `InterruptPolicy.decision(true, networkInFlight, toolLoopRunning)` 传递真实在途网络/工具状态。
- `RunControl` 新增默认方法 `isStopped()` / `stopReason()`：`AgentLoop` 在模型调用因断连抛异常或返回 `Failure` 时若检测到 `control.isStopped()`，直接向 `RunStore` 持久化 `RunPhase.INTERRUPTED` 及真实停止原因（不再误记为 `FAILED / model-transport`）。
- `PhoneBridge`（`waitForPackage` / `stableSnapshot`）与 `PhoneTools`（`sleepCancellable`）按 ≤50ms 切片检测 `cancelRequested`，停止时立即退出等待；顺手消除 `SENSITIVE_PACKAGES` 集合规范化（`setOf`）并修正过时注释。

## 二、实跑验证结果

| 验证项 | 命令 / 对象 | 结果 |
|---|---|---|
| **JVM 契约** | `.\gradlew.bat --no-daemon --console=plain :agent-core:test --rerun-tasks` | **14 个测试类、142/142 通过**（0 fail / 0 error / 0 skip）：`ActionSafetyPolicyTest` 12、`AgentLoopTest` 18、`CloudModelClientTest` 18、`SensitiveWordMatchTest` 10、`ApprovalTtlTest` 9、`RunDeadlineTest` 8 等 |
| **Android 编译** | `:app:compileDebugKotlin` | **BUILD SUCCESSFUL**（无新增警告） |
| **RN agentChain** | `npm run test:agentChain` | **`test:agentCoreCi` 41/0**（钉死 14 类 142 `@Test`）+ **`test:screenOff` 2/0** + **`test:agentStream` 7/0** + **`test:agentC2` 4/0** |
| **类型与门禁** | `npm run typecheck` / `test:suiteRunner` / `test:signingWf` / `test:security` | `tsc --noEmit` **0 错误**；`suiteRunner` **75/0**（125 条命令）；`signingWf` **32/0**；`security` **61/0** |
| **关联 dsh 回归** | `butler-workspace-modal-escape` / `local-butler-placement` / `butler-activity-notify` | **24/0 通过** |

## 三、治理与诚实边界
- 审批 TTL 到期自动拒绝、在途停止写 `INTERRUPTED`、以及真实 App（如微信/支付宝/银行 App）中的元素树与真机交互行为已通过纯 JVM 契约、组件/纯函数单元测试与 Kotlin 编译验证；**真机/模拟器端到端运行仍需后续配合设备/模拟器验收或 B4 回归固化补齐**。
- `dsh-mobile` 全量 `dshChain` 104 项留待 CI 异步跑全（本轮已实跑与 `AgentButlerScreen` / 门禁 / 安全直接关联项且全绿）。
