# 手机 Agent 独立产品化 + 执行端到端验收 路线图

日期：2026-11-20 · 状态：草案 v1（待用户拍板）· 分支：opt/p1-phone-polish
触发：用户决定把手机 agent 当作主功能，重心不再 dsh（「可以哦，出一版吧」）。

> 本路线图基于本轮代码实证，不是愿景文。每个阶段带验收标准与治理约束；
> 敏感改动（审批/凭据/设备控制/持久化）逐项需第二方批准，证据门控，不伪造门。

---

## 产品决策（A1 已定，2026-11-21，用户拍板）

- **产品名：Rurea**。
- **图标**：深海军蓝圆角方形底 + 金色极简线稿符号（蜜蜂 / 心形带叶意象），双色扁平现代风。
- **dsh 客户端功能**：保留**一个入口**（不删除，降级为次要入口；agent 为主 surface）。
- **最终目标**：依赖用户**自己的手机**完成 Word / PPT 等「人在手机上能做的一切事」，
  **除付钱外**。端侧执行，模型走用户自配云服务商。
- **核心安全策略（产品原则）**：
  - **收集信息：全自主**——读屏 / 浏览 / 滚动 / 导航读取，无需逐次批准。
  - **向外发送信息：需用户批准**——发送 / 分享 / 发布 / 提交等一切外发动作。
  - **付钱：永不执行**（硬禁止，无批准通道）。
- **第一冲刺：B1+B2**（正常进程 Run harness，把手势执行真验通）。

> 策略映射：现有工具风险模型 READ 自主 / PHONE 需批 / 支付硬禁 已对齐大方向；
> 但「浏览导航 tap 属收集（自主）」vs「发送 tap 属外发（需批）」的细粒度区分，
> 是 C2 安全门落地的设计点（敏感，需另批）。B1+B2 只验执行机制，不动审批策略。

---

## 0. 现状基线（已实证）

**已是「能跑的安全骨架」，不是 demo：**
- 自主多步循环：`AgentLoop`（纯 JVM）+ `RunSpec(maxSteps)` 有界 + `ActionExecutor`
  （审批门 + preApproval/preExecute 否决）+ RunStore；AgentLoopTest 验证链式多步/否决/审批顺序。
- 8 手机工具（phone_screen/apps/open/tap/type/scroll/key/handoff）+ workspace_read/write；
  元素 id 替代坐标、密码框拒填、敏感包启动前拒、锁屏/敏感屏 fail-closed + handoff。
- 模型 4 协议（OpenAI 兼容 / OpenAI Responses / Anthropic / Gemini），Key 存本机 Keystore，
  强制 HTTPS（HTTP 仅 loopback）、key 脱敏、SSE 流式解析、可中断在途（#25）。
- 三层审批绑定（callId+digest / ScreenGuard 屏指纹 / ApprovalNodeBinding 节点身份），
  agent-core **83/83 JVM 契约** + CI 全绿 + 本地全链 **123/123**。
- 后台副屏：Shizuku 虚拟显示，bind 修复已在 API35 emulator 验证（displayId>0, state=running）。

**耦合现状（产品化要处理的）：**
- `dsh-mobile/package.json` name=`dsh-outpost` v0.18.3，描述「DSH 原生移动客户端：工作区/会话/聊天」。
- devDependency `dsh-plugin-mobile-gateway@0.10.3`；native agent 五件套
  （AgentModule/AgentSettingsStore/BackgroundDisplayController/OutpostAccessibilityService/PhoneBridge）
  仍含 gateway/tunnel/connect 引用。
- `test:chain` 约百条规格，绝大多数是 dsh 网关/桌面/管家/凭据/设备撤销功能，agent 专属仅一小撮
  （agentCoreCi/approval/screenOff/gesture/approvalDock 等）——测试链与 dsh 深度交织。
- 品牌/包名混杂：`dsh-outpost` / `DSH Outpost` / `com.dshpocket` / 隔离 `com.dshoutpost.p1.*`。

