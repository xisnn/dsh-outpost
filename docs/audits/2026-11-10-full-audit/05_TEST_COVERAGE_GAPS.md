# 05 · 测试与 CI 覆盖缺口

审计基线：`E:\work\dsBot-opt` 工作区 HEAD `2325d34`（分支 `opt/p1-phone-polish`，工作树干净）。
本轮**只审计、未修改任何业务代码**。

---

## 〇、方法论声明（必读）

本文档的所有数字都来自**明确标注的方法**，不使用任何未验证的推断：

| 方法 | 用途 | 局限性 |
|---|---|---|
| **import-graph grep** | 判定某个源文件"是否被任何测试加载过" | 只能回答"加载了吗"，**不能**回答"语句/分支覆盖了多少" |
| **workflow YAML 直读** | 判定 CI 跑了哪些命令 | **未访问任何 CI 运行日志/产物**（无网络），因此不对"CI 当前是绿是红"做任何断言 |
| **真实执行 4 个只读 spec** | 取得少量真实耗时数据 | 本地 Node v24.13.0 / Windows，**不是** CI 的 Node 20 / ubuntu-latest |

### 覆盖率分类定义

| 标记 | 含义 |
|---|---|
| **EXEC** | 被至少一个测试真实 `import` / `require`，代码体被执行 |
| **TEXT-ONLY** | 只被 `readFileSync` 读成字符串做正则断言，**代码体从不执行** |
| **MOCK-ONLY** | 被 module hook 替换成一个字符串常量，**代码体从不执行** |
| **MENTION-ONLY** | 只在文档 / 注释 / 配置里被提到 |
| **NONE** | 全仓 grep **零**引用 |
| **SKIP** | 存在但在所有路径下被跳过 |

### ⚠️ 本轮**未执行**的内容

按宪章"禁止编造测试结果"，以下明确声明**没有跑过**：

- ❌ 完整的 `npm test` 链（103 个 spawn）
- ❌ `npm run test:integration`
- ❌ `npm run test:node20`
- ❌ `tsc --noEmit`
- ❌ 任何 `gradlew` 调用（含 `:agent-core:test`）
- ❌ 任何 `npm ci` / 依赖安装
- ❌ 任何构建（debug / release APK）
- ❌ 任何模拟器 / instrumented 测试
- ❌ 任何覆盖率工具（仓库里**根本不存在**覆盖率工具，见 TEST-15）

**因此本文档不包含：**
- "测试套件当前是通过还是失败"的任何断言
- "总耗时多少秒"的任何断言
- 任何百分比形式的**语句/分支覆盖率**

### ✅ 本轮**真实执行**过的（只读，本地环境）

| 命令 | 结果 | 环境 |
|---|---|---|
| `node tests/cwd-spec.mjs` | exit 0，0.173s | Node v24.13.0 / Windows（**非 CI**） |
| `./node_modules/.bin/tsx tests/updater-spec.mjs` | exit 0，0.828s | 同上 |
| `tsx tests/teammate-spec.mjs` | exit 0，0.743s | 同上 |
| `node tests/version-code-spec.mjs` | **25 pass / 0 fail**，`duration_ms 31`，exit 0，总 0.227s | 同上 |

其余所有耗时数字都是**标注过的算术外推**，不是测量值。

---

## 一、CI 矩阵（直读 workflow YAML）

### 1.1 `.github/workflows/android.yml`

| Job | 触发 | Runner | Node / JDK | 执行内容 |
|---|---|---|---|---|
| **`test`** | push tag `v*` + `workflow_dispatch` | `ubuntu-latest`（`:53`） | node 20（`:63`）；**无 setup-java** | env `DSH_GATEWAY_PLUGIN_DIR = ${{ github.workspace }}/dsh-mobile/node_modules/dsh-plugin-mobile-gateway`（`:57`）→ dsh-mobile `npm ci`（`:69`）→ dsh-mobile `npm test`（`:73`）→ butler `npm test`（`:78`，**无 install 步骤**）→ `npm run test:integration`（`:83`）→ `npm run test:node20`（`:90`） |
| **`desktop`** | needs `test` | `windows-latest`（`:94`） | node 20（`:99`） | 版本一致性 `node -e`（`:105`）→ `npm ci` → `npm test`（`:111`）→ `npm run pack`（`:114`）→ 上传产物 |
| **`build-test`** | **仅 `workflow_dispatch`**（`:126`） | ubuntu | node 20 / temurin **21**（`:141`） | sdkmanager：ndk `27.1.12297006`、`platforms;android-36`、`build-tools;36.0.0`（`:143-155`）→ Gradle cache → `npm ci` → `./gradlew --no-daemon :app:assembleDebug`（`:184`）→ `npm pack ./dsh-outpost-butler` + `sha256sum`（`:189-192`） |
| **`release`** | tag `v*`（`:208`），needs `[test, desktop]` | ubuntu | node 20 / temurin 21 | Gate1 secrets（`:234`）→ SDK/NDK → **Gate2** `node scripts/version-code.mjs --tag`（`:301`）→ **Gate3** keystore + `keytool -list`（`:313`）→ `./gradlew :app:assembleRelease`（`:350`）→ **Gate4** `apksigner verify --verbose/--print-certs`、`aapt2 dump badging`、包名/VC/VN 一致性、debug 证书黑名单（`:361-455`）→ `softprops/action-gh-release@v2` |

### 1.2 `.github/workflows/signing-verify.yml`

| Job | 触发 | 权限 | 内容 |
|---|---|---|---|
| **`verify-signing`** | **仅 `workflow_dispatch`**（`:35`） | `contents: read`；**timeout 45 分钟**（`:54`） | secrets 预检 → SDK/NDK → `npm ci` → **pwsh 存在性硬检查**（`:133-144`）→ `npm test`（`:149`）→ `npm run test:integration`（`:153`）→ keystore → `readFloor()`（`:207`）→ `assembleRelease`（`:242,401,415`）→ 证书/scheme/identity/更新链验证 → **负向测试**：`-m` 必须失败（`:411`） |

### 1.3 回答六个关键问题

| 问题 | 答案 |
|---|---|
| CI 里被测试的包 | **dsh-mobile**（完整 `npm test`，103 个 spawn）、**dsh-outpost-butler**、**dsh-outpost-desktop** |
| CI 里**完全没测**的包 | **`dsh-plugin-connect`** —— 它的 `package.json` 里**没有 `scripts` 块**，且**零** workflow 引用 → **TEST-18** |
| `tsc --noEmit` 跑了吗 | **跑了**，但只作为 `&&` 链的**最后一环**（`dsh-mobile/package.json:18` 结尾是 `… && npm run typecheck`；`typecheck = tsc --noEmit` @ `:10`）。**任何 workflow 都没有单独点名它** → 关联 **BUG-01** |
| `:agent-core:test` 跑了吗 | **从未被调用**。workflow 里只出现 `:app:assembleDebug` / `:app:assembleRelease`。4 个 Kotlin 文件里的 **38 个 `@Test` 方法从不执行**。（`app/build.gradle:257` 的 `implementation project(':agent-core')` 只保证它的 main 源码被编译）→ **TEST-17** |
| androidTest 跑了吗 | **没有**。3 个文件 / 7 个 `@Test`，**没有配置任何模拟器**，没有 `connectedAndroidTest` 步骤 → **TEST-17** |
| 覆盖率测量 | **完全没有**。全仓 grep 无 c8 / nyc / istanbul / `--experimental-test-coverage` / jacoco / kover → **TEST-15** |

### 1.4 发布门禁的真实状态

| 文件 | 是否被 CI 强制执行 | 证据 |
|---|---|---|
| `release-floor.json` | ✅ **强制执行** | `android.yml:301`、`signing-verify.yml:207` 都调 `version-code.mjs` 的 `readFloor()` |
| `release-budgets.json` | ❌ **死配置** | 只被 `dsh-mobile/scripts/release-gate.mjs:31` 读取，而 `release-gate.mjs` **没有任何调用者** |
| `release-signing.json` | ❌ **死配置** | 同上（`release-gate.mjs:35`） |

