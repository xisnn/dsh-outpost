# DSH Outpost 安全整改报告（第一批）

> 依据：`DSH-OUTPOST-CINDY-GAP-ANALYSIS.md` 第 6 章 / 第 8 章。
> 范围：只处理 P0-2、P1-1、P1-2、P1-4、P1-10、P2-13、P2-15 七项。
> 原则：**先复核对证据再动手**；不修改第三方依赖；不为兼容旧版保留默认开放的高危接口；不削弱设备绑定 / 凭据撤销 / 签名验证 / 权限审批。
> 本报告不含任何真实 token、密钥或签名密码。文中出现的 `xxx` / `<redacted>` 均为占位。

---

## 0. 结论摘要

| ID | 问题 | 复核结论 | 处理 | 状态 |
|---|---|---|---|---|
| **P0-2** | 网关配对码未认证生成 | **成立**，但**报告给的修法不成立** | 改为 fail-closed 默认 + 显式风险开关 + 文档如实披露 | ⚠️ 部分缓解，根因在上游 |
| **P1-1** | APK 更新无完整性校验 / 正式签名用公开 debug 密钥 | **成立**（用真实 APK 证书复核） | 更新前强制 SHA-256 校验；gradle 缺签名即硬失败；CI 指纹门禁改为硬失败 | ✅ 已修 |
| **P1-2** | 隧道服务 token 暴露 + CORS 过宽 | **成立**（隔离环境复现） | CORS 收紧到 DSH 自身 origin；拒绝先于任何动作 | ✅ 已修 |
| **P1-4** | 明文 HTTP 校验覆盖不足 | **成立** | 校验下沉到连接构造期 + 各直接 fetch 站点 | ✅ 已修 |
| **P1-10** | `doctor.ps1` 输出真实 token | **成立**（实跑确认） | 新增 `Redact-Url`，三处输出全部脱敏 | ✅ 已修 |
| **P2-13** | `tunnel.json` 权限未收紧 | **成立**（实测 ACL 可被沙箱账号读） | 新增 `Protect-StateFile`，两个写入点都收紧 | ✅ 已修 |
| **P2-15** | 隧道脚本继承危险权限模式 | **成立** | 改为显式 `-PermissionMode` 参数，默认 `workspace-write` | ✅ 已修 |

**自动化测试**：单元 846 通过 / 0 失败；集成 61 通过 / 0 失败；`tsc --noEmit` 通过。
**新增断言** 76 条（58 + 8 + 10），全部为失败场景回归。

**是否满足正式发布安全前置条件**：**否**，有两项硬阻断见 §7。

---

## 1. P0-2 —— 网关配对码未认证生成

### 1.1 报告结论复核：问题成立

原始证据链（重新核对，未直接采信审计结论）：

| 环节 | 位置 | 复核结果 |
|---|---|---|
| 我方写入不安全配置 | `setup-gateway.ps1:113` 原为 `adminLoopbackOnly: false` | ✅ 成立 |
| 插件管理路由的守卫 | 插件 `lib/index.mjs:2696-2703`：`adminLoopbackOnly && !isLoopback` 才 403；非 GET 再走 `isSameOrigin` | ✅ 成立 |
| `isSameOrigin` 可被脚本绕过 | 同文件 `2083-2092`：`if (origin === undefined) return true` | ✅ 成立（无 Origin 的脚本直接放行） |
| `/mgw/pair` 无鉴权 | 同文件 `2827-2858`：仅校验 `gatewayEnabled` 与 `publicUrl`，无 cookie / token / Origin 要求 | ✅ 成立 |

**本机实测（只读 + 无副作用探测）**：

```
GET  /mgw/status   (无 cookie、无 Origin) -> 200
GET  /mgw/devices  (同上)                 -> 200
POST /mgw/auth     {"enabled":true}       -> 200   ← 处理器确实执行
```

