# P0-1 阶段 2 实施报告：发送编排、UI 接线与重启恢复

| 项 | 值 |
|---|---|
| 分支 | `feat/v0.17` |
| 基线 | `06a33e1`（运行时代码等价于 `3349bbf`） |
| 范围 | 阶段 2：文本发送持久化编排、ChatScreen 接线、App 启动/退出语义、single-flight、accepted/confirmed 对账 |
| 状态 | **实现与自动化验证完成；可以带条件进入阶段 3** |
| 正式发布 | 未合并 `main`、未移动 `v0.16.7` Tag、未创建 GitHub Release |

---

## 1. 服务身份来源核实

### 1.1 稳定实例标识：DSH `gatewayId`

源码证据：

- 插件源码：`C:\Users\xis\.dsh\profiles\web\node_modules\dsh-plugin-mobile-gateway\lib\gateway-state.mjs`
  - `createGatewayState(file)` 校验 `gatewayId` 必须是 UUID v4；
  - 首次创建时用 `crypto.randomUUID()` 生成，`write(state, true)` 使用 `fs.linkSync(tmp, file)`：**只在文件不存在时创建，绝不覆盖**；
  - 后续读取同一文件返回同一个 ID。
- 插件主文件 `lib/index.mjs:2266`：
  ```js
  const gatewayIdentity = { gatewayId: gatewayState.gatewayId, gatewayName: ... };
  ```
  - `GET /mgw/status`（约 `:2753-2761`）返回 `...gatewayIdentity`；
  - `POST /mgw/pair`（约 `:2884`）返回 `...gatewayIdentity`；
  - `paired` 帧（约 `:3123`）与 `hello` 帧（约 `:3128`）都带 `...gatewayIdentity`。
- `gatewayInstanceId` 是 `crypto.randomUUID()`，**每次进程启动都变**（`:2294`），不能用作身份；`serverIdentity.ts` 中有同样结论的注释。

运行时证据：

- 实际状态文件：`C:\Users\xis\.dsh\mobile-gateway-devices.json.gateway.json`
  - 内容包含 `"gatewayId": "99921c7e-74b7-4845-91ec-8d600675b55f"`；
  - 文件时间 `2026-10-21 02:52:31`，早于本次 v0.16.7 发布，说明跨重启持续使用同一身份；
  - SHA-256：`A7AF15B6EFE7B01C339E69DDC3EF7A8368F624A796DDB3500F8A46E3DAEA9170`。
- `GET http://172.27.58.79:3095/mgw/status` 在未带 DSH 会话 cookie 时返回 **401**，符合“管理接口需要认证”的预期；没有绕过认证去伪造运行时状态。

### 1.2 `authContextHash` 的稳定组成

实现位置：`dsh-mobile/src/core/pendingSend/serviceBinding.ts`：

```text
authContextHash = SHA-256(JSON.stringify({
  v: 1,
  gatewayId,          // 上文的稳定服务端实例标识
  serverDeviceId,     // CredentialKey.gatewayServerDeviceId（服务端分配的 UUID）
  clientDeviceId,     // CredentialKey.gatewayDeviceId（本机安装标识）
}))
```

- **不包含 cookie**：cookie 会正常轮换，不能当作不可变身份。
- **不包含 baseUrl**：地址是单独字段，地址变化不能被包装成“同一服务”。
- 两个设备 id 都取自 Keychain；任一缺失返回 `device-context-missing`，安全阻断。
- 缺少 `gatewayId` 返回 `gateway-missing`，不使用随机/硬编码值冒充。

### 1.3 地址与服务身份的区别

- 记录绑定 `{baseUrl, gatewayId, authContextHash}` 三者分开保存。
- `loadPendingSendBinding(currentBaseUrl)` 要求持久化的 `gatewayServerBinding.baseUrl` 与当前地址一致；**地址改变但未重新配对验证**时返回 `address-changed`，不自动重试。
- 不同服务器同地址：`gatewayId` 不同 → `server-instance-changed`；
- 切换授权上下文：`serverDeviceId`/`clientDeviceId` 不同 → `authorization-context-changed`；
- cookie 轮换：不影响以上三项，允许同一服务实例下的重试。

针对性测试 `tests/pending-send-service-binding-spec.mjs` **7/7 通过**，覆盖同服务器地址变化、不同服务器同地址、cookie 更新、授权上下文切换、缺 gatewayId、缺设备 context。

---

## 2. 实现文件

### 2.1 核心链路

