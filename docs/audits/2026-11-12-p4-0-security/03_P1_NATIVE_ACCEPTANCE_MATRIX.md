# 03 · P1 原生功能独立验收矩阵

- 范围：P1 的 **10 个提交** `1aa2d82, 9727238, ebcc9a1, 9c17dbd, 2a27192, 9028d26, 9cef57e, 946e291, d4c0869, 2325d34`
- 基线：分支 `opt/p4-0-security`，HEAD `c4c067b`（P3 终点 `617d690` 之上）
- **关键事实**：`git diff 2325d34..HEAD -- dsh-mobile/android` 为**空** ⇒ P1 之后原生 Android 代码零改动，
  上一轮 `07_P1_NATIVE_RISK_REVIEW.md` 的全部行号在 HEAD 仍然有效（本轮逐条复核）。
- **前提纠正**：`targetSdkVersion = 36`、`compileSdkVersion = 36`、`minSdkVersion = 24`
  （`dsh-mobile/android/build.gradle:4-8`），**不是 35**。手机工具另要求 API ≥ 31（`AgentRuntime.kt:249`）。
- 设备：Emulator `emulator-5554`，API 35，x86_64；隔离包 `com.dshoutpost.p1.p3e2e`，
  versionName `0.18.3-p40` / versionCode `940001`（本轮 HEAD 构建）。
  **真机（vivo V1981A）虽已连接但未使用**：在用户个人手机上驱动设备控制不可安全恢复，真机项一律标「待真机验证」。

证据类型：`REAL_HOST_EMULATOR`（真实 Emulator + 真实原生代码 + 本地桩模型）／
`UNIT_TEST`／`STATIC_REVIEW`／`INJECTED_SERVER_EMULATOR`（本轮未用注入服务端）。
状态：`PASS / FAIL / BLOCKED / NOT_RUN`。

---

## 1. 提交 → 子系统映射

| 提交 | 子系统 | 主要文件 |
|---|---|---|
| `1aa2d82` | 全部（奠基，114 文件） | 手机工具/审批/后台屏/本地 runtime/agent-core/FGS/Manifest |
| `9727238` | 审批+手机+agent-core | `Tools.kt`、`AgentRuntime.kt`、`PhoneBridge.kt`、`PhoneTools.kt`、`AgentLoopTest.kt` |
| `ebcc9a1` | 审批 digest 绑定 | `CloudModel.kt`、`AgentModule.kt`、`AgentOverlayController.kt`、`AgentRuntime.kt`、`local-approvals.js` |
| `9c17dbd` | 仅测试 mock 修复 | `butler-activity-notify-spec.mjs`、`loading-skeleton-spec.mjs` |
| `2a27192` | agent-core 上下文/恢复 | `AgentLoop.kt`、`RunRecovery.kt`、`RunStore.kt`、`FileRunStoreTest.kt`(新) |
| `9028d26` | **仅** `OutpostAccessibilityService.kt` | type 跨包中止（+62/−8） |
| `9cef57e` | 凭据 | `AgentSettingsStore.kt`、`AgentSettingsScreen.tsx` |
| `946e291` | **仅** `AgentModule.kt` | 后台屏等待移出 RN native-modules 队列 |
| `d4c0869` | 本地 runtime host | `runtime/host.mjs`、`local-runtime-host-spec.mjs` |
| `2325d34` | **非 Android**（butler） | `task-manager.js`、`task-manager.test.mjs` |

> `2325d34` 与 `ebcc9a1` 的一部分、`9c17dbd` 不涉及 Android 原生代码；矩阵中单列。

---

## 2. 功能矩阵

### 2.1 设备控制（B1，详见 04）

| # | 功能 | 源码证据 | 既有自动化 | 本轮状态 | 证据类型 |
|---|---|---|---|---|---|
| 1 | 原生模块加载 / 工具注册 | `MainApplication.kt:24-25`；`AgentModule.kt:22`；`AgentRuntime.kt:249-257` | 无 JS/JVM 覆盖 | **PASS** | REAL_HOST_EMULATOR（桩收到 11 个工具名） |
| 2 | `phone_screen` 快照+元素定位 | `OutpostAccessibilityService.kt:103-165`；`PhoneBridge.kt:244` | 无 | **PASS**（执行并返回；敏感屏时内容不外发） | REAL_HOST_EMULATOR |
| 3 | 敏感屏 fail-closed 接管 | `PhoneTools.kt:33-48`；`OAS:480-492` | 无 | **PASS** | REAL_HOST_EMULATOR（E5/E6） |
| 4 | `phone_tap` 真实手势 | `OAS:167-185` | 无 | **NOT_RUN**（未能在动作时刻保持非敏感前台） | — |
| 5 | **tap/scroll/key 屏幕世代校验缺口** | `OAS:168,369,381`；`screenId` 仅生产不消费（10 处 grep 全为生产者） | 无 | **FAIL（设计缺口，静态确认）** | STATIC_REVIEW |
| 6 | `type` 同包换屏盲写残留 | `OAS:220-227` 仅比 packageName；`:228-230,244` 位置回退 | 无 | **FAIL（设计缺口，静态确认）** | STATIC_REVIEW |
| 7 | `phone_scroll` | `OAS:368-380`（取第一个 scrollable，无元素绑定） | 无 | **NOT_RUN** | — |
| 8 | `phone_key` | `OAS:381-392`（全局动作） | 无 | **NOT_RUN** | — |
| 9 | `phone_open` 敏感页保护 | `PhoneTools.kt:147-158` 仅查 locked；`:163-190` 事后判敏感 | 无 | **FAIL（先拉起后拒绝，静态确认）** | STATIC_REVIEW |
| 10 | 错误目标不触发设备操作 | `OAS:169` `STALE_ELEMENT` | 无 | **PASS（拒绝路径无手势）**；允许+错误 id 的设备级断言 NOT_RUN | REAL_HOST_EMULATOR（拒绝）+ STATIC_REVIEW |

