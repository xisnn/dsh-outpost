# 06 · P1 后台运行、原生生命周期与本地 Runtime 验收结果

- 设备/包同 04。原始证据：`logs/fgs-agent-service-running.txt`、`logs/logcat-p4-full.log`、
  `evidence/device-native-runtime-evidence.txt`、`evidence/p4-06-fgs-handoff.png`

---

## 1. 前台服务与生命周期（REAL_HOST_EMULATOR）

### 1.1 FGS 启动 — PASS

run 期间 `dumpsys activity services`：

```
ServiceRecord{… com.dshoutpost.p1.p3e2e/com.dshpocket.agent.AgentService}
intent={act=com.dshpocket.agent.RUN …}
isForeground=true foregroundId=4201 types=0x00000001
foregroundNoti=Notification(channel=outpost-agent … flags=ONGOING_EVENT|NO_CLEAR|FOREGROUND_SERVICE …)
targetSdkVersion=36
```

`types=0x1` = `FOREGROUND_SERVICE_TYPE_DATA_SYNC`，与 Manifest:53 声明一致；通知渠道 `outpost-agent`、id 4201
与 `AgentService.kt:27-28` 一致。

### 1.2 息屏即停 — PASS

run 挂起期间发送 `KEYCODE_SLEEP`（SCREEN_OFF）后，`dumpsys activity services … | grep -c AgentService` = **0**
⇒ 前台服务停止。对应 `AgentService.kt:34-41`（SCREEN_OFF → `AgentRuntime.stop()` + 通知「屏幕已锁定，手机任务停止」）。
logcat 可见 `ActivityManager: Stop FGS timeout: …AgentService` 与 SCREEN_OFF 时间吻合。

### 1.3 无息屏恢复路径 — FAIL（设计缺口）

全仓 grep `ACTION_SCREEN_ON` / `ACTION_USER_PRESENT` **0 命中** ⇒ 解锁后**不会自动恢复** run。
后台模式无法息屏运行（与上一轮 §4.1 一致）。

### 1.4 AgentService 无 onTimeout / 无自限时限 — FAIL（设计缺口）

grep `onTimeout` 仅 `DshRuntimeService.java:88,89`；`AgentService` 无 override、无应用层 deadline
（对比 `DshRuntimeService.java:71` 15 分钟上限）。API 36 对 dataSync FGS 的系统上限行为**待真机/长时间实测**。

### 1.5 任务取消传播与持久化 — PASS

点击「停止」后，持久化 run 状态（`files/agent-runs/17bf29f7-….properties`）：

```
phase=INTERRUPTED
reason=stopped-by-user
lastToolStatus=DENIED
lastToolName=phone_screen
lastToolMayHaveSideEffect=false
lastToolDigest=44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
requiresReconciliation=false
step=1
```

⇒ 取消真实传播到 run 状态并落盘；`lastToolMayHaveSideEffect=false` 正确记录被拒绝工具无副作用；
digest 落盘供恢复时校验。UI 显示「任务未完成：stopped-by-user」。

### 1.6 取消为协作式 — FAIL（设计缺口）

`AgentRuntime.stop()`（`:505-520`）只置标志+signal，**无 `Thread.interrupt()`/`shutdownNow()`**；
已陷入 `type()` 10×400ms 循环或 `Thread.sleep` 的工具会跑完。非抢占。

### 1.7 前后台切换 / 无障碍断开恢复 — PASS

`agent-thread.json` 持久化完整对话；切换/重装/息屏期间 `DshPhoneA11y` 多次 destroyed→connected，
会话与列表状态保留。

### 1.8 RN native-modules 队列不阻塞 — PASS（静态+间接）

`AgentModule.kt:25-27,75-96` 把后台屏等待移到独立 `startExecutor`；本轮 run 期间 UI 仍可响应
（审批卡可点、可停止），未观察到队列阻塞。

---

## 2. 本地 Agent 与 DSH Runtime

### 2.1 本地任务创建/运行/取消/持久化 — PASS

见 1.5；`files/agent-runs/*.properties`（4 个 run）+ `agent-thread.json` + `agent-workspace/` 真实存在。
`RunStore`/`RunRecovery` 由 38 个 JVM 测试覆盖（本轮 38/38）。

### 2.2 本地 DSH runtime 全链路 — BLOCKED（门控在设备上证实）

