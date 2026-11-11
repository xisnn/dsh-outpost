# 07 · 全量回归与远程 CI

- 状态：**PASS（本地全量 + 远程 CI 全绿）；Emulator 网关配对回归 FAIL —— 根因在 App 侧原生 cookie 容器，与 D-3 修复无关，已另立缺陷**
- 证据级别：UNIT_TEST（本地 + CI）+ REAL_HOST_EMULATOR（服务端协议/隔离/公网门）+ 真实 App 驱动（配对回归）
- **本地绿 ≠ CI 绿**：两者分别执行、分别记录；CI 用 Node 20.20.2，本地 Node 24.13.0

---

## 1. 远程 CI（权威结论）

Run：**https://github.com/xisnn/dsh-outpost/actions/runs/43080017070**
触发：`workflow_dispatch`（`android.yml` 只在 push tag `v*` 或手动触发时跑）
分支/提交：`opt/p4-0-security` @ `c4c067b9a7a512f691df310f5bde1e6dc9c2c1a0`
时间：2026-11-11T18:40:34Z → 19:00:44Z
**RUN conclusion：success**

| Job | 结论 | URL |
|---|---|---|
| test | **success** | https://github.com/xisnn/dsh-outpost/actions/runs/43080017070/job/130729816855 |
| jvm-tests | **success** | https://github.com/xisnn/dsh-outpost/actions/runs/43080017070/job/130734907399 |
| build-test | **success** | https://github.com/xisnn/dsh-outpost/actions/runs/43080017070/job/130734906275 |
| desktop | **success** | https://github.com/xisnn/dsh-outpost/actions/runs/43080017070/job/130734906248 |
| release | **skipped** | https://github.com/xisnn/dsh-outpost/actions/runs/43080017070/job/130736436902 |

`release` 被跳过是**预期且必须**的：它 gated 于 `startsWith(github.ref,'refs/tags/v')`。
本轮没有 Tag，所以**没有签名、没有发布**。跳过 ≠ 失败，也 ≠ 被绕过。

### 1.1 新门禁确实在远程跑过（不是只在本地绿）

`ci-test-job.log:879`：

```
── [15/115] node tests/mobile-gateway-home-isolation-spec.mjs ──
mobile-gateway home-isolation patch regression
  OK    no DSH_HOME reproduces the legacy default byte-for-byte
  OK    whitespace-only DSH_HOME is treated as unset
  OK    empty DSH_HOME is treated as unset
  OK    DSH_HOME redirects the registry into the isolated root
  OK    explicit deviceFile wins over DSH_HOME and stays verbatim
  ...
mobile-gateway home-isolation patch: 55 passed, 0 failed
```

CI test job 汇总（Node **20.20.2**）：

```
套件汇总：115 条命令，115 通过，0 失败，耗时 501.8s
全部通过。
类型检查（tsc --noEmit）：已执行且通过
套件汇总：5 条命令，5 通过，0 失败，耗时 22.5s      ← Integration tests (fake DSH server)
```

### 1.2 CI JVM 与 APK

`ci-jvm-job.log:462-466`：

```
TEST-…AgentLoopTest.xml:        tests=14 failures=0 errors=0 skipped=0
TEST-…CloudModelClientTest.xml: tests=13 failures=0 errors=0 skipped=0
TEST-…FileRunStoreTest.xml:     tests=7  failures=0 errors=0 skipped=0
TEST-…RunRecoveryTest.xml:      tests=4  failures=0 errors=0 skipped=0
agent-core JVM 合计：files=4 tests=38 failures=0 errors=0 skipped=0
BUILD SUCCESSFUL in 1m 7s
```

`ci-build-job.log:1010-1014`：

```
SHA256 digest of uploaded artifact zip is 8a31ed28d84f9b6a92752fbcbe771d842e017d35c113091a146bd6eb2227d279
Artifact dsh-outpost-test-apk.zip successfully finalized. Artifact ID 13885621404
Final size is 65649972 bytes
https://github.com/xisnn/dsh-outpost/actions/runs/43080017070/artifacts/13885621404
```

CI 原始日志已存档：`logs/ci-test-job.log`、`logs/ci-jvm-job.log`、`logs/ci-build-job.log`、
汇总 `logs/ci-summary.txt`、watch 记录 `logs/ci-run-watch.log`。

### 1.3 CI 注解（如实记录，不掩盖）

- `actions/checkout@v4`、`setup-node@v4`、`setup-java@v4`、`cache@v4`、`upload-artifact@v4`
  仍 target Node 20，被 runner 强制跑在 Node 24 上（deprecation warning）。
