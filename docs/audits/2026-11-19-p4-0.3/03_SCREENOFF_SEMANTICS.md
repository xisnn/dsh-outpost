# 03 · #22 息屏语义 UI 明示

- 缺口：native `AgentService.kt:36-39` 在 `ACTION_SCREEN_OFF` 时 `stop()` 并仅改
  通知文案；RN 屏幕内零说明 → 用户预期落空（P4-0 审计 #22）。
- 产品语义（本轮默认推荐项；审批表单超时未答，按推荐执行、可再改）：
  **息屏即终止**当前任务，亮屏后需重新发起；仅切后台不影响执行（FGS 继续）。
  与 native 实际行为逐字一致；不改变行为、不放宽任何安全姿态。
- 实现：纯展示组件 `src/components/AgentScreenOffNotice.tsx`（导出语义常量），
  接线于 `AgentButlerScreen` composer 上方，常驻可见。
- TDD：RED `P4-0.3-22-screenoff-RED.log`（exit=1，组件缺失+接线缺失两断言失败）→
  GREEN `P4-0.3-22-screenoff-GREEN.log`（2/2）。组件级断言语义文本逐字；
  源码级断言接线存在。typecheck 绿。
- 未选「补 SCREEN_ON/USER_PRESENT 恢复路径」：需真机验证（OEM freezer 不忠实），
  本轮无真机授权；若第二方改选，另立回合。