> 说明：`/mgw/auth` 我用的是 `{"enabled":true}`（当前已是 true，属幂等且不改变安全姿态）。
> **没有**发送 `enabled:false`，也没有调用 `/mgw/pair` 真去铸造配对码 ——
> 避免在本机留下未授权设备记录。`/mgw/auth` 返回 200 已足以证明「未认证即可触达状态变更路由」。

### 1.2 报告给的修法不成立（关键更正）

报告建议「把铸造配对码移到桌面助手的**回环调用**，然后把 `adminLoopbackOnly` 改回 `true`」。
**这个方案在本项目的实际部署形态下会直接破坏功能。** 两条实测证据：

**证据 A：DSH 绑定具体 LAN IP 时，回环根本没有监听。**

```
Get-NetTCPConnection -LocalPort 3095 -State Listen  ->  LocalAddress = 192.168.190.223
TcpClient 127.0.0.1:3095        ->  CONNECT FAIL
Invoke-WebRequest http://127.0.0.1:3095/mgw/status  ->  无法连接到远程服务器
```

**证据 B：DSH 拒绝 `0.0.0.0`。**

```
dsh --profile web --host 0.0.0.0 --port 39095
error: --host 0.0.0.0 is an unspecified (wildcard) address, which is not supported:
       binding every interface would expose remote code execution to the network;
       bind one concrete IPv4 or IPv6 address instead
```

所以「绑定 `0.0.0.0` 以恢复回环」这条路被上游封死了。

**证据 C：即使在本机，访问自己的 LAN IP，服务端看到的源地址也不是回环。**

用一个隔离的探针服务验证（不做任何破坏性操作）：

```
客户端 = 本机 -> http://192.168.190.223:39011/
服务端看到的 remoteAddress = 192.168.190.223
=> 插件 isLoopback() 判定为 FALSE
```

**推论**：`adminLoopbackOnly: true` 会让 `/mgw/*` 对**所有人**（包括本机桌面助手）不可达。
它不是「更安全」，而是让配对功能整体失效。审计报告关于这一点的判断是错的。

**补充复核**：也检查了「升级插件能否解决」—— 拉取 `dsh-plugin-mobile-gateway@0.11.1`（最新）到临时目录只读查看：

```
0.11.1 的 /mgw/pair 仍然是：网关开关检查 + publicUrl 校验 + createPairing()，无任何鉴权
0.11.1 仍然只有 adminLoopbackOnly / requireAuth / allowQueryToken 这几个与鉴权相关的配置
```

**结论：上游没有修复，我们无法在「不改第三方依赖」的前提下闭合根因。**

### 1.3 实际处置（最小、可回退、不默认开放）

按「不得为了兼容旧版而保留默认开放的高危接口」的要求，把默认值翻转为安全侧：

**`setup-gateway.ps1`**
- 新增 `[switch]$AllowLanManagement`。
- **默认分支写 `adminLoopbackOnly: true`**（插件的安全默认）。
- 只有显式传 `-AllowLanManagement` 才写 `false`，且会打印完整风险说明。
- 两条路径都通过 `$adminLoopback` 变量写入 YAML，不再硬编码。

**`docs/mobile-gateway.md`**
- 新增「先说清楚这个安全取舍」小节，给出真实取舍表（回环不可用 → 只有两个选项）。
- 明确写出「`/mgw/pair` 无鉴权 → 同网段可铸造配对码 → 配对即完整远程控制权」，并标注这是插件侧缺口。
- 配置示例里的 `adminLoopbackOnly: false` 加上 `⚠️` 与指向该小节的说明。

**行为变化（用户可感知）**：
默认执行 `setup-gateway.ps1` 后，手机端「审批通道自动配对」会失败（因为 `/mgw/*` 不可达）。
脚本会明确提示「需要手机审批时重跑 `-AllowLanManagement`」。这是**有意的 fail-closed 默认** —— 宁可让用户显式做一次风险确认，也不让「装个插件 = 开放远程控制面」成为默认结果。

### 1.4 修复前后的安全边界