我做了穷举验证：跨 `.github/`、`scripts/`、所有 `*.ps1`、所有 manifest grep `release-gate` —— **只命中它自己的文档注释**。

**后果**：`apkBytesMax: 100000000`、`runtimeArchiveBytesMax`、`knownGoodCertificateSha256` 三项**从未被强制**。而 CI 把 debug 证书指纹**硬编码在 YAML 里**（`android.yml:400`），不读 `release-signing.json:testOnlyDebugCertificates` → **两个真值来源** → **TEST-14**。

---

## 二、覆盖缺口地图（import-graph grep）

### 2.1 `dsh-mobile/src` —— 188 个 `.ts`/`.tsx`，45,492 行

| 分类 | 文件数 | 占比 |
|---|---|---|
| EXEC | 109 | 58% |
| TEXT-ONLY | 27 | 14% |
| MENTION-ONLY | 20 | 11% |
| MOCK-ONLY | 7 | 4% |
| NONE | 21 | 11% |
| SKIP | 4 | 2% |

**→ 188 个文件里有 75 个（40%）没有被任何测试证明执行过。**

#### NONE 且体量大的

| 文件 | 行数 | 备注 |
|---|---|---|
| `screens/AgentDemoScreen.tsx` | 579 | |
| `screens/AgentSettingsScreen.tsx` | 491 | **含 Keystore 密钥管理 UI** |
| `dev/P0Harness.tsx` | 475 | 开发工具（关联 ARCH-06） |
| `screens/BackgroundDisplayScreen.tsx` | 429 | |
| `screens/ButlerMemoryScreen.tsx` | 427 | |
| **`components/DirectoryBrowser.tsx`** | **332** | **文件系统 / 路径穿越 UI —— 零测试** |
| `screens/PairingHelpSheet.tsx` | 272 | |
| `screens/AgentMemoryScreen.tsx` | 250 | |
| `screens/TeamSheet.tsx` | 220 | |
| `components/useLocalRuntime.ts` | 212 | |
| `components/TeamBar.tsx` | 198 | |
| `core/textdecoder.ts` | 136 | |
| `core/butlerSessionOwnership.ts` | 54 | |
| `core/localRuntimeBridge.ts` | 50 | |

#### MOCK-ONLY（被替换成字符串，代码体从不执行）

| 文件 | 行数 | Mock 点 |
|---|---|---|
| **`screens/AgentButlerScreen.tsx`** | **1030** | **App 的主力 butler 屏幕**，在 `tests/butler-activity-notify-spec.mjs:71` 被 mock 成 `{AgentButlerScreen: 'AgentButler'}` |
| `screens/LocalButlerScreen.tsx` | 802 | 同时也是 **ARCH-07** 的零引用死代码 |
| `core/rpc/model.ts` | 107 | |
| `components/MotionModal.tsx` | 83 | |
| `components/TaskMotion.tsx` | 82 | |
| `components/MotionPressable.tsx` | 60 | |
| `components/LoadingSkeleton.tsx` | 49 | |

#### TEXT-ONLY（只被 `readFileSync` 成正则断言）

| 文件 | 行数 | 备注 |
|---|---|---|
| `screens/SessionsScreen.tsx` | 727 | |
| `nav/NavHost.tsx` | 535 | 导航核心 |
| `screens/DevicesScreen.tsx` | 530 | |
| `screens/DocumentViewer.tsx` | 514 | |
| `screens/PairScreen.tsx` | 506 | |
| **`core/updater.ts`** | **392** | **APK 下载与完整性校验**，唯一断言是 `security-remediation-spec.mjs:89-95` 的 `check(/verifyApkIntegrity/.test(updater))` —— **只证明函数名存在，不证明它正确** |
| `components/MarkdownView.tsx` | 326 | 关联 PERF-04 |
| `screens/ImageViewer.tsx` | 277 | |
| `screens/ToolOutputViewer.tsx` | 276 | |
| `screens/ScanSheet.tsx` | 264 | |
| `components/ChatComposer.tsx` | 260 | |
| `core/fileUrl.ts` | 254 | |
| **`core/net-security.ts`** | **182** | **唯一的明文流量边界**（见 `07` 的安全不可简化清单第 1 条），却只有文本断言 |
| `core/gatewayFiles.ts` | 149 | |
| `core/rpc/upload.ts` | 116 | |
| `design/theme.tsx` | 91 | |
| `components/clipboard.ts` | 33 | |

### 2.2 `dsh-outpost-butler/lib` —— 11 个 `.js`，2,271 行

| 分类 | 文件数 |
|---|---|
| EXEC | 8 |
| MENTION-ONLY | 1 |
| NONE | 2 |

**未被执行的两个：**

| 文件 | 行数 | 为什么重要 |
|---|---|---|
| **`lib/workspace-fs.js`** | **80** | **整个沙箱边界**：`inside()`（`:20-23`）、`verifyRoot()` 的 dev/ino 校验（`:24-27`）、`fresh()` 的 TOCTOU 重解析（`:34-39`）、符号链接拒绝（`:14-16`）。**零测试** → **TEST-06** |
| `lib/contracts.js` | 34 | fail-closed 契约定义 |
| `lib/domain.js` | 138 | MENTION-ONLY |

> **反差**：butler 的测试（2,337 行）对**竞态、审批、日志压缩**的覆盖相当深入（见 `07_REGRESSION_PROTECTION.md`），却漏掉了唯一一个安全边界模块。

### 2.3 `dsh-outpost-desktop/src` —— 3 个 `.js`，1,464 行

| 文件 | 行数 | 分类 |
|---|---|---|
| `src/main/main.js` | 1089 | **TEXT-ONLY** —— `main-logic-spec.mjs:40-41` 把它读成字符串断言 `.includes('requestSingleInstanceLock')`；只有**一个**函数被 `vm.runInNewContext`（`:298`）真正执行过 |
| `src/main/preload.js` | 45 | TEXT-ONLY |
| `renderer/app.js` | 330 | **NONE**（且它读一个不存在的字段，见 **CQ-07**） |

**→ EXEC = 0 / 3。** 仓库根的 `dsh-outpost-desktop/pack.js`（234 行）也无 spec。

### 2.4 `dsh-plugin-connect` —— 4 个文件，3,531 行

| 文件 | 状态 |
|---|---|
| `client.js` | `test-qr.mjs:10` 读成文本，用 `new Function()` 只求值抽出来的 `buildQrMatrix`——**而这个测试本身是坏的**（**BUG-07**）。剩余约 **2,800 行**是浏览器 `window.__ModuleLoader__` 模块，Node 里**不可测** |
| `tunnel-service.mjs` | **535 行，零测试**——它 spawn `start-tunnel.ps1` 和 cloudflared |
| `index.js` | `export function apply() {}`，空实现 |

→ **TEST-18**

---

## 三、测试基础设施的结构性问题

### TEST-01 · `&&` 长链使失败诊断不完整 —— **High**（原 Critical，已按复核意见下调）

> 完整分析见 `03_BUG_AND_SECURITY_RISKS.md` 的 **BUG-01**（该条含复核修订说明）。此处只记测试视角的后果。

`dsh-mobile/package.json:18` 是一条 **103 个 spawn** 的 `&&` 链。后果：

1. **第一个失败即中断** —— 后面的测试从不运行，你永远不知道有多少东西坏了。
2. **`tsc --noEmit` 是最后一环** —— 前面任何测试失败，**类型检查根本不跑**。
3. `component-harness.mjs:17-18` 的模块解析缺陷（见 TEST-02）会让某个 spec **进程级 abort**，把整条链带走。

