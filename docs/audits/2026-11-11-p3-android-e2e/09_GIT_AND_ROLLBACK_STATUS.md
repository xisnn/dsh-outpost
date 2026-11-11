# 09 Git 与回滚状态

> 本文不钉住自身 commit SHA；精确 HEAD 见随 ZIP 交付的 `evidence/GIT-HEAD.txt`（最后一次提交后生成）。

## 1. 分支与提交

| 项 | 值 |
|---|---|
| 工作分支 | `opt/p3-bug03`（独立测试分支） |
| 验收基线 HEAD | `a519299`（本轮开始前） |
| 本轮新增 | **仅文档**：`docs/audits/2026-11-11-p3-android-e2e/00…09` + 证据清单；**零产品代码改动** |
| main | **未合并、未触碰** |
| Tag / Release / 签名发布 | **未创建、未执行** |
| P4 | **未启动** |

## 2. 被验收的修复提交（既有，非本轮新增）

- BUG-02：`cb959e7`（call() 超时保持到响应体读完 + 超时归类）。
- BUG-03：`a232ee0`（嵌套 result 字段）、`f016204`（仅无歧义 ID 绑定）、`8dedd2a`（三态 unconfirmed）、`6c39687`（turn 身份与诊断同步）。

## 3. 回滚能力（诚实报告）

- **本轮无产品代码改动 → 不引入新的回滚依赖。** 验收报告与证据为纯文档，可整体 revert 而不影响任何运行时行为。
- 既有 P3 修复的回滚粒度沿用上一轮**实测**结论：分层修复共享 `fold/index.ts` 等文件的相邻编辑，
  **不能**保证逐提交独立 revert；安全路径为**逆序 revert 或整段 range revert**（见上一轮 `docs/audits/2026-11-11-p3-bug03/` 的回滚测量）。
  本轮未重新测量、也未改变该结论。
- 测试环境产物（隔离 DSH profile、注入服务端、AVD、APK）均在仓库外或隔离包名内，删除/卸载即可完全清理，不影响正式环境：
  - 卸载测试包：`adb -s emulator-5584 uninstall com.dshoutpost.p1.p3e2e`
  - 停止隔离服务：`scripts/stop-isolated-dsh.ps1`（只匹配 `--port 3995`，绝不触碰正式 3095）
  - 删除 `E:\work\p3-android-e2e\`（独立工作区）与 AVD `p3_e2e_api35`（可选）

## 4. 正式环境完整性证明

- 正式 DSH（PID 34928，3095/3081）、magpie、claude 全程存活。
- 正式设备注册表 SHA-256 基线 `logs/formal-registry-baseline.sha256`，验收中/后 `sha256sum -c` = OK。
- 真实手机 `762a319` 未安装/写入任何本轮产物。

## 5. 交付与停止

- 交付物打包为 `DSH-Outpost-P3-Android-E2E-Acceptance.zip`（仓库外），含报告、证据、脚本、日志。
- 完成后**停止**，等待第二方最终复核；不自动合并 main、不打 Tag、不发布、不启动 P4。