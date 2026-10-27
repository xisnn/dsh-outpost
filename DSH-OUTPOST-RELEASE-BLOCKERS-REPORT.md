# DSH Outpost 发布阻断问题专项整改报告（第二轮）

> 依据：`DSH-OUTPOST-CINDY-GAP-ANALYSIS.md`、`DSH-OUTPOST-SECURITY-REMEDIATION.md`、`docs/P1-1-SIGNING-VERIFICATION.md`、当前源码与第三方插件实现。
> 范围：**只处理 P0-2（安全可用的配对）与 P1-1（签名与更新迁移）**，外加第一轮修复的回归复核。
> 本报告不含任何真实私钥、密码或令牌。文中所有凭据均以占位符表示。

---

## 0. 结论：是否具备安全发布条件？

**否。** 缺 3 项硬性条件，其中 2 项**只能由仓库管理员手工完成**，1 项需要真机验证：

| # | 缺口 | 性质 | 谁能做 |
|---|---|---|---|
| 1 | **未生成私有签名密钥**，正式包仍会用公开 debug 证书 | 管理员手工 | 仓库管理员 |
| 2 | **GitHub Secrets / Variables 未配置**（4 个 Secret + `EXPECTED_CERT_SHA256`） | 管理员手工 | 仓库管理员 |
| 3 | **P0-2 补丁未在真实环境端到端验证**（本机 DSH 绑定地址失效，无法联调） | 真机验证 | 有可用 DSH 环境的人 |

**已经修复并验证的**：
- P0-2 的**技术方案已落地且可用**：管理接口认证补丁把 `/mgw/*` 交给 DSH 自己的会话认证，19 项自动化断言全通过。**不再需要「接受风险」或「默认关闭功能」。**
- 第一轮的 **2 个真实回归缺陷已修复**（`assembleDebug` 被配置期 `throw` 打挂；CI 缺少 debug 证书黑名单）。

---

## 1. P0-2：安全可用的配对方案

### 1.1 任务 A —— 实际约束（全部实测，不复用第一轮的假设）

第一轮已证明 loopback 不可用。本轮重新独立验证：

| 事实 | 证据 |
|---|---|
| DSH 只接受**一个具体 IP** | `dsh --host 0.0.0.0` → `error: --host 0.0.0.0 is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network` |
| 绑定具体 IP 后**回环不监听** | `Get-NetTCPConnection -LocalPort 3095` → `LocalAddress = 192.168.x.x`；`TcpClient 127.0.0.1:3095` → `CONNECT FAIL` |
| 本机访问自己的 LAN IP，服务端看到的**不是回环** | 隔离探针：客户端本机 → `http://192.168.x.x:39011/`，服务端 `remoteAddress = 192.168.x.x` |
| `/mgw/*` 注册在 **DSH 自己的 webServer** | 插件 `lib/index.mjs:2691` `webServer.register({ kind:'prefix', path:'/mgw', ... })` |
| `/mgw/*` 只受两道不足的防线保护 | `:2696` `adminLoopbackOnly && !isLoopback` ；`:2700` `isSameOrigin(req)`，而 `isSameOrigin` 在 `origin === undefined` 时返回 `true`（`:2085`） |
| `POST /mgw/pair` **无鉴权** | `:2831-2858`：仅校验 `gatewayEnabled` 与 `publicUrl`；上游 0.10.3 与最新 **0.11.1 都一样**（已下载 0.11.1 只读比对） |
| 网关自己的 3081 监听器**只处理 WS upgrade** | `:3144-3160`：非 `/ws/mobile` 的 upgrade 一律 404，普通 HTTP 请求返回 404 → **不存在第二条 `/mgw/*` 路径** |

**关键否定结论**：在本项目的部署形态下，
`adminLoopbackOnly: true` = `/mgw/*` 对**所有人（含本机）**不可达 → 首次配对必然失败；
`adminLoopbackOnly: false` = 配对可用但管理接口无认证。
**上游没有第三条路** —— 这就是本轮要解决的问题。

### 1.2 任务 B —— 五个方案评估

