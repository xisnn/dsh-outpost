# dsh-mobile — Android Debug APK 构建报告（本轮：TEST BUILD ONLY）

**结论（一句话）：** `assembleDebug` **未产出本轮 APK —— 被沙箱环境限制阻断**。失败的收口阶段是 `:app:configureCMakeDebug[arm64-v8a]`，根因是**当前沙箱禁止父进程通过管道捕获子进程 stdout**，导致 CMake 的 `try_compile` 经 `ninja` 链接探测时被 `EPERM` 打死。**不是项目代码错误，不是依赖解析失败，不是 SDK/NDK 配置错误。**

- 日期：2026-10-25（Asia/Tokyo）
- 构建模式：**Debug / 测试构建**（`assembleDebug`）。未构建 release，未签名正式密钥，未推送，未打 tag。
- 本轮**未产出新的可交付 APK**。仓库中现有的 `app-debug.apk` 是**陈旧的**，不能当作本轮产物交付（见第 7 节）。

---

## 1. 环境与工具链（已核验）

| 项 | 值 | 核验方式 |
|---|---|---|
| OS | Windows 11 10.0.26100 amd64 | Gradle `--version` 输出 |
| JDK | Temurin **21.0.8** @ `D:\Jdk21` | `java -version` |
| Gradle | **8.14.3**（wrapper 指定；发行版已解压） | `gradlew.bat --version` → exit 0 |
| AGP | **8.11.0** | `node_modules/react-native/gradle/libs.versions.toml` |
| Kotlin | **2.1.20** | `android/build.gradle` |
| React Native | **0.81.4** | `node_modules/react-native/package.json` |
| Metro | **0.83.8** | bundle banner |
| Node | **v24.13.0** | `node --version` |
| Android SDK | `E:\Android\Sdk`（`local.properties` = `sdk.dir=E\:\\Android\\Sdk`） | 文件读取 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 24 | `android/build.gradle` |
| Build Tools | 36.0.0 | `android/build.gradle` |
| NDK | 27.1.12297006 | `android/build.gradle` |
| CMake | 3.22.1（`E:\Android\Sdk\cmake\3.22.1`） | `CMakeOutput.log` |
| ninja | 1.10.2 | `ninja --version` → exit 0 |

**未升级任何 AGP / Gradle / NDK / Kotlin / RN 版本。** 未修改 `applicationId`，未修改签名身份。

---

## 2. 实际执行的命令与真实结果

### 2.1 `gradlew.bat` wrapper 的 `.lck` 权限错误（次要问题，已定位）

首次尝试（`cd dsh-mobile\android; .\gradlew.bat --version`）失败：

```
Exception in thread "main" java.io.FileNotFoundException:
  C:\Users\xis\.gradle\wrapper\dists\gradle-8.14.3-bin\cv11ve7ro1n3o1j4so8xd9n66\gradle-8.14.3-bin.zip.lck (拒绝访问。)
    at java.base/java.io.RandomAccessFile.open0(Native Method)
    at org.gradle.wrapper.GradleWrapperMain.main(SourceFile:67)
```

**真实原因（已实测证明，不是猜的）：** 该沙箱只允许写**工作区** `E:\work\dsBot`；`C:\Users\xis\.gradle` 整体**不可写**。用写探针逐层验证：

```
WRITE DENY : C:\Users\xis\.gradle          --> UnauthorizedAccessException
WRITE DENY : C:\Users\xis\.gradle\wrapper\dists --> UnauthorizedAccessException
WRITE DENY : C:\Users\xis\AppData\Local\Temp --> UnauthorizedAccessException
WRITE DENY : E:\Android\Sdk                 --> UnauthorizedAccessException
WRITE OK   : E:\work\dsBot\dsh-mobile\android
```

Gradle wrapper 在解压目录旁必须创建/打开 `*.zip.lck`（`RandomAccessFile` 读写），拿到 `AccessDenied` 就直接抛异常退出。**zip 本身没坏、`.ok` 标记存在、发行版是完整的**——纯粹是 home 目录不可写。

**正确解法（已验证有效）：** 把 `GRADLE_USER_HOME` 指向工作区内的可写目录，并预置依赖缓存（本机**无外网**，见 2.3）：