| 维度 | 修复前 | 修复后 |
|---|---|---|
| 默认配置 | `adminLoopbackOnly: false` → `/mgw/*` 同网段可达、`/mgw/pair` 无鉴权 | `adminLoopbackOnly: true` → `/mgw/*` 不可达；需显式开关才恢复 |
| 未授权铸造配对码 | 默认即可能（同网段任一设备） | 默认不可能；开启时用户已知情 |
| 手机审批 | 开箱可用 | 默认不可用，需 `-AllowLanManagement`（有风险提示） |
| 已配对设备连接 | 正常 | **不受影响**（见下） |

**为什么已配对设备不受影响**：WS 升级路径 `handleMobileUpgrade`（插件 `2888-2918`）**完全不检查 `adminLoopbackOnly`**，只校验 `(requireAuth || transport.lan) && !device`。
实测配置里 `requireAuth: true` 保持原样未被修改，所以已有配对凭据的手机仍能连。**这正是「不削弱设备绑定与审批机制」的落实。**

### 1.5 未完成 / 剩余风险

- ⚠️ **根因未闭合**：一旦用户传 `-AllowLanManagement`，`/mgw/pair` 仍然无鉴权。这**必须由上游修**（建议：`/mgw/pair` 要求与 `/mgw/*` 其它管理路由同等凭据，或增加「本机确认」二次确认）。
- ⚠️ 无法在本仓库内实现「桌面助手经回环铸造配对码」——回环不可用（§1.2）。若上游将来支持 loopback 绑定或给 `/mgw/pair` 加认证，应把默认值改回可用状态。
- 📱 **需要真实手机验证**：`-AllowLanManagement` 路径下配对 + 审批是否端到端可用（见 §6）。

---

## 2. P1-1 —— APK 更新校验与正式签名

### 2.1 复核结论：成立，且比报告描述更严重

**用真实 APK 的证书复核（不是只看仓库里有没有 keystore）**：

```
apksigner verify --print-certs

_test-artifacts/TEST-app-release-vc16200-v0.16.2-debugsigned.apk
  Signer #1 certificate DN: CN=Android Debug, OU=Android, O=Unknown, ...
  SHA-256: fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c

_test-artifacts/OLD-app-release-vc1-v0.16.x-2026-10-22.apk
  Signer #1 certificate DN: CN=Android Debug, ...
  SHA-256: fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

仓库内 keystore 的指纹：

```
keytool -list -v -keystore dsh-mobile/android/app/debug.keystore -storepass <redacted>
  SHA256: FA:C6:17:45:DC:09:03:78:...:3B:9C