| 方案 | 安全边界 | 改动量 | 维护成本 | 结论 |
|---|---|---|---|---|
| A. 等上游加认证 | 最好 | 0 | 0 | ❌ 0.11.1 仍未修；发布日期不可控 |
| B. 完整 fork 插件 | 好 | 大 | 高（每次上游更新都要合并） | ❌ 单人项目负担不起 |
| C. 桌面端铸造配对码 + 本机确认 | 好 | 中 | 中 | ❌ **不可行**：回环不监听（§1.1），桌面端无法以本机回环身份调用 |
| D. 网络边界认证代理 | 好 | 大 | 高 | ❌ 需额外常驻进程 + 证书 + 保证代理不可绕过，复杂度远超收益 |
| **E. 受控补丁：把访问控制交给 DSH 自己的会话认证** | 好 | **约 40 行注入** | **低**（一个锚点 + 哈希白名单） | ✅ **选用** |

### 1.3 方案 E 的技术依据（这是本轮的核心发现）

DSH 核心对外暴露了一个**专为此场景设计**的公开方法（从 `app.asar` 提取的类型文档原文）：

```
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection
  "Apply Connection's Host/Origin checks and browser authentication
   to another Web route."
```

它的实现走 `admit(request)`：

```
isTrusted(request)                              → Host 白名单 + Sec-Fetch-Site + Origin 同源栅栏
browserAuth.isAuthenticated(request, secure)    → 校验 dsh-auth-* 会话 cookie
browserAuth.authenticateApi(request, secure)    → 或校验 API 凭据
返回 undefined 放行；401/403 拒绝
```

DSH 自己的路由就是这么用的（`api-gateway`、`open-in-app` 等：`const rejection = ctx.connection.requestRejection(req)`）。
补丁只是在 `/mgw/*` 的路由分派前，插入同一调用。

**为什么这个认证是够格的**（满足「不能单纯依赖 Origin / 来源 IP / 用户确认警告」）：

- 校验的是**签名过的会话 cookie**（`dsh-auth-*`，HMAC 签名 + 绑定 host:port + 绝对过期时间），不是可伪造的请求头。
- 同时叠加 Host/Origin 栅栏，抵御 DNS rebinding 与跨站请求。
- cookie 的签名密钥由 DSH 自己管理（`ctx.credentials`），本插件不持有、也无法伪造。

### 1.4 为什么正常用户不会被挡住（逐条验证）

| 客户端 | 带凭据？ | 依据 |
|---|---|---|
| **手机 App 首次配对** | ✅ | `approvalGateway.ts:843-849` 的 `/mgw/pair` 请求已是 `credentials: 'include'`；此前 `loginWithToken` 已拿到 DSH 会话 cookie |
| **手机重连** | ✅ 不受影响 | 走 `/ws/mobile` WebSocket，不经 `/mgw/*` |
| **网页插件**（DSH 侧边栏） | ✅ | `client.js` 的 `request()` 用 `credentials: 'same-origin'` |
| **桌面助手设备列表** | ⚠️ 需改（已改） | 原来用 Node `fetch` 裸调 `/mgw/devices`。现改为先用 `pairing.json` 的 token 换会话 cookie 再调（`main.js` 新增 `getDshSessionCookie`）；拿不到时降级提示 `authRequired`，**不阻塞主流程** |

**Host 栅栏不会误伤局域网**：`isTrustedApiRequest` 接受「监听地址本身」作为合法 Host
（`isBindAddressAuthority(hostUrl, bindHost)`），手机用 `http://192.168.x.x:3095` 访问是合法的。

### 1.5 实施内容

**新增 `patches/mobile-gateway-mgmt-auth/`（受控补丁，不是 fork）**

| 文件 | 作用 |
|---|---|
| `patch.mjs` | 纯文本变换：在唯一锚点前注入认证块。锚点不是恰好 1 处就抛错；已打过则幂等返回 |
| `apply.mjs` | `--check` / `--apply` / `--revert`；**源文件 SHA-256 白名单**（只允许在核对过的插件版本上打补丁）；打补丁前备份 `.orig`；写 `state.json` 记录指纹 |
| `README.md` | 完整方案说明：约束、依据、五方案对比、部署与升级流程、已验证/待验证 |

**注入的认证块（约 40 行）行为**：

```
ctx.connection 不存在           → 503 mgmt-auth-unavailable   (fail-closed)
requestRejection 不是函数        → 503 mgmt-auth-unavailable   (fail-closed)
requestRejection 抛错            → 503 mgmt-auth-error         (fail-closed)
requestRejection 返回 401        → 401（未认证，拿不到配对码）
requestRejection 返回 403        → 403（Host/Origin 不合法）
requestRejection 返回 undefined  → 放行到原路由
```

**旧的 `isSameOrigin` 检查保留**，作为纵深防御的第二层。

