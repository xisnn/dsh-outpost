# 08 · Git 改动、补丁与回滚验证

- 状态：**PASS（改动范围受控；回滚已在真实隔离插件副本上演练并逐字节校验）**
- 证据级别：STATIC_REVIEW（diff/哈希）+ UNIT_TEST（补丁门禁 G1–G7）+ 真实文件级回滚演练
- 分支：`opt/p4-0-security`（自 `opt/p3-bug03` @ `617d690` 派生）
- **main 未修改；未创建 Tag；未创建 Release；未签名发布**

---

## 1. 分支与提交边界

| 项 | 值 | 校验方式 |
|---|---|---|
| 工作分支 | `opt/p4-0-security` | `git status -sb` |
| 本轮生产修复提交 | `c4c067b` `fix: isolate the gateway device registry under DSH_HOME with single-owner locks` | `git log 617d690..c4c067b` |
| 派生基点 | `617d690`（P3 最终验收记录，已第二方复核） | `git merge-base` |
| `main` HEAD | `e835782` `chore: record the published v0.18.3 Android version floor` | `git rev-parse main origin/main` → **两者相同** |
| `main` 与本轮分支关系 | `merge-base(main, HEAD) == main`，HEAD 领先 50 个提交（P2+P3+P4-0），**main 未被推进** | `git rev-list --count main..HEAD` = 50 |
| 本地 Tag 数 / 远端 Tag 数 | 63 / 63 | `git tag --list \| wc -l`、`git ls-remote --tags origin` → **无新增 Tag** |
| 远端分支 | 仅推送 `origin/opt/p4-0-security`（测试分支） | `git branch -r` |

P3 的全部已验收修复（BUG-02 超时/安全重试、BUG-03 工具结果三态与状态恢复、D-1）**原样保留**：
本轮 diff 未触碰任何 P3 修复文件，`test:chain` 中 P3 相关套件全部仍在链上并通过（见 `07`）。

---

## 2. 仓库侧改动（`617d690..c4c067b`，代码与测试）

`git diff --numstat 617d690..c4c067b -- dsh-mobile patches`：

```
2	1	dsh-mobile/package.json
225	0	dsh-mobile/tests/fixtures/mobile-gateway-home-isolation-devices-fixture.js
43	0	dsh-mobile/tests/fixtures/mobile-gateway-home-isolation-index-fixture.mjs
57	0	dsh-mobile/tests/fixtures/mobile-gateway-home-isolation-state-fixture.mjs
396	0	dsh-mobile/tests/mobile-gateway-home-isolation-spec.mjs
213	0	patches/mobile-gateway-home-isolation/README.md
304	0	patches/mobile-gateway-home-isolation/apply.mjs
49	0	patches/mobile-gateway-home-isolation/files/home-paths.mjs
189	0	patches/mobile-gateway-home-isolation/files/registry-lock.js
141	0	patches/mobile-gateway-home-isolation/patch.mjs
31	0	patches/mobile-gateway-home-isolation/state.json
11 files changed, 1650 insertions(+), 1 deletion(-)
```

加上本目录的审计文档 `01`（221 行），提交总规模为 **12 files, +1871 / −1**。
文档 `00`/`02`–`09` 作为独立的文档提交追加，**不含任何生产代码改动**。

### 2.1 唯一的既有文件修改：`dsh-mobile/package.json`（+2 / −1）

```diff
+    "test:mgwHomeIsolation": "node tests/mobile-gateway-home-isolation-spec.mjs",
-    "test:chain": "... && npm run test:mgwPatch && npm run test:integrity && ..."
+    "test:chain": "... && npm run test:mgwPatch && npm run test:mgwHomeIsolation && npm run test:integrity && ..."
```

即：**只新增一个测试脚本并把它插入既有测试链**，位置紧随同族的 `test:mgwPatch`。
没有删除、跳过、改名任何既有套件，没有放宽任何断言，没有改动 `test`/`typecheck` 入口语义。

### 2.2 新增文件的职责

