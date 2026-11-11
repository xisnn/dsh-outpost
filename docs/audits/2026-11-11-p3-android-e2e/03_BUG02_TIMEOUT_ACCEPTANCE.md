# 03 BUG-02 超时恢复验收（真实 Emulator + hang-body 注入）

> 故障形态严格按章程：**HTTP 200 响应头已返回、响应体迟迟不结束**。
> 注入服务端 `session/prompt` 分支 `res.writeHead(200,…)` + `res.write(部分body)` 后**永不 end()**
> （`scripts/inject-server.mjs`，`logs/inject-server.jsonl` 的 `hang-body-start` 为证）。
> 客户端为 Emulator 上真实 RN 应用，走真实 `transport.call()` → 超时 → abort → 抛错 → pendingSend 落 unknown 全链路。

## 断言与结果

| 断言 | 结果 | 证据 |
|---|---|---|
| RPC 在设定超时后结束（不永久挂起） | PASS：180s（session/prompt 设定值）后结束 | 发送 21:04:38 → 超时横幅出现；`evidence/27-hang-timeout.png` |
| 错误被识别为「请求超时」 | PASS：横幅「session/prompt: 请求超时（180 秒无响应）」 | 27/28/31 |
| 不被错误分类为 malformed response | PASS：文案为请求超时，无 malformed/解析错误字样 | 同上 |
| 发送状态进入 unknown | PASS：气泡「结果未知，可能已在电脑执行」+ 底部「发送结果未知：请求已发出但没收到回执，电脑上可能已经开始执行了」 | `evidence/28-safe-retry.png` |
| 不自动重复发送 | PASS：hang 窗口内 `session/prompt` 仅 1 次（13:04:41），无自动重发 | jsonl 时间线 |
| 手动安全重试复用原 requestId | PASS：原发送 `req-mwc55fe0-2-1gra2oy13rkh1a`（13:14:53，unknown）→ 手动「安全重试（复用原 ID）」（13:22:01）**同一 requestId**，且被受理 | jsonl 两行同 ID；`evidence/31-retry-reuse.png` |
| 发送按钮与加载状态恢复 | PASS：busy 清除，输入框「发消息…」+ 发送箭头可用；重试后气泡转「已受理」 | 28/31 |

## 时间线（节选，UTC）

```
13:04:41.848 rpc session/prompt (hang 开始, 200 头已回)
13:04:41.849 hang-body-start
…180s 无 body…
~13:07:4x   UI: 请求超时（180 秒无响应）/ 结果未知 / 安全重试（复用原 ID）
13:14:53.577 rpc session/prompt req-mwc55fe0-2-…（另一 unknown 记录原发送）
13:22:01.276 rpc session/prompt req-mwc55fe0-2-…（手动安全重试，复用原 ID，受理）
```

## 说明与边界

- 180s 为产品 `rpc/session.ts:117` 硬编码的 session/prompt 超时；本轮**未改产品常量**，真实等待完整超时。
- 曾尝试自研「destroy socket」快速失败模式，发现其扰乱 pendingSend 状态机（同 ID 双发、single-flight 抑制重试），
  属**设施故障形态不当**，已弃用；本报告的结论全部基于干净的 hang-body 路径（见 08 D-6）。
- 「安全重试」按钮文案本身就声明复用原 ID，且服务端时间线证实 ID 一致，非仅 UI 文案。

## 结论

**BUG-02 通过真实 Emulator 验收**：hang-body 不再永久挂起、超时归类正确、unknown 语义正确、不自动重发、
手动安全重试复用原 requestId、发送 UI 正确恢复。