# DSH Outpost 正式签名验证与发布前最终验收

> 更新时间：2026-10-27（**第七轮**修订：定点修复 5 项）
> 依据：最新实际源码 + 真实命令输出
> **未推送、未创建 Tag、未创建 Release、未上传任何签名材料。**

---

## 0. 结论

# `BLOCKED_BY_RELEASE_ISSUES`

第七轮定点修复了 5 项（总体判定不全、v2 签名校验失效、公开仓库 Artifact 风险、
高 versionCode 副作用未记录、真机验收说明混淆两种错误来源）。

累计：第六轮修复 4 个工作流缺陷 + 2 个额外发现的可靠性/CI 问题。
但签名验证仍只能在 GitHub Actions 执行 —— 代码尚未推送，本地没有也无法取得正式签名材料。

---

## 0.1 第七轮修复清单（本次）

| # | 问题 | 严重性 | 状态 |
|---|---|---|---|
| 1 | Summary 总体结论只看 `cert`+`build`，其余门禁不参与 | 🔴 门禁形同虚设 | ✅ 已修复 |
| 2 | v2 用 `grep -q 'Verified using v2'`，会误匹配 `: false` 行 | 🔴 **门禁完全失效** | ✅ 已修复 |
| 3 | 公开仓库上传真实签名 APK，仅靠文件名警告 | 🔴 权限误判 | ✅ 已修复 |
| 4 | 高 versionCode 会阻止后续正式版覆盖安装，未记录 | 🟡 会让正式版装不上 | ✅ 已写入报告 §9.4 |
| 5 | 真机验收把「系统安装器报错」与「App 内 SignatureMismatchError」混为一谈 | 🟡 会误判迁移失败 | ✅ 已澄清 §9.2 |

### 问题 2 的实证（最严重的一项）

`apksigner verify --verbose` 对**每个**方案都打印一行，没签名的也是 `false`：

```
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true    ← 已签名
Verified using v3 scheme (APK Signature Scheme v3): false
```

用真实 apksigner 输出 + 一段等价 shell 逻辑对比如下：

| 输入 | 旧判定 `grep -q 'Verified using v2'` | 新判定 `^...: true$` |
|---|---|---|
| 已签名（v2: true） | PASS ✅ | PASS ✅ |
| **未签名（v2: false）** | **PASS ❌ 误判** | **FAIL ✅ 正确** |

也就是说，**旧写法对「完全没有 v2 签名」的包也会放行**。
已改为锚定 `^Verified using v2 scheme .*: true$`，v3 用 `case` 区分 `true`/`false`
并写入 step output 供 Summary 消费。

### 问题 3 的处理

GitHub Actions Artifact 的访问粒度是**整个仓库**，没有单 Artifact 的 ACL。
所以新增 `Resolve repository visibility` 步骤读 `github.event.repository.private`：

| 仓库可见性 | `can_upload` | 行为 |
|---|---|---|
| 私有（`true`） | `true` | 允许上传，仅协作者可见 |
| 公开（`false`） | `false` | **拒绝上传**，Summary 给出本地构建指引 |
| 无法判定 | `false` | **同样拒绝**（fail-closed） |

文件名 `NOT-FOR-RELEASE` 前缀明确降级为「降低误用概率的提示」，
**不再承担任何权限隔离职责** —— 报告与工作流注释都写清了这一点。

---

## 1. 第六轮修复的问题（逐项复核后）

### 1.1 工作流用 Node 20 却调用 Node 22.6+ 的 `--experimental-strip-types` ✅ 已修复

**复核结论：问题属实，且比审查指出的更深。**

原实现的两处内联脚本用 `node --experimental-strip-types` 加载 `.ts`。
本项目实际约束：

| 证据 | 值 |
|---|---|
| `dsh-mobile/package.json` `engines.node` | `>=20` |
| `android.yml` 三个 job 的 `node-version` | 全部 `20` |
| `package.json` 里用 `tsx` 的脚本数 | 45 个 |

**修复**：把内联脚本抽成 `dsh-mobile/scripts/verify-sums-integration.mjs`，用仓库标准方式 `npx tsx` 运行。
好处：本地与 CI 跑同一份代码、可独立回归、不再是易错的 shell 内联字符串。