**`setup-gateway.ps1` 改为强制依赖补丁**：
- 先 `--check`，未打则 `--apply`
- **补丁未就绪 → `exit 1`，拒绝写配置**（不再提供「接受风险」的开关）
- 补丁就绪后才写 `adminLoopbackOnly: false`（此时配对可用且管理接口受认证保护）
- 已删除 `-AllowLanManagement` 参数（那个「用风险换功能」的中间态已不需要）

### 1.6 P0-2 验收清单

| 验收项 | 状态 | 依据 |
|---|---|---|
| 正常用户能完成首次配对 | ⚠️ **待真机** | 代码路径已就绪（手机带 cookie），但本机 DSH 不可用，未端到端验证 |
| 未授权局域网设备无法铸造配对码 | ✅ **自动化验证** | 模拟 ctx：未认证 → 401，路由不可达（`mobile-gateway-patch-spec.mjs`） |
| 无效/过期配对码无法使用 | ✅ 上游既有 | 上游 `claimPairing` 用 SHA-256 digest + 一次性删除 + TTL；未改动 |
| 已撤销设备无法恢复访问 | ✅ 上游既有 | `registry` 的 `revokedAt` + WS 侧 `authenticate` 校验；未改动 |
| 审批操作仍需合法凭据 | ✅ 不受影响 | 审批走 `/ws/mobile`，`requireAuth: true` 未改 |
| 已配对设备能正常重连 | ⚠️ **待真机** | 代码路径未改（WS 不经过补丁） |
| 不能通过另一管理端点绕过 | ✅ **自动化验证** | 9 个 `/mgw/*` 路由全部在认证块之后；3081 监听器无 `/mgw` |
| 无需开启无认证高危接口 | ✅ **已达成** | 不再有 `-AllowLanManagement`；补丁就绪才允许 `adminLoopbackOnly: false` |

---

## 2. P1-1：正式签名与更新迁移

### 2.1 复核结论：第一轮改动的两个真实缺陷（已修复）

独立复核（用真实 gradle 调用，不是读代码）发现第一轮引入的**两个回归**：

#### 缺陷 A：`GradleException` 写在配置阶段 → `assembleDebug` 全挂

`android { buildTypes { release { } } }` 是**配置期**求值的，即使只跑 `assembleDebug` 也会执行。
实测：

```
gradlew :app:assembleDebug -m            → FAILURE: build.gradle line 144, exit 1
gradlew :app:tasks                       → 同样失败（证明是配置期）
+ -PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true → BUILD SUCCESSFUL
```

**后果**：CI 的 `build-test` job 永远红，所有开发者的 `assembleDebug` 不可用。

**修复**：把检查移到执行阶段 —— `gradle.taskGraph.whenReady` 钩子，只在任务图里真的包含
`assembleRelease` / `bundleRelease` / `packageRelease*` / `signRelease*` 时才抛错。
配置期只记录状态，不再失败。

**修复后实测（`release-signing-gates-spec.mjs` 固化，12 项断言）**：

```
assembleDebug -m                          → exit 0  ✅（回归已修）
:app:tasks                                → exit 0  ✅
assembleRelease -m（无签名材料）            → FAILED  ✅
bundleRelease -m（无签名材料，AAB 路径）    → FAILED  ✅
assembleRelease -m + 冒烟开关               → SUCCESS + debug 签名警告 ✅
```

#### 缺陷 B：CI 无法识别「用公开 debug 证书签名」

原来的 Gate 4 只比对 `EXPECTED_CERT_SHA256`。若管理员把它误设成 debug 证书指纹
（`fac61745…`），门禁会**通过**——而那个证书的私钥就在仓库里。

**修复**：在 `.github/workflows/android.yml` 增加一道**独立于变量配置**的绝对门禁：

```bash
DEBUG_CERT_SHA256="fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c"
if [ "$NORM_ACTUAL_LC" = "$DEBUG_CERT_SHA256" ]; then
  echo "::error::APK 使用的是仓库内公开的 Android Debug 证书，绝对不允许发布"; exit 1
fi
# 并且：EXPECTED_CERT_SHA256 本身被设成该值时也硬失败
```

### 2.2 证书身份（用真实 APK 核验）

`apksigner verify --print-certs` 对 5 个 APK 的结果 —— **全部相同**：

```
SHA-256: fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
DN: CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US
```