> **⚠️ 第二方复核修订（2026-11-11）**：本条原标题是"`&&` 长链使失败信号**不可信**"、严重度 **Critical**，并在 `08` §一 里被写成"『测试是绿的』在当前不是一个可信前提"。**复核意见指出：`&&` 链造成的是失败后提前停止、无法收集后续结果，不等于完整通过的测试链产生假绿。采纳 —— 该表述已撤回。**
>
> **正确的表述**：`&&` 链**失败时退出码非零，CI 是红的**；一条**完整跑通**的链意味着 103 条命令全部通过，**绿色是真实的**。危害是**诊断能力**（一次只暴露第一个问题、`tsc` 可能从未执行），不是**信号被伪造**。
>
> **真正会造成假绿的是 TEST-03（静默 skip）**，其 Critical 名额由本条转移过去。三类现象必须分开评价：
>
> | 现象 | 假绿？ | 严重度 | 条目 |
> |---|---|---|---|
> | 失败截断（本条） | ❌ 否 | **High** | TEST-01 ≡ BUG-01 |
> | **静默 skip** | ✅ **是** | **Critical** | **TEST-03** |
> | 测试从未被 CI 执行 | ❌ 否（覆盖空洞） | Medium-High | TEST-17、6 个孤儿 script |
>
> **因此"在修好它之前任何重构的回归信号都不可靠"这个论断也需要限定**：重构的回归信号不可靠，主要是因为 **TEST-12（34 个 `.tsx` 从不渲染）+ TEST-15（无覆盖率度量）+ TEST-03（关键契约可静默跳过）**，其次才是本条的诊断不便。`08` §六 的理由排序已据此调整。

### TEST-02 · `component-harness.mjs` 的解析缺陷会 abort 整个进程 —— **High**

| 项 | 内容 |
|---|---|
| 位置 | `dsh-mobile/tests/support/component-harness.mjs:17-18` |
| 证据 | `:17` `assert.ok(name.startsWith('.'), 'Unmocked native dependency')`；`:18` 硬编码 `+ '.ts'` |
| 后果 | 一个**过期的 `.tsx` mock** → ENOENT → **进程 abort**（不是测试失败，是崩溃）→ 结合 TEST-01 带走整条链 |
| 历史 | 这是提交 `9c17dbd` 的**结构性成因** |
| 修复 | 按 `.ts` / `.tsx` / `/index.ts` / `/index.tsx` 依次尝试 |
| 风险 | 低 |
| 验证 | 故意放一个 `.tsx` mock，断言 harness 能解析而不是 abort |
| 本轮实施 | **建议排期（与 BUG-01 同批）** |

### TEST-03 · 两个关键契约 spec 在插件不可解析时**零断言通过** —— **Critical**（原 High，已按复核意见上调）

> **⚠️ 第二方复核修订（2026-11-11）**：严重度 **High → Critical**。原证据表述"CANDIDATES 列表里没有 `dsh-mobile/node_modules/dsh-plugin-mobile-gateway` 这一项"**不完整，已更正并加强**：
>
> - `android.yml:54-57` 的 `test` job **确实**通过 `DSH_GATEWAY_PLUGIN_DIR` 指向该路径，所以**那个 job 上插件能解析、测试确实在跑**；
> - **但 `signing-verify.yml` 没有设这个变量**（本人 grep 确认 `android.yml` 是唯一设置它的 workflow），而它在 `:147-149` 跑的是**完整的 `npm test`**，runner 是 `ubuntu-latest`（`:53`）→ `USERPROFILE` 未定义、`$HOME/.dsh/…` 不存在 → **`pluginDir === undefined` → 15 条契约断言全部 skip → 两个 spec 均 exit 0 → 该 workflow 报绿**。
>
> **所以这不是"将来可能失效"，而是"今天已经在 `signing-verify.yml` 上失效"。** 完整证据链见 `03_BUG_AND_SECURITY_RISKS.md` 的 TEST-03（证据 A–D）。真正的问题是**没有任何机制保证插件可解析**——解析失败时两个 spec 会静默跳过全部断言并以 0 退出。修复因此是**两部分**：spec 侧加 fail-closed 守卫 + `signing-verify.yml` 补齐环境变量（**必须同时做，否则会把该 workflow 弄红**）。

| 项 | 内容 |
|---|---|
| **受影响 spec** | **恰好 2 个**（本人以"有 skip 计数器 + 退出码不含 skip + 零 `process.env.CI` 引用"三个条件全量筛查 142 个 spec 得出）：`tests/protocol-contract-spec.mjs`、`tests/crosscheck-revoke-self-spec.mjs` |
| **机制** | 两者都是 `process.exitCode = fail === 0 ? 0 : 1` —— **`skip` 完全不参与退出码**；每条依赖插件的断言写成 `if (!src) return { skip: '插件源码不可用' }`（`protocol-contract-spec.mjs` 有 **11** 处、`crosscheck-revoke-self-spec.mjs` 有 **5** 处） |
| **实测复现**（本地 Node v24.13.0，把 `HOME`/`USERPROFILE` 指向空目录、`DSH_GATEWAY_PLUGIN_DIR` 指向不存在路径） | `protocol-contract-spec.mjs`：正常 **16 通过 / 0 跳过** → 复现时 **6 通过 / 10 跳过 / 0 失败 / exit 0**；`crosscheck-revoke-self-spec.mjs`：正常 **5 通过** → 复现时 **0 通过 / 5 跳过 / 0 失败 / exit 0**（**整组零断言**） |
| **两者都在 CI 链上** | `test:contract`（`package.json:96`）与 `test:crosscheck` 均被 `test` 链引用（本人核实；`test:contract` 的键名不是 `test:protocolContract`，容易漏查） |
| **仓库内已有正确范式（关键）** | 同样消费该插件的**第三个** spec `tests/approval-gateway-f01-spec.mjs:60-63` 是 **fail-closed** 的：<br>`if (!pluginDir) { console.error('FAIL: 未找到真实 dsh-plugin-mobile-gateway 插件目录'); process.exit(1); }`<br>**三个 spec 对同一个前置条件给出了两种相反的处理** —— 这是内部不一致，不是设计选择 |
| **另一处对照** | `gateway-startup-gate-spec.mjs:98-100` 也做对了：`if (process.env.CI) bad(...) else console.log('  SKIP  ...')` |
| **不受影响、且本轮刻意不改** | `server-identity-binding-spec.mjs` 也有 skip 计数器，但它的 skip 来自**端口复用竞态**（`:551,554,562`：`端口 ${oldPort} 没能复用`），属环境抖动而非依赖缺失。让它 `skip>0` 即失败会**引入 CI 抖动**，因此**排除在本次修复之外**，另行排期 |
| **后果** | 一旦 `DSH_GATEWAY_PLUGIN_DIR` 被删/写错、上游包布局变化使 `lib/index.mjs` 或 `lib/devices.js` 不再存在、或有人在 `test` job 之外单独跑这两个 spec —— **DSH 审批协议契约（子协议前缀 `dsh-auth.`/`dsh-pair.`、Origin 同源校验、撤销语义、`clientDeviceId` 缺失时的自识别）会全部失去守卫，而 CI 仍是绿的** |
| **修复** | 照抄 `approval-gateway-f01-spec.mjs:60-63` 的 fail-closed 范式，在**插件解析点**加守卫：`process.env.CI` 下解析失败 → 记一条 `FAIL` 并非零退出；本地无插件 → 保留 SKIP 但打印醒目提示。同时把 `skip > 0 && process.env.CI` 也计入非零退出，覆盖"目录解析成功但单个文件缺失"的残余漏洞 |
| **不改的部分** | **不动任何一条断言的判定逻辑**，不动 `CANDIDATES` 的候选顺序，不动本地开发时的 SKIP 行为（否则没有插件的开发者会被挡在门外） |
| 风险 | **低** —— 只在"CI 且插件不可解析"这个**当前必然为假**的分支上改变退出码 |
| 验证 | 负向测试：在 `CI=1` 且 `DSH_GATEWAY_PLUGIN_DIR` 指向空目录的条件下运行两个 spec，断言**退出码非零**；再在插件可用的正常条件下运行，断言**仍为 0 且 skip 为 0**（防止修复把正常路径弄坏） |
| 本轮实施 | **已获授权实施**（复核范围第 3 项） |


