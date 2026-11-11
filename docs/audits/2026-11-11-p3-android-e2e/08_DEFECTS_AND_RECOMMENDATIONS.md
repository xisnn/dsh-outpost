# 08 缺陷与建议（P3 Android E2E 验收期间发现）

> 分级：阻断 / 高 / 中 / 低 / 观察。每项含复现、归属（产品/环境/设施）、是否 P3 引入、建议。
> **本轮未发现 P3 修改引入的阻断性缺陷。** 下列多为既有问题或环境/设施问题。

## D-1 React 重复 key（sessionId）—— 低 · 既有 · 非 P3 引入

- 现象：dev LogBox 反复报 `Encountered two children with the same key, 'session-…'`（console.error），
  吐司遮挡底部输入区、误触可打开全屏 LogBox，干扰验收操作。
- 复现：配对后进入任一会话即触发（`evidence/06/09/22/28`，logcat `ReactNativeJS`）。
- 归属：产品（UI）。key 为 sessionId，位于 `ChatScreen.tsx:743` 与 `:1066`。
- 是否 P3 引入：**否**。P3 产品改动仅 `fold/toolStatus/workGroup/ToolCard/WorkGroupCard`，未触 `ChatScreen`。
- 建议：独立 issue 排查会话级列表/导航栈重复挂载；release 包不受 LogBox 影响，但重复 key 本身仍应修。

## D-2 Maven Central TLS 握手被中断 —— 环境 · 非产品

- 现象：首次 Gradle 构建卡死 9m38s 后失败，`Remote host terminated the handshake`；curl 同 URL 正常。
- 证据：`logs/gradle-assembleDebug.log`、`logs/gradle-daemon-threaddump.txt`（阻塞于 `DownloadAction.execute` SSL read）。
- 处置：非侵入 init 脚本走本机代理 7890（`scripts/proxy.init.gradle`），未改仓库/全局配置。第二次构建成功。
- 建议：CI/本机构建文档注明代理或镜像；不属产品缺陷。

## D-3 网关插件设备注册表忽略 DSH_HOME —— 中 · 既有 · 隔离缺口（已在测试配置规避）

- 现象：隔离 DSH 首启读到正式 35 台设备（`devices=35`），因 `index.mjs:2255` 默认 `os.homedir()/.dsh/mobile-gateway-devices.json`。
- 风险：多实例/隔离测试会读写正式配对注册表。
- 处置：隔离 profile 显式 pin `deviceFile`/`gatewayStateFile`；重启 `devices=0`；正式注册表 SHA-256 全程不变。
- 建议：产品侧考虑让默认路径尊重 `DSH_HOME`（跟进项，本轮未改产品代码）。

## D-4 纯单段落回答长按被 OS 文本选择接管 —— 低 · UX · 既有

- 现象：仅一个纯文本段落的最终回答，长按出系统 Copy/Share/Select all，而非应用「复制全文」面板（`evidence/10`）；
  含 markdown 结构的答案正常弹应用面板（`evidence/14`）。
- 归属：产品 UX；与 `MarkdownView.tsx:78-80` 注释意图出入。
- 建议：统一长按手势归属，保证「复制全文」入口在所有回答形态可达。

## D-5 外部新建会话不自动刷新列表 —— 低 · 观察 · 既有

- 现象：服务端（探针）新建会话后，App 首页/工作区列表仍显示旧数量；下拉刷新后正确（4→5）。
- 归属：产品（列表刷新时机）。手动刷新可用，非阻断。
- 建议：评估订阅 session-list 变更事件自动刷新。

## D-6 注入设施 abort 模式扰乱 pendingSend —— 设施 · 非产品缺陷声明

- 现象：自研注入服务端「destroy socket」失败模式下观察到同 requestId 的两次快速 prompt，且后续手动重试被 single-flight 抑制。
- 归属：测试设施故障形态不符合章程（章程为 hang-body / 网络 unknown），**不**据此判定产品自动重发缺陷。
- 处置：弃用 abort 模式，改用干净 hang 路径取证（见 03）。

## 未验证项（不宣称通过）

- 剪贴板内容级回读（adb 受限）；断开期间独立可读横幅（重连过快未捕获）；超长输出全屏查看器滚动（本轮无超长输出）；
  D2/D4 负向 ID 冲突/无 ID 的设备级注入（由协议 spec 守卫）。

## 建议汇总

1. 为 D-1、D-4、D-5 立独立跟进 issue（均非 P3 引入，不阻断 P3）。
2. D-3 作为产品隔离性跟进项。
3. 补齐未验证项的设备级/内容级取证后再关闭对应断言。
4. 不开展大规模重构；涉及 fold/pendingSend/transport/approval/原生权限边界的修改先出方案与证据。