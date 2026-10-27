# DSH Outpost × Cindy 深度源码对比与优化潜力审计

> 审计对象：**DSH Outpost**（`E:\work\dsBot`，MIT）与 **Cindy**（`E:\SoftGit\cindy`，Apache-2.0 / XD Inc.）
> 审计方式：逐文件阅读真实源码，交叉验证调用链；**未修改任何业务代码，未执行安装/构建/部署脚本，未上传任何源码或凭据**。
> 版本基线：DSH Outpost `v0.16.6`（git `f978832`）；Cindy 本地工作树。
> 证据约定：所有结论标注 `路径:行号` + 符号名。标注 **【待验证】** 的条目表示源码无法完全证实，不得当作已确认缺陷。

---

## 1. 执行摘要

### 1.1 两个项目真正重合的能力

| 能力域 | 重合程度 | 说明 |
|---|---|---|
| 设备配对与长期凭据 | **高** | 双方都有「一次性码换长期令牌 → 存入系统安全存储 → 断线用令牌重连」 |
| 移动端远程查看/操作桌面 | **高** | 都是手机端 App + 桌面端服务，跨网络访问 |
| 流式输出渲染 | **高** | 都把增量事件 fold 成消息列表并虚拟化渲染 |
| 审批/权限交互 | **中** | 都支持手机端回答工具授权；Cindy 粒度更细 |
| 本地 HTTP 控制面 | **中** | 都有 loopback 控制服务（Outpost 的 tunnel-service，Cindy 的 local-agent） |
| 多 Agent 编排 | **低（且不该重合）** | Cindy 是通用多 harness 平台；Outpost 只服务 DSH |

### 1.2 差异化定位（必须守住）

- **Cindy**：通用 AI Agent 客户端。自带 Claude Code / Codex / Pi 多 harness 抽象、provider/模型路由、插件市场、IM 多渠道、远程桌面 WebRTC、多账号共享任务。规模：`apps/` + `packages/` 共约 13,047 个 `.ts/.tsx`，测试文件 5,596 个（占 42.9%），单文件最大 25,114 行（`apps/desktop/src/main/maker-ipc/register.ts`）。
- **DSH Outpost**：**单一 harness 的专用遥控器**。规模约 40,432 行（`dsh-mobile` 161 文件 / 36,164 行；`dsh-outpost-desktop` 5 文件 / 1,589 行；`dsh-plugin-connect` 4 文件 / 2,679 行）。它把 DSH 已有的能力（Agent Teams、会话、工具执行）通过逆向出的 RPC 投射到手机上，**不重实现 agent 内核**。

这不是「小号 Cindy」，而是两种产品。审计的价值在于：**Cindy 在「不可靠移动网络下把远端状态可靠地搬到手机上」这件事上，工程积累明显更深；而这恰好是 Outpost 当前最大的技术债所在。**

### 1.3 是否存在值得实施的重大改进

**是，而且集中在两条主线上——两条都不是「加功能」，而是修可靠性。**

1. **连接与流的可靠性**：Outpost 的会话流 `session/follow` 没有任何断线检测、超时或恢复机制。WebSocket 静默断开后，聊天界面会**永久卡在「进行中」且无任何错误提示**，唯一恢复方式是退出页面重进。这是本轮审计最严重的可靠性缺陷（P0-1）。
2. **长会话渲染成本**：每收到一个流式事件，`Store.rebuild()` 都会对**整个事件历史**重新排序 + 重新 fold + 重建整个 item 数组（`store.ts:1296-1319`），而 60ms 节流只限制了渲染次数、没有限制 fold 成本。Cindy 用「chunk 数组 + 可见性自适应 flush + 跳过重排序 + 行身份保留」四层把单 token 重渲染压到 1 行，并有测试断言（`messagePerformance.test.ts:170`）。这部分思想可低成本移植。

安全侧另有两个必须处理的问题（P0-2 / P1-1），详见第 6、8 章。

### 1.4 结论前置

- **架构合理性**：Outpost 的分层（`core/transport` → `core/rpc` → `core/store` → `screens`）是合理的，甚至比 Cindy 的 6,623 行单 store 更清晰。**不需要重构。**
- **真正该做的**：给现有架构补上「连接是一等公民」这一层，外加若干安全收口。
- **不该做的**：引入多 harness、通用编排、插件市场、WebRTC 直连等 Cindy 的重型基础设施。

---

## 2. 项目架构对比

### 2.1 DSH Outpost

```
E:\work\dsBot
├── dsh-mobile/                    # Android 客户端（RN 0.81 + TS，裸 RN，无 react-navigation）
│   ├── src/core/                  # 协议层（不依赖 UI，可在 Node 里测）
│   │   ├── transport/index.ts     #   HTTP unary RPC + WS /api/remote.mux 流
│   │   ├── rpc/{session,workspace,model,account,directory,upload}.ts
│   │   ├── store.ts               #   单例状态机（52KB，1404 行）：会话/聊天/团队/审批/通知
│   │   ├── fold/index.ts          #   事件流 → turn/item 投影（620 行，纯函数）
│   │   ├── approvalGateway.ts     #   独立 WS /ws/mobile 审批通道（46KB，1124 行）
│   │   ├── deviceAuth / deviceRevocation / serverIdentity
│   │   ├── secureStore / credentialMigration / cookieJar   # 凭据三件套
│   │   └── net-security.ts        #   「明文只发私有网段」校验
│   ├── src/screens/               # 8 个页面（ChatScreen 1095 行最大）
│   ├── src/components/            # 34 个组件
│   ├── src/nav/NavHost.tsx        # 手写导航栈 + 边缘手势
│   └── tests/                     # 51 个 .mjs spec（Node 驱动）+ fake-dsh.mjs
├── dsh-outpost-desktop/           # Windows 托盘（Electron，主进程 940 行）
├── dsh-plugin-connect/            # 隧道控制服务 + 旧版网页侧边栏插件
├── start-dsh-web.ps1 / start-tunnel.ps1 / doctor.ps1 / setup-*.ps1
└── .github/workflows/android.yml  # 唯一 CI：只覆盖 dsh-mobile
```

**职责边界（关键，勿混淆）**：Outpost **不实现** agent 内核、工具执行、审批裁决、会话持久化。这些都在 DSH 本体里。Outpost 只做「投射 + 转发 + 补 DSH 缺失的编排缝隙」。
其中 `store.wakeButler()`（`store.ts:786-801`）是明确的越界补偿——客户端替 DSH 补发「队员都干完了，请汇总」的 prompt，因为 DSH 的 Agent Teams 不会自动唤醒 lead（注释见 `store.ts:343-346`）。这类补偿是产品定位允许的，但也带来了副作用（见 P1-7）。

### 2.2 Cindy

```
E:\SoftGit\cindy  (pnpm monorepo, Node 22, ~13k TS 文件)
├── apps/desktop/                  # Electron，8,980 TS 文件 / 109MB
│   └── src/main/maker-ipc/register.ts   25,114 行；1,092 个 ipcMain.handle
├── apps/mobile/                   # Expo 57 / RN 0.86（Outpost 是裸 RN 0.81）
│   └── src/session/remoteSessionStore.ts  6,623 行，无 zustand/redux，纯 useSyncExternalStore
├── packages/device-link/          # 端到端可靠传输协议（60 文件，client.ts 5,665 行）
│   ├── transport.ts               #   累计 ACK / 分片 / RFC6298 RTT 估计 / 自适应重传
│   ├── invokeScheduler.ts         #   三级优先级 + 设备级并发闸门（165 行）
│   ├── allowlist.ts               #   230 条 channel 白名单（59KB，默认拒绝）
│   ├── peerRecoveryScheduler.ts   #   多 peer 恢复调度（generation fence）
│   └── __tests__/                 #   53 文件 / 18,670 行 / 717 个 it()
├── packages/maker-{core,shared,scheduler,cc-manager,pi-manager}, orca-workflow
└── packages/{provider*, model-*, plugin-*, lili-im, ...}   # 多 harness / 多渠道 / 商业化
```

**职责边界**：Cindy 是**全栈 agent 客户端**，自带 harness 抽象（`REMOTE_AGENT_KINDS = ['claude-code','codex','pi']`）、调度器、插件沙箱、provider 计费。它的可靠传输层之所以能做到这个深度，是因为它必须跨「桌面 ↔ 云端 relay ↔ 手机」三跳，而且两端都可能离线。

### 2.3 架构差异的本质

| 维度 | DSH Outpost | Cindy | 对我们的含义 |
|---|---|---|---|
| 传输拓扑 | **直连**：手机 → 电脑上的 DSH（局域网/Tailscale/隧道） | **经 relay**：桌面与手机都连云端 relay | Cindy 必须自建可靠层；我们直连 TCP，理论上更简单——**但也因此没有任何「重发/恢复」的现成保障** |
| 会话流 | `session/follow`（DSH 服务端直出） | `maker:event` push + 话题订阅 | 我们的恢复点只能落在「重开 follow + 全量快照」 |
| 状态归属 | DSH 是唯一事实源，客户端只投影 | 客户端有 SQLite + 本地 DB + 版本 fencing | 我们**没有**本地持久层，这是优势（简单）也是风险（崩溃即丢） |
| Agent 编排 | DSH 内部（Agent Teams） | `maker-scheduler` 自研引擎 | **不应自建**，见第 7 章 |
| 单元测试 | 51 spec / 746 个 `check()`，Node 直跑 | 5,596 测试文件，vitest + Maestro E2E | 我们安全/协议层测试强，**UI 层零覆盖** |

---

## 3. 功能与工程能力对照矩阵

图例：✅ 完整实现 ｜ ⚠️ 已实现但有缺陷 ｜ 🟡 部分实现 ｜ ❌ 未实现 ｜ 📄 文档声称但源码无法证明
「引入」列：**建议 / 可选 / 不建议**

### 3.1 通信与连接

