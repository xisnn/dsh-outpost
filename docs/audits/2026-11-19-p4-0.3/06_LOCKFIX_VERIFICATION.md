# 06 · 锁竞态修复验证闭环（P4-0.3，第二方批准「批准锁修复」）

- 修复提交：`0d15601`（A+B 纯收紧）；协议加强：`2f95243`（测试协议，非断言削弱）。
- 模块：`patches/mobile-gateway-home-isolation/files/registry-lock.js`。
  A：mis-take 归还失败保留活 pid marker（finally 条件清理），grave 保留被顶替活记录；
  B：fresh-create 认领空占位前扫 grave，活记录即 fail-closed 拒启。

## 验证矩阵

| 验证 | 结果 | 证据 |
|---|---|---|
| 确定性失败测试（B 认领活 grave / A 清 marker / 孤儿恢复契约） | 修前 RED（B missing-exception、A marker 0≠1）→ 修后 **3/3 GREEN** | lockfix-RED/GREEN.log |
| 压力 60×4 ticket + 25×4 stress（hold 5s） | **35/35，0 违例** | lock-stress-60x4-hold5s.log |
| 本地 Node 24 全量链（123 条） | **123/123**（1494.7s） | full-chain-final.log |
| CI Node 20 run 44555522969（修复后） | 全 job 绿 | ci-fixrun-final.log |
| CI Node 20 run 44562306847（终版） | **全 job 绿**；test 123/123、lock 35/0 | ci-run4.log + run4 test job log |

## 400ms hold 假阳性归因（不掩盖、不削弱）

修后首轮 60×4（hold 400ms）round 9 报 `acquired=2 lost=0`：轨迹为 11100 先
ACQUIRED→STILLOWNS yes→RELEASED，7948 其后 ACQUIRED→yes→RELEASED，**时间不重叠**，
属串行合法获锁。根因：胜者 hold 400ms 短于败者有界重试预算（MAX_ATTEMPTS=6，
sleepSync 每次 spawn 进程，Windows 抖动可超 400ms），败者恰在释放后获锁被
`acquired>1` 代理计数误判。处置：**加强协议**（hold 5000ms > 最坏重试预算），
使任何第二 ACQUIRED 必为真重叠；断言 `acquired>1 || lost>0` 逐字未动。
加强后 60×4 零违例；CI 15 轮亦绿。真实重叠洞（CI run2 round 5，lost=1）由 A+B 关闭，
确定性测试钉死。

## 治理与边界

- 敏感模块改动获第二方明确批准后实施；未合并 main、未建 Tag、未发布。
- 混版结论继承并扩展：P4-0.1↔P4-0.2↔P4-0.3 仲裁补丁互不互通，升级/回滚 stop-the-world。
- 正式数据零触碰；压力/确定性测试仅在临时目录与注入边界内执行。
