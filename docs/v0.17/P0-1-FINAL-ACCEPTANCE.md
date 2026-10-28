# P0-1 最终验收报告

日期：2026-10-28
分支：`feat/v0.17`
代码提交：`2988688`（最新修复；报告提交见文末）
测试 APK：`dsh-mobile/android/app/build/outputs/apk/release/app-release.apk`
APK SHA-256：`ACC6AFAD0A204F39B27EF17505CD91A0B11BFA52E8B19DAC795180F88CAC9C64`
模拟器：`dsh_verify`（独立测试 AVD；未触碰正式验收 AVD）

## 1. 总结

**结论：B. P0-1 BLOCKED**

阻断项：

1. 最新 release 测试 APK（commit `2988688`）在 `dsh_verify` 安装成功，但真实 DSH 配对 token 返回 HTTP 401（`token exchange failed: HTTP 401`），无法在该 APK 上完成真实 ChatScreen 配对。
2. 因此真实 ChatScreen accepted/confirmed 用户操作、unknown 回执丢失重试、force-stop 恢复均未在最新 APK 上完成。
3. App 附件选择器发送图片/文件/混合消息也未完成；真实 DSH 附件链路只由独立脚本验证，不能冒充 App 端到端。
4. 真实磁盘满/256MiB 上限压力注入：**NOT TESTED**。

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
| 最新 APK 真实 DSH 配对 | **FAIL** | `token exchange failed: HTTP 401`，当前配对 token 已失效 |
| 真实 ChatScreen 正常文本 → queued/sending/accepted/confirmed | **NOT TESTED / BLOCKED** | 最新 APK 无法完成配对；旧构建的 accepted/confirmed 不是当前验收 |
| 真实 ChatScreen unknown → 用户点击安全重试 | **NOT TESTED / BLOCKED** | 同上 |
| 真实 ChatScreen force-stop 后恢复 | **NOT TESTED / BLOCKED** | 同上 |
| App 附件选择器图片/文件/混合发送 | **NOT TESTED / BLOCKED** | 最新 APK 无法配对，未进入 ChatScreen |
| 真实磁盘满 / 256MiB 上限 | **NOT TESTED** | 未尝试填满用户磁盘；仅做故障注入/异常映射 |

## 4. 真实 App / 模拟器证据

- 旧调试构建的实际用户操作 failed 状态：
  `docs/v0.17/PHASE-4-ACTUAL-CHATSCREEN-FAILED.png`（实际 UI，但不是最新 release APK，不能作为最终通过）。
- fixture unknown/accepted 截图：`PHASE-3-CHATSCREEN-PENDING.png`，仅视觉 fixture，不计入 PASS。
- 最新 release APK 已安装并启动到配对页；配对失败 HTTP 401 已记录，未继续伪造 UI 结果。

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

1. 使用有效真实 DSH 配对 token（重新从独立 DSH 测试实例生成；不重启正在运行的用户 DSH）重新配对最新 APK。
2. 在 `dsh_verify` 上重新执行真实 ChatScreen 文本 accepted/confirmed、unknown 重试、force-stop 恢复。
3. 用 App 附件选择器发送图片/文件/混合，并在真实 DSH `session/page` 验证 requestId、附件和单条消息。
4. 在独立测试目录用可靠文件系统故障注入验证 256MiB/复制失败/空间不足；真实磁盘满保持 NOT TESTED。
5. 完成上述后再重跑 `npm test`、`typecheck`、61 项集成测试和 Android 测试，才可标记 P0-1 COMPLETE。

## 8. 未解决问题

- 旧 DSH 配对 token 已失效；需要新的独立测试 token，且不得影响用户正在运行的任务。
- 最新 release APK 的可运行 UI 证据缺失。
- 真实 App 附件选择器链路缺失。
- 真实磁盘满未验证。

## 9. 最终结论

**P0-1 BLOCKED。** 不标记 COMPLETE，不合并 `main`，不移动 `v0.16.7` Tag，不创建 GitHub Release。待真实 DSH 配对 token 恢复并在最新 APK 上完成真实 ChatScreen 文本/附件端到端后，才能重新评估 A. P0-1 COMPLETE。

---

*报告提交：`15adb6c`。*
