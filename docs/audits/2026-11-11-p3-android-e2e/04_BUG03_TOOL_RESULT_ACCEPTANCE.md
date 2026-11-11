# 04 BUG-03 工具结果语义验收（真实 Emulator + 真实客户端链路）

> 客户端为装在 Emulator 上的真实 RN 应用（`com.dshoutpost.p1.p3e2e`，HEAD 见 `evidence/GIT-HEAD.txt`）。
> 场景 A/E 走**隔离真实 DSH**（真实工具执行、真实权威事件）；场景 B/C 走**注入服务端**（端口 3996），
> 其协议形状取自真实 DSH 探针（`logs/probe-events-*.jsonl`），客户端与网络均为真实，仅服务端受控。
> 这满足「真实运行中的客户端与服务端链路进行受控故障注入」，**不是** Node 单测构造数据。

## 场景 A：正常工具调用 —— PASS

真实 DSH 经本地模型桩执行 `read`，产生权威 `tool/call → tool/result(isError=false)`。

| 断言 | 结果 | 证据 |
|---|---|---|
| assistant/message 与 tool/call 去重、工具卡数量正确 | PASS：单工具轮仅 1 张卡 | `evidence/06-scenarioA-chat.png`、dump 计数=1 |
| 工具名与参数正确 | PASS：「读取文件」+ 路径 `…/fixture.txt` | 同上 |
| tool/result 正确绑定、输出完整 | PASS：展开后输出含真实文件 3 行内容 | `evidence/07-scenarioA-expanded.png` |
| 成功状态正确 | PASS：绿色「完成」 | 同上 |
| 展开/折叠 | PASS：二次点击收起 | dump 前后对比 |
| 无重复结果 / 永久 pending | PASS：无 pending 残留 | dump |

## 场景 B：缺失工具结果（tool/call → turn/end，无 result）—— PASS

注入序列：`user/message, turn/start, step/start, tool/call(B-A), tool/call(B-B), turn/end`（无 result）。

| 断言 | 结果 | 证据 |
|---|---|---|
| UI 显示「结果未确认」 | PASS：两卡均「读取文件，结果未确认」 | `evidence/19-scenarioB-expanded.png` |
| 不显示虚假成功 | PASS：无「完成」 | 同上 |
| 与真实失败明确区分 | PASS：占位文案「本轮已结束，但没有收到这个工具的结果」，非「失败」 | `evidence/20-scenarioB-card.png` |
| 不产生重复工具卡 | PASS：2 卡 | dump 计数=2 |
| 不自动重新执行工具 | PASS：服务端无新 tool 执行（注入服务端不执行工具，且无 prompt） | `logs/inject-server.jsonl` |
| WorkGroup 汇总正确 | PASS：「执行过程，有结果未确认」+「2 步结果未确认」，**非**「执行失败」 | `evidence/18-scenarioB.png` |

## 场景 C：迟到工具结果（tool/call → turn/end → tool/result）—— PASS

在 B 之后注入 `tool/result(B-A, isError=false)` 与 `tool/result(B-B, isError=true)`。

| 断言 | 结果 | 证据 |
|---|---|---|
| 初始「结果未确认」 | PASS（见 B） | 18/19/20 |
| 迟到结果按可靠 ID 绑定正确工具 | PASS：A→完成、B→失败，未跨绑 | `evidence/21-scenarioC.png` |
| 状态恢复为真实成功/失败 | PASS：汇总转「执行失败 · 已执行 2 步」（因 B 真实失败） | 同上 |
| 输出替换占位内容 | PASS：A 卡输出变为「late success output for A」 | `evidence/23-scenarioC-A-output.png` |
| 不重新进入 pending | PASS：无 pending/进行中 | dump |
| 不生成重复工具卡 | PASS：仍 2 卡 | dump 计数=2 |

## D1–D5 符合性（本轮 Emulator 观察 + 既有 spec 守卫）

| 决策 | 本轮观察 | 守卫 spec |
|---|---|---|
| D1 仅可靠显式 ID 自动绑定 | C 中按 `toolCallId`/`source.callId` 一致才绑定 | `tool-result-binding-spec.mjs` |
| D2 冲突不绑定 | 本轮未注入冲突 ID（Emulator 未覆盖）→ 由 spec 守卫，标 NOT_RUN(on-device) | `tool-result-binding-spec.mjs`、`tool-result-late-recovery-spec.mjs` L9 |
| D3 独立「结果未确认」三态 | B/C 完整呈现三态且 WorkGroup 区分 | `tool-result-unconfirmed-spec.mjs` U10–U15 |
| D4 未归属结果不上 UI | 本轮未注入无 ID 结果（on-device NOT_RUN）→ spec 守卫 | L10 |
| D5 先验协议 | 已用真实 DSH 探针捕获实时/历史 result 形状后再设计注入 | `logs/probe-events-*.jsonl` |

## 结论

BUG-03 的三态语义、缺失/迟到结果处理、WorkGroup 汇总在**真实 Emulator 客户端**上表现正确。
D2/D4 的负向路径本轮未在设备上注入，由既有协议 spec 守卫，单独标 NOT_RUN(on-device)，不宣称设备级通过。