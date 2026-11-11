# 02 · D-3 多实例与隔离安全负向测试（RED → GREEN）

- 测试文件：上游 `test/home-isolation.test.mjs`（14 项）+ `test/helpers/isolation-child.mjs` + `test/helpers/registry-holder.mjs`
- 仓库回归：`dsh-mobile/tests/mobile-gateway-home-isolation-spec.mjs`（55 断言，已入 `npm test`）
- 补丁门禁：`scripts/validate-patch-gates.sh`（G1–G7）
- 原始日志：`logs/A3-RED-home-isolation.log`、`logs/A3-GREEN-home-isolation.log`、
  `logs/A3-GREEN-patched-package.log`、`logs/A3-RED-observations.txt`、`logs/patch-gates.log`、
  `logs/repo-home-isolation-spec.log`、`logs/D3-real-dsh-verification.txt`

**数据全部虚构**：设备名 `Fictional Phone A/B`、Token `fictional-token-AAAA…`、
gatewayId `11111111-2222-4333-8444-555555555555`。每个场景在独立子进程、独立 `mkdtempSync` 目录，
`USERPROFILE`/`HOME` 指向**虚构正式 home** ⇒ 真实 `~/.dsh` 全程不可达。
子进程仅 bind `127.0.0.1:0`，不发布任何服务。

---

## 1. RED（pristine 0.10.3）→ GREEN（修复后）

| # | 场景 | RED | GREEN | 守什么 |
|---|---|---|---|---|
| S1 | DSH_HOME 隔离：不继承正式设备、不写正式 | **FAIL** | PASS | 隔离首启空表；配对认领不写正式 |
| S2 | 无 DSH_HOME 旧行为逐字节兼容 | PASS | PASS | 老用户默认不变 |
| S3 | 显式 deviceFile 优先 | PASS | PASS | 显式配置始终优先 |
| S4 | 空白 DSH_HOME 视为未设 | PASS | PASS | 不产生异常/相对路径 |
| S5 | 派生 gateway/cloudflare 跟随隔离 | **FAIL** | PASS | 只 pin deviceFile 即级联隔离 |
| S6 | 两隔离实例 gatewayId 不共享 | **FAIL** | PASS | 安装身份独立 |
| S7 | 吊销后旧 Token 不在另一实例生效 | **FAIL** | PASS | 跨进程吊销权威 |
| S8 | 并发写不静默回滚 | **FAIL** | PASS | 跨进程单一写者 |
| S9 | gateway mode 磁盘/内存不分歧 | **FAIL** | PASS | 跨进程身份独占 |
| S10 | 注册表损坏失败关闭且不覆盖 | PASS | PASS | 损坏不静默重置 |
| S11 | 注册表位置不可读失败关闭 | PASS | PASS | 权限/形状异常安全失败 |
| S12 | gateway 身份损坏失败关闭且保留 | PASS | PASS | 身份不被替换 |
| S13 | 跨进程独占 + 不同路径不阻断 + 陈旧回收 | **FAIL** | PASS | 独占不误伤合法用法 |
| S14 | 同进程顺序复用同一身份文件合法 | PASS | PASS | 不阻断合法组件共享 |

RED：**7 FAIL / 7 PASS**；GREEN：**14 PASS / 0 FAIL**。
RED 阶段即通过的 7 项正是**兼容性护栏**——修复不得破坏它们，GREEN 全部保持。

### 1.1 RED 关键观测（`A3-RED-observations.txt`）

S1（设 DSH_HOME，pristine）：

```
gatewayId = 11111111-2222-4333-8444-555555555555   ← 与虚构正式相同（共享身份）
deviceCount = 2, deviceNames = [Fictional Phone A, Fictional Phone B]  ← 读到正式设备
claimed = true, formalUnchangedAfterPair = false   ← 真实认领写改了正式注册表
isolatedTree = []                                  ← DSH_HOME 目录全空
```

S7/S8/S9 的 RED 分别复现：吊销后 B 仍接受旧 Token、B 的陈旧快照回滚 A 的 lastSeenAt/复活已删设备、
磁盘 disabled 而 A 内存 persistent。

### 1.2 GREEN 的跨进程证明方式

S7/S8/S9/S13 用**两个真实进程**：持有者进程打开注册表/身份并保持存活，
第二进程尝试打开同一路径 → 必须 `REFUSED … already owned by live process <pid>`；
不同路径 → `ACQUIRED`；持有者退出后 → 陈旧锁回收 `ACQUIRED`。
S7 另断言持有者吊销后自身拒绝旧 Token、磁盘行数归零、被拒进程**从未到达凭据校验**。

---

## 2. 安装态补丁包等价性

对 pristine 副本应用受控补丁后跑同一 14 项测试：**14 PASS / 0 FAIL**
（`A3-GREEN-patched-package.log`）⇒ 本地补丁与上游源码修复**行为等价**。

## 3. 补丁门禁（G1–G7，全部 PASS）

| 门禁 | 内容 | 结果 |
|---|---|---|
| G1 | 幂等（重复 apply 不叠加，5 文件哈希不变） | PASS |
| G2 | 未知版本拒绝且不写盘 | PASS |
| G3 | 指纹不符拒绝且不写盘 | PASS |
| G4 | 锚点缺失拒绝 | PASS |
| G5 | 回滚逐字节还原 + 移除新增模块 + check 报未打 | PASS |
| G7 | 与 mgmt-auth 组合；回滚本补丁后 mgmt-auth **逐字节存活** | PASS |

## 4. 真实 DSH 实例（隔离）

见 `D3-real-dsh-verification.txt` 与 01 §6：无 pin 的 `p40iso` 启动 `devices=0`、
锁/身份落 `DSH_HOME`、gatewayId 与正式不同；**同 DSH_HOME 第二真实实例网关失败关闭**；
正式注册表/身份 SHA-256 与基线一致、正式目录无新增文件。

## 5. 不读写正式目录的证明

- 所有单元测试子进程 `USERPROFILE`/`HOME` = 虚构 home；`os.homedir()` 断言等于虚构 home。
- 每轮测试前后比对正式 `mobile-gateway-devices.json` / `.gateway.json` SHA-256：
  `42be3514…883c9` / `a7af15b6…9170`，**全程不变**。
- 正式目录 `*.lock` 计数 0。
- 补丁门禁/仓库规格只在 `mkdtempSync` 副本上操作。

## 6. 残留（如实标注）

同进程内两个独立注册表对象共用一文件仍各持快照（锁同进程可重入，为不阻断合法共享）；
DSH「一 profile 一进程一实例」模型下生产不可达。PID 复用、Windows ACL 见 01 §7。