### TEST-04 · 三个互不同步的 Cookie jar —— **Medium-High**

| 项 | 内容 |
|---|---|
| 位置 | `tests/support/cookie-fetch.mjs:29`、`tests/support/_cookie-manager-shim.cjs:7`、`tests/support/cookie-manager-stub.mjs:27`（**死的，0 引用**） |
| 证据 1 | shim 自己的注释（`:5-6`）承认无法与 ESM jar 共享状态；测试靠手工桥接：`integration-product.mjs:92-95` 的 `syncJarToCookieManager`，或 `gateway-recovery-spec.mjs:122` 的 `conn.setCookieReader(...)` |
| 证据 2 | **生产代码读原生 jar 优先**，注入的 reader 只是回退（`core/transport/index.ts:320-345`）。所以**测试跑的是生产不会走的那条回退路径**，而真实的 5 秒超时竞争（`:328-331`）与空 `catch (e) {}`（`:340-341`）**从未被触发** |
| 证据 3 | 真实签名是 `clearByName(url, name, useWebKit?)`（`@react-native-cookies/cookies/index.d.ts:32`），而 shim 的 `clearByName(url)`（`:31`）**忽略 `name`、删掉整个 host 桶**。`core/cookieJar.ts:105-109` 声明的是正确的三参形态，所以 `tsc` 满意，**运行时 stub 是错的** |
| 证据 4 | `Cookie.domain / path / expires / secure / httpOnly` 全部被丢弃 → Secure / HttpOnly / SameSite / 过期语义**完全未测** |
| 修复 | 做成**一个** jar 模块，ESM 与 CJS 两个入口都 import 它——用 AsyncStorage 已经做对的模式（`_async-storage-shim.cjs:19-26` 的 `globalThis.__dshTestAsyncStorageState__`）；并把 `clearByName` 的参数个数改对 |
| 风险 | **中** —— 10 个 spec 同时 import 两者 |
| 验证 | 断言 shim 的 `get()` 无需手工同步就能返回 `cookie-fetch` 吸收进去的值；断言 `clearByName(url, 'a')` 不影响同 host 的 `b` |
| 本轮实施 | 建议排期。**是 TEST-09（并行化）的前置条件** |

### TEST-05 · RN shim 冻结了所有环境维度 —— **Medium**

| 冻结项 | 位置 | 后果 |
|---|---|---|
| `AppState.currentState` 恒为 `'active'` | `_react-native-shim.cjs:28` | **前后台切换从不发生** → PERF-03 这类问题**测不出来** |
| `Dimensions` / `useWindowDimensions` 恒为 1080×2400 | `:88, :177` | 响应式断点未测 |
| `useColorScheme` 恒为 `'light'` | `:176` | **暗色主题未测** |
| `Animated.timing/spring` 同步回调 `{finished: true}` | `:171-172` | 动画时序未测 |
| `Linking.canOpenURL` 恒 true | `:76` | 外链降级路径未测 |
| 组件是裸字符串 | `:128-139` | **什么都不渲染、不布局** |

`component-harness.mjs:41` 还把 `useWindowDimensions` 钉在 360×800，与 shim 的 1080×2400 **不一致**。

### TEST-12 · 34 个 `.tsx` 组件从未被渲染 —— **Medium-High**

| 项 | 内容 |
|---|---|
| 证据 | `component-harness.mjs:28` —— `useMemo: fn => fn()`、`useCallback: fn => fn`（**丢弃依赖**）、**`useEffect() {}`（effect 从不执行）**、`:30-34` `useState` 的 setter **不触发重渲染**；没有 `useReducer` / `useContext` / `useLayoutEffect` / error boundary |
| 额外缺陷 | `nodes()`（`:54`）在遍历中调用函数型 children，而此时 `render()`（`:58`）留下的 `cursor` 非零 → **hook 顺序错乱** |
| 后果 | 布局、响应式断点、暗色模式、手势处理器、reanimated/worklets 接线（`babel.config.js:3` 的 `plugins: ['react-native-worklets/plugin']`）、**effect 清理**——全部未测。**这是一整类能 100% 通过现有测试的 bug** |
| 根因 | **TEST-10**（jest 配置是死的，没人引入 react-test-renderer），所以只能手写 harness |
| 修复 | 引入 jest + react-test-renderer（或 `@testing-library/react-native`），至少覆盖 34 个 `.tsx` 里的核心几个 |
| 风险 | 中（新增依赖，需要宪章批准——本轮不改依赖） |
| 验证 | **判据**：写一个故意泄漏 effect 的组件，测试**必须失败** |
| 本轮实施 | 不建议（涉及新增依赖） |

### TEST-06 · butler 沙箱边界零测试 —— **High**

见 §2.2。`lib/workspace-fs.js` 的 81 行里包含 `inside()` / `verifyRoot()` / `fresh()` / 符号链接拒绝，**全部未被任何测试执行**。

| 修复 | 用真实临时目录 + 符号链接 fixture，断言：越界路径被拒、root 的 dev/ino 变化被检出、祖先目录符号链接交换（TOCTOU）被 `fresh()` 拦下 |
|---|---|
| 风险 | 低（纯新增测试） |
| 验证 | 故意把 `fresh()` 换成缓存版本，测试**必须失败** |
| 本轮实施 | **建议排期（前 10 之外，但优先级高）** |

### TEST-07 · Windows 路径语义被"删除"而非"移植" —— **Medium**

| 项 | 内容 |
|---|---|
| 证据 | `git show 138811f`：把 `dsh-outpost-butler/test/task-manager.test.mjs` 里的 `cwd: 'C:/work'` 换成了 `path.resolve('test-workspace')`，**理由是** `path.isAbsolute('C:/work')` 在 Linux 上为 `false`，而 `lib/task-manager.js:159` 正是用 `path.isAbsolute(cwd)` 做门控 |
| 补充证据 | 全仓 grep `path.win32` → **0 命中**（butler / desktop / mobile-src 都没有） |
| 补充证据 | butler 测试只在 `ubuntu-latest` 上跑（`android.yml:53, 76-78`） |
| 补充证据 | `test/task-api.test.mjs:189` 仍然传 `'C:/work'`，但用的是**假 manager**（`manager.calls[0]`），**真实校验被绕过** |
| 后果 | **产品是 Windows 宿主**，但"`create({cwd})` 是否接受 `C:\…` 和 `\\server\share`"**在任何地方都没有被验证** |
| 修复 | 显式通过 `path.win32.isAbsolute` 测试，或加一条 `windows-latest` 的 CI leg |
| 风险 | 低 |
| 验证 | 断言 `path.win32.isAbsolute('C:/work') === true` 且产品代码在 win32 语义下接受它 |
| 本轮实施 | 建议排期 |

### TEST-08 · Gradle dry-run 在 CI 里可能 fail-open —— **Medium**

`release-signing-gates-spec.mjs` 里有 **5 个 Gradle dry-run**，每个 timeout 600s。

**待验证**：`ubuntu-latest` 是否仍然自带 JDK + Android SDK，使这些步骤**真的运行**而不是 fail-open。**本轮未执行任何 gradlew，无法验证，不编造结论。**

### TEST-09 · 墙钟时间被 loader 启动开销主导 —— **Medium**

**【已测量，但仅本地】**

| 命令 | 耗时 |
|---|---|
| `node tests/cwd-spec.mjs` | 0.173s |
| `./node_modules/.bin/tsx tests/updater-spec.mjs` | 0.828s |
| `tsx tests/teammate-spec.mjs` | 0.743s |
| `npx tsx`（额外一层） | 2.952s |

**【算术外推，非测量】** 链条里有 **76 个 tsx spawn + 27 个 node spawn**，仅 loader/启动开销：

```
76 × 0.8s + 27 × 0.2s ≈ 66 秒
```

这还**不含**任何测试体、不含 **89 个 `npm run` spawn**、不含 TEST-08 的 5 次 Gradle dry-run、不含对 45,492 行做 `tsc --noEmit`（**未执行，不报数字**）。而且**完全没有并行**。

