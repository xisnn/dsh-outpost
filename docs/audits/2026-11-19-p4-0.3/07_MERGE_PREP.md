# 07 · 合并准备（FF 演练 / 门槛清单 / 升级规程 / 分支策略）

- 背景：第二方选 (a) 合并准备；**手机 agent 功能仍在开发中**（第二方自述），
  故本文件只做演练与草案，**不执行任何合入**。
- 基线：main `e835782`（v0.18.3 已发布）；集成线 `opt/p4-0.3-coverage-screenoff` `0bb08b2`。

## 1. 拓扑与 FF 演练（非破坏性证明）

- `merge-base --is-ancestor main opt` = true；opt 领先 **69 提交**；
  改动面 **224 文件 +39741/−269**（P4 安全线 + P6 checkpoint + 本轮）。
- `git merge-tree --write-tree main opt` 产出树 `34d0bf36…`，与
  `opt^{tree}` **逐字相同** ⇒ FF 结果即 opt 树，无冲突、无合并提交。
- 结论：两条「并行线」无代码分叉；P6 checkpoint `1aa2d82` 已在 opt 内。
  合并动作本身 trivial；**难的是验收门槛，不是冲突**。

## 2. 门槛清单（治理：main 阻塞条件）

| 门槛 | 状态 | 出处/解锁 |
|---|---|---|
| P4 安全整改双绿 | ✔ | run 44562306847 全 job 绿 |
| 锁仲裁竞态闭环 | ✔ | 06（确定性 3/3 + 60×4 零违例） |
| P1 原生功能独立验收 | ✘ | **功能开发中**；手势类真机 RED/GREEN 缺 |
| 真机证据（手势/息屏/OEM 后台/API36 FGS） | ✘ | 需专用真机或第二方明确授权 |
| 敏感项 #17/#15/#23/#25 | ✘ 仅设计 | 逐项第二方批准 |
| #37 libproot / LocalRuntimeBridge 全链路 | ✘ BLOCKED | native dir 注入或正式打包 |
| 发布签名/版本水位门禁 | ✔ 未动 | release 仅 tag v* 触发 |

## 3. 功能未完成期间的分支策略（推荐）

- **main 不动**（发布线 v0.18.3）；opt/p4-0.3 作集成线继续承载安全修复。
- 第二方活跃开发分支 = `opt/p1-phone-polish`。核验：它是 opt tip 的**严格祖先**
  （0 ahead / 60 behind；含 1aa2d82 与 e835782，不含 8648a02/0d15601），merge-tree 干净。
  **已 FF 到 opt tip（f18c7f3）**：只加已验证绿提交、无 rewrite；旧 tip 2325d34
  经 reflog 可回退。agent 新功能直接在此分支继续，不再另起长期分支、不再分叉。
- 风险：该分支**未推 origin**（单副本）。建议第二方确认后 push 备份。
- 工作区：该分支当前未在任何 worktree 检出；需要时一条命令开：
  `git -C E:/work/dsBot worktree add E:/work/dsBot-p1-polish opt/p1-phone-polish`
  （清理删除的 dsBot-p1-native 之提交 1aa2d82 已含于本线，无丢失）。
- 证据/设计文档继续放 `E:/DSH-Private/Outpost/v0.19`（并行性在证据层，不在代码层）。
- 合入时机：**功能完成 + P1 验收 + 真机补证后 FF main**；或第二方书面豁免门槛
  （记录于交付文档）。不建议现在 FF main：会把未验收的 agent 代码放进发布线基线。

## 4. stop-the-world 升级/回滚规程（草案，部署实例用）

混版矩阵：P4-0.1（rename-replace+回收票）/ P4-0.2（wx+原子取走）/
P4-0.3（+孤儿窗口守卫）**仲裁互不互通**；混版并发实证双所有权 ⇒ 禁止滚动升级。

升级步骤：
1. 停止该注册表全部 DSH/网关实例；逐 pid 确认死亡（zombie 按 Linux 规程判定）。
2. 检查 sidecars：活 marker/grave 按孤儿规程处置（**不得盲删活记录**）；
   死 marker+死 grave 方可清理；不可读者保留待人工。
3. 备份注册表、state.json、补丁目录；记录 SHA-256 与 mtime。
4. 切换补丁 payload（apply 脚本）；校验哈希。
5. 先单实例启动 → /health + 单主验证 → 再启其余实例。
6. 负向验证：第二实例必须 fail-closed 拒绝；锁套件本地绿。
7. 记录升级窗口、前后哈希、实例清单。

回滚：对称 stop-the-world；**回滚非安全中性**（P4-0 R1）→ 同时恢复 deviceFile
显式 pin 作补偿控制；回滚后重跑负向验证。

## 5. 待第二方决策

1. 合入时机：功能完成后 FF（推荐）/ 现在 FF 并书面豁免门槛 / 先合到集成分支 staging。
2. 真机授权与敏感项批准（门槛清掉才能闭环 P1 验收）。
3. 是否立即恢复 agent 开发工作区（§3 命令）。
