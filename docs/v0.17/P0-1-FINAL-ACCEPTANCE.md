# P0-1 最终验收报告

日期：2026-10-29
分支：`feat/v0.17`
代码提交：`5d38cdf`（PairScreen 修复）、`9c0adce` & `f0feb80`（任务 A）、`bae61c9`（任务 B）、本轮任务 C 修复提交
测试 APK：`dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk`
APK SHA-256：`C5AABF2DC4D65B1FB1080D07576F2A20FB7700E3E4ADB4485B66904DC9476E39`
APK 元数据：`versionCode=1`、`versionName=1.0`、`minSdk=24`、`targetSdk=36`；debug 测试包
APK 签名：`CN=Android Debug, OU=Android`，证书 SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`（测试签名）
模拟器：`dsh_verify`（独立测试 AVD；未触碰正式验收 AVD）

## 0. 构建追溯

- 实际 Git HEAD：`13a838e`（文档提交）；代码提交 `5d38cdf`，回归测试提交 `9b641da`。
- 正常配对/文本证据使用 commit `5d38cdf` 的 debug 测试包。
- unknown 场景 A 的 `[P0_DROP]` 故障注入是临时 Debug-only 构建的未提交改动，测试后已撤销；未进入正式发布路径。
- 最终测试 APK SHA-256：`C5AABF2DC4D65B1FB1080D07576F2A20FB7700E3E4ADB4485B66904DC9476E39`；versionCode 1 / versionName 1.0 / `CN=Android Debug`。
- 注：注入 APK 与 clean APK 不是同一字节文件；上表将每个测试对应到其测试构建，避免把临时注入包冒充最终构建。
- 所有测试 DSH 实例均为隔离实例（127.0.0.1:3097，adb reverse，`lanPort: 3082`）；未触碰用户真实任务或正式验收 AVD。

## 1. 总结

**结论：A. P0-1 COMPLETE（任务 A / B / C 全部 PASS）**

验收完成摘要：

1. 最新测试 APK 已在 `dsh_verify` 完成真实 DSH 配对：`127.0.0.1:3097` 直连，首次 Token 交换 303 + Set-Cookie → 200，`/api/session/list` 成功。
2. 真实 ChatScreen 正常文本发送已实际完成：用户消息 `P0-1finaltext`，服务端 `agent/inbox/spliced` 的 `user` 事件 rpcId 为 `req-mvs8lr4r-1-1en7ldl1lf720s`，仅 1 条用户消息；UI 无重复气泡。
3. 真实 ChatScreen unknown 安全重试（任务 A）、force-stop 持久化恢复（任务 B）、以及真实 Android 系统选择器（PhotoPicker + DocumentsUI）图片/文件/混合附件发送（任务 C）均已全部 **PASS**。
4. 受控容量上限（`attachment-too-large`）、暂存空间不足（`staging-full`）与文件复制失败（`attachment-copy-failed`）已通过 `ReactNativePendingSendStaging` 真实文件系统测试（23/23 PASS，不填满真实磁盘）。

### 1.1 HTTP 401 诊断

- 原始 DSH `dsh-web-3095.log` 记录了启动 token URL；同一进程的 token 已使用过多轮。
- DSH 源码 `dsh-client-connection/lib/index.js:294-299` 显示 launch token 是进程级 256-bit 随机值、进程存活期间可重复匹配；`cookieMaxAgeDays` 默认 30 天，因此不能把 401 直接归因于一次性/过期 token。
- 脱敏代理链路已抓到：首次 `GET /?token=...` → **303 + Set-Cookie**；跟随 `GET /` → **200**；Native Cookie Jar 读到 `dsh-auth`；随后 `POST /api/session/list` → **403**；之后 `GET /` 无 token/Cookie → **401**。
- 最终 401 的准确位置：`PairScreen` 在 ping 403 后把第一个正确 token 判为失败，清空 Cookie Jar 并用 `-`/`_` 变体再次 `loginWithToken`；第二次请求返回 401 并覆盖真实 403。不是首次 token 交换失败，也不是 Cookie Jar 未保存。
- 修复提交 `5d38cdf`：登录成功后 ping 失败不再尝试变体 token，避免 403 被 401 掩盖。详细证据见 [PAIRING-401-ROOT-CAUSE.md](PAIRING-401-ROOT-CAUSE.md)。
- 未关闭身份检查、未硬编码 gatewayId、未改认证补丁；没有把 token/cookie 原文写入报告或提交。

## 2. PASS

| 项目 | 证据 |
|---|---|
| 真实 DSH 文本正常发送、accepted、同 requestId 去重 | `PHASE-3-REAL-DSH-EVIDENCE.md`，`REAL_DSH_PROBE=PASS` |
| 真实 DSH 图片/文件/混合 `uploadFileBinary → prompt → page` | `PHASE-3-REAL-DSH-EVIDENCE.md`，`REAL_DSH_ATTACHMENTS=PASS` |
| 上传成功但 prompt 回执丢失、上传中断、非法 receipt、prompt 明确失败 | 真实 DSH 独立脚本，输出见证据文件 |
| App 运行时远端身份探针（真实 Keychain Cookie + 绑定） | `REAL_PROBE={"status":200,"gatewayId":"99921c7e-...b55f"}` |
| 过期语义按 `expiredFrom` 区分 queued/unknown/accepted | `pending-send-store-spec` 15/15 |
| 清理失败、共享附件引用、孤儿回收、确认/放弃清理、受控容量/空间不足/复制失败 | `pending-send-attachment-flow-spec` 23/23 |
| `npm test` | PASS，exit 0 |
| `npm run typecheck` | PASS |
| `npm run test:integration` | 61/61 |
| 真实 App 配对（`127.0.0.1:3097` 直连） | PASS：303/200、Cookie Jar 有 dsh-auth、`/api/session/list` 成功、首页加载 2 个会话 |
| 真实 ChatScreen 文本发送/accepted/confirmed | PASS：服务端 user 事件 rpcId `req-mvs8lr4r-1-1en7ldl1lf720s`，1 条消息；截图 `P0-1-FINAL-CHATSCREEN-TEXT.png` |
| 真实 ChatScreen unknown 场景 A（回执丢失 + 自动对账） | PASS：同 requestId `req-mvsb90p7-1-1mt0nc00enraf9` 进入 unknown 后由真实 WebSocket user 事件自动 confirmed；服务端 1 条消息；无残留气泡 |
| 真实 ChatScreen unknown 场景 B / 任务 A（隔离确认事件 + UI 手动安全重试） | **PASS**：requestId `req-mvsjv5ct-1-09qobvt0sqavwy` 真实 UI 点击安全重试后解除隔离、收到 `user/message` 事件、进入 `confirmed` 并完成 Keychain 清理，服务端仅 1 条用户消息 |
| 真实 ChatScreen force-stop 后恢复（任务 B） | **PASS**：requestId `req-mvsm6uw7-1-05gvoa41g8sjnr` 在 `sending` 持久化后、`session/prompt` 前暂停并 `adb force-stop`；重启后 `hydrate` 恢复为 `unknown` 且不自动重发（服务端 `USER_MESSAGES=0`）；真实 UI 点击安全重试后 `confirmed` 并从 Keychain 清理，服务端仅 1 条用户消息 |
| 真实 ChatScreen 附件选择器图片/文件/混合发送（任务 C） | **PASS**：通过真实 Android PhotoPicker 与 DocumentsUI 选择并发送纯图片（`req-mvsnr23r-1-1gpmikx06ltz6c`）、纯文件（`req-mvsnzs0v-1-05ahjh31bsac6k`）、图片+文件混合（`req-mvso2yza-1-0h2ugin0n2jnmm`），验证私有暂存、SHA-256、上传回执、服务端唯一 `user/message`、`confirmed` 及 Keychain/私有暂存目录清理 |
| PairScreen 配对回归（登录成功后 ping 403/超时不得变体重试） | `pairing-spec` 13/13（测试提交 `9b641da`） |
| Android debug build | PASS（APK SHA-256 `C5AABF...6E39`） |

## 3. 核心验收项状态表

| 项目 | 状态 | 证据与说明 |
|---|---|---|
| 最新 APK 真实 DSH 配对 | **PASS** | 127.0.0.1:3097 直连成功；代理 403 仅是 Host 未 trusted 的测试环境问题 |
| 真实 ChatScreen 正常文本 → queued/sending/accepted/confirmed | **PASS** | 实际 UI 发送 `P0-1finaltext`；服务端 user rpcId `req-mvs8lr4r-1-1en7ldl1lf720s`，仅 1 条；截图见第 4 节 |
| 真实 ChatScreen unknown 场景 A（HTTP 成功回执丢失 + 自动对账） | **PASS** | 注入日志 `[p0-state] sending requestId=req-mvsb90p7-1-1mt0nc00enraf9` → `[p0-state] unknown requestId=...`；随后真实 WebSocket user 事件自动 reconcile 为 confirmed；UI 无残留待发送气泡，服务端仅 1 条用户消息 |
| 真实 ChatScreen unknown 场景 B / 任务 A（隔离确认事件 + 手动安全重试） | **PASS** | 真实 ChatScreen 发送 `[P0_BLOCK]TaskA_OK`（`req-mvsjv5ct-1-09qobvt0sqavwy`）→ unknown 稳定停留（截图 `P0-1-FINAL-CHATSCREEN-UNKNOWN.png`）→ 真实 UI 点击「安全重试（复用原 ID）」→ 恢复对账 → `confirmed` & `pruned-from-keychain`，服务端 `session/page` 仅 1 条 `user/message`（截图 `P0-1-FINAL-CHATSCREEN-CONFIRMED.png`） |
| 真实 ChatScreen force-stop 后恢复（任务 B） | **PASS** | 真实 ChatScreen 发送 `[P0_PAUSE]TaskB_OK`（`req-mvsm6uw7-1-05gvoa41g8sjnr`）→ `sending` 落盘后、`session/prompt` 前暂停（截图 `P0-1-TASKB-SENDING.png`）→ `adb force-stop`（服务端 `USER_MESSAGES=0`）→ 重启恢复为 `unknown` 且不自动重发（截图 `P0-1-TASKB-RECOVERED-UNKNOWN.png`）→ 真实 UI 点击「安全重试（复用原 ID）」→ `confirmed` & `pruned-from-keychain`，服务端仅 1 条 `user/message`（截图 `P0-1-TASKB-CONFIRMED.png`） |
| App 附件选择器图片/文件/混合发送（任务 C） | **PASS** | 真实 Android PhotoPicker / DocumentsUI 选择并发送纯图片、纯文件、图片+文件混合消息，全部完成私有暂存、SHA-256 校验、上传回执、服务端唯一消息对账、`confirmed` 与 Keychain/暂存目录清空（见第 9C 节） |
| 受控容量上限 / 空间不足 / 复制失败（不填满真实磁盘） | **PASS** | `ReactNativePendingSendStaging` 受控上限注入验证 `attachment-too-large`、`staging-full`、`attachment-copy-failed` 均安全阻断并回滚已复制文件（`pending-send-attachment-flow-spec` 23/23 PASS） |

## 4. 真实 App / 模拟器证据

- 真实 App 配对：`dsh_verify` + 隔离 DSH `127.0.0.1:3097`（adb reverse），首页显示 1 个目录、2 个会话。
- 真实 ChatScreen 实际 UI 发送：
  - 消息文本：`P0-1finaltext`
  - 会话：`session-ea7ca051-be8a-46fd-9a36-140e98bcbfd0`
  - 服务端 `agent/inbox/spliced` 的 user 事件 rpcId：`req-mvs8lr4r-1-1en7ldl1lf720s`
  - 服务端用户消息数量：**1**
  - UI 截图：[P0-1-FINAL-CHATSCREEN-TEXT.png](P0-1-FINAL-CHATSCREEN-TEXT.png)
- 旧调试构建的实际 failed 状态截图 `PHASE-4-ACTUAL-CHATSCREEN-FAILED.png` 仅作历史对照，不作为当前 PASS 证据。
- fixture unknown/accepted 截图 `PHASE-3-CHATSCREEN-PENDING.png` 仅视觉 fixture，不计入 PASS。
- 真实 ChatScreen 的 unknown（任务 A）、force-stop（任务 B）、附件选择器（任务 C）均已使用真实 UI + 隔离 DSH 完成端到端验证（详见第 9 / 9B / 9C 节）。

## 5. 真实 DSH 服务端证据

见 [PHASE-3-REAL-DSH-EVIDENCE.md](PHASE-3-REAL-DSH-EVIDENCE.md)：

- 文本正常 accepted、回执丢失重试、同 requestId 不同内容去重；
- 图片/文件/混合真实上传与 prompt；
- 无效 receipt 明确 `attachment-invalid`；
- 上传中断恢复；
- 均使用独立临时会话，未触碰用户任务。

## 6. mock / fixture 证据

- `pending-send-attachment-flow-spec` 使用 `MemoryStaging` + mock prompt/upload；
- `pending-send-send-flow-spec` 使用 mock `session/prompt`；
- `P0Harness` 是 Debug-only harness，不能替代真实 ChatScreen；
- 本报告明确不把这些结果计为真实 App 端到端通过。

## 7. 已落地的最小修复汇总

1. **PairScreen 配对错误掩盖修复（`5d38cdf` / `9b641da`）**：登录成功后 `store.ping()` 失败不再尝试 `-`/`_` 变体 token，避免 403/网络错误被 401 掩盖。
2. **React Native Android WebSocket 鉴权修复（`f0feb80`）**：在 `DshConnection.openWebSocket` 中为 RN 环境显式传入 `{ headers: { Cookie } }`，解决 `/api/remote.mux` 升级握手 401 导致无法收到 `session/follow` 确认事件的问题。
3. **Android SAF `content://` 附件私有暂存修复（本轮任务 C）**：`react-native-blob-util` 的 `copyToInternal` 挂载在 `ReactNativeBlobUtil.MediaCollection.copyToInternal`，且 `fs.cp` 原生支持 `content://` 流复制；更新 `ReactNativePendingSendStaging.stage()` 优先调用 `MediaCollection.copyToInternal` 并回退 `fs.cp(source, target)`，修复了从 Android 系统选择器选图/选文件后暂存报 `当前平台不支持 content:// 复制` 的问题。

