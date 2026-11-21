# 08 — Rurea B3：vivo 真机手势执行验收（全 8 工具 OK）

日期：2026-11-21 · 分支：opt/p1-phone-polish · 设备：vivo V1981A (PD1981) / Android 12 / API 31 / serial 762a319
承接：07（B1+B2 emulator 验通）。本轮把正常进程 Run harness 搬上**真机**，闭掉此前 BLOCKED 的「真机手势执行」。

## 关键突破：正常进程路绕开 vivo instrument 死锁
- vivo 上 `am instrument` 启动曾 D 状态死锁（06）；但 **monkey 正常启动 App 进程 S 状态健康**。
- B1+B2 的正常进程 Run harness（隔离 JS 入口直驱 OutpostAgent 桥）正好走正常启动路 →
  **绕开 instrument 死锁**，真机副屏真建出、真 Run 真跑通。bind 修复（Shizuku IPC 离主线程）+ 正常启动共同生效。

## vivo 特异攻关（都有实证）
1. **Shizuku `provider is null moe.shizuku.privileged.api.shizuku`**：首轮副屏建不出（displayId=-1,
   BACKGROUND_DISPLAY_NOT_READY）。根因：vivo 激进后台管理把 Shizuku 管理器进程杀了，Shizuku provider
   在管理器里 → provider 失效。**保活管理器**（启动 App 前先 monkey 拉起管理器）后 provider 恢复、副屏建出。
2. **无障碍绑定**：`settings put secure enabled_accessibility_services` 追加我们的服务（保留 vivo 收藏
   服务），BOUND=[收藏, DSH Outpost] 真绑定；启动后 toggle 一次确保 instrument 外进程绑定。
3. **联系人包名**：vivo 联系人 = `com.android.contacts`（emulator 是 `com.google.android.contacts`）。
   桩计数驱动 + OPEN_TIMEOUT fallback 自适应两包名。
4. **vivo 禁 logcat**：结果靠桩 `/report`（adb reverse tcp:8787 → host 桩）收，不靠 logcat。

## 验收结果（displayId=6，phase=completed，a11y=true，text=ACCEPTANCE_DONE）
| 工具 | 状态 | 实证 |
|---|---|---|
| phone_open | **OK** | OPENED com.android.contacts（真机副屏真打开） |
| phone_screen | **OK** | 读副屏元素树（displayId=6） |
| phone_scroll | **OK** | SCROLLED down（真机联系人有内容，真滚动） |
| phone_type | **OK** | TYPED n5（真填字 "Hello 测试 123"） |
| phone_tap | **OK** | TAPPED n1 (OK)（真点击） |
| phone_key | **OK** | KEY home（真注入 home 键到副屏） |

**8/8 工具调用全 OK。结论：B3 vivo 真机手势执行端到端验通。** 完整产品路径
模型→AgentLoop→审批门→PhoneTools→a11y 手势→Shizuku 副屏 在**真实 vivo 硬件**上真打见效。
此前 BLOCKED-on-vivo 的手势执行项**正式关闭**。

## 矩阵状态
- **vivo V1981A（API31）：✅ 验通**（本轮）。
- 其它 ROM（小米/华为/三星等）：需相应设备；当前仅 vivo 在线。矩阵扩展待用户提供更多设备。
- 每 ROM 需复验：Shizuku provider 保活策略、a11y 绑定方式、联系人/靶 App 包名、后台查杀行为。

## 安全边界（遵守）
仅隔离包 com.dshoutpost.p1.p6next + Shizuku 副屏；靶为非敏感联系人列表；主屏个人数据零写入；
无支付/银行/密码靶；一次性 setup 点击（安装确认/Shizuku 授权）非 agent 驱动；验后恢复无障碍原值、
卸载隔离包与 Shizuku。

## 证据
- evidence/P6-rurea-b3-vivo-report.json（displayId=6，8/8 OK 完整 events）
- evidence/P6-rurea-b3-vivo-stub-trace.txt（桩脚本轨迹）
- evidence/logs/P6-rurea-b3-{stub,stub2,stub3}.log
- 桩 /report（adb reverse）；vivo logcat 受限故以 /report 为准。