```

**三者一致**：两个已发布的 APK 都用 **AOSP 公共 debug 证书**签名，而该证书的私钥就在仓库里（`.gitignore:43-44` 用 `*.keystore` + `!dsh-mobile/android/app/debug.keystore` 显式放行）。

**更新完整性**：`updater.ts` 原来只比文件大小（`isComplete()`，`:77-86`），下载后再比一次大小（`:144-147`）。
CI 确实生成并发布 `SHA256SUMS.txt`（`android.yml:385`），但**客户端从不读取它**（全仓库 grep `SHA256SUMS` 于 `src/` 无命中）。

### 2.2 实际修改

**(a) 新增 `dsh-mobile/src/core/update-integrity.ts`（纯逻辑，可单测）**

- `parseSumsFile(text, apkFileName)`：解析 `sha256sum` 标准输出，容忍 CRLF / 注释 / `./` 前缀 / 目录前缀；文件名不匹配或哈希位数不足一律返回 `undefined`。
- `resolveExpectedHash({sumsText, notesHash, apkFileName})`：优先 `SHA256SUMS.txt`（独立文件锚点），退到 release body 内联哈希；**两者都没有时返回 `undefined`**（调用方必须拒绝安装，不得跳过）。
- `hashMatches(actual, expected)`：只接受 64 位 hex，任何异常输入判为不匹配（fail-closed）。
- `fileNameOfUrl(url)`：从下载 URL 取文件名（忽略 query）。

**(b) `updater.ts`**

- `ReleaseInfo` 增加 `sumsUrl` / `sha256FromNotes`；`checkForUpdate()` 从 release 资产里找 `SHA256SUMS.txt`，并从 body 抽取 `SHA-256: <64hex>`。
- 新增 `verifyApkIntegrity()`：拉 sums → 解析 → 算原生 SHA-256（`blob-util` 的 `fs.hash(path,'sha256')`，不把 APK 读进 JS 内存）→ 比对。
- `downloadAndInstall()` 在**进入系统安装器之前**调用校验；失败则 `unlink` + 抛错（缓存命中路径同样经过这段）。

**(c) `dsh-mobile/android/app/build.gradle`**

- 删除 `signingConfig ... ? signingConfigs.release : signingConfigs.debug` 这行静默回退。
- release 变体缺 `DSH_STORE_FILE` 时 **`throw new GradleException(...)`**，错误信息说明如何补参数。
- 保留显式逃生口 `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true`（默认 false，且会 `logger.warn`），仅供本机冒烟构建，产物不可发布。

**(d) `.github/workflows/android.yml`**

- Gate 4 的证书指纹比对，原来在 `EXPECTED_CERT_SHA256` 未配置时只 `::warning::` 然后**继续发布**；改为 `::error::` + `exit 1`。
- 理由：门禁必须默认开启。一次配错证书的发布，后果是所有老用户装不上后续版本（签名不一致必须卸载重装）。

### 2.3 信任锚的诚实说明

这是本次整改最需要说清楚的一点，我**没有**把哈希包装成完整方案：

**能防**：传输损坏、单个 APK 被替换（sums/body 未被一起替换）、大小相同但内容不同的替换（旧实现能过）。

**不能防**：GitHub Release 整体被接管（哈希与 APK 同渠道，攻击者可一起换）。
**真正的信任锚必须是 Android 的 APK 签名校验，且正式包必须用非公开密钥。** 这正是本次改动的另一半：
- gradle 硬失败 → 不可能再产出 debug 签名的「正式包」；
- CI 指纹门禁硬失败 → 配错证书发不出去。

只要正式包改用私有 keystore 签名，Android 就会拒绝任何非该证书的更新 —— 那时哈希校验只是纵深的一层。

### 2.4 修复前后的安全边界

| 维度 | 修复前 | 修复后 |
|---|---|---|
| 更新包完整性 | 只比大小 | SHA-256 比对，不匹配即删文件 + 拒绝安装 |
| 拿不到期望哈希 | 等于不校验 | **拒绝安装**（不做降级） |
| `assembleRelease` 缺签名材料 | 静默用 debug 签名，产出可发布样子的包 | 构建失败（除非显式冒烟开关） |
| CI 指纹配置缺失 | warning，照常发布 | 硬失败 |

### 2.5 剩余风险

- 🔴 **存量用户迁移问题（最重要）**：历史上约 10 个正式版本都由公开 debug 证书签名。切换到私有 keystore 后，**老用户无法覆盖升级**，必须卸载重装（聊天记录/配对会丢）。
  需要在发布说明里提前告知，并考虑一个过渡版本做「引导用户主动卸载重装」的解释页。**此项未实现，需产品决策。**
- 🟡 哈希与 APK 同渠道，无法抵御 Release 整体被接管（需签名兜底，见 2.3）。
- 🟡 `EXPECTED_CERT_SHA256` 目前仓库里**未配置**。改完后 release job 会**直接失败**——这是预期行为，但**发布前必须去 Settings → Variables 配好**，否则发不出版本。

---

## 3. P1-2 —— 隧道控制服务 Token 暴露与 CORS

### 3.1 复核结论：成立

`dsh-plugin-connect/tunnel-service.mjs`（绑 `127.0.0.1:3199`，绑定本身正确）：

- 原 `ALLOWED_ORIGIN`（`:70-71`）放行 `127.0.0.1|localhost|[::1]|10.x|172.x|192.168.x` 的**任意** origin；
- `corsHeaders()` 原样回显该 origin（`:77-85`）；
- `GET /tunnel/status` 返回 `token`、`lanUrl`（含 `?token=`）、`pairUrl`（含 `?token=`）（`:225-237`）；
- 拒绝逻辑是 `if (origin && !ALLOWED_ORIGIN.test(origin))`（`:274`）—— 无 Origin 的脚本直接放行（设计如此，因为要支持本机进程）。

**风险**：同网段任意网页可 `fetch('http://127.0.0.1:3199/tunnel/status')` 读到 token；
且 `POST /tunnel/stop` 属「简单请求」（不设自定义头、不触发预检），浏览器会直接发出 → **CSRF**。

### 3.2 实际修改

`dsh-plugin-connect/tunnel-service.mjs`

- 删除「整段私网」正则。
- 新增 `allowedOrigins()`：只包含 `http://127.0.0.1:<DSH_PORT>`、`http://localhost:<DSH_PORT>`、`http://[::1]:<DSH_PORT>`，外加 `pairing.json` 记录的这台机器地址与当前网卡地址（**都必须配 DSH 端口**）。
- 新增 `isAllowedOrigin(origin)`；`corsHeaders()` 改用它，并补 `Vary: Origin`。
- **顺序调整（关键）**：origin 拒绝现在发生在 `OPTIONS` 之前、在 `new URL(...)` 与任何动作之前。原来是先处理 OPTIONS 再校验，跨站简单请求仍可能被处理。

