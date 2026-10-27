# DSH Outpost CI 正式签名验证 —— 验收报告

> 运行时间：2026-10-27
> 结论：**`SIGNING_VERIFIED_PASS`** —— 正式签名构建与全部关键门禁已通过
> 未创建 Tag、未创建 Release、未发布任何 APK。

---

## 0. 一句话结论

GitHub Actions 用**真实的私有 keystore**（PKCS12 / RSA 4096 / alias `dsh-release`）
成功构建并验证了正式签名 APK，证书指纹与 `EXPECTED_CERT_SHA256` 完全一致，
且**不是**公开的 AOSP Debug 证书。Windows 程序也已真实构建。

**APK 未上传**（按你选择的安全方案），交付的是可复核的密码学证据。

---

## 1. GitHub Actions 运行结果

| 项 | 值 |
|---|---|
| 运行链接 | https://github.com/xisnn/dsh-outpost/actions/runs/40467239206 |
| 提交 | `66d860a` |
| 结论 | ✅ **success** |
| 触发方式 | `workflow_dispatch`（`gh workflow run`） |

### 1.1 全部 31 个步骤

| 结果 | 步骤 |
|---|---|
| ✅ | Set up job / checkout / setup-node / setup-java |
| ✅ | Check signing secrets are present |
| ✅ | Ensure NDK and SDK packages |
| ✅ | Cache Gradle / Install dependencies |
| ✅ | **Verify PowerShell availability** |
| ✅ | **Unit tests** |
| ✅ | **Integration tests** |
| ✅ | Materialize keystore |
| ✅ | Derive synthetic version for verification |
| ✅ | **Build release APK with REAL signing** |
| ✅ | **Verify APK signature and certificate identity** |
| ✅ | **Verify package identity and signing schemes** |
| ✅ | **Verify update-integrity chain** |
| ✅ | **Verify debug build still works** |
| ✅ | **Negative test — release must fail without signing material** |
| ✅ | Upload verification evidence |
| ✅ | Resolve repository visibility |
| ⏭️ | Stage non-release APK for device acceptance（**按设计跳过**：公开仓库） |
| ⏭️ | Upload non-release APK（同上） |
| ✅ | Summary / Enforce gate result / Clean up keystore |
| ✅ | Post steps / Complete job |

**Zero failure. 两个 skip 是安全策略的正确执行，不是遗漏。**

---

## 2. 证书验证结果（核心证据）

```
APK 证书 DN      : CN=jingchanglong, OU=dshoutpost, O=xis,
                   L=chengdu, ST=chengdu, C=cn
APK 证书 SHA-256 : 191b16cebd6f39f64f8cbbe3fcbdd90e2d845a9d7b1fbe19ccdcd819293a736a
```

| 检查 | 结果 |
|---|---|
| 证书指纹 == `EXPECTED_CERT_SHA256` | ✅ 完全一致 |
| 是否为公开 AOSP Debug 证书 | ✅ **否**（`fac61745…` 黑名单未命中） |
| 证书 DN | ✅ 私有主题，非 `CN=Android Debug` |

对照历史：此前所有已发布 APK 都是 `fac61745…`（公开 debug 证书，私钥在仓库里）。
本次首次使用真正的私有证书。

---

## 3. APK 签名与包信息

```
包名         : com.dshpocket
versionCode  : 916204      （合成值 = 水位线 16200 + 900000 + run）
versionName  : 0.0.0-verify.4
```

| 检查 | 结果 |
|---|---|
| v2 签名方案（Android 7+ 必需） | ✅ `true` |
| v3 签名方案 | ⚠️ `false`（可选，不影响安装） |
| v1 (JAR) | `false`（正常，v2+ 不需要） |
| 签名者数量 | 1 |
| `apksigner verify` 密码学验证 | ✅ 通过 |

---

## 4. APK 哈希（本地构建对照凭据）

由于仓库是 public 且你选择了「不上传 APK」方案，CI 不产出 APK 文件。
以下是 CI 构建出的 APK 的 SHA-256，你**本地用同一 keystore 构建后可对照**：

```
268e39eba640d0d978c8b17824e1242b709f11fe81dacd85ac1dc7a9e1372451  dsh-outpost-verify.apk
```

本地构建命令（需你持有 keystore）：
```powershell
cd E:\work\dsBot\dsh-mobile\android
.\gradlew.bat :app:assembleRelease `
  -PDSH_VERSION_NAME=0.0.0-verify.4 `
  -PDSH_VERSION_CODE=916204 `
  -PDSH_STORE_FILE="<你的keystore路径>" `
  -PDSH_STORE_PASSWORD="<密码>" `
  -PDSH_KEY_ALIAS=dsh-release `
  -PDSH_KEY_PASSWORD="<密码>"
```
> 注：Gradle 构建不完全可复现（时间戳等），哈希可能不同。
> **比对证书指纹比比对哈希更可靠**：
> `apksigner verify --print-certs` 应得到 `191b16ce…736a`。

---

## 5. 更新完整性链路验证

CI 用**产品代码自己的解析器**验证了 SHA256SUMS：

```
OK  parseSumsFile 解析到哈希：268e39eba640d0d9…
OK  resolveExpectedHash 选中 sums 来源
OK  hashMatches：相等时通过
OK  hashMatches：不等时拒绝
OK 文件名不匹配时返回 undefined（不会误用其它文件的哈希）
结果：更新完整性链路验证通过
```

---

## 6. 负向门禁验证

