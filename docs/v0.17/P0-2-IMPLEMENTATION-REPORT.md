# P0-2 WebSocket 自动重连与会话恢复验收报告

日期：2026-10-29
分支：`feat/v0.17`
前置基线：`c897257`（P0-1 COMPLETE）
P0-2 代码提交：`f62813b`
测试 APK：`dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk`
APK SHA-256：`0E3C2C3062A09CD710EF04C6FD2AEC80211AEFE47FED04F9A440432658B04EA0`
模拟器：`dsh_verify`（`emulator-5584`）+ 隔离 DSH 实例（`127.0.0.1:3097`）

---

## 1. 调研结论与设计（借鉴 Cindy，独立实现）

1. **当前 DSH Outpost 连接生命周期分析**：
   - `DshConnection`（`src/core/transport/index.ts`）通过 `/api/remote.mux` 复用单条 WebSocket 承载 `session/follow` 流；
   - P0-1 仅在 `ws` 关闭/出错时调用 `failAllStreams()` 唤醒挂起的迭代器抛错，`Store.pump()` 捕获异常后只设置 `chat.error` 并退出循环，**没有自动重连或断档补齐**；
   - 同时存在两个竞态缺口：`ensureSocket()` 无并发 single-flight 保护（多流并发打开可能建多条底层连接），且旧 `ws` 迟到的 `close/error` 回调可能误清空新连接的 `this.streams`。
2. **借鉴 Cindy 的核心设计思想**：
   - 查阅 `E:\SoftGit\cindy` 中的 `PeerRecoveryScheduler`（`packages/device-link/src/peerRecoveryScheduler.ts`）、`rehydrateDeviceLinkTopics`（`apps/mobile/src/device-link/rehydrate.ts`）、`backgroundConnection.ts` 与 `reconnectHeal.test.ts`：
     - **代次隔离（Generation Fencing）**：每次重连/关闭递增 `generation`，异步回调先核对代次，防止旧连接/旧流迟到回调污染新状态；
     - **指数退避 + 抖动**：瞬时网络错误按指数退避重试，明确鉴权拒绝（401/403）属于永久错误，立即停止重连；
     - **Host 权威快照 + 断档回填（Gap Healing）**：重连成功后拉取最新快照，若断连窗口内产生事件缺口，通过分页接口回填并按唯一事件序号去重合并；
     - **前后台切换恢复**：App 回到前台时重置半开连接并立即触发活跃会话重连对账。

---

## 2. 核心实现改动

1. **`src/core/transport/index.ts`**：
   - 为 `ensureSocket()` 增加 `connectingWs` 并发 single-flight 锁与 `socketGeneration` 代次隔离；
   - 旧 WebSocket 迟到的 `message` / `close` / `error` 事件严格比对 `isCurrent()`，绝不误杀替换后的新连接；
   - 握手阶段识别 `401/403/Unauthorized` 并构造 `RpcError(kind: 'http')`，供上层区分鉴权失效与普通网络断连；
   - 新增 `resetSocket(reason)`，供前后台切换时主动清理可能半开假死的底层连接。
2. **`src/core/rpc/session.ts`**：
   - `SessionApi.page()` 支持传入可选 `address: SessionAddress`，使子代理会话与普通会话在重连回填时保持一致地址。
3. **`src/core/store.ts`**：
   - 扩展 `streams` 项状态（`generation`、`retryAttempt`、`retryTimer`、`connecting`、`address`）；
   - 新增 `connectChatStream(sessionId, isReconnect)` 与 `handleStreamDisconnect()`：
     - 指数退避（默认 `base=500ms`, `max=15000ms`）+ 随机抖动（`0.85 ~ 1.15`）；
     - 识别 `401/403` 鉴权失效立即停止自动重连，提示 `登录状态已失效，请回配对页重新连接`；
     - 重连成功后将新 `snapshot.records` 合并进 `entry.records`（按 `event.seq` 幂等去重）；
     - 若断线期间产生跨越单页快照窗口的缺口（`minNewSnapSeq > prevMaxSeq + 1`），调用 `backfillReconnectGap()` 通过 `session/page(throughSeq=snapshot.cursor, beforeSeq=...)` 循环回填全部遗漏事件；
     - 重连并合并事件后调用 `rebuild(sessionId)` 触发 `reconcilePendingNow(sessionId)`，自动将断线期间服务端已落盘的 P0-1 `unknown/accepted/sending` 记录对账为 `confirmed`。
   - 新增 `handleAppForeground(baseUrl)`：App 切回前台时重置半开 socket、清零退避计数并立即恢复活跃会话流。
4. **`src/App.tsx` & `src/core/approvalGateway.ts`**：
   - 在 `GlobalNotices` 中监听 React Native `AppState` 从 `background/inactive` 切回 `active`，调用 `store.handleAppForeground(baseUrl)`；
   - 为 `ApprovalGateway.scheduleRetry()` 补充 `0.85 ~ 1.15` 随机抖动。