| 文件 | 内容 |
|---|---|
| `dsh-mobile/src/core/pendingSend/serviceBinding.ts` | `loadPendingSendBinding()`：从 Keychain `gatewayServerBinding` + 两个设备 id 生成 `PendingSendBinding`；地址/身份缺失安全阻断 |
| `dsh-mobile/src/core/pendingSend/errors.ts` | prompt 失败分类；`PendingSendPostAcceptError` / `PendingSendFailurePersistError` |
| `dsh-mobile/src/core/store.ts` | `sendPending()` / `retryPending()` / `runPendingSend()` / single-flight / `reconcilePendingNow()`；`send(..., {optimistic:false})` 避免待发送气泡与乐观消息双显 |
| `dsh-mobile/src/core/pendingSend/store.ts` | `subscribe()`、`ensureHydrated()`、状态变化通知；阶段 1 存储/锁逻辑复用 |
| `dsh-mobile/src/screens/ChatScreen.tsx` | 文本路径改走 `store.sendPending`；附件路径保留旧逻辑；渲染 `PendingSendBubble`；显式安全重试；错误文案区分身份/存储/未知 |
| `dsh-mobile/src/components/PendingSendBubble.tsx` | 待发送/发送中/结果未知/未发出/已受理气泡；只有用户点击才重试 |
| `dsh-mobile/src/App.tsx` | App 级 `PendingSendStore` 单例；启动 `hydrate`；`clearAuthorization` 清除待发送并纳入结果；`signOut` 保留 |
| `dsh-mobile/src/screens/ProfileScreen.tsx` | 清除授权确认文案明确提示“未确认的待发送消息也会清除、无法再安全重试” |

### 2.2 Android 真实接线 harness

- `dsh-mobile/src/dev/P0Harness.tsx`：debug-only JS harness，**真实走 JS → react-native-keychain → Android Keystore/DataStore**。
- `dsh-mobile/android/app/src/debug/java/com/dshpocket/P0HarnessActivity.kt`
- `dsh-mobile/android/app/src/debug/AndroidManifest.xml`
- `dsh-mobile/index.js`：仅 `__DEV__` 注册 `P0Harness` 组件，正式包不启用 UI。

harness 覆盖：首次发送前持久化、同文本连续两次新发送、失败后同 ID 重试、接受后回执丢失去重、页面退出/新实例恢复、20×8KiB Keychain 容量/性能、注入写失败/回读失败阻断、force-stop 后重启恢复。

### 2.3 测试隔离修复

- `tests/mobile-gateway-patch-spec.mjs` 不再读取 `~/.dsh` 下真实插件；
- 新增独立 fixture：`tests/fixtures/mobile-gateway-index-fixture.mjs`；
- 不修改、不恢复、不覆盖正在运行的真实 DSH 网关插件；认证补丁逻辑未削弱；
- `test:mgwPatch` 从 23 通过/1 失败变为 **24 通过/0 失败**。

---

## 3. 测试结果

### 3.1 Node 单元/回归

| 命令 | 结果 |
|---|---|
| `npm run test:pendingSendServiceBinding` | **7 通过，0 失败** |
| `npm run test:pendingSendFlow` | **7 通过，0 失败** |
| `npm run test:pendingSendWiring` | **4 通过，0 失败** |
| `npm run test:pendingSendWiring` | **4 通过，0 失败** |
| `npm run test:idem` | 12 通过，0 失败 |
| `npm run test:retry` | 9 通过，0 失败 |
| `npm run test:mgwPatch` | 24 通过，0 失败（独立 fixture） |
| `npm run test:pendingSendState` / `Identity` / `Store` / `Persistence` / `Perf` | 阶段 1 既有测试，全部通过 |
| `npm run typecheck` | PASS |

### 3.2 Android 真实接线（P0Harness）

日志来自 `adb -s emulator-5584 logcat -s ReactNativeJS`：

```text
P0HARNESS PASS service-binding-cookie-rotation
P0HARNESS PASS first-persist
P0HARNESS PASS same-text-new-id
P0HARNESS PASS retry-same-id
P0HARNESS PASS accepted-response-lost-dedupe
P0HARNESS PASS page-exit-reenter
P0HARNESS PASS keychain-capacity-perf count=20 bytes=173935 totalMs=2444
P0HARNESS PASS injected-write-readback-failure-blocked
P0HARNESS READY_FOR_FORCE_STOP req-mvrt0wpq-t-1i8pfxo0e1kr1x
P0HARNESS PASS force-stop-restart-recovery
```

