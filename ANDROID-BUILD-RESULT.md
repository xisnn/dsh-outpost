# ANDROID BUILD RESULT — DSH Outpost

- 执行日期：2026-10-25（Asia/Tokyo）
- 执行人：AI 构建/质量代理（受人工指挥）
- **本轮未提交、未推送、未打 tag、未创建 Release**

---

## 1. Git 状态

| 项 | 值 |
|---|---|
| 分支 | `main` |
| HEAD | `5d34541fc1a6a2871ed858c830e1470b9c0e1320` |
| HEAD 说明 | `feat: 设备管理页 —— 看全貌、撤销任意设备 (v0.16.2)` |
| HEAD 日期 | 2026-10-24 19:45:37 +0900 |
| 已暂存 | 0 个文件（未 `git add`） |
| stash | 0 条 |
| 工作区 | 保留全部未提交修改：**19 个 modified + 33 个 untracked + 0 个 deleted** |
| 是否执行过 reset/clean/checkout | **否**（全部改动完好保留） |

> 开始前重新核实过 HEAD 仍是 `5d34541`（未假设）。
> 三轮安全修复全部确认仍在源码中（13 项标记逐项验证 `PRESENT`）。

---

## 2. 构建环境（本轮实测，非沿用上轮）

| 项 | 值 |
|---|---|
| OS | Windows 11 10.0.26100 amd64 |
| Node | v24.13.0 |
| npm | 11.6.2 |
| JDK | Temurin **21.0.8** @ `D:\Jdk21`（`JAVA_HOME`） |
| Gradle | **8.14.3**（wrapper 指定，`gradlew.bat --version` exit 0） |
| AGP | 8.11.0（`react-native/gradle/libs.versions.toml`） |
| Kotlin | 2.1.20 |
| React Native | 0.81.4 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 24 |
| Build Tools | 36.0.0 |
| NDK | 27.1.12297006 |
| CMake | 3.22.1 |
| Android SDK | `E:\Android\Sdk` |
| 模拟器 | `dsh_test` AVD（Android **15 / API 35 / x86_64**），WHPX 加速可用 |

**未升级任何 AGP / Gradle / NDK / Kotlin / RN 版本。未修改 `applicationId`，未更换签名身份。**

---

## 3. ⚠️ 上一轮「环境限制」结论被本轮推翻（重要）

上一轮 `APK-BUILD-REPORT.md` 判定：构建被「沙箱禁止父进程管道捕获子进程 stdout」阻断，
属**不可修复的环境限制**。**本轮证明该结论只对当时的受限沙箱成立，不是项目或工具链问题。**

本轮运行时的文件策略变更为 `danger-full-access`（非受限），于是同一台机器上：

| 探测 | 受限沙箱（上轮） | 本轮（非受限） |
|---|---|---|
| `spawnSync('cmd',{stdio:'pipe'})` | `EPERM` | **正常** |
| `ninja` 构建（spawn 子进程） | `exit -1`，无输出 | **`exit 0`，产物生成** |
| `npm test`（走 tsx/esbuild） | `TransformError: spawn EPERM` | **EXIT 0，768 项通过** |
| 写 `C:\Users\xis\.gradle` | `AccessDenied` | **OK** |
| `gradlew.bat --version` | `.zip.lck` 拒绝访问 | **exit 0** |
| `:app:assembleDebug` | `configureCMakeDebug` 失败 | **BUILD SUCCESSFUL** |

**结论修正**：上一轮的 A/B 判定中「环境无法完成构建」这条，在本轮环境下**不成立**。
真实原因始终是运行沙箱的子进程/管道限制，不是 NDK、依赖或项目代码。本轮未对项目做任何
为绕过该限制的修改 —— 限制消失后原样构建即成功。

---

## 4. 自动化测试（构建前完成）

命令与结果（**均为项目原始命令**，非替代引导）：

