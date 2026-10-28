# P0-1 最终验收报告

日期：2026-10-28
分支：`feat/v0.17`
代码提交：`5d38cdf`（PairScreen 配对错误掩盖修复）
测试 APK：`dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk`
APK SHA-256：`8A7DA281654D149088D55717070946411F3E58D94D43351EFE6B295B033D36D8`
APK 元数据：`versionCode=1`、`versionName=1.0`、`minSdk=24`、`targetSdk=36`；debug 测试包
APK 签名：`CN=Android Debug, OU=Android`，证书 SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`（测试签名）
模拟器：`dsh_verify`（独立测试 AVD；未触碰正式验收 AVD）

## 0. 构建追溯

- 实际 Git HEAD：`13a838e`（文档提交）；代码提交 `5d38cdf`，回归测试提交 `9b641da`。
- 正常配对/文本证据使用 commit `5d38cdf` 的 debug 测试包。
- unknown 场景 A 的 `[P0_DROP]` 故障注入是临时 Debug-only 构建的未提交改动，测试后已撤销；未进入正式发布路径。
- 最终 clean APK SHA-256：`8A7DA281654D149088D55717070946411F3E58D94D43351EFE6B295B033D36D8`；versionCode 1 / versionName 1.0 / `CN=Android Debug`。
- 注：注入 APK 与 clean APK 不是同一字节文件；上表将每个测试对应到其测试构建，避免把临时注入包冒充最终构建。
- 所有测试 DSH 实例均为隔离实例（127.0.0.1:3097，adb reverse）；未触碰用户真实任务或正式验收 AVD。

## 1. 总结

**结论：B. P0-1 BLOCKED**

阻断项：

1. 最新测试 APK（commit `5d38cdf`，debug 测试包）已在 `dsh_verify` 完成真实 DSH 配对：`127.0.0.1:3097` 直连，首次 Token 交换 303 + Set-Cookie → 200，`/api/session/list` 成功，首页出现 2 个测试会话。
2. 真实 ChatScreen 文本发送已实际完成：用户消息 `P0-1finaltext`，服务端 `agent/inbox/spliced` 的 `user` 事件 rpcId 为 `req-mvs8lr4r-1-1en7ldl1lf720s`，仅 1 条用户消息；UI 无重复气泡。
3. 真实 ChatScreen unknown 安全重试、force-stop 恢复、图片/文件/混合附件选择器尚未完成。
4. 真实磁盘满/256MiB 上限压力注入：**NOT TESTED**。

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
| 清理失败、共享附件引用、孤儿回收、确认/放弃清理 | `pending-send-attachment-flow-spec` 19/19 |
| `npm test` | PASS，exit 0 |
| `npm run typecheck` | PASS |
| `npm run test:integration` | 61/61 |
| 真实 App 配对（`127.0.0.1:3097` 直连） | PASS：303/200、Cookie Jar 有 dsh-auth、`/api/session/list` 成功、首页加载 2 个会话 |
| 真实 ChatScreen 文本发送/accepted/confirmed | PASS：服务端 user 事件 rpcId `req-mvs8lr4r-1-1en7ldl1lf720s`，1 条消息；截图 `P0-1-FINAL-CHATSCREEN-TEXT.png` |
| 真实 ChatScreen unknown 场景 A（回执丢失 + 自动对账） | PASS：同 requestId `req-mvsb90p7-1-1mt0nc00enraf9` 进入 unknown 后由真实 WebSocket user 事件自动 confirmed；服务端 1 条消息；无残留气泡 |
| PairScreen 配对回归（登录成功后 ping 403/超时不得变体重试） | `pairing-spec` 13/13（测试提交 `9b641da`） |
| Android debug build | PASS（APK SHA-256 `8A7DA2...36D8`） |

## 3. FAIL / BLOCKED

| 项目 | 状态 | 原因 |
|---|---|---|
| 最新 APK 真实 DSH 配对 | **PASS** | 127.0.0.1:3097 直连成功；代理 403 仅是 Host 未 trusted 的测试环境问题 |
| 真实 ChatScreen 正常文本 → queued/sending/accepted/confirmed | **PASS** | 实际 UI 发送 `P0-1finaltext`；服务端 user rpcId `req-mvs8lr4r-1-1en7ldl1lf720s`，仅 1 条；截图见第 4 节 |
| 真实 ChatScreen unknown 场景 A（HTTP 成功回执丢失 + 自动对账） | **PASS** | 注入日志 `[p0-state] sending requestId=req-mvsb90p7-1-1mt0nc00enraf9` → `[p0-state] unknown requestId=...`；随后真实 WebSocket user 事件自动 reconcile 为 confirmed；UI 无残留待发送气泡，服务端仅 1 条用户消息 |
| 真实 ChatScreen unknown 场景 B（隔离确认事件 + 手动安全重试） | **NOT TESTED / BLOCKED** | 需要 Debug-only 隔离 session/follow/reconcile 事件，当前尚未完成；未伪造 unknown 按钮或重试结果 |
| 真实 ChatScreen force-stop 后恢复 | **NOT TESTED / BLOCKED** | 尚未完成可控 `[P0_PAUSE]` 持久化屏障 + force-stop 用例 |
| App 附件选择器图片/文件/混合发送 | **NOT TESTED / BLOCKED** | 尚未完成 App 附件选择器链路 |
| 真实磁盘满 / 256MiB 上限 | **NOT TESTED** | 未尝试填满用户磁盘；仅做故障注入/异常映射 |

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
- 真实 ChatScreen 的 unknown、force-stop、附件选择器尚未完成，未伪造结果。

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

## 7. 最小修复措施

1. 真实 App 配对已通过（`127.0.0.1:3097` + adb reverse）；无需再修改认证代码。
2. 继续完成真实 ChatScreen unknown 安全重试与 force-stop 恢复。
3. 用 App 附件选择器发送图片/文件/混合，并在真实 DSH `session/page` 验证 rpcId、附件和单条消息。
4. 在独立测试目录用可靠文件系统故障注入验证 256MiB/复制失败/空间不足；真实磁盘满保持 NOT TESTED。
5. 完成后重跑相关门禁，才可标记 P0-1 COMPLETE。

## 8. 未解决问题

- 真实 ChatScreen unknown 安全重试、force-stop 恢复未完成。
- 真实 App 附件选择器图片/文件/混合链路未完成。
- 错误 Token App 首次交换、已消费 Token App 用例未单独执行。
- 真实磁盘满未验证。
- `/mgw/status` 的 App 侧完整 gatewayId 记录未单独完成。

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
- 真实 UI 结果：**NOT COMPLETED**。本轮构建/配对后，ChatScreen 导航操作未稳定落到目标会话，未获得 unknown + 安全重试按钮的实际 UI 证据，因此任务 A 不标记 PASS。

## 10. 最终结论

**P0-1 BLOCKED。** 真实 App 配对与文本发送 PASS，但 unknown 安全重试、force-stop 恢复及附件选择器关键链路未通过，因此不标记 COMPLETE、不合并 `main`、不移动 `v0.16.7` Tag、不创建 GitHub Release。

---

*报告维护：2026-10-28 · 具体文档提交见 `feat/v0.17` Git 历史。*
