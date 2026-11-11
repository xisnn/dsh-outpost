# 06 · Git 差异与回滚

- 基线：`17040e9c582851b072446ffbc49c5eb91fff195d`（上一轮交付 HEAD，工作区干净）
- 本轮新增 commit：`4a24e9a37c3b7f4b62163ae40c8d002221a1ddbc` — `fix: give ApprovalBanner a distinct sibling key in the chat composer`
- 分支：`opt/p3-bug03`（测试分支；**未合并 main、未打 Tag、未发 Release**）
- 远程：已 push `origin/opt/p3-bug03`；CI 见 `05_REGRESSION_TEST_RESULTS.md`

## 1. 仓库内差异（全部）

```
dsh-mobile/package.json                            |   3 +-   （新增 test:chatKeys 并挂入 test:chain）
dsh-mobile/src/screens/ChatScreen.tsx              |   3 +-   （1 行 key 修改 + 1 行注释）
dsh-mobile/tests/chat-screen-sibling-keys-spec.mjs | 160 +++  （新增回归 spec）
3 files changed, 164 insertions(+), 2 deletions(-)
```

生产代码净变化 = **1 行**：`ApprovalBanner` 的 `key={sessionId}` → `` key={`approval:${sessionId}`} ``。
无原生（Java/Kotlin/Gradle）改动、无协议改动、无 fold/Store/通信状态机改动、无数据迁移。

## 2. 回滚

- 单 commit revert 即可完整回滚（`git revert 4a24e9a`）。回滚后 `test:chatKeys` 会失败——这是预期的 RED，证明该 spec 真的盯着缺陷。
- **已实测回滚路径**：本轮 A/B 对照就是把该行临时改回 `key={sessionId}`，经 Metro Fast Refresh 下发后模拟器重新出现 13 条 duplicate-key 警告；改回修复值后警告归零。即「回滚 → 缺陷复现 → 再修复 → 缺陷消失」闭环真实走过。
- 纯 JS 改动：Debug 包经 Metro 加载，回滚不需要重编 APK；若走离线 bundle 则需重新 `assembleDebug`（本轮未改原生，构建配置不变）。
- 无持久化 schema 变化，回滚不涉及用户数据。

## 3. 仓库外测试设施变更（不属于交付 commit，单独列出）

均在 `E:/work/p3-android-e2e/`（独立验收工作区）：

- `scripts/inject-server.mjs`：新增连接级跟踪（connId/remotePort）、requestId 业务 effects 账本、全量 HTTP 请求日志、`/__ctl/effects`、hang/abort 模式。
- `scripts/ui.mjs`：dump 前先删旧 xml 并重试，失败即抛错（修复「过期 dump 被当成当前界面」）；其余不变。
- `scripts/d1-regression.mjs`、`scripts/d2-run.mjs`、`scripts/d2-follow-diag.mjs`：新增回归/验收驱动。
- `scripts/net-block.sh`：注释更新为 LAN 寻址口径（规则本身不变：OUTPUT DROP dport 3995/3981）。
- `scripts/start-isolated-dsh.sh`：`--host` 由 127.0.0.1 改为具体局域网 IPv4 `192.168.193.223`，cwd 改为 `C:/Users/xis/p3-d2-ws`（pwsh 沙箱在 E:/work 下 Win32 5 失败）。**DSH 拒绝通配符绑定**（安全门禁），故用具体地址；验收结束后应改回 127.0.0.1。
- 隔离 profile `dsh-home/profiles/p3e2e/cordis.patch.yml`：`lanHost`/`lanAdvertiseHost` 改为同一具体 IPv4（原为 127.0.0.1）。deviceFile/gatewayStateFile 的 pin 保持不变。
- 以上只影响隔离实例与测试脚本；**正式 DSH（端口 3095/3081）与正式注册表全程未触碰**，sha256 与基线一致。

## 4. 当前工作区状态

报告目录 `docs/audits/2026-11-11-p3-final-closure/` 为本轮新增文档（随交付 commit 提交）。除此之外无未提交生产改动。