# 00 · P3 最终补充验收与定点修复 · 总结

- 日期：2026-11-11（UTC 晚间至 2026-11-12 UTC 凌晨）
- 基线：`17040e9c582851b072446ffbc49c5eb91fff195d`；本轮唯一生产 commit：`4a24e9a37c3b7f4b62163ae40c8d002221a1ddbc`
- 分支：`opt/p3-bug03`（测试分支）。**未合并 main、未打 Tag、未发 Release、未开始 P4。**
- 交付 ZIP：`E:/work/DSH-Outpost-P3-Final-Closure-2026-11-11.zip`（仓库外；解包 diff 与秘密扫描通过）

## 1. 四项收尾结论

| 项 | 状态 | 级别 | 报告 |
|---|---|---|---|
| F2 超时 + 手动安全重试全链路 | **PASS** | INJECTED_SERVER_EMULATOR | 01 |
| F2 附加：abort「同请求两次到达」归因 | **PASS（归因完成）** | INJECTED_SERVER_EMULATOR + 代码证据 | 01 §2 |
| D2 断线期间产生结果的历史补洞 | **PASS** | **REAL_HOST_EMULATOR** | 02 |
| D-1 重复 key 根因 + 最小修复 + 回归 | **PASS** | STATIC + UNIT_TEST + Emulator A/B | 03 |
| D-3 注册表隔离调查 + 负向测试 + 方案 | **PASS（只调查，未改生产）** | STATIC + UNIT_TEST（虚构数据） | 04 |

关键事实：
- F2：180s body 级超时生效；unknown 三态正确；发送态收尾且 UI 可操作；等待期 **零自动重发**；手动重试**复用原 requestId**；服务端 `arrivals=2, executions=1`（幂等成立）。
- abort 双发 = **okhttp 传输层透明重试**（同 rpcId、新 TCP 连接、单次 JS 发送），非 App 重发、非注入服务器重复日志；服务端幂等兜底已验证。
- D2：断网窗口内经断言校验（`blockAt < tool/result.time < unblockAt`）；服务端在断网期间产出 result+turn/end；客户端三次退避重连后 `cursor=26 records=27` 经真实 follow 补洞；UI 单卡「完成」+ 终答；**无 prompt 重发**。
- D-1：兄弟 key 冲突（ApprovalBanner/ChatComposer 同用 sessionId），**先于 P3 存在**（26c255a）；先红后绿；1 行修复；Emulator 警告 13→0，六步 UI 逐字不变（仅少掉警告 toast）。
- D-3：插件默认路径只认 `os.homedir()`、忽略 DSH_HOME；**会写**正式注册表；双实例吊销失效/状态回滚已复现；向后兼容修复方案与 RED/GREEN 测试设计已给出；44/44 虚构数据断言通过；正式注册表 sha256 全程与基线一致。

## 2. 回归与 CI

本地 `npm test`（含 typecheck）exit 0；D-1 spec 先 RED 后 GREEN；Emulator A/B 无渲染回归。远程 Actions run 43051894227 **总结论 success**：test / jvm-tests / build-test / desktop 全部 success，release = skipped（无 tag）；test job 第 [42/114] 步真实执行并通过 D-1 回归 spec。详见 05。

## 3. 停止点八问

1. **F2 完整链路是否完成？** 是。超时→unknown→发送态收尾→UI 可操作→禁自动重发→手动重试复用原 ID→服务端不重复执行，全链路真实 Emulator 证据齐备（01）。
2. **D2 是否完成？** 是。真实 Host + 真实 Emulator，断网窗口断言通过，补洞经真实 follow 路径，UI 终态正确（02）。
3. **D-1 是否修复并 Emulator 回归？** 是。1 行最小修复 + 先红后绿 spec + 全量 + 远程 CI + Emulator A/B（警告消失、卡片零变化）（03）。
4. **D-3 是否根因 + 方案？** 是。六问逐答、写触发点与跨实例混淆机制有代码行号与执行复现；修复方案与测试设计就绪；**按章程未改生产路径**（04）。
5. **BUG-02 / BUG-03 可否关闭？** 可以。上一轮 A–F + 本轮 F2/D2/D-1 回归中的语义复验 + 全量单测 + 远程 CI，未发现新回归（07 §2）。
6. **结束 P3 的阻塞项？** 无。D-3 修复与 P1 独立验收是 **P4 前置**，不是 P3 阻塞；测试环境 LAN 绑定需回退（清理项，07 §3.4）。
7. **剩余 P1 原生风险？** 沿用上一轮清单：息屏即停、tap/scroll/key 无屏幕世代绑定、type 同包换屏盲写面、敏感词子串误报、phone_open 不校验 before.sensitive；未验证项：AgentService 运行时限、API35 dataSync 上限、snapshot 抢锁竞争。审批链未发现 fail-open（07 §3.3）。
8. **是否建议 P4？** 建议。前置：D-3 修复 + 其 RED/GREEN 测试、P1 独立验收、协议补「传输层重放⇒服务端幂等」条款与集成测试、环境清理（07 §4）。

## 4. 安全与治理核对

- 正式 DSH（3095/3081）全程运行未触碰；正式注册表与 gateway state 的 sha256 与基线一致（调查前后、本轮结束各核对一次）。
- 独立端口（3990/3995/3996/3981/8081）、独立 DSH_HOME/profile/凭据；模型为本地 stub，无收费云调用。
- 未删除测试、未降低断言、未隐藏异常；RED 日志与作废运行均保留。
- 交付文档以 ZIP 交付于仓库外；报告不内嵌自身 commit SHA，精确 SHA 见 ZIP 内 `evidence/GIT-HEAD.txt`。

## 5. 目录

00 总结 · 01 F2 · 02 D2 · 03 D-1 · 04 D-3 · 05 回归与 CI · 06 Git 与回滚 · 07 遗留风险与 P4 就绪度