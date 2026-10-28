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

## 4. 边界说明

以上是文本 `session/prompt` 的真实 DSH 验证；没有把 mock 结果冒充为真实网络测试。附件 `uploadFileBinary` 的真实 DSH e2e 未包含在本证据中，见阶段 3 报告「剩余风险」。