| 修复 | 换成单次 `node --test` + `--test-concurrency`，可省掉约 100 个 spawn |
|---|---|
| 前置条件 | **必须先解决 TEST-04 / TEST-11 的 `globalThis` 共享状态问题**，否则并行会互相污染 |
| 本轮实施 | 与 BUG-01 同批 |

### TEST-10 · `jest.config.js` 是死配置 —— **Low-Medium**

| 项 | 内容 |
|---|---|
| 证据 | `preset: 'react-native'` **无任何引用**；jest / jest-cli / @types/jest / react-test-renderer / @testing-library 在**任何 package.json 里都没有**，也**不在 node_modules 里**；dsh-mobile 下**没有 `__tests__` 目录**，没有 `*.test.ts(x)` / `*.spec.ts(x)` |
| 补充 | butler 的 `test/*.test.mjs` 也匹配不上 jest 默认 `testMatch`，且配置根目录是 dsh-mobile |
| 后果 | 这个文件的存在**误导**读者以为有 jest 测试。它也是 **TEST-12** 的成因（因为没有 jest，只能手写 harness） |
| 修复 | 删掉，**或者**真的采用 jest + react-test-renderer 覆盖 34 个 `.tsx` |
| 验证 | `npx jest --showConfig` 今天就会失败 |
| 本轮实施 | 建议随 CQ-02 死代码清理一起做 |

### TEST-11 · 死/不一致的测试支撑件 —— **Medium**

| 文件 | 行数 | 问题 |
|---|---|---|
| `tests/support/local-runtime-app.js` | 28 | **零引用** |
| `tests/support/cookie-manager-stub.mjs` | 88 | **零引用**（见 TEST-04） |
| `tests/support/node-ts-bootstrap.mjs` | 48 | 只在 `tests/README.md:179` 被提到，且**不注册任何 RN shim** |
| `tests/support/ws-with-headers.mjs` | 181 | 只被 `runtime-compat-spec.mjs` + README 用，已被 `ws-compat.mjs` 取代 |
| **两套分歧的 TS 解析器** | | `rn-module-hook.mjs:45`（6 种扩展名）vs `ts-resolve.mjs:27-36`（8 种，多了 `.cjs` 和 `/index.js`）—— **这正是 TEST-02 的成因** |
| `ws-compat.mjs:142-149` | | `fire()` **吞掉每个 handler 异常** |
| `ws-compat.mjs:153` | | 对所有消息数据做 `String(data)` |
| `ws-compat.mjs:56` | | `send()` 在 `readyState !== OPEN` 时**不抛错**（真实 WebSocket 抛 `InvalidStateError`） |
| **`node20-sim.cjs` 与 `ws-compat.mjs` 互相矛盾** | | `node20-sim.cjs` 18 行，唯一动作是 `delete globalThis.WebSocket`（`:18`），文档串 `:13-14` 里还有一个**损坏的字面换行**。它存在是因为 `engines.node >= 20` 必须被尊重而本地开发用 Node 24（`ws-compat.mjs:8-15` 解释了那次"本地绿 / CI 红"事故）。**但** `ws-compat.ensureWebSocket()`（`:224-227`）随后**无条件替换** `globalThis.WebSocket` —— 两者同时加载时语义冲突 |

### TEST-13 · Android 构建可复现性缺口 —— **Medium-High**

| 项 | 证据 | 后果 |
|---|---|---|
| **AGP 未声明版本** | `android/build.gradle:15` 是 `classpath("com.android.tools.build:gradle")`，**没有版本号** → 通过 `node_modules/react-native/gradle/libs.versions.toml:11` 传递解析到 **8.11.0** | **升级 RN 会静默改变构建工具链** |
| **Gradle 分发包无校验和** | `gradle-wrapper.jar` **已提交**（43,764 字节），`gradle-wrapper.properties:3` 钉住 `gradle-8.14.3-bin.zip`、`:5` `validateDistributionUrl=true`，**但没有 `distributionSha256Sum`**（grep 0 命中） | 供应链风险 |
| **versionCode/Name 非确定性** | `app/build.gradle:123-124` 在缺少 `-PDSH_VERSION_CODE` / `-PDSH_VERSION_NAME` 时默认 `'1'` / `'1.0'`；`build-signed-apk.ps1:66` 默认硬编码 `916204`；只有 CI 从 tag 推导 | **三个真值来源，只有一个被门禁** |

已声明的：Kotlin 2.1.20、buildTools 36.0.0、compile/target 36、minSdk 24、NDK 27.1.12297006（`android/build.gradle:3-8`）、CI JDK temurin 21（`android.yml:141`）；而 `agent-core/build.gradle` 声明 `jvmToolchain(17)`。

**【待验证】** AGP 8.11.0 + Gradle 8.14.3 + Kotlin 2.1.20 + JDK 21 的组合**看起来**兼容，但**本轮离线无法验证**，不做断言。

| 修复 | (1) 显式声明 AGP 版本；(2) 加 `distributionSha256Sum`；(3) 让 Gradle 在缺少 `DSH_VERSION_CODE` 时**失败** |
|---|---|
| 风险 | 低（(1)(3) 是纯收紧；(2) 需要先算出校验和） |
| 验证 | 不带 `-P` 参数运行 `./gradlew :app:assembleRelease` **必须失败** |
| 本轮实施 | **建议排期（前 10 之外，优先级高）** |

### TEST-14 · 发布门禁死代码 + 两个绕过路径 —— **High**

**(a) 门禁本身没被调用**（见 §1.4）→ `apkBytesMax` / `runtimeArchiveBytesMax` / `knownGoodCertificateSha256` 从未强制。

**(b) 绕过路径 1：`-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true`**
`app/build.gradle:167, 232, 247`。用仓库里已提交的 `debug.keystore` 签 release。
`:151` 的注释断言"CI 永不传"，而 CI Gate 4 也**独立地**把 debug 指纹列入黑名单（`android.yml:400-410`）——所以它**不能通过 CI 发布**，但**可以被构建出来并手工分发**。

**(c) 绕过路径 2：`-SkipGatewayPatchCheck`**
`start-dsh-web.ps1:114-118`（其存在性被 `gateway-startup-gate-spec.mjs:80` 断言）。
以及 `build-signed-apk.ps1:150, 308` 在 `apksigner` 缺失时降级为 `Write-Warn2` —— **fail-open**。

**(d) 补丁本身测得很好，但 CI 不打补丁**

`mobile-gateway-patch-spec.mjs` 是**真实**的强测试：应用补丁 → 对结果跑 `node --check`（`:133`）→ 执行打过补丁的路由并断言 fail-closed 503/401/403（`:211-242`）→ 断言 `--apply` 拒绝未知插件版本（`:310`）。

**但是：没有任何 CI 步骤运行 `apply.mjs --apply`。** 所以 `npm ci` 之后 gateway 是**原始的**，CI 的集成测试跑的是**未打补丁的 gateway**。`patches/…/state.json` 钉住了版本 0.10.3 与 pristine/patched 的 SHA-256，但**在 CI 里从未被验证**。

→ 关联 **SEC-01**（`start-tunnel.ps1` 缺门禁）与 **BUG-13**（补丁门禁静默跳过）。

| 修复 | (1) 让 CI 在集成测试前跑 `apply.mjs --apply` 并校验 `state.json`；(2) 把 `release-gate.mjs` 接进 release job；(3) `build-signed-apk.ps1` 的 `apksigner` 缺失改为 **fail-closed** |
|---|---|
| 风险 | (1)(2) 低；(3) 低但会挡住没有 SDK 的本地环境——需要保留显式的 `-AllowUnsignedLocal` 而不是静默降级 |
| 验证 | CI 日志里必须能看到补丁被应用；删掉 `release-floor.json` 后 release job 必须失败 |
| 本轮实施 | **建议排期（(3) 优先，属安全收紧）** |

> **注意（宪章约束）**：涉及安全的代码不得提出简化删除方案。本条**全部是收紧**，没有任何"删掉检查"的建议。