### 3.3 修复前后的安全边界

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `http://192.168.1.99:*` 读 `/tunnel/status` | **200 + 回显该 origin + 返回 token** | **403** |
| `http://10.0.0.55:*` / `http://172.16.5.5:*` | **200** | **403** |
| `https://evil.example.com` | 403（原本就对） | 403 |
| DSH 自身页面（`127.0.0.1:<DSH_PORT>`） | 200 | 200（功能不退化） |
| 无 Origin 的本机进程 | 200 | 200（桌面助手/插件不受影响） |
| 跨站 `POST /tunnel/stop` | **会被执行** | **403，拒绝先于动作** |

### 3.4 剩余风险

- 🟡 `/tunnel/status` 仍然返回 `token` 字段。当前的防线是 CORS gate（已验证有效）。**未移除该字段**，因为网页插件自身依赖它渲染二维码；移除需要同时改插件前端，超出「最小修复」范围。建议后续单独处理（或让插件自己从 `pairing.json` 读）。
- 🟡 无 Origin 的本机进程仍可读写。这是设计前提（服务只绑回环），但意味着**同机其它用户进程**可以驱动它。

---

## 4. P1-4 —— 明文 HTTP 安全限制覆盖不足

### 4.1 复核结论：成立

`checkBaseUrlSecurity()` 原本只有两个调用点：`transport/index.ts:174`（`loginWithToken`）与 `PairScreen.tsx:104`。
以下全部未校验：`DshConnection.call()`（所有 HTTP RPC，带 `Cookie`）、`ensureSocket()`（会话流 WS）、`ApprovalGateway.requestPairingCode()`（`credentials:'include'`）、`deviceAuth.*`、`serverIdentity.*`、`UploadApi.uploadBinary()`（带 Cookie）、`fileUrl.fetchRemoteFile()`（带 Cookie）。
另：`App.tsx` 从 `@dsh/baseUrl` 恢复地址时不重新校验。

### 4.2 实际修改

- **`net-security.ts`** 新增 `assertSecureUrl(url, what)`：不合格直接抛错，请求根本不发。
- **`transport/index.ts`**：`DshConnection` 构造期调用 `assertSecureUrl(this.baseUrl, '连接地址')`。
  选这里是因为连接对象是所有带凭据请求的**唯一来源**（RPC / WS / 上传 / 下载都从它拿 baseUrl），在入口挡一次比在每个调用点重复挡可靠。