### 2.2 权限与审批（B2，详见 05）

| # | 功能 | 源码证据 | 本轮状态 | 证据类型 |
|---|---|---|---|---|
| 11 | Accessibility 授权/撤销 | `OAS:83-101`；Manifest:54-65 | **PASS**（connected/destroyed/reconnected 实测） | REAL_HOST_EMULATOR |
| 12 | 审批提示绑定用户所见 | `Contracts.kt:103-106`；`AgentOverlayController.kt:235-240` | **PASS**（digest 与参数 SHA-256 逐字匹配） | REAL_HOST_EMULATOR |
| 13 | 未授权不执行 / 拒绝后不续调 | `Tools.kt:92-94`；`AgentRuntime.kt:401,405,632` | **PASS**（拒绝→DENIED，无手势日志） | REAL_HOST_EMULATOR |
| 14 | 审批≠放行（运行时守卫仍在） | `PhoneTools.kt:33-48` | **PASS**（允许后仍被敏感屏守卫拦截） | REAL_HOST_EMULATOR |
| 15 | 敏感词子串误报（shipping⊃pin） | `OAS:75-78,487-490` | **FAIL（误报确认，方向 fail-closed）** | STATIC_REVIEW + 已执行谓词 |
| 16 | 非法/重复审批 | `AgentRuntime.kt:400,401,405` | **PASS（静态+JVM）**；设备级 NOT_RUN | STATIC_REVIEW / UNIT_TEST |
| 17 | **原生审批无过期** | `AgentRuntime.kt:629-631` 无 TTL；对比 butler `local-approvals.js:11,87` | **FAIL（设计缺口）** | STATIC_REVIEW |
| 18 | 悬浮审批卡覆盖他应用 | `AgentOverlayController.kt:57-68,296-299` | **NOT_RUN**（本轮 RN 卡生效，悬浮卡未出现） | — |
| 19 | 后台/失权安全行为 | `AgentRuntime.kt:409-415,296-305` | **PASS（静态）**；设备级 NOT_RUN | STATIC_REVIEW |

### 2.3 后台与生命周期（B3，详见 06）

| # | 功能 | 源码证据 | 本轮状态 | 证据类型 |
|---|---|---|---|---|
| 20 | FGS 启动 | `AgentService.kt:74`；Manifest:49-53 | **PASS**（isForeground=true, id=4201, dataSync） | REAL_HOST_EMULATOR |
| 21 | FGS 停止 / 息屏即停 | `AgentService.kt:34-41` | **PASS**（SCREEN_OFF 后服务计数 0） | REAL_HOST_EMULATOR |
| 22 | 无 SCREEN_ON/USER_PRESENT 恢复路径 | grep 全仓 0 命中 | **FAIL（设计缺口：息屏后不自动恢复）** | STATIC_REVIEW |
| 23 | AgentService 无 onTimeout/时限 | grep `onTimeout` 仅 `DshRuntimeService.java:88,89` | **FAIL（设计缺口，API36 dataSync 上限待测）** | STATIC_REVIEW |
| 24 | 任务取消传播 | `AgentRuntime.kt:505-520`；`AgentLoop.kt:128-142` | **PASS**（持久化 INTERRUPTED/stopped-by-user） | REAL_HOST_EMULATOR |
| 25 | 取消为协作式（非抢占） | `AgentRuntime.stop()` 无 interrupt/shutdownNow | **FAIL（设计缺口：进行中 tool 跑完）** | STATIC_REVIEW |
| 26 | 前后台切换状态保留 | `agent-thread.json` 持久化 | **PASS** | REAL_HOST_EMULATOR |
| 27 | 无障碍断开/恢复 | `OAS:83-101` | **PASS**（多次 destroyed/connected） | REAL_HOST_EMULATOR |
| 28 | RN 队列不阻塞 | `AgentModule.kt:25-27,75-96` | **PASS（静态+JVM 间接）** | STATIC_REVIEW |
| 29 | 后台虚拟屏 / Shizuku | `BackgroundDisplayController.kt`、`BackgroundDisplayUserService.kt` | **BLOCKED**（需 Shizuku，未启动） | — |
| 30 | Runtime 异常退出升级 | `RuntimeSupervisor.java:235-257` | **PASS（静态+JVM）**；设备级 BLOCKED | STATIC_REVIEW / UNIT_TEST |

