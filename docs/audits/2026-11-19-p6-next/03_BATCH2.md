# 03 · P6-next 批 2 验证与 BLOCKED 清单（候选 2 + #17 + #23 + #25 + #15）

- 提交：`9751241`（分支 `opt/p1-phone-polish`）；批准：第二方「再补齐缺口吧／接着完成吧」。
- 范围不含真机授权与 #37；设备级验收继续诚实 BLOCKED。

## 五项实施与契约

| 项 | 纯 JVM 对象 | 契约 | 接线 |
|---|---|---|---|
| #15 敏感词词边界 | SensitiveWordMatch | 8 | OAS 敏感屏判定改 token-start（Latin）/substring（CJK） |
| #17 审批 TTL | ApprovalTtl（300s，butler 对齐） | 7 | AgentRuntime 捕获 issuedAt；decide 过期/不可验证拒批；snapshot 暴露 expiresAt |
| #23 deadline/onTimeout | RunDeadline（30min 应用层） | 6 | beforeStep 超限优雅 stop；AgentService.onTimeout(startId,fgsType) API34+ 优雅 stop |
| #25 可中断取消 | InterruptPolicy | 6 | stop→模型 HTTP disconnect（Http active 连接缝）+ OAS 循环 cancelRequested→CANCELLED |
| 候选 2 副屏 home/recents | KeyOutcomeDecision | 5 | 解除 isUnsupportedBackgroundKey 误拦（Shizuku `input -d` 本就 display-targeted）；空屏三态 OK_DISPLAY_EMPTY 不再误报 ERROR |

## 验证矩阵

| 验证 | 结果 | 证据 |
|---|---|---|
| 批 A RED（21 契约先写） | 52 unresolved 留证 | P6-next2-RED.log |
| 批 B RED（11 契约先写） | 24 unresolved 留证 | P6-next2b-RED.log |
| JVM GREEN（13 类 **115** @Test） | 115/115，0 失败 | P6-next2-GREEN.log / P6-next2b-GREEN.log |
| 接线编译 `:app:compileDebugKotlin` | BUILD SUCCESSFUL ×2 | 同上 |
| CI gate spec（13 类/115 pin，同提交强化） | 40/0 | 9751241 |
| `tsc --noEmit` | 绿 | 本轮跑 |
| 本地 Node 24 全量链 | **123/123**（1229.0s） | P6-next2-full-chain.log |
| CI Node 20 run 44678450045 | **全 job 绿**（test/jvm/desktop/build-test；release skipped） | P6-next2-ci.log |

## 诚实 BLOCKED / 未验证

1. 设备级验收（批 1+批 2 全部接线项）：需隔离靶 App + 真机/服务绑定 instrumentation；
   本轮仅 JVM 契约 + 编译级接线，**未冒充设备验收**。
2. 副屏 home/recents 的 OEM 行为、API36 FGS 上限、息屏恢复：待真机授权。
3. #37 libproot 本地 runtime 全链路：BLOCKED（不伪造门控）。
4. 取消的 in-flight 窗口为保守近似（整个 active run 视为 in-flight）：只使取消更及时，
   不削弱任何安全方向；精确网络/工具阶段标记留待后续。

## 治理

敏感改动仅限批准清单；未合并 main、未建 Tag、未发布；不变量逐条遵守（只紧不松）。
混版 stop-the-world 规程继承（07_MERGE_PREP §4，P4-0.3 轮）。

## 剩余门槛（合并前）

设备验收闭环 → P1 原生独立验收 → 真机补证 → 第二方批准 FF main（拓扑已证：FF 无冲突）。