| 能力 | Outpost | Cindy | 关键代码依据 | 引入 |
|---|---|---|---|---|
| HTTP RPC 超时 | ✅ 30s 可覆盖（`transport/index.ts:119,257-258`） | ✅ 按 channel 分级（`invokePolicy.ts:125-153`） | 我们已有，且注释解释了取值 | 保持 |
| WS 连接超时 | ⚠️ 仅握手 15s（`transport/index.ts:355-359`） | ✅ 握手看门狗 + 连续超时窗口翻倍（`client.ts:2210-2228`） | 我们**缺**连接后的存活判定 | **建议**（见 P0-1） |
| WS 断线检测 | ❌ **零**：`ensureSocket` 只监听 open/error/message，**无 close 监听**（`transport/index.ts:360-374`） | ✅ 心跳 20s + 双条件判死 + `isValidInboundEnvelope`（`client.ts:2261-2302`） | 本报告 P0-1 根因 | **建议** |
| 流级超时 | ❌ `openStream` 无超时（`transport/index.ts:404-450`） | ✅ 首包/请求双时钟（`client.ts:1813-1836`） | 首帧永不返回即永久 loading | **建议** |
| 断线重连（会话流） | ❌ 无 | ✅ 指数退避 + 抖动 0.7~1.0 + 稳定复位（`client.ts:425-450`） | 只有审批网关有重连 | **建议** |
| 断线重连（审批） | ✅ 完整（`approvalGateway.ts:877-889`） | ✅ | 我们这块做得比多数项目好 | 保持 |
| 重连抖动 | ❌ 无（`approvalGateway.ts:883` 纯指数，无 random） | ✅ 只向下抖动，保证不上溢 | 多设备同刻重启会同时握手 | 可选（1 行） |
| 消息序号/断点续传 | 🟡 有 `seq` 只用于排序去重，**无 `afterSeq` 续传**（`store.ts:1239-1242`） | ✅ `streamId/seq/baseSeq` 累计 ACK，跨重连保留（`transport.ts:174-448`） | 重连只能全量重取 | 可选（见 5.1） |
| 心跳/保活 | ❌ 无 | ✅ ping 20s | 半开连接无法发现 | **建议** |
| 网络变化感知 | ❌ 无 `NetInfo`/`AppState`（全局仅 `PairScreen.tsx:64` 用过 AppState） | ✅ `notifyNetworkChanged` 把系统提示当**线索**而非事实（`client.ts:1005-1048`） | 切 WiFi 后无主动探测 | **建议** |
| 离线队列 | ❌ 无（`store.ts:1373-1385` 直接 await 后抛错） | ✅ durable outbox 状态机（`durableOutbox.ts:126-187`） | 弱网下用户必须手动重发 | 可选（依赖 P1-11） |
| 请求幂等键 | ⚠️ `requestId` 在 API 层内部生成（`rpc/session.ts:77`），重试必然换新 id | ✅ 每操作独立幂等键（`remoteAgent.ts:14-15`） | 阻塞任何重试设计 | **建议**（改动极小） |
| 并发/背压闸门 | ❌ 无 | ✅ 三级优先级 + 设备级上限 + 派发时二次过期校验（`invokeScheduler.ts:5-17,80-88`） | 我们单客户端，压力小 | 不建议（过重） |

### 3.2 任务与执行

| 能力 | Outpost | Cindy | 依据 | 引入 |
|---|---|---|---|---|
| 创建会话/工作区 | ✅（`store.ts:278-296`，`workspaceId` 优先） | ✅ | 幂等性靠 DSH `workspace/create` | 保持 |
| 发消息（排队/插话） | ✅ `mode:'queue'\|'steer'`（`rpc/session.ts:59-84`） | ✅ | | 保持 |
| 取消当前轮 | ⚠️ `store.cancel` 无 try/catch、无乐观更新、无 pending 态（`store.ts:1389-1391`；`ChatScreen.tsx:648` `void`） | ✅ abort + 5s 后强制释放（`scheduler.ts:2252`） | 失败时用户看不到任何反馈 | **建议**（P2） |
| 中断单个 agent | ❌（`interrupt_agent` 只是模型侧工具名，`design/tokens.ts:314`） | ✅ 状态机 | DSH 未暴露 RPC | 属 DSH 核心 |
| 任务恢复/续跑 | ❌ | ✅ `persistentSession` + `resumeSessionId`（`runner.ts:1123,1496-1506`） | 我们的「恢复」= 重开 follow | 属 DSH 核心 |
| 排队消息编辑 | 🟡 `updateQueue` 封装存在但**零调用者**（`rpc/session.ts:92-107`），却被列为必需接口（`protocol.ts:39`） | ✅ | 能力探测会误报「支持」 | **建议**（P2，一行归类） |
| 任务状态机 | 🟡 派生式：`foldEvents` 按事件推 `running`（`fold/index.ts:556`） | ✅ 显式冻结转移表 + 非法转移抛错（`attemptLifecycle.ts:29-45`） | 我们靠 `turn/end` 单事件决定，丢了就永久 running | **建议**（见 P1-1） |
| 状态与服务端对账 | ❌ `refreshChatMeta` 拿到 `row.running` 却不写回（`store.ts:357-368`） | ✅ 派生优先级表 + 心跳租约（`agentTask.ts:177-209`） | P1-1 根因 | **建议** |
| 长任务看门狗 | ❌ 无 | ✅ 4 层阈值阶梯（300s/30min/45min/60min，`scheduler.ts:207-219`） | 「无进展」而非「总时长」判据 | 属 DSH 核心 |
| 进度反馈 | ⚠️ 只有「进行中」动画，无耗时/阶段（`ChatScreen.tsx:574-584`） | ✅ `sessionLiveActivity` + phase | 用户无法判断是卡住还是慢 | 可选 |

### 3.3 客户端体验

| 能力 | Outpost | Cindy | 依据 | 引入 |
|---|---|---|---|---|
| 流式增量合并 | 🟡 有 60ms 尾随节流（`store.ts:869-885`）但**每事件先全量重 fold**（`store.ts:1296-1319`） | ✅ chunk 数组 + 可见性自适应 32/64/96ms + 跳过重排序（`remoteSessionStore.ts:678-686,2979-2980,3125-3145`） | 我们限制渲染、没限制计算 | **建议**（P1-2） |
| 单 token 重渲染行数 | ❌ 整个 ChatScreen 子树（无 `React.memo`、无选择器，`ChatScreen.tsx:115`） | ✅ 1 行，并有测试断言（`messagePerformance.test.ts:170`） | 长会话卡顿主因 | **建议** |
| 行身份保留 | ❌ `toChatItems` 每次新建所有 item（`fold/index.ts:580-619`） | ✅ reconcile 复用旧对象（`messageRenderReconcile.ts:31-76`） | memo 若无稳定 props 等于没做 | **建议** |
| 虚拟化配置 | ✅ `initialNumToRender=14 / windowSize=9`（`ChatScreen.tsx:519-522`） | ✅ + `getItemType` + 关闭 recycle | 我们参数合理 | 保持 |
| 加载更早的滚动锚定 | ❌ 无 `maintainVisibleContentPosition`（`ChatScreen.tsx:512-555`） | ✅ 完整处理 | 翻历史会跳 | **建议**（P2） |
| 「回到最新」提示 | ❌ 无（滚上去 >80px 就静默累积） | ✅ | 远程操作常见痛点 | **建议**（P2） |
| 草稿持久化 | ❌ 纯组件 state（`ChatScreen.tsx:95`），返回即丢 | ✅ | 手机上误触返回就白打 | **建议**（P1-8） |
| 连接状态 UI | 🟡 仅「我的」页手动 ping（`ProfileScreen.tsx:163`），聊天页无 | ✅ 纯函数可见性策略 + 3s 防闪（`connectionBannerVisibility.ts:14-46`） | 用户不知道已断线 | **建议**（P1-3） |
| 审批呈现 | ⚠️ 横幅，且**只在 ChatScreen 内可操作**（`ChatScreen.tsx:470`） | ✅ 底部常驻面板 + 队列 + 折叠意图持久化 | 在别的页面收到审批只能看不能点 | **建议**（P1-5） |
| 审批失败反馈 | ❌ `onAnswer` 返回值被丢弃（`ChatScreen.tsx:478-481`），`busy` 800ms 后自动复位（`ApprovalBanner.tsx:51-60`） | ✅ 乐观隐藏 + 抑制窗口 + 失败还原（`InteractionPanel.tsx:567-579`） | 用户以为批了其实没批 | **建议**（P1-6） |
| 审批「始终允许」 | ❌ 协议不支持（`docs/mobile-gateway.md:114`） | ✅ 会话级作用域（`interaction.ts:1080-1085`） | 依赖上游 | 属上游 |
| 审批二次确认 | ❌ 无（高危工具也一键批） | ✅ arm-then-commit（`InteractionPanel.tsx:796-807`） | 手机误触即批准 shell | **建议**（P2） |
| 审批审计 | ❌ 决策不落本地，卡片决定后从 UI 移除（`fold/index.ts:541-547`） | 🟡 部分（仅进 transcript） | 「我刚才批了什么」无从查 | 可选 |
| 后台通知 | 🟡 本地通知 + 5s 轮询（`notify.ts:184-208`），App 被杀即失效（已如实说明） | ✅ Android 前台服务 + push inbox 游标（`ChatConnectionService.kt:30-107`） | 我们已诚实标注限制 | 可选（成本高） |
| 通知去重 | ⚠️ 全局 3s 单桶，审批与完成**共用**（`notify.ts:113,225`） | ✅ 按 kind + 会话 | 审批可能被完成通知吞掉 | **建议**（P1-9） |
| 通知点击路由 | ⚠️ 冷启动可能丢（`App.tsx:1294-1307` 依赖 `authed`） | ✅ 校验后重建 deep link（`pushRegistrationModel.ts:51-120`） | 见 P2-6 | 可选 |
| 深色模式 | ✅ token 化彻底（`screens/**` 零硬编码色） | ✅ | **这块我们比 Cindy 之外的多数项目干净** | 保持 |
| 跟随系统主题 | ❌ 无 `useColorScheme` | ✅ + `Appearance.setColorScheme` 驱动原生控件 | | 可选 |
| 无障碍 | 🟡 部分 label，`SlideSegmented` 完全不可读（`SlideSegmented.tsx:124-163`） | 🟡 同样不完整 | | 可选 |
| i18n | ❌ 全硬编码中文 | ✅ 5 locale + glossary 门禁 | 单人项目合理取舍 | 不建议 |

### 3.4 安全与稳定性