```powershell
$env:JAVA_HOME='D:\Jdk21'
$env:ANDROID_HOME='E:\Android\Sdk'
$env:ANDROID_SDK_ROOT='E:\Android\Sdk'
$env:GRADLE_USER_HOME='E:\work\dsBot\_gradle-home'      # 从 C:\Users\xis\.gradle 预拷 ~2.5 GB
$env:ANDROID_USER_HOME='E:\work\dsBot\_android-home'    # 拷 debug.keystore / adbkey
$env:LOCALAPPDATA='E:\work\dsBot\_localappdata'         # Kotlin daemon 需要可写的 %LOCALAPPDATA%\kotlin
cd E:\work\dsBot\dsh-mobile\android
.\gradlew.bat --version
```

重试后 **exit 0**：

```
------------------------------------------------------------
Gradle 8.14.3
------------------------------------------------------------
Launcher JVM:  21.0.8 (Oracle Corporation 21.0.8+12-LTS-250)
Daemon JVM:    D:\Jdk21
OS:            Windows 11 10.0 amd64
```

> 说明：`gradlew.bat` **本身可以正常工作**，无需改用直接 `gradle.bat`。任务简报里"wrapper 坏了"的推断不成立，真实原因是 GRADLE_USER_HOME 不可写。

### 2.2 配置阶段 — **成功**

```powershell
.\gradlew.bat --no-daemon --console=plain --stacktrace :app:tasks --group=build
```

**结果：`BUILD SUCCESSFUL in 4m 20s`，exit 0。** `:app` 成功配置，`assemble` / `assembleDebug` 等任务正常列出。完整日志：`BUILD-LOG-config.txt`。

过程中出现的告警均**非致命**，且都属于同一个可写性根因：

- `Unable to initialize metrics, ensure C:\Users\xis\.android is writable`（AGP 想写 analytics.settings）
- `e: java.nio.file.AccessDeniedException: C:\Users\xis\AppData\Local\kotlin\daemon\kotlin-daemon-client-tsmarker*.tmp` → Kotlin 编译守护进程连不上，**自动回退到 in-process 编译并成功**
- `Exception in thread "File watcher server" net.rubygrapefruit.platform.NativeException: Couldn't open current thread, error = 5`（文件监听线程被禁，不影响构建）

### 2.3 无外网（重要前提）

依赖解析**完全依赖本机缓存**，网络探测全部失败：

```
FAIL https://dl.google.com/dl/android/maven2/...      --> 基础连接已经关闭
FAIL https://repo.maven.apache.org/maven2/           --> 基础连接已经关闭
FAIL https://services.gradle.org/distributions/      --> 基础连接已经关闭
```

因此 `GRADLE_USER_HOME` 必须从 `C:\Users\xis\.gradle\caches\modules-2` 预拷（约 1.29 GB / 3143 文件）才能离线解析 AGP、RN、Kotlin 等依赖。**实测配置阶段在此前提下成功，说明依赖解析没有问题。**

### 2.4 `assembleDebug` — **失败（环境限制）**

```powershell
.\gradlew.bat --no-daemon --console=plain --stacktrace --no-watch-fs ':app:assembleDebug'
```

**结果：`BUILD FAILED`，exit 1，耗时 31m 56s。** 完整日志：`BUILD-LOG-assembleDebug.txt`。

失败前大量任务已完成（`mergeDebugResources`、`processDebugResources`、`compileDebugKotlin`、`dexBuilderDebug`、`mergeProjectDexDebug`、各 autolinking codegen 等均 PASS/UP-TO-DATE），**卡死在原生库配置阶段**。

Gradle 给出的表层错误（日志原文）：

```
FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:configureCMakeDebug[arm64-v8a]'.
> [CXX1429] error when building with cmake using
  E:\work\dsBot\dsh-mobile\node_modules\react-native\ReactAndroid\cmake-utils\default-app-setup\CMakeLists.txt:
  -- The C compiler identification is Clang 18.0.2
  -- The CXX compiler identification is Clang 18.0.2
  -- Detecting C compiler ABI info

  C++ build system [configure] failed while executing:
      "E:\Android\Sdk\cmake\3.22.1\bin\cmake.exe" ...
        "-DANDROID_ABI=arm64-v8a" ... "-GNinja"
```

