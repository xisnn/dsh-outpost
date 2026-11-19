# 01 · P6-next 实施报告（候选 1+3，第二方批准「按照你的建议来」）

- 提交：`e95dc89`（分支 `opt/p1-phone-polish`，工作区 `E:/work/dsBot-p1-polish`）。
- 范围：候选 1（phone_type 不可聚焦自定义控件 guarded fallback）+
  候选 3（审批节点身份绑定）。候选 2 保持设计-only（00_CHARTER）。
- 模式：决策逻辑提取为 agent-core 纯 JVM 对象（ScreenGuard 先例），Android 层只接线。

## 候选 3 · 审批节点身份绑定

- 新纯对象 `ApprovalNodeBinding`：`identity(package, ElementSig)` 哈希**排除序号**、
  包含用户所见全部字段（text/description/class/bounds/flags + package）；
  `decision(approved, live)` = ALLOW / STALE_NODE / UNVERIFIABLE（任一侧缺失即拒）。
- 接线：`AgentRuntime.awaitApproval` 入口捕获当前屏上该 ordinal 的节点身份
  （`OAS.nodeIdentity`，复用 snapshot 与 fingerprintOf 同一字段映射）；
  `ActionExecutor.preExecute` veto 在执行前 re-resolve 并比对：
  STALE_NODE / APPROVAL_NODE_UNVERIFIABLE 拒执行，要求重快照重审批；不自动重批。
- 与既有门叠加：callId+arguments digest（decide）+ ScreenGuard 屏指纹 + 本节点身份。
  只紧不松；非元素目标工具（phone_open/key/screen）不启用绑定。
- JVM 契约 9 项：序号无关、text/bounds/package 敏感、等→ALLOW、异→STALE_NODE、
  缺失/空白→UNVERIFIABLE。

## 候选 1 · 自定义输入 guarded fallback

- 新纯对象 `TypeFallbackDecision`：gate（password/disabled 先拒；editable/subtree
  走原路径；clickable 非 editable → TRY_CUSTOM_FALLBACK；否则 REFUSE_NOT_EDITABLE）、
  outcome（EXACT+accepted→OK；CONTAINS→UNVERIFIED 不重试；accepted→UNVERIFIED；
  否则 FAILED）、abort（包/窗变化即中止）。
- 接线：`OAS.type` 用 gate 分流；`customInputFallback`：click 求焦 → 每轮复查
  包/窗（变化即 SCREEN_CHANGED_DURING_TYPE，零写入）→ 焦点/子树 editable 目标
  password/disabled 复查 → setText → clipboard paste（finally 清剪贴板不变）→
  副屏 ASCII shell input → re-read 验证映射 outcome。
- JVM 契约 12 项覆盖 gate/outcome/abort 全分支。

## 门禁与验证

- CI gate spec 同提交强化：六类→八类，62→**83** @Test（+9+12），实跑 83/0；
  android.yml jvm step 名称同步 83。
- RED：契约测试先写，`:agent-core:test` 编译失败（unresolved）留证 P6-next-RED.log；
  GREEN：P6-next-GREEN.log 83/0。
- 接线编译：`:app:compileDebugKotlin` BUILD SUCCESSFUL（P6-next-wiring-compile.log）。
- gate spec 35/0；`tsc --noEmit` 绿；全量链与 CI 见 02。

## 不变量遵守

默认拒绝、审批绑定用户所见、敏感屏 fail-closed、密码拒写、剪贴板不留敏感文本、
跨窗/跨包 abort、CONTAINS 不重试防重复写入。未合并 main、未建 Tag、未发布。
