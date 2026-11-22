# 14 — Rurea C4：错误恢复 UX（模型 / 网络 / 副屏 / 无障碍 / 中断 可见恢复闭环）

日期：2026-11-22 · 分支：`opt/p1-phone-polish` · 触发：用户确认「那我们再把 C4 错误恢复 UX 也收了吧」。
性质：**非敏感**（错误分类归一化、前端恢复建议卡与操作引导、轻量运行时元数据；不动审批门、Keystore 凭据、Shizuku binder 控制与 RunStore 持久化格式）。

## 一、现状审计与缺口
逐层排查 C1/C2 之后的错误呈现路径，发现虽然底层已有严格 fail-closed 保护，但前端恢复 UX 存在 6 个明显断点：
1. **Run 失败与操作拒绝对用户仅展示裸红字**：`AgentButlerScreen` / `AgentDemoScreen` 直接把 `model-transport: ...`、`http-401`、`BACKGROUND_NOT_READY`、`ACCESSIBILITY_NOT_CONNECTED` 等内部报错原样吐出，既无中文归因，也没有一步直达的恢复按钮。
2. **中断原因不透明且缺口恢复路径**：`AgentService` 息屏 receiver 调用无参 `stop()`，UI 无法区分「用户点停」「息屏自动停（`screen-off`）」「30 分钟安全上限（`run-deadline-exceeded`）」「系统前台超时（`fgs-system-timeout`）」「单次步数上限（`step-limit`）」，也无法将原任务快捷回填输入框继续调整。
3. **重放盲区风险**：若任务在失败前已经成功执行过有副作用的工具（如 `phone_tap` / `workspace_write`），无差别「重试」容易误触二次发送/覆写，需要显式警示并优先引导回填输入框确认。
4. **崩溃恢复（`RunRecovery`）仍透出英文机制语**且缺少回填原 `goal` 入口；时间线中 `approval_expired` / `PAYMENT_HARD_DENIED` 等高价值状态缺乏语义翻译，无障碍断连后也不提供快速跳转按钮。
5. **从系统设置/Shizuku 切回无即时刷新**：用户去系统开无障碍或授权 Shizuku 返回 `AgentButlerScreen` 后，状态只能等定时轮询慢吞吞刷新；`agent.ts` 的 `parse()` 抛出拒收动作时丢失 `.code`。
6. **`BackgroundDisplayScreen` 状态卡滞感**：处于 `binding` / `retrying` / `retry_exhausted` 等态且 `connected == false` 时，「停止并释放」按钮被死锁禁用，也缺少显式连接中指示与「重试连接」按钮。

## 二、核心落地内容

### 1. 轻量原生元数据与息屏停因标记
- `AgentService.kt`：`ACTION_SCREEN_OFF` 改为调用 `stop("screen-off")`。
- `AgentRuntime.kt`：跟踪 `currentGoal` 并在 `snapshot()` 输出 `goal` 字段（含演示、云端与排队出队任务）；对话记录追加 `"screen-off"` 中文中断标记，不动 `RunStore` 持久化文件结构。

### 2. 纯 TS 故障分类与恢复规划（`src/core/agentRecovery.ts`）
- **12 类故障归一化**：`snapshot_read` / `background_display` / `accessibility` / `approval_state` / `interrupted` / `step_limit` / `model_config` / `model_auth`（区分 401 Key 无效与 403 权限不足且声明不清除本地 Key）/ `model_rate_limit`（429）/ `network`（区分 DNS/证书握手/超时/断流，且不被含 timeout 文案的 HTTP 5xx 误吞）/ `model_provider`（区分 4xx 协议不匹配、5xx 临时不可用与内容策略中止）/ `runtime`。
- **副作用感知**：`hasRunSideEffects(events)` 排除 `workspace_read` / `workspace_list` / `phone_screen` / `phone_apps` / `phone_handoff` 与 `DENIED`/`ERROR` 结果；一旦存在已生效的修改动作，`classifyAgentFailure` 自动输出黄色风险警示并将「填入输入框」前置、「从头重试」退后。
- **不破坏安全原则的恢复动作**：`open_shizuku` / `retry_background` / `open_background` / `disable_auto_start` / `open_accessibility` / `open_settings` / `retry_goal` / `edit_goal` / `refresh_snapshot` / `dismiss`，绝不绕过后台屏切回主屏，也绝不自动重放崩溃/超时任务。
- **辅助格式化**：`formatCrashRecoveryReason` 汉化 `RunRecovery` 原因；`formatTimelineEvent` 识别 `approval_expired`、`PAYMENT_HARD_DENIED`、`SENSITIVE_SCREEN`、`ACCESSIBILITY_NOT_CONNECTED`、`BACKGROUND_DISPLAY_LOST`、`STALE_NODE`、`SCREEN_LOCKED`、`OPEN_TIMEOUT` 等语义。

### 3. 可折叠详情恢复卡片与三端页面接线
- 新增 `src/components/AgentRecoveryCard.tsx`：醒目中文标题与建议、副作用提示条、默认折叠的「查看详情 / 收起详情」技术信息框；`busy` 期间「知道了（`dismiss`）」保持可点不卡死。
- `src/core/agent.ts`：`AgentSnapshot` 补充 `goal?: string | null`，`parse()` 拒收分支保留 `.code`。
- `src/screens/AgentButlerScreen.tsx` & `AgentDemoScreen.tsx`：接入 `AgentRecoveryCard`、崩溃恢复「填入输入框」、`AppState` 回前台即时刷新、`backgroundLost` 内「打开 Shizuku / 后台屏设置」、手动后台屏失败非阻塞横幅（可忽略）、时间线语义渲染与无障碍直达按钮。
- `src/screens/BackgroundDisplayScreen.tsx`：基于 `canStopBackgroundDisplay` 解锁 `binding` / `retrying` / `retry_exhausted` / `permission_*` 状态下的「取消连接」，补充连接中动画提示与失败态「重试连接」按钮。

## 三、实跑验证结果

| 验证项 | 命令 / 对象 | 结果 |
|---|---|---|
| **JVM 契约** | `.\gradlew.bat --no-daemon --console=plain :agent-core:test` | **14 个测试类、142/142 通过**（0 fail / 0 error / 0 skip） |
| **Android 编译** | `:app:compileDebugKotlin` | **BUILD SUCCESSFUL**（无新增告警） |
| **RN `test:agentChain`** | `npm run test:agentChain` | `test:agentCoreCi` **41/0** + `test:screenOff` **2/0** + `test:agentStream` **7/0** + `test:agentC2` **4/0** + **`test:agentC4` 6/0** |
| **类型与门禁** | `npm run typecheck` / `test:suiteRunner` / `test:signingWf` / `test:security` | `tsc --noEmit` **0 错误**；`suiteRunner` **75/0**（126 条命令）；`signingWf` **32/0**；`security` **61/0** |
| **关联 dsh 回归** | `butler-workspace-modal-escape` / `local-butler-placement` / `butler-activity-notify` | **24/0 通过** |

## 四、诚实边界
- 本轮已通过纯逻辑故障注入单测、`AgentRecoveryCard` 组件 harness、跨层接线静态守卫、Android Kotlin 编译及类型/门禁全量验证；真实实体机上的界面观感、Shizuku/无障碍切屏往返恢复、401/断网实测表现留待下一轮连同 C1 + C2 在 vivo V1981A（`762a319`）隔离包合并验收。
