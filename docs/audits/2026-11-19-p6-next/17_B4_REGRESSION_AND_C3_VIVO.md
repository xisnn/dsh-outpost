# 17 — Rurea B4 回归固化 + C3 真机 4 次冷重启与迁移验收（vivo `762a319`）

日期：2026-11-22 · 分支：`opt/p1-phone-polish` · 设备：vivo V1981A (`PD1981`) / Android 12 / API 31 / serial `762a319`
承接：[07_RUREA_B1B2_ACCEPTANCE.md](./07_RUREA_B1B2_ACCEPTANCE.md)、[08_RUREA_B3_VIVO.md](./08_RUREA_B3_VIVO.md)、[15_C1C2C4_VIVO_ACCEPTANCE.md](./15_C1C2C4_VIVO_ACCEPTANCE.md)、[16_C3_PERSISTENCE_MEMORY.md](./16_C3_PERSISTENCE_MEMORY.md)。
性质：**非敏感**（验收脚本、隔离 verifications 入口、只读 emulator CI workflow 与运维 SOP；零改动正式包 `com.dshpocket` 与签名门禁）。

---

## 一、B4 回归固化交付物

1. **统一正常进程验收 Runner（`dsh-mobile/scripts/run-rurea-acceptance.mjs`）**：
   - 收敛 `b2`（副屏手势）、`c1c2c4`（流式 UX + 三层安全门 + 错误恢复）与 `c3`（Stop-the-World 迁移 + 4 次冷重启持久化）三套隔离正常进程验收至同一无外部依赖 Node CLI。
   - 强制锁定隔离包名 `com.dshoutpost.p1.p6next` 与 `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true`；按设备 ABI（或显式 `--abi`）组装、`uninstall -> install -r`、自动 `adb reverse tcp:<port>`、通过 `am force-stop` + `monkey` 驱动多阶段冷重启、自动备份/还原无障碍设置，并于 `finally` 必然卸载隔离包与清理端口转发。
   - 支持 `--dry-run`（已纳入门禁断言）与未知 `--suite` fail-closed 报错退出。
2. **C3 多冷重启验收入口与 loopback 桩**：
   - `dsh-mobile/src/acceptance/c3-persistence-entry.tsx`：经 `-PDSH_TEST_ENTRY_FILE` 编入隔离包，通过 `ReactNativeBlobUtil` 在 `AgentRuntime` 惰性初始化前种入真实 v1 磁盘数据，随后跨越 4 次 `am force-stop` 冷重启完整校验 Stop-the-World 迁移、备份、记忆去重/置顶预算、多会话、`RunStore` 时间线落盘、`pendingReconciliation` 二次冷重启存活与 `acknowledgeRun` 清除，以及未来 `schemaVersion: 99` 清单的 `STORAGE_DOWNGRADE_BLOCKED` 零写盘保护。
   - `dsh-mobile/tests/acceptance/c3-stub-server.mjs`：纯本地 OpenAI SSE loopback 桩（支持动态端口 `0` 供离线测试）。
3. **CI 模拟器验收工作流（`.github/workflows/rurea-acceptance.yml`）**：
   - 独立 `workflow_dispatch` 触发，严格只读 `permissions: contents: read`，零 `secrets.`、零发布动作、零引用 `com.dshpocket`。
   - 基于 `reactivecircus/android-emulator-runner@v2`（API 34 `x86_64`）在正常启动进程运行 `c3` 与 `c1c2c4` 套件，并将 JSON 报告保留为 Actions Artifact（`14` 天）。
4. **可复现操作规程（`docs/rurea-acceptance-runbook.md`）**：
   - 文档化环境准备、三套件命令、vivo OEM 注意事项（解锁屏幕/安装确认/Shizuku 保活/无障碍还原/受限 `logcat` 替代路径）、验后清理核对与显式 `BLOCKED` 项。
5. **离线回归守卫（`dsh-mobile/tests/agent-b4-acceptance-ci-spec.mjs`）**：
   - 接入 `npm run test:agentB4` 与 `test:agentChain`，实跑本地 `c3-stub-server.mjs`（端口 `0`）HTTP SSE、验证 runner `--dry-run` 对 3 套件包名锁定与未知套件拒绝、并校验工作流权限边界与 runbook 完整性。