| 文件 | 职责 | 是否影响生产运行 |
|---|---|---|
| `patches/.../files/home-paths.mjs` | DSH_HOME 解析 + deviceFile 优先级（49 行，纯函数，无 I/O） | 仅在被补丁安装后 |
| `patches/.../files/registry-lock.js` | 单活所有者锁（189 行，CJS，`wx` 原子创建 + 同 pid 可重入 + 陈旧回收 + 失败关闭） | 仅在被补丁安装后 |
| `patches/.../patch.mjs` | 11 处唯一文本锚点 + 标记 `DSH_OUTPOST_HOME_ISOLATION_PATCH` + EOL 对齐 | 否（离线工具） |
| `patches/.../apply.mjs` | `--check/--apply/--revert/--path`，版本白名单 + 双变体 SHA-256 校验 + 全有或全无 | 否（离线工具） |
| `patches/.../state.json` | 记录已应用变体与前后哈希（审计用） | 否 |
| `patches/.../README.md` | 操作手册、门禁说明、回滚步骤、限制 | 否 |
| `dsh-mobile/tests/mobile-gateway-home-isolation-spec.mjs` | 仓库侧 55 条断言（补丁契约 + 解析优先级 + 锁语义） | 否（测试） |
| `dsh-mobile/tests/fixtures/*` | 三个上游模块的**最小可执行替身**，用于在没有安装插件的 CI 上跑契约 | 否（测试） |

> 仓库内**不含**任何 `node_modules` 改动，不含对正式 DSH 安装目录的写入。
> 补丁只在你显式执行 `apply.mjs --apply --path=<隔离插件根>` 时才落地。

---

## 3. 上游源码修复（可维护路径）

克隆：`E:/work/p4-0-security/upstream-mobile-gateway`
分支：`fix/p4-0-device-file-isolation`
提交：`9d26cb9` `Resolve the device registry under DSH_HOME and give it one live owner`
基线：`9ce0b33` `Adapt gateway to DSH 0.2.1-rc.2 Connection Peer`（与安装版 0.10.3 四个模块逐字节一致）

`git diff --numstat 9ce0b33..HEAD`：

```
13	2	lib/devices.js
4	0	lib/gateway-state.mjs
49	0	lib/home-paths.mjs
4	1	lib/index.mjs
189	0	lib/registry-lock.js
1	1	package.json
268	0	test/helpers/isolation-child.mjs
96	0	test/helpers/registry-holder.mjs
391	0	test/home-isolation.test.mjs
9 files changed, 1015 insertions(+), 4 deletions(-)
```

生产代码净改动只有 **lib 5 个文件 +259 / −3**（其中 238 行是两个新增模块，
既有三个文件的实际改动为 `index.mjs` 4/1、`devices.js` 13/2、`gateway-state.mjs` 4/0）。
`package.json` 的 1/1 是把新测试文件追加到 `test` 脚本尾部。

**未推送到上游远端**（无授权，且本轮不对外发布）。diff 已导出：
`delivery/diffs/upstream-mobile-gateway-fix.diff`（1151 行）。

仓库侧 diff：`delivery/diffs/repo-opt-p4-0-security.diff`。

---

## 4. 受控补丁的七道门禁（G1–G7）

原始日志：`logs/patch-gates.log`（2026-11-11T17:18:47Z）， runner：`logs/patch-gates-runner.log`。

| 门禁 | 断言 | 结果 |
|---|---|---|
| **G1** | 重复 `--apply` 幂等：5 个文件逐一二次执行均 exit 0 且报「already applied」 | **PASS** |
| **G2** | 版本不在白名单（伪造 `9.9.9`）→ 拒绝，**文件未被触碰**，exit 1，并打印三个实际 SHA-256 供人工复核 | **PASS** |
| **G3** | 版本正确但 `devices.js` 摘要不匹配（`6491e9dd…` ≠ 两个已审变体）→ 拒绝，**零写入**，exit 1 | **PASS** |
| **G4** | 摘要匹配但锚点缺失（`index.mjs` 被改成 `f0bad154…`）→ 拒绝，exit 1 | **PASS** |
| **G5** | `--revert` 后三个既有文件**逐字节还原**、两个新增模块被删除、`--check` 转为 exit 1 | **PASS** |
| **G6** | 打过补丁的**真实安装包**跑隔离套件 14/14 通过（`A3-GREEN-patched-package.log`） | **PASS** |
| **G7** | 与既有 `mobile-gateway-mgmt-auth` 补丁**可组合**：先管理认证补丁 → 再本补丁（变体 `mgmt-auth-patched`）→ 回滚后**管理认证补丁逐字节存活** | **PASS** |

