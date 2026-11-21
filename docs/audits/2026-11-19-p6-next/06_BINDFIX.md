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

## B 路径：API 35 emulator 验证（用户批准）
- **bind 修复在 emulator 上验证生效**：step 信标 launch-app→controller-start→controller-started→
  status；status JSON `connected=true, permissionGranted=true, displayId=2/3/4/5, state=running`。
  Shizuku 虚拟副屏真建出跑起，**无 D 状态死锁**（与 vivo 相反）。批准的 bind 路径修复得证。
- **手势服务执行仍 BLOCKED**：emulator 无障碍服务不绑定到 instrument 进程。realGestures
  step=service-null；awaitService 经 UiDevice.executeShellCommand toggle 确已执行（logcat 可见
  settings put），但 instrument 运行期间 AccessibilityManagerService 从未为 OutpostAccessibilityService
  起进程/绑定。对照手动 monkey+toggle：`Start proc … for service OutpostAccessibilityService` →
  BOUND=[DSH Outpost]。即无障碍绑正常进程、不绑 instrument 进程（P6-13 记载限制，logcat 实证）。
- 故 tap/type/scroll/STALE_SCREEN/STALE_NODE/home-recents 的服务依赖断言在 instrument 下 skip；
  OK(4 tests) 含 Assume skip，非验收。
- 测试基建改进（非敏感，仅 androidTest）：加 androidx.test.uiautomator:2.3.0；awaitService 自助
  toggle 重绑 + 轮询；step 信标定位挂死阶段。不伪造任何门。
- 要验手势**执行**（非仅逻辑）：需正常启动隔离包（无障碍可绑）经 RN phone_* 工具 + 桩模型 Run
  驱动（P6-13 式），或隔离包内测试专用自检广播——更重 setup，待决策。
- 证据：evidence/logs/P6-emulator-{boot,gates,gates-run2,testbuild}.log；
  evidence/P6-emulator-verification-diagnosis.txt。emulator 验后已卸载三包、关无障碍、关机。

## 安全边界（不变）
仅隔离包 com.dshoutpost.p1.p6next + 虚拟副屏；主屏个人数据零写入；验后恢复无障碍原值、
卸载隔离包与 Shizuku。
