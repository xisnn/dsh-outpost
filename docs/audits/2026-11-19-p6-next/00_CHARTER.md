# 00 · P6-next 章程（手机 agent 继续开发；设计先行，实施待批准）

- 分支/工作区：`opt/p1-phone-polish` @ f18c7f3（已 FF 含 P4 全安全修复），
  worktree `E:/work/dsBot-p1-polish`；已推 origin 备份。
- 治理：三项均触敏感模块（设备控制/审批）。审批表单超时未答 ⇒ **本轮仅设计**，
  第二方选定即视为对该项的批准；未选项保持设计-only。
- 不变量（任何实施不得削弱）：默认拒绝、审批绑定用户所见、敏感屏 fail-closed、
  密码字段拒写、剪贴板不留敏感文本、跨窗/跨包 abort。

## 候选 1 · phone_type 输入边界：不可聚焦自定义控件（报告明确待补）

现状（OAS.kt:222-312）：setText → click 展开重试（包/窗变化 abort）→
`pasteText`（clipboard+ACTION_PASTE，finally 清剪贴板）→ 副屏 ASCII shell `input text`。
**洞**：非 editable 自定义控件（WebView contenteditable/自绘输入面）在 229 行
`ELEMENT_NOT_EDITABLE` 直接拒绝，永远到不了 clipboard/shell fallback；
`pasteText` 依赖 ACTION_PASTE，无 input connection 的控件不支持。
设计： guarded fallback 链——click 目标节点求焦 → 复查包/窗不变 →
clipboard + 副屏 shell `input -d <displayId> keyevent KEYCODE_PASTE`（或 IME commit）→
**re-snapshot 文本验证**（EXACT 才 OK，CONTAINS→UNVERIFIED，不重试防重复写入）→
失败保持 fail-closed 状态码；密码/禁用/敏感守卫前置不变；剪贴板 finally 清理不变。
失败测试设计：JVM 纯决策对象 `TypeFallbackDecision`（节点可编辑性/ paste 支持/
验证结果 → 状态码）契约测试 RED→GREEN；androidTest 用隔离靶 App 的自绘输入面
（负向先打虚构 UI）+ WebView contenteditable 真机/模拟器验收；
跨窗注入负向（fallback 期间换窗必须 abort，零写入）。

## 候选 2 · phone_key 副屏 home/recents + 关最后 App 的上报修正

现状（PhoneTools.kt:316）：副屏 home/recents 一律 `BACKGROUND_KEY_UNSUPPORTED`；
back/home 关掉副屏最后一个 App 时「无活动窗口」被上报成 ERROR（注入其实成功，
OAS.kt:59 注释已承认）。
设计：home/recents 用 display-targeted 启动（`ActivityOptions.setLaunchDisplayId`
+ CATEGORY_HOME intent；recents 走副屏 shell keyevent APP_SWITCH），作用域限定
该 displayId，**绝不落主屏**；结果三态：OK / OK_DISPLAY_EMPTY（注入成功但副屏已空，
供模型决策下一步）/ ERROR（注入失败）。纯决策提取为 JVM 对象
`KeyOutcomeDecision(injected, windowPresent, displayId)` 契约测试。
失败测试：负向——主屏前台不得被 home 影响（双屏断言）；空屏上报不得为 ERROR；
注入失败不得报 OK。真机 OEM 行为待真机门槛。

## 候选 3 · 审批节点身份加固（安全向）

现状（AgentRuntime.kt:396-401）：decide 绑定 callId+**arguments digest**；
ScreenGuard 屏指纹门在执行入口拒过期屏。但副屏丢失→恢复→重快照发布后，
**同一元素序号可能指向新屏不同节点**，旧审批据此执行 = 批错对象。
设计：审批渲染时捕获目标节点身份 digest（package+class+text+bounds+viewIdResourceName）
随 pendingApproval 下发；执行前 re-resolve 序号并比对身份 digest，不等 →
`STALE_NODE` 拒绝并要求重新审批（fail-closed，不自动重批）。与 ScreenGuard
指纹门叠加（屏变拒 + 节点变拒），只紧不松。
失败测试：JVM `ApprovalNodeBinding` 契约（身份等/不等/缺失/不可读 → 允许/拒绝）；
androidTest 真实服务：审批后切屏再恢复，allow 必须 STALE_NODE；
迟到 allow 不得覆盖 reject（既有不变量回归）。

## 验收与门槛（三项共用）

- JVM 契约 RED→GREEN + CI gate spec 同提交更新；JS 链/typecheck 双绿；
- 模拟器隔离靶验收 + 诚实 BLOCKED 清单；真机项待授权（门槛见 07_MERGE_PREP §2）；
- 交付 docs/audits/<date>-p6-next/00…08 + zip；不合并 main、不建 Tag、不发布。

## 待第二方

选定候选（1/2/3 或组合）= 批准实施；其余保持设计-only。