### TEST-15 · 没有覆盖率测量 + 测试文件不受类型检查 —— **Medium**

| 项 | 证据 |
|---|---|
| 无覆盖率工具 | 全仓 grep 无 c8 / nyc / istanbul / `--experimental-test-coverage` / jacoco / kover |
| **测试文件不做类型检查** | `dsh-mobile/tsconfig.json`：`"include": ["src/**/*.ts", "src/**/*.tsx"]`、`"exclude": ["node_modules", "tests"]`、`"skipLibCheck": true` → **142 个测试文件完全没有类型检查** |

**这正是 SEC-06 不可见的原因**：`secureStore.ts:50-54` 把 keychain 结果标成 `Promise<unknown>`，而真实 API 是 `Promise<false | Result>`——如果测试文件也受类型检查，mock 与真实签名的偏差会**在编译期暴露**。

| 修复 | (1) 加一个 CI 步骤跑 `node --test --experimental-test-coverage` 并公布数字；(2) 考虑 `tsconfig.test.json` |
|---|---|
| 风险 | 低（(2) 可能暴露一批现有类型错误，需要先修） |
| 验证 | 覆盖率数字出现在 CI 输出里 |
| 本轮实施 | (1) **建议排期**——这是唯一能量化本文所有"缺口地图"的手段 |

### TEST-16 · CI 无 timeout + PowerShell 版本错配 —— **Medium-High**

**(a) 无 timeout**
`android.yml` 的**所有 job 都没有 `timeout-minutes`**——只有 `signing-verify.yml:54` 设了 45 分钟。结合 TEST-08 的 5×600s Gradle timeout，一个挂死的 daemon 可以**占用 runner 数小时**。

**(b) PowerShell 5.1 vs pwsh 7 的错配（重要）**

| 事实 | 证据 |
|---|---|
| PowerShell **是真实执行的**，不是 stub | `tests/support/powershell.mjs:122, 162` 用 `execFileSync` |
| CI 会硬失败如果 pwsh 缺失 | `signing-verify.yml:133-144` |
| `.ps1` 文件是**为 PS 5.1 写的** | `powershell.mjs:42-43` 的注释明说（依赖 BOM/ANSI） |
| **但候选程序在 Windows 上优先 `powershell.exe`(5.1)，在 Linux 上只用 `pwsh`** | `powershell.mjs:45-50` |
| CI 是 Linux | `android.yml:53` |

**→ 每一个 `.ps1` 都只在 PowerShell 7 下被验证过。PS 5.1-only 的破损永远不会被发现。**

而产品是 **Windows 宿主**，用户机器上跑的很可能就是 5.1。

这与已确认的 **BUG-06**（`start-tunnel.ps1:439` 调用未定义的 `Write-Warn`）是同一类问题的两个面：**BUG-06 之所以能存在，正是因为 TEST-16 的这个盲区。**

| 修复 | (1) 给所有 job 加 `timeout-minutes`；(2) 在 `windows-latest` 上加一条 leg，用 `powershell.exe`（5.1）对每个 `.ps1` 跑 `PSParser::Tokenize` 或 `-WhatIf` 级语法校验 |
|---|---|
| 风险 | 低 |
| 验证 | 故意在某个 `.ps1` 里写 `Write-Warn`，5.1 leg **必须失败** |
| 本轮实施 | **建议排期（(1) 立即，(2) 高价值）** |

### TEST-17 · Android 原生测试覆盖严重偏斜 —— **Medium-High**

**已存在、可在 CI 无设备运行的 JVM 单元测试（共 38 个 `@Test`）：**

| 文件 | 测试数 | 覆盖内容 |
|---|---|---|
| `AgentLoopTest` | 14 | 审批绑定、执行前否决、结果裁剪、超时老化 |
| `CloudModelClientTest` | 13 | **四个协议适配器全部**、合成 id 唯一性、密钥脱敏、明文 URL 拒绝、畸形 SSE |
| `FileRunStoreTest` | 7 | 原子性、损坏→不可读、损坏在 prune 后存活 |
| `RunRecoveryTest` | 4 | |

**→ `agent-core` 覆盖得不错。但 `android/app` 覆盖率为零：**

`AgentModule`、`AgentRuntime`、`PhoneTools`、`OutpostAccessibilityService`、`BackgroundDisplayController`、`AgentService`、`ShareInbox` —— **没有任何自动化测试**。

**androidTest（3 文件 / 7 个 `@Test`，需要真机，从不运行）：**

| 文件 | 测试数 | 内容 |
|---|---|---|
| `KeychainStorageValidationTest` | 5 | 通过 `KeyInfo` 验证 AES-256-GCM、无用户认证要求、DataStore 静态密文、`allowBackup=false`、性能上界 |
| `LocalRuntimeBridgeValidationTest` | 2 | 需要隔离的 `com.dshoutpost.p1.*` 包 + 外部 fixture + 真机 → **实际上是手工测试** |

**特殊：`RuntimeInstallerChecks.java` 不是 JUnit**
它是一个手工调用的设备端 helper（`run(File)`），内含**约 40 项极好的失败注入检查**：9 个崩溃检查点 × 安装/回滚、6 条穿越路径、7 种禁止的 tar 类型、符号链接禁闭、损坏指针 fail-closed。

**问题不是这些检查写得不好——问题是它们从不自动运行。**

`P0HarnessActivity.kt` 是 14 行的 debug harness。

| 修复 | (1) 在 CI 加 `./gradlew :agent-core:test`（**零成本，38 个已有测试立刻生效**）；(2) 把 `RuntimeInstallerChecks` 包一层 JUnit + 用 `reactivecircus/android-emulator-action` 跑；(3) 给 `AgentRuntime` 的状态机补 JVM 单元测试（它不依赖 Android framework 的部分） |
|---|---|
| 风险 | (1) 极低；(2) 中（模拟器在 CI 里慢且脆）；(3) 低 |
| 验证 | (1) CI 日志出现 38 个测试结果 |
| 本轮实施 | **(1) 强烈建议排期——这是本次审计里"收益/成本比"最高的单项** |

### TEST-18 · `dsh-plugin-connect` 无测试、无 CI —— **Medium**

`package.json` **没有 `scripts` 块**，**零** workflow 引用。3,531 行代码，其中 `tunnel-service.mjs`（534 行，spawn `start-tunnel.ps1` 与 cloudflared）**完全未测**，`client.js` 的约 2,800 行在 Node 里不可测。

唯一的测试 `test-qr.mjs` **本身是坏的**（**BUG-07**）。

---

## 四、Mock 与真实服务端的差异（harness divergence）

### 4.1 `fake-dsh.mjs` vs 真实 `dsh-plugin-mobile-gateway@0.10.3`

我读了**已安装的真实包**（`%USERPROFILE%\.dsh\profiles\web\node_modules\...` 与 `dsh-mobile/node_modules/...`）逐条对比：