已安装 native 库（x86_64）含 `libdsh-runtime-runner.so`，但 **`libproot.so` 计数 = 0**，
且无 `assets/dsh-runtime` manifest ⇒ `LocalDshModule.getConstants()` 的
`hasBundledRuntime = hasManifest && hasProot` = **false**（`LocalDshModule.kt:27-36`），
本地 runtime 入口隐藏；`RuntimeSupervisor.java:128-129` 另以
`libdsh-runtime-runner.so + libproot.so` 双文件做启动门控。
**Emulator 默认构建无法验证全链路**；需 `-PDSH_RUNTIME_NATIVE_DIR/-PDSH_RUNTIME_ASSETS_DIR` 注入或真机安装路径。

### 2.3 JNI runner — PASS（存在/编译）

`libdsh-runtime-runner.so` 已随 x86_64 包安装（`build-runtime-native.mjs:8` 含 x86_64）。
其为**可执行 owner**（非 `System.loadLibrary`），`cpp/runtime-runner.c:36-81` 实现
setsid/PDEATHSIG/subreaper/进程组清理/exit≥125 不宣称 verified stop。运行时行为设备级 BLOCKED（同 2.2）。

### 2.4 凭据与用户数据隔离 — PASS

Keystore AES/GCM-256、key 不回传 JS、`allowBackup=false`、`getNoBackupFilesDir()`、
stderr 不落盘（`RuntimeSupervisor.java:153`）。provider 变更不带旧 key（`AgentSettingsStore.kt:62-69`，
信任边界 scheme+host+port）。

### 2.5 权限越界拒绝 — PASS（静态）/ BLOCKED（设备级）

`RuntimeSupervisor.java:118-137`：`SDK_INT<28`/非 arm64/x86_64 → `LOCAL_RUNTIME_UNSUPPORTED`；
未安装 → `RUNTIME_NOT_INSTALLED`；需 reconciliation → `RECONCILIATION_REQUIRED`；
停止中 → `RUNTIME_STOPPING`；先前 app 进程存在 → `PRIOR_APP_PROCESS_PRESENT`。
设备级因 2.2 BLOCKED。

### 2.6 Runtime 异常退出升级 — PASS（静态+JVM）/ BLOCKED（设备级）

`RuntimeSupervisor.java:235-257` 分级：shutdown → +1.5s 关 stdin → +4s SIGTERM → +7s SIGKILL+destroyForcibly
→ +10s 强杀并 fail-all `RUNTIME_EXITED`；`killOwner` 先校验 `/proc/<pid>` UID 再杀进程组。
看门狗：调度间隙>20s / 心跳>15s / 后台空闲>30s。JVM `RunRecoveryTest`/`FileRunStoreTest` 本轮通过。

---

## 3. 后台虚拟屏 / Shizuku — BLOCKED

`BackgroundDisplayController.kt`/`BackgroundDisplayUserService.kt` 需先 adb 起 Shizuku；
`FLAG_TRUSTED` + 反射 `ShellContext` 依赖 ROM。本轮**未启动 Shizuku**，不宣称验收。
帧回读为 **ImageReader（非 MediaProjection）**（`:602-605,714-756`），全仓无 MediaProjection。

---

## 4. 测试设施缺口

- **androidTest 7 项不被任何 CI job 运行**（`.github/workflows` 无 connectedAndroidTest）。
  `KeychainStorageValidationTest`(5) + `LocalRuntimeBridgeValidationTest`(2)。
- **`RuntimeInstallerChecks.java`（404 行）是孤儿**：0 `@Test`、全仓无调用者 ⇒ 贡献 0 断言。
  上一轮把它列为覆盖是**高估**。
- `test:p3` / `test:p4` / `test:localRuntime` **不在 `npm test`**，需显式调用。
- 手机工具/敏感词/原生审批/后台屏/悬浮卡 **零 JS/JVM/androidTest 覆盖**。

---

## 5. 待真机验证（Emulator 无法证明）

厂商后台杀进程/自启、真实 IME/触摸硬件、API36 dataSync FGS 长时间上限、
Shizuku 虚拟屏 ROM 行为、本地 runtime 全链路（需 bundled runtime）、真实电池优化策略。
**真机已连接但本轮未使用**（个人手机驱动设备控制不可安全恢复）。