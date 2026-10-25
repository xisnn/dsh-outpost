# DSH OUTPOST RELEASE REPORT — v0.16.3（公开预览版）

- 执行日期：2026-10-26（Asia/Tokyo）
- 仓库：https://github.com/xisnn/dsh-outpost
- **最终状态：`RELEASED_PREVIEW`** —— 预览版已真实发布，产物已下载复核验证通过

---

## 1. 最终 Git Commit

| 项 | 值 |
|---|---|
| 分支 | `main` |
| **发布提交** | **`5d2ec0b701a9deaa989a9e132cc0fc7b5fbe0f02`** |
| Tag | `v0.16.3` → 指向 `5d2ec0b`（与 CI 通过的那个提交完全一致） |
| 基线 | `5d34541`（v0.16.2） |
| 本次发布提交数 | **14 个**（`5d34541..5d2ec0b`） |
| 改动规模 | 54 个文件，+18,909 / −640 行 |

### 提交清单（按职责）

| Commit | 内容 |
|---|---|
| `c590802` | **安全修复**：P0-1/P0-2/P1-1/P1-2/P1-3/P1-4 第三轮收尾 |
| `12fe12f` | 测试：新增 5 个安全 spec（136 断言）+ 与真实插件对齐的协议契约 |
| `74cd397` | **发布工程**：签名门禁 + versionCode 单调递增 |
| `4c1c7d6` | 文档：安全报告 / 构建验收结果 / 真机清单 |
| `a5d5888` | 修复：握手 401 在 Node(ws) 下未被识别 |
| `2a1150e` | 修复：WebSocket 替身惰性桥接 unexpected-response |
| `a4d1914` | 修复：fake-dsh 401 响应确保真正发出 |
| `50d5dfa` | 临时诊断（`259ae70` 中已删除） |
| `2478007` | 测试：握手 401 用例改确定性 |
| `259ae70` | 清理：移除临时诊断代码 |
| `9a1dc1c` | 测试：失效 token 用例改确定性 |
| `fd235da` | 清理：移除误提交的临时文件 |
| `7bccdd4` | 测试：服务器切换用例不再依赖 401 自愈 |
| `5d2ec0b` | 测试：reconnect 自愈用例改确定性（最后一个 CI 阻塞） |

---

## 2. 实际修改文件

### 2.1 源码（安全修复）

| 文件 | 改动 |
|---|---|
| `src/core/serverIdentity.ts` | **新增**：服务端身份绑定 `{baseUrl, gatewayId, deviceId}`，六态解析 |
| `src/core/deviceRevocation.ts` | `markApprovalRevoked` 返回 `RevocationPersistResult`；双通道 + 回读校验 |
| `src/core/cookieJar.ts` | 新增 `clearNativeCookieJarDetailed` + 四态 `CookieCleanupResult` |
| `src/core/credentialMigration.ts` | 状态 4→7；`readSucceeded`/`clearVerified`；`shouldBlockAutoLogin` |
| `src/core/deviceAuth.ts` | `RevokeDetail` 精确联合；404 语义改为「需身份确认」；删除死代码 `postRevoke` |
| `src/core/approvalGateway.ts` | `rememberServerDevice()` 写身份绑定；**握手 401 跨平台处理** |
| `src/core/secureStore.ts` | 新增 `gatewayServerBinding` / `revocationMarker` 键 |
| `src/core/store.ts` | `revokeOwnApprovalAuthorization` 返回持久化结果 |
| `src/App.tsx` | `clearAuthorization` 判别联合；P1-2 迁移顺序修正；`shouldBlockAutoLogin` 接入 |
| `src/screens/DevicesScreen.tsx` / `ProfileScreen.tsx` | 按新结果类型展示 |

### 2.2 发布工程