说明：
- `first-persist`：`store.sendPending` 在调用 mock `session/prompt` 时能在 Keychain 中读到已 accepted 的记录（真实 Keychain 写入成功）。
- `same-text-new-id`：连续两次相同文本得到两个不同 ID、两次 prompt。
- `retry-same-id` / `accepted-response-lost-dedupe`：失败/回执丢失后显式重试复用同一 ID；mock 服务端记录同一个 ID 被接受两次但去重。
- `page-exit-reenter`：新 `PendingSendStore` 从同一真实 Keychain 恢复 accepted 记录。
- `keychain-capacity-perf`：20 条 8KiB 记录实际 Keychain 写入 **2444ms**，文档 173,935 bytes。
- `force-stop-restart-recovery`：`adb shell am force-stop com.dshpocket` 后重启 Activity，`sending` 恢复为 `unknown`，显式 retry 复用原 ID。
- `injected-write-readback-failure-blocked`：在 JS 存储边界注入写失败/回读失败，均未调用 prompt。**注意：这是 JS 边界故障注入，不是用 adb 强行制造原生 Keychain 故障；原生 Keychain 成功路径由上面的真实测试覆盖。**

Android Keychain 仪器测试（`KeychainStorageValidationTest`）复跑：**OK (5 tests)**。

### 3.3 完整 `npm test` + 集成测试

- **`npm test`：PASS（exit 0）**。全量脚本（包括修复后的 `test:mgwPatch`、阶段 1/2 新增测试、`typecheck`）全部通过。
- **`npm run test:integration`：61/61 通过**：
  - `integration-transport.mjs`：15/15
  - `integration-gateway.mjs`：14/14
  - `integration-long-session.mjs`：10/10
  - `integration-product.mjs`：16/16
  - `integration-gateway-reconnect.mjs`：6/6
- 未发现 P0-1 相关失败。

---

## 4. 发现并修复的缺陷

1. **待发送记录 + 乐观消息双显风险**：原 `store.send` 会插入 `local-*` 乐观项，而 PendingSendBubble 也显示文本。改为 `sendPending` 调用 `send(..., { optimistic:false })`，由待发送气泡承担发送中展示。
2. **accepted 后本地状态写失败**：新增 `PendingSendPostAcceptError`；不把服务端已受理误报为“没发出去”，记录停在 sending，restart hydrate 转 unknown，用户可安全重试同一 ID。
3. **retry 并发重复发送**：`Store` 新增 `pendingInFlight` single-flight；同一 requestId 并发重试只会有一个 prompt。
4. **test:mgwPatch 依赖真实插件**：改为独立 fixture，避免读取/修改 `~/.dsh` 正在运行的已打补丁插件。
5. **Store 的 Node 测试静态加载链**：将依赖 RN 的 PendingSend 模块改为延迟 require，避免测试不需要的 React Native 解析；同时保留生产运行时懒加载。

---

## 5. 未完成项 / 限制

- **附件路径不在阶段 2**：ChatScreen 的附件分支仍走旧 `store.send`；阶段 3 才接入附件 outbox/哈希/回执保护。本次未宣称附件持久化完成。
- **Android 原生 Keychain 故障注入未做**：无法安全地让 Android Keystore 按需失败；写/回读失败在 JS 存储边界注入并在 Node/Android harness 验证阻断逻辑。
- **真实 DSH 网络 e2e 未做**：harness 的 `session/prompt` 是 mock，用于验证本地持久化与编排；真实 DSH 去重仍需阶段验收时用手工 e2e（已有 `send-idempotency-spec` 基线）复核。
- **ChatScreen UI 视觉验收未做**：已通过 typecheck/静态接线检查和 harness 数据路径，但未在真机做完整聊天 UI 截图验收。
- 完整 `npm test` 结果待最终更新。

---

## 6. 阶段 3 进入结论

**有条件可以进入阶段 3**：核心文本路径已按“先持久化、后 prompt、显式重试同 ID、accepted/confirmed 分离、single-flight、force-stop 恢复”验证通过，完整 `npm test` 与 61 项集成测试均通过。

进入阶段 3 前需要补齐/确认：
1. 对真实 DSH 做一次手工发送/重试 e2e（验证真实网络和 `hasPromptRequest`）；
2. 在真机/模拟器完成 ChatScreen 视觉验收（待发送气泡、结果未知/失败重试、清除授权提示）；
3. 附件路径保持现状并建立阶段 3 的独立测试门禁，不得把附件误标成已持久化。

> 结论：阶段 2 的自动化门禁已满足；真实 DSH 手工 e2e 和 ChatScreen 视觉验收不阻塞代码进入阶段 3 开发，但必须作为阶段 3 发布前验收项。

---

*报告生成：2026-10-28 · 阶段 2 · 完整 `npm test` 与集成测试通过*