- `ubuntu-latest` 将于 2026-10-19 起迁移到 Ubuntu 26（runner-images#14748）。
两者都是**警告**，不影响本轮结论；列入 `09` 的维护项。

---

## 2. 本地全量回归

| 项 | 结果 | 证据 |
|---|---|---|
| `npm test`（115 条命令链，含 tsc） | **115/115，0 失败，935.3s，EXIT=0** | `logs/repo-full-npm-test.log` |
| 新增隔离契约套件 | **55 passed, 0 failed** | `logs/repo-home-isolation-spec.log` |
| 上游插件测试（修复前） | 8 个**环境性**失败（见 §2.1） | `logs/pristine-*.test.log`、`pristine-summary.txt` |
| 上游插件测试（修复后） | 同样 8 个环境性失败 + **新增 14/14 通过** | `logs/fixed-*.test.log`、`fixed-summary.txt` |
| 打过补丁的真实安装包跑隔离套件 | **14/14** | `logs/A3-GREEN-patched-package.log` |
| 补丁门禁 G1–G7 | **全 PASS** | `logs/patch-gates.log` |
| Gradle `:agent-core:test` | **38/38**（14+13+7+4），BUILD SUCCESSFUL | `logs/gradle-p4-build-versioned.log` |
| Debug APK 构建 | **BUILD SUCCESSFUL**（versionCode 940001 / 0.18.3-p40） | 同上 |
| 回滚演练（真实隔离插件副本） | **PASS**，逐字节还原 | `logs/rollback-drill-isolated.txt` |

### 2.1 上游 8 个环境性失败：修复前后签名一致，未削弱任何断言

`pristine-summary.txt` 与 `fixed-summary.txt` 的失败集合**完全相同**，全部是 Windows 环境限制：

- 文件 mode 位断言 `438 !== 384`（Windows 无 POSIX 权限位）
- `EPERM` symlink（无创建符号链接权限）
- `python3` 退出码 9009（未安装）
- `cloudflared` 二进制缺失
- `DSH_INSTALL_ROOT` 需要 asar 解包

**没有**为了让测试变绿而修改断言、跳过用例或改环境判定。新增的 14 个隔离用例在修复前 RED
（`A3-RED-home-isolation.log`，7F/7P）、修复后 GREEN（`A3-GREEN-home-isolation.log`，14P），
RED 与 GREEN 分属独立日志文件。

---

## 3. 章程点名的回归项逐条对账

| 章程要求 | 覆盖方式 | 结论 |
|---|---|---|
| D-3 负向测试 | 上游 14 用例 RED→GREEN + 仓库 55 断言 + 真实包 14/14 + 真实第二实例 fail-closed | **PASS** |
| 网关协议 / 认证 | 真实隔离实例：`/mgw/status`、`/mgw/devices`、`/mgw/pair` 带 cookie 200/201；无 cookie 401；`requireAuth=true` | **PASS**（`regression/emulator-core-regression.txt` R1） |
| P2 公网门 | `test:publicGate`（链 [7/115]）+ 真实 status：`cloudflare.enabled=false`、`publicReady=false`、`lan.host=127.0.0.1`、`queryTokenAllowed=false` | **PASS** |
| BUG-02 超时 / 安全重试 | `test:retry`（[90/115] send-retry）、`test:recovery`（[103/115] gateway-recovery） | **PASS** |
| BUG-03 工具结果绑定 / 状态恢复 | `test:toolResultBinding`（[20/115]）、`test:toolResultUnconfirmed`（[21/115]）、`test:toolResultLateRecovery`（[22/115]） | **PASS** |
| 审批 / 撤销 | `test:approval`、`test:gateway`（[34/115]）、`test:approvalGatewayF01`（[62/115]）、`test:revocation`（[100/115]） | **PASS** |
| 全量 npm test | 本地 115/115 + CI 115/115 | **PASS** |
| tsc | 本地 + CI 均「已执行且通过」 | **PASS** |
| Android JVM 测试 | 本地 38/38 + CI 38/38 | **PASS** |
| Debug APK 构建 | 本地 BUILD SUCCESSFUL + CI build-test success + artifact | **PASS** |
| Emulator 核心回归 | 服务端协议/隔离/公网门 PASS；**App 配对 FAIL（App 侧根因，见 §4）** | **部分 PASS / 一项 FAIL** |
| 远程 CI | run 43080017070 success，4 job 绿，release skipped | **PASS** |

---