| 能力 | Outpost | Cindy | 依据 | 引入 |
|---|---|---|---|---|
| 凭据加密存储 | ✅ Keystore `WHEN_UNLOCKED_THIS_DEVICE_ONLY`（`secureStore.ts:156-161`） | ✅ 系统钥匙串 | | 保持 |
| 明文 HTTP 限制 | ⚠️ 规则正确但**只在 2 个入口校验**（`transport/index.ts:174`、`PairScreen.tsx:104`）；`call()`/`ensureSocket()`/`upload`/`fileUrl`/`deviceAuth`/`gateway` 全部裸奔 | ✅ 下载器统一 `isUrlAllowed` 每次重定向复检（`verified-downloads.md:9-30`） | 见 P1-4 | **建议** |
| 令牌泄漏面 | ⚠️ `doctor.ps1:164,176,201` 直接打印含 token 的 URL | ✅ 日志四层收口（source→regex→field→cap） | 诊断脚本会被贴进 issue | **建议**（P1-10） |
| 本地 HTTP 控制面 | ⚠️ loopback 绑定正确，但 CORS 放行**任意私网 origin** 且返回明文 token（`tunnel-service.mjs:70-71,225-237`） | ✅ loopback + 32B 随机 bearer + 常数时间比较（`tunnel.ts:79-106`） | 见 P1-2 | **建议** |
| 配对端点鉴权 | ❌ 未认证（第三方插件 `/mgw/pair`），且我们的脚本 `adminLoopbackOnly: false` 打开了局域网 | ✅ 单次码 + SHA-256 存储 + `timingSafeEqual` | 见 P0-2 | **建议** |
| 服务端身份绑定 | ✅ **强**：`gatewayId` vs `gatewayInstanceId` 判别 + 五态 `BindingResolution` + 写后回读（`serverIdentity.ts:112-122,267-280`） | 🟡 依赖云端会话 | 我们这块超过 Cindy 同类 | 保持 |
| 撤销 fail-closed | ✅ 三态 + 双通道标记 + 读失败即禁止自动配对（`deviceRevocation.ts:426-462`） | ✅ | 设计质量高 | 保持 |
| 凭据迁移 | ✅ 7 状态机 + 写后回读 + 失败不静默降级（`credentialMigration.ts:114-152,305-321`） | — | 少见的严谨 | 保持 |
| 更新包完整性 | ❌ 只校验大小（`updater.ts:77-86`），已发布 `SHA256SUMS.txt` 但**客户端从不校验** | ✅ 强制 sha256 + size + 单飞（`downloader/index.ts:35-43`） | 见 P1-1 | **建议** |
| 签名身份 | ❌ 仓库内提交了 **AOSP debug keystore**（`.gitignore:44` 显式放行），所有正式包同签 | ✅ 外部签名 + 失败即硬停（`forge.config.ts:585-596`） | 见 P1-1 | **建议** |
| Electron 渲染进程隔离 | 🟡 `contextIsolation:true / nodeIntegration:false` 但 `sandbox:false`（`main.js:307-309`），无 `will-navigate`/`setWindowOpenHandler` | ✅ 11 字段基线 + 表驱动测试 + webview 强制覆写（`webview-security.ts:93-142`） | 当前只加载 `file://`，风险有限 | **建议**（低成本） |
| IPC 权限面 | ✅ 11 个通道，动词白名单，**无任意命令执行**（`main.js:567-828`） | ✅ sender guard 双向 + `[CODE]` 错误协议 | 我们结构正确，缺 sender 校验 | 可选 |
| 崩溃/日志边界 | ⚠️ 崩溃日志有，但 `App.tsx:598-600` 的 catch-all 把迁移/撤销/意图全部吞成「未登录」 | ✅ 3 阶段 disposer + 外部强杀看门狗 + run marker | 见 P2-8 | 可选 |
| 退出清理 | ❌ `before-quit` 只杀 `serviceProc`（`main.js:930-939`），**cloudflared 残留 → 机器仍对公网暴露** | ✅ 3 阶段 disposer 预算 | 见 P1-12 | **建议** |

### 3.5 工程质量

| 能力 | Outpost | Cindy | 依据 | 引入 |
|---|---|---|---|---|
| 单元测试 | ✅ 51 spec / 746 个 `check()`，安全与协议层**驱动真实模块** | ✅ 5,596 文件 | `tests/README.md:212` 的自述属实 | 保持 |
| 协议集成测试 | ✅ `fake-dsh.mjs`（28KB）真 HTTP + 手写 RFC6455 | ✅ `MemoryRelay` + 故障注入 | 我们这块相当扎实 | 保持 |
| UI/渲染测试 | ❌ **零**（无 react-test-renderer / testing-library；`device-list-state-spec.mjs:39` 自认） | ✅ 201 个 jsdom 组件测试 + Maestro 41 流 | 高风险区无任何行为覆盖 | **建议**（选择性） |
| 静态检查伪装成单测 | ⚠️ 22/45 spec 用 `readFileSync` 正则扫源码（如 `timeout-throttle-spec.mjs:49-155`） | ✅ 显式分离 guard tier 与 unit tier（`test-workspaces.config.mjs:430-443`） | 我认可它们的「分层」思想 | **建议**（概念） |
| 孤儿测试 | ⚠️ `tests/version-code-spec.mjs` 未被任何 npm script 引用 | — | 一行修复 | **建议** |
| CI 覆盖 | ⚠️ 只跑 `dsh-mobile`；**desktop / plugin / PowerShell 零自动化**（`android.yml:52-81`） | ✅ 多 OS 分片 + 20+ 检查脚本 | 见 P1-13 | **建议** |
| 发布门禁 | ✅ Gate1-4（签名材料/版本单调/keystore 校验/证书指纹）确实硬失败（`android.yml:186-375`） | ✅ 可执行断言 + fuses | **这块比多数个人项目强** | 保持 |
| Gate 4 指纹校验 | ⚠️ `if [ -n "$EXPECTED" ]` 未设置时只 warning 照样发（`android.yml:344-358`） | — | 与发布报告 §101 的描述不符 | **建议**（1 行） |
| 可复现构建 | ❌ 桌面 zip 用文件 mtime，两次构建字节不同（`pack.js:151`） | — | 未宣称，属诚实空白 | 可选 |
| 文档准确性 | ⚠️ 4 处与代码矛盾（见 6.5） | ✅ 大部分有 incident 注释 | | **建议** |
| 注释质量 | ✅ 异常高：常量多带事故日期与实测数字 | ✅ 同样高 | **两者共同的优点** | 保持 |

---

## 4. DSH Outpost 已有优势（不要为了模仿而重构）

以下能力**已经做对了**，改动只会增加风险：

1. **审批网关的失败分类。** `isCredentialRejection()` 只认 401（`approvalGateway.ts:245-257`），并用 30 行注释解释了为什么不能把 403 / 1006 / ECONNREFUSED 当凭据失效（`:214-243`）；`isDeviceRevokedClose()` 要求 `4003` **且** reason 匹配 `device revoked`，刻意排除网关另一种 4003 用法（`:100-104`）。这比 Cindy 同类逻辑更严谨——Cindy 的心跳 docstring 写「2 个周期无 pong」，实现却是 4 次且 ≥80s（`client.ts:212` vs `:2281-2282`），文档与代码已经漂移。
2. **服务端身份绑定。** `serverIdentity.ts` 区分了「UUID 属于哪台服务器」，用判别联合而非 bool（`:112-122`），并对 404 采取保守解释（`canTrustNotFound` 仅 `confirmed` 才允许）。这是「撤销看起来成功了但其实没撤」这一类 bug 的正解。
3. **撤销 fail-closed 三态。** `revoked / unknown / not-revoked`，读失败 ≠ 未撤销（`deviceRevocation.ts:426-462`），双通道标记 + 写后回读。
4. **凭据迁移。** 7 个终态 + 「读失败不等于干净」+ 先写后读回再删明文（`credentialMigration.ts:225-232,305-321`）。
5. **协议能力探测而非版本号协商。** `protocol.ts:19-25` 的取舍说明是对的：DSH 没暴露协议版本，语义化版本又不可靠。`checkCompatibility()` 只探只读接口（`store.ts:968-990`）。
6. **错误信息给人话。** `RpcError` 带 `userTitle/userHint/retryable`（`rpc-error.ts:32-66`），transport 层按 `not-found / auth / network / malformed / 5xx` 分类（`transport/index.ts:19-72`）。用户不会看到 `gateway/not-found`。
7. **测试驱动真实产品代码。** `fake-dsh.mjs` 是真 HTTP + 手写 WebSocket，凭据/撤销/网关门禁这些 spec 直接 import 生产模块（`tests/README.md:212` 自述属实，audit 抽查 `credential-migration-spec.mjs` 等 10 个文件确认）。
8. **管家模式省 token 的取舍。** 模式切换用**单条指令**而非每条消息带标记（`butler.ts:120-134`），100 轮省 100 个标记。这个决定是对的。
9. **深色模式 token 化彻底。** `src/screens/**` 零硬编码色，34/34 组件用 `useMemo(() => makeStyles(tv), [tv])`。
10. **图片分块落盘的坑已修。** `gatewayFiles.ts:106-123` 把「不能把多块 base64 拼起来再解码」的原理和实测症状写清楚了，是正确的独立编码分块写法。
11. **导航手势 + 键盘处理。** `NavHost.tsx:113-125` 的边缘判据要求 `|dy| <= |dx|`；`ChatScreen.tsx:196-217` 明确说明不要与 `adjustResize` 叠加 marginBottom（真机踩过）。
12. **发布门禁。** Gate1（签名材料缺失硬失败，无 debug 回退）、Gate2（versionCode 水位线单调）、Gate3（keystore 别名+密码校验，不打印）、Gate4（`apksigner verify` + badging 比对）——这套在个人项目里属于上游水平。

**结论：不需要照搬 Cindy 的任何目录结构或技术栈。**

---

## 5. 值得借鉴的 Cindy 设计（按实际价值排序）

### 5.1 可靠流：累计 ACK + 断点续传 +「在途请求选择性存活」

**技术原理。** `transport.ts` 把每条逻辑消息包成 `{streamId, seq, baseSeq?, segment?}`，接收端回累计 ACK（`transport.ts:402-448`）；`streamId` 在 relay 重连后**保留**（`client.ts:815-819`），握手双方都带 `transportBaseSeq`（`protocol.ts:136-137,180-181`），让对端在自身重启后也能重建基线。断连时 `failNonReliablePending()` 只 reject「从未写出去」的请求，**已写出的保留原 seq 重放**（`client.ts:1921-1929`），并用错误上的 `inFlight` 位告诉调用方「可能已到达」（`protocol.ts:99-119`）。

**对 Outpost 的适配（不需要照搬整个协议）。**
我们直连 DSH，不需要分片/ACK 全栈。但「流断线后能接着看」这件事需要三个最小件：

1. `DshConnection.ensureSocket()` 增加 `close` 监听（`transport/index.ts:360-374` 补一个 `addEventListener('close')`）。
2. close 时把所有活跃 stream 以 `RpcError(kind:'network')` 失败掉 —— 让 `pump()` 的 `await` 立即返回（`store.ts:1232-1253`）。
3. `Store` 记住每个会话已 fold 到的 `maxSeq`，重连后重新 `follow` 拿快照，按 seq 合并（现有 `records: Map<seq, EventRecord>` 天然幂等，`store.ts:1241` 已是按 seq 写入）。

**改动面**：`core/transport/index.ts`（+30 行）、`core/store.ts`（`openChat`/`pump` 增加重连入口，+40 行）。
**代价**：小。**风险**：低——现有 fold 已按 seq 去重，重放安全。
**收益**：这是 P0-1 的正解，也是「更可靠远程连接」这个目标的核心。

### 5.2 流式渲染四层：chunk 累积 + 可见性自适应 flush + 跳过重排序 + 行身份保留

**技术原理（Cindy 实测代码）。**
- 增量以 **chunk 数组**累积，每次 flush 只 `join('')` 一次，避免 O(n²) 字符串拷贝（`remoteSessionStore.ts:678-686`）。
- flush 间隔按可见性分级：可见 64ms、后台 96ms、首包 32ms（`:674-676`，选择逻辑 `:3125-3145`）。是**截止时间**而非 debounce，重复调用只能缩短不能延后（`:3133-3137`）。
- store 写入走「内容替换、顺序不变」快路径：`existing.slice()` + 单点替换，**跳过全量 `normalizeMessages` 重排**，并继承上一個数组的结构 token / 索引 / 字节统计（`:2979-2980, 2684-2694`）。
- 渲染模型重建被限制在**当前活跃 turn**，历史前缀按结构 token 复用（`messageRenderStreamingCache.ts:182-197,229-233`）；即使必须重建，`messageRenderReconcile.ts:31-76` 也会对字段相等的行**返回原对象**，让 `memo` 真正 bail out。
- 有测试断言：250 次连续流式更新后 `changedRows === 1`（`messagePerformance.test.ts:170`）。

**对 Outpost 的适配。**
我们的问题是 `rebuild()` 每次全量 fold（`store.ts:1296-1319`）。最小改动顺序：

