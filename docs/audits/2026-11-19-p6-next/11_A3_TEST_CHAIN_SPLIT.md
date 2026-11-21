# 11 — Rurea A3：测试链拆分（agent vs dsh）

日期：2026-11-21 · 分支：opt/p1-phone-polish · 触发：用户「接着做 A3 测试链拆分」。
原则：**只分组不删减**——所有规格仍全跑，安全断言一条不削弱；分类按内容而非名字。

## 分类发现（诚实，纠正路线图假设）
路线图原以为 agent 链含 approval/gesture/模型协议/副屏 等。**逐规格转查内容后纠正**：
- `approval-spec`：测 foldEvents，「用户在**电脑上**点允许/拒绝」→ **dsh 客户端**审批横幅。
- `approval-gateway-spec` / `approval-gateway-f01-spec`：协议来源 **dsh-plugin-mobile-gateway**
  PROTOCOL.md / 真实网关插件 lib → **dsh 网关**，非手机 agent。
- `gesture-notice-spec`：「**边缘手势**判定」（根页右滑返回/列表横滑冲突/纵向滚动）→ **dsh 导航**手势。
- `approval-dock-ux-spec` / `approval-card-spec`：「多会话审批隔离/待执行命令/401/403」→ **dsh 客户端**审批 dock。
- 真正测**手机 agent** 的 RN 规格仅 2 个：
  - `android-jvm-tests-ci-spec`（test:agentCoreCi）：agent-core JVM 测试的 CI 接线回归。
  - `agent-screen-off-notice-spec`（test:screenOff）：agent 息屏语义 UI 明示。

**为何这么少**：手机 agent 的核心逻辑压倒性地由 **JVM**（agent-core 契约，CI `jvm-tests` job
独立执行）+ **native androidTest** + **B 轨正常进程验收 harness**（emulator/vivo 已验）覆盖；
RN agent 表面规格极少。这是架构事实，不是覆盖缺口。

## 实施（程序化拆分，验证不重不漏）
- `test:agentChain` = `test:agentCoreCi && test:screenOff`（2 步）。
- `test:dshChain` = 原链其余 **104** 步（dsh 客户端遗留）。
- `test:chain` = `npm run test:agentChain && npm run test:dshChain && npm run typecheck`。
- 断言验证：agent/dsh **不相交** + **并集 == 原链 106 步** + typecheck 尾步保留。
- CI `android.yml` test job：原「Unit tests」一步 → **三步各自可见**：
  「Rurea agent chain」(`npm run test:agentChain`) / 「dsh client chain」(`npm run test:dshChain`) /
  「Typecheck」(`npm run typecheck`)。jvm-tests job（agent-core JVM）原样独立。

## agent 回归三层（完整图景）
1. **RN agentChain**：agentCoreCi（CI 接线）+ screenOff（agent UI）。
2. **JVM jvm-tests job**：agent-core 契约（AgentLoop/CloudModel/ScreenGuard/ApprovalNodeBinding/
   TypeFallbackDecision 等），CI 独立 job 真跑 + 报数。
3. **native B 轨验收**：正常进程 Run harness，emulator（07）+ vivo 真机（08）手势执行已验。

## 验证
- agentChain 本地绿：agentCoreCi 40/0 + screenOff 2/0。
- 解析 workflow 的规格复跑全绿（确认双链改动不破坏）：agentCoreCi 40/0、suiteRunner 75/0、
  signingWf 32/0、security 61/0。
- 拆分不重不漏程序化断言通过；CI 双链触发复跑全量。

## 治理
- 无规格删除/削弱；分类按内容（避免把 dsh 网关审批误当 agent）。
- test:chain 仍跑全部（agent+dsh+typecheck）；本地 `npm test` 行为等价。
- 未来 agent 规格（C1 流式 UX / C2 安全门）归入 agentChain，dsh 遗留归 dshChain。
