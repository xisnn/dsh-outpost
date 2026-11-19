# 00 · 执行摘要（P4-0.3 覆盖/语义/CI 维护 + 锁竞态新发现）

- 分支：`opt/p4-0.3-coverage-screenoff`（基线 `8648a02` = P4-0.2 补充）。
- 提交：`62b467f` #22；`4ecd8d3` #44/#43；`56be418` actions v5；`58278bf` JDK 21；
  `0d15601` 锁竞态修复（已批准）；`2f95243` _race 协议加强；+ 文档提交。
- 治理：未合并 main、未建 Tag、未发布；敏感项（#17/#15/#23/#25）审批表单两次超时
  ⇒ 仅设计、零代码；正式数据零触碰；全程本地确定性桩，无收费云模型。

## 结论速览

| 项 | 结论 | 证据 |
|---|---|---|
| #44 链覆盖 | 103→106 条；p3 24/24、p4 4/4 入链 | 本地 122/122（1176s）；suite-runner 75/0；typecheck 绿 |
| #43 androidTest | 孤儿转活真跑：8 tests 0 fail 1 诚实 skip；installer 19 组 pin 绿 | 02 + XML + 两份 log |
| #22 息屏语义 | UI 明示「息屏即终止」，RED→GREEN 2/2 | 03 + RED/GREEN log |
| CI 维护 | actions v5；Ubuntu 26 默认 JDK 25 挂 gradlew dry-run → 钉 JDK 21 修复 | 04；run1 红(signing)→run2 该 spec 绿 |
| 锁竞态修复 | 已批准、已实施、已闭环：A+B 收紧，确定性 3/3，60×4 压力 0 违例 | 05/06；run4 全绿 |

## CI 双绿状态（已闭环）

- run 44541006869：test 红 = signing-gates（Ubuntu 26 JDK 环境性）→ 58278bf 修。
- run 44544978457：test 121/122，唯一红 = lock-race（P4-0.2 既有缺陷）→ 0d15601 修。
- run 44555522969（修复后）：全 job 绿。
- run 44562306847（终版）：**全 job 绿**（test/jvm/desktop/build-test；release 仅
  tag 触发 skipped）；test 123/123、lock concurrency 35/0。
- 本地 Node 24 终版全量链 123/123（1494.7s）；60×4+25×4 压力 35/0（hold 5s）。

## BLOCKED / 待真机 / 待批准

1. ~~锁竞态修复~~ 已闭环（0d15601 + 2f95243，见 06）。
2. #37 libproot.so ⇒ test:localRuntime 与 LocalRuntimeBridgeValidationTest BLOCKED。
3. 手势类真机 RED/GREEN、息屏/OEM 后台：待真机授权。
4. a11y 服务 instrumentation 进程重绑：emulator 已知限制，诚实 skip（02）。
5. #17/#15/#23/#25：仅设计，待批准。

## 下一步

双绿已闭环 → 议两条线合并：P6 checkpoint 1aa2d82 本就是 opt lineage 祖先，
merge-tree 干净；合并须第二方批准 + 混版 stop-the-world 规程 + 真机/敏感项门槛复核。
