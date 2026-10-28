# P0-1 最终验收前检查（Pre-Final Acceptance）

日期：2026-10-28
分支：`feat/v0.17`
阶段 4 实现提交：`e48b68a`
本报告提交：见 Git 最后一条 `docs(v0.17): pre-final acceptance` 提交

## 1. 结论摘要

| 项目 | 结果 |
|---|---|
| 真实 DSH 文本发送 / accepted / 同 requestId 去重 | PASS |
| 真实 DSH 图片/文件/混合附件上传→prompt→page | PASS |
| 真实 App 运行时远端身份探针（真实 Keychain Cookie + 真实绑定） | PASS（HTTP 200，gatewayId 一致） |
| 真实 ChatScreen 实际用户操作触发失败状态 | PASS（failed 截图） |
| 真实 ChatScreen 实际用户操作触发 accepted / confirmed | **未验证** |
| 真实 App 附件选择器完整上传链路 | **未验证** |
| 阶段 4 过期/清理/授权清除语义 | 自动化测试通过 |
| 真实磁盘满注入 | **NOT TESTED**；仅故障注入/异常映射 |

**最终判定：P0-1 尚未达到最终验收标准。** 阻断点是真实 ChatScreen 的 accepted/confirmed 用户操作证据和真实 App 附件选择器上传链路，不是代码中的已知逻辑错误。

## 2. 远端身份验证诊断

### 2.1 探针结果

在独立模拟器上，用 **当前 App 的真实 Keychain 数据**（不是 fixture）运行诊断探针：

```text
P0HARNESS REAL_COOKIE_PRESENT=true
P0HARNESS REAL_BINDING_BASE=http://172.27.58.79:3095
P0HARNESS REAL_BINDING_GATEWAY=99921c7e-74b7-4845-91ec-8d600675b55f
P0HARNESS REAL_PROBE={"status":200,"gatewayId":"99921c7e-74b7-4845-91ec-8d600675b55f"}
```

结论：

- Cookie 存在；
- 已保存绑定 baseUrl 与实际 DSH 地址一致；
- 已保存 gatewayId 与真实 `/mgw/status` 返回值一致；
- 当前 App 运行时请求返回 HTTP 200；
- 没有可复现的远端身份不匹配、凭据过期、网络拒绝或网关配置拒绝。

### 2.2 仍然存在的 UI 证据缺口

真实 ChatScreen 实际用户操作发送时，曾出现 `remote-identity-unavailable` 和「未发出」气泡；截图见
`PHASE-4-ACTUAL-CHATSCREEN-FAILED.png`。该截图来自较早构建/旧状态。最新构建的 App 运行时探针已恢复 HTTP 200，但尚未重新完成 accepted/confirmed UI 截图。因此：

- 不把 fixture 的 accepted 截图冒充真实结果；
- 不把探针 PASS 冒充 UI 端到端 PASS；
- 保持该验收项为未关闭。

未采用的绕过方式（明确禁止）：关闭远端验证、使用本地缓存冒充实时身份、硬编码 gatewayId、削弱管理接口认证。

## 3. 真实 DSH 收发与附件证据

真实 DSH 独立临时会话（未触碰用户已有会话）：

```text
IMAGE_PROMPT={"accepted":true} USER_MESSAGES=1
FILE_PROMPT={"accepted":true} UPLOAD_RECEIPT=true USER_MESSAGES=1
MIXED_PROMPT={"accepted":true} USER_MESSAGES=1
ATTACH_LOSS_FIRST=simulated prompt response lost RETRY={"accepted":true} USER_MESSAGES=1
INVALID_RECEIPT_ERROR=session/attachment-invalid (FILE_NOT_STAGED) USER_MESSAGES=0
UPLOAD_ABORT_ERROR=simulated upload interruption RETRY_RECEIPT=true USER_MESSAGES=0
DEFINITE_FAIL_FIRST=INVALID_IMAGE_BASE64 RETRY={"accepted":true} USER_MESSAGES=1
REAL_DSH_ATTACHMENTS=PASS
```

完整 session ID 与输出见 [PHASE-3-REAL-DSH-EVIDENCE.md](PHASE-3-REAL-DSH-EVIDENCE.md)。

