# 00 · 执行摘要（P4-0.3 覆盖/语义/CI 维护 + 锁竞态新发现）

- 分支：`opt/p4-0.3-coverage-screenoff`（基线 `8648a02` = P4-0.2 补充）。
- 提交：`62b467f` #22 UI 语义；`4ecd8d3` #44/#43 链与 androidTest；`56be418` actions v5；
  `58278bf` test job 钉 JDK 21；+ 本文档提交。
- 治理：未合并 main、未建 Tag、未发布；敏感项（#17/#15/#23/#25）审批表单两次超时
  ⇒ 仅设计、零代码；正式数据零触碰；全程本地确定性桩，无收费云模型。

## 结论速览

| 项 | 结论 | 证据 |
|---|---|---|
| #44 链覆盖 | 103→106 条；p3 24/24、p4 4/4 入链 | 本地 122/122（1176s）；suite-runner 75/0；typecheck 绿 |
| #43 androidTest | 孤儿转活真跑：8 tests 0 fail 1 诚实 skip；installer 19 组 pin 绿 | 02 + XML + 两份 log |
| #22 息屏语义 | UI 明示「息屏即终止」，RED→GREEN 2/2 | 03 + RED/GREEN log |
| CI 维护 | actions v5；Ubuntu 26 默认 JDK 25 挂 gradlew dry-run → 钉 JDK 21 修复 | 04；run1 红(signing)→run2 该 spec 绿 |
| 新发现 | P4-0.2 锁仲裁残留竞态（三进程交错顶替活主） | 05；CI run2 唯一红；本地 30 轮 0 违例 |

## CI 双绿状态（诚实）

- run 44541006869：test 红 = signing-gates（Ubuntu 26 JDK 环境性）→ 已修。
- run 44544978457：test 121/122，唯一红 = `mobile-gateway-lock-race-spec`
  （**P4-0.2 既有缺陷**，非本轮引入；本轮未改锁模块）。jvm/desktop/build-test 因
  test 红被跳过；release 仅 tag 触发，skipped。
- 处置：不削弱断言、不降轮次；修复设计（05）待第二方批准 → 同分支提交 → 复跑双绿。

## BLOCKED / 待真机 / 待批准

1. 锁竞态修复（敏感，待批准）——main 合入前必须闭环。
2. #37 libproot.so ⇒ test:localRuntime 与 LocalRuntimeBridgeValidationTest BLOCKED。
3. 手势类真机 RED/GREEN、息屏/OEM 后台：待真机授权。
4. a11y 服务 instrumentation 进程重绑：emulator 已知限制，诚实 skip（02）。
5. #17/#15/#23/#25：仅设计，待批准。

## 下一步

批准锁修复 → 复跑 CI 双绿 → 再议两条线合并（P6 checkpoint 1aa2d82 本就是 opt
 lineage 祖先，merge-tree 干净；合并时执行混版 stop-the-world 规程）。