1. **P1 优先**：`pump()` 里不要每事件调 `rebuild()`，改为按 `EMIT_THROTTLE_MS` 窗口累积一批 seq 再重建（`store.ts:1242`）。**这一步就能把 O(n) 从「每 token」降到「每 60ms」，改动约 15 行。**
2. **P2**：`ChatScreen` 的 `renderItem` 用 `React.memo` 包一层 `MessageRow`，并在 `toChatItems` 里对未变化的 step 复用上一版对象（`fold/index.ts:580-619`）。
3. **P2**：给 `Store` 增加会话级订阅通道（见 5.3），让「别的会话的 emit」不再触发当前页面重渲染。

**代价**：中（前两步各 0.5 天）。**风险**：第 2 步的相等判据必须覆盖该行读的所有字段，否则出现陈旧行。
**收益**：直接对应「更流畅的 Android 操作体验」。

### 5.3 会话级订阅通道（替代全局 force-update）

**技术原理。** Cindy 的 store 用**三个独立通知通道**：全量版本、首页状态版本（「普通文本 delta 不推进它」，`remoteSessionStore.ts:6530-6534`）、以及按 `sessionId` 的消息/预览订阅（`:5877,6393,6401`）。渲染粒度由订阅通道决定，而不是由组件层级决定。

**对 Outpost 的适配。** 当前 `Store.subscribe(fn)` 是裸回调、无参数（`store.ts:838-841`），每个页面都 `force(n => n+1)`（`ChatScreen.tsx:115`、`SessionsScreen.tsx:73`、`WorkspacesScreen.tsx:95`、`DevicesScreen.tsx:115`…）。最小改法是给 `subscribe` 增加一个可选的 `key`（`'sessions' | 'chat:<id>' | 'gateway' | 'notices'`），`emit()` 按脏标记分通道通知。

**代价**：小（约 40 行）。**收益**：高——这是「一行代码换全 App 少重渲染」的杠杆点。

### 5.4 纯函数化的连接可见性策略 + 防闪延迟

**技术原理。** `connectionBannerVisibility.ts:14-27` 是一个纯函数：错误与「设备无响应」立即显示，普通离线必须持续超过 3s 才显示（`connectionNoticeDelay.ts:1-7`）；并且**刻意不提供「同步」按钮**，避免与自动重连竞争（`:30-46`）。

**对 Outpost 的适配。** 我们现在只有「我的 → 连接状态」的手动 ping（`ProfileScreen.tsx:163`），聊天页完全没有连接指示（`ProfileScreen.tsx:89-91` 自己也说明了 `store.connection` 在流层无意义）。加一个纯函数策略 + 聊天页顶部横幅即可，且策略可单测（正好补上当前 UI 层零测试的窟窿）。

**代价**：小（1 天，含测试）。**收益**：高——这是 P0-1 的用户可见面。

### 5.5 审批：队列 + 折叠意图持久化 + arm-then-commit + 乐观隐藏 + 抑制窗口

**技术原理。** 审批不是模态框，而是底部常驻 surface（`sessions/[sessionId].tsx:10758`）；多个待审批进队列并有优先级（`interaction.ts:794-843`）；折叠是**页面级持久意图**（`pendingInteractionCollapseStore.ts`），并且「非权威的空待办列表不得清除折叠记录」（`interactionModel.ts:156-175`）——否则每次网络抖动都会把卡片重新弹出来。高危审批需要两次点击（`InteractionPanel.tsx:796-807`）。点击后同帧移除并登记抑制窗口，防止服务端快照把它闪回来（`:567-579`）。

**对 Outpost 的适配（按性价比排序）。**
- **必做**：审批失败要可见。当前 `ChatScreen.tsx:478-481` 丢弃 `answerApproval` 的 bool，`ApprovalBanner` 的 `busy` 800ms 后无条件复位（`ApprovalBanner.tsx:51-60`）。改成 await + 失败文案 + `canAnswer` 判活即可（约 20 行）。
- **必做**：让审批在任意页面可操作。现在只有 `ChatScreen` 内渲染横幅（`ChatScreen.tsx:470`），全局 `NoticeHost` 只是 3.5s 吐司且点了只跳会话（`App.tsx:1312-1314`）。
- **可选**：高危工具二次确认。

**代价**：小~中。**收益**：高——这是「更严格的用户授权」与「更可信的任务状态」的交点。

### 5.6 显式状态机（冻结转移表 + 非法转移抛错）

**技术原理。** `attemptLifecycle.ts:29-45` 把 7 个状态的合法转移写成 frozen 常量表，非法转移**抛错而非容忍**（`:5-7`），注释记录了「同一个 exit 分支漏掉 cleanup」在 review 里出现 4 次，于是一次性枚举了全部 7 个写入点（`:9-10`）。

**对 Outpost 的适配。** 两处直接受益：`ApprovalGateway` 的连接状态（现在散在 `connect/onclose/onerror/scheduleRetry` 多处赋值，`approvalGateway.ts:406-798`）和 `Store.connection`（`store.ts:70` 四态但只被两处写）。约 45 行。

**代价**：小。**收益**：中——主要买的是「以后加状态不会漏」。

### 5.7 「失败半径」按证据分级

**技术原理。** Cindy 区分「relay 静默」（整个连接有问题）与「peer 静默」（单个对端有问题）：只有**所有** ready peer 都自各自队首写出后仍无任何入站，才重建整连接；否则只复位该 peer（`client.ts:5033-5082, 5199-5226`）。注释记录了反面代价：一台睡着的 iPhone 一天内把共享 relay 干掉 38 次（`client.ts:2016-2019`）。

**对 Outpost 的适配。** 我们的两条 WS（mux 流 + 审批网关）完全独立，本来就是「小失败半径」。真正可借鉴的是**判据**：mux 断开时，只影响流，不能连带把审批网关状态或会话列表状态改坏；反之亦然。当前已经基本如此，但 `Store.connection` 被 `ping()`（`store.ts:911-943`）和 `loginWithToken()`（`:895-909`）写，语义含糊——建议明确「流健康」与「HTTP 可达」是两个指标。

**代价**：极小。**收益**：中。

### 5.8 测试：故障注入 + 按事故命名的 describe

**技术原理。** Cindy 的 `client.test.ts` 有四层可组合脚手架：`FakeWs` 可编程 socket（记录 `sent`、暴露 `bufferedAmount`）、`makeHarness` 注入快时序、`MemoryRelay`（**同步、保序、且模拟生产不变量「发往离线目的地会在入口丢弃，靠发送端可靠层保留」**，`client.test.ts:692-696`）、以及 `dropNext(predicate)` / `disconnect()` 一行注入故障（`:720-730`）。describe 用事故命名：`'可靠传输死锁自愈(2026-08-03 线上实锤...)'`（`:7019`）。

**对 Outpost 的适配。** 我们已有 `fake-dsh.mjs`（真 HTTP + 手写 WS，28KB），最缺的是**主动断连注入**。加两个能力即可：`server.closeAllConnections()` 触发器，以及「不发 `turn/end` 就断」的场景。这会直接复现 P0-1/P1-1，并成为回归护栏。

**代价**：小（半天）。**收益**：高——把本报告最重要的两个 P0/P1 变成可回归。

### 5.9 Electron 窗口安全基线做成测试

**技术原理。** Cindy 把 11 个 `webPreferences` 字段写成常量，并用表驱动测试断言它们（`webview-security.test.ts:216-236`），因为「Electron 大版本之间默认值会变，静默放宽必须不可能」。

**对 Outpost 的适配。** `main.js:306-309` 只有 3 个字段，`sandbox:false`，且无 `will-navigate`/`setWindowOpenHandler`。补齐字段 + 一条测试即可。

**代价**：小。**收益**：中（防未来回归）。

### 5.10 三阶段退出清理 + 外部强杀看门狗

**技术原理。** `lifecycle.ts:116-188` 分 sync → async（带预算）→ post-async（带预算）三阶段；`:337-433` 再挂一个 detached killer，20s 后强杀自己，因为「同步 disposer 阻塞事件循环」和「`app.exit()` 卡在原生 teardown」都真实发生过（注释记录了一次 32 小时僵尸进程，`:322-324`）。

**对 Outpost 的适配。** 当前 `before-quit` 只杀 `serviceProc`（`main.js:930-939`），cloudflared 是 PowerShell 的孙子进程，**退出后仍在跑**——用户以为关了程序，机器其实还对公网开着隧道。最小修复：退出时调一次 `start-tunnel.ps1 -Stop`，并把「隧道是否在跑」写进面板的退出确认。

**代价**：小。**收益**：高（安全 + 用户预期一致性）。

---

## 6. DSH Outpost 独立发现的问题（不依赖 Cindy 对比）

> 以下全部来自对 Outpost 自身源码的追踪。分级见第 8 章。置信度：**确认 / 很可能 / 待验证**。

### 6.1 P0-1 —— 会话流静默死亡：聊天永久卡在「进行中」，无错误、无恢复（**确认**）

**证据链。**
1. `core/transport/index.ts:360-374`：`ensureSocket()` 只注册了 `open`、`error`、`message` 三个监听。**全文没有 `close` 监听**（grep `addEventListener` 仅 3 处）。
2. `core/transport/index.ts:434-441`：流的 `async *[Symbol.asyncIterator]()` 在没有数据时执行 `await new Promise<void>((r) => { notify = r; })`。`done` / `failure` 只可能由 `end` / `error` **帧**设置。
3. socket 断开后不会再有帧 → 该 Promise 永不 settle → `iterator.next()` 永不返回。
4. `core/rpc/session.ts:167-177` 的 `next()` 直接 `await iterator.next()`。
5. `core/store.ts:1232-1253` 的 `pump()` `while (true) { const rec = await next(); ... }` 挂死，`catch` 分支永不进入 → `chat.error` 从不被写。
6. `fold/index.ts:556` 会给任何没有 `endedAt` 的 turn 标 `running = true`；`store.ts:1315` 用最后一轮决定 `chat.running` → 界面永久显示「进行中」+ 动画点。

**用户可见症状。** 消息流到一半停住，转圈动画一直动。此时发新消息**看起来成功**（`session/prompt` 走 HTTP，是通的），但回复永远不出现。唯一恢复方式是退出会话页再进（`ChatScreen.tsx:117-120` 的 cleanup 会 `closeChat`，再进时重新 `follow`）。切 WiFi↔蜂窝、锁屏、DSH 重启都会触发。

**为什么现有测试抓不到。** `tests/integration-transport.mjs` 等只验证「正常收发」与「401 分类」，没有「不发结束帧就断开」的注入；`tests/README.md` 自己声明按 4 层测试，但端到端层是手工的。

**修复方向。** 见 5.1 / 9.1。

### 6.2 P0-2 —— 局域网内任何人都能无认证铸造网关配对码，进而接管审批与远程控制（**确认，已在本机复现**）

