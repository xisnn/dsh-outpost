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
- `:app:compileDebugKotlin` BUILD SUCCESSFUL。
- 真机手势门重跑（隔离包重建后）：realGestures(tap/type/scroll 副屏)、staleScreen 负向、
  nodeIdentity 负向、home/recents 三态 —— 见 05 更新与 evidence/logs/P6-realdevice-bindfix-*。
- 该修复属线程调度接线，非纯决策对象；最强证据即真机门由挂死转为可跑（不伪造 JVM 替身）。

## 安全边界（不变）
仅隔离包 com.dshoutpost.p1.p6next + 虚拟副屏；主屏个人数据零写入；验后恢复无障碍原值、
卸载隔离包与 Shizuku。
