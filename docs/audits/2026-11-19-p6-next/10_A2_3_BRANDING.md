# 10 — Rurea A2.3：默认切换 + 品牌化

日期：2026-11-21 · 分支：opt/p1-phone-polish · 触发：用户「A2.3 默认切换 + Rurea 品牌化」（批准）。

## 默认切换
- `index.js` 默认入口 `App`（dsh 外壳）→ **`RureaApp`**（agent-first）。生产默认即 Rurea。
- 遗留 dsh 客户端经 RureaApp 的单一 `DshClient` 入口可达（AgentSettings showDshEntry）。
- `DSH_RUREA_ENTRY` flag 保留（现冗余但无害）；隔离验收机制不变。

## 品牌化（用户提供的图标：深藏蓝底 + 金色心形带叶符号）
品牌色解析自用户图标：**navy #16233B** (22,35,59) + **gold #E9C878** (233,200,120)。
- `strings.xml` app_name：`DSH Outpost` → **`Rurea`**（launcher 显示名）。
- launcher 图标：从用户图标提取金符号，生成各密度 `ic_launcher.png` / `ic_launcher_round.png`
  （mdpi48→xxxhdpi192，navy 底 + 金符号居中）；adaptive foreground（drawable-nodpi 432，金符号透明底安全区）。
- `ic_launcher_background`：`#FFFFFF` → **`#16233B`**（adaptive 背景 navy）。
- `splash_background`：旧品牌天蓝 `#1C4492` → **`#16233B`**；`splash.png` 旧 DSH「鲸尾图」(680×1024)
  → **Rurea 金符号透明底** (432×432)，映在 navy 闪屏上。SplashTheme 状态栏/导航栏随 splash_background。
- 视觉验证：生成的 launcher 图标 navy 底 + 金色心形带叶，清晰完整无白边（vision 确认）。

## 包名决策（敏感，本轮不改）
**保持 `com.dshpocket`**（applicationId 不变）。理由：
- Android Keystore 密钥按**包名 + 签名**作用域；改 applicationId = 新应用身份 →
  旧凭据（模型 Key/cookie/设备身份）**不可访问**，且无法覆盖升级旧安装（须全新安装）。
- 品牌身份已由**显示名 Rurea + 图标**（用户可见层）达成；内部包名保留以维持凭据/升级连续性。
  这是标准做法（内部包名 ≠ 品牌名）。
- 若日后要干净的 `com.rurea` 身份，属**独立迁移决策**（全新安装 + 重新配置/凭据迁移），
  需 stop-the-world 规程 + 另批。本轮不做。

## 验证
- typecheck 绿。
- 默认入口 Rurea APK（隔离 com.dshoutpost.p1.rurea，debug 签名，**不传 DSH_RUREA_ENTRY**，
  走默认 index.js=Rurea）装机：launcher 显示名 Rurea、navy+金图标、boot 直达 agent 主界面（无 dsh 配对）。
- 证据 evidence/P6-rurea-a23-*。emulator 验后卸载关机。

## 治理
- 品牌化（名/图标/色）属外观，非敏感。默认切换改生产行为（A2.3 已批）。
- 包名/凭据迁移敏感，本轮明确不做，留独立决策。
- 不削弱任何安全断言；agent 审批/敏感守卫原样。
- 全量 test:chain 由 CI 复跑确认默认切换不破坏 dsh 规格（入口级改动，组件规格直 import 不受影响）。