| 命令 | 退出码 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| `npm test` | **0** | **768**（40 个 spec + `cwd-spec` 6 项，共 774 断言） | **0** | 0 |
| `npm run test:integration` | **0** | **61**（5 个文件：15+14+10+16+6） | **0** | 0 |
| `npx tsc --noEmit` | **0** | — | 0 | — |
| `npx eslint src --ext .ts,.tsx` | 1（见下） | — | 15 个**既有**错误 | — |

### 4.1 lint 账目（区分既有与本轮新增）

- 初次运行：**18 errors / 132 warnings**
- 其中 **3 个是本轮引入的死代码**（已定位并修复）：
  | 文件 | 符号 | 原因 |
  |---|---|---|
  | `src/App.tsx` | `clearLegacyCredentialStorage` 未使用 | P1-3 改用 `…Verified()` 后遗留的导入 |
  | `src/App.tsx` | `LEGACY_KEY_COUNT` 未使用 | 旧计数判据被 `verified` 取代 |
  | `src/core/deviceAuth.ts` | `postRevoke` 未使用 | P1-1 改造后全部调用走 `postRevokeDetailed()` |
- 修复后：**15 errors**，全部位于**本轮未修改的文件**（已逐个用 `git status` 证明 unmodified vs HEAD）：
  `AssistantRichText(1) DocumentViewer(2) Message(1) ModelSwitcher(2) ChatScreen(4) SessionsScreen(2) TaskBoardScreen(2) WorkspacesScreen(1)`
- **本轮改动过的 9 个源文件：0 errors**（34 warnings，均为既有风格告警 `no-void` 等）

> 既有 lint 问题**未清理**：属上一轮之前遗留，清理它们会扩大本轮范围（第十二节禁止无关改动）。
> 不影响构建（`assembleDebug`/`assembleRelease` 均不跑 lint）。

---

## 5. 构建命令与结果

### 5.1 Debug 构建（开发用，JS 从 Metro 加载）

```powershell
$env:JAVA_HOME='D:\Jdk21'; $env:ANDROID_HOME='E:\Android\Sdk'; $env:ANDROID_SDK_ROOT='E:\Android\Sdk'
cd E:\work\dsBot\dsh-mobile\android
.\gradlew.bat --no-daemon --console=plain :app:assembleDebug `
  -PDSH_VERSION_CODE=16200 -PDSH_VERSION_NAME=0.16.2
```

**结果：`BUILD SUCCESSFUL in 11m 58s`，exit 0**
日志：`BUILD-LOG-round4b.txt`

### 5.2 Release 构建（**自包含可分发测试包**，未配置签名密钥 → CI 同款回退到 debug 签名）

```powershell
.\gradlew.bat --no-daemon --console=plain :app:assembleRelease `
  -PDSH_VERSION_CODE=16200 -PDSH_VERSION_NAME=0.16.2
```

**结果：`BUILD SUCCESSFUL`，exit 0**
日志：`BUILD-LOG-round4-release-testsigned.txt`，最终重建：`BUILD-LOG-round4-final-release.txt`

> 该构建路径与仓库 CI（`.github/workflows/android.yml`）在**未配置 secrets**时的行为完全一致：
> `release { signingConfig = hasProperty('DSH_STORE_FILE') ? release : debug }`。
> 本机无 `DSH_STORE_FILE`，因此回退 debug 签名 —— **这是有意的测试包，不可上架**。

### 5.3 构建警告（需知悉，不阻塞）

- `C/C++: Hard link ... failed. Doing a slower copy instead.`（跨盘 C:→E: 硬链接失败，自动降级为复制，无害）
- `Deprecated Gradle features were used ... incompatible with Gradle 9.0`（既有，非本轮引入）
- 无编译错误、无 lint gate、无签名警告。

---

## 6. APK 产物

### 6.1 ⭐ 本轮主交付：自包含测试包

