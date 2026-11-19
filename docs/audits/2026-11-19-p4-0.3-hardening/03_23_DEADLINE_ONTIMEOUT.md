# 03 · #23 应用层 deadline + onTimeout

## 缺陷

`AgentService` 无应用层自限时，也无 `onTimeout` 收尾；API36 dataSync FGS
系统上限行为未知（真机待测），长任务可能被系统强杀而无优雅收尾。

## 修复

- `agent-core/RunDeadline`（纯函数）：默认 30 分钟；**fail-closed**——
  limit ≤ 0（配置错误）或 now < startedAt（时钟异常）一律 STOP，无无限模式
- `AgentRuntime`：`startedAtMs` 在新 run 与队列切换时重置；
  `enforceDeadline()` 由 service 700ms tick 调用，到期走与用户 stop 相同的
  优雅停止路径（run store 记录中断）
- `AgentService.onTimeout(startId, fgsType)`（API34+，manifest 已声明
  `foregroundServiceType="dataSync"`）：系统回收时同样优雅 stop + 通知 + stopSelf

## 测试

- JVM `RunDeadlineTest` 5/5：限前 CONTINUE；恰好到期/超期 STOP；时钟异常 STOP；
  非正 limit STOP
- 编译验证 `:app:compileDebugKotlin`（onTimeout 签名为 (Int, Int)，非无参）
- **未验证**：API36 真机 FGS 上限实测——仍在待真机清单，不宣称已验证
