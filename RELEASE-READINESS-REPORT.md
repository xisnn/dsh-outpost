# RELEASE READINESS REPORT — DSH Outpost v0.16.2

- 报告日期：2026-10-25
- 基线：`main` @ `5d34541`（v0.16.2）+ 三轮安全修复（**仍未提交**）
- 本轮目标：构建验证 → APK 安装 → 真机/模拟器验收 → 发布条件评估

---

## 1. 一句话结论

**状态 C：APK 已成功构建，但真机验收尚未完成。**

代码层（自动化测试 + 类型检查 + 真实构建）已全部通过；
APK 已在 Android 15 上**成功安装、同签名覆盖升级、真实服务端交互**；
但**没有真机**，且核心安全项（撤销当前设备后不自动复活等）尚未在真实设备上验证，
因此**不满足 D/E**。

---

## 2. 自动化测试情况 ✅

| 命令 | 退出码 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| `npm test` | **0** | **774**（40 spec 文件 + cwd 6 项） | **0** | 0 |
| `npm run test:integration` | **0** | **61**（5 文件） | **0** | 0 |
| `npx tsc --noEmit` | **0** | — | 0 | — |
| `npx eslint src` | 1 | — | **15（全部既有）** | — |

**关键点**：
- 本轮使用的是**项目原始命令**（`npm test` 走 tsx），不再是替代 Node 引导。
  上一轮记录的 `spawn EPERM` 已确认是**受限沙箱**造成，非项目问题 —— 本轮原命令直接通过。
- lint 的 18 个 error 中，**3 个是本轮引入的死代码**（已修复）；
  剩余 **15 个位于本轮未修改的文件**（已用 `git status` 逐个证明 unmodified vs HEAD）。
  本轮改动过的 9 个源文件 lint **0 error**。
- 未删除、未弱化任何断言。

---

## 3. APK 构建情况 ✅

| 项 | 结果 |
|---|---|
| `:app:assembleDebug` | **BUILD SUCCESSFUL**（11m58s，exit 0） |
| `:app:assembleRelease`（debug 签名回退） | **BUILD SUCCESSFUL**（exit 0） |
| 交付产物 | `_test-artifacts/TEST-app-release-vc16200-v0.16.2-debugsigned.apk` |
| 大小 / SHA256 | 77,145,609 B / `64CD35FEFF73362D57FA27A1FE2C6D8B6E052F9B09C5F25F955C17723AF1CB1C` |
| JS bundle | 已内嵌（2,183,260 B） |
| 构建环境 | JDK 21 / Gradle 8.14.3 / AGP 8.11.0 / NDK 27.1.12297006 / CMake 3.22.1 |

> **重要更正**：上一轮 `APK-BUILD-REPORT.md` 把构建失败归因为「不可修复的环境限制」。
> 本轮证明该判断**仅在受限沙箱内成立**。在正常权限下，**未修改任何构建配置**即构建成功。
> 这排除了「项目代码/依赖/SDK-NDK 配置有问题」的怀疑。

---

## 4. 真机测试情况 ⚠️

- **无真机**（`adb devices` 空）。
- 使用**模拟器** `dsh_test`（Android 15 / API 35 / x86_64）完成可自动化部分。
- 详见 `ANDROID-TEST-RESULT.md`。

| 组 | PASS | FAIL | NOT RUN |
|---|---|---|---|
| 1. 旧版升级 | **6** | 0 | 3 |
| 2. 登录与退出 | 1 | 0 | 5 |
| 3. 设备授权撤销 | **3** | 0 | 4 |
| 4. 异常情况 | 0 | 0 | 6 |
| 5. 服务器身份绑定 | 1 | 0 | 5 |
| 6. 基本业务功能 | **6** | 0 | 4 |
| **合计** | **17** | **0** | **27** |

**已执行项 100% 通过（0 FAIL）；覆盖率 38.6%。**

### 已获证的硬结论

1. **同签名覆盖升级可行**：旧包（vc=1,vn=1.0）→ 新包（vc=16200,vn=0.16.2），
   `adb install -r` 成功，`firstInstallTime` **未变**（2026-10-21），用户数据保留。
2. **升级后可用**：免重新扫码直接进入，列出真实 **582 工作区 / 715 会话**。
3. **真实服务端撤销生效**：设备管理页撤销一台设备 →
   `GET /mgw/devices` 由 **24 → 23** 条，目标 UUID 确已消失。