| 项 | 值 |
|---|---|
| 路径 | `dsh-mobile/android/app/build/outputs/apk/release/app-release.apk` |
| 归档副本 | `_test-artifacts/TEST-app-release-vc16200-v0.16.2-debugsigned.apk` |
| 大小 | **77,145,609 字节（73.57 MiB）** |
| 构建时间 | 2026-10-25 23:10:42 |
| SHA256 | **`64CD35FEFF73362D57FA27A1FE2C6D8B6E052F9B09C5F25F955C17723AF1CB1C`** |
| SHA1 | `E60083CB3C732BA222DBF304066BF776074F908F`（debug 变体） |
| 构建模式 | **Release 变体 + debug 签名（侧载测试用，不可上架）** |
| JS bundle | **已内嵌** `assets/index.android.bundle`（2,183,260 字节） |
| 原生库 | arm64-v8a / armeabi-v7a / x86 / x86_64 各 15 个 `.so` |

### 6.2 Debug 构建（开发用，需 Metro）

| 项 | 值 |
|---|---|
| 路径 | `.../apk/debug/app-debug.apk` |
| 归档副本 | `_test-artifacts/NEW-app-debug-vc16200-v0.16.2.apk` |
| 大小 | 133,221,664 字节 |
| SHA256 | `F5687363A8757923726B9F0F92E1D11F9D1FE8E9FD07E93D20486B1D0A70C8F2` |
| JS bundle | **无**（debug 从 Metro 加载，属正常） |

### 6.3 包名 / 版本 / 签名（`aapt2 dump badging` + `apksigner verify` 实测）

| 项 | 旧版 APK（基线） | **本轮测试 APK** | 结论 |
|---|---|---|---|
| applicationId | `com.dshpocket` | **`com.dshpocket`** | ✅ 未变 |
| versionCode | `1` | **`16200`** | ✅ 单调递增 |
| versionName | `1.0` | **`0.16.2`** | ✅ 与 package.json 一致 |
| 签名证书 SHA-256 | `fac61745dc09…033b9c` | **`fac61745dc09…033b9c`** | ✅ **同一证书** |
| 签名证书 DN | `CN=Android Debug, OU=Android, …` | 同左 | ✅ 一致 |
| minSdk / targetSdk | 24 / 36 | 24 / 36 | ✅ 未变 |
| application-label | DSH Outpost | DSH Outpost | ✅ 未变 |

> 版本号由 `-PDSH_VERSION_CODE/-PDSH_VERSION_NAME` 显式传入。
> `package.json` version = `0.16.2`，与 `versionName` 一致（应用内更新检查依赖此一致性）。
> 未传参时 Gradle 默认会落到 `versionCode=1 / versionName=1.0`（即旧包的取值）——
> 正式构建必须像 CI 那样由 tag 推导，否则无法覆盖安装。

### 6.4 产物是否包含本轮代码（逐项验证）

内嵌 bundle 中检索**本轮新增的运行时字面量**：

| 标记 | 所属修复 | 结果 |
|---|---|---|
| `dsh.revocationMarker` | P0-1 双通道降级 | ✅ 存在 |
| `persisted: 'async-storage'` / `'secure-store'` | P0-1 落盘通道 | ✅ 存在 |
| `memoryOnly` | P0-1 三维结果 | ✅ 存在 |
| `dsh.gatewayServerBinding` | P1-1 服务端身份绑定 | ✅ 存在 |
| `gatewayId` | P1-1 实例身份 | ✅ 存在 |
| `foreign` / `unverifiable` | P1-1 绑定判定 | ✅ 存在 |
| `read-failed` / `clear-failed` / `verify-failed` | P1-3 迁移诚实报告 | ✅ 存在 |
| `partial` / `unverified` | P1-4 Cookie 四态 | ✅ 存在 |
| `server-revoked` / `self-revoked` | 上轮撤销状态 | ✅ 存在 |
| `dsh-auth` | 上轮子协议修复 | ✅ 存在 |

> 注：`RevocationPersistResult`、`ServerRevokeResult` 等**类型名**在 bundle 中不出现是正常的
> （TypeScript 类型在编译期被擦除，不产生运行时值）。上面用的是运行时字面量，才是有效证据。

### 6.5 与旧 APK 的区分（防混淆）

