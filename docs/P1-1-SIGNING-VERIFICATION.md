# P1-1 签名门禁核验、证书身份比对与迁移方案

> 核验人：signing-auditor（shared task `task-7`）
> 核验时间：2026-10-27
> 核验对象（工作区快照，非 HEAD）：

| 文件 | SHA-256（文件级） | 最后修改 |
|---|---|---|
| `dsh-mobile/android/app/build.gradle` | `fda9c35ed9d88e8a1ab66ff838b76bb29c2ea6463ce416fbae35dae8e2f9dbae` | 2026-10-26T22:50:05 |
| `.github/workflows/android.yml` | `9133adfbbb43b851cdfaf26cffa721bcc85056dad3db7afddfa53a0a9a92e105` | 2026-10-26T22:50:13 |
| `dsh-mobile/src/core/updater.ts` | `a64013bbe5816a9479e3caf5e134472c345f87816ad6e0adff2e85e2dd3f6f69` | 2026-10-26T23:00:30 |
| `dsh-mobile/src/core/update-integrity.ts` | `15f7dc191405e9ce986d3ba006963dddb8990d4c282ba4a5b42d33dcdffa8d6f` | 2026-10-26T22:59:41 |

> **本文档中的每一行签名门禁代码，当前都只存在于未提交的工作区。**
> `git status --porcelain` 显示 `build.gradle` 与 `android.yml` 均为 ` M`（modified, not staged）。
> 详见 §A.4 —— 这是本次核验最重要的结论之一。

**机密处理声明**：本文档不含任何密码、私钥、token。AOSP debug keystore 的密码是公开常量，
但仍按要求统一记作 `<known AOSP debug password>`。

---

## 0. 结论速览（先看这段）

| # | 问题 | 结论 |
|---|---|---|
| 1 | gradle 能否静默回退 debug 签名？ | **不能**。缺签名材料时在 **configuration 阶段** 抛 `GradleException`，已实测构建失败。 |
| 2 | 这个门禁是否有副作用？ | **有，且是回归**：它让 `assembleDebug` 也一并失败。CI 的 `build-test` job（`android.yml:145`）**必然红**。详见 §A.3。 |
| 3 | CI Gate 1–4 是否硬失败？ | **是**（按工作区版本）。Gate 4 缺 `EXPECTED_CERT_SHA256` 已由 `::warning::` 改为 `::error::` + `exit 1`。但**该改动尚未提交**（§A.4）。 |
| 4 | AAB 路径是否覆盖？ | **覆盖到位但无门禁**：`bundleRelease` 同样受 gradle 门禁保护（已实测），但 CI 无任何 AAB 任务，指纹门禁也不覆盖 AAB（§A.5）。 |
| 5 | 4 个 APK 的证书是否一致？ | **全部一致**，且等于仓库 `debug.keystore` 的证书：`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`（§B）。 |
| 6 | 历史哪些 APK 真正公开发布过？ | v0.16.3 有文书记录；`_test-artifacts/` 里 3 个**从未公开**；`v0.16.3` 之前的 Release **无法证实**（§C）。 |
| 7 | SHA-256 校验是否 fail-closed？ | **是**，6 种失败路径全部拒绝安装且删文件（已用真实代码跑通，§D）。 |
| 8 | 迁移会丢什么？ | Keystore 5 项 + AsyncStorage 15 项 + CookieJar 本地全丢；**DSH 侧会话/任务不丢**；**服务端设备授权记录会变孤儿**（§E）。 |
| 9 | 管理员必须手工做什么？ | 6 步：造 keystore、配 4 个 Secret、配 `EXPECTED_CERT_SHA256`、备份、抬 `versionCode` 水位线、准备迁移公告（§F）。 |

**一句话**：签名/哈希这两层现在是「失败即停」的，但**它们守护的仍然是一把公开的调试私钥**；
而且真正拦住这件事的两处改动还没进仓库，同时那个 gradle 门禁还顺手把 debug 构建弄坏了。

---

## A. 签名门禁是否真正 fail-closed

### A.1 gradle：release 变体的签名选择

`dsh-mobile/android/app/build.gradle:131-150`：

```groovy
131:            def allowDebugSigning =
132:                (project.findProperty('DSH_ALLOW_DEBUG_RELEASE_SIGNING') ?: 'false')
133:                    .toString().toBoolean()
134:            if (project.hasProperty('DSH_STORE_FILE')) {
135:                signingConfig signingConfigs.release
136:            } else if (allowDebugSigning) {
137:                logger.warn(  ... '这个包**不能**作为正式发布包'  )
141:                signingConfig signingConfigs.debug
142:            } else {
143:                throw new GradleException(
144:                    'release 构建缺少正式签名材料。请传 -PDSH_STORE_FILE / ...'
```

三路分支都核验过：

| 分支 | 条件 | 结果 | 实测 |
|---|---|---|---|
| 正式签名 | `-PDSH_STORE_FILE` 存在 | `signingConfigs.release` | 见 §A.6 探针 4 |
| 显式冒烟 | 上面不成立 + `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true` | `signingConfigs.debug` + `logger.warn` | **通过，且验证了告警真的打印**（§A.6 探针 3） |
| 默认 | 都不成立 | `throw new GradleException` | **构建失败**（§A.6 探针 1） |

**结论：不存在「静默」回退路径。** 回退只发生在显式传参 `DSH_ALLOW_DEBUG_RELEASE_SIGNING=true` 时，
且必定打印一行醒目告警。全仓库搜索该开关只有 4 处命中，全部在 `build.gradle` 自身 + 一份说明文档：

```
dsh-mobile\android\app\build.gradle:116:  // -PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true（CI 永不传）。
dsh-mobile\android\app\build.gradle:132:  (project.findProperty('DSH_ALLOW_DEBUG_RELEASE_SIGNING') ?: 'false')
dsh-mobile\android\app\build.gradle:138:  '⚠️ release 变体正在使用 debug 签名（DSH_ALLOW_DEBUG_RELEASE_SIGNING=true）。'
dsh-mobile\android\app\build.gradle:147:  '如果只是想做一次冒烟构建，显式加 -PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true ' +
DSH-OUTPOST-SECURITY-REMEDIATION.md:188: - 保留显式逃生口 `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true`（默认 false...）
```

两份 `gradle.properties`（`dsh-mobile/android/gradle.properties` 与 `~/.gradle/gradle.properties`）
均**未**定义该属性（前者已全文检查，无 `DSH_` 前缀的任何键），因此无法通过项目级配置把它永久打开。

### A.2 部分传参 / 空值传参是否 fail-closed

不是「有 `DSH_STORE_FILE` 就认为齐全」——`signingConfigs.release` 会无条件读取另外三个属性。
实测两种残缺情形都在配置阶段炸掉（§A.6 探针 4/5）：

```
PROBE 4: 只设 DSH_STORE_FILE           → FAILURE, build.gradle line: 120   (storePassword 缺失)
PROBE 5: 四个都传但都是空字符串         → FAILURE, build.gradle line: 119   (storeFile 空 → file('') )
```

两种都是**硬失败**，不会产出任何包。✅

### A.3 ⚠️ 回归：这个门禁把 `assembleDebug` 也一起挡死了

`throw` 写在 `android { buildTypes { release { ... } } }` 里，而 **Gradle 的配置阶段针对所有变体执行**。
所以只要 release 分支走进 `else`，**同一模块的任何任务**都会失败，包括 `assembleDebug`。

实测（`GRADLE_USER_HOME=_gradle-home`，`--offline`，不传任何签名参数）：

```
PROBE 2: :app:assembleDebug -m   (dry run，不传签名参数)
  FAILURE: Build failed with an exception.
  Build file 'E:\work\dsBot\dsh-mobile\android\app\build.gradle' line: 144
  > release 构建缺少正式签名材料。请传 -PDSH_STORE_FILE / ...
  BUILD FAILED in 20s
  EXIT=1
```

对照 §A.6 探针 3：同一命令加上 `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true` 后 `BUILD SUCCESSFUL`。
**这证明失败原因就是这条 `throw`，而不是环境问题。**

后果是具体的：`.github/workflows/android.yml:141-147` 的 `build-test` job 只跑