G3/G4 的关键性质：**失败关闭（fail-closed）**。校验不通过时不写任何文件，
而不是「尽力打上」。这满足章程「不能只手工改 node_modules」的要求。

### 4.1 备份后缀隔离

本补丁使用专属后缀 **`.pre-home-isolation.orig`**，
管理认证补丁使用 `.orig`。两者互不覆盖，这是 G7 能成立的直接原因。

`state.json`（真实隔离插件，变体 `mgmt-auth-patched`）：

```
lib/index.mjs          602a3ed1…5cb9fcb  →  868e159b…bf411dcc
lib/devices.js         63395755…82bae3503 →  6226d4d7…321265d9b
lib/gateway-state.mjs  971fbc10…13b553c75 →  59892270…266f8b67c
lib/home-paths.mjs     (新增)             →  08eec183…0a9b37
lib/registry-lock.js   (新增)             →  b55c9bfb…978663e
```

---

## 5. 回滚演练（在真实隔离插件的副本上）

日志：`logs/rollback-drill-isolated.txt`（2026-11-11T18:46:19Z）。
对象：`E:/work/p4-0-security/rollback-drill/plugin` —— **真实隔离 DSH 插件的完整副本，两个补丁都在**，
不是 fixture，不是空目录。

```
before index sha: 868e159b0f664f44b3e29ebe8581a5a8507adf7852394277e9ad1b60bf411dcc
✓ patch is applied (plugin 0.10.3)
check_exit=0
✓ reverted 3 file(s) and removed the added modules
revert_exit=0
after index sha: 602a3ed1f45e0f11cb28fc0b30900019cb7bddb9af6fbfb13b1f265f55cb9fcb
mgmt marker present: 1
home marker present: 0
added modules removed: home-paths=YES registry-lock=YES
✗ patch is NOT applied (plugin 0.10.3)
check_after_revert_exit=1 (expect 1)
```

逐项判定：

| 回滚要求 | 实测 | 判定 |
|---|---|---|
| 还原到**打本补丁之前**的状态，而不是裸上游 | index sha 回到 `602a3ed1…`（= 管理认证补丁态），**不是** `7f9f38f3…`（裸上游） | **PASS** |
| 不破坏其它已应用补丁 | 管理认证标记仍存在（计数 1） | **PASS** |
| 本补丁痕迹清除 | home 标记计数 0 | **PASS** |
| 新增模块移除 | `home-paths.mjs`、`registry-lock.js` 均已删除 | **PASS** |
| 状态可自检 | `--check` 由 0 翻转为 1，并给出重新应用命令 | **PASS** |

### 5.1 回滚操作手册

```bash
# 1) 先停掉使用该插件的 DSH 实例（补丁在进程启动时加载）
# 2) 自检当前状态
node patches/mobile-gateway-home-isolation/apply.mjs --check --path=<插件根>
# 3) 回滚
node patches/mobile-gateway-home-isolation/apply.mjs --revert --path=<插件根>
# 4) 确认已回到未打补丁态（期望 exit 1）
node patches/mobile-gateway-home-isolation/apply.mjs --check --path=<插件根>
# 5) 重启 DSH 实例
```

仓库侧回滚（测试分支，不影响 main）：`git revert c4c067b`，
或直接丢弃分支 `opt/p4-0-security`。两者都不触碰正式安装。

### 5.2 回滚的已知限制（如实记录，不掩盖）

1. **`--revert` 不检查是否有实例正在运行。** 它只还原 `lib/` 文件。
   运行中的进程仍持有旧代码与旧锁，必须**先停实例再回滚再重启**，否则会出现
   「文件已回滚但进程仍在写注册表」的窗口。手册第 1 步已写明，但工具本身未强制。
2. **`--revert` 不清理遗留 `.lock` 文件。** 正常退出由 `process.on('exit')` 清理；
   若进程被强杀（`SIGKILL`/断电）留下陈旧锁，回滚后该文件仍在。
   由于回滚后的代码不再读锁，它只是一个无害残留；重新应用补丁时，
   陈旧锁会按 pid 存活探测自动回收，锁错误信息也会明确提示
   `remove <path>.lock and retry`。**未做自动删除**，因为删锁属于破坏性操作，
   在无法确认所有者已死时不应由工具擅自执行。