CI 真实执行了「缺签名材料的 release 构建必须被拒绝」：
✅ **pass** —— 证明签名门禁不是摆设。

同时 `assembleDebug` ✅ 通过，证明门禁没有误伤日常构建
（这正是第二轮修过的配置期回归）。

---

## 7. Windows 构建结果

本机执行 `npx electron-builder --win zip --x64`，**exit 0**。

| 产物 | 路径 | 大小 |
|---|---|---|
| 便携 zip | `dsh-outpost-desktop\release\DSH-Outpost-Desktop-0.16.4-win-x64.zip` | 139.7 MB |
| 未打包目录 | `dsh-outpost-desktop\release\win-unpacked\DSH Outpost.exe` | 228.0 MB |

**布局验证**（本轮修复的关键点，已在 zip 内确认）：
```
resources/scripts/gateway-patch-gate.ps1
resources/patches/mobile-gateway-mgmt-auth/apply.mjs
resources/patches/mobile-gateway-mgmt-auth/patch.mjs
resources/patches/mobile-gateway-mgmt-auth/README.md
```

### ⚠️ portable(.exe) 目标未成功 —— 环境限制，非代码问题

```
⨯ mkdir C:\Users\xis\AppData\Local\electron-builder\Cache\nsis\<随机>: Access is denied
```

NSIS 打包需要 `app-builder.exe` 在缓存目录创建随机名子目录，本会话沙箱禁止
子进程做该文件操作。我验证过：**父进程可以创建同名目录，子进程不行** ——
是沙箱对子进程的限制，不是配置或代码缺陷。

zip 目标不经过 NSIS，构建成功，产物功能完整（解压即用）。
**你可以在自己的终端（非沙箱）执行 `npm run dist` 产出 portable .exe。**

---

## 8. 本轮修复的 3 个 CI 阻断

| # | 提交 | 问题 | 根因 |
|---|---|---|---|
| 1 | `2ed8a33` | `test:startupGate` 3 断言失败 | 门禁内联在「定位 dsh」之后，Linux 上先 exit 1 导致门禁执行不到；且硬编码 `powershell.exe` |
| 2 | `b54b7e8` | **打包版无法启动** | `scripts/` 与 `patches/` 未加入 `extraResources` |
| 3 | `66d860a` | `test:signingGates` 5 断言失败 | `gradlew` 在 git 里是 100644，Ubuntu 上无执行权限 |

三者都是**真实缺陷**，无一是靠跳过测试或放宽门禁解决的。

### 附带改进
- 新增跨平台 PowerShell 运行器（`tests/support/powershell.mjs`），三态区分
  missing / parse / error
- 修正「catch 后无条件 PASS」的假阳性断言
- 打包测试改为**自动提取** `Join-Path $PSScriptRoot` 依赖并校验已打包
- gradle 调用失败时输出尾部日志（此前 CI 上只看到 `exit=1`，无法诊断）

---

## 9. 安全检查

| 项 | 结果 |
|---|---|
| 读取/复制/上传本地 keystore | ❌ 未做 |
| 输出或修改 GitHub Secrets | ❌ 未做 |
| 创建 Release Tag | ❌ 未做（tag 数仍 30） |
| 发布正式版本 | ❌ 未做（最新 release 仍 v0.16.6） |
| 绕过签名/安全/测试门禁 | ❌ 未做 |
| 跳过失败测试 | ❌ 未做 |
| 提交中的敏感材料 | ✅ 扫描无（私钥/令牌/base64/密码字面量） |
| CI 日志中的 Secrets | ✅ 全部 `***`（`EXPECTED_CERT_SHA256` 可见属正常：它是 Variable + 公钥指纹） |

**仓库可见性 `public` → 真实签名 APK 按设计不上传。** 这是第七轮确认的安全策略。

---

## 10. 最终状态

```
分支        main（与 origin/main 同步，ahead=0）
最新提交    66d860a  fix(ci): chmod +x gradlew in signing-gates test
工作区      clean
单元测试    1040 通过 / 0 失败
集成测试    61 通过 / 0 失败
CI          全部关键门禁 PASS
Tag/Release 无新增
```

---

## 11. 还需你做的事

### 11.1 真机验收（必须）
1. 本地用同一 keystore 构建 release APK（命令见 §4）
2. `apksigner verify --print-certs` 确认指纹 = `191b16ce…736a`
3. 装到 Android 真机，按 `DSH-OUTPOST-FINAL-RELEASE-ACCEPTANCE.md` §9 走 12 项验收

### 11.2 发布前（如要正式发布）
- 抬 `.github/release-floor.json` 的 `minVersionCode`
- 写发布说明（老用户需卸载重装 —— 签名已从 debug 换为私有证书）
- 打 **正式** tag 触发 `android.yml`（该流程会创建 Release）

### 11.3 可选
- 若想让 CI 直接产出 APK：把仓库改为 private，现有的
  `Resolve repository visibility` 门禁会自动允许上传

---

## 12. 未关闭事项（如实列出）

| 级别 | 项 |
|---|---|
| 🟡 | v3 签名方案为 false（可选，不影响 Android 7+） |
| 🟡 | portable .exe 因沙箱限制未构建（zip 可用） |
| 🟡 | P0-1 仍无自动重连/会话恢复（断线只做快速失败） |
| 🟡 | 真机验收 12 项未执行（需你操作） |
| 🟡 | 存量 debug 签名用户需卸载重装 |
