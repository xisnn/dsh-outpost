# 05 · 回归测试结果（本地 + 远程 CI）

## 1. 本地（真实执行，原始日志在证据目录）

| 项目 | 结果 | 日志 |
|---|---|---|
| D-1 新 spec（修复前） | **RED**：3/3 失败，冲突与模拟器日志逐字一致 | `d1-red-before-fix.log`（exit 1） |
| D-1 新 spec（修复后） | **GREEN**：3/3 通过 | `d1-green-after-fix.log`（exit 0） |
| `npm test`（完整 chain，含 typecheck） | **exit 0** | `npm-test-after-d1.log` |
| `npx tsc --noEmit` | **exit 0** | `typecheck-after-d1.log` |
| Emulator A/B 回归（D-1 + BUG-03 语义） | 警告 13→0；UI 仅少掉警告 toast；冲突拒绝/迟到回收/去重/重连全部保持 | `before-*` / `after-*`、`d1-ab-ui-diff.txt` |
| F2 超时/unknown/手动重试/幂等 | PASS | 见 01 |
| D2 断线补洞（真实 Host） | PASS，窗口断言通过 | 见 02 |
| D-3 虚构数据负向测试 | 44/44 断言通过；RED=S1/S7/S8 | `d3/d3-negative-test.stdout.txt` |

BUG-02/BUG-03 相关单测（fold、tool-result-fields/binding/unconfirmed/late-recovery、send-idempotency、send-retry、pending-send 系列、ws-disconnect、ws-reconnect、workgroup 等）均包含在上述 `npm test` chain 中并通过。

**Android Debug 构建**：本轮生产改动为纯 JS（1 行 key），Debug 包经 Metro 加载，本地未重编 APK；远程 CI 的 `build-test` job 执行 `assembleDebug` 作为构建证据（见下）。本地 Gradle 环境上一轮已验证可用（`logs/gradle-assembleDebug-attempt2.log`）。

## 2. 远程 GitHub Actions（真实运行，非本地冒充）

- 触发：`gh workflow run android.yml --ref opt/p3-bug03 -f build_variant=test`（workflow_dispatch，test 变体，**绝不发 Release**）
- Run：<https://github.com/xisnn/dsh-outpost/actions/runs/43051894227>
- 分支/commit：`opt/p3-bug03` @ `4a24e9a37c3b7f4b62163ae40c8d002221a1ddbc`
- 逐 job 结果：见 `ci-jobs.json`（运行结束后抓取）与 `ci-test-job.log`（test job 全量日志）

| job | 结论 |
|---|---|
| test（npm ci + npm test + integration + node20） | success |
| jvm-tests | success |
| desktop | success |
| build-test（assembleDebug，test only） | **success** |
| release | skipped（无 tag，符合门禁） |

Run 总结论 **success**（`ci-jobs.json`、`ci-watch.log`）。`test` job 日志第 [42/114] 步真实执行
`node --test tests/chat-screen-sibling-keys-spec.mjs` 且 3 用例 ok（`ci-test-job.log`），即 D-1 回归 spec 在远程 CI 通过。

## 3. 口径声明

- 本地通过 ≠ 远程通过：两者分别记录，远程以 Actions run 链接与 job 结论为准。
- Emulator 验收与单测/静态审查分级标注，见各报告头部。
- 未为得到 PASS 删除测试、降低断言或隐藏异常；D-1 spec 的 RED 日志保留在交付中。