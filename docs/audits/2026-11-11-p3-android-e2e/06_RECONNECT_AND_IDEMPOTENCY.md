# 06 断线重连与幂等验收（真实 Emulator）

> 链路：真实 RN 应用 ↔ 注入服务端（3996，真实 TCP/WS）。断连由服务端 `__ctl/kill` 主动销毁
> mux+gateway socket 模拟（隔离网络控制），客户端自动重连并重新 `session/follow` 拉取权威快照。
> 会话权威记录保存在服务端（`logs/inject-server.jsonl`），重连后以快照回填。

## 步骤

1. 建立会话并注入含工具调用的轮（B/C 完成后服务端持有 8 条权威记录，UI 2 卡：完成/失败）。
2. `POST /__ctl/kill` 销毁全部 WS socket。
3. 观察断开期间 UI 保留已有会话与卡片状态。
4. 等待自动重连；服务端记录到第二次 `session/follow` open。
5. 快照回填后核对 UI 与服务端权威记录一致、无重复。

## 断言

| 断言 | 结果 | 证据 |
|---|---|---|
| WebSocket 自动重连 | PASS：服务端 `session/follow` open 计数 1→2 | `logs/inject-server.jsonl` |
| 历史事件不重复 | PASS：回填后仍 2 张工具卡（无重复） | `evidence/25-reconnected.png`、dump 计数=2 |
| 工具结果正确恢复 | PASS：完成/失败状态与输出保持 | 25 |
| 不发生跨工具错误绑定 | PASS：A=完成(a.txt)、B=失败(b.txt) 未互换 | 25 |
| 不触发非幂等任务自动重发 | PASS：断连前后 `session/prompt` 计数 0（该会话从未自动重发） | jsonl grep |
| UI 与服务端权威记录一致 | PASS：汇总「执行失败 · 已执行 2 步」与服务端 8 条记录折叠结果一致 | 25 |
| 断开期间保留会话/请求状态 | PASS：断开帧仍显示完整卡片与输出，无白屏/丢状态 | `evidence/24-disconnected.png` |
| 可读断开提示 | **未验证**：3s 采样窗口内重连已完成，未捕获到独立断开横幅；不宣称有可见断开提示 | 24 |

## 幂等补充（与 03 联动）

- hang-body 超时窗口内仅 1 次 `session/prompt`，无自动重发（03）。
- 手动「安全重试（复用原 ID）」存在且可受理；requestId 复用见 03 的最终对比。

## 结论

重连、历史回填去重、状态恢复、跨工具绑定正确性、非幂等不自动重发均通过。
「可读断开提示」一项因重连过快未捕获，标未验证。