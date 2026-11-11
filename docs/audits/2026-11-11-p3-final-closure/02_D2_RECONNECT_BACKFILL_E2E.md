# 02 · D2 断线期间产生工具结果的历史补洞（真实 Host + 真实 Emulator）

- 状态：**PASS**
- 证据级别：**REAL_HOST_EMULATOR**（隔离的真实 DSH 0.10.3 网关 + 真实 RN App + 真实 Android Emulator；模型为本地确定性 stub，工具为真实 pwsh 执行。非注入服务器模拟。）
- 会话：`session-50e08154-89bf-406a-92f1-b1636f4287fe`（在 App 内「新建」创建，UI 与探针盯同一 session）
- 寻址：emulator → host 具体局域网 IPv4 `192.168.193.223:3995/3981`（adb reverse 在 `adb root` 后失效；DSH 拒绝通配符绑定，故用具体地址）。断网为**客户端侧** iptables OUTPUT DROP（emulator 内，root），服务端全程不受影响。

## 1. 时间线（host UTC；断网窗口经断言校验）

| 时刻 | 侧 | 事件 |
|---|---|---|
| 16:04:0x | App | 发送 `D2-backfill-probe`（真实 session/prompt） |
| 16:04:0x+6s | server | 权威历史出现 `tool/call`（seq 17，pwsh `Start-Sleep -Seconds 30; Write-Output 'P3-D2-late-result'`），**尚无 tool/result** |
| 断网前 | UI | 截图 `d2-01-toolcall-before-block.png`：工具卡「执行命令 执行中」→ **客户端确已收到 tool/call** |
| **16:04:05.023** | client | `net-block.sh block`：iptables OUTPUT DROP dport 3995/3981 |
| 16:04:10–16:04:33 | client | logcat `[p0-2-verify] schedule-reconnect … attempt=1/2/3`（退避 552/1021/2107ms）→ 断线真实发生 |
| 断网中 | UI | 截图 `d2-02-blocked.png`：仍「执行中 / 继续中」，无结果 |
| **16:04:42.018** | server | `tool/result`（seq 21）产生 —— **在断网窗口内** |
| **16:04:42.200** | server | `turn/end`（seq 26）产生 —— **在断网窗口内** |
| **16:04:43.156** | client | `net-block.sh unblock` |
| 16:04:45.614 | client | logcat `[p0-2-verify] reconnected … cursor=26 records=27` → **自动重连并经真实 follow 路径补洞** |
| 16:04:4x | UI | 截图 `d2-03-backfilled.png`：工具卡变「执行命令 完成」+ 终答 `D2 final answer after delayed tool result.` |

窗口断言（脚本内置，失败即 throw）：`blockAt < tool/result.time < unblockAt` 且 `blockAt < turn/end.time < unblockAt` —— 通过（`d2-timeline.jsonl` 的 `disconnect-window-verified`）。

## 2. 逐项核对

- **断线/重连真实**：客户端 iptables 丢包 + 三次退避重连日志 + 重连后 cursor=26/records=27。
- **新结果在服务端权威历史**：`d2-history-during-disconnect.jsonl` 含 seq 19 job/registered、20 job/settled、21 tool/result、22–25 第二步、26 turn/end；读法为每次新开 `session/follow` 流取首帧 snapshot（长驻订阅会被 App 自己的 follow 顶掉，snapshot 才是稳定权威读法）。
- **经真实补洞路径获得**：重连日志的 cursor/records 与 UI 终态一致；不是 UI 自行伪造。
- **可靠 ID 绑定 / 状态正确**：工具卡唯一且为「完成」，命令文案与 stub 步骤一致；终答文本正确。
- **无重复卡片 / 无跨工具归属**：截图与 `d2-ui-settled.txt` 仅 1 张工具卡；`toolCalls=1, toolResults=1`。
- **WorkGroup 摘要刷新**：单工具轮次摘要为「执行命令 完成」，与终态一致（多工具 WorkGroup 摘要刷新另见 03 的 A/B 场景）。
- **无非幂等自动重发**：权威历史中匹配探针文本的 `user/message` 仅 **1** 条（`serverHistory.userMessages=1`）；重连只补历史，不重发 prompt。

## 3. 过程说明（诚实记录）

前几次运行窗口不成立或取证失败，均已作废并重跑：
- 第 3 次：长驻 follow 订阅被 App 顶掉，只拿到 snapshot → 改为每次快照读。
- 第 4 次：tool/result 早于断网 5.3s（UI 慢轮询拖晚了断网点）→ 作废。
- 第 5 次：工具运行中 UI 有 spinner，uiautomator 拿不到 idle，一次 dump 重试烧掉 ~40s，再次把断网点拖到结果之后 → 作废；改为断网前用**截图**取证（screencap 不需要 idle）。
- 第 6 次（本报告）：窗口断言通过，全部核对项成立。
作废运行的日志保留在 `closure/evidence/d2-run.log` 历史覆盖前的时间线中可追溯；最终证据以第 6 次为准。

## 4. 证据清单

- `evidence/d2-timeline.jsonl`、`d2-summary.json`、`d2-run.log`
- `evidence/d2-history-during-disconnect.jsonl`、`d2-history-after.jsonl`
- `evidence/d2-logcat.txt`（含 schedule-reconnect / reconnected）
- 截图 `evidence/d2-01-toolcall-before-block.png`、`d2-02-blocked.png`、`d2-03-backfilled.png`、`d2-04-settled.png`
- `evidence/d2-ui-backfilled.txt`、`d2-ui-settled.txt`
- 驱动 `scripts/d2-run.mjs`、断网 `scripts/net-block.sh`