- **`approvalGateway.ts`**：构造期 `assertSecureUrl(baseUrl, '网关地址')`。
- **`rpc/upload.ts`**：`uploadBinary()` 内单独校验（它直接走 blob-util，不经过 `conn.call`）。
- **`fileUrl.ts`**：`fetchRemoteFile()` 内单独校验（同上）。
- **`App.tsx`**：恢复 `@dsh/baseUrl` 时用 `checkBaseUrlSecurity()` 复校验；不安全则不恢复地址、**不自动登录**，并通过 `secureStorageError` 给出明确提示。

### 4.3 修复前后的安全边界

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `http://` 公网地址建连接 | 建得出来；只有 `loginWithToken` 会拦 | **构造即抛错**，任何后续请求都发不出 |
| 已有 cookie 直接发 RPC（跳过 login） | **绕过校验** | 不可能（对象建不出来） |
| 上传 / 文件下载（各自裸 fetch） | 无校验 | 各自有出口校验 |
| 从存储恢复的公网 `http://` 地址 | 直接使用 | 拒绝 + 提示重新扫码 |
| Tailscale CGNAT（100.64/10）、私网、localhost、https | 允许 | **仍允许**（功能不退化，测试覆盖） |

### 4.4 剩余风险

- 🟡 业务层仍有若干 `makeRpcError`/`classifyError` 的双分类器不一致（报告 P2-1），本次未动（不属于七项范围）。

---

## 5. P1-10 / P2-13 / P2-15 —— 脚本加固

### 5.1 P1-10：`doctor.ps1` 输出真实 token（成立）

原 `:164` / `:176` / `:201` 直接打印 `$j.url`，而 `pairing.json.url` / `tunnel.json.url` 形如
`http://<ip>:3095/?token=<43 字符>`。该脚本的定位就是「把状态贴给别人看」。

**修改**：新增 `Redact-Url()`（查询参数 `token|key|secret|password|auth|code` → `***`，外加 43+ 位 base64url 兜底），三处输出全部套用；配对地址后补一行说明。

**实跑验证**（真实环境）：

```
[OK]  pairing.json  http://192.168.190.223:3095/?token=***
[OK]  tunnel.json   https://<redacted>.trycloudflare.com
     配对地址：http://192.168.190.223:3095/?token=***
     （token 已打码；完整地址见 start-dsh-web.ps1 的输出或 pairing.json）
```

断言：输出中无任何 43+ 位 token 形态字符串、`token=` 后仅 `***`。

### 5.2 P2-13：`tunnel.json` 权限未收紧（成立）

实测 ACL：

```
pairing.json : inherited=False  (SYSTEM / Administrators / 当前用户)
tunnel.json  : inherited=True   ← 含 XIS\CodexSandboxUsers: ReadAndExecute
```

`tunnel.json` 含 `token` 与带 token 的 `pairUrl` —— 和 `pairing.json` 是同一把钥匙。

**修改**：`start-tunnel.ps1` 新增 `Protect-StateFile($path)`（断开继承 → 只留 当前用户/SYSTEM/Administrators；失败仅提示不中断，兼容 FAT32/网络盘），在 `tunnel.json` 写入后与 `pairing.json` 重写后各调用一次。

### 5.3 P2-15：隧道脚本继承危险权限模式（成立）

原 `:386`：`$env:DSH_PERMISSION_MODE = if ($env:DSH_PERMISSION_MODE) { 沿用它 } else { 'workspace-write' }`。
只要用户曾在某处导出 `danger-full-access`，之后每次走隧道启动都会**静默关闭审批** —— 而隧道意味着公网可达，是最不该关审批的场景。

**修改**：新增受约束参数 `[ValidateSet('read-only','workspace-write','danger-full-access')] [string]$PermissionMode = 'workspace-write'`，并改为 `$env:DSH_PERMISSION_MODE = $PermissionMode`（**不再继承**）。选 `danger-full-access` 时打印显著警告。

### 5.4 修复前后边界