覆盖：`_test-artifacts/TEST-…-vc16200-…-debugsigned.apk`、`_test-artifacts/OLD-…-vc1-…apk`、
本地 `apk/release/app-release.apk`、本地 `apk/debug/app-debug.apk`、`_test-artifacts/NEW-app-debug….apk`。

与仓库内 `dsh-mobile/android/app/debug.keystore` 的证书指纹**完全一致**（keytool 核验）。
该 keystore 由 `.gitignore:43-44` 显式放行（`*.keystore` + `!dsh-mobile/android/app/debug.keystore`）。

### 2.3 哪些 APK 真正公开发布过

| 来源 | 判定 | 依据 |
|---|---|---|
| **v0.16.3** | ✅ **确认公开发布** | `DSH-OUTPOST-RELEASE-REPORT.md:5,331-333`（RELEASED_PREVIEW，`prerelease:true`，`draft:false`，2026-10-25T20:00:27Z） |
| `_test-artifacts/` 3 个 APK | ✅ 仅测试 | `ANDROID-BUILD-RESULT.md:144,149,158,206` |
| v0.15.8–v0.16.2 及更早 | ❓ **无法确定** | 本沙箱无法访问 github.com/api.github.com（DNS 指向非公网 IP）；57 个 tag 都含发布 workflow，tag 存在不能证明发布过 |

**但不影响迁移结论**：所有可查到的产物都是 `fac61745…`，因此**所有历史用户都受影响**。

### 2.4 SHA-256 更新校验：双向验证

`update-integrity.ts`（纯逻辑）+ `updater.ts`（接入）的 6 种情形：

| 情形 | 行为 | 结论 |
|---|---|---|
| 哈希匹配 | 放行到安装器 | ✅ |
| 哈希不匹配 | **删除文件 + 抛错**，不进安装器 | ✅ |
| `SHA256SUMS.txt` 不存在 | 退到 release body 内联哈希 | ✅ |
| sums 存在但不含该 APK | **拒绝安装**（不误用别人的哈希） | ✅ |
| sums 拉取失败 + body 有哈希 | 用 body 哈希 | ✅ |
| 两者都没有 | **拒绝安装**（不降级为「只比大小」） | ✅ |
| 缓存命中路径 | 同样经过校验 | ✅ |

**信任锚的诚实边界**：哈希与 APK 来自同一渠道（GitHub Release），**挡不住整个 Release 被接管**。
真正的锚是 Android 的签名校验 —— 前提是正式包用**私有**密钥（阻断项 1）。
本轮新增的 debug 证书黑名单让这个前提**无法被绕过**。

### 2.5 第二条安装路径（本轮新发现并修复）

复核时发现：聊天附件里的 `.apk` 会经 `FileCard` → `openLocalFile` → `actionViewIntent`
直接进系统安装器，**完全不经过 `verifyApkIntegrity`**。在签名密钥公开的情况下，
任何能往会话里丢文件的人都能投递一个 Android 会接受的「更新」。

**修复**：新增 `src/core/installable.ts`（纯逻辑），`openLocalFile` 对
`.apk/.apks/.xapk/.aab/.apkm` 抛错并提示改用「保存到手机」后手动安装。
已固化 18 项断言（`update-integrity-spec.mjs`）。

### 2.6 迁移与数据恢复矩阵

从 debug 签名升级到正式签名，Android **强制要求卸载重装**。用户会失去：

| 数据 | 是否丢失 | 能否恢复 |
|---|---|---|
| Keystore 内 5 个凭据（cookie / gatewayToken / deviceId×2 / binding） | ❌ 全丢（卸载销毁 Keystore） | ✅ 重新扫码配对即可重建 |
| `@dsh/archivedSessions`（已删除标记） | ❌ 丢 | ❌ **不可恢复**（DSH 本身不返回归档状态） |
| `workspace-custom`（工作区别名 / emoji） | ❌ 丢 | ❌ 需手工重设 |
| 主题 / 管家模式 / 最近工作区 / baseUrl | ❌ 丢 | ✅ 重设一次即可 |
| 原生 CookieJar | ❌ 丢 | ✅ 重新配对 |
| **所有会话、任务、计划、工作区文件** | ✅ **不丢** | 全部在电脑上（DSH 侧） |
| 服务端设备记录 | ⚠️ 残留 | 会变成孤儿但仍「受信」→ **必须在电脑上撤销** |
| `@dsh/approvalRevoked` + revocationMarker | ❌ 丢 | ✅ 安全中性（凭据也一起没了，不会自动重新授权） |