**证据链（第三方插件，但是我方配置把它置于此状态）。**
1. `dsh-mobile/src/core/approvalGateway.ts:828-864` `requestPairingCode()` → 手机 `POST /mgw/pair`（8s 超时）。
2. 插件侧：`dsh-plugin-mobile-gateway@0.10.3` 的 `lib/index.mjs:2696-2703` —— `adminLoopbackOnly` 只挡 `/mgw/*` 前缀；一旦为 `false`，**只剩 `isSameOrigin` 保护非 GET**。
3. `lib/index.mjs:2083-2092` `isSameOrigin()`：`if (origin === undefined) return true;` —— **无 Origin 头（curl / 任意脚本）直接放行**。
4. `lib/index.mjs:2827-2858` `POST /mgw/pair`：仅检查 `gatewayEnabled` 与 `publicUrl` 合法性，**无任何凭据校验**，直接 `registry.createPairing()` 并返回 `pairingCode`。
5. 攻击者拿到自己 mint 的 code → 走 WS `dsh-pair.<code>` → `lib/index.mjs:2903` `claimPairing(...)` 成功 → 获得 256-bit device token。
6. **我方交付物把 1 变成了现实**：`setup-gateway.ps1:109-115` 写入 `gatewayEnabled:true / requireAuth:true / adminLoopbackOnly:false / lanEnabled:true / lanHost:0.0.0.0`；`docs/mobile-gateway.md:41` 也指导用户这样配。

**文档给出的理由不准确。** `docs/mobile-gateway.md:28-29` 称「DSH 的 web server 绑在局域网 IP 上，回环地址连不进去，所以管理接口打不开」。真实约束是**手机必须能 `POST /mgw/pair`**（手机不在本机回环）。两件事不同：前者是浏览器视角，后者才是协议依赖。

**影响面（取决于第三方插件的能力表，`lib/index.mjs:3026-3040`）。** 配对设备可执行：发 prompt（⇒ agent 跑 shell 工具）、`permission` 切换（⇒ `danger-full-access` 直接关闭审批，DSH 侧证据：asar `approval.config.policy: … === 'danger-full-access' ? 'never' : 'ask'`）、`plugin-install` / `plugin-remove`（⇒ 向 DSH 宿主安装任意代码）、`directory-create`、`workspace-create`、`command-execute`。**即「配对即全权」。**

**为什么仍列为 P0。** 项目自身的威胁模型（`docs/security.md:12-19`）已把「公共 WiFi 上同网段的人」列为风险，而这里是一个**写入原语**而非被动嗅探。

**修复方向（不实施，仅建议）。**
- **正解（架构级，推荐）**：把「铸造配对码」这件事从手机侧移到**桌面助手的 loopback 调用**——桌面助手本来就在本机，`POST http://127.0.0.1:3095/mgw/pair` 可用；把返回的 `pairingCode` 编进配对二维码（`core/pairing.ts` 目前支持 URL-with-token 与裸 base64url 两种形态，扩展第三种即可），手机跳过 `requestPairingCode()` 直接用 `dsh-pair.<code>`。随后把 `adminLoopbackOnly` 改回 `true`。
- **过渡（1 行）**：`setup-gateway.ps1` 与 `docs/mobile-gateway.md` 显式警示「开启后同网段任何设备可铸造配对码」，并在面板里把该状态标红。
- **彻底**：向插件上游提交「配对需本机确认」的选项（`{ok:true}` 需桌面端点击）。

### 6.3 P1-1 —— 更新包只校验大小 + 仓库内提交了公共 debug 签名密钥（**确认**）

**证据。**
- `core/updater.ts:77-86` `isComplete()`：判据是「文件存在 **且** 大小等于 release 声明的 size」；注释自认「release 没给 size 时退化成存在即用」。
- `core/updater.ts:144-147` 下载后再校验**一次大小**，无哈希、无签名。
- CI 确实生成并发布了 `SHA256SUMS.txt`（`.github/workflows/android.yml:385,409`），**但客户端从不拉取它**。
- `git ls-files` 确认 `dsh-mobile/android/app/debug.keystore` 被跟踪；`.gitignore:43-44` 是 `*.keystore` 后紧跟 `!dsh-mobile/android/app/debug.keystore`（显式放行）。
- `dsh-mobile/android/app/build.gradle` 的 release signingConfig 回退到 `signingConfigs.debug`。

**后果。** 任何克隆仓库的人都能构建出 `Android` 会接受为「升级」的同签名 APK；配合 `REQUEST_INSTALL_PACKAGES` 权限（`AndroidManifest.xml:18`）与 App 内一键安装，构成完整的更新链伪造路径。

**为什么列 P1 而非 P0。** 需要仓库账户被攻破，或用户从非官方渠道拿到 APK；且项目已在 `DSH-OUTPOST-RELEASE-REPORT.md:126-130` 如实披露。但**影响一旦发生是全量用户 RCE**，所以修复优先级应视为 P0 级。
**最小修复。** 客户端下载后校验 release body 里已发布的 SHA-256（`updater.ts` +15 行，`SHA256SUMS.txt` 已经存在）；同时把 CI Gate4 的指纹比对改成硬失败（见 P2-2）。

### 6.4 P1-2 —— 本地隧道控制服务把明文 token 交给任意私网 origin（**确认**）

**证据。** `dsh-plugin-connect/tunnel-service.mjs`
- `:70-71` `ALLOWED_ORIGIN` 接受 `127.0.0.1 | localhost | 10.x | 172.x | 192.168.x` 的**任意** origin。
- `:77-85` `corsHeaders()` 回显该 origin。
- `:225-237` `getStatus()` 返回 `token: pair?.token`、`lanUrl`（含 `?token=`）、`pairUrl`（含 `?token=`）。
- `:274` 只有**存在** Origin 时才校验；无 Origin 直接放行（设计如此）。
- 绑定 `127.0.0.1`（`:359`）是对的，但 CORS 让**任意私网页面的浏览器**成为代理。

**后果。** 同网段内任何 HTML 页面（被入侵的 IoT、同事本机起在 0.0.0.0 的 dev server、NAS 管理页）可 `fetch('http://127.0.0.1:3199/tunnel/status')` 读到 DSH token，并可 POST `/tunnel/start|stop|repair` 驱动服务。跨公网 origin 会被 403（这点是对的）。
**修复。** 只放行 `http://127.0.0.1:<DSH_WEB_PORT>` 与 `http://localhost:<port>`（即 DSH 自身页面），不回显其它私网 origin；`/tunnel/status` 不返回 `token`（面板本来就从 `pairing.json` 读到了）。

### 6.5 P1-3 —— 即使连接正常，`chat.running` 也可能永久为真（**很可能**）

**证据。** `store.ts:1315` `running: last?.running ?? false`；`fold/index.ts:464-474` 只有 `turn/end` 会清 `running`，`:556` 兜底标 running。而 `refreshChatMeta()`（唯一能拿到服务端 `row.running` 的地方）**拿到了却故意不写回**（`store.ts:357-368` 只更新 title/context/model/agentTeam）。

**触发条件**：宿主崩溃、取消后未发 `turn/end`、事件丢失。
**症状**：永久「进行中」+ 永久可点的「打断」按钮；且由于 `prev.running && !row.running` 的转变永不发生（`store.ts:483-490`），**该会话的完成通知也永远不会发**。
**修复。** `refreshChatMeta` 里用 `row.running` 覆盖本地 `running`（服务端为权威），fold 只作为快速路径。约 5 行。

### 6.6 P1-4 —— 明文 HTTP 安全检查只在 2 个入口生效（**确认**）

**证据。** `checkBaseUrlSecurity()` 只在 `transport/index.ts:174`（`loginWithToken`）与 `PairScreen.tsx:104`（UI 预校验）调用。以下**全部未校验**：`DshConnection.call()`（`transport/index.ts:252`，携带 `Cookie` 头）、`ensureSocket()`（`:338`）、`ApprovalGateway.requestPairingCode()`（`approvalGateway.ts:840`，`credentials:'include'`）、`deviceAuth.listPairedDevices()` / `postRevokeDetailed()`（`deviceAuth.ts:170,258`）、`serverIdentity.fetchServerGatewayId()`（`:203`）、`UploadApi.uploadBinary()`（`rpc/upload.ts:49`）、`fileUrl.fetchRemoteFile()`（`fileUrl.ts:75`）。
另外 `App.tsx:528-532` 从 `@dsh/baseUrl` 恢复地址时**没有重新校验**。

**为什么仍然是问题。** 单用户路径上 `baseUrl` 只在配对时写入，所以是「传递性满足」；但这是**入参时刻的策略**，不是**使用时刻的强制**。任何一个新加的裸 fetch、或一个由旧版本/备份写入的 `http://` 公网地址，都会绕过这层保护——正是 `net-security.ts:5-22` 声称要防的场景。
顺带：`isPlainHttp()` / `isPublicHost()`（`net-security.ts:106,115`）导出了但**全项目零调用**，即 `docs/security.md` 描述的「明文风险提示」在 UI 上并不存在。

**修复。** 把校验下沉到 `DshConnection` 构造函数与 `ApprovalGateway` 构造处（fail fast），并给所有 `fetch` 站点加一个 `assertSecureUrl()` 包装；恢复 `baseUrl` 时复校验。约 50 行。

### 6.7 P1-5 —— 审批只能在聊天页操作，且失败静默（**确认**）

**证据。** 横幅只在 `ChatScreen.tsx:470-482` 渲染；全局 `NoticeHost` 的审批吐司 3.5s 自动消失（`NoticeHost.tsx:85`），点击只调 `store.requestOpenSession(sessionId)`（`App.tsx:1312-1314`），**不定位到具体审批**。`answerApproval` 返回 bool 但调用处丢弃（`ChatScreen.tsx:478-481`）；`ApprovalBanner` 的 `busy` 用 `setTimeout(() => setBusy(false), 800)` 无条件复位且未在卸载时清理（`ApprovalBanner.tsx:51-60`）。
另：`pendingApprovals` 无 TTL（`store.ts:566`，仅 `onResolved`/`revoked` 清除），服务端静默解决时会留下一个能点但无效的横幅。

### 6.8 P1-6 —— 轮询无 AppState 门控，前后台都在打 `session/list`（**确认**）

**证据。** `ChatScreen.tsx:171-179` 每 2s `refreshChatMeta()`；`store.ts:317-325` 每次都 `api.list()` 并 `groupByWorkspace()` 重建整个工作区分组；`store.ts:398-405` 另有独立 5s `scanOnce()`，注释明确拒绝「空闲就不扫」。`notify.ts:240-246` 定义了 `isForeground()` 但**全项目零调用**。
`workspaceFilter.ts:12-14` 自述实测一台机器 173 个会话 → 每个 tick 都是全量序列化 + 客户端分组。开着一个管家会话时约 1.7 次 `session/list`/秒，且**后台不停**。

### 6.9 P1-7 —— `wakeButler` 可能注入重复/错误的「汇总」prompt（**很可能**）

**证据。** `store.ts:786-801` 由客户端替用户发 `session/prompt`；触发条件是 `store.ts:347-355` 的快照判断；`store.ts:336` 对「两次轮询之间新建并完成」的任务不可见（`before === undefined` 被跳过）；失败静默（`:795-797`）；`waking` 保护仅 30s（`:799`）。
**后果**：可能发送用户没写过的指令（虽被 `fold` 过滤不可见，`fold/index.ts:40`），消耗额度，甚至产生重复汇总。且用户无法审计「App 代我说了什么」。

