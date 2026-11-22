# 15 — Rurea C1 + C2 + C4 真机端到端验收（vivo V1981A / `762a319`）

日期：2026-11-22 · 分支：`opt/p1-phone-polish` · 设备：vivo V1981A (`PD1981`) / Android 12 / API 31 / serial `762a319`
承接：[08_RUREA_B3_VIVO.md](./08_RUREA_B3_VIVO.md)、[12_C1_STREAMING_UX.md](./12_C1_STREAMING_UX.md)、[13_C2_SAFETY_GATES.md](./13_C2_SAFETY_GATES.md)、[14_C4_ERROR_RECOVERY_UX.md](./14_C4_ERROR_RECOVERY_UX.md)。

## 一、验收设计（隔离包 + 正常进程 + loopback 桩）
- **隔离包名**：`com.dshoutpost.p1.p6next`（release + JS 内置 + `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true` + `-PDSH_TEST_ENTRY_FILE=../../src/acceptance/c1c2c4-entry.tsx`，零污染生产包 `com.dshpocket` 与 `index.js`/`index.rurea.js`）。
- **正常进程链路**：经 `monkey` 正常启动 App + `enabled_accessibility_services` 追加服务 + `accessibility_enabled` `0→1` 触发绑定，真绑定 `OutpostAccessibilityService`（无 instrument 死锁）。
- **本地 loopback 桩**：`tests/acceptance/c1c2c4-stub-server.mjs` 监听 `127.0.0.1:8787`，经 `adb reverse tcp:8787 tcp:8787` 连接，零付费云 API 调用。
- **零个人隐私 / 零实付靶**：所有设备动作仅在沙盒工作区与零个人数据自带计算器（`com.android.bbkcalculator`）执行；支付宝 `com.eg.android.AlipayGphone` 于 `ActionSafetyPolicy` 层硬拒绝，从未启动。

## 二、7/7 用例真机实跑结果（`allOk: true`）

| # | 用例 | 结果 | 真机实测数据 |
|---|---|---|---|
| 1 | **`C1_STREAM_COMPAT`** | **通过** | `OPENAI_COMPAT` `agentStream` 原生推送 6 次，流式文本长度依次推进 `[3, 7, 11, 16]`，终态 `completed`，`text="第一段，第二段，第三段，完成🎉"`（含 emoji 完整保留），`goal="[C1_STREAM_COMPAT]"` |
| 2 | **`C1_STREAM_RESPONSES`** | **通过** | `OPENAI_RESPONSES` `agentStream` 原生推送 5 次，长度依次推进 `[10, 14, 18]`，终态 `completed`，`text="Responses 流式增量验证成功"` |
| 3 | **`C1_C2_MIDSTREAM_STOP`** | **通过** | 收到增量 `"半截输出"` 后调用 `stop()`，在途断连耗散仅 **126ms**；快照 `phase="interrupted"`、`error="stopped-by-user"`；`FileRunStore` history 记为 `interrupted`；`AgentThreadStore` 保留 `"半截输出\n\n（已中断）"`（无红字 `model-transport` 报错） |
| 4 | **`C4_MODEL_AUTH_401`** | **通过** | 桩返 HTTP 401，`phase="failed"`，`error="http-401: ..."`、`goal="[C4_HTTP_401]"`，`classifyAgentFailure` 归因 `model_auth`（`模型 API Key 认证失败（401）`），首选动作 `open_settings` |
| 5 | **`C4_FAULT_RETRY_503_AND_SOCKET_DROP`** | **通过** | (a) 首调 HTTP 503 → 归因 `model_provider`，按 `snap.goal` 重试 → `completed` (`C4_RETRY_503_OK`)；(b) 首调服务端强断 TCP → `model-transport: EOFException` → 归因 `network`，按 `snap.goal` 重试 → `completed` (`C4_RETRY_NET_OK`) |
| 6 | **`C4_BACKGROUND_NOT_READY`** | **通过** | 未装 Shizuku 且开启自动后台屏时，`startCloud` 同步拒绝抛 `code="BACKGROUND_NOT_READY"`（不悄悄切主屏）；`classifyAgentFailure` 识别 `shizuku_not_running` 并给出 `open_background` + `disable_auto_start`；关闭自动后台屏后立即恢复执行 (`C4_BG_RECOVERED_OK`) |
| 7 | **`C2_THREE_TIER_POLICY`** | **通过** | `phase="completed"`，`text="C2_POLICY_DONE"`：<br>• `phone_open("com.eg.android.AlipayGphone")` → **0 审批直接 `DENIED` (`PAYMENT_HARD_DENIED`)**<br>• `phone_open("com.android.settings")` → 弹审批 + 实时 TTL（`剩余 5:00 后自动拒绝`），拒绝后 `DENIED`<br>• `workspace_write("c2-vivo-probe.txt")` → 弹审批 + 实时 TTL，允许后 `OK` (`wrote 11 bytes`)<br>• `phone_tap("n1")` → 弹审批 + 实时 TTL，拒绝后 `DENIED`<br>• `phone_open("com.android.bbkcalculator")` → **0 审批自主 `OK`**（真打开系统计算器）<br>• `phone_screen()` → **0 审批自主 `OK`**（读取计算器节点树）<br>• `phone_scroll("down")` → **0 审批自主执行**（计算器无滚动容器诚实返 `NO_SCROLLABLE`）<br>• `phone_key("back")` → **0 审批自主 `OK`**（自动切回测试 App） |

## 三、诚实边界说明
- `phone_scroll` 在本轮无滚动容器的计算器页验证了 **0 审批自主进入执行层**（`NO_SCROLLABLE`）；真实可滚动列表上的 `SCROLLED down` 动作效果已由 B3（[08_RUREA_B3_VIVO.md](./08_RUREA_B3_VIVO.md)）在同台 vivo 设备上实测通过。
- 靶元素文字含支付词的 `phone_tap`/`phone_type` 硬禁（`PAYMENT_HARD_DENIED`）、外发按钮 `OUTWARD_ACTION_APPROVAL` 提示及 300s/30min 长时定时器自动超时，保持由 `ActionSafetyPolicyTest`（12 `@Test`）、`ApprovalTtlTest`（9 `@Test`）、`RunDeadlineTest`（8 `@Test`）及 `test:agentC2` 覆盖，不在用户日用手机上触发真实第三方支付或外发 App 页面，也不阻塞等待 5 分钟 / 30 分钟实钟。
- **API 36 FGS `dataSync` 限时** 仍因本机为 Android 12（API 31）而保持 `BLOCKED`。

## 四、设备环境清理确认（实测回读）
- 无障碍原值恢复：`enabled_accessibility_services=com.vivo.favorite/com.vivo.favorite.support.accessibility.ActivityMonitorService`，`accessibility_enabled=1`；
- 已卸载 `com.dshoutpost.p1.p6next`（`Uninstall: 0 Success`，`pm list packages com.dshoutpost.p1.p6next` 为空）；
- 已关闭 `com.android.bbkcalculator`、移除 `adb reverse tcp:8787` 并停止本地 loopback 桩服务；用户主屏个人数据零写入。

## 五、证据文件
- [P6-rurea-c1c2c4-vivo-report.json](./evidence/P6-rurea-c1c2c4-vivo-report.json)
- [P6-rurea-c1c2c4-prior-a11y.txt](./evidence/P6-rurea-c1c2c4-prior-a11y.txt)
- 验收入口与桩：`dsh-mobile/src/acceptance/c1c2c4-entry.tsx`、`dsh-mobile/tests/acceptance/c1c2c4-stub-server.mjs`
