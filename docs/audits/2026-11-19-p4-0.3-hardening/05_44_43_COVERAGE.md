# 05 · #44 测试链覆盖 + #43 androidTest 孤儿

## #44

`test:p3` / `test:p4` / `test:localRuntime` 原不在 `test:chain` 上（覆盖缺口）。
本轮纳入链尾（typecheck 之前），链长 118→123 命令。三套件先单独本地验证
exit 0，再全链 123/123。run-suite 聚合器语义不变（串行、收集全部失败、
Node 20 兼容）。CI 的 test job 跑同链 → 自动覆盖。

## #43

- 删除 `RuntimeInstallerChecks.java`：0 个 @Test、无调用者（grep 全仓核实），
  纯孤儿，删之不影响任何覆盖
- 现有 androidTest 首次在本地模拟器（API35 AVD p3_e2e_api35）执行出证据：
  12 项（含本轮新增 ScreenOffRecoveryTest 2 项）**10 PASS / 2 FAIL**
- 2 FAIL 均为 `LocalRuntimeBridgeValidationTest`（#37：默认构建缺
  libproot.so ⇒ hasBundledRuntime=false）。全盘搜索 node_modules / 归档 / SDK
  无 libproot.so；审计允许的注入参数（-PDSH_RUNTIME_NATIVE_DIR）无材料可用，
  **不得为测试伪造门控** → 诚实 BLOCKED，待正式打包路径或材料注入
- androidTest 仍不在 CI（任何 job 都不跑）；本轮按第二方选定「本地模拟器出
  证据」执行，CI androidTest job 留待后续章程

## 门禁

JVM CI 门禁 EXPECTED 62→86（11 类）同步加强；`test:agentCoreCi` 34 断言全过。
