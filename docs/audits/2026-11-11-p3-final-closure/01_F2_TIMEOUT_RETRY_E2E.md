# 01 · F2 超时 + 手动安全重试完整链路（真实 Emulator）

- 状态：**PASS**
- 证据级别：**INJECTED_SERVER_EMULATOR**（真实 RN App + 真实 Android Emulator；HTTP 服务端为协议保真注入服务器 `inject-server.mjs`，用于精确制造「200 响应头 + 挂起 body」与「连接级中断」两种故障。不是 REAL_HOST。）
- 基线 commit：`17040e9c582851b072446ffbc49c5eb91fff195d`（F2 主链路在 D-1 修复前的构建上完成；abort 归因 likewise 修复前）
- 时钟口径：host UTC 比 emulator UTC 快约 **0.914s**（实测 host 14:55:29.512Z vs emulator 14:55:28.598Z）。下表 server 列为 host 时钟，client 列为 emulator 时钟。

## 1. 干净单记录 hang → 超时 → unknown → 手动重试

会话 `session-inject-0001`，注入服务器 effects 账本清空后只发一条消息。

| 时刻 | 侧 | 事件 |
|---|---|---|
| 14:47:17.510 | client | `[p0-verify] sending requestId=req-mwc8g8qm-1-0xrpsps0ur1tu6 attachments=0` |
| 14:47:18.713 | server | `POST /api/session/prompt`，rpcId=`rmwc8gbo4-131`，connId=18，remotePort=63605 |
| 14:47:18.714 | server | `business-exec` executions=1（非幂等业务执行一次） |
| 14:47:18.717 | server | `hang-body-start`：已写 200 响应头与半截 body，永不 end |
| 14:50:17.653 | client | `[transport] fetch failed … AbortError: Aborted`（距发送整 180s，BUG-02 的 body 级超时生效） |
| 14:50:18.985 | client | `[p0-verify] hydrated-unknown requestId=req-mwc8g8qm-1-0xrpsps0ur1tu6` |
| 14:50:18–14:51:02 | UI | `session/prompt: 请求超时（180 秒无响应）`、`结果未知，可能已在电脑执行`、`安全重试（复用原 ID）`；发送按钮恢复为「发送消息」（非 busy） |
| 等待全程 | server | effects 账本 `arrivals=1, executions=1` → **App 层没有自动重发** |
| 14:51:25.943 | UI | 人工点击「安全重试（复用原 ID）」 |
| 14:51:29.148 | client | `[p0-verify] sending requestId=req-mwc8g8qm-1-0xrpsps0ur1tu6`（**同一 requestId**） |
| 14:51:30.320 | server | rpcId=`rmwc8lpts-187`，connId=22，remotePort=51798，requestId 不变 |
| 14:51:30.321 | server | `duplicate-arrival arrivals=2, executions=1` → **服务端没有重复执行业务** |
| 重试后 | UI | 未知态解除为「已受理，等待会话确认」，安全重试按钮消失 |

UI 可操作性另证：超时后在输入框成功键入 `UIOK`（截图与 dump 见证据），证明发送态结束且界面可交互。

结论：BUG-02 的「超时覆盖到 body 读取」、三态中的 unknown、发送态收尾、禁止自动重发、手动重试复用原 ID、服务端幂等，六项全部在真实 Emulator 上成立。

## 2. abort 场景「同一请求到达两次」的根因归因

复现：`/__ctl/hang {mode:'abort'}`（服务端解析完请求后直接 destroy socket），发送一条消息。

| 时刻 | 侧 | 事件 |
|---|---|---|
| 14:54:43.394 | client | **仅一条** `[p0-verify] sending requestId=req-mwc8ptrl-2-06p9k4c1y4whec` |
| 14:54:44.580 | server | 第 1 次 `POST /api/session/prompt`：rpcId=`rmwc8pvpe-239`，connId=**22**，remotePort=**51798**（此前一直复用的 keep-alive 连接） |
| 14:54:44.583 | server | `abort-prompt`（destroy socket） |
| 14:54:44.753 | server | 第 2 次 `POST /api/session/prompt`：rpcId=**rmwc8pvpe-239（完全相同）**，connId=**31**，remotePort=**62254（新建 TCP 连接）** |
| 14:54:44.757 | server | `abort-prompt` |
| 14:54:43.945 | client | 一次 `TypeError: Network request failed`，随后 hydrated-unknown |
| 账本 | server | `arrivals=2, executions=1` |

逐排除：

1. **不是 App 层重发**：`send()` 只日志一次；`transport.call()` 每次调用生成一个 `nextRpcId()` 且只 `fetchImpl` 一次（[dsh-mobile/src/core/transport/index.ts:374](file:///E:/work/dsBot-opt/dsh-mobile/src/core/transport/index.ts#L374)、[:389](file:///E:/work/dsBot-opt/dsh-mobile/src/core/transport/index.ts#L389)），无重试循环。两次到达的 **rpcId 完全相同** ⇒ 同一个 JS call() 的同一份 body 被重放，不可能来自两次 call()。
2. **不是注入服务器重复记日志**：两条 `http` 记录对应两个不同 socket（connId 22 vs 31、remotePort 51798 vs 62254），是两次真实 TCP 请求。
3. **不是「多个 HTTP 请求共用一个 rpcId」的应用行为**：rpcId 由 call() 单调生成，应用不会复用。
4. **结论：Android 原生网络栈（okhttp）的透明重试**。第 1 次走的是被服务端 destroy 的复用连接；okhttp 默认 `retryOnConnectionFailure=true`，在「未收到任何响应字节」的连接失败时用新连接重放可重放 body。间隔 173ms，与上一轮观察到的 77–200ms 同量级。

服务端幂等性验证：尽管传输层重放，`executions` 始终为 1 —— 注入服务器按 requestId 去重，非幂等业务只执行一次。真实 DSH 侧的同等保证见 `tests/send-idempotency-spec.mjs`（本轮全量 npm test 通过）。

**未验证项**：okhttp 重试开关的具体取值未在本轮拆包确认（归因依据是「同 rpcId + 新连接 + 单次 JS 发送」的组合证据）；该透明重试发生在 JS fetch 边界之下，App 无法也不应禁止它，正确防线是服务端 requestId 幂等（已验证）。

## 3. 证据清单

- `evidence/f2-server-timeline.jsonl`：server 侧 rpc/http/business-exec/duplicate-arrival/abort 全记录 + 时钟偏移说明
- `evidence/f2-client-logcat.txt`：client 侧 sending / fetch failed / hydrated-unknown
- `evidence/52-f2-send-hanging.png`、`53-f2-timeout-unknown.png`、`54-f2-after-safe-retry.png`、`55-f2-abort-double-arrival.png`
- `logs/f2-logcat.log`、`logs/inject-server.jsonl`（原始）