## 4. accepted / confirmed 对账

自动化测试已验证：

- accepted 只表示服务端入队；
- 只有真实 `user/message.source.rpcId` 命中才 confirmed；
- confirmed 先于 accepted 到达时状态不倒退；
- 迟到 accepted 对 confirmed 是幂等 no-op；
- 同一 requestId 重试不会产生第二条用户任务；
- fixture 的 accepted 记录只是视觉测试，不进入本验收结论。

真实 ChatScreen 的 accepted/confirmed 端到端尚未完成（见第 2/8 节）。

## 5. unknown 重试与去重

- 真实 DSH 文本探针：accepted 后模拟客户端回执丢失，同 requestId 重试；`session/page` 显示该 requestId 仅 1 条 `user/message`。
- 真实 DSH 附件探针：文件上传成功、prompt 回执丢失，同 requestId 重试；仅 1 条用户消息。
- 自动化测试：`pending-send-send-flow-spec` 9/9，`pending-send-attachment-flow-spec` 19/19，覆盖 unknown、显式重试、single-flight、上传中断恢复。

## 6. 过期状态语义修复

- `PendingSendRecord` 新增 `expiredFrom`。
- `expire` 状态迁移保留原状态：
  - `queued/preparing/ready/failed` → 过期显示「未发送（附件已清理）」；
  - `unknown/sending` → 「发送结果未确认，可能已执行（附件已清理）」；
  - `accepted` → 「服务端曾受理但未确认（附件已清理）」。
- 过期记录不可重试；不允许自动新建 requestId。
- `accepted` 超过 24h 等待确认窗口也会转 `expired` 并保留 `expiredFrom='accepted'`。
- 测试：`pending-send-store-spec` 15/15，包含 queued/unknown/accepted 过期原状态断言。

## 7. 清理失败与容量测试

- `clearAll()` 返回 `{records:'cleared'|'failed', staging:'cleared'|'failed'}`；
- 记录清除成功但目录清理失败时返回 `partial`，App 提示「记录已清除，但附件暂存目录没能确认清空」；
- 目录清理失败不会虚报全部成功；
- 共享 `stagedUri` 不会被其他记录过早删除；
- 启动 `cleanupOrphans` 回收孤儿文件；
- 单文件 50MiB / 总量 256MiB 上限已实现；复制失败/空间不足映射到 staging error；
- **真实磁盘填满：NOT TESTED**。只做可靠文件系统故障注入和异常映射，不尝试填满用户磁盘。

## 8. 测试结果

| 测试 | 结果 |
|---|---|
| `npm test`（最终工作树） | **PASS，exit 0** |
| `npm run typecheck` | PASS |
| `npm run test:integration` | **61/61 通过** |
| `pending-send-attachment-flow-spec` | 19/19 |
| `pending-send-store-spec` | 15/15 |
| `pending-send-service-binding-spec` | 10/10 |
| `pending-send-send-flow-spec` | 9/9 |
| `pending-send-wiring-spec` | 5/5 |
| `test:idem` / `test:retry` | 12/12、9/9 |
| `test:mgwPatch` | 24/24 |
| Android debug build | PASS |

## 9. 未验证场景

1. 真实 ChatScreen 用户操作触发 accepted/confirmed（本报告阻断项）。
2. 真实 App 附件选择器发送图片/文件/混合（真实 DSH 附件脚本已验证，但不是 App UI 选择器）。
3. 真实磁盘满 / 256MiB 上限压力注入（NOT TESTED）。
4. Android 原生 Keychain 故障注入（JS 边界注入已覆盖；原生成功路径已实测）。
5. 服务端 receipt 清理后的真实服务端行为（invalid receipt 已实测为明确错误）。

## 10. 阶段 5 结论

**暂停在阻断点，不进入 P0-1 阶段 5 最终故障注入验收。**

阻断点：

- 真实 ChatScreen accepted/confirmed 用户操作证据未完成；
- 真实 App 附件选择器完整上传链路未完成；
- 真实磁盘满/暂存上限压力测试未执行。

`npm test`、`typecheck`、61 项集成测试通过并不等于上述 App 端到端验收通过；本报告不把 fixture、脚本或 mock 结果冒充 App 端到端结果。