### 6.10 P1-8 —— 返回即丢草稿（**确认**）

`ChatScreen.tsx:95` 的 `draft` 是组件 state；`NavHost.tsx:328-340` 只渲染栈内条目 → 返回即卸载。用户在手机上误触返回键，已输入的整段文字与已选附件全部消失，且无任何提示。

### 6.11 P1-9 —— 通知去重把「审批」与「完成」塞进同一个 3 秒桶（**确认**）

`notify.ts:113` `MIN_GAP_MS = 3000`、`:224-226` 全局判重；`store.ts:547-551`（完成）与 `:641`（审批）都走同一个 `notifyDone()`，且没有调用方传 `force:true`。于是**一个任务刚完成时到达的审批请求，既不会震动也不会弹系统通知**——恰恰是最需要提醒的那一个。

### 6.12 P1-10 —— `doctor.ps1` 把含 token 的 URL 打印到终端（**确认**）

`doctor.ps1:164` `Line $true 'pairing.json' $j.url`、`:176` 隧道 URL、`:201` `配对地址：$($j.url)`。而 `README.md:355` 把这个脚本定位为「哪里不对会直接告诉你怎么办」的自检工具——**用户会把它整段贴进 issue 或聊天**。

### 6.13 P1-11 —— 打包版桌面助手的隧道功能实际不可用（**确认**）

**证据链。**
- `electron-builder.yml:30-39` 的 `extraResources` **只拷** `tunnel-service.mjs` 与 `start-dsh-web.ps1`，**没有 `start-tunnel.ps1`**。实际产物核实：`release/win-unpacked/resources/` 只有这两个文件 + `app.asar`。
- `tunnel-service.mjs:47` `REPO_ROOT = process.env.DSH_POCKET_ROOT || path.resolve(HERE, '..')`（打包后 = `win-unpacked`）；`:61-62` `TUNNEL_SCRIPT = REPO_ROOT/start-tunnel.ps1`、`DSH_SCRIPT = REPO_ROOT/start-dsh-web.ps1`。
- 两个路径在打包版中**都不存在**（后者在 `resources/` 里，不是 `win-unpacked/`）。
- 因此 `/tunnel/start`、`/tunnel/stop`、`/tunnel/repair` 全部会走到 `execFile` 失败分支（`tunnel-service.mjs:245-261` 把错误吞成 `{ok:false}`）。
- 另：`main.js:455` `const nodeExe = process.env.DSH_NODE || 'node'` —— 便携版**隐含要求系统装有 Node**，而 `dsh-outpost-desktop/README.md` 从未说明。

**影响**：面板上的「启动隧道 / 停止隧道 / 一键修复」在正式包里是死按钮；IP 变更后的修复路径也失效。而隧道恰恰是「在外面也能用」的唯一免装方案（`README.md:190`）。

### 6.14 P1-12 —— 退出后 cloudflared 残留，机器仍对公网暴露（**确认**）

`main.js:930-939` 的 `before-quit` 只 `serviceProc.kill()`；cloudflared 是 `start-tunnel.ps1` 拉起的**孙子进程**，不在同一 job object 内。仓库里没有任何「退出时停隧道」的调用。用户在面板看到 `running` 的隧道，点「退出」，以为已关闭——实际公网域名仍指向这台机器，且 token 仍有效。
`START.bat:71-79` 还会 `taskkill /F /IM "DSH Outpost.exe"`，直接绕过 `before-quit`，必然留下孤儿。

### 6.15 P2 级独立问题（汇总）