| 维度 | 真实 gateway | `fake-dsh.mjs` | 风险 |
|---|---|---|---|
| **wire 序列化** | `stringifyWireFrame` 把孤立 UTF-16 代理项替换成 U+FFFD（`lib/wire-json.mjs:4-7`） | 裸 `JSON.stringify`（`:170, 762, 766`） | **含孤立代理项的文本在真机上行为不同** |
| **子协议** | `handleProtocols` 在客户端未提供 `dsh-mobile-v1` 时**返回 false 中止握手**（`:2274`） | **从不检查** `dsh-mobile-v1`，只看 `dsh-pair.` / `dsh-auth.`（`:618-631`），且**总是回显** `dsh-mobile-v1`（`:658`） | **协议协商失败路径未测** |
| **`hello.capabilities`** | 约 **19** 项，含 `assistant-stream-v1`、`history-format-version`、`projection-baseline`、`session-create`、`tasks`、`goals`、`queue-control`，以及条件性的 `speech-input-v1` / `file-downloads`（`:3094-3113`） | `['split-channels', 'images']`（`:716`） | **能力协商完全未测** |
| **`hello` 字段** | `dshVersion`、`historyFormatVersion`、`authenticated: !!device`、`port: transport.port \|\| webServer.port`、`clients: clients.size`（`:3092-3120`） | 硬编码 `authenticated: true`、`port: 3095`、`clients: 1`（`:711-721`），**无版本字段** | **未认证 hello 未测** |
| **hello 之后的帧** | 依次发 `session-archives`、`session-queues`、`projection-baseline`、`replayPendingInteractions(ws, 'connect')`（`:3121-3131`） | **什么都不发** | **重连后的待处理交互重放未测**（这正是"pending 状态无法结束"类 bug 的温床） |
| **`maxPayload`** | `WebSocketServer({maxPayload: options.maxPayloadBytes})`（`:2270`） | **无限制**，裸 `Buffer.concat`（`:134`） | **1009 过大帧路径未测** → 理论上的内存放大 |
| **帧 opcode** | 支持分片与二进制 | **只发 0x1**（`:154`）；**0x0 续帧与 0x2 二进制被静默丢弃** | 大消息分片未测 |
| **`POST /mgw/pair`** | 读 body，尊重 `body.publicUrl` / `body.endpoints`，**禁用时返回 409**（`:2831-2841`） | **从不读 body**，从 `req.headers.host` 推导，**无 409**（`:297-327`）；`calls` 只记录 `/api/*`（`:503`） | **配对被禁用的 fail-closed 路径未测** |
| **配对 TTL** | `registry.createPairing()` 带 `pairingTtlMs` | 配对**永不过期**（`:271, 796`） | TTL 语义未测 |
| **revoke** | 用 **4003** 关闭匹配的 client（`:2866-2869`） | 只改集合 + 返回 JSON（`:469-481`） | **4003 关闭码处理未测**（而 `deviceRevocation.ts:30-36` 明确说 `unknown` 不能当作未吊销，就是因为等不到 4003） |
| **关闭码** | 4003 **和 4004**（"mobile gateway disabled"，`:2357`） | 通过 `closeGatewayWith` 任意指定 | 4004 未在真实语义下测过 |
| **`/mgw/status`** | **20+** 字段，含 `endpoints`、`publicUrl`、`lan{}`、`pairingTtlMs`、`waitExpiresAt`、`webPid`、`platform`、`queryTokenAllowed`（`:2712-2740`） | **8** 个字段，`version: 'fake'`（`:391-407`） | 状态解析的健壮性未测 |

**总评**：`fake-dsh.mjs` 是一个**协议子集**的 mock。它对"正常路径"的模拟是够用的（`ws-reconnect-session-recovery-spec.mjs` 这类测试确实是真实的、有价值的），但**所有 fail-closed 分支——409、4003、4004、1009、能力缺失、未认证 hello——都在 mock 层就被抹掉了**。

### 4.2 Keychain shim vs 真实 API

| 项 | 真实 | shim |
|---|---|---|
| `setGenericPassword()` 返回 | `Promise<false \| Result>`（`node_modules/react-native-keychain/lib/typescript/index.d.ts:17`） | **总是**返回 `{service, storage: 'keystore-stub'}`（`_keychain-shim.cjs:41-45`），**从不抛错** |
| 产品代码的类型 | `Promise<unknown>`（`secureStore.ts:50-54`） | —— |
| 产品代码是否检查返回值 | **从不**（`secureStore.ts:156-161`） | —— |
| `ACCESSIBLE` 常量 | shim 暴露了（`:29-36`） | **但从不被验证** |

→ **SEC-06**：`false`（写入失败）被当作成功。而 shim 永不返回 `false`，所以**这条路径在测试里不可能被发现**。

### 4.3 Cookie shim

见 **TEST-04**。

### 4.4 PowerShell：**不是** stub（这是好消息）

`tests/support/powershell.mjs:122, 162` 用 `execFileSync` **真实执行**。相关的 fail-closed 设计：

| 位置 | 行为 |
|---|---|
| `signing-verify.yml:133-144` | pwsh 缺失 → **硬失败** |
| `gateway-startup-gate-spec.mjs:96-99` | `process.env.CI` 下**失败**，只本地跳过 ✅ **正确做法** |
| `butler-installer-spec.mjs:12` | `assert.ok(ps.ok, …)` **无条件失败** ✅ |

**但**版本错配问题见 **TEST-16(b)**。

---

## 五、已核查为健康的地方（防止重复审计）

### 5.1 CI 发布门禁（真的是 fail-closed）

| 项 | 证据 |
|---|---|
| Gate 4 缺 `EXPECTED_CERT_SHA256` 时**硬失败**，不是警告 | `android.yml:432-440` |
| **独立地**把公开的 AOSP debug 指纹列入黑名单（不依赖上面的变量） | `android.yml:400-410` |
| 用 `aapt2` 交叉校验包名 / versionCode / versionName 与推导值 | `android.yml:445-455` |
| `signing-verify.yml` 是 `contents: read` 且**没有 release 步骤** → 物理上不可能发布 | `:43-44` |
| `version-code-spec.mjs` 断言 `readFloor` 在 floor 缺失/非法时**抛错**，并回归测试了旧公式 | **我真实执行过：25 pass / 0 fail，31ms** |
| `.gitattributes` 正确强制 `*.ps1 text eol=crlf`，其余 LF；`gradle-wrapper.jar` / `*.apk` / `*.keystore` 标为 binary | ✅ |

### 5.2 大小写敏感性（Linux checkout 安全）

**665 个相对 import 说明符**（`dsh-mobile/src` 内）逐一与磁盘上的真实文件名比对 → **0 处大小写不匹配**。

这一轴上 Linux CI checkout 是安全的。

### 5.3 没有"假绿"的测试

| 检查 | 结果 |
|---|---|
| 使用非失败型 skip 计数器的 spec | **只有 3 个**：`protocol-contract-spec.mjs:417`、`crosscheck-revoke-self-spec.mjs:315`、`server-identity-binding-spec.mjs:879` |
| 全树 `process.exit(0)` | **只有 1 处**，在 `tests/manual/check-update.mjs:14`（手工脚本，不在任何链里） |
| `xit` / `xdescribe` / `test.skip` / `it.skip` / `.todo(` | **零命中** |
| 三个我怀疑过"无断言"的 spec | **都不是** —— `cwd-spec.mjs:24`、`teammate-spec.mjs:34`、`updater-spec.mjs:27` 都维护真实的 pass/fail 计数器并以 `process.exit(fail === 0 ? 0 : 1)` 结束 |

### 5.4 孤儿脚本（已修正的统计）

> **方法修正记录**：我最初的脚本只检查链条里是否出现 spec **文件名**，得出"136/142 从未运行"的错误结论。
> 原因是链条引用的是 **`npm run test:xyz` 子脚本**，不是文件名。
> 修正方法：从 CI 根（`test`、`test:integration`、`test:node20`）出发**传递展开** `npm run X` 引用。

**修正后的正确结果：**

| 指标 | 数值 |
|---|---|
| spec 文件总数 | **142** |
| CI **从不到达**的 spec | **20** |
| 孤儿 npm script（定义了但 CI 从不调用） | **6**：`test:localRuntime`、`test:p4`、`test:p3`、`test:e2e`、`test:perf`、`test:filesave` |
| CI 到达的 npm script | **92 / 107** |

### 5.5 依赖版本（无冲突）

