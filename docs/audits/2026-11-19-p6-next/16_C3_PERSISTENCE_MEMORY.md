# 16 — Rurea C3：记忆与持久化深度（Stop-the-World 迁移 + RunStore 历史/跨重启核对 + 多会话 + 显式记忆）

日期：2026-11-22 · 分支：`opt/p1-phone-polish` · 触发：用户确认「继续 C3 记忆/持久化深度」并批准完整方案（A1 全量闭环 + A2 严格显式记忆边界）。
性质：**敏感**（涉及 RunStore 状态文件、用户记忆、多会话对话存储结构升级与 Stop-the-World 迁移规程；严格遵循隐私边界、损坏隔离保护与降级 fail-closed）。

---

## 一、现状审计与核心缺口

1. **缺少统一 Schema 版本控制与 Stop-the-World 迁移机制**：`agent-runs/*.properties`、`agent-memory.json`、`agent-thread.json` 原先各自独立无版本清单，存在跨版本降级静默覆写风险，也缺少升级前 `fsync` 备份机制。
2. **二次冷重启丢失未核对崩溃警告**：`AgentRuntime` 初始化仅调用 `RunRecovery.recover(runs)`。首次冷启把 `RUNNING` 状态写有未知副作用工具的 Run 转为 `INTERRUPTED + requiresReconciliation = true`；若用户在点击「知道了」前 app 再次冷重启，第二次启动因已无活跃 Run 而导致 `recover()` 返回 `null`，未核对警示直接消失；且 `dismissRecovery()` 未把确认结果写回磁盘，导致崩溃文件永久滞留历史上限豁免名单。
3. **损坏文件静默丢失与缺口 `fd.sync()`**：`AgentMemoryStore` 与 `AgentThreadStore` 原先使用 `temporary.writeText(...)` 未调 `fd.sync()`，且遇到 JSON 解析异常时直接返回空对象，导致下一次写入永久覆盖用户数据。
4. **记忆与对话能力受限**：
   - `AgentMemoryStore.save()` 在编辑模式（`editId != null`）未拦截重名 key，可能造成重复记忆；缺少分类（偏好 / 项目 / 事实）、置顶优先级、启用开关与 2400 字注入预算透明展示。
   - `AgentThreadStore` 仅支持单一全局对话，清空即抹去全部上下文；`FileRunStore` 缺少工具事件时间线与独立 `createdAt`，且 UI 缺少历史页面查看 `agentClient.history()`。

---

## 二、核心落地内容与 Schema 演进（v1 → v2）

### 1. Stop-the-World 迁移器与存储防线（`StorageMigrator.kt`）
- **调用顺序（Stop-the-World）**：`AgentRuntime` 在构建 `Workspace`、`FileRunStore`、`AgentMemoryStore`、`AgentThreadStore` 与执行 `RunRecovery` **之前**同步执行 `StorageMigrator.migrateIfNeeded(app.filesDir.toPath())`。
- **降级 Fail-Closed**：当磁盘 `storage-manifest.json` 的 `schemaVersion > 2` 时，返回 `MigrationStatus.DOWNGRADE_BLOCKED` 并且**零写盘**；`AgentRuntime` / `AgentModule` 拒绝 `startDemo`、`startCloud`、`clearThread`、所有会话写操作与记忆写操作（报错 `STORAGE_DOWNGRADE_BLOCKED`），前端给出明确的只读保护告警与提示。
- **迁移前备份**：发现 v1 遗留数据时，先把 `agent-memory.json`、`agent-thread.json` 与 `agent-runs/*.properties` 通过 `atomicWriteBytes`（Temp 文件 + `output.fd.sync()` + 原子 `ATOMIC_MOVE`）快照至 `agent-backups/v<from>-<ts>/`（滚动保留最新 3 份）。
- **无损幂等升级与损坏隔离**：
  - `agent-memory.json`（v1 → v2）：补全 `kind`（默认 `"fact"`）、`pinned=false`、`enabled=true`、`revision=1`，并对历史重名 key 按最新 `updatedAt` 去重与告警；损坏 JSON 隔离为 `agent-memory.json.corrupt.<ts>`。
  - `agent-thread.json`（v1 平铺 → v2 多会话）：将旧 `{ messages }` 无损装入 `sessions: [{ id: "default", title: "默认对话", ... }]`；若已是 v2 结构（例如上次迁移写入 manifest 前崩溃）则幂等规范化，绝不重复嵌套。
  - `agent-runs/*.properties`：为合法终态/有效 `phase` 文件追加 `schemaVersion=2` 与 `createdAt`；损坏或非法 `phase` 文件保持原样，继续交由 `FileRunStore` 隔离报错。
  - 最后才提交 `storage-manifest.json`（`schemaVersion = 2`），确保任意中途中断后重启均可安全重入。