即：**编译器识别已成功，死在紧接着的 "Detecting C compiler ABI info"**，且 Gradle 报不出任何底层诊断信息。

---

## 3. 根因：沙箱禁止"父进程管道捕获子进程 stdout"（已用最小用例证明）

### 3.1 沙箱限制的直接证据

同一命令，仅 `stdio` 模式不同：

```
node -e "spawnSync('cmd',['/c','echo hi'],{stdio:'pipe'})"     -> status=null  error=EPERM
node -e "spawnSync('cmd',['/c','echo hi'],{stdio:'ignore'})"   -> status=0
node -e "spawnSync('cmd',['/c','echo hi'],{stdio:'inherit'})"  -> status=0
```

`worker_threads`（线程，非进程）正常：`worker_threads OK, got 42`。→ 限制的是**子进程 stdout 管道**，不是所有并发。

### 3.2 ninja 因此必然挂死

ninja **无条件**通过管道捕获子进程输出。最小复现（`ninja.exe` 1.10.2，`E:\Android\Sdk\cmake\3.22.1\bin`）：

| 用例 | 结果 |
|---|---|
| `ninja --version`（不产生子进程） | exit 0 → `1.10.2` |
| `ninja -t targets`（只解析，不跑） | exit 0 |
| `ninja`，rule = `cmd.exe /c "echo hello > $out"` | **HUNG >60s**，但 `out.txt` 已被创建 |
| `ninja`，rule = 直接 `node.exe -e "...writeFileSync(...)"` | **HUNG >60s**，但 `marker.txt` 已被创建 |

**关键判据**：子进程**确实执行成功了**（输出文件已生成），而 ninja 仍挂住。在挂起状态下检查进程树：

```
ninja alive: True PID=6836
marker.txt created: True
>>> NO LIVE CHILDREN -> child already EXITED; ninja is stuck on its own I/O <<<
```

ninja 线程处于 `Wait EventPairLow`——**卡在读它和已退出子进程之间的管道上**（子进程侧因 EPERM 无法正常传回输出/关闭管道）。这是权限拒绝导致的等待，不是死循环。

### 3.3 工具链本身是健康的（排除 NDK/SDK 配置问题）

| 测试 | 结果 |
|---|---|
| `clang.exe --version` | exit 0 → `clang version 18.0.2` |
| `clang --target=aarch64-none-linux-android24 -c` | **exit 0**，`.o` 生成 |
| `clang --target=aarch64-none-linux-android24 <src> -o exe`（链接） | **exit 0**，产物生成 |
| 带完整 Android link flags 链接（`-Wl,-z,max-page-size=16384` 等） | **exit 0**，6816 字节可执行文件 |
| `llvm-ar.exe rcs` | **exit 0**，`.a` 生成 |
| CMake 的 `execute_process()` 管道捕获（非 ninja 路径） | **rc=0**，正常返回 `1.10.2` |

再进一步：把失败现场 `.cxx\Debug\1v5l374x\arm64-v8a\CMakeFiles\CMakeTmp` 里 ninja 生成的三条命令（compile / link / `cmd.exe /C` 包装链接）**手工逐条执行，全部 exit 0 并产出文件**。同一批命令，经过 ninja 就挂死 → 问题 100% 在 ninja 的子进程捕获，而非编译器、NDK、CMake 配置或 flags。

`CMakeOutput.log` 也印证了这一点：

```
Compilation of the C compiler identification source "CMakeCCompilerId.c" produced "CMakeCCompilerId.o"
The C compiler identification is Clang, found in ".../CompilerIdC/CMakeCCompilerId.o"
Compilation of the CXX compiler identification source "CMakeCXXCompilerId.cpp" produced "CMakeCXXCompilerId.o"
```

`CMakeCCompilerABI.c.o` 也**已产出**——坏的一步恰好是 `try_compile` 把 **LINK** 交给 ninja 那一步。

### 3.4 为什么在 Gradle 里表现为"卡 30 分钟然后失败"