## 8. 边界说明（非阻断项）

- 真实磁盘填满（256MiB 物理写满宿主磁盘）按安全规范不执行；已通过 `ReactNativePendingSendStaging` 受控阈值测试验证 `attachment-too-large`、`staging-full`、`attachment-copy-failed` 的拒绝与回滚语义。

## 9. 任务 A：手动安全重试（本轮实现）

- 代码提交：`9c0adce`
- 新增 `dsh-mobile/src/dev/p0Verify.ts`：
  - 仅 Debug 调用；
  - 按 requestId 精确 block/unblock 确认；
  - `[P0_BLOCK]` 测试消息创建后 block 对应 requestId；
  - `reconcilePendingNow()` 对所有被 block 的 requestId 跳过自动 confirm；
  - 用户点击真实 retry 时 debug-only 解除 block。
- 覆盖确认入口：当前源码只有 `reconcilePendingNow()` 会执行 `confirm`；WebSocket/snapshot 最终都调用该入口。
- 自动化：`npx tsx tests/p0-verify-spec.mjs` **3/3 PASS**；`npx tsx tests/p0-verify-behavior-spec.mjs` **4/4 PASS**；typecheck PASS。行为测试覆盖一次性注入、同 requestId 重试、提前确认隔离、身份验证失败不解除、confirmed 清理和其他 requestId 不受影响。
- 真实 UI 结果：**TASK A PASS**
  - **服务端根因与预检**：隔离 DSH 实例（port 3097，独立 `DSH_HOME`/`DSH_STATE_DIR`，`lanPort: 3082`）拥有完整可用的 `sessionController`。启动第一秒的 `active Service "sessionController" is unavailable` 只是 `dsh-plugin-mobile-gateway` 早于 `workspaceRegistry` 异步初始化完成的首次探活日志；此前客户端收不到 `confirmed` 事件的真实根因是：React Native Android (OkHttp) 的 `new WebSocket(url)` 不会自动附带 `CookieManager` 里的 cookie，必须在 `DshConnection.openWebSocket` 第 3 个参数显式传入 `{ headers: { Cookie } }`，否则 `/api/remote.mux` 握手返回 401。预检已通过全部 6 项（`session/create`、`session/prompt`、`session/page`、`source.rpcId`、`session/follow`、同 `requestId` 去重无重复消息）。
  - 真实 ChatScreen 进入独立会话 `session-16bfb704-dadf-44ca-bd43-fda6f8ce3645`，发送测试消息 `[P0_BLOCK]TaskA_OK`；
  - 状态迁移与隔离日志：
    - `[p0-verify] arm requestId=req-mvsjv5ct-1-09qobvt0sqavwy`
    - `[p0-verify] suppressed confirm requestId=req-mvsjv5ct-1-09qobvt0sqavwy`
    - `[p0-verify] unknown requestId=req-mvsjv5ct-1-09qobvt0sqavwy`
  - 真实 UI 稳定显示「结果未知」与「安全重试（复用原 ID）」按钮（截图：[P0-1-FINAL-CHATSCREEN-UNKNOWN.png](P0-1-FINAL-CHATSCREEN-UNKNOWN.png)）；
  - 真实 UI 点击「安全重试（复用原 ID）」按钮后，日志确认同一 `requestId` 解锁、确认并从 Keychain 清理：
    - `[p0-verify] release-after-retry requestId=req-mvsjv5ct-1-09qobvt0sqavwy`
    - `[p0-verify] confirmed requestId=req-mvsjv5ct-1-09qobvt0sqavwy`
    - `[p0-verify] pruned-from-keychain requestId=req-mvsjv5ct-1-09qobvt0sqavwy`
  - 服务端 `session/page`（`throughSeq=34`）验证该会话仅存在 **1 条**用户消息：`seq=8, rpcId=req-mvsjv5ct-1-09qobvt0sqavwy, text=[P0_BLOCK]TaskA_OK`；
  - 确认后 UI 截图（无重复气泡、无残留重试按钮）：[P0-1-FINAL-CHATSCREEN-CONFIRMED.png](P0-1-FINAL-CHATSCREEN-CONFIRMED.png)

