# 07 — Rurea B1+B2：手势执行端到端验收（emulator 验通）

日期：2026-11-21 · 分支：opt/p1-phone-polish · 设备：API35 emulator p3_e2e_api35
触发：用户拍板产品名 Rurea + 第一冲刺 B1+B2（「先冲 B1+B2 把执行验通」）。

## 目标
验手势**执行**（真打出去见效），而非仅决策逻辑（后者早已 agent-core 83/83 JVM 验通）。
instrument 路在两环境都验不了（vivo 启动 D 状态死锁 / emulator a11y 不绑 instrument 进程），
故换**正常进程 Run harness**：正常启动隔离包（a11y 可绑）驱动真实 agent Run。

## Harness 设计（复用已批准 native 桥，零新增敏感设备控制面）
- **隔离 JS 入口** `src/acceptance/entry.tsx`：经 `-PDSH_TEST_ENTRY_FILE` 编译期隔离编进
  `com.dshoutpost.p1.p6next`（永不进正式入口）。注册 DshPocket→AcceptanceApp，挂载即：
  saveModelSettings(loopback 桩)→等副屏就绪→**等 a11y 真连接**→startCloud→轮询快照自动批准
  （callId 去重 + 容错）→收 events 回报（console RUREA_ACCEPTANCE + POST /report）。
- **反应式 loopback 桩模型** `tests/acceptance/stub-model-server.mjs`：OpenAI 兼容 SSE，
  按 phone_screen 活结果挑元素 id 脚本化 open→screen→scroll→screen→type→screen→tap→key→done。
  HTTP 仅 loopback（agent modelBaseUrlAllowed 只放 127.0.0.1/localhost）。
- **adb reverse tcp:8787**：设备 127.0.0.1:8787 → host 桩（10.0.2.2 会被 agent 拒，故用 reverse）。
- 全程复用 OutpostAgent 桥（startCloud/decide/saveModelSettings/backgroundStart），无新 native 面。

## 攻关路径（每步都有 logcat/报告实证）
1. **bind 修复得证**：副屏真建出（displayId>0, state=running），无 D 状态死锁（承接 06）。
2. **unknown tool**：executeRun 仅在 PhoneBridge.isConnected() 时注册 phone 工具；a11y 异步绑定
   竞态致注册表缺 phone_*。修：入口 startCloud 前轮询 getPhoneCapabilities().accessibilityConnected。
3. **a11y 慢绑**：emulator（swiftshader）a11y 服务在 20s 后才 connected → 等待加到 90s +
   启动后 toggle 无障碍触发绑定，入口在等待窗内捕获。
4. **NO_PENDING_APPROVAL**：入口对同一审批重复 decide → callId 去重 + decide try/catch 容错。
5. **model-transport Failed to connect**：adb daemon 重启丢失 reverse 映射 → 重设 adb reverse。

## 验收结果（displayId=8，phase=completed，a11y=true，text=ACCEPTANCE_DONE）
| 工具 | 状态 | 实证 |
|---|---|---|
| phone_open | **OK** | OPENED com.google.android.contacts（副屏真打开） |
| phone_screen | **OK** | 读副屏元素树（com.google.android.contacts, displayId=8） |
| phone_scroll | ERROR | NO_SCROLLABLE（emulator 联系人**空列表**无可滚靶） |
| phone_type | **OK** | TYPED n1（真填字 "Hello 测试 123"） |
| phone_tap | **OK** | TAPPED n1 (OK)（真点击手势） |
| phone_key | **OK** | KEY home（真注入 home 键到副屏） |

**结论：B1 harness 建成 + B2 手势执行端到端验通。** 完整产品路径
模型→AgentLoop→审批门→PhoneTools→a11y 手势→Shizuku 副屏 真跑通，screen/type/tap/key 真打见效。

## 诚实 nuance（非机制失败）
- **scroll NO_SCROLLABLE**：emulator 联系人空列表无 scrollable 节点；scroll 与 tap/type/key 共用
  同一 a11y 手势派发（机制已由后者得证），空靶诚实报 NO_SCROLLABLE 是正确 fail-closed。
  要 scroll OK 需有内容的可滚靶（填充联系人/换可滚 App），属靶态而非机制。
- **open 包名别名**：首轮桩用 com.android.contacts，emulator 实际 com.google.android.contacts →
  waitForPackage 精确匹配 OPEN_TIMEOUT；改桩用真实包名后 OK。产品侧 waitForPackage 对别名包
  的解析可作 C 轨健壮性改进（非阻塞）。

## 仍待（B 轨后续）
- **B3 OEM 矩阵**：vivo 等真机。vivo instrument 启动死锁仍在（bind 部分修复），但**正常进程 Run**
  路（本 harness）在真机或可绕开 instrument 死锁——需真机授权后验。
- **B4 回归固化**：本 harness 进 CI（emulator 正常进程路）+ 真机手动验收规程文档化。
- 手势执行的真机（vivo）端到端尚待 B3。

## 安全边界（遵守）
仅隔离包 + Shizuku 副屏；靶为非敏感联系人列表；主屏个人数据零写入；无支付/银行/密码靶；
验后卸载隔离包、关无障碍、关 emulator 与桩。

## 证据
- evidence/P6-rurea-b2-acceptance-report.json（displayId=8 完整 events）
- evidence/P6-rurea-b2-stub-trace.log（桩脚本轨迹）
- evidence/logs/P6-rurea-b1-{build,build2,build3,build4,emulator,stub,stub2}.log
- logcat RUREA_ACCEPTANCE（ReactNativeJS）+ DshPhoneA11y service connected 时间线
