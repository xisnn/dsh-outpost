# 12 — Rurea C1：增量流式 UX（4/4 云协议 + 原生推送 + 打字机平滑 + 可中断）

日期：2026-11-22 · 分支：opt/p1-phone-polish · 触发：用户「C1 流式 UX，加油」/「接着完成吧」。
性质：**非敏感**（模型传输层 + UI 流式表现；不动审批门、凭据 Keystore、设备控制或 RunStore 持久化）。

## 现状梳理与真缺口
逐层核查现有链路后确认：
1. **模型传输层**：`OPENAI_COMPAT`、`ANTHROPIC`、`GEMINI` 3 个协议已走 `transport.stream` 逐 SSE delta 回调 `onText`，唯独 **`OPENAI_RESPONSES`** 仍走同步 `transport.post`、解析完才一次性回调 `onText`。
2. **多步与中断衔接**：
   - `AgentLoop` 切入新一步时 `AgentRuntime.liveText` 未重置，多步任务中前一步旁白与后一步回答直接拼接；
   - 用户在流式输出途中点击「停止」触发 `cancelInFlight()` 断连时，底层 socket 异常落为 `model-transport: Socket closed`（红字报错卡），而非干净的「已中断」并保留半截内容。
3. **RN 渲染与节拍**：
   - 仅依赖 700ms 固定轮询拉取 `snapshot()`，逐帧大块跳字而非打字机增量；
   - 运行结束时 `liveText` 立刻清空而 `thread` 异步刷新，产生 50~1200ms 回复闪烁消失；
   - `ScrollView` 无条件 `scrollToEnd`，用户上翻读历史时会被强行拉回底部。

## 实施摘要
- **4/4 协议全量增量流式（`agent-core`）**：
  - `CloudModel.kt`：`OPENAI_RESPONSES` 切到 `stream: true` + `transport.stream` + `responsesTextDelta`（提取 `response.output_text.delta`）；`parseResponsesResponse` 支持 SSE 流（`response.completed` 取完整结构，保留非流式 JSON 兼容），对 `response.failed` / `response.incomplete` / 非法 SSE JSON 一律 fail-closed，与其他 3 协议一致。
  - `RunObserver.kt` + `AgentLoop.kt`：新增默认空实现的 `onStepStarted(step: Int)` 观察钩子，不改变执行语义。
- **原生低延迟推送 + 干净中断（`android/app`）**：
  - `AgentRuntime.kt`：在 `onStepStarted` 按步重置 `liveText`；新增锁外回调的 `StreamUpdate` 推送；在途 `stop()` 中断 HTTP 流时把 UI 终态归一化为 `interrupted` / `stopped-by-user`，并在对话记录中保留已生成的半截内容 + `（已中断）`。
  - `AgentModule.kt`：接通 `addListener` / `removeListeners`，以 40ms 合并节流（步切换/停止/终态 0ms 立即推送）发射 `agentStream` 事件，`invalidate()` 清理监听与待发回调。
- **打字机平滑 + 零闪烁 + 不抢滚动（`dsh-mobile/src`）**：
  - `src/core/agent.ts`：新增 `AGENT_STREAM_EVENT`、`AgentStreamEvent` 与 `agentClient.subscribeStream`。
  - `src/core/agentStream.ts`（纯 TS，可完整单测）：
    - 自适应轮询节拍（运行/停止中 `180ms` 兜底，空闲 `700ms`）；
    - 打字机增量推进 `advanceRevealedLength` + 代理对安全切片 `safeSlice`（不截断 emoji，尊重 `reduceMotion`）；
    - `applyStreamEvent` 防终态回退、防跨 `runId` 串写、保留 `waiting_user`；
    - `resolveStreamingBubble` 覆盖 `working` / `streaming` / `stopping` / `settling`（完成落盘前无缝承接，待 `thread` 同步后自动去重）。
  - `src/components/AgentStreamingBubble.tsx`：增量文本 + 光标 `▍`（`reduceMotion` 静态不闪）+ 气泡内一键「停止」按钮。
  - `src/screens/AgentButlerScreen.tsx` & `AgentDemoScreen.tsx`：接入 `subscribeStream`、打字机推进、`AgentStreamingBubble`、`scrollFollow` 近底跟随（用户上翻不抢滚动）；`AgentDemoScreen` 运行中同步展示 `streamText`。

## 验证（实跑结果）
- **JVM 契约（`:agent-core:test --rerun-tasks`）**：**122/122 通过**（0 fail / 0 error / 0 skip）：
  - `CloudModelClientTest` 13 → **18**（补齐 Responses 增量/工具调用/fail-closed + Anthropic 增量 + Gemini 增量与跳 thought）；
  - `AgentLoopTest` 14 → **16**（跨步 `onStepStarted` + 增量 delta + 工具生命周期交织）。
- **Android Kotlin 编译（`:app:compileDebugKotlin`）**：**BUILD SUCCESSFUL**（无新增告警）。
- **RN `test:agentChain`**（新增 `test:agentStream` 归入 `agentChain`，见 A3 约定）：
  - `test:agentCoreCi`：**40/0**（校验 13 个测试类共 122 个 `@Test`）；
  - `test:screenOff`：**2/0**；
  - `test:agentStream`（`tests/agent-streaming-ux-spec.mjs`）：**7/0**（纯逻辑 + 组件渲染与可中断交互 + 跨层接线断言）。
- **类型检查 & 门禁 / 关联 dsh 回归**：
  - `npm run typecheck`（`tsc --noEmit`）：**0 错误**；
  - `test:suiteRunner`：**75/0**（展开 124 条命令逐字一致）；
  - `test:signingWf`：**32/0**；`test:security`：**61/0**；
  - 关联引用 `AgentButlerScreen` 的 3 份 dsh spec：**24/0**。
- **A3 前置 CI 闭环**：run `44915891619`（`@830b97c`）= **SUCCESS**。

## 治理与诚实边界
- 非敏感范围：未触碰审批绑定/TTL/决策、Keystore 凭据、无障碍/副屏设备控制、RunStore 持久化格式。
- 不削弱任何断言，JVM 门禁计数单调递增（115 → 122），`.github/workflows/android.yml` step 标签同步更新。
- 真机/模拟器视觉动画观感与实际云端 SSE 分片延迟需后续配合实体机/模拟器冒烟复核；本轮以 JVM 契约 + 组件 harness + Android 编译 + CI 门禁验收闭环。