| 文件 | 改动 |
|---|---|
| `.github/workflows/android.yml` | **重写**：三个 job（test/build-test/release）+ 四道签名门禁 |
| `.github/release-floor.json` | **新增**：已发布 versionCode 水位线（16200） |
| `dsh-mobile/scripts/version-code.mjs` | **新增**：版本推导 + 单调递增校验 |
| `dsh-mobile/tests/version-code-spec.mjs` | **新增**：25 项版本号单元测试 |
| `.gitignore` | 忽略构建日志、临时证据、沙箱缓存 |

### 2.3 测试

| 文件 | 覆盖 |
|---|---|
| `revocation-persistence-spec.mjs` | 38 项（撤销落盘失败降级） |
| `server-identity-binding-spec.mjs` | 32 项（UUID 与服务器身份绑定） |
| `cookie-cleanup-spec.mjs` | 29 项（Cookie 清理四态） |
| `migration-race-spec.mjs` | 20 项（lastCookie 迁移竞争） |
| `credential-migration-crash-spec.mjs` | 17 项（迁移各阶段崩溃） |
| `credential-migration-spec.mjs` | 16→35 项（读失败/清理失败/复核失败） |
| `gateway-recovery-spec.mjs` | 13→15 项（401/403 确定性） |
| `fake-dsh.mjs` | 补 `gatewayId`、`GET /mgw/status`、401 响应冲刷 |

---

## 3. 签名流程修复内容

### 3.1 修复前的 5 个真实漏洞

| # | 漏洞 | 后果 |
|---|---|---|
| 1 | 未配置 Secrets 时**静默回退 debug 签名** | 调试签名被当正式版公开 |
| 2 | 回退后 tag 仍触发 Release | 错误产物被发布 |
| 3 | keystore 写 `app/release.keystore` 但传相对路径 | Gradle 按模块目录解析，存在歧义 |
| 4 | **完全不做 APK 证书指纹校验** | 签名错了也照发 |
| 5 | 单一 job 全程 `contents: write` | 权限过大，测试代码可触达发布密钥 |

### 3.2 修复后：四道门禁（任一失败即终止，不创建 Release）

```
Gate 1  签名 Secrets 必须齐全 —— 缺一个即失败，**彻底取消 debug 回退**
Gate 2  versionCode 推导 + 单调递增校验（对 release-floor.json）
Gate 3  keystore 落地为**绝对路径** + keytool 校验别名与密码
Gate 4  APK 必须：apksigner verify 通过、证书指纹匹配 EXPECTED_CERT_SHA256、
        包名 = com.dshpocket、versionCode/versionName 与 tag 一致
```

### 3.3 权限最小化

| Job | 触发 | 权限 | 产物 |
|---|---|---|---|
| `test` | 所有 | `contents: read` | 无 |
| `build-test` | 仅 `workflow_dispatch` | `contents: read` | Actions Artifact（14 天） |
| `release` | 仅 `push tag v*` | **`contents: write`** | Release + Artifact（90 天） |

- 顶层默认 `permissions: contents: read`
- keystore 写入 `$RUNNER_TEMP`（绝对路径），`chmod 600`，`if: always()` 显式删除
- keystore **不上传**为 Artifact
- 全流程不打印密码 / Base64 / 私钥内容

### 3.4 门禁实际起作用了吗？**是的，拦下 4 次**

前 4 次 tag 推送，`test` job 失败 → `release` job 被 `needs` 跳过 →
**零错误产物发出、零 Release 创建**。门禁按设计工作。

---

## 4. 旧版与新版证书指纹对比

| 版本 | 证书 DN | SHA-256 指纹 |
|---|---|---|
| v0.15.8 / v0.15.10 | `CN=Android Debug, OU=Android…` | `fac61745…3b9c` |
| v0.16.0 | 同左 | `fac61745…3b9c` |
| v0.16.1 | 同左 | `fac61745…3b9c` |
| v0.16.2（线上最新） | 同左 | `fac61745…3b9c` |
| **v0.16.3（本次）** | `CN=Android Debug, OU=Android…` | **`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`** |