**顺带查出一个更严重的同类问题（审查未提）**：
我自己在前几轮写的三个测试 —— `security-remediation-spec`、`ws-disconnect-spec`、`update-integrity-spec` ——
用**动态 `import()`** 加载 `.ts`，却挂在 `node` 下运行。

它们在本机 Node 24 能跑，但 **CI 的 Node 20 会直接 `ERR_UNKNOWN_FILE_EXTENSION` 挂掉**。
而仓库里本来就有守卫 `runtime-compat-spec.mjs` —— 它的正则**只查静态 `from '...ts'`**，漏掉了动态 `import()`，所以没拦住。

**已修**：三个脚本改用 `tsx`；守卫正则补齐动态 `import()` 的检测。
**已反证**：临时把 `test:integrity` 改回 `node`，守卫确实报 FAIL 并指出「动态 import()」；恢复后 11/11 通过。

### 1.2 工作目录为 `dsh-mobile` 时读 `../../.github/release-floor.json` 路径错误 ✅ 已修复

**复核结论：问题属实。**

```
cwd = dsh-mobile
  ../.github/release-floor.json   -> 存在 ✓
  ../../.github/release-floor.json -> 不存在 ✗  ← 原实现用的这个
```

**修复**：不再自己拼相对路径，改为复用仓库自己的 `scripts/version-code.mjs` 的 `readFloor()` ——
它按 `__dirname`（= `dsh-mobile/scripts`）解析，**与 cwd 无关**，且与正式发布流程读的是**同一份逻辑**，不会两边分叉。

同时加了防御：读到空值或非正整数立刻 `exit 1`，绝不静默用默认值。

**可执行验证**：
```
$ cd dsh-mobile && node -e "import('./scripts/version-code.mjs').then(m=>console.log(m.readFloor().minVersionCode))"
16200
```
合成版本：`16200 + 900000 + run` = 916242（> 水位线 16200 ✓）。

### 1.3 `if: always()` 的 Summary 无条件显示成功 ✅ 已修复

**复核结论：问题属实，且是最危险的一类缺陷 —— 失败时输出虚假成功。**

原 Summary 硬编码了 `| 与 EXPECTED_CERT_SHA256 一致 | 是 |` 和 `| 是公开 debug 证书 | 否（已排除） |`。
由于是 `if: always()`，**即使证书验证步骤失败，摘要仍会显示"一致 / 已排除"**。

**修复**：每一项都读对应步骤的 `steps.<id>.outcome`，映射成三态：

| `outcome` | 显示 |
|---|---|
| `success` | ✅ PASS |
| `failure` | ❌ FAIL |
| `skipped` / `cancelled` / `''` | ⏭️ NOT RUN（附原因） |

证书指纹/DN 在证书步骤未成功时显示「未判定」而不是编造结论。
总体结论：`S_CERT` 或 `S_BUILD` 任一非 success 即显示 **「验证失败 — 不可据此发布」**。

并新增 `Enforce gate result` 步骤：`if: always()` 跑，检查 6 个关键门禁，
任一非 success 就 `::error::` + `exit 1` —— 保证 **job 真的变红**，不会因为某步被跳过而蒙混成绿色。

为此给 7 个步骤补了 `id`（`precheck` / `keystore` / `build` / `pkg` / `sums` / `debugbuild` / `negative`）。

### 1.4 Artifact 未包含正式签名测试 APK ✅ 已按你的选择实现

**按你的选择**：「上传但强标记为非正式」。

实现的**四层防误用标记**：

| 层 | 内容 |
|---|---|
| 文件名 | `NOT-FOR-RELEASE-dsh-outpost-verify-<version>.apk` |
| versionName | 合成值 `0.0.0-verify.<run>`，不含任何正式版本号 |
| versionCode | `水位线 + 900000 + run`，远高于正式序列，不可能与正式号相同 |
| Artifact 名 | `NOT-FOR-RELEASE-signing-verify-apk`，仅保留 **3 天** |

**访问权限**：Actions Artifact 对拥有仓库读权限者可见。
⚠️ **若仓库是 public，此 APK 会对外可见** —— 报告里已明确提示，公开仓库建议改用管理员本地构建。

**结构上不可能变成正式版**：该工作流 `permissions: contents: read`，没有 `contents: write` 就**物理上无法**创建 Release。

同时保留 `signing-verification-evidence`（校验证据 + 明文哈希，1 天过期）。