```
145:          ./gradlew --no-daemon :app:assembleDebug \
146:            -PDSH_VERSION_NAME="${{ steps.ver.outputs.version }}" \
147:            -PDSH_VERSION_CODE="${{ steps.ver.outputs.code }}"
```

传了版本号但**没传任何 `DSH_*` 签名参数**，因此该 job 必定失败。
`workflow_dispatch` 手动触发测试包构建的能力**已被破坏**。

同时，本地开发者的日常操作也被打断：

```
.\gradlew.bat assembleDebug                       → 失败（需要 release 签名材料？）
.\gradlew.bat assembleDebug -PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true   → 成功
```

这对一个「只想调试」的开发者是反直觉的：debug 变体根本不用 `signingConfigs.release`。

**建议的修法（需 owner 决策，本次未改代码）**：把校验从配置期改为**任务期**，
仅当真的在构建 release 产物时才失败，例如用 `gradle.taskGraph.whenReady { ... }` 判断
是否存在 `assembleRelease`/`bundleRelease`/`packageRelease*`，或改用
`androidComponents.onVariants { variant -> if (variant.buildType == 'release' && variant.signingConfig == null) throw ... }`。
**不建议**简单地在 `build-test` 里补传 `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true` ——
那会把「逃生口」固化进 CI，反而削弱了 §A.1 的保证。

### A.4 ⚠️ 门禁改动尚未提交 —— 发布时用的仍是旧门禁

```
$ git status --porcelain dsh-mobile/android/app/build.gradle .github/workflows/android.yml
 M dsh-mobile/android/app/build.gradle
 M .github/workflows/android.yml
```

已提交的 HEAD 版本（`git show HEAD:`）里：

```
HEAD:dsh-mobile/android/app/build.gradle:118:
    signingConfig project.hasProperty('DSH_STORE_FILE') ? signingConfigs.release : signingConfigs.debug
                                            ↑ 单行三元回退，正是本次要消灭的那一行

HEAD:.github/workflows/android.yml:356:
    echo "::warning::未设置仓库变量 EXPECTED_CERT_SHA256，跳过指纹比对"
                                            ↑ warning + 继续发布
```

再看**实际发布 v0.16.3 那一刻**的 tag：

```
$ git show v0.16.3:.github/workflows/android.yml | grep -E 'EXPECTED_CERT_SHA256|::warning::'
343: EXPECTED="${{ vars.EXPECTED_CERT_SHA256 }}"
356: echo "::warning::未设置仓库变量 EXPECTED_CERT_SHA256，跳过指纹比对"

$ git show v0.16.3:dsh-mobile/android/app/build.gradle | grep 'signingConfig project.hasProperty'
118: signingConfig project.hasProperty('DSH_STORE_FILE') ? signingConfigs.release : signingConfigs.debug
```

**所以：v0.16.3 那次真实发布，Gate 4 的指纹比对是「关着的」，gradle 仍会自动回退 debug 签名。**
它能发出一个「看起来通过了 4 道门禁」的包，只是因为 Gate 1/3 用**同一个 debug keystore**
去满足「必须有签名 Secrets」——这一点由 `DSH-OUTPOST-RELEASE-REPORT.md:139-145` 自述佐证：

> **历史所有正式 Release（含 v0.16.2）实际都是 Android Debug 证书签名。**
> **本轮决策（已获用户明确确认）**：继续使用该签名发布，以保住老用户覆盖升级能力。

**这条必须写进 owner 的待办：两处核心门禁在提交前，仓库是「没有修」的状态。**

### A.5 CI Gate 1–4 逐条核验

| Gate | 位置 | 触发条件 | 行为 | 是否硬失败 |
|---|---|---|---|---|
| **Gate 1** 签名 Secrets 齐全 | `android.yml:186-213` | 四个 secret 任一为空 | `::error::` + `exit 1` | ✅ `exit 1`(`:211`) |
| **Gate 2** versionCode 推导 + 单调递增 | `android.yml:249-255` → `scripts/version-code.mjs` | 公式不递增 / 水位线缺失 / tag 非法 | `throw VersionError` → `process.exit(2)` | ✅ 已实测，见下 |
| **Gate 3** keystore 落地 + 别名校验 | `android.yml:265-290` | base64 解码空 / keytool 失败 | `::error::` + `exit 1`(`:279`,`:286`) | ✅ |
| **Gate 4** APK 验签 + 指纹 + 包名/版本 | `android.yml:313-383` | 见下 | 全部 `::error::` + `exit 1` | ✅（工作区版本） |

Gate 4 内部 5 个断言全部硬失败（工作区版本）：

```
:319  [ ! -f "$APK" ]                    → ::error:: + exit 1    产物不存在
:330  apksigner verify 失败              → ::error:: + exit 1    密码学验签失败
:347  NORM_ACTUAL != NORM_EXPECTED       → ::error:: + exit 1    指纹不符
:362  -z "$EXPECTED" (未配置变量)        → ::error:: + exit 1    ← 本次从 warning 改为 error
:375  [ "$PKG" != "com.dshpocket" ]      → ::error:: + exit 1    包名不符
:376  [ "$VC" != ver.code ]              → ::error:: + exit 1    版本码不符
:377  [ "$VN" != ver.version ]           → ::error:: + exit 1    版本名不符
```

`EXPECTED_CERT_SHA256` **缺失即失败**（工作区版本 `android.yml:355-366`）：

```bash
355:          else
362:            echo "::error::未设置仓库变量 EXPECTED_CERT_SHA256，无法校验发布身份，已中止。"
363:            echo "  请在 Settings → Variables 配置该项（值为正式签名证书的 SHA-256）。"
365:            exit 1
```

✅ 确认是 fail-closed，不是 warning。

**Gate 2 实测**（`node scripts/version-code.mjs`，Node v24.13.0）：

```
$ node scripts/version-code.mjs --tag v0.16.3
versionCode : 160300  (水位线 16200，严格大于 ✓)          exit=0

$ node scripts/version-code.mjs --tag v0.1.0
::error::versionCode 没有递增：本次算出 10000，而已发布水位线是 16200。   exit=2
```

判据在 `scripts/version-code.mjs:181-188`（`code <= floor.minVersionCode` 即抛错），
水位线文件缺失在 `:143-153` 视为严重错误（不是跳过）。

**`continue-on-error` 检查**：

```
$ Select-String -Path .github/workflows/android.yml -Pattern 'continue-on-error'
(无命中)
```

全文件仅 3 处 `if:`：`:87`（`workflow_dispatch` → build-test）、`:160`（tag → release）、
`:399`（`if: always()` → 清理 keystore）。**没有任何 `continue-on-error`**。✅

**Gate 之后是否还有能发布的步骤？** 有，但都依赖前面成功：

```
:385 Prepare release files      → 复制 + 生成 SHA256SUMS.txt
:398 Clean up keystore          (if: always())
:402 Upload signed APK as artifact
:412 Publish GitHub Release     ← 唯一发布点，softprops/action-gh-release@v2
```

`:412` 是 issue 之外唯一的发布动作，位于 Gate 4 之后。`build-test` job（`:86-154`）
只 `upload-artifact`，**不含任何 `action-gh-release`**，符合「测试构建绝不发 Release」的设计。
✅ 没有「门禁之后仍可发布」的旁路。

### A.6 gradle 门禁实测探针（全部真实执行）

环境：`GRADLE_USER_HOME=E:\work\dsBot\_gradle-home`，`--offline`，Gradle 8.14.3。

```
PROBE 1  :app:tasks                      无签名参数
         → FAILURE: build.gradle line: 144   BUILD FAILED   EXIT=1
         （连 :app:tasks 这种只读任务都过不去 —— 证明失败点在配置期）

PROBE 2  :app:assembleDebug -m           无签名参数
         → FAILURE: build.gradle line: 144   BUILD FAILED   EXIT=1
         （CI build-test 用的正是这条命令）

PROBE 3  :app:assembleDebug -m           -PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true
         → ⚠️ release 变体正在使用 debug 签名（...）。 这个包**不能**作为正式发布包
           BUILD SUCCESSFUL   EXIT=0
PROBE 3  :app:assembleRelease -m         同上
         → BUILD SUCCESSFUL   EXIT=0
PROBE 3  :app:bundleRelease -m           同上
         → BUILD SUCCESSFUL   EXIT=0     ← AAB 任务同样受此门禁保护

PROBE 4  :app:assembleRelease -m         -PDSH_STORE_FILE='C:\nonexistent\release.keystore'（其余缺失）
         → FAILURE: build.gradle line: 120                 EXIT=1

PROBE 5  :app:assembleRelease -m         四个属性全传空串
         → FAILURE: build.gradle line: 119                 EXIT=1
```

