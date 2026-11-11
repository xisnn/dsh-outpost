# 07 P1 原生功能风险审查（附带冒烟，非 P1 正式验收）

> **P3 通过 ≠ P1 已验收。** P1 的 10 个提交（`1aa2d82`…`2325d34`，实测正好 10 个）仍须独立验收。
> 本文只做「能力盘点 + Emulator 可验性划分 + 基础冒烟」，并给出独立 P1 验收计划。
> 结论均带 `文件:行号` 或 adb 实测证据；推测项明确标注。

## 0. 前提纠正

记忆/旧审计中「Android 原生侧零自动化覆盖」**不成立**：实测 `android/agent-core/src/test` 共 **38 个 `@Test`**，
另有 androidTest `RuntimeInstallerChecks.java`、`LocalRuntimeBridgeValidationTest.kt`、`KeychainStorageValidationTest.kt`。
成立的是：**无真机/Emulator 端到端验收记录**。本轮冒烟不改变 P1 未验收状态。

## 1. P1 引入的 Android 原生能力（已验证存在）

| 能力 | 证据 |
|---|---|
| 2 个 RN Package（旧架构 ReactPackage，非 TurboModule） | `MainApplication.kt:24-25`（`LocalDshPackage()`/`AgentPackage()`）；`AgentModule.kt:437-443`；`LocalDshModule.kt:148-151` |
| 模块名 `OutpostAgent` / `OutpostLocalDsh` | `AgentModule.kt:22`；`LocalDshModule.kt:19` |
| 新增 5 权限 | `AndroidManifest.xml:4-8`（FGS、FGS_DATA_SYNC、POST_NOTIFICATIONS、WAKE_LOCK、SYSTEM_ALERT_WINDOW） |
| 2 个 `dataSync` 前台服务 | `AndroidManifest.xml:44-53`；`DshRuntimeService.java:64`；`AgentService.kt:74` |
| 2 个通知渠道 | `AgentService.kt:27,70`；`DshRuntimeService.java:25,37` |
| 无障碍服务（手势+读屏+跨屏窗口） | `AndroidManifest.xml:54-65`；`res/xml/outpost_accessibility_service.xml:3-9` |
| 输入注入 tap/type/scroll/key | `OutpostAccessibilityService.kt:167,188,368,381` |
| Shizuku provider + shell UserService | `AndroidManifest.xml:67-73`；`BackgroundDisplayUserService.kt:49,81-86,130,158` |
| 虚拟屏帧回读（ImageReader，**非** MediaProjection） | `BackgroundDisplayController.kt:602-605,714-756` |
| 原生悬浮审批卡 | `AgentOverlayController.kt:57-68,230-249` |
| JNI runner（可执行 owner，非 System.loadLibrary） | `cpp/runtime-runner.c:36-81`；`scripts/build-runtime-native.mjs:15` |
| `:agent-core` 为纯 JVM Kotlin 库 | `agent-core/build.gradle:1-4` |

**未引入**：MediaProjection、电池优化豁免、BOOT_COMPLETED receiver（全仓 grep 无匹配）。

## 2. Emulator 可验 vs 必须真机

| Emulator（API35 x86_64 google_apis）可验 | 依据 |
|---|---|
| 启动、原生模块加载、无障碍授权与连接、默认屏 tap/type/scroll/key、通知+FGS、悬浮窗、审批 digest 绑定、敏感屏拦截、息屏停止、agent-core JVM 测试、runner x86_64 编译 | 均为 AOSP 标准 API；`build-runtime-native.mjs:8` 已含 x86_64 |