我的构建在 `configureCMakeDebug[arm64-v8a]` 上**静默挂起 20+ 分钟**（实测 45 秒内 Gradle 守护进程 CPU 仅 +0.3s，`.cxx` 目录 5 分钟内零文件变更）。为拿到真实错误，我 kill 了卡死的 `ninja`/`cmake` 子进程，Gradle 才输出上述 `[CXX1429]`。**这个失败是我主动终止挂起后暴露的，不是项目自己崩的。**

### 3.5 为什么无法在本环境绕过（明确不做的尝试）

- Gradle 的 `externalNativeBuild` **只能**通过 ninja 驱动 CMake；RN 0.81 + `newArchEnabled=true` 必需 CMake/ninja 路径（`libappmodules.so`、`libreact_codegen_*.so`、hermes 等）。
- **未**设置 `CMAKE_TRY_COMPILE_TARGET_TYPE` 之类标志去"骗过" ABI 探测：即便配置阶段过了，后续每一个真实编译/链接仍要走 ninja，会以完全相同的方式失败；这样产出的 APK 也不代表真实构建机的结果。
- **未**改用 ndk-build / Android.mk：属于禁止的大规模架构改动，且同样需要能 spawn 子进程的环境。
- 未升级 / 降级任何工具版本。

---

## 4. 失败分类（明确结论）

| 维度 | 判定 | 依据 |
|---|---|---|
| **项目代码错误** | ❌ **不是** | Metro bundle 成功（第 5 节）；`compileDebugKotlin`、`dexBuilderDebug` 等全部通过 |
| **依赖解析** | ❌ **不是** | 配置阶段在完全离线、依赖全部命中本地缓存的情况下 `BUILD SUCCESSFUL` |
| **SDK / NDK 配置** | ❌ **不是** | clang/llvm-ar 直接调用全部成功；CMake 识别编译器成功；路径全部正确 |
| **环境 / 沙箱限制** | ✅ **是** | 沙箱禁止父进程管道捕获子进程 stdout（EPERM）；ninja 强制使用管道 → 必然挂死 |

**根因一句话：** 沙箱禁止"父进程通过管道捕获子进程 stdout"，而 ninja（CMake 的默认构建后端，也是 AGP `externalNativeBuild` 的唯一路径）无条件依赖该能力，因此在 `Detecting C compiler ABI info` 阶段挂起并以 EPERM 退出，导致 `:app:configureCMakeDebug[arm64-v8a]` 失败。

> 注：这与本次任务里其他 agent 遇到的 `spawn EPERM`（tsx / npm test）是**同一个**沙箱限制的两个表现。但**具体到本次 APK 失败，它不是"spawn 完全不可用"**——子进程能启动、能干活、能产出文件；失败点是**stdout 管道捕获**这一个能力。

---

## 5. 附加验证：项目 JS/TS 代码可以通过真实 Metro 流水线打包（**成功**）

这是本轮真正被改动、且在无 Android 工具链时仍可验证的部分。Metro 是纯 JS，但默认用 `jest-worker` 的 `fork()` 起子进程 → 首次尝试同样被 EPERM 打死：

```
node.exe : Failed to construct transformer:  Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:421:11)
    at fork (node:child_process:174:10)
    at ChildProcessWorker.initialize (.../jest-worker/build/workers/ChildProcessWorker.js:144:45)
error Cannot read properties of undefined (reading 'end').
```

Metro 的 `WorkerFarm` 在 `maxWorkers <= 1` **不建 worker 池、在进程内直接转译**，因此加上 `--max-workers 1` 即可绕开子进程，让 Metro 真实跑完全部 TS/JSX：

```powershell
cd E:\work\dsBot\dsh-mobile
npx --no-install react-native bundle --platform android --dev false `
  --entry-file index.js `
  --bundle-output E:\work\dsBot\_bundle-probe\index.android.bundle `
  --assets-dest E:\work\dsBot\_bundle-probe\res `
  --max-workers 1
```

**结果：`FINAL_EXIT=0`，`Done writing bundle output`。**