**未验/缺失（诚实清单）：**
- 手势**执行**端到端未在设备验通（vivo 启动 D 状态死锁；emulator a11y 不绑 instrument 进程）。
- OEM 健壮性（vivo 安装确认/禁 logcat/binder 死锁/a11y 不自动绑）。
- 设计-only 未落地：审批 TTL(#17)、敏感词误报(#15)、onTimeout 自限时(#23)、取消(#25 部分)、
  home/recents 语义(候选2)。
- 产品层：UI 增量流式（现同步解析完整 SSE）、本地运行时(#37 libproot 缺)、记忆/持久化深度、错误恢复 UX。
- API36 FGS dataSync 上限：无设备，BLOCKED。

---

## Track A — 独立产品化（从 dsh 解耦）

目标：手机 agent 成为可独立发布的产品，不再背 dsh 移动客户端的包袱。

> **状态（2026-11-21）：A2.1+A2.2 已验通**（见 09_A2_DECOUPLING.md）。Agent* 屏幕本就 useApp()-free、
> native 直连云模型；新增 RureaApp agent-first 外壳 + index.rurea.js + DSH_RUREA_ENTRY flag，
> emulator 装机 boot 直达 agent 主界面、无 dsh 配对/网关。dsh 客户端留一个入口（AgentSettings showDshEntry）。
> A2.3 默认切换 + 品牌/包名/凭据迁移 + A3 测试链拆分待后续（敏感，另批）。

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **A1 产品边界** | 定产品名/包名/图标；界定「agent 核心」vs「dsh 客户端遗留」功能清单；决定 fork 独立 app 还是原 app 重构为 agent 主surface | 一页边界文档 + 功能去留表，用户批准 |
| **A2 代码解耦** | 抽 agent 核心（agent-core 已纯 JVM；native 五件套 + RN AgentButlerScreen）为独立模块；移除/隔离 `dsh-plugin-mobile-gateway` 依赖与 gateway/tunnel/pairing 耦合；agent 直连云模型路径不依赖 dsh 网关 | agent 模块独立编译；无 dsh 网关依赖即可跑 Run；耦合点 grep 清零或显式隔离 |
| **A3 测试链拆分** | 从 ~100 条混合 chain 拆出 agent 专属链（agentCore/approval/gesture/screenOff/模型协议/副屏）；dsh 遗留规格归 dsh 线 | agent 链独立可跑且全绿；CI 双链各自触发；不削弱任何安全断言 |
| **A4 独立发布线** | 独立 versionCode/签名/发布 workflow；隔离验收包与正式包关系理顺；main 发布门槛重定义 | 独立 tag 可构建签名 APK；发布门禁文档化；停-the-world 升级规程（若涉持久化迁移） |

风险：A2 触及网关/凭据耦合属敏感，需逐项批准；A3 拆链不得借机降断言。
建议：A1 先行（纯决策，零代码风险），据其结论再定 A2 范围。

## Track B — 执行端到端验收（验「真打出去」）

目标：手势**执行**（非仅决策逻辑）在设备可回归验证。instrument 路在两环境都验不了
（vivo 死锁 / emulator a11y 不绑 instrument 进程），必须换正常进程 harness。

> **状态（2026-11-21）：B1+B2 已在 API35 emulator 验通**（见 07_RUREA_B1B2_ACCEPTANCE.md）。
> 正常进程 Run harness 建成（隔离 JS 入口 + 反应式 loopback 桩模型 + 自动批准，复用已批准桥）；
> phone_open/screen/type/tap/key 真打副屏见效（displayId=8, completed）；scroll 空靶 NO_SCROLLABLE
> （机制与 tap/type/key 共用已证）。**B3 vivo 真机亦验通（8/8 工具 OK，见 08_RUREA_B3_VIVO.md）：
> 正常进程路绕开 instrument 死锁 + 保活 Shizuku 管理器解 provider null**。其它 ROM 待设备；B4 CI 回归固化待后续。

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **B1 正常进程 Run harness** | P6-13 式：正常启动隔离包（a11y 可绑）+ loopback 桩模型（HTTP 仅 loopback 已支持）+ 经 RN phone_* 工具驱动 Run；或隔离包内测试专用自检广播（test-only，不进正式包） | harness 能在副屏跑起一个多步 Run 并采到真实屏态变化 |
| **B2 手势执行真验** | 在副屏真打 tap/type/scroll/key，断言屏态实际改变；STALE_SCREEN/STALE_NODE 负向真拒；home/recents 三态；密码框/敏感屏真 handoff | 逐用例真过（非 Assume skip）；证据=屏态前后对比+Run 日志，非 OK 行 |
| **B3 OEM 适配矩阵** | vivo（已暴露问题）+ 至少 1 其它 ROM（小米/华为/三星）；安装确认/a11y 绑定/binder 死锁/后台查杀逐项验 | 每 ROM 一份验收报告 + 已知问题清单；bind 死锁修复（所有 Shizuku IPC 离主线程+缓存态）落地并真验 |
| **B4 回归固化** | B1 harness 进 CI（emulator 正常进程路）+ 真机手动验收规程文档化 | CI 能回归手势执行；真机规程可复现；BLOCKED 项显式列出 |

风险：B3 的 binder 死锁全量修复是敏感设备控制重构，需批准；OEM 设备可得性约束矩阵规模。
依赖：B1 是 B2/B4 前提；bind 修复（已部分落地）需在 B2 真验后才算闭环。

## Track C — 产品成熟度（可靠性 + UX）

目标：从「骨架」到「可交给真实用户」。按优先级：

1. **C1 UI 增量流式**：现同步解析完整 SSE → 增量渲染（CloudModel 已留 onText 回调契约，
   改 UI 层即可，非敏感）。验收：打字机式增量显示 + 可中断。
2. **C2 安全门落地**（敏感，逐项批）：审批 TTL(#17)、onTimeout 自限时(#23)、可中断取消(#25)、
   敏感词误报收敛(#15，不放宽方向)、home/recents 语义(候选2)。验收：各门 JVM 契约 + 真验。
3. **C3 记忆/持久化深度**：RunStore 持久化 + 跨会话记忆（敏感，批准）。验收：重启恢复 + 迁移规程。
4. **C4 错误恢复 UX**：模型/网络/副屏失败的可见恢复路径（非敏感为主）。验收：故障注入下不卡死、有恢复按钮。
5. **C5 本地运行时(#37)**：libproot 缺失解锁（官方打包或注入），让 agent 可离线跑本地模型。BLOCKED→需资源。

---

## 推荐里程碑顺序

```
M0  A1 产品边界（纯决策，先拍板）──────────────┐
M1  B1 正常进程 Run harness ── B2 手势执行真验 │  并行：A 解耦 / B 验收
M2  A2 代码解耦 ── A3 测试链拆分 ── A4 独立发布线 │
M3  C1 流式 UX ── C2 安全门落地（逐项批）──────┘
M4  B3 OEM 矩阵 ── B4 回归固化 ── C3/C4 持久化/恢复
M5  C5 本地运行时（资源到位后）
```

**第一下一轮建议（M1 的 B1+B2）**：先建正常进程 Run harness 把手势执行真验通——
这是「当主功能」最硬的底气（证明它真能安全地操作手机），且不改敏感代码、风险最低、
复用现成 P6-13 机制。A1 产品边界可并行让你拍板。

## 治理（贯穿）
- 敏感模块（审批/凭据/设备控制/持久化）逐项第二方批准；clarify 超时=未批→设计-only。
- 证据门控：RED→GREEN 日志、真机/emu 屏态证据进 evidence/；Assume skip 不算验收；不伪造门、不拿桩冒充设备验收、不调收费云模型（loopback 桩）。
- 不削弱断言/降轮次/重试掩盖红；CI 红如实归因。
- 独立发布前 main 门槛重定义；涉持久化迁移走 stop-the-world。

## 已知阻塞
- API36 FGS dataSync：无 API36 设备。
- #37 libproot.so：本地运行时全链路 BLOCKED，需官方打包/注入资源。
- OEM 设备可得性：B3 矩阵规模受设备约束。
- vivo instrument 启动死锁：bind 部分修复已提交，全量修复（所有 Shizuku IPC 离主线程）待批+真验。