3. **回滚即恢复 D-3 漏洞。** 回滚后网关回到「只认 `os.homedir()`、多实例共享注册表」的行为。
   这是预期的（回滚的定义就是撤销修复），但意味着**回滚不是安全中性的操作**，
   只在补丁本身引发故障时使用，且应同时恢复 `deviceFile` 显式 pin 作为补偿控制。
4. **本轮未对正式 DSH 应用补丁，因此正式环境无需回滚。** 演练对象是隔离副本。

---

## 6. 正式数据与凭据未被触碰（最终复核）

基线：`logs/formal-registry-baseline.txt`（2026-11-11T16:34:12Z，只读采集）。
最终复核（本文撰写时）：

| 文件 | 基线 SHA-256 | 当前 SHA-256 | mtime | size |
|---|---|---|---|---|
| `~/.dsh/mobile-gateway-devices.json` | `42be3514…91883c9` | `42be3514…91883c9` **相同** | `2026-11-06 02:25:34.327446500 +0800` **未变** | 11612 **未变** |
| `~/.dsh/mobile-gateway-devices.json.gateway.json` | `a7af15b6…3daea9170` | `a7af15b6…3daea9170` **相同** | `2026-10-21 02:52:31.904722300 +0800` **未变** | 90 **未变** |
| `~/.dsh/mobile-gateway-devices.json.cloudflare.json` | ABSENT | ABSENT | — | — |
| `~/.dsh/*.lock` | 0 个 | **0 个** | — | — |

不仅哈希一致，**mtime 与 size 也一致** —— 排除「写入后又写回相同内容」的可能。
正式 `gatewayId` `99921c7e-74b7-4845-91ec-8d600675b55f` 未出现在任何测试产物中。
所有测试设备与令牌均为虚构（见 `02`）。

**未自动迁移、复制或删除任何已有设备凭据**：修复只改变「新实例去哪里找注册表」，
不含任何数据搬迁逻辑；隔离首启 `devices=0`，不继承正式注册表（`D3-real-dsh-verification.txt`）。

---

## 7. 局域网绑定清理（章程首项要求）

| 阶段 | 证据 | 结论 |
|---|---|---|
| 清理前 | `logs/lan-before.txt` | 隔离 profile `p3e2e` 的 `lanHost`/`lanAdvertiseHost` 指向局域网地址，存在对外暴露 |
| 清理动作 | `logs/p3e2e-cordis.patch.yml.bak`（原文件备份） | 两个字段改为 `127.0.0.1`；`deviceFile`/`gatewayStateFile` 的显式 pin **保留** |
| 清理后 | `logs/lan-after.txt` | **实际监听地址**复核为 `127.0.0.1`，非 `0.0.0.0`、非局域网 IP |
| 新建隔离 profile | `dsh-home/profiles/p40iso` | `lanHost 127.0.0.1`、`lanPort 3983`、web `3997`；**无 deviceFile pin**（用于验证 DSH_HOME 默认解析） |

清理只针对**上一轮测试留下的隔离服务**，未改动正式 DSH 的任何网络配置。

---

## 8. 结论

- 改动范围：**11 个代码/测试文件 +1650/−1**，其中对既有文件的唯一修改是往测试链里加一个套件。
- 上游修复净生产改动 **lib 5 文件 +259/−3**，可维护、可提交上游。
- 补丁具备**可重复应用（G1）、版本校验（G2）、摘要校验（G3/G4）、失败关闭（G3/G4）、
  逐字节回滚（G5）、真实包等效（G6）、与既有补丁可组合且回滚不伤及其它补丁（G7）**。
- 回滚已在**真实隔离插件副本**上演练成功，且回滚目标正确（管理认证态，而非裸上游）。
- **main 未动、无新 Tag、无 Release、正式注册表与凭据逐字节未变、局域网绑定已收回 127.0.0.1。**
- 如实记录 4 项回滚限制（§5.2），其中「回滚即恢复漏洞」需要运营侧知晓。