---

## 2. 重新核对可靠性

### 2.1 P0-1：只做到「快速失败」，**没有**自动重连与会话恢复

**如实标记：未完整恢复。**

| 能力 | 状态 | 证据 |
|---|---|---|
| 断线后活跃流立刻失败（不永久挂起） | ✅ **已实现** | `transport/index.ts` 的 `failAllStreams` + `close`/`error` 监听 |
| 自动重连 | ❌ **未实现** | `transport` 里无 `reconnect` / `backoff` 相关代码 |
| 会话/流续传（seq 断点恢复） | ❌ **未实现** | 无 `resumeFrom` / `sinceSeq` / `lastEventSeq` |

**当前真实行为**：socket 断开 → 所有活跃流抛错 → `store.pump` 捕获 → 聊天页显示可读错误并 `loading: false`。
**用户需要手动重进会话**。这与「自动恢复」是两回事，不得混淆。

为什么本轮不实现：自动重连涉及退避策略、重复事件去重、seq 协议对齐 ——
属于设计级改动，不是「最小修复」。按你的要求（仅修复能通过源码证明的发布阻断问题、避免不必要的重构），
**只记录状态，不擅自扩大改动**。

### 2.2 P0-2：管理接口认证补丁的完整性门禁 —— 发现并修复一个真实缺口

**审查方向正确，确实有缺口。**

复核发现：补丁检查**只存在于 `setup-gateway.ps1`**，而日常启动走的是 `start-dsh-web.ps1` —— 后者**完全不检查**。

真实风险链：
```
用户装好一切（补丁已打、adminLoopbackOnly=false）
  → 上游插件升级 / npm install
  → 补丁被抹掉
  → 用户只是正常重启 DSH
  → 配置里 adminLoopbackOnly 仍是 false
  → /mgw/* 管理接口无认证地暴露在局域网上，没人察觉
```

**修复**：在 `start-dsh-web.ps1` 加完整性门禁，**默认 fail-closed**（拒绝启动），
只有在插件未安装、或显式传 `-SkipGatewayPatchCheck` 时才放行。
失败时打印可直接执行的修复命令。

修复过程中还避开一个 PowerShell 坑：脚本全局设了 `$ErrorActionPreference='Stop'`，
node 往 stderr 写东西会被当成终止错误抛出，导致门禁的 `if` 根本执行不到。
已改为临时 `Continue` + 用 `$LASTEXITCODE` 判断。

**行为已实测**：

| 场景 | 结果 |
|---|---|
| 补丁未应用、正常启动 | ❌ 拒绝启动，exit≠0，输出含「认证补丁未生效」+ 修复命令 |
| 补丁未应用 + `-SkipGatewayPatchCheck` | ✅ 跳过门禁继续 |
| 插件未安装 | ✅ 不检查（不影响没用网关的用户） |

**三个入口的覆盖情况**：

| 入口 | 是否执行门禁 |
|---|---|
| `setup-gateway.ps1`（安装/配置） | ✅ check → 按需 apply → 失败则拒绝写配置 |
| `start-dsh-web.ps1`（日常启动） | ✅ **本轮新增**，fail-closed |
| `apply.mjs --check`（手动/脚本） | ✅ 退出码 1 = 未应用 |

**插件升级后的行为**：版本不在白名单 → 拒绝打补丁、打印实际版本与文件 SHA-256、**不写半成品**。
启动门禁会把这种情况变成「无法启动 + 明确指引」，而不是「静默裸奔」。

---

## 3. 已完成的本地验证

