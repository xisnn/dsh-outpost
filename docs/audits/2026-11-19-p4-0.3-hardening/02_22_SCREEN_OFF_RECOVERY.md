# 02 · #22 息屏暂停 / 解锁恢复

第二方本轮选定「补 SCREEN_ON/USER_PRESENT 恢复路径」（非 UI 明示终止）。

## 语义

- `SCREEN_OFF` → `AgentRuntime.pauseForScreenOff()`：**可恢复暂停**（不再 stop()
  清队列）。用户已显式暂停时不覆盖（`ScreenPausePolicy.screenOff` IGNORE）；
  重复 SCREEN_OFF 幂等
- `USER_PRESENT`（解锁，而非仅 SCREEN_ON——后者可能仍在 keyguard）→
  `resumeFromScreenOff()`：仅恢复息屏暂停；用户暂停保持暂停
- 暂停期间 `beforeStep` 在任何模型请求/tool 调用前阻塞；恢复后既有
  locked-screen 与 stale-screen 守卫仍 fail-closed（未验证屏幕不执行动作）

## 实现

- `agent-core/ScreenPausePolicy`（纯函数决策矩阵）
- `AgentRuntime`：`screenOffPaused` 标记 + 两个方法 + snapshot 增字段；
  `stop()`/新 run/队列切换均重置标记
- `AgentService`：receiver 增 `ACTION_USER_PRESENT`；通知文案区分
  「暂停，解锁后自动恢复」/「恢复」；仅在确实从息屏暂停恢复时提示恢复

## 测试

- JVM `ScreenPausePolicyTest` 6/6（含用户暂停优先、幂等、非活跃忽略）
- 模拟器集成 `ScreenOffRecoveryTest` 2/2（loopback ServerSocket 桩模型，
  延迟回复制造在途窗口）：
  1. 息屏暂停后回复到达仍阻塞不完成；解锁后完成且交付文本正确
  2. 用户暂停经历息屏/解锁循环后仍暂停，标记不被改写

## 残留风险

- 解锁后若屏幕指纹与暂停前**完全一致**，旧的一次性审批仍可被消费
  （同屏复用）。时间窗复用由 #17 TTL 治理——本轮未获批准，保持仅设计。
  换屏/锁屏场景已被 stale/locked 守卫 fail-closed 覆盖
- 真机 OEM 息屏/冻结行为仍待真机（模拟器不忠实模拟 OEM freezer）