4. **撤销他人不误伤自己**：撤销后本机「连接状态=正常」「审批通道=已连通」。
5. **零崩溃**：全程 logcat 无 `FATAL EXCEPTION`。
6. **P1-1 协议前提成立**：真实插件 `GET /mgw/status` 返回稳定 `gatewayId`
   （`99921c7e-…`），与每次重启都变的 `gatewayInstanceId` 是两个独立字段。

---

## 5. 版本兼容情况 ✅

| 项 | 旧包 | 新包 | 判定 |
|---|---|---|---|
| applicationId | `com.dshpocket` | `com.dshpocket` | ✅ 未变 |
| versionCode | 1 | **16200** | ✅ 单调递增，可覆盖 |
| versionName | 1.0 | **0.16.2** | ✅ 与 `package.json` 一致 |
| 签名证书 SHA-256 | `fac61745…033b9c` | `fac61745…033b9c` | ✅ **完全一致** |
| minSdk / targetSdk | 24 / 36 | 24 / 36 | ✅ 未变 |
| application-label | DSH Outpost | DSH Outpost | ✅ 未变 |

`versionCode` 推导规则（CI）：`major*1000000 + minor*1000 + patch` → `0.16.2` = **16200**。
**正式构建必须由 tag 推导传入**，否则 Gradle 会回落到默认 `1`（= 旧包取值，无法覆盖安装）。

---

## 6. 安全验收结果

### 6.1 三轮修复仍在且被测

| 轮次 | 修复 | 源码在位 | 自动化测试 |
|---|---|---|---|
| 三轮（本轮前） | P0-1 撤销标记持久化失败降级 | ✅ | `revocation-persistence` 38 项 |
| | P0-2 彻底清除的虚假成功路径 | ✅ | `device-revoke` 9 项 |
| | P1-1 服务端 UUID ↔ 服务器身份绑定 | ✅ | `server-identity-binding` 32 项 |
| | P1-2 `lastCookie` 迁移异步竞争 | ✅ | `migration-race` 20 项 |
| | P1-3 明文迁移错误报告 | ✅ | `credential-migration(-crash)` 35+17 项 |
| | P1-4 Cookie 清理结果可信性 | ✅ | `cookie-cleanup` 29 项 |
| 更早 | `dsh-auth.` 子协议 / 4003 按原因分类 / 设备列表三态 / 撤销后不自动配对 | ✅ | 对应 spec 全绿 |

**13 项源码标记逐项验证 `PRESENT`，无遗漏。**

### 6.2 已被真实环境证实的安全行为

- ✅ 撤销**其他**设备真的会删服务端记录，且不影响本机授权
- ✅ 认证状态跨版本升级可用（Keystore 凭据延续）
- ✅ 无任何认证数据出现在日志/报告中

### 6.3 尚未被真实环境证实的安全行为（关键）

| # | 行为 | 现状 |
|---|---|---|
| S1 | 撤销**当前**设备后不自动重新授权、重启后仍为已撤销 | 逻辑层 38+19 项测试通过；**真机未验证** |
| S2 | WS 不可用时不误删有效 token | 逻辑层 13 项通过；**真机未验证** |
| S3 | 彻底清除授权后不自动恢复登录 | 逻辑层 22+20 项通过；**真机未验证** |
| S4 | 旧版明文凭据确实被清除 | 需 debuggable 包/`adb backup`；**未验证** |
| S5 | 跨服务器不复用设备 UUID / 404 不误判成功 | 逻辑层 32 项通过；**需第二套服务器** |

---

## 7. 发布阻塞项

### 7.1 必须解决（代码已完成，仅缺验证）

| # | 阻塞项 | 类型 | 解除条件 |
|---|---|---|---|
| B1 | S1 撤销当前设备的安全行为未经真机证实 | **验证缺口** | 真机执行 `ANDROID-TEST-RESULT.md` §10.2，服务端记录不复活 |
| B2 | S2 WS 不可用不误删 token 未经真机证实 | 验证缺口 | 执行 §10.3 |
| B3 | S3 彻底清除授权不自动恢复未经真机证实 | 验证缺口 | 执行 §10.4（需可重置设备） |
| B4 | S4 明文凭据清理未验证 | 验证缺口 | 执行 §10.5（debuggable 包 + adb） |
| B5 | S5 跨服务器身份绑定未验证 | 验证缺口 | 执行 §10.6（需第二套 DSH） |

### 7.2 发布工程阻塞项