| 项 | 结论 |
|---|---|
| peer range 互相兼容 | reanimated 4.3.4 要求 react-native 0.81–0.85（**有 0.81.4** ✅）+ react-native-worklets 0.8.x（**有 0.8.3** ✅）；worklets 0.8.3 要求 react-native 0.81–0.85 ✅；bottom-sheet 5.2.14 要求 gesture-handler ≥2.16.1（**有 2.33.1** ✅）+ reanimated ≥3.16.0 \|\| ≥4.0.0- ✅；gesture-handler 2.33.1 要求 `*` |
| lockfile 里的重复版本 | **恰好一个 `react`（19.1.0）、一个 `react-native`（0.81.4）** —— 无重复版本冲突 |
| lockfile 提交情况 | dsh-mobile ✅、dsh-outpost-desktop ✅；dsh-outpost-butler ❌（**无害：零依赖**）、dsh-plugin-connect ❌（**无害：零依赖、无 test script**）。**这也解释了为什么 butler 的 CI `npm test` 不需要 install 步骤** |
| 会在**全新 `npm install`** 时漂移的 `^` 范围 | `react-native-safe-area-context ^5.5.2`→5.10.1、`typescript ^5.8.3`→5.9.3、`async-storage ^2.1.0`→2.2.0、`tsx ^4.23.15`→4.23.15、`electron-builder ^25.1.8`→25.1.8、`qrcode ^1.5.4`→1.5.4。**今天全部被已提交的 lock + `npm ci` 钉住** |
| 精确钉住的 | react、react-native、reanimated、worklets、gesture-handler、@gorhom/bottom-sheet、@noble/hashes、whatwg-url-without-unicode、**dsh-plugin-mobile-gateway 0.10.3**、electron 43.7.9 |

### 5.6 补丁状态（本机只读核查）

| 项 | 结果 |
|---|---|
| 插件安装位置 | `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-plugin-mobile-gateway`，版本 **0.10.3** |
| `lib/index.mjs` | **恰好 1 个锚点**、**1 个** `DSH_OUTPOST_MGW_AUTH_PATCH` 标记 ✅ |
| `index.mjs.orig` 备份 | 存在 ✅ |
| `state.json` 哈希 | 与 `apply.mjs:47` 的 `KNOWN_SOURCES` **匹配** ✅ |
| 版本变化时的行为 | `--apply` **拒绝**未知版本（`apply.mjs:155-169`）；`--check` 退出 1 → `start-dsh-web` **拒绝启动**（`start-dsh-web.ps1:140-144`）→ **fail-closed，符合设计** ✅ |

---

## 六、缺口汇总表

| 编号 | 严重程度 | 一句话 | 本轮实施 |
|---|---|---|---|
| **TEST-03** | **Critical**（↑ 原 High） | **两个契约 spec 在插件不可解析时零断言通过**（已实测复现：`crosscheck` 0 通过 / 5 跳过 / exit 0）——**唯一真正的假绿通道** | ✅ **已实施** `f38d9e2`（两层守卫 + `signing-verify.yml` 补环境变量 + 新增 `contract-skip-guard-spec.mjs` 28/0） |
| **TEST-01 / BUG-01** | **High**（↓ 原 Critical） | `&&` 链（审计基线 103 条叶子命令，现 106 条）**失败即截断**，`tsc` 是最后一环 → 前置任何失败都会让类型检查从不执行。**不产生假绿**（退出码非零，CI 是红的），危害是诊断不完整 + 类型错误可长期潜伏 | ✅ **已实施**（`9211da8`：新增 `tests/run-suite.mjs` 聚合器 + `suite-runner-spec.mjs` **75/0**，含"前置失败时 tsc 仍执行"的变异反证；本机 `npm test` 实跑 **106/106 通过**，**CI 上待验证**） |
| **TEST-02** | **High** | `component-harness.mjs:17-18` 的 `.ts` 硬编码使过期 mock **abort 进程** | 排期（同批） |
| **TEST-14** | **High** | 发布门禁死代码；CI **不打 gateway 补丁**就跑集成测试；两处 fail-open | 排期（(3) 优先） |
| **TEST-17** | **Medium-High** | `:agent-core:test` 的 **38 个已有测试从不运行**；`android/app` 覆盖率为零 | ✅ **第 (1) 项已实施** `6a83f2c`（新增 `jvm-tests` job + 门禁 release + `android-jvm-tests-ci-spec.mjs` 31/0；本人实跑 gradlew 得 **38/0/0/0**）。`android/app` 覆盖率为零**仍未解决** |
| **TEST-16** | **Medium-High** | CI 无 `timeout-minutes`；**所有 `.ps1` 只在 pwsh 7 下验证过，产品跑在 5.1** | 排期（(1) 立即） |
| **TEST-04** | **Medium-High** | 三个互不同步的 cookie jar；测试跑的是生产不会走的回退路径 | 排期（TEST-09 前置） |
| **TEST-12** | **Medium-High** | 34 个 `.tsx` 从不渲染；`useEffect` 是空函数 → effect 清理未测 | 不建议（需新增依赖） |
| **TEST-06** | **High** | butler 沙箱边界 `workspace-fs.js`（81 行）**零测试** | 排期（高优先） |
| **TEST-13** | **Medium-High** | AGP 版本未声明（传递解析到 8.11.0）；Gradle 无 `distributionSha256Sum`；versionCode 三个真值来源 | 排期 |
| **TEST-15** | **Medium** | 无覆盖率工具；**142 个测试文件完全不做类型检查** | 排期（(1)） |
| **TEST-09** | **Medium** | 墙钟被 loader 启动主导（外推 ≈66s），无并行 | 与 BUG-01 同批 |
| **TEST-11** | **Medium** | 4 个死支撑件、两套分歧 TS 解析器、`node20-sim` 与 `ws-compat` 语义矛盾 | 排期 |
| **TEST-05** | **Medium** | RN shim 冻结 AppState / Dimensions / 暗色 / 动画 / Linking | 排期（与 PERF-03 联动） |
| **TEST-07** | **Medium** | Windows 路径语义被**删除**而非移植；产品是 Windows 宿主 | 排期 |
| **TEST-08** | **Medium** | Gradle dry-run 在 CI 里可能 fail-open | **待验证** |
| **TEST-18** | **Medium** | `dsh-plugin-connect` 无 test script、零 workflow 引用；3,531 行 | 排期 |

---

## 七、总评

| 维度 | 评价 |
|---|---|
| **测试的"真实性"** | **意外地好**。没有 `xit`/`.skip`/`.todo`，没有假绿计数器，PowerShell 是真实执行的，`ws-reconnect-session-recovery-spec.mjs` / `fold-spec.mjs` / `pending-send-send-flow-spec.mjs` / `mobile-gateway-patch-spec.mjs` 都是驱动真实产品代码的强测试 |
| **测试的"可达性"** | **差**。三者叠加但**性质不同**：**静默 skip（TEST-03）是唯一真正让绿灯失真的通道**；`&&` 链（TEST-01）与进程 abort（TEST-02）**不伪造绿灯**（退出码非零），它们损害的是**诊断完整性**——一次只暴露一个问题、`tsc` 可能从未执行 |
| **测试的"广度"** | **偏斜严重**。核心通信/发送/fold 覆盖深；UI 层（34 个 `.tsx`）、桌面端（EXEC 0/3）、butler 沙箱边界、`dsh-plugin-connect` 几乎为零 |
| **原生测试** | **已有 38 个 JVM 测试写得很好，但 CI 从不运行它们**——这是最可惜的一项 |
| **Mock 保真度** | `fake-dsh.mjs` 是协议**子集**，所有 fail-closed 分支（409/4003/4004/1009/能力缺失/未认证 hello）在 mock 层被抹掉 |
| **可观测性** | **零覆盖率工具**，且测试文件不受类型检查——这让 SEC-06 这类"mock 与真实签名不符"的问题**在编译期不可见** |
| **构建可复现性** | AGP 传递解析、Gradle 无校验和、versionCode 三个真值来源 |

**一句话结论：** 这套测试的**质量**（写出来的那些）明显高于**结构**（它们如何被组织和执行）。当务之急不是写更多测试，而是**让已有的测试可信地跑起来**——TEST-01/02/03 修好之后，TEST-17(1) 那 38 个已经写好的原生测试只要加一行 gradlew 就能生效。

---

*本文档由只读审计产生，未修改任何业务代码。所有耗时数字均标注了"已测量（本地）"或"算术外推"；覆盖率缺口地图的方法为 import-graph grep，非覆盖率工具；未访问任何 CI 运行日志。*
