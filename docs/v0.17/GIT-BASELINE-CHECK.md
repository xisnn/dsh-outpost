# DSH Outpost v0.17 — Git 基线检查报告

| 项 | 值 |
|---|---|
| 检查时间 | 2026-10-28 13:59–14:10 Asia/Shanghai |
| 仓库 | `E:\work\dsBot` |
| 检查时分支 | `main`（检查后从该提交重建 `feat/v0.17`） |
| 当前 HEAD | `06a33e1`（`main` = `origin/main`） |
| 当前发布标签 | `v0.16.7`（annotated tag `54c5686`）→ `06a33e1` |
| 工作区状态 | 干净；仅未跟踪 `emu-screenshots/`（95 个文件，非构建输入） |

---

## 1. 结论摘要

1. **RC 代码基线 `3349bbf` 仍完整保留，且未被任何后续提交改动**。`3349bbf..HEAD` 在 `dsh-mobile/src`、桌面端、插件、脚本、CI 目录上**零差异**。
2. **`60d37d8` 只改版本与 README**：`dsh-mobile/package.json` 的 `version` 从 `0.16.6` 改成 `0.16.7`，README 更新版本表与消息可靠性说明；没有业务代码改动。它是 v0.16.7 的版本号来源。
3. **`6e708b6` 的代码部分只改测试/CI**：两个测试补 `ensureWebSocket()`，`package.json` 增加 `test:retry` 并接进 `npm test` 链；没有业务代码改动。原始 `6e708b6` 曾被研究报告的中间快照污染（1,656 行），该报告现已从当前历史清除；其等价提交为 `35667c3`，代码内容与原始 `6e708b6` 完全一致（只少了研究报告文件）。
4. **当前 `v0.16.7` 标签指向 `06a33e1`**（历史清理后的新 annotated tag 对象 `54c5686`）。它与原标签对象 `2782771`（指向 `6e708b6`）的运行时树完全一致；差异仅在研究报告文件、RC 文档、测试/包配置与 `.gitignore`。
5. **RC 验收 APK 仍在**：`_acceptance-apk/DSH-Outpost-TEST-0.0.0-verify.local-20261028-015002.apk` 的 SHA-256 为 `2FD7C78B...`，与 `DSH-OUTPOST-RC-FINAL-ACCEPTANCE.md` 记录一致；`dsh-mobile/android/app/build/outputs/apk/release/app-release.apk` 也是同一哈希。
6. **研究报告已由共享工作区清理**：历史中 `docs/research/CINDY-VS-DSH-OUTPOST-RESEARCH.md` 已被移除，`.gitignore` 增加 `docs/research/`；这不影响 RC 代码、APK 或运行时行为。

---

## 2. 当前引用与工作区状态

### 2.1 引用

| 引用 | 提交/对象 | 说明 |
|---|---|---|
| `HEAD` / `main` / `origin/main` | `06a33e1` | `chore: 忽略 docs/research/ 内部研究报告` |
| `v0.16.7`（annotated tag） | tag `54c5686` → `06a33e1` | tagger 时间 2026-10-28 04:49:19 |
| `git describe --tags --always HEAD` | `v0.16.7` | 标签正指向当前 HEAD |
| 原 v0.16.7 标签对象 | tag `2782771` → `6e708b6` | 旧对象仍可按哈希读取，但当前分支不再引用 |
| `feat/v0.17` | `06a33e1`（本报告完成后提交文档） | 从当前 `main` 重建的独立开发分支 |

### 2.2 工作区

- `git status --porcelain=v2`：仅 `? emu-screenshots/`。
- 无暂存改动、无未暂存改动、无 stash、无 `.gitmodules`/子模块。
- `git diff --check`：无输出。
- `emu-screenshots/` 为 95 个模拟器截图文件，未被 `.gitignore` 排除，但与构建/发布无关；本分支未纳入、未删除。

### 2.3 分支动作

| 动作 | 结果 |
|---|---|
| 创建/重建 v0.17 开发分支 | `feat/v0.17`，起点 `06a33e1` |
| `main` | 未改动，仍为 `06a33e1`，与 `origin/main` 同步 |
| `v0.16.7` 标签 | 本次操作未修改；当前指向 `06a33e1`（由先前历史清理产生） |
| Push / 新 Tag / GitHub Release | 均未执行 |

---

## 3. 三个重点提交的实际修改

### 3.1 `3349bbf`：RC 代码基线

- 作者/时间：xisnn，2026-10-28 01:41:58 +0800。
- 提交说明：`fix: 重试复用 requestId，避免服务端重复执行任务`。
- 实际改动：