| # | 阻塞项 | 说明 |
|---|---|---|
| **R1** | **本轮 APK 是 debug 签名，不可上架/不可作为正式发布包** | 正式签名需仓库 secrets 中的 keystore（`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`）。**本机不可得，且禁止自行生成新签名冒充旧签名。** |
| **R2** | **三轮修复仍未提交** | 远程 CI 拿不到本地未提交修改。要出正式包必须先提交（见 §9 步骤）。 |
| R3 | 版本号必须由 tag 推导 | 直接 `assembleRelease` 不带 `-P` 参数会得到 `versionCode=1`，无法覆盖旧包 |

### 7.3 非阻塞（工程整洁度）

| # | 项 | 影响 |
|---|---|---|
| N1 | 15 个既有 eslint error（本轮未触及的文件） | 不影响构建；建议后续单独清理 |
| N2 | 132 个 eslint warning（`no-void` 等风格） | 同上 |
| N3 | `Deprecated Gradle features ... Gradle 9.0` | 既有；升级前需评估 |
| N4 | 跨盘 C:→E: 硬链接失败降级为复制 | 仅变慢，无功能影响 |
| N5 | `_gradle-home/` 等沙箱缓存约 4.66 GB（已 gitignore，未删除） | 可随时删除 |

---

## 8. 与上一轮结论的差异（必须记录）

| 项 | 上一轮结论 | 本轮实测 | 差异原因 |
|---|---|---|---|
| `assembleDebug` | 失败（`configureCMakeDebug`） | **成功** | 上一轮处于受限沙箱；本轮为非受限运行时 |
| `spawn EPERM` | 判定为不可绕过的环境限制 | **不存在** | 同上 |
| `npm test` | 只能用替代 Node 引导 | **原命令通过** | 同上 |
| Gradle wrapper `.lck` 拒绝访问 | 需改用重定向 `GRADLE_USER_HOME` | **不需要**，直接可用 | 同上 |
| 真机测试 | 全部 NOT RUN | 模拟器完成 17 项 | 本轮启用了 AVD + 真实 LAN DSH |

> 这不是「上一轮判断错误」——上一轮的**证据是真实的**，只是适用范围被误判为
> 「不可修复」。本轮修正为：**该限制属于运行沙箱，切换权限后不复现**。

---

## 9. 建议的下一步操作

### 第 1 步：真机验收（最高优先，无需改代码）

```powershell
# 1) 真机连上并授权
adb devices

# 2) 安装本轮测试包（覆盖升级）
adb install -r _test-artifacts\TEST-app-release-vc16200-v0.16.2-debugsigned.apk

# 3) 按 ANDROID-TEST-RESULT.md §10 的 B1~B5 逐项执行
#    重点：B1（撤销当前设备后不复活）、B2（WS 不可用不误删 token）、B3（彻底清除）
```

**产出**：填完 `RELEASE-ACCEPTANCE-CHECKLIST.md`，B1~B5 全 PASS 才可升级到 D。

### 第 2 步：出正式签名包（需仓库 secrets）

> ⚠️ **不要自行生成新 keystore**。必须使用与现有发布包相同的签名材料，
> 否则老用户无法覆盖安装（只能卸载重装，会丢本地数据）。

方案 A（推荐，复用现有 CI）：

```powershell
# 1) 提交本轮修复到测试分支（需人工授权后执行，本轮未做）
git checkout -b release/v0.16.2-test
git add dsh-mobile/src dsh-mobile/tests dsh-mobile/package.json .gitignore
git commit -m "fix: 第三轮安全收尾修复（P0-1/P0-2/P1-1~P1-4）"
git push -u origin release/v0.16.2-test
```

然后在 GitHub Actions 手动触发 `Android APK` workflow（`workflow_dispatch`），
它会自动：跑 `npm test` + `npm run test:integration` + `test:node20` →
用 tag 推导版本 → `assembleRelease` → 上传 artifact。
（工作流已存在且与本轮工具链兼容，**无需修改**。）

方案 B（本地出正式包，需签名材料在手）：

```powershell
cd dsh-mobile\android
.\gradlew.bat --no-daemon --console=plain :app:assembleRelease `
  -PDSH_VERSION_CODE=16200 -PDSH_VERSION_NAME=0.16.2 `
  -PDSH_STORE_FILE=<keystore路径> `
  -PDSH_STORE_PASSWORD=<密码> -PDSH_KEY_ALIAS=<别名> -PDSH_KEY_PASSWORD=<密码>
