# P0-1 最终验收报告

日期：2026-10-28
分支：`feat/v0.17`
代码提交：`5d38cdf`（PairScreen 配对错误掩盖修复）
测试 APK：`dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk`
APK SHA-256：`01A30A444DACCC799A6F2DC0B3A9BBD93A10240E10FA091C4FDED05A7779745F`
APK 元数据：`versionCode=1`、`versionName=1.0`、`minSdk=24`、`targetSdk=36`；debug 测试包
APK 签名：`CN=Android Debug, OU=Android`，证书 SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`（测试签名）
模拟器：`dsh_verify`（独立测试 AVD；未触碰正式验收 AVD）

## 1. 总结

**结论：B. P0-1 BLOCKED**

阻断项：

1. 最新 release 测试 APK（commit `2988688`）在 `dsh_verify` 安装成功，但真实 DSH 配对 token 返回 HTTP 401（`token exchange failed: HTTP 401`），无法在该 APK 上完成真实 ChatScreen 配对。
2. 因此真实 ChatScreen accepted/confirmed 用户操作、unknown 回执丢失重试、force-stop 恢复均未在最新 APK 上完成。
3. App 附件选择器发送图片/文件/混合消息也未完成；真实 DSH 附件链路只由独立脚本验证，不能冒充 App 端到端。
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
| Android debug build | PASS |

## 3. FAIL / BLOCKED

| 项目 | 状态 | 原因 |
|---|---|---|
| 最新 APK 真实 DSH 配对 | **FAIL / PARTIAL** | 首次 token 交换已 PASS（303 + Set-Cookie → 200，Cookie Jar 有 dsh-auth）；`/api/session/list` 403 后旧 PairScreen 用变体 token 重试得到 401。修复后 UI 尚未重新完成完整配对 |
| 真实 ChatScreen 正常文本 → queued/sending/accepted/confirmed | **NOT TESTED / BLOCKED** | 完整配对未完成；旧构建的 accepted/confirmed 不是当前验收 |
| 真实 ChatScreen unknown → 用户点击安全重试 | **NOT TESTED / BLOCKED** | 同上 |
| 真实 ChatScreen force-stop 后恢复 | **NOT TESTED / BLOCKED** | 同上 |
| App 附件选择器图片/文件/混合发送 | **NOT TESTED / BLOCKED** | 完整配对未完成，未进入 ChatScreen |
| 真实磁盘满 / 256MiB 上限 | **NOT TESTED** | 未尝试填满用户磁盘；仅做故障注入/异常映射 |

## 4. 真实 App / 模拟器证据

- 脱敏代理已证明 Android 首次 Token 交换：`GET /?token=...` → 303 + Set-Cookie；跟随 `GET /` → 200；Cookie Jar `dsh-auth` present；详见 [PAIRING-401-ROOT-CAUSE.md](PAIRING-401-ROOT-CAUSE.md)。
- 最终 401 来自 `PairScreen` 的变体 token 重试；修复提交 `5d38cdf`。
- 旧调试构建的实际用户操作 failed 状态：
  `docs/v0.17/PHASE-4-ACTUAL-CHATSCREEN-FAILED.png`（实际 UI，但不是最新 APK 的 accepted/confirmed 证据）。
- fixture unknown/accepted 截图：`PHASE-3-CHATSCREEN-PENDING.png`，仅视觉 fixture，不计入 PASS。
- 修复后的 debug APK 已构建，未完成完整配对后的 ChatScreen 测试；未伪造 UI 结果。

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

1. 将测试代理 Host 加入隔离 DSH 的 `--trusted-host`，或直接使用 DSH 可信 Host，消除 `/api/session/list` 403。
2. 使用独立 DSH 测试实例的新 token 重新配对修复后的 APK，先证明正确 token 成功、错误 token 401。
3. 在 `dsh_verify` 上重新执行真实 ChatScreen 文本 accepted/confirmed、unknown 重试、force-stop 恢复。
4. 用 App 附件选择器发送图片/文件/混合，并在真实 DSH `session/page` 验证 requestId、附件和单条消息。
5. 在独立测试目录用可靠文件系统故障注入验证 256MiB/复制失败/空间不足；真实磁盘满保持 NOT TESTED。
6. 完成上述后重跑 `npm test`、`typecheck`、61 项集成测试和 Android 测试，才可标记 P0-1 COMPLETE。

## 8. 未解决问题

- 完整配对仍被测试环境 Host/trust 与 UI 自动化阻断；需要重跑修复后的 APK。
- 真实 ChatScreen 文本/附件端到端未完成。
- 错误 Token App 首次交换、已消费 Token App 用例未单独执行。
- 真实磁盘满未验证。

## 9. 最终结论

**P0-1 BLOCKED。** 不标记 COMPLETE，不合并 `main`，不移动 `v0.16.7` Tag，不创建 GitHub Release。待真实 DSH 配对 token 恢复并在最新 APK 上完成真实 ChatScreen 文本/附件端到端后，才能重新评估 A. P0-1 COMPLETE。

---

*报告维护：2026-10-28 · 具体文档提交见 `feat/v0.17` Git 历史。*