| 文件 | 变更 |
|---|---|
| `dsh-mobile/src/core/store.ts` | `send()` 增加 `requestId` 参数并透传给 `session/prompt`；失败时按 `optimisticKey` 精确删除乐观消息 |
| `dsh-mobile/src/screens/ChatScreen.tsx` | 失败后记住 `{requestId, text}`，重试复用；内容变化时换新 id；错误提示区分“结果未知”和“没发出去” |
| `dsh-mobile/tests/send-idempotency-spec.mjs` | 新增 12 项回归测试（252 行） |
| `dsh-mobile/package.json` | 增加 `test:idem` 并接进 `npm test` 链 |

- 影响：已通过模拟器验收的 RC 代码；`3349bbf` 本身未包含版本号提升。
- 当前状态：仍是 `HEAD` 的祖先，`git merge-base --is-ancestor 3349bbf HEAD` 成立。

### 3.2 `60d37d8`：版本与 README

- 作者/时间：xisnn，2026-10-28 03:26:44 +0800。
- 提交说明：`release: v0.16.7 —— 消息发送可靠性`。
- 实际改动：2 个文件，11 insertions / 6 deletions。
  - `dsh-mobile/package.json`：`"version": "0.16.6"` → `"0.16.7"`。
  - `README.md`：当前版本改为 v0.16.7；补充消息可靠性说明；版本表补 0.16.4–0.16.7。
- 影响：只影响版本元数据与文档；不改变运行时逻辑。
- 来源线索：正常发布流程提交，提交说明与 diff 一致，没有夹带其他文件。

### 3.3 `6e708b6`：测试与 CI 修复（原始对象与当前等价提交）

- 原始对象：`6e708b6`，作者/时间 xisnn，2026-10-28 03:43:50 +0800。
- 提交说明：`fix(test): 两个新测试缺 ensureWebSocket，CI（Node 20）直接失败`。
- 原始 diff 实际包含 **5 个文件、1,671 insertions / 1 deletion**：
  - `dsh-mobile/tests/send-idempotency-spec.mjs`：在 import `DshConnection` 前调用 `ensureWebSocket()`（+7）。
  - `dsh-mobile/tests/send-retry-spec.mjs`：同样补 `ensureWebSocket()`（+6）。
  - `dsh-mobile/package.json`：新增 `"test:retry"` 并插入 `npm test` 长链（+2/-1）。
  - `docs/research/CINDY-VS-DSH-OUTPOST-RESEARCH.md`：**新增 1,656 行**（研究报告中间快照，提交说明未提及）。
- 当前历史中的等价提交：`35667c3`，**3 个文件、15 insertions / 1 deletion**：
  - 与原始 `6e708b6` 的 `git diff 6e708b6 35667c3` 只有研究报告文件被删除（1,656 行）；测试/CI 改动逐字节一致。
- 影响：
  - 测试/CI 部分修复了 Node 20 没有全局 WebSocket 导致的 Unit tests 失败，并把此前从未进入 CI 的 `send-retry-spec` 接进测试链；对运行时无影响。
  - 研究报告部分不影响 APK；当前历史已通过 `git filter-branch` 清除该文件，并在 `.gitignore` 添加 `docs/research/`，避免再次 `git add -A` 误提交。
- 来源线索：
  - 原始提交说明只写测试/CI，没有提研究报告，属于共享工作区中 `git add -A` 类操作误扫。
  - 研究报告自身附录 E 与旧提交 `075eec3` 的说明均记载：报告由**另一个并发进程/工作区**产出，不属于发布流程。
  - 后续清理由用户侧共享工作区完成；当前 `35667c3` 是清理后的等价提交，原始 `6e708b6` 仍可按哈希读取用于审计，但不在任何当前分支上。

### 3.4 历史清理与提交映射

当前 `git log` 的发布线：

```text
06a33e1  chore: 忽略 docs/research/ 内部研究报告
d4c6a12  docs: 记录 v0.16.7 发布状态与 CI 修复
35667c3  fix(test): 两个新测试缺 ensureWebSocket，CI（Node 20）直接失败
60d37d8  release: v0.16.7 —— 消息发送可靠性
debc0be  docs: RC 最终验收报告（3349bbf / RC READY）
dbbbd37  docs: 消息发送可靠性检查报告（发布前）
3349bbf  fix: 重试复用 requestId，避免服务端重复执行任务
```

新旧对应：

| 旧提交（不在当前分支） | 当前等价提交 | 差异 |
|---|---|---|
| `6e708b6` | `35667c3` | 仅删除 `docs/research/CINDY-VS-DSH-OUTPOST-RESEARCH.md`（1,656 行） |
| `692f78d` | `d4c6a12` | 仅删除该报告的后续修订；RC 发布状态 38 行保留 |
| `075eec3`（旧 revert） | — | 效果由历史清理 + `06a33e1` 的 `.gitignore` 取代 |