| 产物 | 值 |
|---|---|
| 路径 | `E:\work\dsBot\_bundle-probe\index.android.bundle` |
| 大小 | **2,102,992 bytes (2.01 MiB)** |
| SHA256 | `E0187884120E81E9F1321B500BFCA4AED29C11F586B1A469060C4CB2A97F6017` |
| SHA1 | `3CDD849EDF28E5AA83A383FEB7956207811C9725` |
| 形态 | 单行压缩生产 bundle，824 行，768 个 `__d(` 模块注册，`--dev false` |

**"本轮改动的模块确实进了 bundle"的证明**（按运行时字符串字面量检索，避免压缩后标识符被 mangle）：

| 模块 / 主题 | 检索串 | 命中 |
|---|---|---|
| `deviceRevocation.ts` | `server-revoked` | ✅ |
| `deviceRevocation.ts` | `self-revoked` | ✅ |
| `credentialMigration.ts` | `read-failed` | ✅ |
| `credentialMigration.ts` | `already-secure` | ✅ |
| `cookieJar.ts` | `dsh-auth` | ✅ |
| `cookieJar.ts` | `unverified` | ✅ |
| `secureStore.ts` | `dsh.revocationMarker` | ✅ |
| `index.js` | `DshPocket` | ✅ |

**意义：** `App.tsx`、`store.ts`、`deviceAuth.ts`、`approvalGateway.ts`、`cookieJar.ts`、`credentialMigration.ts`、`deviceRevocation.ts` 等本轮被修改的 TS 文件，**全部通过了真实的 Metro/Babel 转译管线**（不只是 `tsc` 类型检查），且依赖图可达。这是本轮能拿到的最强的"代码没被改坏"证据。

---

## 6. 不构建也能断言的事实（静态核验，仍然有效）

| 项 | 值 | 来源 |
|---|---|---|
| `namespace` | `com.dshpocket` | `android/app/build.gradle:80` |
| `applicationId` | **`com.dshpocket`** ✅ 未变 | `android/app/build.gradle:82` |
| `versionCode` | `(findProperty('DSH_VERSION_CODE') ?: '1').toInteger()` → 未传参时 **1** | `android/app/build.gradle:89` |
| `versionName` | `(findProperty('DSH_VERSION_NAME') ?: '1.0')` → 未传参时 **"1.0"** | `android/app/build.gradle:90` |
| 本轮是否传了 `-PDSH_VERSION_CODE/-PDSH_VERSION_NAME` | **否**，均为默认值 | 构建命令 |
| debug `signingConfig` | `signingConfigs.debug`：`storeFile=debug.keystore`、`storePassword='android'`、`keyAlias='androiddebugkey'`、`keyPassword='android'` | `android/app/build.gradle:97-102,115` |
| release 签名 | 仅当传入 `-PDSH_STORE_FILE` 才用正式密钥，否则回退 debug | `android/app/build.gradle:104-111,118` |
| 本轮是否使用正式密钥 | **否** | 只跑了 `assembleDebug` |
| `minSdk/targetSdk/compileSdk` | 24 / 36 / 36 | `android/build.gradle` |

以上为**源码级断言**；因为本轮没有产出 APK，**无法**用 `aapt2 dump badging` / `apkanalyzer` 对"新产物"做实证。上一次成功构建的 metadata 可作旁证（见下）。

> **重要区分：** `applicationId="com.dshpocket"` 是**源码里写死的**，本轮未改动；`versionCode=1` / `versionName="1.0"` 是**未传参时的默认值**，属"将采用的默认值"，不是"已产物的实际值"。若真实构建机传了 `-PDSH_VERSION_CODE` / `-PDSH_VERSION_NAME`，产物会是别的值。

---

## 7. 现有 APK 产物的状态 —— ⚠️ 陈旧，禁止当作本轮产物交付

| 产物 | 大小 | 时间戳 | 判定 |
|---|---|---|---|
| `android/app/build/outputs/apk/debug/app-debug.apk` | 137,286,513 B (≈130.9 MiB) | **2026/10/23 19:12:31** | ⚠️ **陈旧** |
| `android/app/build/outputs/apk/debug/output-metadata.json` | 395 B | 2026/10/23 19:12:31 | ⚠️ 陈旧 |
| `android/app/build/outputs/apk/release/app-release.apk` | 76,270,249 B | 2026/10/22 05:21:39 | 陈旧（且非本轮任务） |