> 注：PROBE 4/5 的 `EXIT` 被 PowerShell 记为 `-1`（pwsh 对子进程异常的取值），
> 但 `FAILURE` + `BUILD FAILED` 文本明确，且无产物生成。

### A.7 AAB / `bundleRelease` 覆盖情况

| 问题 | 结论 | 证据 |
|---|---|---|
| gradle 门禁是否也管 AAB？ | **管**。`buildTypes.release` 对所有 release 类任务生效，实测 `:app:bundleRelease -m` 无参数时同样失败 | §A.6 |
| CI 里有没有构建 AAB？ | **没有**。全仓库搜索 `bundleRelease` / `.aab` / `bundletool` 在 workflow 与脚本中零命中 | 见下 |
| CI 的 Gate 4 是否校验 AAB？ | **不校验**（Gate 4 硬编码 `app-release.apk`） | `android.yml:317` |
| 现在有没有漏洞被利用？ | **没有**。因为根本没有 AAB 产物发布 | — |

搜索结果（排除 `node_modules` / `build` / `.git`）：

```
bundleRelease  → 仅 dsh-mobile\android\app\build.gradle:37（注释里的 bundleAssetName，无关）
.aab           → 零命中
bundletool     → 零命中
```

`android.yml:317`：

```bash
317:          APK="dsh-mobile/android/app/build/outputs/apk/release/app-release.apk"
```

**残余风险（低，但需记录）**：若将来加入「出 AAB 上传 Google Play」的流程，Gate 4 不会覆盖它。
AAB 的信任锚是 Google Play 的签名验证，与自签名 APK 是两套体系；
新增 AAB 发布路径时**必须**同步加一条 `bundletool validate --print-certs` 之类的门禁，
否则会重演「指纹门禁不覆盖产物」的老问题。

### A.8 Gate 4 的两个逻辑弱点（不构成漏洞，但会误判）

**(1) `grep 'SHA-256 digest' | head -1` 只取第一个签名者**（`android.yml:340`）：

```bash
340:          ACTUAL=$(grep 'SHA-256 digest' /tmp/certs.txt | head -1 | awk '{print $NF}')
```

当前所有产物都是单签名者（实测 `Number of signers: 1`），所以没问题。
但若将来多做一次轮换签名（multi-signer），`head -1` 可能取到非预期的那个证书。

**(2) 没有任何地方校验「证书 ≠ 公开 debug 证书」**

```
$ Select-String -Path .github/workflows/android.yml,dsh-mobile/scripts/version-code.mjs \
    -Pattern 'fac61745|debug.keystore|Android Debug|CN='
(无命中)
```

这意味着：只要 owner 把 `EXPECTED_CERT_SHA256` 填成
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`（即仓库里那把公开证书），
**Gate 4 会高高兴兴地通过**，并且报告「证书指纹符合预期 ✓」。
门禁只保证「每次发布用的是同一把证书」，**不保证「那把证书是私有的」**。
这正是 §C/§F 要解决的信任锚问题，建议 owner 在填变量时显式确认它不是 `fac61745…`。

### A.9 A 节小结

| 检查项 | 结论 |
|---|---|
| release 静默回退 debug | ❌ 已消除（配置期硬失败） |
| 部分/空签名参数 | ✅ fail-closed（配置期硬失败） |
| Gate 1–4 硬失败 | ✅（工作区版本） |
| 缺 `EXPECTED_CERT_SHA256` | ✅ 硬失败（工作区版本） |
| `continue-on-error` | ✅ 无 |
| 门禁后可发布旁路 | ✅ 无（唯一发布点 `:412` 在 Gate 4 之后） |
| AAB 覆盖 | ⚠️ gradle 层覆盖；CI 层无 AAB、无 AAB 门禁 |
| **改动是否已提交** | ❌ **未提交**，v0.16.3 发布时用的是旧门禁 |
| **对 debug 构建的影响** | ❌ **回归**，`assembleDebug` / CI `build-test` 必定失败 |
| 证书是否被验证为「非公开」 | ❌ 无此校验，填错值也会通过 |

---

## B. 证书身份比对（真实 APK）

### B.1 方法

```
D:\Android\Sdk\build-tools\34.0.0\apksigner.bat verify --print-certs <apk>
D:\Jdk21\bin\keytool.exe -list -v -keystore dsh-mobile\android\app\debug.keystore \
    -storepass <known AOSP debug password> -alias androiddebugkey
```

`keytool` 的密码由脚本**从 `build.gradle:99` 读取后直接传入**，未在命令行手写、未打印。
`debug.keystore` 由 `git ls-files` 确认为**已跟踪文件**（`.gitignore:43-44` 用 `!` 显式放行）。

### B.2 仓库 debug keystore 的身份（基准）

```
$ keytool -list -v -keystore dsh-mobile/android/app/debug.keystore -alias androiddebugkey
别名: androiddebugkey        创建日期: 2014年1月1日        条目类型: PrivateKeyEntry
所有者: CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US
有效期: Wed Jan 01 06:35:04 CST 2014  →  Wed May 01 06:35:04 CST 2052
SHA1:   5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25
SHA256: FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C
签名算法名: SHA1withRSA (弱)      公钥算法: 2048 位 RSA
```

**基准指纹 = `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`**

> 附带发现：这把证书是 **2014 年** 的 AOSP 默认 debug 证书，且签名算法是 **SHA1withRSA**（keytool 自己标了「弱」）。
> 有效期到 2052 年，所以不存在过期问题；但 SHA-1 说明它连现代化程度都不具备，进一步印证必须换掉。

### B.3 四个（实为五个）APK 的实测结果

| APK | 字节数 | versionCode / versionName | Signer DN | 证书 SHA-256 | 等于仓库 debug 证书？ |
|---|---|---|---|---|---|
| `_test-artifacts/TEST-app-release-vc16200-v0.16.2-debugsigned.apk` | 77,145,609 | 16200 / 0.16.2 | `CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US` | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` | **是** |
| `_test-artifacts/OLD-app-release-vc1-v0.16.x-2026-10-22.apk` | 76,270,249 | **1 / 1.0** | 同上 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` | **是** |
| `dsh-mobile/android/app/build/outputs/apk/release/app-release.apk` | 77,145,613 | **160300 / 0.16.3** | 同上 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` | **是** |
| `dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk` | 133,221,664 | 16200 / 0.16.2 | 同上 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` | **是** |
| `_test-artifacts/NEW-app-debug-vc16200-v0.16.2.apk`（额外核验） | 133,221,664 | 16200 / 0.16.2 | 同上 | `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` | **是** |

**5/5 全部命中同一把公开 debug 证书。** ✅ 与 `DSH-OUTPOST-SECURITY-REMEDIATION.md:150,154`
记录的值完全一致，也与 `DSH-OUTPOST-RELEASE-REPORT.md:275`（v0.16.3 线上产物）一致。

### B.4 签名方案与完整性

```
apksigner verify --verbose
  Verifies
  Verified using v1 scheme (JAR signing): false
  Verified using v2 scheme (APK Signature Scheme v2): true
  Verified using v3 scheme (APK Signature Scheme v3): false
  Number of signers: 1