---

## 二、vivo V1981A（`762a319`）C3 四次冷重启真机实测结果

命令：
```powershell
node scripts/run-rurea-acceptance.mjs --suite c3 --serial 762a319 --report-out ../docs/audits/2026-11-19-p6-next/evidence/P6-rurea-c3-vivo-report.json
```

实测 **`4/4` Stage 全部通过（`allOk: true`）**：

| Stage | 进程启动次数 | 真机实测结论 | 关键实测数据 |
|---|---|---|---|
| **Stage 1** | 首次冷启（种 v1 数据 → 初始化 `AgentRuntime`） | **通过** | `status="migrated"`、`fromVersion=1` → `toVersion=2`、`backupPath="agent-backups/v1-1795344711234"`（含 `agent-memory.json` + `agent-thread.json` 备份）+ 去重告警 `1` 条；`run-v1-crash` 被 `RunRecovery` 记为 `interrupted + requiresReconciliation=true`（不消除）；编辑重名被拒 (`dupRejected=true`)、置顶优先排序、预算 `125` 字符；新建会话运行 `[C3_PERSIST_RUN]` 调 `workspace_list` 返回 `C3_PERSIST_OK` 且落盘 `2` 条事件 |
| **Stage 2** | **`am force-stop` 后第二次冷启** | **通过** | `status="up_to_date"`、备份目录仍为 `1` 份（幂等）；**`crashSurvivedSecondRestart=true`**（`run-v1-crash` 跨越第二次冷重启继续呈现）；`2` 个会话 / `[C3_PERSIST_RUN]` 对话 / `3` 条置顶记忆 / `2` 条 Run 事件全数存活；调用 `acknowledgeRun('run-v1-crash')` 后 `recoveryAfterAck=null` 且落盘 `reconciledAt=1795344714214` |
| **Stage 3** | **`am force-stop` 后第三次冷启** | **通过** | `recoveryClearedOnRestart=true`（已核对崩溃不再重复弹出）；记录 `agent-memory.json` (`480` bytes) 与 `agent-thread.json` (`455` bytes) 原文快照后写入 `{"schemaVersion":99}` 模拟未来高版本磁盘 |
| **Stage 4** | **`am force-stop` 后第四次冷启** | **通过** | `status="downgrade_blocked"`、`downgradeBlocked=true`、`fromVersion=99`、`formatStorageNotice.tone="danger"`；`startCloud` / `createSession` / `saveMemoryEntry` 三路写入口全部失败拒绝且错误码均为 **`STORAGE_DOWNGRADE_BLOCKED`**；回读 `agent-memory.json` 与 `agent-thread.json` **`filesUntouched=true`**（零改写、零截断） |

---

## 三、离线自动化与设备清理回读

| 检查项 | 结果 |
|---|---|
| `npm run test:agentChain` | `test:agentCoreCi` **42/0** + `test:screenOff` **2/0** + `test:agentStream` **7/0** + `test:agentC2` **4/0** + `test:agentC3` **6/0** + `test:agentC4` **6/0** + **`test:agentB4` 3/0** |
| `npm run typecheck` | `tsc --noEmit` **0 错误** |
| `test:suiteRunner` / `test:signingWf` / `test:security` | `suiteRunner` **75/0**（128 条命令）、`signingWf` **32/0**、`security` **61/0** |
| `vivo 762a319` 清理回读 | `pm list packages com.dshoutpost.p1.p6next` **为空**；`adb reverse --list` **为空**；`enabled_accessibility_services` 保持原值 `com.vivo.favorite/...`、`accessibility_enabled=1` |

---

## 四、证据与已知阻塞
- 真机 4 次冷重启报告：[P6-rurea-c3-vivo-report.json](./evidence/P6-rurea-c3-vivo-report.json)
- 已知 BLOCKED 项见 [rurea-acceptance-runbook.md](../../../docs/rurea-acceptance-runbook.md)（`API 36 FGS dataSync`、`#37 libproot.so`、多 ROM OEM 矩阵、Shizuku 全量离主线程重构与 CI `b2` 守护进程环境）。