| 受阻 / 必须真机 | 依据 |
|---|---|
| **本地 DSH runtime 全链路** | 仓库无 `libproot.so`、无 bundled runtime assets（实测 `android/app/src/main/jniLibs` 不存在）→ `hasBundledRuntime=false`，入口隐藏（`LocalDshModule.kt:29-35`；`RuntimeSupervisor.java:128-129`）。Emulator 无法验证 |
| 后台虚拟屏 | 需先 adb 起 Shizuku；`FLAG_TRUSTED` + 反射 `ShellContext` 依赖 ROM（`BackgroundDisplayUserService.kt:44-56,196-270`），**未验证** |
| 厂商后台杀进程/自启、真实 IME、真实触摸硬件 | P1 无对应代码，属真机专项 |

## 3. 本轮 Emulator 基础冒烟（真实执行）

| 类别 | 命令 / 信号 | 结果 |
|---|---|---|
| 启动 | `am start …SplashActivity`；logcat 无 FATAL | **PASS**（0 FATAL，MainActivity resumed） |
| 权限 | 通知弹窗真实出现并允许；`dumpsys package` 显示 FGS/FGS_DATA_SYNC/WAKE_LOCK granted=true | **PASS** |
| 无障碍原生模块加载 | `settings put secure enabled_accessibility_services …OutpostAccessibilityService` + `accessibility_enabled 1` → logcat `I/DshPhoneA11y: service connected` | **PASS**（13:06:27 实测） |
| 悬浮窗权限 | `appops set … SYSTEM_ALERT_WINDOW allow` | 已授予（悬浮卡 UI 未单独驱动，记 NOT_RUN） |
| 后台恢复 | 前后台切换后会话/列表状态保留 | **PASS**（场景 D 期间一并观察） |
| 前台服务运行态 | `dumpsys activity services` | 未启动 agent，故无运行中 FGS —— 属 NOT_RUN（需先启用手机 agent） |

## 4. 原生风险点（有代码证据）

1. **息屏即停**：`AgentService.kt:36-38` 收 SCREEN_OFF 直接 `stop()`；`OutpostAccessibilityService.kt:105-108` 用全局 `isKeyguardLocked` 拦截 → 后台模式无法息屏运行。
2. **tap/scroll/key 无屏幕世代绑定**：`screenId` 只输出不校验（`PhoneBridge.kt:244`），动作时重取 root（`OutpostAccessibilityService.kt:168`）→ 同包换屏仍按位置 id 点击。`9028d26` 只修了 `type`。
3. **type 残留盲写面**：跨包中止只比 `packageName`（`:220-227`），同包换屏仍走 `findFirstEditable`/`pasteText`（`:228-230,244`）。
4. **敏感词子串误报**：`"pin"` 命中 `"shipping"`（`:75-78,487-490`）→ 偏 fail-closed 的误接管。
5. **phone_open 不校验 `before.sensitive`**（`PhoneTools.kt:147-158` 仅查 locked）→ 敏感屏在前仍可拉起他应用（需审批，注释承认设计）。

**未发现 fail-open**：审批链 `Tools.kt:75-99` + `AgentRuntime.kt:401-416,632` 三重 fail-closed；RN 队列阻塞已由 `AgentModule.kt:25-27,75-96` 移出。
**未验证/推测**：`AgentService` 无 `onTimeout`/运行时限（对比 `DshRuntimeService.java:88-89`），API35 dataSync 上限行为待测；`AgentModule.snapshot` 同步抢锁（`:33`）竞争未测。

## 5. 独立 P1 验收计划（建议）

1. **Emulator 专项**：启用手机 agent → 驱动 FGS/通知/悬浮审批卡/无障碍 tap/type/scroll；断言审批 digest 绑定与 fail-closed；息屏停止行为；敏感屏拦截。
2. **真机专项**：本地 DSH runtime 全链路（需 bundled runtime 或真机安装路径）、Shizuku 后台虚拟屏、厂商后台策略、真实 IME/触摸。
3. **回归门禁**：把 38 个 agent-core JVM 测试 + 2 个 androidTest 纳入 P1 验收 CI 节点，headSha 必须落在 P1 提交上。
4. 每个风险点（§4）配最小复现与负向测试；涉及原生权限边界的修改先出方案与证据再动手。