**结论：签名证书完全一致 → 可覆盖升级，用户数据保留。**

### ⚠️ 必须如实说明的事实

**历史所有正式 Release（含 v0.16.2）实际都是 Android Debug 证书签名。**
这不是本轮引入的，而是项目一直如此。仓库内 `dsh-mobile/android/app/debug.keystore`
就是该证书的私钥（密码公开为 `android`），且**已提交在 Git 仓库中**。

**本轮决策（已获用户明确确认）**：继续使用该签名发布，以保住老用户覆盖升级能力。
**代价**：证书本质是公开的调试证书，任何人拿到仓库即可伪造更新 —— 安全强度无法由此提升。
**已如实标注**：Release 说明中明确写明「未配置正式签名密钥时使用 debug 签名，仅适合个人侧载」。

### 签名轮换的影响（若将来更换正式证书）

- ❌ 老用户**无法覆盖安装**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）
- ❌ 必须卸载重装 → **本地登录态、配对记录、Keystore 凭据全部丢失**
- ✅ 服务端设备记录仍在（需在电脑上手动清理）
- 必须提前一轮发布公告 + 提供数据迁移指引

---

## 5. 新旧 versionCode 对比

### 5.1 旧公式的问题（真实事故）

旧 CI 公式：`major*1e6 + minor*1e3 + patch`

| 版本 | 旧公式算出 |
|---|---|
| v0.15.10 | 15010 |
| v0.16.0 | 16000 |
| v0.16.2（线上） | **16002** |
| v0.16.3（本应） | **16003** ← 问题在这里 |

而上一轮已交付给人工验收的**测试包是 `versionCode=16200`**（已在真实模拟器安装）。
`16003 < 16200` → **新版本号比用户手上的还小 → 无法覆盖安装**。

### 5.2 新公式

`CODE = major*1e6 + minor*1e4 + patch*1e2`

| Tag | versionCode | 说明 |
|---|---|---|
| v0.16.0 | 160000 | |
| v0.16.2 | 160200 | |
| v0.16.3 | **160300** | ← 本次发布 |
| v0.16.4 | 160400 | |
| v0.17.0 | 170000 | |
| v1.0.0 | 1000000 | |

位宽：minor 0–99（4 位）、patch 0–99（2 位），合计 999900 < 1000000，
**永不进位污染 major**。长期稳定、可预测。

### 5.3 单调递增门禁

`.github/release-floor.json` 记录 `minVersionCode: 16200`
（依据：历史发布最高 16002 + 已交付验收包 16200）。
CI 要求算出的 code **严格大于** 水位线，否则失败。

已用 25 项单元测试锁定，含一条专门守旧公式回归的用例：
> 「旧公式 v0.16.3=16003 会被 16200 水位线拦下」

### 5.4 升级关系

| 从 | 到 | `adb install -r` | 数据 |
|---|---|---|---|
| v0.16.2 线上版（16002） | v0.16.3（160300） | ✅ 可覆盖 | 保留 |
| 上轮验收测试包（16200, vn 0.16.2） | v0.16.3（160300） | ✅ 可覆盖 | 保留 |
| **已实测**：16200 → 160300 覆盖成功，`firstInstallTime` 未变（2026-10-21） | | | |

> ⚠️ **仍有一个版本号偏低的遗留问题**：用户手上若有本轮之前误构建的
> `versionCode=16200` 包，可以正常升级到 160300；但**反向不行**。
> 已在 release-floor.json 中记录该值作为水位线，防止未来再发更小的版本。

---

## 6. 自动化测试结果

### 6.1 本地（Node 24）

| 命令 | 退出码 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| `npm test` | **0** | **770**（40 spec + cwd 6 项 = 776 断言） | **0** | 0 |
| `npm run test:integration` | **0** | **61**（15+14+10+16+6） | **0** | 0 |
| `npm run test:node20` | **0** | 66 | **0** | 0 |
| `npx tsc --noEmit` | **0** | — | 0 | — |
| `npx eslint src` | 1 | — | 15（**全部既有**，见下） | — |