旧产物已在构建前**备份并改名**，避免被新构建覆盖后无法做升级对比：

| 文件 | 说明 | SHA256 |
|---|---|---|
| `_test-artifacts/OLD-app-release-vc1-v0.16.x-2026-10-22.apk` | **旧版**（vc=1, vn=1.0，2026-10-22），仅作升级基线 | `63FA2B2F…E7EA32` |
| `_test-artifacts/NEW-app-debug-vc16200-v0.16.2.apk` | 本轮 debug | `F5687363…70C8F2` |
| `_test-artifacts/TEST-app-release-vc16200-v0.16.2-debugsigned.apk` | **本轮主交付** | `64CD35FE…F1CB1C` |

> **未把旧 APK 改名冒充本轮产物。** 三者版本号、构建时间、SHA256 均可区分。

---

## 7. 构建日志

| 文件 | 内容 |
|---|---|
| `BUILD-LOG-round4b.txt` | `assembleDebug` 完整日志（BUILD SUCCESSFUL 11m58s） |
| `BUILD-LOG-round4-release-testsigned.txt` | 首次 `assembleRelease` |
| `BUILD-LOG-round4-final-release.txt` | 清理死代码后最终重建（release+debug） |
| `BUILD-LOG-round4-assembleDebug.txt` | 较早一次失败尝试（UTF-16，含 `NoClassDefFound`/会话错误，已被 4b 取代） |
| `TEST-LOG-round4-npm-test.txt` | `npm test` 全量输出 |
| `TEST-LOG-round4-npm-test-final.txt` | 清理后最终 `npm test` |
| `TEST-LOG-round4-integration*.txt` | `npm run test:integration` |

---

## 8. 失败与最小解决方案

**本轮构建：无最终失败。** 过程中有两个已解决的问题：

| 现象 | 真实原因 | 解决 |
|---|---|---|
| 首次 `assembleDebug` 失败（`BUILD FAILED in 3m 17s`，daemon 会话异常） | 上一次受限沙箱遗留的 Gradle daemon 状态 + 日志被 UTF-16 截断，无法定位 | 改用非受限运行时、`cmd /c` 重定向为 UTF-8 日志后重建成功 |
| `npm test` 早期 `spawn EPERM` | 受限沙箱的子进程管道限制 | 非受限运行时下原命令直接通过 |

**给「普通 Windows 终端」的最小可复现步骤**（无需任何沙箱特殊处理）：

```powershell
# 前置：JDK 21、Android SDK 36、NDK 27.1.12297006、CMake 3.22.1 已安装
$env:JAVA_HOME='D:\Jdk21'
$env:ANDROID_HOME='E:\Android\Sdk'
$env:ANDROID_SDK_ROOT='E:\Android\Sdk'

cd dsh-mobile
npm ci
npm test                       # 期望 exit 0
npm run test:integration       # 期望 exit 0

cd android
# 测试包（debug 签名，可侧载）
.\gradlew.bat --no-daemon --console=plain :app:assembleRelease `
  -PDSH_VERSION_CODE=16200 -PDSH_VERSION_NAME=0.16.2

# 产物
# app\build\outputs\apk\release\app-release.apk
```

**若要在真机/模拟器上看到界面**，debug 包需要 Metro：

```powershell
cd dsh-mobile
npx react-native start --port 8081
# 另开终端：
adb reverse tcp:8081 tcp:8081
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```
或直接安装 **release 变体测试包**（JS 已内嵌，无需 Metro）。

---

## 9. 结论

**APK 构建成功。** 两条构建路径（debug / release-test-signed）均 `BUILD SUCCESSFUL`，
产物真实存在、可安装、可在 Android 15 上运行，且包含本轮全部修复。

唯一限制：**本轮交付的是 debug 签名测试包，不是可上架的正式签名包**。
正式签名需要仓库 secrets 中的 keystore（`KEYSTORE_BASE64` 等），本机不可得 ——
详见 `RELEASE-READINESS-REPORT.md` 的阻塞项。