构建前后我**均未修改、未删除**任何既有产物（构建 session 的 PRE/POST 清单记录在 `BUILD-LOG-assembleDebug.txt` 尾部，两个时间戳完全一致）。

`output-metadata.json`（上一轮产物，仅作字段旁证）：

```json
{ "applicationId": "com.dshpocket", "variantName": "debug",
  "elements": [ { "versionCode": 1, "versionName": "1.0", "outputFile": "app-debug.apk" } ] }
```

**❗该 `app-debug.apk` 早于本轮所有源码改动（10/23 19:12 vs 本轮 10/25 的修改），不包含本轮 P0/P1 的修补，绝不能作为"本轮可测试包"交给测试同学。** 它只能作为"上一次构建确实产出过 debug APK"的历史证据。

---

## 8. 真实构建机需要做什么才能验证

1. **换到允许子进程 stdout 管道的环境**（本机受限的沙箱之外，或放行 `ninja` 的子进程管道能力）。这是**唯一**的硬性阻塞项。
2. 在可写 home 下跑（或显式指定可写目录）：`GRADLE_USER_HOME`、`ANDROID_USER_HOME`、`LOCALAPPDATA`，并保证 `JAVA_HOME` / `ANDROID_HOME` 已导出。
3. 联网（或预热依赖缓存）以解析 AGP 8.11.0 / RN 0.81.4 / Kotlin 2.1.20 等依赖；NDK 27.1.12297006 与 CMake 3.22.1 需已安装。
4. 执行：
   ```powershell
   cd dsh-mobile\android
   .\gradlew.bat --no-daemon assembleDebug
   ```
5. 产物核对：
   ```powershell
   $apk = "app\build\outputs\apk\debug\app-debug.apk"
   E:\Android\Sdk\build-tools\36.0.0\aapt2.exe dump badging $apk   # applicationId / versionCode / versionName / minSdk / targetSdk
   E:\Android\Sdk\build-tools\36.0.0\apksigner.bat verify --print-certs $apk   # 应为 debug 证书 CN=Android Debug
   Get-FileHash $apk -Algorithm SHA256
   ```
6. 建议同时确认 `:app:bundleDebugJsAndAssets` **未**被执行（debug 变体从 Metro 取 JS，不应打包 JS bundle）。本轮已核验：失败日志中 `bundleDebugJsAndAssets` / `createBundleDebugJsAndAssets` 出现次数均为 **0**，且无任何 `> Task :app:*[Bb]undle*` 行 —— 行为符合预期。

---

## 9. 本轮复现脚本与日志清单

| 文件 | 内容 |
|---|---|
| `BUILD-LOG-gradlew-wrapper-attempt.txt` | `gradlew.bat --version` 的 `.lck` 权限失败原始栈，及修复后的成功输出 |
| `BUILD-LOG-config.txt` | `:app:tasks` 配置阶段完整日志（**BUILD SUCCESSFUL**，含全部非致命告警） |
| `BUILD-LOG-assembleDebug.txt` | `assembleDebug` 完整日志（1,064 行；含 PRE/POST 产物清单、`[CXX1429]` 与 `GRADLE_EXITCODE=1`） |
| `BUILD-LOG-seed-gradle-home.txt` | 预置可写 `GRADLE_USER_HOME` 的拷贝记录（~2.5 GB） |
| `BUILD-LOG-metro-bundle.txt` | Metro 打包两次尝试（EPERM 失败 + `--max-workers 1` 成功）与产物哈希 |
| `BUILD-LOG-cmake-probe.txt` / `-exec-probe.txt` | CMake 最小配置探针（挂起）与 `execute_process` 管道捕获对照（正常） |
| `_build-debug.ps1` | 构建复现脚本（含所需环境变量） |

---

## 10. 残余风险与说明