### 2.4 本地 Agent 与 DSH Runtime（B4，详见 06）

| # | 功能 | 源码证据 | 本轮状态 | 证据类型 |
|---|---|---|---|---|
| 31 | Agent 原生模块加载 | `AgentModule.kt`、`LocalDshModule.kt:19` | **PASS** | REAL_HOST_EMULATOR |
| 32 | 本地任务创建/运行/取消 | `AgentRuntime.kt`；run 状态文件 | **PASS** | REAL_HOST_EMULATOR |
| 33 | 异常失败关闭 | `Tools.kt:89-91,104-106` | **PASS** | REAL_HOST_EMULATOR + UNIT_TEST |
| 34 | 本地数据保存/恢复 | `RunStore.kt`；`files/agent-runs/*.properties`、`agent-thread.json` | **PASS** | REAL_HOST_EMULATOR |
| 35 | 凭据 Keystore 隔离 | `AgentSettingsStore.kt:30,110-145`；key 不回传 JS | **PASS**（掩码+已保存；androidTest 5 项静态在库） | REAL_HOST_EMULATOR + STATIC_REVIEW |
| 36 | provider 变更不带走旧 key | `AgentSettingsStore.kt:62-69` | **PASS（静态+JVM 无；代码确认）** | STATIC_REVIEW |
| 37 | **本地 DSH runtime 全链路** | `LocalDshModule.kt:27-36`；`RuntimeSupervisor.java:128-129` | **BLOCKED**（`libproot.so` 缺失 ⇒ hasBundledRuntime=false，入口隐藏） | REAL_HOST_EMULATOR（门控证实） |
| 38 | JNI runner 编译/存在 | `cpp/runtime-runner.c`；`build-runtime-native.mjs:8` | **PASS**（x86_64 `libdsh-runtime-runner.so` 已安装） | REAL_HOST_EMULATOR |
| 39 | 权限越界拒绝 | `RuntimeSupervisor.java:118-137` | **PASS（静态）**；设备级 BLOCKED | STATIC_REVIEW |

### 2.5 非 Android / 测试设施

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 40 | `2325d34` butler 任务取消记录 | **PASS** | UNIT_TEST（`task-manager.test.mjs`，npm test 内） |
| 41 | `9c17dbd` mock 修复 | **PASS** | UNIT_TEST（npm test 内） |
| 42 | agent-core 38 JVM 测试 | **PASS** | UNIT_TEST（本轮 `:agent-core:test` 38/38） |
| 43 | **androidTest 7 项** | **NOT_RUN**（任何 CI job 都不跑；`RuntimeInstallerChecks.java` 为**孤儿**，0 @Test 无调用者） | STATIC_REVIEW |
| 44 | `test:p3/p4/localRuntime` 不在 `npm test` | **FAIL（覆盖缺口）** | STATIC_REVIEW（package.json 核实） |
| 45 | **N1 原生 cookie 容器：清理无超时 / 读超时被吞成误导 401** | **FAIL（本轮回归新发现，敏感：凭据/认证；只交方案）** | REAL_HOST_EMULATOR（`07` §4、`regression/emulator-core-regression.txt`） |
| 46 | **N2 死胡同工作区弹层（无出口、跨重启仍在）** | **FAIL（本轮回归新发现，产品 UI；只交方案）** | REAL_HOST_EMULATOR（`07` §4.4、reg-02/reg-03 截图） |

---

## 3. 汇总

- **PASS（真实 Emulator）**：#1,2,3,10(拒绝),11,12,13,14,20,21,24,26,27,31,32,33,34,35,38
- **FAIL（设计缺口，静态确认，未擅自修改）**：#5,6,9,15,17,22,23,25,44
- **FAIL（本轮回归新发现，只交方案）**：#45（N1 cookie 容器）、#46（N2 死胡同弹层）
- **BLOCKED**：#29,30(设备级),37,39(设备级)
- **NOT_RUN**：#4,7,8,10(允许+错误id设备级),16(设备级),18,19(设备级),43

**结论**：P1 的「安全骨架」（fail-closed 审批、敏感屏接管、 digest 绑定、FGS、取消与持久化）在真实
Emulator 上**成立**；但**设备控制的屏幕世代绑定、type 同包盲写、phone_open 事前敏感校验、敏感词子串、
原生审批过期、息屏恢复、AgentService 时限**等缺口**仍然存在**，属设计层面，需第二方复核后才可修改。