## 4. Emulator 网关配对回归：FAIL，但根因不在 D-3 修复

完整原始记录：`logs/regression/emulator-core-regression.txt`。
驱动脚本：`scripts/reg-pair.mjs`（服务端）、`scripts/reg-connect.mjs`（真实 App UI）。

### 4.1 两个症状

- **症状 A**：配对页横幅 `token exchange failed: HTTP 401`，设备数保持 0。
- **症状 B**（`pm clear` 后的全新 App + 重启后的服务端）：「连接」按钮**无限转圈**，
  且 `netstat` 显示**设备到 3997 的连接数为 0** —— App 根本没发出登录请求。

### 4.2 服务端被实测排除（不是推断）

```
GET /?token=X  → 303 + Set-Cookie（dsh-auth-<实例后缀>；HttpOnly；SameSite=Strict；Path=/）
GET /          → 401 "dsh web authentication required; reopen the URL printed by dsh web."
```

**同一个 401 状态码与响应体**出现在**完全移除 mobile-gateway 插件**的对照实例上
（该实例 `/mgw/status` 为 404）。⇒ 401 是 DSH core 的未认证根路由响应，**两个补丁都不产生它**。
用 Node 复现「跟随 303 但不带 cookie」得到一模一样的 401。

### 4.3 根因（App 侧，凭据/认证路径 —— 敏感模块，只交方案不改代码）

- `dsh-mobile/src/core/cookieJar.ts:212-283`：`clearNativeCookieJarDetailed()` 依次 await
  `listDshCookies()`（内部 `cm.getAll()/cm.get()`，183-200 行）与 `cm.clearByName()/clearAll()`，
  **全链路没有任何超时**。原生 cookie 容器一旦不回调，`loginWithToken()` 就永久卡在
  `await this.clearCookieJar()`（`transport/index.ts:244`）⇒ **症状 B**。
- `dsh-mobile/src/core/transport/index.ts:328-342`：`readCookieFromJar()` 有 5s `Promise.race`
  超时，但 rejection 被**空 catch 吞掉**；空 jar 随后落到
  `throw new Error('token exchange failed: HTTP ' + res.status)`（286 行）⇒ **症状 A**，
  一个把原生模块故障伪装成服务端 401 的误导性报错。
- 代码自己的注释就写着原生容器「偶发不回调」（`transport/index.ts:327`）。
- 对照实例上同一 App 构建**曾成功完成一次 cookie 交换**（R3）⇒ 间歇性原生行为，
  不是确定性的服务端变更。

**与 D-3 修复的关系：无。** 症状 B 不发任何请求；症状 A 的 401 由 DSH core 产生且与插件存在与否无关；
本修复只改注册表路径解析与单活锁，不注册任何 HTTP 请求处理器。

### 4.4 顺带发现的新 P1 缺陷：死胡同工作区弹层（产品 UI，只交方案不改代码）

`HomeScreen.tsx:93-98` 以 `onCancel={() => {}}` 渲染 `ButlerWorkspacePicker`，且未传 `allowCancel`
（默认 false ⇒ 无「取消」按钮，`ButlerWorkspacePicker.tsx:29,93-103`）；背板无 onPress，
Android BACK 走同一个 no-op。当 `butlerMode && location==='desktop' && !butlerSessionId && 工作区为空`
时弹层**无任何出口**，且**跨 force-stop 重启仍在**（butlerMode 已持久化），只能 `pm clear` 脱身。
证据：`evidence/reg-02-control-state.png`、`reg-03-after-restart.png`。
影响：用户可被锁死在整个 App UI 之外，无应用内恢复路径。

### 4.5 本轮处置

两项都落在**敏感/产品模块**，按章程**只提交修复方案供第二方复核，不擅自修改**（方案见 `09` §3）。
本轮**没有**为了通过回归而放宽认证、自动批准或跳过失败。

---

## 5. 结论

- 远程 CI 与本地全量**双绿**，新门禁在 CI 的 Node 20 上真实执行并通过。
- 章程点名的回归项除「Emulator 核心回归」的 App 配对外**全部 PASS**。
- App 配对 FAIL 的根因已定位到 App 侧原生 cookie 容器的**无超时清理路径**与**被吞掉的读超时**，
  并用「无插件对照实例」实测排除了 D-3 修复与 mgmt-auth 补丁。
- 新增两项 P1 缺陷（cookie 容器 hang/误导 401；死胡同工作区弹层），均只交方案。
- 正式 DSH、正式注册表、正式凭据在全部回归步骤前后**逐字节未变**；无 Tag、无 Release。