| 项 | 结果 | 备注 |
|---|---|---|
| 单元测试 `npm test` | ✅ **996 通过 / 0 失败** | 退出码 0 |
| 集成测试 `npm run test:integration` | ✅ **61 通过 / 0 失败** | 起真实 HTTP+WS 假 DSH |
| TypeScript `tsc --noEmit` | ✅ 通过 | 退出码 0 |
| Gradle `assembleDebug` | ✅ 成功 | |
| Gradle `assembleRelease`（无签名） | ✅ 正确失败 | BUILD FAILED |
| Gradle `assembleRelease`（冒烟开关） | ✅ 成功 + 警告 | |
| Windows 真实打包 | ✅ 成功 | 产物含 `start-tunnel.ps1` |
| 网关认证门禁（启动路径） | ✅ **19 断言** | 含真实行为测试 |
| WS 断线快速失败 | ✅ **10 断言** | |
| 更新完整性链路 | ✅ **26 断言** | |
| 工作流 YAML 语法 | ✅ 两个文件均通过 | `yaml.safe_load` |
| 版本水位线读取 | ✅ 16200 | 用 `readFloor()` 实测 |
| 无 `--experimental-strip-types` 实际调用 | ✅ | 仅剩 2 处注释说明 |
| Node 版本一致性 | ✅ 全部 `20` | 四个位置 |
| 工作流不能建 Tag/Release | ✅ | 无 `git tag` / 无 `gh-release` / 无 `contents: write` / 无 `GITHUB_TOKEN` |
| Secrets 不回显 | ✅ | 只打印 `KEY_ALIAS` 长度；keytool 输出丢弃；`certs.txt` 只留公钥字段 |
| 暂存区无敏感材料 | ✅ | 已扫描 43 个待提交文件，无密钥/密码/大块 base64 |

**断言演进**：第一轮末 846 → 第二轮 901 → 第五轮 945 → 第六轮 964 → **第七轮 996**（+32）。

---

## 4. 尚未运行的 GitHub Actions 验证

**全部未执行。** 原因：工作流文件是新文件，且所有改动未提交；GitHub 只对已推送分支上的 `workflow_dispatch` 提供运行入口。

| 未执行项 | 为什么 |
|---|---|
| `signing-verify.yml` 实际运行 | 工作流未推送 |
| 正式签名 APK 的实际证书指纹 | 需 CI + Secrets |
| `EXPECTED_CERT_SHA256` 是否配置正确 | 本地不可见（Variable 只在 runner 内） |
| 包名/版本/签名方案的线上校验 | 同上 |
| 运行链接 | 尚未产生 |

---

## 5. 尚未执行的 Android 真机验收

全部 11 项待执行（见 §9）。本轮无法进行，原因：
1. 没有签名验证通过的 APK；
2. 本机 DSH 绑定在 `192.168.190.223`，该地址已不在任何网卡上（探测 ECONNRESET），无法联调。

---

## 6. 未关闭的可靠性问题

| 级别 | 问题 | 说明 |
|---|---|---|
| 🔴 **R1** | 正式签名未经验证 | 必须推送 + 跑 `signing-verify.yml` |
| 🔴 **R2** | 所有改动未提交 | HEAD 仍是 `f978832`；不推送则 GitHub 跑的是**旧代码**（旧的 `? release : debug` 回退、旧的 `::warning::` 跳过指纹） |
| 🔴 **R3** | 本机 DSH 不可用 | 绑定地址失效，P0-2 端到端联调阻塞 |
| 🟡 **R4** | **P0-1 无自动重连/恢复** | 断线后需用户手动重进会话。**未完整解决，只是不再假死** |
| 🟡 **R5** | 存量用户需卸载重装 | 迁移提示已实现（`SignatureMismatchError`），通知方式待产品决定 |
| 🟡 **R6** | 哈希与 APK 同渠道 | 由私有签名兜底 |
| 🟡 **R7** | 无 Origin 的本机进程可驱动 tunnel-service | 服务只绑回环，属既有前提 |
| 🟡 **R8** | 公开仓库时验收 APK 对外可见 | 见 §1.4 访问权限说明 |
| 🟡 **R9** | 补丁依赖上游锚点 | 插件升级需人工核对后更新白名单；`--check` 会失败提醒 |

---

## 7. Git 修改清单

### 7.1 第七轮改动（本次）

**新增（1）**
```
dsh-mobile/tests/signing-workflow-gates-spec.mjs   工作流门禁回归（32 断言）
```

**修改（3）**
```
.github/workflows/signing-verify.yml     总体判定覆盖全部门禁；v2/v3 按 :true 判定；
                                         新增仓库可见性门禁；APK 上传改为私有仓库限定
dsh-mobile/package.json                  接入 test:signingWf
DSH-OUTPOST-FINAL-RELEASE-ACCEPTANCE.md  §0.1 第七轮清单、§9 重写（9.0–9.4）
```

### 7.1a 第六轮改动

