# 04 · #25 可中断取消（tool / 网络 abort）

## 缺陷

取消为协作式：`RunControl.beforeStep` 只在步骤间检查，进行中的 tool/网络请求
跑完才停（长网络读最长 120s readTimeout，phone_open 等待循环最长 5s）。

## 修复

- `AgentTool.abort()` 默认 no-op 钩子；`Abortable` 能力接口（core）
- `ActionExecutor`：跟踪 executing tool + 执行线程；`abortCurrent()` 调钩子并
  中断执行线程；`aborted` 后拒绝任何后续执行（"ABORTED: run stopped before
  execution"）；InterruptedException → 可见 "ABORTED: tool interrupted"；
  finally 消费中断标志，专用 worker 不携带陈旧中断进入下一 run
- `UrlConnectionTransport`（实现 Abortable）：socket 读不响应线程中断，故
  `abort()` disconnect 活动连接 → 阻塞 I/O 抛 IOException → 适配器报可见
  transport 失败，**绝不伪造成功**
- `CloudModelClient`（实现 Abortable）：入口 aborted 检查 → Failure("aborted")；
  abort 委托 transport
- `AgentRuntime.stop()`：接线 `currentExecutor?.abortCurrent()` +
  `(currentModel as? Abortable)?.abort()`；awaitApproval/awaitHandoff/beforeStep
  的 condition await 捕获 InterruptedException → 视为 stop（fail-closed，绝不 allow）
- PhoneBridge 等待循环既有 InterruptedException 处理（返回 last）自然生效；
  handoff 等待经上述捕获路径中断

## 安全不变量

- abort 不绕过审批：aborted 后 execute 在审批门禁**之前**拒绝（JVM 断言
  gate 调用次数 0）；审批等待中被中断 → REJECT，不允许
- 非 abortable tool 行为不变（固定延迟正常完成或可见 ABORTED，绝不挂起）

## 测试

- JVM `ActionExecutorAbortTest` 4/4：在途中断 <2s 返回可见 ABORTED；空执行
  abort 拒绝后续；非 abortable 不挂起；abort 不绕过审批
- JVM `TransportAbortTest` 2/2：在途 stream abort <2.5s 抛可见错误（本地
  HttpServer 延迟桩）；client 预 abort → Failure("aborted")