## 9B. 任务 B：真实 Android App force-stop 后持久化恢复（本轮实现）

- 真实 UI 结果：**TASK B PASS**
- Debug-only 屏障机制：
  - 在 `p0Verify.ts` 中新增 `armP0PauseBeforePrompt(requestId)` 与一次性 `shouldPauseP0BeforePrompt(requestId)`（均受 `__DEV__` 保护，Release 完全不生效）；
  - 当真实 ChatScreen 发送包含 `[P0_PAUSE]` 的消息时，`runPendingSend()` 在完成 `this.pendingSends.apply(requestId, { type: 'begin-send' })`（已写入 Keychain 并回读确认 `sending`）之后、调用 `this.send(...)` 发出 `session/prompt` 之前暂停。
- 自动化行为测试：`npx tsx tests/p0-verify-behavior-spec.mjs` **5/5 PASS**。
- 真实 Android 模拟器（`dsh_verify` / `emulator-5584`）+ 隔离 DSH（`127.0.0.1:3097`）端到端步骤与证据：
  1. 独立会话：`session-f3417604-0b28-4387-ba03-cf7e6fd2ae14`，发送测试消息 `[P0_PAUSE]TaskB_OK`；
  2. 暂停屏障命中日志：
     - `[p0-verify] arm-pause requestId=req-mvsm6uw7-1-05gvoa41g8sjnr`
     - `[p0-verify] paused-before-prompt requestId=req-mvsm6uw7-1-05gvoa41g8sjnr`
     - 暂停时 UI 显示「发送中…」（截图：[P0-1-TASKB-SENDING.png](P0-1-TASKB-SENDING.png)）；
  3. 执行 `adb shell am force-stop com.dshpocket`，查询服务端 `session/page`：`AS_OF_SEQ=2 TOTAL_RECORDS=3 USER_MESSAGES=0`（确认 `session/prompt` 尚未发出）；
  4. 重启 App 并进入该会话，日志确认原 `requestId` 从 `sending` 恢复为 `unknown`：
     - `[p0-verify] hydrate-recover requestId=req-mvsm6uw7-1-05gvoa41g8sjnr from=sending to=unknown`
     - `[p0-verify] hydrated-unknown requestId=req-mvsm6uw7-1-05gvoa41g8sjnr`
  5. 验证重启后**不会自动重新发送**：查询服务端 `session/page` 仍为 `AS_OF_SEQ=2 TOTAL_RECORDS=3 USER_MESSAGES=0`；UI 显示「结果未知，可能已在电脑执行」及「安全重试（复用原 ID）」按钮（截图：[P0-1-TASKB-RECOVERED-UNKNOWN.png](P0-1-TASKB-RECOVERED-UNKNOWN.png)）；
  6. 真实 UI 点击「安全重试（复用原 ID）」，日志确认同一 `requestId` 完成发送、收到 `user/message` 对账确认并从 Keychain 清理：
     - `[p0-verify] confirmed requestId=req-mvsm6uw7-1-05gvoa41g8sjnr`
     - `[p0-verify] pruned-from-keychain requestId=req-mvsm6uw7-1-05gvoa41g8sjnr`
  7. 服务端 `session/page`（`throughSeq=19`）确认该会话仅存在 **1 条**用户消息：`seq=8, rpcId=req-mvsm6uw7-1-05gvoa41g8sjnr, text=[P0_PAUSE]TaskB_OK`；
  8. 确认并清理后 UI 截图（无重复气泡、无残留待发送卡片）：[P0-1-TASKB-CONFIRMED.png](P0-1-TASKB-CONFIRMED.png)