**新增（3）**
```
.github/workflows/signing-verify.yml              独立签名验证工作流（第六轮创建）
dsh-mobile/scripts/verify-sums-integration.mjs    更新完整性链路验证（替代内联脚本）
dsh-mobile/tests/gateway-startup-gate-spec.mjs    启动门禁回归（19 断言）
```

**修改（4）**
```
.github/workflows/signing-verify.yml   Node20/tsx、水位线路径、Summary 三态、APK 交付
start-dsh-web.ps1                      新增网关认证补丁完整性门禁 + -SkipGatewayPatchCheck
dsh-mobile/package.json                三个 spec 改 tsx、接入新测试
dsh-mobile/tests/runtime-compat-spec.mjs  守卫补齐动态 import() 检测
```

### 7.2 之前各轮尚未提交的修复（共 21 项修改 + 16 项新增）

**修改**
```
.github/workflows/android.yml                    debug 证书黑名单门禁
docs/mobile-gateway.md                           P0-2 取舍说明
doctor.ps1                                       P1-10 URL 打码
dsh-mobile/android/app/build.gradle              签名检查移到 taskGraph（修复 assembleDebug 回归）
dsh-mobile/src/App.tsx                           P1-4 savedBase 复验
dsh-mobile/src/core/approvalGateway.ts           P1-4 assertSecureUrl
dsh-mobile/src/core/fileUrl.ts                   P1-4 + 拒绝安装附件 APK
dsh-mobile/src/core/net-security.ts              P1-4 assertSecureUrl
dsh-mobile/src/core/rpc/upload.ts                P1-4
dsh-mobile/src/core/transport/index.ts           P1-4 + P0-1 断线快速失败
dsh-mobile/src/core/updater.ts                   P1-1 完整性校验 + 签名迁移提示
dsh-mobile/tests/integration-product.mjs         适配
dsh-mobile/tests/login-intent-spec.mjs           适配
dsh-outpost-desktop/electron-builder.yml         P1-11 extraResources 补 start-tunnel.ps1
dsh-outpost-desktop/src/main/main.js             P1-12 退出停隧道 + P1-11 findStartScript + mgw 带凭据
dsh-plugin-connect/client.js                     token 改从页面 URL 取
dsh-plugin-connect/tunnel-service.mjs            P1-11 findScript + 移除 status 里的 token
setup-gateway.ps1                                P0-2 强制补丁；移除 -AllowLanManagement
start-tunnel.ps1                                 P2-13 状态文件保护 + P2-15 权限模式
```

**新增**
```
patches/mobile-gateway-mgmt-auth/{patch.mjs,apply.mjs,README.md}   P0-2 受控补丁
dsh-mobile/src/core/installable.ts                                安装包判定
dsh-mobile/src/core/update-integrity.ts                           更新完整性纯逻辑
dsh-mobile/tests/security-remediation-spec.mjs                    60 断言
dsh-mobile/tests/doctor-redaction-spec.mjs                        8 断言
dsh-mobile/tests/tunnel-cors-spec.mjs                             14 断言
dsh-mobile/tests/mobile-gateway-patch-spec.mjs                    24 断言
dsh-mobile/tests/release-signing-gates-spec.mjs                   12 断言
dsh-mobile/tests/update-integrity-spec.mjs                        26 断言
dsh-mobile/tests/ws-disconnect-spec.mjs                           10 断言
dsh-mobile/tests/desktop-packaging-spec.mjs                       21 断言
4 份 Markdown 报告
```

### 7.3 安全的提交顺序

**不要 `git add -A` 盲提。** 建议分 4 批，每批提交后跑一次测试：

```bash
# 第 1 批：核心安全修复（手机端 + 网关补丁）
git add patches/ \
        dsh-mobile/src/core/installable.ts \
        dsh-mobile/src/core/update-integrity.ts \
        dsh-mobile/src/core/transport/index.ts \
        dsh-mobile/src/core/updater.ts \
        dsh-mobile/src/core/fileUrl.ts \
        dsh-mobile/src/core/net-security.ts \
        dsh-mobile/src/core/approvalGateway.ts \
        dsh-mobile/src/core/rpc/upload.ts \
        dsh-mobile/src/App.tsx \
        setup-gateway.ps1 start-dsh-web.ps1 start-tunnel.ps1 doctor.ps1
git commit -m "security: gateway mgmt auth patch + ws disconnect fail-fast"

# 第 2 批：桌面端 + 插件连接
git add dsh-outpost-desktop/ dsh-plugin-connect/ docs/mobile-gateway.md
git commit -m "fix(desktop): quit-time tunnel cleanup + packaged script resolution"

# 第 3 批：构建与签名门禁 + 测试
git add dsh-mobile/android/app/build.gradle \
        dsh-mobile/package.json \
        dsh-mobile/tests/ dsh-mobile/scripts/
git commit -m "build: enforce release signing + add regression specs"

# 第 4 批：CI 工作流与报告
git add .github/workflows/ *.md docs/
git commit -m "ci: add signing verification workflow + acceptance reports"
```