| 项 | 修复前 | 修复后 |
|---|---|---|
| `doctor.ps1` 输出 | 含真实 token | 全部打码 |
| `tunnel.json` ACL | 继承，沙箱账号可读 | 仅 当前用户/SYSTEM/Administrators |
| 隧道启动权限模式 | 继承环境变量（可能静默 danger-full-access） | 显式参数，默认 workspace-write |

---

## 6. 测试

### 6.1 新增回归测试（76 条断言，全部针对失败场景）

| 文件 | 断言 | 覆盖 |
|---|---|---|
| `dsh-mobile/tests/security-remediation-spec.mjs` | 58 | P0-2 默认安全、P1-1 哈希解析与 fail-closed、gradle 硬失败、CI 门禁、P1-4 各校验点、P2-13/P2-15 脚本 |
| `dsh-mobile/tests/doctor-redaction-spec.mjs` | 8 | P1-10：静态结构 + **实跑 `doctor.ps1`** 验证输出无 token |
| `dsh-mobile/tests/tunnel-cors-spec.mjs` | 10 | P1-2：**起真实服务进程**（隔离端口 + 临时状态目录），打 4 类 origin |

`tunnel-cors-spec.mjs` 的关键断言（旧代码会失败）：

```
OK  私网 origin http://192.168.1.99:8080 被 403（旧版会放行）
OK  私网 origin http://10.0.0.55:3000    被 403（旧版会放行）
OK  私网 origin http://172.16.5.5:8000   被 403（旧版会放行）
OK  DSH 自身 origin（127.0.0.1:DSH_PORT）被允许
OK  无 Origin 的本机进程请求被允许
OK  跨站 POST /tunnel/stop 被 403（CSRF 挡住）
```

三个 spec 均已接入 `npm test`（`test:security` / `test:doctorRedact` / `test:tunnelCors`）。

### 6.2 自动化结果

```
单元测试   npm test                 846 通过 / 0 失败   (exit 0)
集成测试   npm run test:integration  61 通过 / 0 失败   (exit 0)
类型检查   npx tsc --noEmit          通过              (exit 0)
```

基线对照：整改前 770 条，新增 76 条 → 846 条。**没有任何测试被删除或放宽。**

### 6.3 为适配新行为而修改的两处既有测试（说明原因）

| 测试 | 原因 |
|---|---|
| `tests/integration-product.mjs`「公网 http 地址被拦住」 | 校验点从 `loginWithToken` 前移到构造期，`new DshConnection(...)` 即抛错。断言改为「两个拦截点都接受、但必须被拦住」——安全属性未削弱。 |
| `tests/login-intent-spec.mjs`「凭据不存在时不自动登录」 | 地址变量因 P1-4 改名（`usableBase` 表示「校验通过可用」）。断言改为同时要求 地址 && cookie && 意图，并额外验证 `setAuthed(true)` 位于条件分支内 —— **比原来更严格**。 |

### 6.4 需要真实设备 / Windows 环境验证的事项（本机无法完成）

1. **P0-2 手机端配对与审批**（`-AllowLanManagement` 路径）：需真实 Android 手机扫码 → 审批卡片可点 → 决定能回传。
2. **P0-2 未授权拒绝**：需第二台设备/另一台手机尝试 `POST /mgw/pair`，确认在 `adminLoopbackOnly: true` 下为 403。
3. **P1-1 更新流程**：需一次真实 Release（含 `SHA256SUMS.txt`）验证校验通过；再用篡改包验证被拒。
4. **P1-1 签名迁移**：需 Windows + Android SDK 手工跑 `assembleRelease`（带正式 keystore）并用 `apksigner verify --print-certs` 核对指纹 ≠ `fac61745…`。
5. **P2-13 ACL 生效**：需 Windows 上重跑 `start-tunnel.ps1` 后 `Get-Acl tunnel.json` 确认 `inherited=False`。
6. **P1-2 桌面助手面板**：需启动 Electron 应用确认二维码 / 隧道按钮仍正常（本机未运行 GUI）。

---

## 7. 是否满足正式发布的安全前置条件

**否。** 三项硬阻断：