- 旧 `v0.16.7` 标签对象 `2782771` → `6e708b6` 仍可按哈希读取；当前标签对象 `54c5686` → `06a33e1`。
- **两个标签对象的运行时树相同**：`git diff 6e708b6 06a33e1` 仅包含研究报告删除、RC 文档、`.gitignore`、测试/包配置变更，不含业务代码。

---

## 4. 对 RC 与 v0.16.7 的影响判定

### 4.1 代码差异

以下命令均无输出（零差异）：

```text
git diff --stat 3349bbf..HEAD -- dsh-mobile/src dsh-outpost-desktop dsh-plugin-connect scripts .github
git diff --stat 60d37d8..HEAD -- dsh-mobile/src dsh-outpost-desktop dsh-plugin-connect scripts .github
```

`3349bbf..HEAD` 的全部变更：

```text
.gitignore                                     4/0
DSH-OUTPOST-RC-FINAL-ACCEPTANCE.md           260/0
DSH-OUTPOST-SEND-RELIABILITY-REPORT.md       365/0
README.md                                     10/5
dsh-mobile/package.json                        3/2
dsh-mobile/tests/send-idempotency-spec.mjs     7/0
dsh-mobile/tests/send-retry-spec.mjs           6/0
```

其中 `dsh-mobile/package.json` 的 3/2 只有版本号与 `test:retry` 脚本，不含依赖或运行时代码。

### 4.2 结论

- **v0.16.7 的运行时 = `3349bbf` 的运行时**；`60d37d8`/`35667c3`/`d4c6a12`/`06a33e1` 只影响版本号、README、测试/CI、文档与 `.gitignore`。
- **RC 验收结论仍然有效**；无需回退、重建或重新验收已发布的 v0.16.7 APK。
- **研究报告清理是仓库内容治理，不是产品变更**；当前历史不包含该报告，不阻塞 v0.17 开发。
- 若发布审计要求 `v0.16.7` 标签继续指向原始对象 `2782771`，需要单独确认；本报告只记录事实，不擅自移动标签。

---

## 5. 已验收版本与 APK 保留清单

### 5.1 验收 APK（工作区保留）

| APK | SHA-256 | 说明 |
|---|---|---|
| `_acceptance-apk/DSH-Outpost-TEST-0.0.0-verify.local-20261028-015002.apk` | `2FD7C78BEBD0E71677D0D33C79BCAE884293DABBDFFC81A62AF9AB25CC0E7741` | **RC READY 验收包**（对应 `3349bbf`，与 `SHA256SUMS-20261028-015002.txt` 一致） |
| `_acceptance-apk/DSH-Outpost-TEST-0.0.0-verify.local-20261027-234510.apk` | `89B910D05CECDF5365E2C110440841689C3B312BFD7E7F166E764E0CF5258F3E` | 中间验收包 |
| `_acceptance-apk/DSH-Outpost-TEST-0.0.0-verify.local-20261027-223643.apk` | `7D877E1728169F8AB66D03ED73D725A8CC6C5ABF20D818ACFA1ACC7BE1C94BE8` | 早期验收包 |

另外，`dsh-mobile/android/app/build/outputs/apk/release/app-release.apk` 的 SHA-256 也是 `2FD7C78B...`，与 RC 验收包一致。

### 5.2 发布 APK 记录

`DSH-OUTPOST-RC-FINAL-ACCEPTANCE.md` 记录的 v0.16.7 正式发布 APK：

- 文件名：`dsh-outpost-v0.16.7.apk`（73.6 MB）
- SHA-256：`1BE39824B0EC35576B91D223CF488D9F911C233EE0063042D409D981D00015F2`
- versionCode/Name：`160700` / `0.16.7`
- 签名证书：`191b16ce...293a736a`（与 CI 一致）

该正式包不在当前工作区的 `_acceptance-apk/` 目录中（目录只保留验收测试包）；其指纹和发布状态已记录在 RC 报告中，未做任何删除或覆盖。

---

## 6. 安全边界确认

本次重新检查与分支准备**没有**执行以下动作：

- 没有回退、覆盖或修改任何业务代码；
- 没有创建、移动或删除 `v0.16.7` 标签；
- 没有创建 GitHub Release；
- 没有推送 `feat/v0.17`；
- 没有删除 `_acceptance-apk/` 或任何 APK；
- 没有把未跟踪的 `emu-screenshots/` 纳入版本控制。

当前唯一的分支动作是：从 `06a33e1` 重建 `feat/v0.17`，并在该分支提交本报告与 P0-1 方案文档；`main` 与 `origin/main` 保持同步。

---

*报告生成：2026-10-28 · 基于 `06a33e1` · 基线代码仍为 `3349bbf`*