**每批提交前确认**：
```bash
git diff --cached --name-only          # 只应包含本批文件
git diff --cached | Select-String -Pattern 'PRIVATE KEY|storepass \w|keypass \w'
```
第 4 批含 `*.md`，提交前请再次确认报告中没有真实凭据（本轮已扫描通过）。

### 7.4 敏感材料检查结果

| 检查 | 结果 |
|---|---|
| 暂存区 | 空（未 stage 任何文件） |
| 待提交文件数 | 43 |
| keystore / jks / p12 / pfx / pem | 无 |
| `node_modules` / `release/` / `build/` / `.apk` | 无 |
| 私钥块 / 密码字面量 / 大块 base64 / GitHub token / AWS key | 无 |
| `debug.keystore` | 已在仓库中（历史既有），仅用于 debug 构建；`.gitignore` 显式放行 |

---

## 8. 推送到默认分支并运行验证

### 8.1 推送（需管理员执行，本轮未执行）

```bash
cd E:\work\dsBot
git branch --show-current        # 确认是 main
git push origin main
```

推送后确认工作流已被 GitHub 识别：
```bash
gh workflow list | grep -i signing
# 期望看到: Signing Verification (no publish)
```

### 8.2 手动运行

**Web**：`Actions` → 左侧 **Signing Verification (no publish)** → **Run workflow**
→ Branch 选 `main` → `verify_debug_too` 保持勾选 → **Run workflow**

**CLI**：
```bash
gh workflow run signing-verify.yml --ref main -f verify_debug_too=true
gh run watch
```

预计 20–30 分钟。

### 8.3 管理员应检查哪些结果

**① 页首 Summary（最重要）** —— 应看到 10 行三态表：

| 验证项 | 期望 |
|---|---|
| Secrets 齐全 | ✅ PASS |
| keystore 可解 / 别名正确 | ✅ PASS |
| 水位线可读 + 合成版本推导 | ✅ PASS |
| 正式签名 release 构建 | ✅ PASS |
| **证书身份（非 debug + 匹配 EXPECTED）** | ✅ PASS ← 关键 |
| 包名 / 版本 / 签名方案 | ✅ PASS |
| 更新完整性链路 | ✅ PASS |
| debug 构建未受影响 | ✅ PASS |
| 负向：缺签名必须被拒 | ✅ PASS |
| 真机验收包暂存 | ✅ PASS |

**总体必须是「✅ 全部通过」**。若显示「❌ 验证失败 — 不可据此发布」，下方会指出哪一项 FAIL。

**② 证书指纹** —— Summary 里「证书 SHA-256」的 64 位值必须：
- **不等于** `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`（公开 debug 证书）
- **等于** 你在 Settings → Variables 里配的 `EXPECTED_CERT_SHA256`
- DN 应是你的私有证书主题，**不是** `CN=Android Debug`

交叉核对你本地 keystore：
```bash
keytool -list -v -keystore <你的release.keystore> -alias dsh-release | grep SHA256
```

**③ 产物区** —— 应有两个 Artifact：
- `signing-verification-evidence`（1 天过期，校验证据）
- `NOT-FOR-RELEASE-signing-verify-apk`（3 天过期，**仅供真机验收**）

**④ 不应存在的东西**：Releases 页面无新条目、无新 Tag、无 `contents: write` 迹象。

**⑤ 若失败，常见原因**：
- `EXPECTED_CERT_SHA256` 与 keystore 实际指纹不一致 → 用上面命令重取
- `KEY_ALIAS` 不是 `dsh-release` → 用 `keytool -list -keystore <ks>` 查别名
- keystore base64 编码时有换行/截断 → 用 `[Convert]::ToBase64String([IO.File]::ReadAllBytes('ks'))` 重新生成