| # | 阻断项 | 说明 |
|---|---|---|
| 1 | **正式签名未落地** | 当前仍用公开 debug 证书。必须生成私有 keystore、配 `KEYSTORE_*` Secrets 与 `EXPECTED_CERT_SHA256` 变量。在配置之前，CI 的 release job 会**直接失败**（这是改对后的预期行为）。 |
| 2 | **P0-2 根因在上游** | `/mgw/pair` 无鉴权仍存在。我们只能做到「默认不开放」。若发布说明要宣称「手机审批开箱可用」，就必须让用户显式开启一个已知风险面 —— 需要产品层面决定是否接受。 |
| 3 | **真实设备验收未做** | 见 §6.4 六项；其中 1、2 直接关系安全结论。 |

**建议的发布路径**：
1. 先完成 P1-1 的签名迁移（含老用户重装引导的产品决策）；
2. 在发布说明中如实披露 P0-2 的取舍（默认关闭 LAN 管理面）；
3. 完成 §6.4 的真实设备验收；
4. 之后再考虑「连接可靠性 / UI 性能」等下一批工作。

---

## 8. 变更文件清单

**修改（17）**
```
.github/workflows/android.yml          Gate 4 指纹校验改为硬失败
docs/mobile-gateway.md                 P0-2 取舍说明 + 配置示例
doctor.ps1                             P1-10 Redact-Url + 三处输出脱敏
dsh-mobile/android/app/build.gradle    P1-1 release 缺签名即失败
dsh-mobile/package.json                接入三个新 spec
dsh-mobile/src/App.tsx                 P1-4 恢复地址时复校验
dsh-mobile/src/core/approvalGateway.ts P1-4 构造期校验
dsh-mobile/src/core/fileUrl.ts         P1-4 出口校验
dsh-mobile/src/core/net-security.ts    P1-4 assertSecureUrl
dsh-mobile/src/core/rpc/upload.ts      P1-4 出口校验
dsh-mobile/src/core/transport/index.ts P1-4 构造期校验
dsh-mobile/src/core/updater.ts         P1-1 verifyApkIntegrity 接入
dsh-mobile/tests/integration-product.mjs  适配构造期校验
dsh-mobile/tests/login-intent-spec.mjs    适配变量改名（更严格）
dsh-plugin-connect/tunnel-service.mjs  P1-2 CORS 收紧 + 顺序修正
setup-gateway.ps1                       P0-2 默认 fail-closed + 显式开关
start-tunnel.ps1                       P2-13 Protect-StateFile + P2-15 显式权限模式
```

**新增（4）**
```
dsh-mobile/src/core/update-integrity.ts        纯逻辑（哈希解析 / 比较）
dsh-mobile/tests/security-remediation-spec.mjs 58 断言
dsh-mobile/tests/doctor-redaction-spec.mjs      8 断言
dsh-mobile/tests/tunnel-cors-spec.mjs          10 断言
```

未修改任何第三方依赖（`node_modules` / 插件源码均未改动）。
未提交、未推送、未发布、未上传任何签名材料。

---

## 9. 剩余风险汇总

| 级别 | 风险 | 归属 | 建议 |
|---|---|---|---|
| 🔴 | 存量 debug 签名用户无法覆盖升级 | 发布流程 | 需产品决策：发布说明 + 引导重装 |
| 🔴 | `/mgw/pair` 无鉴权（上游） | 第三方插件 | 向上游提 issue；或自建 fork 加认证 |
| 🟡 | `/tunnel/status` 仍返回 token 字段 | 本仓库 | 后续单独改造（需同步改插件前端） |
| 🟡 | 哈希校验与 APK 同渠道 | 本仓库 | 由私有签名兜底（阻断项 1 解决后自动消解） |
| 🟡 | 同机其它用户进程可驱动 tunnel-service | 本仓库 | 属于「回环 = 本机可信」的既有前提 |
| 🟡 | 错误分类器 403 策略不一致 | 本仓库 | 报告 P2-1，不在本轮范围 |