## 9C. 任务 C：真实 Android ChatScreen 附件发送（图片 / 文件 / 混合）

- 真实 UI 结果：**TASK C PASS**
- 发现并修复的真实缺陷：
  - `@react-native-documents/picker` 在 Android SAF（PhotoPicker / DocumentsUI）下返回 `content://` URI；
  - `react-native-blob-util` 的 `copyToInternal` 位于 `ReactNativeBlobUtil.MediaCollection.copyToInternal`（而非 `fs.copyToInternal`），导致首次真实 UI 发送图片时报错 `发送失败：当前平台不支持 content:// 复制`；
  - 已在 `dsh-mobile/src/core/pendingSend/staging.ts` 中最小修复：对 `content://` 源优先调用 `MediaCollection.copyToInternal`，若不存在则调用原生支持 `ContentResolver.openInputStream` 的 `fs.cp(source, target)`。
- 受控容量上限、空间不足与复制失败测试（不填满真实磁盘）：
  - 在 `tests/pending-send-attachment-flow-spec.mjs` 中补充 4 项针对真实 `ReactNativePendingSendStaging` 的受控测试（`attachment-too-large`、`staging-full`、`attachment-copy-failed`、`content://` 复制），**23/23 PASS**。
- 真实 Android 模拟器（`dsh_verify` / `emulator-5584`）+ 隔离 DSH（`127.0.0.1:3097`）三类场景端到端证据：
  1. **场景 1：纯图片发送（Android PhotoPicker）**
     - 会话：`session-4eef012d-9295-4edf-9f2a-cc2fb3ff14a5`，`requestId=req-mvsnr23r-1-1gpmikx06ltz6c`
     - 客户端日志：
       - `[p0-verify] staged kind=image name=1000000136.png size=178 sha256=8df27e46ef1ae284e479dfd0b076bd8f8cfebfba75062808fcb1bea69fdc30b1 stagedUri=/data/user/0/com.dshpocket/files/dsh-pending-send/1793224808693-zxqq3lto-1000000136.png`
       - `[p0-verify] sending requestId=req-mvsnr23r-1-1gpmikx06ltz6c attachments=1`
       - `[p0-verify] confirmed requestId=req-mvsnr23r-1-1gpmikx06ltz6c`
       - `[p0-verify] staged-removed name=1000000136.png ...`
       - `[p0-verify] pruned-from-keychain requestId=req-mvsnr23r-1-1gpmikx06ltz6c`
     - 服务端 `session/page`：仅 **1 条** `user/message`（`seq=8, rpcId=req-mvsnr23r-1-1gpmikx06ltz6c`），包含 `text: "TaskC_Image_OK"` 与 `image`（`attachmentId: "sha256:8df27e46ef1ae284e479dfd0b076bd8f8cfebfba75062808fcb1bea69fdc30b1"`, `64x64`, `178 B`）。
     - 截图：草稿 [P0-1-TASKC-IMAGE-DRAFT.png](P0-1-TASKC-IMAGE-DRAFT.png) · 确认后 [P0-1-TASKC-IMAGE-CONFIRMED.png](P0-1-TASKC-IMAGE-CONFIRMED.png)
  2. **场景 2：纯文件发送（Android DocumentsUI）**
     - 会话：`session-19b33bc9-61b6-45d4-b0d5-b8f9254b2059`，`requestId=req-mvsnzs0v-1-05ahjh31bsac6k`
     - 客户端日志：
       - `[p0-verify] staged kind=file name=p0c_note.txt size=51 sha256=ea0e10ba9bc854f56bf44e9eb56c930ca45105afcc187b85e280364b5c5f28f0 stagedUri=/data/user/0/com.dshpocket/files/dsh-pending-send/1793225215705-dmvf3uc5-p0c_note.txt`
       - `[p0-verify] uploaded requestId=req-mvsnzs0v-1-05ahjh31bsac6k name=p0c_note.txt receiptId=809ffb04-5ae0-4342-8bc8-c79d1771efa6 attachmentId=sha256:ea0e10ba9bc854f56bf44e9eb56c930ca45105afcc187b85e280364b5c5f28f0`
       - `[p0-verify] sending requestId=req-mvsnzs0v-1-05ahjh31bsac6k attachments=1`
       - `[p0-verify] confirmed requestId=req-mvsnzs0v-1-05ahjh31bsac6k`
       - `[p0-verify] staged-removed name=p0c_note.txt ...`
       - `[p0-verify] pruned-from-keychain requestId=req-mvsnzs0v-1-05ahjh31bsac6k`
     - 服务端 `session/page`：仅 **1 条** `user/message`（`seq=8, rpcId=req-mvsnzs0v-1-05ahjh31bsac6k`），包含 `text: "TaskC_File_OK"` 与 `file`（`attachmentId: "sha256:ea0e10ba9bc854f56bf44e9eb56c930ca45105afcc187b85e280364b5c5f28f0"`, `name: "p0c_note.txt"`, `bytes: 51`）。
     - 截图：草稿 [P0-1-TASKC-FILE-DRAFT.png](P0-1-TASKC-FILE-DRAFT.png) · 确认后 [P0-1-TASKC-FILE-CONFIRMED.png](P0-1-TASKC-FILE-CONFIRMED.png)
  3. **场景 3：图片 + 文件混合发送（PhotoPicker + DocumentsUI）**
     - 会话：`session-4dfa4399-aa17-44d9-849b-9711d7b0d7d5`，`requestId=req-mvso2yza-1-0h2ugin0n2jnmm`
     - 客户端日志：
       - `[p0-verify] staged kind=image name=1000000136.png size=178 sha256=8df27e46ef1ae284e479dfd0b076bd8f8cfebfba75062808fcb1bea69fdc30b1 ...`
       - `[p0-verify] staged kind=file name=p0c_note.txt size=51 sha256=ea0e10ba9bc854f56bf44e9eb56c930ca45105afcc187b85e280364b5c5f28f0 ...`
       - `[p0-verify] uploaded requestId=req-mvso2yza-1-0h2ugin0n2jnmm name=p0c_note.txt receiptId=d8e70096-632a-4eed-9c9f-a209da092a68 attachmentId=sha256:ea0e10ba9bc854f56bf44e9eb56c930ca45105afcc187b85e280364b5c5f28f0`
       - `[p0-verify] sending requestId=req-mvso2yza-1-0h2ugin0n2jnmm attachments=2`
       - `[p0-verify] confirmed requestId=req-mvso2yza-1-0h2ugin0n2jnmm`
       - `[p0-verify] staged-removed name=1000000136.png ...`
       - `[p0-verify] staged-removed name=p0c_note.txt ...`
       - `[p0-verify] pruned-from-keychain requestId=req-mvso2yza-1-0h2ugin0n2jnmm`
     - 服务端 `session/page`：仅 **1 条** `user/message`（`seq=8, rpcId=req-mvso2yza-1-0h2ugin0n2jnmm`），同时包含 `text`、`image`（`178 B`）和 `file`（`p0c_note.txt`, `51 B`）。
     - 私有暂存目录核查：`adb shell run-as com.dshpocket ls -la /data/user/0/com.dshpocket/files/dsh-pending-send` 确认目录已完全清空（仅 `.` 与 `..`）。
     - 截图：草稿 [P0-1-TASKC-MIXED-DRAFT.png](P0-1-TASKC-MIXED-DRAFT.png) · 确认后 [P0-1-TASKC-MIXED-CONFIRMED.png](P0-1-TASKC-MIXED-CONFIRMED.png)

## 10. 最终结论

**P0-1 COMPLETE。** 真实 App 配对、正常文本发送、任务 A（unknown 手动安全重试）、任务 B（force-stop 持久化恢复与安全重试）、任务 C（真实系统选择器图片/文件/混合附件发送与受控异常测试）已全部验证通过，相关回归测试全部 PASS，无高风险缺陷。按指令保持在 `feat/v0.17` 分支，不合并 `main`、不移动 `v0.16.7` Tag、不创建 GitHub Release。

---

*报告维护：2026-10-28 · 具体文档提交见 `feat/v0.17` Git 历史。*