```

> 密码**不得**写入报告、日志或提交历史。

### 第 3 步：验证正式包签名

```powershell
& "E:\Android\Sdk\build-tools\36.0.0\apksigner.bat" verify --print-certs <正式APK>
# 证书 SHA-256 必须 == 旧发布包的值（fac61745dc09…033b9c，若旧包即 debug 签名）
# 若历史上用过独立 release 签名，必须与那个证书一致
```

### 第 4 步：清理与提交

- 删除 `_gradle-home/ _android-home/ _localappdata/`（约 4.66 GB，已 gitignore）
- 保留 `_test-artifacts/`（测试证据）或按需清理
- 决定是否清理 15 个既有 lint error（建议单独 commit）

---

## 10. 最终状态判定

### **C：APK 已成功构建，但真机验收尚未完成。**

| 状态 | 是否满足 | 理由 |
|---|---|---|
| A. 仍有阻塞性代码错误 | ❌ | 774+61 测试 0 失败、tsc 0 错误、lint 本轮 0 新增、构建成功、模拟器 17 项全 PASS |
| B. 代码通过但环境无法构建 | ❌ | **本轮已成功构建**（上一轮的环境限制不复现） |
| **C. APK 已构建，真机未完成** | ✅ | **选这个**：APK 真实存在、可安装、可升级、可运行；但无真机，27/44 项 NOT RUN，核心安全项 S1~S5 未被真机证实 |
| D. 构建成功 + 必要真机验收通过 | ❌ | 真机零验证；B1~B5 全未执行 |
| E. 发布条件全部满足 | ❌ | 另需：正式签名包（R1）+ 代码提交（R2）+ 真机验收（B1~B5） |

**不得仅凭测试数量升到 D/E。** 本轮测试数字漂亮（835 项断言 0 失败），
但**真机覆盖只有 38.6%，且最能证明安全目标的三项恰好都在未验证之列**。

---

## 11. 交付物清单

| 文件 | 说明 |
|---|---|
| `ANDROID-BUILD-RESULT.md` | 构建结果（环境、命令、产物、SHA256、签名、日志、失败原因） |
| `ANDROID-TEST-RESULT.md` | 测试结果（44 项逐项 PASS/FAIL/NOT RUN + 人工步骤 + ADB 命令） |
| `RELEASE-READINESS-REPORT.md` | 本文件 |
| `_test-artifacts/TEST-app-release-vc16200-v0.16.2-debugsigned.apk` | **本轮主交付**（自包含，可安装） |
| `_test-artifacts/NEW-app-debug-vc16200-v0.16.2.apk` | debug 包（需 Metro） |
| `_test-artifacts/OLD-app-release-vc1-v0.16.x-2026-10-22.apk` | 旧版基线（升级测试用） |
| `_test-artifacts/screenshot-workspaces.png` | 运行截图证据 |
| `BUILD-LOG-round4*.txt` / `TEST-LOG-round4*.txt` | 完整构建/测试日志 |
| `RELEASE-ACCEPTANCE-CHECKLIST.md` | 原有真机验收清单（本轮沿用，未另立标准） |

### 安装说明（测试包）

```powershell
# 覆盖升级（保留用户数据）
adb install -r _test-artifacts\TEST-app-release-vc16200-v0.16.2-debugsigned.apk

# 首次安装
adb install _test-artifacts\TEST-app-release-vc16200-v0.16.2-debugsigned.apk
```

> 该包使用 **debug 签名**，仅用于测试侧载。正式发布必须用正式签名重新构建。

---

## 12. 执行边界遵守情况

| 约束 | 状态 |
|---|---|
| 未大规模重构安全状态机 | ✅ 仅删除 3 处死代码 |
| 未添加新业务功能 | ✅ |
| 未修改 Android 包名 | ✅ `com.dshpocket` 未变 |
| 未擅自更换发布签名 | ✅ 未生成新 keystore |
| 未删除旧用户数据 | ✅ 全程 `install -r`，`firstInstallTime` 未变 |
| 未删除或弱化测试 | ✅ 768→774 断言全绿，无删减 |
| 未随意升级核心依赖 | ✅ AGP/Gradle/NDK/Kotlin/RN 全部未动 |
| 未覆盖未提交修改 | ✅ 19 modified + 33 untracked 完整保留 |
| 未推送远程仓库 | ✅ HEAD 仍为 `5d34541`，未 stage、未 commit |
| 未创建 Release | ✅ |
| 未发布 APK | ✅ 仅在本地模拟器安装测试 |
| 未把未运行测试写成已通过 | ✅ 27 项如实标 NOT RUN |

---

**结论：代码与构建已就绪（状态 C）。距离正式发布还差三步 —— 真机验收、正式签名包、代码提交。**
