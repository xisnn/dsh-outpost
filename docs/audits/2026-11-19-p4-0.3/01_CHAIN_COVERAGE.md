# 01 · #44 测试链覆盖扩充

- 修前：`test:p3`（24 项）、`test:p4`（4 项）不在 `test:chain`（103 条），CI 从不执行。
- 修后：链尾 typecheck 之前插入 `test:p3 && test:p4 && test:screenOff`（106 条）。
- 本地（Node 24）：`test:p4` 4/4、`test:p3` 24/24 绿（修前单独跑即绿，入链不改动断言）；
  `suite-runner-spec` 75/0（链展开/typecheck 链尾/dry-run 不执行等门禁保持）；
  `tsc --noEmit` 绿。日志：`P4-0.3-44-suite-runner.log`、`P4-0.3-typecheck.log`。
- `test:localRuntime` **保持链外**：#37 libproot.so 缺失 ⇒ 全链路 BLOCKED；
  不得为覆盖率伪造门控（治理）。解锁条件见 02。
- Node 20 双绿：CI `test` job 以 Node 20 跑同链（运行编号见 00 摘要）。
