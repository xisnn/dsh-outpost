# 05 · P1 权限与审批 Emulator 验收结果

- 设备/包/模型同 04。原始证据：`evidence/p4-07-approval-card-phone-tap.png`、
  `logs/logcat-p4-full.log`、`logs/stub-model-requests.jsonl`、`evidence/device-native-runtime-evidence.txt`

---

## 1. 已实测（REAL_HOST_EMULATOR）

### 1.1 AccessibilityService 授权与撤销 — PASS

- `settings put secure enabled_accessibility_services com.dshoutpost.p1.p3e2e/com.dshpocket.agent.OutpostAccessibilityService`
  + `accessibility_enabled 1` 后，logcat `DshPhoneA11y: service connected`。
- 重装/切换/息屏唤醒期间多次 `service destroyed` → `service connected`，撤销与恢复路径真实工作。
- 工具注册以**服务实际连接**为准（`PhoneBridge.isConnected()` = `instance != null`），
  而非仅「设置里启用」——运行中启用不会追加工具，需新 run（`AgentRuntime.kt:249-257`）。

### 1.2 审批提示绑定用户实际看到的内容 — PASS（digest 逐字校验）

审批卡（`evidence/p4-07-approval-card-phone-tap.png`）显示：

```
需要你确认 · phone_tap
参数摘要 f2f501979d88…
element: n999
[允许一次] [拒绝]
```

独立计算：`SHA-256(canonical({"element":"n999"})) = f2f501979d88e0c6bbaad99fd14e27b65cbd869baa2b2ba0794c013353e50435`，
前 12 位 `f2f501979d88` **与卡片完全一致**。
canonical 为键排序 JSON（`Contracts.kt:91-101`），digest 由执行器计算并传入（`Tools.kt:74,85`），
UI 回传**渲染时**的 digest（`AgentOverlayController.kt:235-240` / `AgentButlerScreen.tsx:237`）。
⇒ 审批绑定的是用户看到的参数，换参数即换 digest，旧批准失效（`AgentRuntime.kt:401`）。

> 注意：digest 只覆盖**参数**，不含工具名/runId/屏幕内容。用户批准的是参数 JSON，不是屏幕哈希。

### 1.3 未授权不执行 / 拒绝后不续调 — PASS

点击「拒绝」后，回喂模型的工具结果为 `DENIED: approval rejected`，
且 logcat **无任何手势/设备动作日志** ⇒ 拒绝后设备操作未执行。
默认拒绝链：`Tools.kt:92-94`（decision != ALLOW_ONCE → DENIED）、`AgentRuntime.kt:632`（null → REJECT）。

### 1.4 审批通过 ≠ 放行（运行时守卫独立生效）— PASS

点击「允许一次」后，`phone_tap` 仍被**运行时敏感屏守卫**拦截（前台为 DSH 自身）→ 再次接管暂停。
证明审批与屏幕守卫是**两道独立防线**，批准不能绕过敏感屏保护。

### 1.5 权限授予 — PASS

`dumpsys package`：`FOREGROUND_SERVICE_DATA_SYNC granted=true`、`WAKE_LOCK`、`POST_NOTIFICATIONS` 已授予；
`appops set … SYSTEM_ALERT_WINDOW allow`。通知权限弹窗在 P3 已真实出现并允许（本轮沿用）。

### 1.6 凭据隔离 — PASS

模型 API Key 保存后 UI 显示掩码 `••••…` + 「已保存」，`read()` 只暴露 `hasKey`（需成功解密），
**Key 不回传 JS**（`AgentSettingsStore.kt:41-46`）。存储为 Android Keystore AES/GCM-256
（`:30,110-145`），`allowBackup=false`。androidTest `KeychainStorageValidationTest`（5 项）在库但本轮未跑（见 06）。

---

## 2. 静态确认的缺口（FAIL，未擅自修改）

### 2.1 敏感词子串误报

`OAS:75-78,487-490`：`"pin"` 以 `contains` 命中 `shipping` / `Shopping cart` / `spinner` / `happiness`。
方向 fail-closed（误接管），但正常屏被误判。已执行谓词验证，非推测。

### 2.2 原生审批链**无过期**

`AgentRuntime.kt:629-631` 为无时限 `approvalChanged.await()`；无 TTL/看门狗。
对比 butler 路径有 300s 过期（`local-approvals.js:11,87,112`）。
⇒ 原生审批可**无限期挂起**，仅 stop/进程死亡释放。属设计缺口。

### 2.3 拒绝后模型可重试（无熔断）

`AgentLoop.kt:76-81` 把 DENIED 作为工具消息回喂并继续循环；无拒绝计数/熔断。
模型可重发相同调用 → 新 callId → 再次弹窗。仅受 maxSteps 限制。
现有 JVM 测试 `AgentLoopTest.kt:100-104` **断言此为预期行为**（拒绝≠run 中止）。
验收含义：拒绝后应断言「副作用未落地 + 可能再弹窗」，而非「run 终止」。

### 2.4 悬浮审批卡未在他应用上出现（NOT_RUN）

本轮审批走 RN 内嵌卡；`AgentOverlayController` 的悬浮卡未观察到覆盖 Contacts。
`start():57-68` 以 `canDrawOverlays` 为门；已授 appops 但卡未出现，原因未定（可能与 run 状态/轮询有关）。
**不宣称悬浮卡已验收。**

---

## 3. 非法/过期/重复审批（静态 + JVM）

| 情形 | 原生链 | 证据 |
|---|---|---|
| 无 pending | `NO_PENDING_APPROVAL` | `AgentRuntime.kt:400` |
| callId/digest 不符 | `STALE_APPROVAL` | `:401` |
| 重复决定 | `DECISION_IN_PROGRESS`（首次为准） | `:405` |
| 决定值非法 | Kotlin Boolean，桥接层不可能非 bool | 类型系统 |
| gate 抛错 | `ERROR "approval unavailable"`（不放行） | `Tools.kt:89-91` |
| 过期 | **无概念**（见 2.2） | `:629-631` |

JVM 侧 `AgentLoopTest` 的三个 veto 测试（`9727238`）本轮 38/38 通过，覆盖 pre-approval/pre-execute 否决。

---

## 4. 结论

审批的**绑定、默认拒绝、拒绝无副作用、审批与守卫分离**在真实 Emulator 上 PASS；
**敏感词子串、原生审批无过期、拒绝可重试、悬浮卡**为缺口/未验项。
涉及审批安全边界的修改**先交付方案供第二方复核**（见 09）。