---

## 9. Android 真机验收步骤

### 9.0 前置：怎么拿到验收包

| 仓库可见性 | 验收包来源 |
|---|---|
| **私有仓库** | 工作流会上传 `NOT-FOR-RELEASE-signing-verify-apk`（仅协作者可见，3 天过期） |
| **公开仓库** | **工作流故意不上传** —— Artifact 访问粒度是整个仓库，公开仓库下任何人登录后都能下载。请按 §9.1 在本地构建 |

**为什么公开仓库不上传**：GitHub Actions Artifact 的权限模型是「仓库级」，没有单 Artifact 的访问控制。
文件名加 `NOT-FOR-RELEASE` 只是**命名提示**，不构成权限隔离 —— 拿到文件的人照样能安装、重新签名、二次分发。
工作流里的 `Resolve repository visibility` 步骤会读 `github.event.repository.private`：
只有明确为 `true` 才允许上传，公开或未知一律拒绝。

### 9.1 公开仓库：管理员本地构建验收包

在持有 keystore 的机器上（**不要把 keystore 拷到别处**）：

```powershell
# 在本机 PowerShell 里，凭据只存在于当前进程环境
cd E:\work\dsBot\dsh-mobile\android

# 版本号用合成值，避免与正式版本冲突
$env:DSH_STORE_FILE      = 'C:\path\to\your-release.keystore'
$env:DSH_STORE_PASSWORD  = '<你的 keystore 密码>'
$env:DSH_KEY_ALIAS       = 'dsh-release'
$env:DSH_KEY_PASSWORD    = '<你的 key 密码>'

.\gradlew.bat :app:assembleRelease `
  -PDSH_VERSION_NAME=0.0.0-localverify `
  -PDSH_VERSION_CODE=916242 `
  -PDSH_STORE_FILE="$env:DSH_STORE_FILE" `
  -PDSH_STORE_PASSWORD="$env:DSH_STORE_PASSWORD" `
  -PDSH_KEY_ALIAS="$env:DSH_KEY_ALIAS" `
  -PDSH_KEY_PASSWORD="$env:DSH_KEY_PASSWORD"

# 构建完立刻清掉当前进程里的密码
Remove-Item Env:DSH_STORE_PASSWORD, Env:DSH_KEY_PASSWORD
```

产物：`dsh-mobile\android\app\build\outputs\apk\release\app-release.apk`

自检证书（应与 `EXPECTED_CERT_SHA256` 一致）：
```powershell
& 'D:\Android\Sdk\build-tools\34.0.0\apksigner.bat' verify --print-certs `
  dsh-mobile\android\app\build\outputs\apk\release\app-release.apk |
  Select-String 'SHA-256|DN'
```

### 9.2 两种「装不上」的错误来源必须分清

真机验收时最容易搞混的一点：**系统安装器**和**应用内更新器**是完全不同的两条路径，报错也不同。

| | 系统安装器（文件管理器/ADB 直接装） | 应用内更新器（App 里点「检查更新」） |
|---|---|---|
| 触发方式 | 手动点 APK 文件安装 | App 调 `actionViewIntent` 拉起安装 |
| 签名不一致时的报错 | 系统弹窗：`应用未安装` / `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，**由 Android 系统生成，App 无法拦截改写** | App 抛 `SignatureMismatchError`，显示我们写的可读文案（说明要卸载、数据不丢、需重新配对） |
| 本轮能否验证 | ✅ 可以（§9.3 步骤 1） | ⚠️ 需要已安装旧版 + 有可用更新源，本轮无法验证 |

**关键结论**：
- **§9.3 步骤 1 看到的是系统报错**（英文或系统本地化的「应用未安装」），**不会**看到我们的中文 `SignatureMismatchError` 文案 —— 因为那是直接装 APK，根本没走 App 内的更新器。
- `SignatureMismatchError` 只在「App 内部下载并安装」时才会出现。验证它需要：手机上装着**旧的 debug 签名版本**，然后在 App 里走更新流程装**新签名包**。

**不要把「系统安装器报错看不懂」当成迁移提示失效。** 两者是不同代码路径。