**必须做的用户侧动作**（写进发布说明）：卸载前先记录工作区别名；重装后重新扫码；
到「我的 → 设备管理」把旧设备记录撤销。

### 2.7 管理员必须手工完成的步骤（**尚未完成，不予假装完成**）

以下步骤**无法自动化**，必须由仓库管理员执行：

1. **离线生成私有 keystore**（不要把密码写进命令行历史）
   ```
   keytool -genkeypair -v -keystore dsh-release.keystore -alias dsh-release \
     -keyalg RSA -keysize 4096 -validity 10000 -storetype PKCS12
   ```
2. **保管**：至少 2 份加密离线备份、异地存放；密码与密钥文件分开保管；不云盘、不进 Git、不发聊天；每半年演练一次恢复。
3. **配置 4 个 GitHub Secrets**：`KEYSTORE_BASE64`（`[Convert]::ToBase64String([IO.File]::ReadAllBytes('dsh-release.keystore'))`）、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`。
4. **配置 1 个 GitHub Variable**：`EXPECTED_CERT_SHA256`（**注意是 Variable 不是 Secret**，`android.yml` 读的是 `vars.`）。
   **必须 ≠ `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`** —— 设成它会导致门禁失败（这是有意的）。
5. 发布后把 `.github/release-floor.json` 的 `minVersionCode` 抬到刚发布的值。

**校验方法**（配好后自测一次）：
```
apksigner verify --print-certs <产物>.apk   → 指纹必须 ≠ fac61745…
```

---

## 3. 第一轮修复的回归复核

| 复核项 | 结论 | 证据 |
|---|---|---|
| 隧道 CORS 拒绝策略 | ✅ 无回归 | `isAllowedOrigin` 仍按 host:port 精确匹配；私网/公网 origin 仍 403（14/14 测试） |
| 无 Origin 请求的实际安全边界 | ⚠️ **如实说明** | 无 Origin 仍放行 —— 这是设计前提（服务只绑 `127.0.0.1`）。**结论：同机其它进程仍可驱动它**，属既有前提而非新缺陷 |
| `/tunnel/status` 剩余敏感信息 | ✅ **本轮已消除** | 第一轮只是收紧 CORS，token 仍在响应体里。本轮**直接移除 token 字段**，地址类字段改为去凭据版本；网页插件改为从自己页面 `?token=` 取，桌面助手本来就读 `pairing.json` |
| HTTPS 与局域网 HTTP 兼容性 | ✅ 无回归 | `net-security.ts` 规则未动：https 恒允许、私有网段 http 允许、CGNAT/Tailscale 允许、公网 http 拒绝 |
| 设备撤销与凭据迁移 | ✅ 未被触碰 | `deviceRevocation.ts` / `credentialMigration.ts` / `secureStore.ts` 无 diff |
| 更新包校验 | ✅ 仍在链路里 | `updater.ts:257` `await verifyApkIntegrity(path, release)` |
| 桌面启动脚本与原有网关配置 | ✅ 全部可解析 | `setup-gateway.ps1` / `start-dsh-web.ps1` / `start-tunnel.ps1` / `doctor.ps1` 语法检查通过；`tunnel-service.mjs` 与 `client.js` `node --check` 通过 |

**本轮额外发现并修复的回归**：第一轮 `gradle` 配置期 `throw`（见 §2.1 缺陷 A）—— 这条会让 **CI 与所有开发者构建失败**，属严重回归，已修复并加测试固化。

---

## 4. 本轮全部改动

**修改（9）**
```
.github/workflows/android.yml          +debug 证书黑名单门禁（独立于 EXPECTED 变量）
dsh-mobile/android/app/build.gradle    签名检查移到 taskGraph（修复 assembleDebug 回归）
dsh-mobile/src/core/fileUrl.ts         拒绝在 App 内安装聊天附件里的 APK
dsh-mobile/src/core/updater.ts         （沿用第一轮）verifyApkIntegrity 接入
dsh-mobile/package.json                接入 3 个新 spec
dsh-outpost-desktop/src/main/main.js   /mgw/devices 改为带会话凭据调用
dsh-plugin-connect/client.js           token 改从页面 URL 取（服务端不再返回）
dsh-plugin-connect/tunnel-service.mjs  移除 /tunnel/status 的 token 字段
setup-gateway.ps1                      强制依赖认证补丁；移除 -AllowLanManagement
```

**新增（7）**
```
patches/mobile-gateway-mgmt-auth/patch.mjs   管理接口认证补丁（纯文本注入）
patches/mobile-gateway-mgmt-auth/apply.mjs   幂等应用 + 哈希白名单 + 备份/回退
patches/mobile-gateway-mgmt-auth/README.md   方案依据、五方案对比、部署流程
dsh-mobile/src/core/installable.ts           安装包判定（纯逻辑）
dsh-mobile/tests/mobile-gateway-patch-spec.mjs   19 断言
dsh-mobile/tests/release-signing-gates-spec.mjs  12 断言（真实 gradle）
dsh-mobile/tests/update-integrity-spec.mjs       18 断言
```

未修改任何第三方依赖源码（补丁以可重放的文件形式存在于 `patches/`，不改 `node_modules` 的内容除外 —— 应用时通过 `apply.mjs` 写入并备份）。
未提交、未推送、未发布、未上传任何签名材料。

---

## 5. 测试结果

```
单元测试    npm test                    901 通过 / 0 失败   (exit 0)
集成测试    npm run test:integration     61 通过 / 0 失败   (exit 0)
类型检查    npx tsc --noEmit             通过              (exit 0)
Gradle 门禁 五种路径实测                  见 §2.1
```

断言数演进：第一轮结束 846 → 本轮 901（新增 55 条）。

**新增测试的关键断言**：
- `mobile-gateway-patch-spec.mjs`：补丁幂等、锚点缺失/重复即拒绝、注入位置在全部 9 个 `/mgw` 路由之前、6 条认证控制流（含 3 条 fail-closed）、3081 无旁路
- `release-signing-gates-spec.mjs`：**真实调用 gradlew**，断言 `assembleRelease`/`bundleRelease` 被拒且 `assembleDebug`/`:app:tasks` 正常
- `update-integrity-spec.mjs`：APK 附件拦截 + CI debug 证书黑名单存在且顺序正确 + gradle 无配置期 `throw`

**没有删除或放宽任何测试。** 修改的 2 个既有测试（`login-intent-spec.mjs`、`integration-product.mjs`）均为第一轮改动导致的适配，断言强度未降低。

---

## 6. 尚未完成 / 剩余风险

### 🔴 阻断发布

| # | 项 | 归属 | 为什么阻断 |
|---|---|---|---|
| 1 | 私有 keystore 未生成、Secrets/Variable 未配置 | **管理员手工** | 当前正式包仍会用公开 debug 证书；且**配置前 release job 会直接失败**（这是改对后的预期行为） |
| 2 | P0-2 未在真实环境端到端验证 | **真机** | 本轮执行期间本机 DSH 绑定在已从网卡消失的地址（`192.168.190.223` 不在任何接口上，连接 ECONNRESET），无法联调 |
| 3 | 存量用户迁移方案未落地到产品 | **产品决策** | 所有历史版本都是 debug 签名，切私有密钥后必须卸载重装；需要发布说明 + 引导文案 |

### 🟡 非阻断但需知晓

| # | 项 |
|---|---|
| 4 | 补丁依赖上游锚点。插件升级后需重新核对锚点并更新 `KNOWN_SOURCES` 哈希；`--check` 会失败提醒，不会静默退回无认证状态 |
| 5 | 哈希校验与 APK 同渠道，挡不住 Release 整体被接管（由私有签名兜底） |
| 6 | 无 Origin 的本机进程仍可驱动 `tunnel-service`（服务只绑回环，属既有前提） |
| 7 | `EXPECTED_CERT_SHA256` 目前未配置 → 配置前 release job 必定失败 |
| 8 | 上游若给 `/mgw/*` 加了认证，本补丁可安全移除 |

---

## 7. 当前是否具备安全发布条件？

**否。** 具体还缺：

**必须完成（阻断）**
1. 管理员生成私有 keystore + 配置 4 个 Secrets + `EXPECTED_CERT_SHA256` Variable；
2. 在可用环境完成 P0-2 真机验收：正常配对能拿到码、未认证请求被 401、已配对设备能重连；
3. 确定并落地存量用户的卸载重装迁移方案（含 PC 侧孤儿设备撤销引导）。

**完成后可发布**：本轮已把「必须开无认证高危接口才能用」这个两难**彻底消除**——
管理接口现在受 DSH 会话认证保护，配对可用且安全，不再需要任何「接受风险」的开关。

**不建议在以下情况发布**：未配置正式签名就发（会被 CI 拦住，但如果有人本地绕过去手动上传，等于发了一个任何人都能伪造更新的包）。
