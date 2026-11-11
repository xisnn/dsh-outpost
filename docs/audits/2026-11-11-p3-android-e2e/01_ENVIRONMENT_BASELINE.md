# 01 环境基线（P3 Android Emulator 端到端验收）

> 本轮为**真实 Emulator + 真实 RN 客户端**验收。所有「真实执行」结论均以 adb / Gradle / 服务端日志与截图为证；
> 未执行项一律标 NOT_RUN / BLOCKED，不以构建成功、单测成功或 Mock 成功冒充 Emulator 验收。
> 本文不钉住自身 commit SHA；精确 SHA 见随 ZIP 交付的 `evidence/GIT-HEAD.txt`（最后一次提交后生成）。

## 1. Git 基线

| 项 | 值 |
|---|---|
| 工作区 | `E:\work\dsBot-opt`（git worktree，隔离副本） |
| 分支 | `opt/p3-bug03`（测试分支，**未合并 main**） |
| HEAD | `a519299`（docs: describe the consolidated docs patch…） |
| 工作区状态 | 验收开始前干净；本轮仅新增 `docs/audits/2026-11-11-p3-android-e2e/` 报告目录 |
| BUG-02 修复提交 | `cb959e7` fix: keep the call() timeout alive until the response body is read |
| BUG-03 修复提交 | `a232ee0`…`6c39687`（fields / binding / unconfirmed / turn-identity 四个 fix + 配套 spec） |
| P1 待验收提交 | `1aa2d82`…`2325d34`，**正好 10 个**（`git rev-list --count` 实测 = 10），分支 `opt/p1-phone-polish` |

BUG-03 产品改动面（`git diff --stat a232ee0^ 6c39687`）：`fold/index.ts`、`toolStatus.ts`、`workGroup.ts`、
`ToolCard.tsx`、`WorkGroupCard.tsx` + 4 个 spec。**未触及** `ChatScreen.tsx`、`transport`、`pendingSend`、`approvalGateway`。

## 2. 工具链

| 组件 | 版本 / 位置 | 实测 |
|---|---|---|
| Android SDK | `E:\Android\Sdk`（`local.properties` 指向它） | build-tools 35/36、platforms 34/35/36、NDK 27.1.12297006、cmake 3.22.1 |
| JDK | `D:\Jdk21`（21.0.8） | 配合 `android/jdk21.init.gradle` + `-Preact.internal.disableJavaVersionAlignment=true` |
| Gradle | wrapper 8.14.3 | 复用既有 daemon |
| Node | v24.13.0 | 驱动脚本 / Metro |
| React Native | 0.81.4（newArch + Hermes + Fabric） | 真机日志 `Running "DshPocket" … fabric:true` |
| ADB | `E:\Android\Sdk\platform-tools\adb.exe` | 见下 |
| 网关插件 | `dsh-plugin-mobile-gateway` **0.10.3** | 隔离实例启动日志 `version=0.10.3` |

## 3. Emulator 与真机区分

| 设备 | 类型 | 证据 |
|---|---|---|
| `emulator-5584` | **真实 Emulator**，API 35 / x86_64 / google_apis | `ro.kernel.qemu=1`、`sys.boot_completed=1`；AVD `p3_e2e_api35`（本轮新建，因 `-list-avds` 原本为空） |
| `762a319` (V1981A) | **真实手机**，API 31 / arm64-v8a | `ro.kernel.qemu` 为空；仅含 P1 探针包，**本轮未向其安装/写入任何东西** |

加速：`emulator -accel-check` → `WHPX(10.0.26100) is installed and usable`。
启动参数：`-no-snapshot -no-boot-anim -no-audio -gpu swiftshader_indirect -memory 3072 -port 5584`。

## 4. 正式服务（保持运行、未被触碰）

| 服务 | PID | 端口 | 状态 |
|---|---|---|---|
| 正式 DSH（DeepSeek Harness） | 34928 | 3095(web) / 3081(gateway) | 全程存活，验收前后均确认 |
| magpie / magpie-bun | 24548 / 26584 | 3425 等 | 未触碰 |
| 多个 claude 进程 | — | — | 未触碰 |

