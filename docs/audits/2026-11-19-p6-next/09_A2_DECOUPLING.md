# 09 — Rurea A2：从 dsh 解耦（设计与基础实施）

日期：2026-11-21 · 分支：opt/p1-phone-polish · 触发：用户「A2 从 dsh 解耦」（敏感架构改动批准）。

## 耦合现状（代码实证）
- `src/App.tsx`（1686 行）是 **dsh 客户端外壳**：DshConnection（网关 transport）/ Store
  （会话/工作区/聊天）/ 凭据迁移 / cookie jar / 设备撤销 / 审批网关 / 配对 / 管家模式。
- `dsh-plugin-mobile-gateway@0.10.3`（devDep）被 4 个 **dsh 客户端**文件用：
  core/approvalGateway.ts、core/store.ts、core/serverIdentity.ts、components/FileCard.tsx。
- **关键发现：所有 Agent* 屏幕都不 useApp()**（useApp 用户全是 dsh 客户端屏幕/组件）。
  agent 屏幕仅依赖 useTheme / useNav / agentClient（OutpostAgent 桥）+ 无 dsh 依赖的共享 UI
  （Header / MotionPressable / ChatComposer / AgentScreenOffNotice / SectionLabel / SlideSegmented）。
- `NavHost` 完全独立（render prop + useTheme + useMotionPreference + adaptiveNavigation，无 store）。
- **native + 桥层早已解耦**：agent-core 纯 JVM；AgentRuntime 直连云模型（CloudModelClient），
  不经 dsh 网关。B1+B2+B3 的验收入口 entry.tsx 已实证 agent 能**完全脱离 dsh 外壳独立跑**。

结论：耦合只在**生产入口仍先 boot dsh 外壳**（index.js→App.tsx），agent 屏幕埋在里面。
agent 本体（native/桥/屏幕/导航/主题）已可独立。

## 解耦方案（agent-first，dsh 留一个入口）
**A2.1 Rurea 外壳（additive，低风险，本轮基础）**
- 新增 `src/rurea/RureaApp.tsx`：轻量外壳 = GestureHandlerRootView + SafeAreaProvider +
  ThemeProvider + MotionProvider + BottomSheetModalProvider + NavHost，
  **home = AgentButlerScreen**（手机 agent 主 surface），render 注册
  AgentButler/AgentSettings/AgentMemory/BackgroundDisplay/AgentDemo + **DshClient**。
- `DshClient` 屏幕渲染遗留 `App`（dsh 客户端整体，自带 provider）——**dsh 留一个入口**。
- dsh 入口按钮：AgentSettingsScreen 加可选 `showDshEntry` prop（默认 false）；
  Rurea 传 true 显示「dsh 客户端（旧版）」行→nav.push('DshClient')；dsh 上下文不显示（不污染）。
- 新增 `index.rurea.js`：registerComponent('DshPocket', RureaApp)。
- build.gradle 加 `DSH_RUREA_ENTRY` 属性换 entryFile（生产 Rurea flavor，**不要求隔离测试 id**，
  与 DSH_TEST_ENTRY_FILE 分离）。默认 dsh 构建不变（可逆）。

**A2.2 验证（下一步）**
- typecheck 绿；`-PDSH_RUREA_ENTRY=index.rurea.js` 构建 Rurea APK。
- 装机验证：boot 直达 agent 主 surface（无配对/无 dsh 网关连接）；agent Run 可跑（复用 B 轨 harness 结论）；
  dsh 入口可进遗留客户端。
- 验收：agent 模块独立编译；无 dsh 网关依赖即可跑 Run；耦合点 grep 清零或显式隔离。

**A2.3 默认切换 + 清理（待 A2.2 验通后，敏感，另批）**
- 验通后把生产默认入口切到 Rurea（index.js→RureaApp 或构建默认 Rurea）。
- 品牌/包名 Rurea 化（com.dshpocket→新包名需谨慎，涉 Keystore/凭据迁移，单独评估）。
- test:chain 拆分 agent 专属链 vs dsh 链（A3）。

## 治理 / 风险
- A2.1 additive（新增文件 + 可选 prop + 可选构建 flag），不改 dsh 默认行为，可逆。
- A2.3 默认切换 + 包名/凭据迁移属敏感，需另批 + stop-the-world 升级规程。
- 不削弱任何安全断言；agent 审批/敏感守卫原样保留。

## 本轮实施
A2.1 基础：RureaApp.tsx + index.rurea.js + DSH_RUREA_ENTRY flag + AgentSettingsScreen showDshEntry。
typecheck 验证。A2.2 装机验证下一步。