- **未产出本轮 APK**，因此"能装上并跑通"这一层完全没有被验证——本轮只验证到 **JS/TS 层**（Metro 打包成功）和 **Java/Kotlin 层**（`compileDebugKotlin`、dex 阶段通过），**原生 C++ 层（RN New Architecture）完全未被验证**。
- Metro bundle 用的是 `--max-workers 1` 的进程内路径。这是沙箱下的必要变通，**转译语义与多 worker 路径一致**（同一 transformer、同一 Babel 配置），但不代表"并行构建路径"也被验证过。
- 依赖缓存从 `C:\Users\xis\.gradle` 预拷；若真实构建机缓存与本机不一致，可能暴露本机看不到的依赖问题。
- `android/app/build.gradle:105-110`：release 分支里 `storePassword project.property('DSH_STORE_PASSWORD')` 等在未传 `DSH_STORE_FILE` 时不会求值，本轮无影响；但若在不传 `DSH_STORE_FILE` 的情况下误传 `DSH_STORE_PASSWORD`，`project.property` 会抛异常——属既有写法，未修改，仅记录。
- 本轮**未**修改 `android/**` 下任何文件（无需真实修复），**未**触碰 `src/**`、`tests/**`、`package.json`。

### 10.1 ⚠️ 我创建的临时目录会污染 `git status`（需 Lead/用户决定是否删除）

为绕开"只有工作区可写"的限制，我把 Gradle/Android home 及探测产物放在了**仓库根目录**。它们**未被 `.gitignore` 覆盖**，因此会出现在 `git status` 的未跟踪列表里：

| 路径 | 大小 | 用途 | 是否必需保留 |
|---|---|---|---|
| `_gradle-home/` | **4,660 MB** | 可写 `GRADLE_USER_HOME`（含依赖缓存） | 否，可删（重跑构建需重建约 2.5 GB 种子） |
| `_android-home/` | 极小 | 可写 `ANDROID_USER_HOME`（debug.keystore 等） | 否，可删 |
| `_localappdata/` | 极小 | 可写 `%LOCALAPPDATA%`（Kotlin daemon） | 否，可删 |
| `_bundle-probe/` | 2.0 MB | **Metro 成功产物**（证据），建议保留 | 建议保留 |
| `_cmake-probe/` | ~0.1 MB | CMake 最小探针的最小骨架 | 否，可删 |
| `BUILD-LOG-*.txt`（8 个） | ~0.3 MB | 本轮全部构建/探测原始日志 | **建议保留**（审计证据） |
| `_build-debug.ps1` | 小 | 构建复现脚本 | 建议保留 |

> 我**没有**删除这些目录，因为其中 `_bundle-probe/` 和 `BUILD-LOG-*` 是本轮结论的关键证据；且删除大目录属破坏性操作，按规则不擅自执行。**建议由 Lead/用户决定**：确认结论后删除 `_gradle-home/`、`_android-home/`、`_localappdata/`、`_cmake-probe/`，并考虑把 `_gradle-home/`、`_android-home/`、`_localappdata/` 加入 `.gitignore`。
>
> 另注：`git status` 中根目录还可见 `_abi_probe.*`、`_cmake-probe.bat`、`_cmake-probe2*`、`_ninja-probe/`、`_spawn-probe.cjs` 等——**这些不是我的产出**，推测来自 Lead 或其他 agent 的并行探测，我未触碰。

---

## 11. 结论（可放进发布报告的一句话）

> **Debug APK 构建被环境限制阻断（非项目问题）：沙箱禁止父进程通过管道捕获子进程 stdout（`spawnSync(...,{stdio:'pipe'}) -> EPERM`），而 `ninja` 无条件依赖该能力，导致 `:app:configureCMakeDebug[arm64-v8a]` 在 "Detecting C compiler ABI info" 阶段挂起并以 EPERM 退出（`[CXX1429]`）。工具链本身健康（clang 18.0.2 / llvm-ar 直连调用全部成功），依赖解析正常（配置阶段 `BUILD SUCCESSFUL`），项目代码正常（Metro 成功产出 2,102,992 B 的 `index.android.bundle`，SHA256 `E0187884...F6017`，本轮所有改动模块均在包内）。现有 `app-debug.apk`（2026/10/23 19:12:31）为**陈旧产物**，不得作为本轮交付。**