| # | 问题 | 依据 |
|---|---|---|
| P2-1 | 三套错误分类器且 403 策略互相矛盾：`transport/index.ts:29-30` 与 `protocol.ts:99` 把 403 当鉴权失败，`approvalGateway.ts:245-257` 明确说 403 永不是凭据问题 | 「你不是在私有网络」被提示成「重新扫码」 |
| P2-2 | `malformed` 被标为 `retryable=true`（`transport/index.ts:55-60`）——格式变更重试一万次也不会好 | 若接入重试会造成空转 |
| P2-3 | `isRetryable`/`isAuthFailure`/`isEndpointMissing`/`safeErrorMessage`/`isPlainHttp`/`isPublicHost` 全部零/单调用者 | 死安全代码比没有更糟：它暗示存在覆盖 |
| P2-4 | `session/updateQueue` 有封装无调用者（`rpc/session.ts:92-107`）却列入 `REQUIRED_ENDPOINTS`（`protocol.ts:39`） | 能力探测会误报支持 |
| P2-5 | `attachment-cache.ts:12-14` 三个模块级 Map/Set **无上限、无淘汰**，存整段 base64 data URI；失败集合永久毒化（`:47-49`） | 图片多的会话内存持续增长 |
| P2-6 | 通知冷启动路由可能丢失：`App.tsx:1294-1307` 在 `GlobalNotices` 内初始化，而 `GlobalNotices` 只在 `authed` 时挂载（`App.tsx:1240`） | 未登录/首次启动点通知无反应；`pendingOpenSession` 是单值会被覆盖（`store.ts:824-835`） |
| P2-7 | `startNoticeScan` 的 `lastScan` 对「两次轮询间完成的任务」不可见（`store.ts:336,470`） | 已完成但不通知 |
| P2-8 | `App.tsx:598-600` 的 catch-all 把迁移/撤销/意图/自动登录全部吞成「未登录」，无日志无提示 | 用户报「升级后要重新扫码」时无任何可诊断信息 |
| P2-9 | 两个 AsyncStorage 键无 schema 版本：`@dsh/archivedSessions`（`store.ts:1072-1079`）、`@dsh/butlerSessionsByWs`（`App.tsx:1110-1116`） | 损坏时静默把已删除会话放出来 |
| P2-10 | `@dsh/archivedSessions` 只增不减（`store.ts:1125,1140`），老 DSH 返回空列表时永远无法自我修复 | 本地集合无界 |
| P2-11 | `approvalGateway.ts:879` 即使传 `overrideMs` 也自增 `retry`，导致慢速通道（15s/60s）把正常退避顶到 30s 上限 | 存储故障后重连变慢 |
| P2-12 | `start-tunnel.ps1:376-377,414` 仍把 DSH 日志写到 `%TEMP%\dsh-web-<port>.log`（含 token），而 `docs/security.md:136-141` 声称已迁到状态目录并收紧 ACL | 文档与代码矛盾 |
| P2-13 | `start-tunnel.ps1:491` 写 `tunnel.json`（含 token）**未收紧 ACL**，而 `start-dsh-web.ps1:359-381` 对 `pairing.json` 做了 | 同一把钥匙两套权限 |
| P2-14 | `start-dsh-web.ps1:234-235` 防火墙规则只有 `-Profile Private`，**无 `-RemoteAddress`** | `docs/security.md:172` 建议「只放行自己的网段」，脚本没实现 |
| P2-15 | `start-tunnel.ps1:386` 继承环境里已存在的 `DSH_PERMISSION_MODE` | 一次 `danger-full-access` 导出会静默关掉后续所有审批 |
| P2-16 | CI 不覆盖 desktop / plugin / PowerShell（`.github/workflows/android.yml:52-81` 只有 `dsh-mobile`） | 桌面包与控制面零自动化验证 |
| P2-17 | `android.yml:344-358` Gate4 指纹校验在未设置变量时只 warning | 与 `DSH-OUTPOST-RELEASE-REPORT.md:101` 描述不符 |
| P2-18 | `tests/version-code-spec.mjs` 未被 `npm test` 或任何 script 引用 | 孤儿测试 |
| P2-19 | 静态扫描型 spec 与行为型 spec 混在同一 `npm test`（22/45 用 `readFileSync`） | 「774 项测试」里有一部分只是字符串匹配 |
| P2-20 | 文档三处与代码矛盾：`docs/protocol-compat.md:42` 与 `docs/known-issues.md:11,41,46` 写 `dsh-token.<token>`，实际是 `dsh-auth.<token>`（`approvalGateway.ts:548-557` 自己记录了这是坑）；`docs/configuration.md:3` 称「没有写死盘符」但 `start-dsh-web.ps1:68,79` 等处确实写死 `E:\` 兜底；`dsh-outpost-desktop/README.md:88` 称 `tunnel-service.mjs` 已正确拷入，但见 P1-11 |
| P2-21 | `main.js:307-309` `sandbox:false`，无 `will-navigate` / `setWindowOpenHandler`；`status:get` 把明文 token 返回渲染层（`:571,590-591`） | CSP 与常量 `innerHTML`（`app.js:110-154`）当前挡住了，但属纵深不足 |
| P2-22 | `NavHost.tsx:75` `SCREEN_WIDTH` 模块级捕获一次，而 `configChanges` 含 `orientation`（`AndroidManifest.xml`） | 横屏时边缘手势阈值仍按竖屏算 |
| P2-23 | `NoticeHost` 绝对定位 `top: insets.top+6, zIndex:9999` 且渲染在 `NavHost` 之外（`App.tsx:1240`） | 3.5s 内遮住返回按钮 |
| P2-24 | 无「回到最新」控件；`nearBottom` 10Hz 采样 + 两套滚动机制并存（`ChatScreen.tsx:189-194` 与 `:535-537`） | 上滑后新内容静默堆积 |
| P2-25 | `SlideSegmented` 无 `accessibilityRole/State/Label`（`SlideSegmented.tsx:124-163`） | TalkBack 下切主题/切模式不可用 |

**已排除的「疑似问题」（核对后确认不是缺陷，列出以免重复报告）：**
- `runScript` 命令注入：`tunnel-service.mjs:245-250` 用 `execFile` + 参数数组，且实参全是字面量（`:298,314,329,334`）。**安全。**
- 桌面渲染层 XSS：`app.js` 全部 6 处 `innerHTML` 都是字面常量（`:110,118,121,136,143,147`），设备名走 `textContent`（`:153-154`）。**安全。**
- 网关文件下载路径穿越：第三方插件用 `isInsideWorkspace` + `realpath` 前后各校验一次。**安全。**
- 凭据明文落盘：枚举全部 `@dsh/` 键后确认无非凭据项；历史明文已在迁移中验证删除。**干净。**
- 调试日志泄漏 token：`transport/index.ts:294` 只打印 `/api/<endpoint>`（无 query），且 `__DEV__` 门控。**干净。**

### 6.16 文档声称但源码无法证明（**【待验证】**，不得当作缺陷）

1. `tests/README.md` 的「774 通过 / 0 失败」——本次为只读审计，未执行测试。静态计数 41 个 spec 文件 ✓、746 处 `check(` 调用；差额可由循环内生成断言解释。
2. DSH 宿主是否按 `requestId` 去重 `session/prompt`——决定 P2-3（幂等键）修好后能否安全重试。
3. DSH 是否在流式过程中持久化 `assistant/message`——决定 App 被杀后部分输出能否找回。
4. iOS 侧 RN WebSocket 的 cookie/header 行为（`node_modules` 中无 `.mm` 源码）。
5. `docs/mobile-gateway.md:87-89` 的 `approval-resolved` 帧形状（未实际触发审批链路）。
6. Cindy 的 `deviceIdentity.ts` P-256 挑战是否真的被任何一端执行（其头注释自述「需 native 侧实现」，包内无调用者）。
7. Cindy 的 `allowlistHash` 是否有消费者（包内未找到比对点）。

---

## 7. 不建议引入的 Cindy 功能

| # | 能力 | 为什么对我们无价值 |
|---|---|---|
| 1 | **多 harness 抽象**：`REMOTE_AGENT_KINDS = ['claude-code','codex','pi']`、`maker-cc-manager` / `maker-pi-manager` 两个 socket 守护进程、`maker-core/src/agents/**`（仅 `claude-code/index.ts` 就 439KB）、各 `translator.ts` | Outpost 的设计前提是**只服务 DSH**。引入抽象层会立刻产生一层「为了通用而通用」的适配税，且没有任何第二种 harness 的需求。**这条明确排除。** |
| 2 | **230 条 channel 白名单**（`allowlist.ts:184-741`，59KB） | 我们的远程面只有 15 个 RPC + 审批通道。**借「默认拒绝 + 漂移测试」的思想即可**（5 行表 + 1 条子集断言），不要借规模。 |
| 3 | **WebRTC 直连 + ICE 协商**（`directNegotiation.ts` 201 行、`directRuntimeBridge.ts` 151 行、`client.ts` 内约 190 行） | 它只在局域网生效（`iceServers: []`，`directRtcRuntime.ts:10`），本质是缓解 relay 带宽。我们**没有 relay**，直连 TCP 本来就在局域网上。 |
| 4 | **自适应重传数学**（RFC6298 + `deliveryBytesPerMs` + 120s 上限，`transport.ts:108-172`） | 每个常数都是从弱网实测反推的（注释自述 2026-10-12 机上实测 40% 出站字节是重发）。**在没有对应弱网测量的前提下移植，行为会比固定间隔更差。** |
| 5 | **拥塞发送预算**（`congestionSendBudget.ts`） | 它只在收到 1013 之后才武装（`client.ts:3387`），本质上无法阻止第一次拥塞；而且 `canTake` 会改窗口状态导致 check-then-take 非原子（`:28-52`）。审计还发现其单测把这个副作用当作期望行为固化了下来（`congestionSendBudget.test.ts:5-14`）。**不建议**。 |
| 6 | **`sharedTask` + `providerShare` 双作用域混淆代理防御** | 解决的是「陌生人跨账号共享任务」——我们没有共享账户体系。唯一值得记的是「作用域键填充到比物理 id 更长以避免碰撞」这个技巧（`sharedTaskPeer.ts:7-9`）。 |
| 7 | **6,623 行单 store + 8 轴 generation fencing**（`remoteSessionStore.ts`） | 那是为多设备多 harness 多账号同步付的复杂度。**借技术（chunk 合并、结构 token、身份保留），不借架构。** |
| 8 | **`@legendapp/list` + 约 1,500 行滚动补丁**（`MessageRenderer.tsx:969-1030`、`messageScroll.ts` 581 行） | 其中很大一部分在对抗该虚拟化库自身与 Android Fabric recycle 的边界情况（`:2889-2893` 注释称生产环境关闭 recycle 以避免 detach/attach 竞态）。**换库等于接盘那场仗**；用 FlatList 时那些具体 bug 不存在。 |
| 9 | **原生聊天视口模块**（`cindy-chat-viewport` Kotlin/Swift） | UI 线程键盘跟随确实更好，但每平台数周投入，属打磨而非瓶颈。 |
| 10 | **`taskMigration.ts` 7 动作迁移协议** | 产品功能而非机制。唯一可推广的是「宿主放弃必须严格晚于控制端等待」这条不变量（`invokePolicy.ts:162-172`）。 |
| 11 | **四层日志上传管道**（`log-upload/**`，约 1,000 行） | 我们没有上传需求。**借「先白名单再脱敏再字段白名单」的形状即可**，不必实现。 |
| 12 | **8 路 CI 分片 + 聚合 job**、`check-test-hygiene.mjs`（75KB，git 锚定基线防篡改）、DCO 钩子、`pr-design-basis` 机器门禁、5 locale 术语表（129KB） | 这些是**多人协作治理设施**。单人项目引入等于把预算全花在流程上。 |
| 13 | **`historyDiskStore` 的 `HISTORY_DISK_BUDGET_BYTES = Infinity`** | 对我们是明确的反面教材：无上限的磁盘缓存不能上手机。 |
| 14 | **零 ErrorBoundary + 无崩溃上报的策略** | Cindy 能这么做是因为它有 700 个组件测试 + 卡片可空设计。**我们恰恰缺这两样**，所以一个顶层 boundary 比「保证渲染路径永不抛」更划算。 |
| 15 | **审批无超时 + 无本地审计** | 对它们的桌面陪伴模型可接受；对手机远程控制是产品缺口，**不应继承**。 |

---

## 8. 优化优先级与实施成本

工作量口径：**S** ≤ 0.5 天，**M** 1–2 天，**L** 3–5 天（单人、无外部依赖）。

### P0 —— 必须修复（2 项）

| ID | 问题 | 证据锚点 | 成本 | 风险 |
|---|---|---|---|---|
| **P0-1** | 会话流静默死亡后永久卡死，无错误无恢复 | `transport/index.ts:360-374`（无 close 监听）→ `:434-441`（iterator 永久阻塞）→ `store.ts:1232-1253`（pump 挂死） | **M**（+70 行，含注入测试） | 低。fold 已按 seq 去重，重放安全 |
| **P0-2** | 局域网无认证铸造配对码 → 审批/控制面可被同网段接管 | `setup-gateway.ps1:109-115` + `docs/mobile-gateway.md:41` + 第三方 `lib/index.mjs:2696-2703, 2827-2858, 2083-2092` | **M**（桌面铸造 + QR 扩展 + 配置改回 loopback） | 中。需改配对流程，必须保留回退路径 |

### P1 —— 高价值改进（12 项）

| ID | 问题 | 证据锚点 | 成本 |
|---|---|---|---|
| P1-1 | 更新包只校验大小 + 公共 debug 签名 | `updater.ts:77-86,144-147`；`.gitignore:44`；CI 已发布 `SHA256SUMS.txt` 但无消费者 | **S**（+15 行） |
| P1-2 | tunnel-service 把 token 交给任意私网 origin | `tunnel-service.mjs:70-71,77-85,225-237` | **S**（+10 行） |
| P1-3 | `chat.running` 不与服务端对账 | `store.ts:357-368`（拿到 `row.running` 不写回）、`fold/index.ts:556` | **S**（+5 行） |
| P1-4 | 明文 HTTP 校验只在 2 处生效 | `transport/index.ts:174`、`PairScreen.tsx:104` 为仅有的调用点 | **S/M**（+50 行） |
| P1-5 | 审批仅聊天页可操作 + 失败静默 | `ChatScreen.tsx:470-482`、`ApprovalBanner.tsx:51-60`、`App.tsx:1312-1314` | **M** |
| P1-6 | 轮询无 AppState 门控 | `ChatScreen.tsx:171-179`、`store.ts:398-405`、`notify.ts:240-246`（`isForeground` 零调用） | **S**（+15 行） |
| P1-7 | `wakeButler` 可能重复/错误注入 | `store.ts:336,347-355,786-801` | **S**（改为按任务 id 集合去重） |
| P1-8 | 返回即丢草稿 | `ChatScreen.tsx:95`、`NavHost.tsx:328-340` | **S/M** |
| P1-9 | 通知 3s 单桶吞掉审批提醒 | `notify.ts:113,224-226`、`store.ts:547,641` | **S**（+10 行） |
| P1-10 | `doctor.ps1` 打印 token URL | `doctor.ps1:164,176,201` | **S**（+5 行，或直接调 `redactUrl` 等价逻辑） |
| P1-11 | 打包版隧道按钮全废 + 隐含依赖系统 Node | `electron-builder.yml:30-39`（未打包 `start-tunnel.ps1`）、`tunnel-service.mjs:47,61-62`、`main.js:455` | **S/M** |
| P1-12 | 退出后 cloudflared 残留 → 机器仍暴露 | `main.js:930-939`、`START.bat:71-79` | **S/M** |

### P2 —— 可选增强（约 25 项，见 6.15）

按收益再筛，值得排进日程的 6 项：

| ID | 问题 | 成本 |
|---|---|---|
| P2-A | 流式渲染：批内重建 + `React.memo` + item 身份复用 + 会话级订阅通道（对应 5.2/5.3） | **M**（收益最高的一条 P2，实际应按 P1 排） |
| P2-B | 三套错误分类器合一，采用网关的「403 永不是凭据问题」规则；`malformed` 改 `retryable=false` | **S** |
| P2-C | 清理死代码与孤儿测试；`updateQueue` 移入 `OPTIONAL_ENDPOINTS` | **S** |
| P2-D | `main.js` 补齐 Electron 安全基线（`sandbox:true`、`will-navigate`、`setWindowOpenHandler`）+ 一条表驱动测试 | **S** |
| P2-E | `tunnel.json` 补 ACL、`%TEMP%` 日志迁回状态目录、防火墙规则加 `-RemoteAddress` | **S** |
| P2-F | 文档三处硬矛盾修正（`dsh-auth` vs `dsh-token`、盘符、tunnel-service 拷入声明） | **S** |

### P3 —— 不建议引入

第 7 章全部 15 项。核心判据：**任何增加常驻复杂度、却不减少用户可感知故障的改动，都不做。**

### 统计

- **P0：2 项**
- **P1：12 项**
- **P2：25 项**（其中 6 项建议优先）
- **P3：15 项**（明确排除）
- **待验证：7 项**

---

## 9. 最小改动实施路线

原则：**每一阶段都能独立发布、独立回滚，且不改变现有分层。**

### 阶段一：连接与状态的可信性（约 3–4 天，目标 P0-1 + P1-3 + P1-6）

**改动**
1. `core/transport/index.ts`：`ensureSocket()` 增加 `close` 监听 → 以 `RpcError(kind:'network')` 失败所有活跃 stream；`openStream()` 首帧加 15s 超时。
2. `core/store.ts`：`pump()` 的 catch 分支写 `chat.error` 并置 `running=false`；`refreshChatMeta()` 用 `row.running` 覆盖本地 `running`；`startNoticeScan`/2s 轮询接 `AppState`。
3. 新增 `core/connectionHealth.ts`（纯函数）：把「流健康 / HTTP 可达 / 审批通道」三态收敛成可测策略。
4. 新增 `tests/support/fault-injection`：让 `fake-dsh.mjs` 支持「不发 `turn/end` 就断连」。

**验收条件**
- 注入「半途断连」后 ≤1s 内聊天页出现错误条 + 「重试」按钮，不再是无限转圈。
- 注入「丢失 `turn/end`」后，`refreshChatMeta` 在 ≤2s 内把 `running` 纠正为服务端值。
- App 切后台 30s 后 `session/list` 调用次数为 0（可用现有 fake-dsh 计数断言）。

**回归重点**：`test:fold`、`test:contract`、`test:recovery`、`integration-transport`、`integration-product`；以及手动验证一次真实断网恢复。

### 阶段二：长会话渲染与审批闭环（约 3–5 天，目标 P1-5 + P2-A + P1-8）

**改动**
1. `store.ts`：`pump()` 按 `EMIT_THROTTLE_MS` 窗口批量重建（不再每事件 rebuild）。
2. `Store.subscribe(fn, key?)`：增加会话级/通知级通道；`emit()` 按脏标记分派。
3. `fold/index.ts`：`toChatItems()` 对未变化的 step 复用上一版对象；`ChatScreen` 的 `renderItem` 抽成 `React.memo` 组件。
4. `ApprovalBanner`：`await onAnswer()` + 失败文案 + 卸载清理 timer；审批接「全局常驻面」（复用 `NoticeHost` 位置但在有 pending 时不自动消失）。
5. 草稿按 `sessionId` 存 AsyncStorage（debounce 写，成功发送后清除）。

**验收条件**
- 200 条消息的会话，流式输出期间 `renderItem` 调用次数与被更新行数同阶（用 `React.Profiler` 或计数断言）。
- 「加载更早」后阅读位置不跳（人工）。
- 网关离线时点审批 → 明确提示「审批通道已断开」，不再是按钮假死。
- 返回再进会话，草稿与附件仍在。

**回归重点**：`test:fold`、`test:approval`、`test:gateway*`、`test:gesture`；长会话人工走查。

### 阶段三：安全与发布收口（约 4–6 天，目标 P0-2 + P1-1 + P1-2 + P1-10 + P1-11 + P1-12）

**改动**
1. 桌面助手用 loopback `POST /mgw/pair` 铸造码 → 编进配对二维码 → `adminLoopbackOnly` 改回 `true`；`setup-gateway.ps1` / `docs/mobile-gateway.md` 同步更新；保留「旧流程仍可用」的开关一版。
2. `updater.ts` 下载后校验 release body 中的 SHA-256。
3. `tunnel-service.mjs` 收紧 CORS 到 DSH 自身 origin，`/tunnel/status` 不回传 token。
4. `doctor.ps1` 输出脱敏。
5. `electron-builder.yml` 补 `start-tunnel.ps1` 到 `extraResources`；`before-quit` 调 `-Stop`；面板退出前提示隧道状态；README 说明 Node 依赖。
6. CI 增加 desktop/plugin 的测试 job（两者已有 `npm test`）。

**验收条件**
- 从「干净安装」走一遍：配对 → 局域网 → 隧道 → 断网 → 恢复，全程无需终端。
- 打包版点击「启动隧道」成功（当前失败）。
- 退出程序后 `cloudflared` 进程不存在（`Get-Process cloudflared` 为空）。
- `POST /mgw/pair` 从局域网返回 403；配对仍能通过扫码完成。
- CI 在 desktop/plugin 测试失败时阻止 tag 发布。

**回归重点**：`test:creds`、`test:migration*`、`test:revoke*`、`test:serveridentity`、`test:secreview`、`test:netsec`、`test:pairing`；外加真实手机全流程。

### 不建议排进路线的

多 harness、通用编排、provider/计费、插件市场、WebRTC、i18n 多语言、CI 分片、DCO、术语表门禁——见第 7 章。

---

## 10. 最终技术判断

**DSH Outpost 当前架构是否已经足够合理？**
**是。** 分层清晰（transport → rpc → store → screens，`core` 完全不依赖 RN 因而可在 Node 里测），职责边界守住（不重实现 agent 内核），单文件最大 1,405 行（`store.ts`）——对比 Cindy 的 25,114 行 `register.ts` 与 6,623 行 store，我们的复杂度是**克制的**。不需要重构。

**是否存在值得立即处理的结构性问题？**
**有一个：连接不是一等公民。** 传输层没有任何存活判定、超时或恢复，导致「断线」在 UI 上等同于「模型一直在想」。这不是靠加功能能掩盖的，必须补一层。其余问题都是局部的。

**Cindy 最值得我们学习的三个设计：**
1. **累计 ACK + 断点续传 + 在途请求选择性存活 + `inFlight` 错误位**（`transport.ts:174-448`、`client.ts:1921-1929`、`protocol.ts:99-119`）——「重连而不对用户撒谎」的完整答案。我们只需取它的最小子集即可解决 P0-1。
2. **流式渲染四层：chunk 累积 + 可见性自适应 flush + 跳过重排序 + 行身份保留**，并用「变更行数 == 1」的测试固化（`remoteSessionStore.ts:678-686,2684-2694`、`messageRenderReconcile.ts:31-76`、`messagePerformance.test.ts:170`）。要点不在 memo，而在**保证 props 引用稳定**。
3. **可测试的恢复判据**：失败半径按证据分级（`client.ts:5199-5226`）、状态转移写成冻结表且非法即抛（`attemptLifecycle.ts:29-45`）、连接可见性写成纯函数（`connectionBannerVisibility.ts:14-46`）。共同点是**把「什么时候该做什么」从代码里抽成可断言的数据**。

**哪三个设计不应该引入：**
1. **多 harness 抽象**（`REMOTE_AGENT_KINDS`、`maker-cc-manager` / `maker-pi-manager`、`maker-core/src/agents/**`）——与产品定位直接冲突，且是 Cindy 复杂度最大的来源。
2. **专用虚拟化库 + 数千行滚动补丁**（`@legendapp/list` + `MessageRenderer` 的约 1,500 行规避代码）——那些补丁在对抗库自身的边界情况；我们没有那个问题，接盘等于自找。
3. **以 relay 为前提的可靠传输全栈**（自适应重传数学、拥塞预算、WebRTC 直连、230 条 allowlist）——每个常数都绑定他们的实测环境与业务体量，脱离语境移植会**降低**可靠性。

**哪些优化真正能提升产品竞争力？**
1. **断线可见 + 可恢复**（P0-1 / 阶段一）——直接消除最伤信任的体验：发了消息没反应。
2. **审批在任何页面都能处理，且失败可见**（P1-5）——这是本产品相对「用电脑」的唯一不可替代价值。
3. **长会话不卡**（P2-A）——用户实际使用时长的决定性因素。
4. **「在外面也能用」真的能用**（P1-11/P1-12：打包版隧道修复 + 退出清理）——功能存在但坏掉，比没有更伤。

**哪些只是增加代码规模和维护负担？**
多 harness 抽象、通用编排、provider 计费、插件市场、IM 多渠道、WebRTC 直连、i18n 多语言治理、CI 分片、DCO/术语表门禁、日志上传管道。这些在 Cindy 那里各有其理由（团队规模、商业化、多产品线），在我们这里是纯成本。

**如果只能投入有限的开发时间，最应该改进什么？**
**按这个顺序做三件事**：
1. 阶段一的全部（约 3–4 天）——把「连接」变成可观测、可恢复、可测试的一等公民。
2. P1-1 + P1-10 + P1-2（约 1 天）——三个纯加法的小修，但各自堵住一条真实的凭据泄漏/伪造路径。
3. P1-11 + P1-12（约 1 天）——让「在外面也能用」这条宣称成立。

合计约一周，换来的全部是**现有功能的可靠性**，没有一行是新功能。

**如果当前没有明显的高价值改进，是否应该停止加功能，转向发布、测试与实际用户反馈？**
**应该——而且本次审计的结论正是如此。** 除 P0-1 的结构性缺失外，其余高价值项都是**修复既有功能**而非新增功能。同时有两个信号支持「转向验证」：

- `RELEASE-ACCEPTANCE-CHECKLIST.md` 里 57 项真机验收**全部标记 `NOT RUN`**（清单自身在 `:23-25` 如实说明）；
- `README.md:437` 自述 v0.16.6 是「自动化测试已通过，但尚待真实手机验收」的预发布版。

也就是说：**自动化能证明的部分已经证明得不错，而唯一能证明剩下的部分（真实网络、真实手机、真实长会话）恰恰是自动化覆盖不到的**。UI 层零渲染/交互测试（第 3.5 节）意味着本报告里的 D-1/D-2/D-5/D-6 这类问题，静态检查永远抓不到。

**建议的止损线**：完成阶段一 + 三个安全小修（约一周）后，**冻结功能开发，走完 57 项真机验收，收真实用户反馈**。在此之前继续加功能，边际收益低于把现有功能做可靠。

**最后一条判断纪律**：本报告刻意区分了「Cindy 做了但我们没做」（不等于我们该做）与「我们做错了」（才该改）。第 7 章排除的 15 项，以及第 4 章肯定的 12 项，是这个区分的结果。**目标不是让 DSH Outpost 更像 Cindy，而是用 Cindy 当参照，确认我们用更小的代码量把「DSH 遥控器」这一件事做对。**

---

### 附录 A：许可证与借鉴边界

- **Cindy 许可**：`LICENSE` 为 Apache-2.0（`LICENSE:2-4`），`package.json:6` 声明一致；`NOTICE` 载明 `Cindy / Copyright 2026 XD Inc.`；第三方声明与 SPDX SBOM 在 `docs/legal/`，由 `scripts/generate-third-party-notices.mjs` 生成。
- **Outpost 许可**：MIT（`LICENSE`）。
- **本报告的边界**：
  - **默认姿态：只借鉴思想，不复制代码。** 本报告所有引用均为「机制描述 + 行号」，不含可直接粘贴的实现。
  - 若未来确实要复制 Cindy 的少量自包含文件，必须履行 Apache-2.0 第 4 条：随分发提供许可证副本、在修改过的文件加显著变更声明、保留归属声明、**保留 `NOTICE`**（"This product includes software developed by XD Inc."）、不得使用其商标暗示背书。Apache-2.0 与 MIT 兼容，但被复制文件**不能**只标 MIT。
  - 三个需要注意的「非纯 Apache-2.0 来源」子树：`apps/desktop/resources/system-skills/cindy-skill-creator/**`（改编自 OpenAI Codex）、`apps/desktop/src/renderer/vendor/drawio`、`packages/browser-control-runtime/src/_generated/vendor/fs-safe`。从这些路径复制会带入第三份许可。
  - 实际约束：本报告推荐的机制都只有几十到几百行，**重写比适配更快、更安全**，也能把 NOTICE 控制在一行。

### 附录 B：本次审计覆盖范围

**已完整阅读**：`dsh-mobile/src/core/**`（全部 33 个文件）、`src/screens/**`（8 个）、`src/components/**`（34 个）、`src/nav/`、`src/design/`、`App.tsx`、`dsh-outpost-desktop/src/**`、`dsh-plugin-connect/*`、根目录全部 `.ps1`、`.github/workflows/android.yml`、`docs/**`（13 个）、`dsh-mobile/tests/**`（51 spec + support）。
**对 Cindy 采用定点阅读**：`packages/device-link/src/**`（60 文件，`client.ts` 按 grep 定位后读关键区）、`device-link-protocol/**`、`apps/mobile/src/session/remoteSessionStore.ts` 关键区、`messageRender*` / `interaction*` / `transport*`、`apps/desktop` 安全与生命周期相关文件、`AGENTS.md`、`docs/dev-rules/**`、`package.json`。
**未执行**：任何构建、测试、安装、部署脚本；任何会修改文件的命令。**唯一的外部观察**是只读 GET 与故意构造非法体的 POST，以及 `git ls-files` / `keytool` / `apksigner verify` 等只读校验。