---

## 3. 自动化测试结果

新增 `dsh-mobile/tests/ws-reconnect-session-recovery-spec.mjs`（`npm run test:wsReconnect`），**5/5 PASS**：

1. `DshConnection.ensureSocket`：并发 `openStream` 共享同一连接（single-flight），且旧连接迟到 `close` 不误杀新连接 — **OK**
2. 断线自动重连 + 指数退避 + `cursor`/`session/page` 补齐遗漏事件（`Msg-1..Msg-6`）且不重复显示消息 — **OK**
3. Cookie 失效（`401/403`）停止自动重连，不无限重试 — **OK**
4. 会话切换（`closeChat`）取消待定重连定时器，重复 `openChat` 不重复建流 — **OK**
5. App 前后台切换（`handleAppForeground`）与 P0-1 `unknown` 消息重连后自动对账为 `confirmed`（`requestId` 不变） — **OK**

相关回归测试汇总（全部 PASS）：
- `npm run typecheck`：PASS
- `npm run test:wsReconnect`：5/5 PASS
- `npm run test:disconnect`：10/10 PASS
- `npm run test:recovery`：15/15 PASS
- `npm run test:pendingSendStore`：15/15 PASS
- `npm run test:pendingSendFlow`：9/9 PASS
- `npm run test:pendingSendAttachments`：23/23 PASS
- `npx tsx tests/p0-verify-spec.mjs`：3/3 PASS
- `npx tsx tests/p0-verify-behavior-spec.mjs`：5/5 PASS
- `npm run test:integration`：61/61 PASS

---

## 4. 真实 Android 模拟器（`dsh_verify`）端到端验收证据

测试会话：`session-78b8870f-b726-4b5c-9bd3-b09c20322f69`

1. **初始连接与首条消息**：
   - 真实 ChatScreen 打开会话，显示初始消息 `P02_Before_Disconnect`。
2. **断网 + DSH 服务停止 → 指数退避 + 抖动重连**：
   - 移除 `adb reverse` 并停止隔离 DSH 3097 进程；
   - `adb logcat` 实测退避序列（含抖动，封顶 `15000ms`）：
     ```text
     10-29 07:52:45.714 I ReactNativeJS: [p0-2-verify] schedule-reconnect sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 attempt=1 delayMs=516
     10-29 07:52:46.250 I ReactNativeJS: [p0-2-verify] schedule-reconnect sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 attempt=2 delayMs=858
     10-29 07:52:47.133 I ReactNativeJS: [p0-2-verify] schedule-reconnect sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 attempt=3 delayMs=1967
     10-29 07:52:49.112 I ReactNativeJS: [p0-2-verify] schedule-reconnect sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 attempt=4 delayMs=3793
     10-29 07:52:52.947 I ReactNativeJS: [p0-2-verify] schedule-reconnect sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 attempt=5 delayMs=9141
     10-29 07:53:02.129 I ReactNativeJS: [p0-2-verify] schedule-reconnect sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 attempt=6 delayMs=15000
     ```
   - 断线重连提示截图：[P0-2-DISCONNECTED-RECONNECTING.png](P0-2-DISCONNECTED-RECONNECTING.png)
3. **DSH 服务重启 + 断线期间产生遗漏消息 + 网络恢复自动补齐**：
   - 重启隔离 DSH 3097，在 App 仍处于断网状态时向该会话写入第 2 条消息 `P02_Missed_During_Disconnect`；
   - 恢复 `adb reverse tcp:3097 tcp:3097`，App 自动重连成功并补齐断线期间消息：
     ```text
     10-29 07:54:00.270 I ReactNativeJS: [p0-2-verify] reconnected sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 cursor=29 records=30
     ```
4. **App 前后台切换恢复与后台期间遗漏消息补齐**：
   - 发送 `KEYCODE_HOME` 将 App 切到后台，向服务端写入第 3 条消息 `P02_After_Foreground_Resume`，再将 App 切回前台；
   - `adb logcat` 确认触发前后台恢复并立即重连同步到最新游标 `cursor=37`：
     ```text
     10-29 07:54:06.721 I ReactNativeJS: [p0-2-verify] app-foreground activeStreams=1
     10-29 07:54:08.192 I ReactNativeJS: [p0-2-verify] reconnected sessionId=session-78b8870f-b726-4b5c-9bd3-b09c20322f69 cursor=37 records=38
     ```
   - UI 恢复截图（顶部错误横幅已消失，`P02_Before_Disconnect`、`P02_Missed_During_Disconnect`、`P02_After_Foreground_Resume` 三条消息按序完整展示且无重复）：[P0-2-RECOVERED-CHATSCREEN.png](P0-2-RECOVERED-CHATSCREEN.png)

---

## 5. 结论

**P0-2 PASS**