### 9.3 真机验收步骤

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 在**旧 debug 签名版**上直接装新签名包（系统安装器） | 系统弹「应用未安装」/ `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。**这是系统报错，不是我们的提示**，见 §9.2 |
| 2 | 卸载旧版 → 装新签名包 | 安装成功 |
| 3 | 启动，扫码配对 | 配对成功，进入会话列表 |
| 4 | 电脑运行 `setup-gateway.ps1` | 自动打补丁并报「补丁已就绪」 |
| 5 | **重启 DSH**（用 `start-dsh-web.ps1`） | 显示「网关认证补丁：已生效」，正常启动 |
| 6 | 触发需审批的工具调用 | 手机收到审批卡片，可允许/拒绝 |
| 7 | **未授权验证**：同网段另一设备 `POST /mgw/pair` | **401**，拿不到配对码 |
| 8 | 断网 10 秒再恢复 | 出现可读断开提示（**不会自动重连，需手动重进会话** —— 见 §2.1） |
| 9 | 面板启动 → 停止 → 再启动隧道 | 三个按钮都生效（P1-11） |
| 10 | 启动隧道后退出程序 | 面板显示已停；`Get-Process cloudflared` 为空（P1-12） |
| 11 | 我的 → 设备管理 → 撤销旧设备 | 撤销成功，旧设备无法再连 |
| 12 | **（可选）** App 内更新器遇到签名不一致 | 显示中文 `SignatureMismatchError` 文案 —— 需另备旧签名版本 + 更新源，本轮无法验证 |

### 9.4 ⚠️ 真机验完必须卸载测试包（重要）

验收包使用**合成高 versionCode**（`水位线 + 900000 + run`，约 91 万），远高于任何正式版本（当前约 1.6 万）。

**副作用**：Android 不允许 versionCode 降级安装。真机上留着这个测试包时，
**后续正式版 APK 会装不上去**，报 `INSTALL_FAILED_VERSION_DOWNGRADE`。

**因此真机验收结束后必须**：

```powershell
# 列出设备上的包并确认版本号
adb shell dumpsys package com.dshpocket | Select-String 'versionCode|versionName'

# 卸载测试包
adb uninstall com.dshpocket
```

卸载后确认：
```powershell
adb shell pm list packages | Select-String dshpocket
# 无输出 = 已卸载干净
```

然后再装正式版本。若忘记卸载，正式版会一直装不进去，且报错信息很容易被误判成签名问题。

**另外**：卸载会清掉 Keystore 凭据与配对信息，需要重新扫码（这与迁移本身的数据影响一致，见 §6-R5）。

---

## 10. 是否达到正式发布条件

# `BLOCKED_BY_RELEASE_ISSUES`

### 已达成

- 996 单元 + 61 集成 + tsc 全绿
- 四个工作流缺陷全部修复并验证
- 启动路径补丁门禁 fail-closed（含真实行为测试）
- 三个 P0/P1 阻断项（P0-1 快速失败、P1-11、P1-12）修复并有回归测试
- 无敏感材料、暂存区干净、工作流无发布能力

### 未达成

1. **代码未推送** → GitHub 跑的仍是旧代码，签名门禁实际不生效
2. **签名验证未运行** → 无法证明私有证书能正确签名、指纹匹配
3. **真机验收未做** → §9 的 11 项全部待执行
4. **P0-1 未完整解决** → 只做到快速失败，无自动重连/恢复

### 解除阻断的最短路径

```
推送（§8.1）→ 跑 signing-verify（§8.2）→ 核对 Summary 全绿 + 指纹正确 → 真机走 §9 → 可发布
```

### 必须由管理员完成

1. 推送代码到 `main`
2. 手动运行 `Signing Verification (no publish)`
3. 核对 §8.3 的五项结果
4. 完成 §9 的 11 项真机验收
5. 决定 P0-1 的自动重连是否纳入本次发布（当前为已知限制）
6. 决定存量用户迁移通知方式

---

## 附录：本轮未能验证的事项（如实列出）

1. 正式签名 APK 的实际证书指纹 —— 需 CI
2. `EXPECTED_CERT_SHA256` 实际值是否正确 —— 本地不可见
3. GitHub Actions 运行结果与链接 —— 工作流未推送
4. Android 真机上的配对、审批、断线、隧道、退出清理 —— 需真机
5. 补丁在真实插件升级后的端到端表现 —— 需真实升级场景

以上 5 项**均不得视为通过**。
