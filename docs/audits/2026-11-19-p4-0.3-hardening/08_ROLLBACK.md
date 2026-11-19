# 08 · 回滚

- 代码为单一提交 `b3322c5`，`git revert b3322c5` 即可整体回滚；无状态迁移、
  无锁格式变更（version 1/pid/token 沿用）、无持久化 schema 变更
- snapshot 仅**新增** `screenOffPaused` 字段（ additive，旧 UI 忽略即可）
- test:chain 增加三套件为纯测试覆盖，回滚即移除；JVM 门禁 EXPECTED 随 revert
  回到 62（门禁与测试同提交，不会出现计数不一致）
- 安装版补丁状态（patches/mobile-gateway-home-isolation/state.json）本轮
  **零变更**（测试时间戳副作用已还原）；回滚不涉及受控补丁重评审
- 混版注意：若部署环境同时存在 P4-0.1 与 P4-0.2+ 仲裁机制，回滚同样必须
  stop-the-world（R4）；单版本环境无此约束
- 回滚后 #15 误报、#22 息屏即停（旧行为）、#25 协作式取消恢复原状——均为
  已知旧缺陷回归，不是新风险