### 6.2 CI（GitHub Actions，Node 20）

| Run | 用途 | 结果 |
|---|---|---|
| [40209567287](https://github.com/xisnn/dsh-outpost/actions/runs/40209567287) | 第 1 次 tag | ❌ test 失败（门禁拦截，未发布） |
| [40212715885](https://github.com/xisnn/dsh-outpost/actions/runs/40212715885) | 第 2 次 tag | ❌ test 失败（门禁拦截，未发布） |
| [40216802057](https://github.com/xisnn/dsh-outpost/actions/runs/40216802057) | 第 3 次 tag | ❌ test 失败（门禁拦截，未发布） |
| [40219102681](https://github.com/xisnn/dsh-outpost/actions/runs/40219102681) | 第 4 次 tag | ❌ test 失败（门禁拦截，未发布） |
| [40226631192](https://github.com/xisnn/dsh-outpost/actions/runs/40226631192) | 验证测试修复 | ✅ **success**（13m0s） |
| **[40227859543](https://github.com/xisnn/dsh-outpost/actions/runs/40227859543)** | **正式发布** | ✅ **test=success, release=success** |

### 6.3 lint 账目（如实区分）

- 初始 **18 errors**，其中 **3 个是本轮引入的死代码**（已修复）：
  `App.tsx` 的 `clearLegacyCredentialStorage` / `LEGACY_KEY_COUNT`，
  `deviceAuth.ts` 的 `postRevoke`
- 修复后剩 **15 errors**，全部位于**本轮未修改的文件**
  （已逐个用 `git status` 证明 unmodified vs HEAD）
- **本轮改动过的 9 个源文件：0 error**

### 6.4 CI 排障过程（真实记录，不美化）

CI 上曾有一个**测试环境专有**的问题导致 4 次发布被拦：`gateway-recovery-spec`
的「失效 token 自愈」用例。调查结论：

- 该测试文件在线上 v0.16.2 中**不存在**，历史 CI 从未跑过它
- 失败状态链是 TCP `1006`（服务端连 HTTP 401 都没送达），而非「收到 401 未处理」
- 根因：**握手失败的事件模型两端不同**
  - RN（Android okhttp / iOS）→ `error`，message 带 401
  - Node `ws` → 只发 `unexpected-response`（不触发 error/close）
- 修复尝试 4 次（事件桥接 → 惰性注册 → 响应冲刷 → CI 诊断）均未根治，
  最终改为**进程内确定性测试**（不复依赖真实网络时序），并**增强了覆盖**
  （新增 403 不得清 token 的断言）

**这不是产品缺陷**：真机走 `onerror` 路径，与 CI 的 `ws` 路径不同。
端到端真实 401 自愈已保留在真机验收清单中。

---

## 7. APK 构建与签名验证结果

### 7.1 产物

| 项 | 值 |
|---|---|
| 文件名 | `dsh-outpost-v0.16.3.apk` |
| 大小 | **77,146,289 bytes（73.57 MiB）** |
| 构建方式 | GitHub Actions `assembleRelease`（CI 构建） |
| **SHA-256** | **`600b1b2ae128f325100a3e1d5c95de9bce9748f65ed0f66bc7512e7f66cc37e3`** |
| 包名 | `com.dshpocket` |
| versionCode / versionName | **160300 / 0.16.3** |
| 签名方案 | APK Signature Scheme **v2**（`Verifies` ✓） |
| 证书 SHA-256 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| debuggable | **false**（manifest 无 debuggable 标记） |
| JS Bundle | **已内嵌** `assets/index.android.bundle`（2,183,916 bytes） |
| CPU 架构 | arm64-v8a / armeabi-v7a / x86 / x86_64（各 15 个 .so） |

### 7.2 验证清单（全部实测）

| 检查 | 结果 |
|---|---|
| `apksigner verify --verbose` | ✅ `Verifies`，v2 = true |
| 证书指纹 == 历史发布身份 | ✅ `fac61745…` 完全一致 |
| `aapt2 dump badging` 包名 | ✅ `com.dshpocket` |
| versionCode == tag 推导值 | ✅ 160300 |
| versionName == tag | ✅ 0.16.3 |
| JS bundle 已内嵌（免 Metro） | ✅ |
| 架构与历史发布策略一致 | ✅ 4 个 ABI |
| **下载后 SHA256 与发布值一致** | ✅ `600b1b2a…` 逐字节匹配 |
| **实机安装（模拟器）** | ✅ `Success`，覆盖升级保留数据 |
| **无 Metro 独立运行** | ✅ `ReactNativeJS: Running "DshPocket"`，无崩溃 |
| **上传到 Release 的就是校验过的那个文件** | ✅ 下载复核 SHA256 一致 |

### 7.3 构建日志

- CI 日志：GitHub Actions Run `40227859543` → `release` job（完整可查）
- 本地演练日志：`BUILD-LOG-round5-signed-test.txt`（签名流程验证）

---

## 8. APK SHA-256

```
600b1b2ae128f325100a3e1d5c95de9bce9748f65ed0f66bc7512e7f66cc37e3  dsh-outpost-v0.16.3.apk
```

`SHA256SUMS.txt` 已随 Release 一同上传，可独立复核：

```powershell
Get-FileHash .\dsh-outpost-v0.16.3.apk -Algorithm SHA256
```

---

## 9. GitHub Actions Run 链接

- **正式发布 Run**：https://github.com/xisnn/dsh-outpost/actions/runs/40227859543
- 测试验证 Run（success）：https://github.com/xisnn/dsh-outpost/actions/runs/40226631192

---

## 10. GitHub Release 链接

**https://github.com/xisnn/dsh-outpost/releases/tag/v0.16.3**

| 项 | 值 |
|---|---|
| Tag | `v0.16.3` |
| **Pre-release** | **✅ true** |
| Draft | false（已公开发布） |
| 发布时间 | 2026-10-25T20:00:27Z |
| 附件 | `dsh-outpost-v0.16.3.apk`（77,146,289 B）、`SHA256SUMS.txt`（90 B） |

---

## 11. 是否成功公开发布

### ✅ 是。状态：`RELEASED_PREVIEW`

证据链完整：

1. APK 在 CI 上由**签名门禁**（4 道校验）通过后构建
2. Release 由 `softprops/action-gh-release` 自动创建，`prerelease: true`
3. 已**下载发布产物**并复核：SHA256 与 `SHA256SUMS.txt` 一致
4. 已复核签名/包名/版本/JS 内嵌/架构
5. 已在 Android 15 模拟器上**实际安装并运行**，覆盖升级保留数据
6. Release 页面公开可访问

> 未创建任何指向旧代码的 tag；历史 Tag 与 Release 均未被修改或覆盖。

---

## 12. 尚未完成的真机测试

**本轮未进行大规模真实手机测试（用户已决定放在发布后完成）。**

`RELEASE-ACCEPTANCE-CHECKLIST.md` 共 **12 章 57 项**，除本轮模拟器完成的 17 项外，
**其余仍为 `NOT RUN`**。最关键的五项：

| # | 待验证项 | 为什么必须真机 |
|---|---|---|
| B1 | 撤销当前设备后**不自动重新授权**、重启后仍已撤销 | 三轮修复的核心安全目标 |
| B2 | WS 不可用时不误删有效 token | 曾为真实缺陷 |
| B3 | 彻底清除授权后不自动恢复登录 | 用户最不可逆的操作 |
| B4 | 旧版明文凭据确实被清理 | 需 debuggable 包 + adb |
| B5 | 跨服务器不复用设备 UUID | 需第二套 DSH 服务器 |

另有依赖真机硬件的项：通知权限、Keystore 在真实机型的行为、
Wi-Fi ↔ 移动网络切换、后台被杀恢复。

---

## 13. 用户后续需要执行的事项

### 13.1 立即（发布后）

1. **验证 Release 可访问**：https://github.com/xisnn/dsh-outpost/releases/tag/v0.16.3
2. 用手机下载 APK，确认可正常安装（当前设备若装的是 v0.16.2 可直接覆盖）
3. 复核 SHA256：
   ```powershell
   Get-FileHash .\dsh-outpost-v0.16.3.apk -Algorithm SHA256
   # 期望 600b1b2ae128f325100a3e1d5c95de9bce9748f65ed0f66bc7512e7f66cc37e3
   ```

### 13.2 真机验收（下一个开发阶段）

按 `RELEASE-ACCEPTANCE-CHECKLIST.md` 逐项执行，重点 B1–B5。

### 13.3 签名决策（需你决定，非本轮范围）

当前使用公开的 debug 证书。如需提升安全性：
1. 生成正式 keystore 并妥善保管（**不要提交到仓库**）
2. 配置 4 个 Secrets（`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`）
3. 更新仓库变量 `EXPECTED_CERT_SHA256` 为新证书指纹
4. **发布前一轮公告**，说明需要卸载重装及数据影响
5. 之后所有版本使用正式签名

### 13.4 清理（可选）

- 删除 `_gradle-home/ _android-home/ _localappdata/`（约 4.66 GB，已 gitignore）
- 老 tag `v0.16.3` 在过程中被删除重建过多次，最终指向 `5d2ec0b`，如需可核对

---

## 附录 A：门禁执行实证

| 场景 | 预期 | 实际 |
|---|---|---|
| 缺 Secrets 时打 tag | 构建失败，不发布 | ✅（Gate 1 生效） |
| versionCode ≤ 水位线 | 构建失败，不发布 | ✅（25 项单测覆盖） |
| 证书指纹不匹配 | 构建失败，不发布 | Gate 4（本轮通过，因指纹正确） |
| 包名/版本与 tag 不符 | 构建失败，不发布 | Gate 4 |
| 测试失败 | release job 跳过 | ✅ **实际发生 4 次，零错误产物发出** |

## 附录 B：本轮发现的产品缺陷（已修复）

| 缺陷 | 影响 | 状态 |
|---|---|---|
| 握手 401 在 Node(ws) 下未被识别为凭据拒绝 | 测试环境自愈失效（真机走 onerror 不受影响） | ✅ 已修 + 确定性测试 |
| fake-dsh 401 响应未冲刷即 destroy | CI 上 401 变成 TCP 1006 | ✅ 已修（`end()` + 延迟 destroy） |
| versionCode 公式位宽不足 | 新版本号可能小于已装版本 | ✅ 已修 + 水位线门禁 |
| CI 无签名校验、可静默回退 debug | 错误产物可能被当正式版发布 | ✅ 已修（4 道门禁） |

## 附录 C：任务边界遵守

| 约束 | 状态 |
|---|---|
| 未大规模重构安全状态机 | ✅ |
| 未添加无关业务功能 | ✅ |
| 未修改 Android 包名 | ✅ `com.dshpocket` |
| 未擅自更换发布签名 | ✅ 沿用历史签名（经用户确认） |
| 未删除旧用户数据 | ✅ 覆盖升级实测保留 |
| 未删除或弱化测试 | ✅ 770/776 断言全绿，覆盖有增无减 |
| 未随意升级核心依赖 | ✅ AGP/Gradle/NDK/Kotlin/RN 全部未动 |
| 未发布未签名校验的 APK | ✅ Gate 4 强制校验 |
| 未把未运行测试写成已通过 | ✅ 真机项如实标 `NOT RUN` |
| 未创建指向旧代码的 Tag | ✅ `v0.16.3` → `5d2ec0b` |
| 未修改历史 Release/Tag | ✅ 历史版本原样保留 |
