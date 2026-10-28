# 阶段 3 真实 DSH 验证证据

日期：2026-10-28
服务：本机真实 DSH，`http://172.27.58.79:3095`（DSH `gatewayId=99921c7e-74b7-4845-91ec-8d600675b55f`）

## 1. 已认证远端身份

- 使用 `pairing.json` 的 token 登录（命令未打印 token）。
- 真实 `GET /mgw/status` 返回 HTTP 200，`gatewayId=99921c7e-74b7-4845-91ec-8d600675b55f`。
- 生产代码 `fetchServerGatewayId(baseUrl, cookie)` 在真实服务上返回同一 ID：`REAL_FETCH_SERVER_GATEWAY_ID=PASS`。

## 2. 真实 session/prompt（文本）

```text
SESSION_CREATED=session-65546806-af13-49d0-be32-e79ae074ce2c
NORMAL_ACCEPTED={"accepted":true}
THROUGH_SEQ=36
NORMAL_RPC_MESSAGE_COUNT=1
```

## 3. accepted 后回执丢失 + 同 requestId 重试

```text
LOST_SESSION_CREATED=session-a456f888-d6ab-484a-8fa9-c3ec474b9df5
LOST_FIRST_ERROR=simulated receipt loss after server accepted
LOST_RETRY_ACCEPTED={"accepted":true}
DUPLICATE_ACCEPTED={"accepted":true}   # 同 requestId、不同内容，服务端 accepted 但应丢弃
LOST_THROUGH_SEQ=35
LOST_RPC_MESSAGE_COUNT=1
LOST_RPC_TEXTS=[[{"type":"text","text":"P0-1 real DSH accepted-but-receipt-lost probe"}]]
REAL_DSH_PROBE=PASS
```

结论：
- 首条 prompt 已被真实服务端受理（客户端主动丢弃响应模拟回执丢失）。
- 同 requestId 重试被服务端接受，会话事件只有 1 条对应 `user/message`。
- 同 requestId 发送不同内容返回 accepted，但不同内容未出现在事件中，证明服务端 `hasPromptRequest` 按 requestId 去重。

## 4. 真实 DSH 附件链路（uploadFileBinary → prompt → page）

在真实 DSH 上用独立临时 cwd 创建会话，使用真实 `uploadFileBinary`：

```text
IMAGE_PROMPT={"accepted":true} USER_MESSAGES=1 SESSION=session-4d9f1a07-d318-4692-80c8-8b23ad153397
FILE_PROMPT={"accepted":true} UPLOAD_RECEIPT=true USER_MESSAGES=1 SESSION=session-d6936be6-eb2b-494b-9491-132d28cc5c7f
MIXED_PROMPT={"accepted":true} USER_MESSAGES=1 SESSION=session-6853bc67-9ed5-433c-8bb6-32db9b6f210a
ATTACH_LOSS_FIRST=simulated prompt response lost RETRY={"accepted":true} USER_MESSAGES=1 SESSION=session-299d7df5-cc86-47de-8784-a032e3c224c4
INVALID_RECEIPT_ERROR=prompt: {"code":"session/attachment-invalid","message":"File was not uploaded for this session.","details":{"reason":"FILE_NOT_STAGED"}} USER_MESSAGES=0 SESSION=session-eb9f280e-9b67-4c1b-9ecb-f402847fff8c
UPLOAD_ABORT_ERROR=simulated upload interruption: This operation was aborted RETRY_RECEIPT=true USER_MESSAGES=0 SESSION=session-3f4b7f22-0c71-48aa-8507-d4209e55e4e9
DEFINITE_FAIL_FIRST=prompt: {"code":"session/attachment-invalid","message":"Image upload is not canonical base64.","details":{"reason":"INVALID_IMAGE_BASE64"}} RETRY={"accepted":true} USER_MESSAGES=1 SESSION=session-80860fb7-934c-447f-803d-1fbf85db004e
REAL_DSH_ATTACHMENTS=PASS
```

结论：
- 图片、文件、混合消息均完成真实 `session/prompt`，`session/page` 均只有 1 条对应 `user/message`；
- 上传成功但 prompt 回执丢失后同 requestId 重试，仍只有 1 条任务；
- 无效 receipt 返回明确 `session/attachment-invalid`（`FILE_NOT_STAGED`），没有产生用户任务消息；
- 上传中断（客户端 Abort）后重新上传成功，未产生 prompt 任务；
- 上传成功但 prompt 因非法图片 base64 明确失败后，同 requestId 修正内容重试成功，仍只有 1 条任务。

## 5. 边界说明

以上是真实 DSH 服务验证；附件测试使用独立临时会话并在用户消息落库后 `session/cancel`。没有把 mock 结果冒充为真实网络测试。未打印或提交 Token/Cookie/私有文件内容。
