# Rurea 正常进程验收与真机回归操作规程（B4 Runbook）

本规程用于可复现地在 Android 真机或模拟器上运行 Rurea 隔离验证包（`com.dshoutpost.p1.p6next`），**严禁使用 `am instrument`（vivo D 状态死锁 / emulator 无障碍不绑定），也严禁污染正式包 `com.dshpocket` 与用户真实数据**。

---

## 一、环境前置

1. 安装 JDK 21（Windows 默认探测 `D:\Jdk21`）与 Android SDK（包含 NDK `27.1.12297006`、`platform-tools/adb`）。
2. 已在 `dsh-mobile/` 执行过 `npm install`（或 `npm ci`）。
3. 连接一台已解锁屏幕、开启 USB 调试的 Android 真机或启动一台模拟器（API 31+；C3 跨重启套件支持 API 26+）。
4. 如需运行 `b2` 后台虚拟屏手势套件：设备需安装并**启动 Shizuku**（保持后台服务存活），并预先授过权（或首次在测试弹窗手工点允许一次）。

---

## 二、统一执行入口（`scripts/run-rurea-acceptance.mjs`）

在 `dsh-mobile/` 目录执行以下任一套件：

### 1. `c3` — 持久化深度与 4 次冷重启迁移验收
覆盖 v1→v2 Stop-the-World 迁移、`fd.sync` 备份、重复 key 去重与编辑重名拦截、置顶注入预算、多会话上下文、工具事件落盘、二次冷重启未核对恢复（`pendingReconciliation`）及未来 v99 清单降级 fail-closed（`STORAGE_DOWNGRADE_BLOCKED`）：
```bash
node scripts/run-rurea-acceptance.mjs --suite c3 --report-out ../docs/audits/2026-11-19-p6-next/evidence/P6-rurea-c3-report.json
```

### 2. `c1c2c4` — 流式 UX + 三层安全门 + 错误恢复 7 用例验收
覆盖 `OPENAI_COMPAT` / `OPENAI_RESPONSES` 原生流式增量、在途 `stop()` 中断、401/503/断流重试、`BACKGROUND_NOT_READY` 拒退主屏与三层安全策略 + 审批 TTL：
```bash
node scripts/run-rurea-acceptance.mjs --suite c1c2c4 --report-out ../docs/audits/2026-11-19-p6-next/evidence/P6-rurea-c1c2c4-report.json
```

### 3. `b2` — 后台副屏手势端到端验收（需 Shizuku）
覆盖在 Shizuku 副屏真实打开系统应用、读屏、滚动、输入、点击与按键返回：
```bash
node scripts/run-rurea-acceptance.mjs --suite b2 --report-out ../docs/audits/2026-11-19-p6-next/evidence/P6-rurea-b2-report.json
```

常用参数：`--serial <device-id>` 指定设备、`--abi arm64-v8a|x86_64` 显式架构、`--skip-build` 复用已编译 APK、`--dry-run` 仅检查路径与配置而不实际编译或连接设备。

---

## 三、vivo / OEM 真机注意事项

1. **解锁屏幕 & USB 安装确认**：`adb install` 前请先手动解锁屏幕；若首次弹出 OEM「继续安装」确认，由操作者手动点击一次（Runner 不越权绕过锁屏或系统确认框）。
2. **Shizuku 管理器保活（`b2` 必备）**：OriginOS / FuntouchOS 激进杀后台会导致 `Shizuku provider is null`，跑 `b2` 前建议先手动打开一次 Shizuku 应用保活。
3. **无障碍绑定**：Runner 会在 `b2` / `c1c2c4` 阶段自动备份并在 `finally` 还原 `enabled_accessibility_services` 与 `accessibility_enabled`，并通过 `0 -> 1` toggle 确保正常进程即时绑定。
4. **日志替代路径**：vivo 等受限 ROM 默认屏蔽第三方进程 `logcat` 明文采集，所有套件以 loopback `/report`（`adb reverse tcp:8787 tcp:8787`）为准。

---

## 四、验后核对与安全清理

Runner 退出前会自动执行以下清理；真机验收结束后请通过 `adb` 二次核对：
- 隔离包已卸载：`adb shell pm list packages com.dshoutpost.p1.p6next` 应为空；
- 端口转发已清空：`adb reverse --list` 应无残留 `tcp:8787`；
- 无障碍原值已恢复：`adb shell settings get secure enabled_accessibility_services` 恢复到运行前原值（如 vivo 原生服务）。

---

## 五、已知阻塞清单（BLOCKED，本轮不伪造覆盖）

| 阻塞项 | 现状与原因 |
|---|---|
| **`API 36 FGS dataSync` 限时** | 当前可用真机仅 vivo V1981A（Android 12 / API 31），无 Android 16（API 36）硬件实测。 |
| **`#37 libproot.so` 本地运行时** | 缺少预编译 `libproot.so` 二进制资源，C5 本地模型运行时整条线仍为 `BLOCKED`。 |
| **多 OEM ROM 矩阵（小米 / 华为 / 三星）** | 当前手头仅一台 vivo V1981A 真机，缺乏其它厂商实体机复验后台保活与安装策略。 |
| **Shizuku 全量离主线程懒加载 + CI `b2` 自动跑** | CI GitHub 模拟器默认无 Shizuku 守护进程与 root 提权环境，故 [rurea-acceptance.yml](../.github/workflows/rurea-acceptance.yml) 仅固化 `c3` 与 `c1c2c4`，`b2` 由本规程在真机运行。 |
