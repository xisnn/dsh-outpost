# 08 · 回滚说明（P4-0.3）

- 本轮改动面：测试链扩充（`test:p3`/`test:p4`/`test:screenOff` 入链）、新增纯展示组件
  `AgentScreenOffNotice` 及其在 `AgentButlerScreen` 的接线、androidTest 包装
  `RuntimeInstallerChecksTest`（孤儿检查套件转活）、CI actions v4→v5。
- **未改任何生产安全逻辑、未改锁仲裁、未改 native 代码、未改 main、未建 Tag、未发布。**
- 回滚方式：在 `opt/p4-0.3-coverage-screenoff` 上 `git revert` 本轮提交即可。
  - UI 明示移除仅影响展示文案，不影响安全姿态；
  - 测试链回缩仅减少覆盖，不改变断言强度；
  - actions 回退 v4 仅恢复旧 runner 运行时（Node 20 deprecation 警告会回来）。
- 混版约束继承：跨 P4-0.1↔P4-0.2 锁仲裁的升级/回滚仍须 stop-the-world
  （见 `DSH-P4-0.2-supplemental-fail-closed-fix.zip` 内 `MIXED-VERSION-SAFETY.md`）。
  本轮不改变该约束，也不触发该约束（无仲裁代码变化）。
- 正式数据零触碰：本轮所有设备侧执行仅在标准 debug 包 `com.dshpocket` 的
  cacheDir/externalFilesDir 内创建测试 fixture，未写正式注册表/凭据/DSH home。
