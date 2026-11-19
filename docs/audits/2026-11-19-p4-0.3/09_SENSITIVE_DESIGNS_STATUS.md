# 09 · 敏感项与待复核清单（P4-0.3 治理状态）

本轮开工前以审批表单征求第二方（用户）意见，表单**超时未答**。按回合治理
「skipped clarify answer = NOT approved → keep design-only」，以下敏感项本轮
**零代码改动**，设计沿用既有交付：

| 项 | 状态 | 设计出处 | 解锁条件 |
|---|---|---|---|
| #17 / P0-3 C 原生审批 TTL | 仅设计 | P4-0.1 交付 `docs/04_P1_DEVICE_CONTROL_SECURITY.md` §3（issuedAt+TTL，对齐 butler `local-approvals.js` 过期语义） | 第二方明确批准授权语义变更 |
| #15 敏感词子串误报 → 词边界 | 仅设计 | P4-0 审计 `09` §2（不得为消误报放宽 fail-closed） | 第二方批准敏感模块改动 |
| #23 AgentService deadline + onTimeout | 仅设计 | P4-0 审计 `09` §2；实施注意 `onTimeout(startId: Int, fgsType: Int)`（API34+） | 第二方批准设备控制运行时改动 |
| #25 取消可中断边界 / abort 信号 | 仅设计 | P4-0 审计 `09` §2 | 同上 |
| 手势类真机 RED/GREEN 补证 | BLOCKED/待真机 | P4-0.1 `09` §1；个人 vivo 未获授权，本轮只用模拟器 | 专用测试真机或用户明确授权 |

## 本轮已实施的非敏感项

- #44：`test:p3`、`test:p4` 纳入 `test:chain`（typecheck 仍链尾）；`test:localRuntime`
  因 #37（libproot.so 缺失）**诚实保持链外 BLOCKED**，不伪造门控。
- #43：孤儿 `RuntimeInstallerChecks`（0 @Test、无调用者）包装为
  `RuntimeInstallerChecksTest` 并在标准模拟器真跑；`LocalRuntimeBridgeValidationTest`
  仍 BLOCKED（需隔离包名 `com.dshoutpost.p1.*` + `DSH_TEST_ENTRY_FILE` +
  `DSH_RUNTIME_NATIVE_DIR/ASSETS_DIR` + 固定 fixture `runtime.tar`，见 #37）。
- #22：采用推荐默认产品语义「息屏即终止」，纯展示组件明示，与 native
  `AgentService` SCREEN_OFF→stop() 行为逐字一致；**不改变行为、不放宽安全**。
  若第二方改选「补恢复路径」，另立回合（需真机验证）。
- CI 维护：actions checkout/setup-node/setup-java/cache/upload-artifact/download-artifact
  v4→v5（Node 20 deprecation）；ubuntu-latest 迁移警告以本轮全量 CI 真跑归因。

## 下一轮需第二方拍板

1. 上述敏感项批准与否（逐项）；
2. #22 产品语义确认或改选恢复路径；
3. 真机授权（手势/息屏/OEM 后台补证）——这是 main 合入的治理门槛之一；
4. P4-0.2 线复核/合并/发布决策（stop-the-world 升级规程）。