```

四个产物完全一致：**仅 v2 签名，单签名者，验签通过**。
v1 = false 对 `minSdkVersion 24`（`aapt2 dump badging: sdkVersion:'24'`）是安全的 ——
Android 7.0+ 只认 v2 也够。但这也意味着**无法用 v1 JAR 签名做额外校验**。

### B.5 ⚠️ 本地 `app-release.apk` 的来源可疑（无法确证）

这个文件很容易被误当成「正式签名包」，但：

| 事实 | 证据 |
|---|---|
| 它的证书 = 公开 debug 证书 | 见 §B.3 |
| versionCode 是**旧公式**的 160300 | `aapt2 dump badging` → `versionCode='160300'` |
| **旧公式在 CI 里会被 Gate 2 拦下** | 旧公式算 v0.16.3 = **16003** < 水位线 16200 → `exit 2`（§A.5 实测同类） |
| 所以它不可能是当前 CI 产物 | 逻辑推演 |

`versionCode=160300` 只可能来自**新公式**（`major*1e6 + minor*1e4 + patch*1e2`），
而新公式 + Gate 2 共存是「本轮整改」才有的组合；但本轮整改又没提交、且本机没有正式 keystore。
最可能的解释是：用一个本地手工传参的 `-PDSH_VERSION_CODE=160300` + `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true`
冒烟构建出来的。**但这只是推断，没有直接日志证据。**

`BUILD-LOG-round4-final-release.txt:752` / `BUILD-LOG-round5-signed-test.txt:508` 只记录了
`BUILD SUCCESSFUL`，日志中**没有**出现 `DSH_ALLOW_DEBUG_RELEASE_SIGNING` 或 `DSH_STORE_FILE` 字样
（旧版 gradle 还没有这两个开关，所以这本就查不到）。

> **判定：`app-release.apk` 是「本地冒烟产物」，不得发布。标记 待验证（来源无法从现有日志确证）。**

---

## C. 哪些 APK 真正公开发布过

### C.1 判定依据与限制

**⚠️ 无法访问网络**：本沙箱对 `github.com` 与 `api.github.com` 均返回
`URL hostname resolves to a non-public IP address`，因此**无法直接查询 GitHub Releases**。
以下判定完全基于仓库内证据，凡无法确证的均标 `无法确定`。

### C.2 逐个判定

| 产物 / 版本 | 判定 | 依据 |
|---|---|---|
| `_test-artifacts/TEST-app-release-vc16200-v0.16.2-debugsigned.apk` | **仅测试（从未公开）** | `ANDROID-BUILD-RESULT.md:144,149`「**Release 变体 + debug 签名（侧载测试用，不可上架）**」、`:208` 标为「本轮主交付」；`RELEASE-READINESS-REPORT.md:154` R1「本轮 APK 是 debug 签名，不可上架/不可作为正式发布包」 |
| `_test-artifacts/OLD-app-release-vc1-v0.16.x-2026-10-22.apk` | **仅测试（基线包）** | `ANDROID-BUILD-RESULT.md:206`「**旧版**（vc=1, vn=1.0，2026-10-22），仅作升级基线」；versionCode=1 说明它是 `assembleRelease` 不带 `-P` 的产物 |
| `_test-artifacts/NEW-app-debug-vc16200-v0.16.2.apk` | **仅测试** | `ANDROID-BUILD-RESULT.md:158`；与 `app-debug.apk` **字节完全相同**（SHA-256 均为 `f5687363…70c8f2`） |
| `dsh-mobile/.../app-release.apk`（本地） | **仅本地冒烟** | §B.5 |
| `dsh-mobile/.../app-debug.apk`（本地） | **仅本地** | debug 变体 |
| **v0.16.3** | **已公开发布（Pre-release）** | `DSH-OUTPOST-RELEASE-REPORT.md:5`「`RELEASED_PREVIEW`」、`:331`「Pre-release ✅ true」、`:332`「Draft false（已公开发布）」、`:333` 发布时间 `2026-10-25T20:00:27Z`；附件 `dsh-outpost-v0.16.3.apk` + `SHA256SUMS.txt`；`git tag -l` 中 v0.16.3 存在 |
| **v0.15.8 / v0.15.10 / v0.16.0 / v0.16.1 / v0.16.2** | **无法确定**（仓库自述为已发布） | `.github/release-floor.json` 的 `note` 明写「GitHub 历史已发布 APK：v0.15.8=15008 … v0.16.2=16002 → 当前线上最高」；但这是**自述**，本次无法联网核实 |
| **v0.1.0 – v0.15.5 之间的其余 tag** | **无法确定** | 见 C.3 |

### C.3 关键不确定性：旧 workflow 是否对每个 tag 都发 Release

`v0.9.0` 的 workflow 已经具备发布能力：

```
$ git show v0.9.0:.github/workflows/android.yml | grep -n 'softprops\|tags:\|files:'
5:    tags:
153: - name: Publish release
155: uses: softprops/action-gh-release@v2
```

`v0.15.3` / `v0.16.2` 同样在 `files: out/*.apk` 下发布 APK。
**所有 57 个 tag 的树里都存在 `.github/workflows/android.yml`**，且触发条件都是 `push: tags: v*`。

因此：**任何一次 tag 推送理论上都会创建 Release**。但「tag 存在」≠「Release 存在」——
可能被手动删除、可能 job 失败、可能仓库早期是私有仓库。**这三者本机都无法证伪。**

`DSH-OUTPOST-SECURITY-REMEDIATION.md:219` 的说法是「历史上**约** 10 个正式版本」，
用「约」字本身说明作者也没有精确账本。**本文档不对 v0.16.3 之前的版本数量做断言。**

### C.4 对迁移方案的意义（重要）

无论是 5 个还是 10 个、还是 57 个版本，**结论都不变**：

> 只要用户装过**任意一个** debug 证书签名的包，切换到私有证书后都必须卸载重装。

而「哪些版本是 debug 签名」这个问题**已经被 §B 彻底回答**：
仓库里能找到的产物、以及 `DSH-OUTPOST-RELEASE-REPORT.md:127-133` 的逐版本指纹表，
全部指向同一把 `fac61745…3b9c`。所以**没有任何一个已发布版本用了别的证书**，
不存在「部分用户已经是私有证书」的乐观情形——**所有人都会受影响**。

---

## D. SHA-256 更新校验路径（双向）

### D.1 代码位置

- 纯逻辑：`dsh-mobile/src/core/update-integrity.ts`（96 行）
- 编排 + IO：`dsh-mobile/src/core/updater.ts`
  - `checkForUpdate()` `:45-93`
  - `verifyApkIntegrity()` `:141-188`
  - `downloadAndInstall()` `:201-284`

### D.2 六种情形逐条追踪

> 下表 (i)(ii)(iii)(iv)(v)(vi) 中，**标记「实测」的行由真实代码执行验证**：
> 用 `tsx` 加载 `src/core/update-integrity.ts` 逐用例调用纯函数（脚本写在 `%TEMP%`，
> 不在仓库内；执行后已删除）。

| # | 情形 | 代码路径 | 结果 | 证据 |
|---|---|---|---|---|
| **(i)** | 哈希匹配 | `updater.ts:175` 算实际 → `:177` `hashMatches` 为 true → `:187` return | **进入安装器**，`actionViewIntent` `:273` | 实测 `hashMatches(A, A.toUpperCase()) = true`（大小写不敏感） |
| **(ii)** | 哈希不匹配 | `:177` false → `:179` `throw` → 被 `:258` 捕获 → `:259` `unlink` | **删文件 + 抛错，不进安装器** | 实测 `hashMatches(A,B) = false`；`security-remediation-spec.mjs:97` 断言 `hashMatches(actual, expected.sha256)` |
| **(iii)** | `SHA256SUMS.txt` 缺失（且无 body 哈希） | `:151` `sumsUrl` 为空 → `sumsText=undefined` → `:161` `resolveExpectedHash` 返回 `undefined` → `:167` `throw` | **拒绝安装**（在删除逻辑之前抛出，但缓存文件仍会被 `:259` 删掉） | **实测** `resolveExpectedHash({sumsText:undefined, notesHash:undefined, ...}) = undefined` |
| **(iv)** | sums 存在但 APK 名不在里面 | `update-integrity.ts:48` 名字不匹配 → 返回 `undefined` → 退到 `notesHash`；若 notes 也没有 → `undefined` → `:167` throw | **拒绝安装**（不会「随便拿一个哈希」） | **实测** `parseSumsFile(A+'  other.apk', apk) = undefined`；`resolveExpectedHash({sumsText:'<A>  other.apk', notesHash:undefined}) = undefined`。`security-remediation-spec.mjs:126,151` 同名断言 |
| **(v)** | 拉 sums 网络失败，但 release body 有哈希 | `:151-158` catch 后 `sumsText` 保持 `undefined` → `:161` 退到 `notesHash` → `:70` 校验 64 hex → 返回 `{source:'notes'}` | **继续校验**（用 body 哈希），匹配才装 | **实测** `resolveExpectedHash({sumsText:undefined, notesHash:'a'*64, ...}) = {sha256:'aaa…', source:'notes'}` |
| **(vi)** | 两者都拿不到 | 同 (iii) | **拒绝安装** | **实测** `resolveExpectedHash({sumsText:'', notesHash:'', ...}) = undefined` |

### D.3 失败路径是否「删文件 + 不进安装器」—— 逐条确认

`updater.ts:252-261`：

```ts
252:  // ── 完整性校验（大小对了不代表内容对）────────────────────────
255:  // 校验失败必须删文件 + 抛错，绝不能继续进安装器。
256:  try {
257:    await verifyApkIntegrity(path, release);
258:  } catch (e) {
259:    await ReactNativeBlobUtil.fs.unlink(path).catch(() => undefined);
260:    throw e;
261:  }
```

- ✅ `verifyApkIntegrity` 是 `downloadAndInstall` 中 `actionViewIntent`（`:273`）**之前**的唯一语句块，
  且 `throw` 会中断函数，**不可能到达 `:273`**。
- ✅ 两个失败出口（`:167` 无期望值、`:179` 哈希不符）都是 `throw`，都被 `:258` 捕获 → 删文件。
- ✅ **缓存命中**路径也走同一段：`usable` 为真时（`:215-221`）只是跳过下载，
  代码直接落到 `:256` 的校验。所以「上次留下的完整但被篡改的文件」同样会被拦。
- ✅ 所有失败都是 `Error`，`InstallPermissionError` 只在 `:280` 安装器抛权限错时才产生，
  不会被误标成「权限问题」而让用户以为重试就行。

`security-remediation-spec.mjs:99-104` 还静态断言了这段结构：

```
99:   /await verifyApkIntegrity\(path, release\)/.test(updater)
103:  /await ReactNativeBlobUtil\.fs\.unlink\(path\)\.catch\(\(\) => undefined\);\s*\n\s*throw e;/.test(...)
```

**结论：D 节的 6 种情形全部 fail-closed，且失败即删文件、不进安装器。** ✅

### D.4 ⚠️ 但存在第二条完全绕过哈希校验的安装路径

`dsh-mobile/src/core/fileUrl.ts:112-115`：

```ts
112: export async function openLocalFile(file: RemoteFile): Promise<void> {
113:   const mime = mimeOf(file.name);
114:   await ReactNativeBlobUtil.android.actionViewIntent(file.fsPath, mime);
115: }
```

而 `mimeOf()` 对 `.apk` 会返回**安装用的 MIME**（`fileUrl.ts:177-178`）：

```ts
177:     case 'apk':
178:       return 'application/vnd.android.package-archive';
```

调用链是真实可 Reach 的：

```
FileCard.tsx:244   await openLocalFile(f)          ← 用户在聊天里点一个附件
  → fileUrl.ts:114 actionViewIntent(fsPath, 'application/vnd.android.package-archive')
  → 系统安装器弹出
```

也就是说：**DSH agent（或被攻陷的 PC）只要把恶意 APK 作为一个普通文件发到聊天里，
用户在手机上点一下，就能安装一个完全绕过 SHA-256 校验的包。**
这条路径不属于 `updater.ts`，`verifApkIntegrity` 根本不参与。

不过要说清楚它的**实际危害边界**：
- Android 仍会做签名校验 → 攻击者必须持有**同一把证书**才能覆盖安装；
- 而当前那把证书是**公开的 debug 密钥**（§B）→ **这个前提恰好成立**。

所以 D.4 与 P1-1 的根因是同一个：**签名私钥公开 ⇒ 应用内的所有哈希/校验都失去意义**。
换私有证书后，D.4 的危害会从「可覆盖安装恶意包」降级为「安装失败（签名不符）」，
即**自动被签名信任锚兜住**。这也再次说明 §F 换证书是唯一的根本解。

> 建议（本次未改代码）：`openLocalFile` 对 `.apk` 直接拒开，或改走 `downloadAndInstall` 的校验流程。

### D.5 残余信任锚弱点

| 弱点 | 说明 | 现状 |
|---|---|---|
| **哈希与 APK 同渠道** | `SHA256SUMS.txt` 与 APK 都在同一个 GitHub Release。整仓接管者可一起替换 | 已在 `updater.ts:129-137` 如实注释，不假装是完整方案 |
| **`checkForUpdate` 走未鉴权 API** | `https://api.github.com/repos/xisnn/dsh-outpost/releases/latest`（`:23`），受 GitHub 账号与 DNS/TLS 信任 | 无法在本 APP 内改善；TLS 是唯一锚 |
| **`sumsUrl` 由 release 元数据决定** | 攻击者控制 release 就能把 `sumsUrl` 指向任意 URL | 同上 |
| **失败退化为「没有更新」** | `checkForUpdate` 的 `catch { return null }`（`:89-92`）—— 网络/限流都静默 | 不构成安全问题（不装即安全），但用户可能长期不知道有更新 |
| **真实信任锚** | 只能是 **Android APK 签名 + 私有密钥** | **当前不成立**（私钥已公开） |
| **无 `update-integrity.ts` 单元测试** | `grep` 全 `tests/` 无 `update-integrity|parseSumsFile|resolveExpectedHash` 命中；`updater-spec.mjs` 只测 `isNewer`（27 行） | ⚠️ 纯逻辑无回归保护，本次靠 §D.2 的手工探针兜住 |

---

## E. 迁移与数据恢复矩阵（用户最关心的部分）

### E.1 为什么必须卸载重装

Android 要求更新包的签名证书与已装版本**完全一致**，否则安装直接失败：

```
INSTALL_FAILED_UPDATE_INCOMPATIBLE / INSTALL_FAILED_INVALID_APK
```

当前所有已发布版本都是 `fac61745…`（§B.3 实测）。换成私有证书后证书必然不同 →
**唯一的升级路径是「卸载 → 安装」**，没有任何例外、没有平滑过渡的官方手段
（除非继续用那把公开私钥，那等于永远不修 P1-1）。

`DSH-OUTPOST-RELEASE-REPORT.md:147-152` 也已记录同样的结论。

### E.2 本地存储清点（逐项，含 `path:line`）

#### (a) Android Keystore / Keychain —— 卸载即销毁

`secureStore.ts:75-138` 定义 6 个 `CredentialKey`，实际落盘在
`react-native-keychain` 的 service `com.dshpocket.credentials.<key>`：

| # | 键 | 内容 | 能力 | 卸载后 | 可否恢复 |
|---|---|---|---|---|---|
| 1 | `dsh.cookie` (`:77`) | 会话 Cookie | **能读写 DSH、执行命令** | **丢失** | ✅ 可恢复（重扫码） |
| 2 | `dsh.gatewayToken` (`:79`) | 网关长期 device token | **能在手机端批准命令执行** | **丢失** | ✅ 可恢复（重配对） |
| 3 | `dsh.gatewayDeviceId` (`:81`) | 客户端自生成 `dsh-outpost-xxx` | 仅标识，非秘密 | **丢失** | ✅ 自动重新生成（`approvalGateway.ts:194`） |
| 4 | `dsh.gatewayServerDeviceId` (`:105`) | 服务端注册表主键 UUID | 撤销设备时用 | **丢失** | ⚠️ 重配对后可再拿到（服务端 `paired` 帧回传） |
| 5 | `dsh.gatewayServerBinding` (`:126`) | `{baseUrl, gatewayId, deviceId}` 三元组 | 判断 UUID 属于哪台服务器 | **丢失** | ✅ 重配对后重建 |
| 6 | `dsh.revocationMarker` (`:137`) | 撤销标记的 Keystore 降级副本 | 阻止自动重新授权 | **丢失** | ❌ 但 `@dsh/approvalRevoked` 也一起没，见下 |

> **技术事实**：Android Keystore 里的密钥在**应用卸载时由系统销毁**，且不可导出、不可备份。
> 即使用 `allowBackup=true` 也备份不了 Keystore 别名。本 App 还额外设了
> `AndroidManifest.xml:27 android:allowBackup="false"`，所以连普通应用数据都不在系统备份里。
> → **卸载后本地没有任何可恢复的数据**。

#### (b) AsyncStorage 键 —— 卸载即删除

全仓库 `*KEY*` 常量清点（共 15 个业务键 + 4 个历史明文键）：

| # | 键 | 定义处 | 用途 | 卸载后 | 可否恢复 |
|---|---|---|---|---|---|
| 1 | `@dsh/baseUrl` | `App.tsx:65` | DSH 地址 | 丢失 | ✅ 重新输入/扫码（`pairing.ts:28` `normalizeBaseUrl`） |
| 2 | `@dsh/ownedSessions` | `App.tsx:66` | 我创建的会话列表 | 丢失 | ⚠️ 部分（DSH 侧 `session/list` 能重新拉，但「归属」标记是纯本地的） |
| 3 | `@dsh/themeMode` | `App.tsx:67` | 主题 | 丢失 | ❌ 需手动重设（无服务端副本） |
| 4 | `@dsh/butlerMode` | `App.tsx:68` | 管家开关 | 丢失 | ❌ 需手动重开 |
| 5 | `@dsh/butlerSession` | `App.tsx:69` | 管家会话 id | 丢失 | ⚠️ 会话在 PC 上还在，但 App 不知道是哪个了 |
| 6 | `@dsh/butlerWorkspace` | `App.tsx:71` | 管家绑定工作区 | 丢失 | ⚠️ 需重选工作区 |
| 7 | `@dsh/butlerSessionsByWs` | `App.tsx:79` | 工作区→会话映射 | 丢失 | ⚠️ 同上 |
| 8 | `@dsh/butlerPrimed` | `App.tsx:80` | 一次性引导标记 | 丢失 | ✅ 无影响 |
| 9 | `@dsh/archivedSessions` | `store.ts:38` | **已归档会话 id** | 丢失 | ❌ **不可恢复**（`store.ts:37` 注释：DSH 不返回归档状态，只能客户端自己记） |
| 10 | `@dsh/workspaceCustom` | `workspace-custom.ts:15` | 工作区别名/emoji | 丢失 | ❌ 不可恢复（纯展示层覆盖，PC 上没有） |
| 11 | `@dsh/recentWorkspaces` | `WorkspacesScreen.tsx:47` | 最近工作区 | 丢失 | ✅ 使用后自然重建 |
| 12 | `@dsh/butlerPlan` | `ChatScreen.tsx:58` | 管家计划模式 | 丢失 | ❌ 需手动重设 |
| 13 | `@dsh/loginIntent` | `loginIntent.ts:79` | 登录意图三态 | 丢失 | ✅ 无影响（键不存在按 `active` 处理，`:147-151`） |
| 14 | `@dsh/approvalRevoked` | `deviceRevocation.ts:113` | **撤销标记主副本** | 丢失 | ⚠️ 见 E.4 |
| 15 | `@dsh/cookie` `@dsh/gatewayToken` `@dsh/gatewayDeviceId` `@dsh/lastCookie` | `credentialMigration.ts:93-99` | 旧版明文凭据 | 丢失 | ✅ **本来就应该清掉**（丢掉是好事） |

#### (c) 原生 CookieJar —— 卸载即清空

`App.tsx:879-885` 明确：登录时 `credentials:'include'` 让 RN 原生层把 `dsh-auth-*`
存进 `CookieManager`，这是**独立于 Keystore 的第三份凭据**。卸载必然清空。

### E.3 DSH 侧（PC 上）的状态 —— 全部保留

| 项 | 卸载重装后 | 依据 |
|---|---|---|
| 会话列表 / 历史 / 内容 | **完好无损** | 全部在 PC 上的 DSH 服务里，手机只是客户端 |
| 任务 / 计划 / agent 运行记录 | **完好无损** | 同上 |
| 工作区 / 文件 | **完好无损** | 同上 |
| **服务端设备注册表记录** | **保留，但变成孤儿** | 见 E.4 |

### E.4 ⚠️ 两个「服务端残留」问题，必须让用户知道

**(1) 孤儿设备记录**

卸载不会通知服务端。服务端 `GET /mgw/devices`（`deviceAuth.ts:14,170`）里那台旧设备**仍然存在且仍被信任**，
只是再也连不上了。手机重装后会产生**新的** `gatewayDeviceId`（`approvalGateway.ts:194` 重新生成），
于是列表里会出现两条：旧的（永久离线）+ 新的。

→ **必须由用户在 PC 上手动撤销旧记录**，否则「丢了手机也踢不掉」的观感会保留，且审批列表会脏。
撤销接口：`POST /mgw/devices/<id>/revoke`（`deviceAuth.ts:15`），见 §F 第 6 步。

**(2) 撤销标记 `@dsh/approvalRevoked` 丢失 —— 这是唯一有安全含义的丢失**

`deviceRevocation.ts:113` 的 `@dsh/approvalRevoked` 记录的是「用户已经撤销过审批授权」。
卸载后它和它的 Keystore 降级副本（`CredentialKey.revocationMarker`）**同时消失**。

后果：如果用户当初撤销过授权，重装后这个「别再自动授权」的证据没了。
但因为**Keystore 里的凭据也一起没了**，`loadLoginIntent()` 会说「没凭据就别自动登录」
（`loginIntent.ts:147-151` + 凭据为空），所以**实际不会自动恢复授权** —— 需要用户重新扫码配对。

→ 净结论：**安全上不退化**（无凭据即无法自动授权），但用户的心理预期要交代清楚：
「以前撤销过的那台设备，重装后不会自动恢复；你必须重新扫码才会重新获得授权。」

### E.5 配对关系能否重建 —— 已验证

`transport/index.ts:176` `loginWithToken(token)` 的完整链路：

```
1. 用户在 PC 上跑 start-dsh-web.ps1
   → 脚本从日志抓 token URL（start-dsh-web.ps1:323）
   → 把 {url, token, host, port} 写入 pairing.json（:346-357），供插件渲染二维码
2. 手机扫码 → pairing.ts:35 parsePairingText() 解析出 {baseUrl, token}
3. PairScreen.tsx:124 new DshConnection({baseUrl}) → :127 store.loginWithToken(token)
4. transport/index.ts:183 GET {baseUrl}/?token=...  (credentials:'include')
5. :206 readCookieFromJar() 从原生 CookieManager 读回 cookie
6. PairScreen.tsx:140 saveCookie(cookie) → 写回 Keystore
```

**✅ 配对完全可通过「重新扫一次二维码」重建，不依赖任何卸载前遗留的数据。**
token 是每次启动新生成的（`start-dsh-web.ps1:323` 从日志实时抓），所以旧的丢失没有影响。

> 前提：`baseUrl` 要填回原来的地址 —— 但它也丢了。用户需要知道「我的 DSH 跑在哪个地址」。
> 建议在升级公告里提醒用户**先记下自己当前的 DSH 地址**。

### E.6 数据丢失矩阵（汇总）

#### 分类 A：**永久丢失，不可恢复**（必须在公告里点名）

| 数据 | 定义处 | 为什么不可恢复 |
|---|---|---|
| 已归档会话的归档状态 | `store.ts:38` | DSH 不返回归档状态，纯客户端记忆 |
| 工作区自定义名 / emoji | `workspace-custom.ts:15` | 纯展示层覆盖，PC 上没有 |
| 主题 / 管家开关 / 管家计划模式 | `App.tsx:67,68`、`ChatScreen.tsx:58` | 纯本地偏好 |
| 我创建的会话的「归属」标记 | `App.tsx:66` | 服务端无此字段 |

#### 分类 B：**丢失但可重建**（用户操作几步即恢复）

| 数据 | 重建方式 |
|---|---|
| 会话 Cookie（`dsh.cookie`） | 重新扫码配对 |
| 网关 token / 设备 id / 服务端绑定 | 重新扫码配对（`approvalGateway.ts:194` 自动重生成） |
| DSH 地址（`@dsh/baseUrl`） | 重新输入或扫码带入（`pairing.ts:28`） |
| 管家会话绑定 / 工作区映射 | 重新选一次工作区 |
| 最近工作区 | 用着用着自然回来 |

#### 分类 C：**完全不受影响**

| 数据 | 位置 |
|---|---|
| 所有会话内容 / 历史 / 任务 / 计划 | PC 上的 DSH 服务 |
| 工作区文件 | PC 磁盘 |
| App 版本 / 更新能力 | 重装即为最新版 |

#### 分类 D：**服务端残留，需 PC 上手动清理**

| 数据 | 处理 |
|---|---|
| 旧的设备注册记录（孤儿） | PC 上 `POST /mgw/devices/<id>/revoke`，或删 DSH 网关状态文件后重启 |

#### 分类 E：**安全上无退化**

| 数据 | 说明 |
|---|---|
| `@dsh/approvalRevoked` + `revocationMarker` | 一起丢失，但凭据也一起没了 ⇒ 不会自动恢复授权，须重新扫码 |

### E.7 建议的迁移 UX（最安全的做法）

**关键的取舍：不要让用户「点一下更新就自动装」。** 必须把「要卸载」这件事说在前面，
否则用户在设置里看到 `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 只会以为是 bug。

#### 方案（三步，按顺序实施）

**第 1 步：过渡版公告（在最后一次 debug 签名版本里出现）**

在 `ProfileScreen` 的「检查更新」位置附近，当 detection 到「当前安装是 debug 证书」且「最新包不是 debug 证书」时，
显示一个**不可跳过的解释卡片**：

```
⚠️ 下一版本将更换为正式签名证书
   由于 Android 的签名限制，你**无法直接覆盖安装**。

   需要你手动操作：
   1) 先记下你的 DSH 地址（我的 → 连接信息：http://<ip>:<port>）
   2) 卸载本 App（本地偏好会被清除：主题、工作区别名、归档状态）
   3) 到 Release 页面下载新版本安装
   4) 重新扫码配对

   不会丢：你在电脑上的所有会话、任务、工作区文件。
   会丢：App 内的主题设置、工作区别名/emoji、会话归档标记。
   会丢：配对关系（需重新扫码，30 秒）。
```

**第 2 步：升级前把「要记的东西」给用户抄下来**

在同样的卡片里提供一个「复制我的连接信息」按钮，复制 `baseUrl`，
让用户能粘到别处（微信/备忘录）。这比让用户自己去翻 IP 现实得多。

**第 3 步：新版本首启检测「是否是换签名后的第一次」**

若检测到是从「无任何本地凭据的全新安装」启动，且用户此前装过（无法判断，故不做自动判断），
直接在配对页顶部加一条：

```
换签名版本首次安装？这是正常的：旧版本必须卸载才能升级。
如果你还没卸载旧版本，请先记下 DSH 地址再卸载。
```

#### 能减少损失的办法（按性价比排序）

| 办法 | 收益 | 成本 | 建议 |
|---|---|---|---|
| **过渡版里加解释卡片** | 高（避免用户懵） | 低（一个组件） | ✅ **必做** |
| **升级前「复制 DSH 地址」按钮** | 高（省掉用户翻 IP） | 极低 | ✅ **必做** |
| **把 `@dsh/workspaceCustom` / `@dsh/archivedSessions` 导出到剪贴板/文件** | 中（不可恢复的数据能带走） | 中（导出/导入 UI） | 🟡 可选，若要极致体贴 |
| **在 PC 侧持久化「工作区别名」** | 高（彻底消除一类丢失） | 高（要改 DSH 协议） | ❌ 本次不建议 |
| **保留 debug 证书继续发版** | 用户零感知 | — | ❌ **绝对不行**，等于永不修 P1-1 |

> **不要**尝试用「两个 APK 共存」来规避卸载：那需要改 `applicationId`，
> 会导致用户在两个 App 之间迁移数据，体验更糟，且旧的那个永远是公开私钥签名的活靶子。

### E.8 待验证事项（本节未能实测的部分）

| 项 | 状态 | 原因 |
|---|---|---|
| 卸载是否真的销毁 Keystore 条目 | **待验证** | 本机 `adb devices` 为空，无模拟器（`D:\Android\Sdk\emulator\emulator.exe` 不存在，`_android-home\avd` 为空目录）。这是 Android 平台**文档保证**的行为，但本轮未在真机复现 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 的实际报错文案 | **待验证** | 同上，需要一台装了旧包的设备 |
| 重装后 `@dsh/*` 是否全部为空 | **待验证** | 同上 |
| 孤儿设备记录的实际表现 | **待验证** | 需要一台运行中的 DSH 服务 + 卸载后重装 |

---

## F. 管理员必须手工完成的步骤

> 以下每一步都**无法自动化**（需要人事决策、机器外保管、GitHub 网页操作）。
> **不要**把密码写进仓库、写进 CI、写进 issue、写进聊天记录。
> 本节所有密码都用 `<PLACEHOLDER>`，请替换为强随机值。

### F.0 前置决策：定一个新的 `applicationId`？—— **不要**

签名轮换**不需要**改 `applicationId`（`build.gradle:82 com.dshpocket`）。
改了会让新旧 App 共存，反而复杂化。**保持 `com.dshpocket` 不变。**

### F.1 第 1 步：生成私有 release keystore（在离线机器上做）

```powershell
# 1) 在**离线/可信**机器上执行（不要在 CI runner 里生成）
# 2) keytool 来自 JDK 21：D:\Jdk21\bin\keytool.exe
# 3) 建议有效期 ≥ 25 年（Google Play 要求到 2033 年后；APK 自签名也建议长有效期）

& 'D:\Jdk21\bin\keytool.exe' -genkeypair `
  -keystore dsh-outpost-release.jks `
  -alias dsh-outpost `
  -keyalg RSA -keysize 4096 `
  -validity 10000 `
  -storetype PKCS12 `
  -dname "CN=DSH Outpost, OU=Release, O=<YOUR_ORG>, L=<CITY>, ST=<PROVINCE>, C=CN" `
  -storepass '<STRONG_STORE_PASSWORD>' `
  -keypass '<STRONG_KEY_PASSWORD>'
```

要点（都是踩过的坑）：

| 要点 | 原因 |
|---|---|
| `-storetype PKCS12` | JKS 已弃用；PKCS12 是 Android 官方推荐，且 `storepass` 与 `keypass` 建议相同（PKCS12 要求一致） |
| `-keysize 4096` | 别再用 2048；这把密钥要用十几年 |
| `-validity 10000`（≈27 年） | 密钥过期后**无法再签更新**，只能再次卸载重装 |
| `-dname` 里别写真实姓名/邮箱 | 证书 DN 是**公开**的，会出现在每个 APK 里 |
| 不要在 CI 里跑这条命令 | runner 是一次性的，私钥会留在日志/临时目录 |

**验证生成结果**（记下输出里的 SHA-256，第 4 步要用）：

```powershell
& 'D:\Jdk21\bin\keytool.exe' -list -v `
  -keystore dsh-outpost-release.jks `
  -alias dsh-outpost `
  -storepass '<STRONG_STORE_PASSWORD>'
```

从输出里找这一行并**抄下来**（去掉冒号、转小写）：

```
SHA256: <AA:BB:CC:...>     →  第 4 步的 EXPECTED_CERT_SHA256 用它
```

> ⚠️ **绝对不要**让它等于 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。
> 如果相等，说明你在用仓库里那份公开 keystore —— 立即重做。

### F.2 第 2 步：密钥保管（**这一步比生成更重要**）

私钥丢失 = **永远无法再给老用户发更新**（只能再让所有人卸载重装一次）。

| 要求 | 做法 |
|---|---|
| **至少 2 份离线备份** | 两块不同的物理介质（U 盘 / 加密移动硬盘），存放在不同地点 |
| **备份必须加密** | 用 7-Zip AES-256 或 VeraCrypt 容器；密码与 keystore 密码**不同** |
| **密码与密钥分开保管** | keystore 文件在一处、`storepass`/`keypass` 在密码管理器（另一处） |
| **不要**放进 | Git 仓库、云盘同步目录（OneDrive/iCloud/Dropbox）、聊天记录、邮件、CI 变量以外的任何地方 |
| **不要**提交 | `.gitignore:41-45` 已挡 `*.jks` / `*.keystore` / `release.keystore`，但**别依赖它**，提交前 `git status` 自己看一眼 |
| **记录恢复演练** | 每半年用备份 + 密码在离线机器上跑一次 `keytool -list`，确认备份真的能用 |
| **交接约定** | 若项目多人维护，明确「谁是密钥保管人」并留一份应急开启流程给信任的人 |

### F.3 第 3 步：配置 4 个 GitHub Secrets

GitHub 网页操作（仓库 → **Settings → Secrets and variables → Actions → New repository secret**）：

| Secret 名 | 值 | 生成命令 |
|---|---|---|
| `KEYSTORE_BASE64` | keystore 文件的 base64（**单行**） | `[Convert]::ToBase64String([IO.File]::ReadAllBytes('dsh-outpost-release.jks'))` |
| `KEYSTORE_PASSWORD` | 上一步的 `<STRONG_STORE_PASSWORD>` | 手工输入 |
| `KEY_ALIAS` | `dsh-outpost` | 手工输入 |
| `KEY_PASSWORD` | 上一步的 `<STRONG_KEY_PASSWORD>` | 手工输入 |

`KEYSTORE_BASE64` 的正确生成方式（PowerShell，输出单行、无换行）：

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('dsh-outpost-release.jks'))
$b64 | Set-Clipboard      # 直接粘到 GitHub 网页，别经过中间文件
```

> Linux/macOS 等价命令：`base64 -w0 dsh-outpost-release.jks | pbcopy`
>
> ⚠️ **不要**用 `base64` 不带 `-w0`（会插入换行 → `android.yml:274` 的 `base64 -d` 仍能解，但历史上踩过这个坑）。
> 粘贴后**清空剪贴板**。

CI 侧对应读取：`android.yml:188-191`（Gate 1）与 `:267-269`（Gate 3）。

### F.4 第 4 步：配置 `EXPECTED_CERT_SHA256` 仓库变量

**注意：这是 Variables，不是 Secrets**（代码里读的是 `vars.`，`android.yml:343`）。

仓库 → **Settings → Secrets and variables → Actions → Variables 标签 → New repository variable**：

| 名称 | 值 |
|---|---|
| `EXPECTED_CERT_SHA256` | 第 1 步 `keytool -list -v` 输出的 SHA256，**去掉冒号、全小写** |

```
示例格式：0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
（64 位小写 hex，无冒号）
```

CI 侧会自动把大小写和冒号归一（`android.yml:345-346`）：
`tr 'A-F' 'a-f'` + `tr -d ':'`，所以填带冒号的大写形式也能过。
但仍建议填规范形式，方便人工比对。

> 🔴 **不配这个变量的后果**：`android.yml:362-365` 会直接 `exit 1`，
> **Release job 100% 失败，发不出版本**。这是预期行为（门禁默认开启），不是 bug。

### F.5 第 5 步：抬 `versionCode` 水位线（**极易忘，忘了就发不出去**）

`.github/release-floor.json` 当前：

```json
"minVersionCode": 16200,
"publishedVersion": "0.16.2"
```

Gate 2 要求**严格大于**水位线（`version-code.mjs:181`）。
当前 HEAD 是 v0.16.6，下一个 tag 若是 `v0.17.0` → 算出 170000 > 16200 ✅ 没问题。
但若想发 `v0.16.7` → 160700 > 16200 ✅ 也没问题。

**真正要注意的是每次正式发布成功后**，手动把 `minVersionCode` 抬到刚发布的那个值：

```jsonc
// 发布 v0.17.0 之后
"minVersionCode": 170000,
"publishedVersion": "0.17.0"
```

> 历史教训记在 `.github/release-floor.json` 的 `note` 里：旧公式给 v0.16.3 算出 16003，
> 而验收包已经是 16200 → 用户装不上。这就是水位线存在的原因。

### F.6 第 6 步：清理服务端孤儿设备记录 + 准备迁移公告

**(a) 清理孤儿设备**

用户卸载重装后，PC 上的设备注册表会残留旧记录。发布后**在过渡期**建议告知用户：

```powershell
# 在 PC 上，DSH 运行中时查看已配对设备
curl.exe -s "http://127.0.0.1:<port>/mgw/devices" -H "Cookie: <你的会话cookie>"
```

或直接让用户用 App 的「我的 → 设备管理」页自己撤销（`dsh-mobile/src/screens/DevicesScreen.tsx`）。
服务端接口：`POST /mgw/devices/<id>/revoke`（`deviceAuth.ts:15`）。

**(b) 迁移公告（必须写，否则老用户会以为 App 坏了）**

在 Release body 里显式加入（当前 `android.yml:420-446` 的 body 模板没有这一段，需补）：

```markdown
### ⚠️ 本次更新必须卸载重装（签名证书更换）

为修复「更新包使用公开调试证书」的安全问题，本版本改用正式签名证书。
Android 要求签名一致才能覆盖安装，因此**你无法直接升级**。

请按以下步骤操作：
1. 在旧版 App 里记下你的 DSH 地址：我的 → 连接信息
2. **卸载**旧版 App（本地偏好会清除）
3. 下载并安装本版本
4. 重新扫码配对

**不会丢**：电脑上的所有会话、任务、计划、工作区文件。
**会丢**：主题设置、工作区别名/emoji、会话归档标记（这些仅存在手机本地）。
**会丢**：配对关系（重新扫码即可恢复，约 30 秒）。
```

### F.7 第 7 步（发布前自检清单）

发布 tag **之前**逐项打勾：

- [ ] keystore 已生成，`SHA256` ≠ `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
- [ ] keystore 已做 **≥2 份**加密离线备份，且做过一次恢复演练
- [ ] 4 个 Secrets 已配：`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`
- [ ] 变量 `EXPECTED_CERT_SHA256` 已配（Variables 不是 Secrets），值 = 新证书指纹
- [ ] **两处门禁改动已提交**（`build.gradle` + `android.yml`）—— 见 §A.4，否则发的还是旧门禁
- [ ] **§A.3 的回归已修**（否则 `build-test` job 永远红）
- [ ] `git status` 里没有 `*.jks` / `*.keystore` 被意外 staged
- [ ] 新 tag 满足 `versionCode > 16200`
- [ ] Release body 已加入 §F.6(b) 的迁移公告
- [ ] 发布后在真机上确认：`apksigner verify --print-certs` 的 SHA-256 == `EXPECTED_CERT_SHA256`

### F.8 生成之后如何自查（不改任何代码）

```powershell
# 拿 CI 产物或本地签名包核对（只读操作，不签名）
& 'D:\Android\Sdk\build-tools\34.0.0\apksigner.bat' verify --print-certs `
    .\dsh-outpost-v0.17.0.apk
```

期望输出里的 `Signer #1 certificate SHA-256 digest` **必须等于**你填进
`EXPECTED_CERT_SHA256` 的那个值，且**不等于** `fac61745…`。

---

## 附录：本次核验用到的命令（可复现）

```powershell
# 证书比对（不传密码，密码由脚本从 build.gradle 读取）
& 'D:\Android\Sdk\build-tools\34.0.0\apksigner.bat' verify --print-certs <apk>
& 'D:\Android\Sdk\build-tools\34.0.0\apksigner.bat' verify --verbose <apk>
& 'D:\Android\Sdk\build-tools\34.0.0\aapt2.exe' dump badging <apk>

# gradle 门禁探针
$env:GRADLE_USER_HOME='E:\work\dsBot\_gradle-home'
.\gradlew.bat --no-daemon --offline --console=plain :app:assembleDebug -m
.\gradlew.bat --no-daemon --offline --console=plain :app:assembleRelease -m -PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true

# Gate 2 单调递增
node dsh-mobile/scripts/version-code.mjs --tag v0.16.3

# 门禁静态断言测试
cd dsh-mobile; npm run test:security      # 结果：60 通过，0 失败
```

## 附录：本文档未能验证的事项（汇总）

| 项 | 状态 | 原因 |
|---|---|---|
| v0.16.3 之前究竟发布过几个 Release | **无法确定** | 沙箱无法访问 `github.com` / `api.github.com`（DNS 解析到非公网 IP） |
| 哪些具体版本被公开下载过 | **无法确定** | 同上 |
| `app-release.apk`（本地）的确切构建命令 | **待验证** | 构建日志中没有签名参数记录 |
| 卸载真的销毁 Keystore 条目 | **待验证** | 无可用真机/模拟器（`adb devices` 为空） |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` 实际行为 | **待验证** | 同上 |
| 重装后 `@dsh/*` 是否全为空 | **待验证** | 同上 |
| 孤儿设备记录的实际表现 | **待验证** | 需要运行中的 DSH + 真机 |
| `EXPECTED_CERT_SHA256` 当前是否已在 GitHub 上配置 | **无法确定** | 需要仓库 Settings 权限，无法从本地读取 |