**正式设备注册表完整性**：验收前记录 SHA-256 基线
（`logs/formal-registry-baseline.sha256`），验收中/后 `sha256sum -c` 均 **OK**，证明隔离实例未写正式注册表。

## 5. 隔离测试设施（独立端口 / 独立凭据 / 独立数据）

| 设施 | 端口 | 性质 | 用途 |
|---|---|---|---|
| 隔离**真实** DSH（profile `p3e2e`） | 3995(web) / 3981(gateway) | 真实 DSH 二进制 + 真实网关插件 | 场景 A / E（真实工具执行、真实权威事件） |
| 本地确定性模型桩 | 3990 | OpenAI 兼容 SSE 桩 | 让真实 DSH 执行工具而**不调用收费云模型** |
| 注入服务端 | 3996 | 协议形状取自真实 DSH 探针的可控服务端 | 场景 B / C / D / F（缺失/迟到结果、断连、hang-body） |

隔离措施：
- `DSH_HOME` / `DSH_STATE_DIR` 指向 `E:\work\p3-android-e2e\` 下独立目录；profile `p3e2e` 独立。
- **发现并修复一个隔离缺口**：网关插件默认把设备注册表硬编码为 `os.homedir()/.dsh/mobile-gateway-devices.json`（忽略 `DSH_HOME`），
  首次启动读到正式 35 台设备。已在隔离 profile 显式 pin `deviceFile` / `gatewayStateFile` 到隔离目录，重启后 `devices=0`。
  证据：`dsh-home/profiles/p3e2e/cordis.patch.yml`、启动日志 `devices=35 → devices=0`。
- 模型 provider 指向 `http://127.0.0.1:3990/v1`（`api: openai-completions`），`apiKeyEnv` 为本地测试值；**无收费调用**。
- 安装包装用隔离 applicationId `com.dshoutpost.p1.p3e2e`（`DSH_TEST_APPLICATION_ID`，build.gradle 强制 `com.dshoutpost.p1.*` 前缀），
  versionCode 930001，**不覆盖正式 `com.dshpocket`**。
- Emulator 经 `adb reverse tcp:3995/3981/3996/8081` 访问宿主回环服务。

## 6. 构建与启动

- 命令：`gradlew :app:assembleDebug -I jdk21.init.gradle -I proxy.init.gradle -PreactNativeArchitectures=x86_64 -PDSH_TEST_APPLICATION_ID=com.dshoutpost.p1.p3e2e …`
- 结果：**BUILD SUCCESSFUL**（attempt2，6m47s）；产物 `app-debug.apk`（28.3MB）。
- **环境问题（非产品缺陷）**：首次构建卡死 9m38s 后失败，根因为 JVM 直连 `repo.maven.apache.org` 时
  `Remote host terminated the handshake`（TLS 被中间设备中断；curl 同 URL 正常）。
  线程转储证实阻塞在 `DownloadAction.execute` 的 SSL read。
  处置：用**非侵入式** init 脚本把 Gradle HTTP 客户端指向本机已验证可用的代理 `127.0.0.1:7890`，
  未改仓库 build 文件、未改全局 `~/.gradle/gradle.properties`。证据：`logs/gradle-daemon-threaddump.txt`、两次构建日志。
- 安装：`adb install -r` Success；启动 `SplashActivity → MainActivity`，**0 FATAL**；Metro 8081 供 bundle。

## 7. 配对与链路

- 真实配对流程（服务地址 + token + 连接）对隔离真实 DSH 成功；通知权限弹窗（P1 POST_NOTIFICATIONS）真实出现并允许。
- 首页正确加载隔离 DSH 的会话历史（`session/list` / follow 快照 / 分页），WebSocket 与 HTTP RPC 均真实打通。
- 服务端探针（`scripts/dsh-probe.mjs`）证实真实 DSH 经本地桩执行真实工具：
  `tool/call(read) → tool/result(isError=false, 真实文件内容)`；多工具轮产生 3 call / 3 result（含 1 个 `FS_NOT_FOUND` 失败）。
  原始事件序列见 `logs/probe-events-*.jsonl`（亦作为注入服务端的协议形状依据）。