### 2. RunStore 持久化深度与跨重启核对（`Contracts.kt` / `RunStore.kt` / `RunRecovery.kt`）
- `RunSnapshot` 与 `FileRunStore` 扩展：新增 `createdAt`、`events`（`eventsJson` 上限 20 条，落盘前经 `sanitizeRunEventDetail` 对 `sk-...`、`Bearer ...`、`api_key=...` 等脱敏）、`reconciledAt`。完整兼容读取旧版 v1 `.properties`。
- `RunRecovery.pendingReconciliation(store)`：保留 `RunRecovery.recover(store)` 既有语义不动，另提供未确认 `requiresReconciliation && reconciledAt == null` 查询，确保崩溃警告可**跨越第二次乃至第 N 次冷重启**持续出现，直到用户点按「知道了」或「确认已核对」。
- `FileRunStore.acknowledgeReconciliation(runId, at)`：对正常崩溃 Run 清除 `requiresReconciliation` 并落盘 `reconciledAt`（同时保留原始 `updatedAt` 排序并在超出 60 条后恢复可清理）；对无法解析的损坏 `.properties` 文件则隔离至 `*.corrupt.<ts>` 保留取证证据并解除阻塞。

### 3. 原生记忆 v2、多会话对话与 Runtime/Bridge 接线
- `AgentMemoryStore.kt`：统一走 `fd.sync()` 原子写与损坏隔离；修复编辑模式下允许重名 key 的历史缺陷；支持 `preference` / `project` / `fact`、`pinned`、`enabled` 与 `revision`；提供 `promptBudget(2400)` 计算与 `promptBlock()` 完全一致的 `usedChars` / `includedIds` / `truncatedIds` / `disabledIds`。
- `AgentThreadStore.kt`：升级多会话存储（最多 20 个会话，每会话保留 40 条 / 24,000 字），支持新建（首次用户消息自动命名）、切换、重命名、删除、仅清空当前会话，以及绑定发起 Run 时 `targetSessionId` 防止跨会话串线；运行中切换/新建/删除会话在 `AgentRuntime` 层被明确拒绝（`RUN_ACTIVE`）。
- 权限与隐私边界（A2）：严守**零静默自动提取**原则。记忆仅来自用户在「管家记忆」页或对话气泡点击「存为记忆」后在可编辑确认卡片中主动点按保存。

### 4. React Native UI 与独立外壳路由
- 新增 `src/core/agentPersistence.ts`：纯 TS（仅 `import type`），实现记忆排序/过滤、2400 字注入预算视图计算、显式草稿生成 `buildMemoryDraftFromMessage`、历史阶段/时间格式化与存储降级/隔离告警构造。
- 升级 `src/screens/AgentMemoryScreen.tsx`：新增分类选择器、置顶/启用切换、搜索与分类筛选、以及 2400 字系统提示词注入预算进度条与每条状态徽标（`已注入` / `超额未注入` / `已停用`）。
- 新增 `src/screens/AgentHistoryScreen.tsx`（独立页面不依赖 `useApp()`，并同时注册到 `RureaApp.tsx` 与 `App.tsx`）：支持「全部 / 待核对 / 失败与中断」筛选、「确认已核对」持久化动作与可折叠的工具执行时间线。
- 升级 `src/screens/AgentButlerScreen.tsx`：Header 新增 `历史` 入口，下方新增紧凑多会话切换栏与可展开会话管理抽屉，对话气泡新增轻量「存为记忆」显式保存入口，并在顶部呈现存储降级只读或损坏隔离提醒。

---

## 三、迁移回滚与运维规程（Stop-the-World）

1. **正常升级**：应用进程首次初始化 `AgentRuntime` 时自动执行同步迁移；原始 v1 文件均保存在应用私有目录 `files/agent-backups/v1-<ts>/`。
2. **严禁直接降级覆盖**：若从未来高版本回退安装旧版 APK，`StorageMigrator` 会命中 `STORAGE_DOWNGRADE_BLOCKED`，拒绝读写本地持久化文件（仅提示升级），保护高版本用户数据不被截断。
3. **坏文件取证**：所有无法解析的 `agent-memory.json`、`agent-thread.json`、`storage-manifest.json` 或确认核对后的损坏 `.properties` 均保留为 `*.corrupt.<ts>` 副本，不直接删除。

---

## 四、实跑验证结果

| 验证项 | 命令 / 对象 | 结果 |
|---|---|---|
| **JVM 核心与迁移测试** | `.\gradlew.bat --no-daemon --console=plain :agent-core:test --rerun-tasks` | **15 个测试类、158/158 通过**（0 fail / 0 error / 0 skip；含 `StorageMigratorTest` **8/8**、`FileRunStoreTest` **12/12**、`RunRecoveryTest` **7/7**） |
| **Android Kotlin 编译** | `:app:compileDebugKotlin` | **BUILD SUCCESSFUL**（无新增警告） |
| **RN `test:agentChain`** | `npm run test:agentChain` | `test:agentCoreCi` **42/0** + `test:screenOff` **2/0** + `test:agentStream` **7/0** + `test:agentC2` **4/0** + **`test:agentC3` 6/0** + `test:agentC4` **6/0** |
| **类型与门禁** | `npm run typecheck` / `test:suiteRunner` / `test:signingWf` / `test:security` | `tsc --noEmit` **0 错误**；`suiteRunner` **75/0**（127 条命令）；`signingWf` **32/0**；`security` **61/0** |

---

## 五、诚实边界与后续
- 本轮已通过纯 JVM Stop-the-World 迁移/损坏隔离/二次冷重启回归（158/158）、`:app:compileDebugKotlin` 编译、RN 纯逻辑/故障分类/跨层接线测试与仓库级安全/CI 门禁验证。
- 物理真机（vivo V1981A `762a319`）上的 `am force-stop` 多次冷重启、v1→v2 真机迁移、气泡「存为记忆」及跨重启核对体验留待下一步按需执行真机验收。
