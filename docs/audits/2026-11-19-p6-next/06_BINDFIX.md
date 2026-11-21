# 06 — Shizuku 绑定死锁修复（敏感设备控制改动，已批）

日期：2026-11-20。

## 授权
用户明确批准候选 1：「那就1吧，加油加油」→ 本轮敏感设备控制改动（Shizuku 懒绑定/
绑定超时）的第二方批准。范围限定：仅 BackgroundDisplayController 的 binder IPC 线程
调度，不动审批/凭据/手势语义，不削弱任何断言或安全方向。

## 根因（承接 05 诊断）
vivo V1981A 上 Shizuku 已授权的隔离包在 am instrument 启动路径下 App 进程 D 状态、
副屏建不出；monkey 直起健康。机理：
- `maybeBind()` 在调用/主线程**同步** `Shizuku.bindUserService(...)`（阻塞 binder IPC）。
- `onServiceConnected`/`maybeBind` 的 `createDisplay()` 内 `remote.createDisplay(...)`
  亦是主线程同步 binder IPC。
- `startBindTimeout()` 的超时 runnable post 在 **mainHandler**：主线程被 binder 阻塞时
  超时永远跑不了 → 与 RN 启动争 Shizuku 锁互锁 → 永久死锁。

## 修复（最小、纯收紧线程调度）
新增专用 `bindThread = HandlerThread("dsh-background-bind")` + `bindHandler`。把三处
阻塞 binder IPC 移出主线程：
1. `maybeBind()` 的 `Shizuku.bindUserService` → `bindHandler.post { … }`。
2. `maybeBind()` 已绑定但 displayId<=0 时的 `createDisplay(current)` → bindHandler.post。
3. `onServiceConnected` 的 `createDisplay(remote)` → bindHandler.post。
状态变更仍全部 synchronized(lock)；绑定超时仍在 mainHandler（主线程现已空闲，超时可触发）。
createDisplay 内的 remote.createDisplay / launchInternal binder IPC 随之在 bind 线程执行。
共 4 处精确替换（含字段声明），各 count==1 原子落地。

## 验证
- `:app:compileDebugKotlin` + `assembleRelease/AndroidTest` BUILD SUCCESSFUL（含修复 APK）。
- 真机手势门重跑（前置全齐：授权/server/管理器关/a11y 真绑定）：**仍挂死**——只发出
  step=launch-app，App 进程即 D 状态、未到 controller-start。bind 修复（bindUserService/
  createDisplay 移出主线程）**未解开启动挂死**。
- 收窄根因：启动期 JS 调 backgroundStatus/backgroundArm → controller.status()/armAutoStart()/
  init 在调用线程同步跑 Shizuku binder 查询（getBinder/checkSelfPermission/
  addBinderReceivedListenerSticky）；instrument + 活 server 下这些查询 uninterruptible 阻塞。
  bind 修复只移了 bind/createDisplay，未移这些查询。
- 彻底修需把**所有** Shizuku IPC 懒加载/移出主线程 + 同步读者用缓存态（status/checkPermission/
  init）——更大的敏感设备控制重构，需明确批准与谨慎测试，不在盲诊断（vivo 禁 logcat）下硬补。
- 手势门逻辑与设备无关；建议改 API35 emulator 验证（P6-13 核心路径曾跑通）以避开 vivo
  instrument binder 怪癖，或批准上述更广懒加载重构。
- 该修复属线程调度接线，非纯决策对象；不伪造 JVM 替身。bind 路径修复本身正确且已提交。

## 安全边界（不变）
仅隔离包 com.dshoutpost.p1.p6next + 虚拟副屏；主屏个人数据零写入；验后恢复无障碍原值、
卸载隔离包与 Shizuku。
