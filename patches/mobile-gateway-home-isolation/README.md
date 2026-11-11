# DSH Mobile Gateway —— D-3 注册表隔离与单一持有者补丁

> 状态：**受控补丁（不是 fork）**。补丁内容在版本控制里，可重放、可校验、可回退。
> 对应问题：**D-3**「隔离实例读写正式设备注册表 + 多实例共享注册表导致吊销失效」。
> 上游修复分支：`fix/p4-0-device-file-isolation`，提交 `9d26cb9`（基于 0.10.3 / `9ce0b33`）。

---

## 1. 为什么需要这个补丁

### 1.1 默认路径忽略 `DSH_HOME`

上游 0.10.3 在 `apply()` 内**内联**解析设备注册表，只认 `os.homedir()`：

```js
// lib/index.mjs:2255（修复前）
const deviceFile = options.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json')
```

派生文件跟着它走：`gatewayStateFile` 默认 `${deviceFile}.gateway.json`（`:2265`），
`cloudflareStateFile` 默认 `${deviceFile}.cloudflare.json`（`:3182`）。
全插件 **0 处** `DSH_HOME` 引用，而 DSH 核心早有权威解析器 `@deepseek-ai/dsh-home-paths`。

后果（已用真实上游模块 + 虚构数据复现，见 `A3-RED-observations.txt`）：

| 现象 | 实测 |
|---|---|
| 隔离实例读正式注册表 | `deviceCount=2`，读到虚构正式设备名 |
| 隔离实例写正式注册表 | 真实配对认领后 `formalUnchangedAfterPair=false` |
| 共享 gatewayId | 隔离实例 gatewayId == 正式 gatewayId |
| `DSH_HOME` 目录 | 完全空，没有任何文件落地 |

**这不是本地补丁引入的**：安装包内 `lib/index.mjs.orig` 与安装版逐字一致。

### 1.2 只修 `DSH_HOME` 还不够

`lib/devices.js` 的注册表是「构造时 `load()` 读入内存 → 每次变更 `save()` 整表覆盖写回」：

```js
// devices.js:52-58（修复前）
const tmp = `${file}.${process.pid}.tmp`
fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, devices }, null, 2), ...)
fs.renameSync(tmp, file)
```

`authenticate()`（`:177`）**只查内存**。所以两个独立进程被显式配置成同一个 `deviceFile` 时：

- A 吊销设备 → B 内存里仍在 → **B 继续接受已吊销 Token**
- B 写回自己的陈旧快照 → **A 的 `lastSeenAt` 被回滚、已删除设备被复活**
- `gateway-state.mjs` 的 `setMode()` 用 rename → 磁盘 disabled 而 A 内存 persistent

这些都已实测复现（S7/S8/S9 的 RED 日志）。

---

## 2. 方案

### 2.1 A1：路径解析（`lib/home-paths.mjs`，新增）

优先级与 DSH 核心 `resolveDshHome` **逐条对齐**：

```
显式 deviceFile（非空字符串）  >  非空白 $DSH_HOME  >  ~/.dsh
```

- 空白 / 空串 `DSH_HOME` 视为未设 —— 绝不会把注册表解析到当前工作目录
- `DSH_HOME` 支持 `~` / `~/` / `~\` 展开（与核心一致）
- **显式 `deviceFile` 原样返回**，不做 resolve、不做 tilde 展开 —— 保持旧配置（含相对路径）的拼写与派生兄弟文件完全不变
- 不设置 `DSH_HOME` 时，解析结果与修复前**逐字节相同**（S2 断言）
- 派生文件自动跟随：只改 `deviceFile` 一处，`gatewayStateFile` / `cloudflareStateFile` 级联隔离（S5 断言）
- **不迁移、不复制、不删除任何已有设备凭据**；隔离实例首启为空表（`devices=0`）

自包含实现而非硬依赖核心包：插件也会被装在 Harness 树之外，那里解析不到 `@deepseek-ai/dsh-home-paths`。

### 2.2 A2：单一存活持有者（`lib/registry-lock.js`，新增）

**策略比较**（详见 `01_D3_ISOLATION_ROOT_CAUSE_AND_FIX.md`）：

| 策略 | 可证明安全 | 兼容成本 | 复杂度 | 结论 |
|---|---|---|---|---|
| **1. 同一路径禁止多个独立实例** | ✅ 只有一个写者 ⇒ 无覆盖、无陈旧吊销 | 低（合法多网关本就各用独立文件） | 低（一个锁模块） | ✅ **选用** |
| 2. 文件锁 + 并发版本校验 | 需合并逻辑正确才安全 | 中（要改文件格式/版本号） | 高 | ❌ |
| 3. 共享权威 + 读时重验吊销 | 只堵吊销，不堵快照回滚 | 中（每次认证读盘） | 中 | ❌ 不完整 |

实现要点：

- 锁文件 `<数据文件>.lock`，`fs.openSync(..., 'wx')` 原子创建（Windows / POSIX 通用）
- 记录 `{version, pid, token, label, file, createdAt}`
- **同进程可重入**（引用计数）—— 合法的「同一进程组件共享」与上游测试的顺序复用不被阻断
- **不同路径互不干扰** —— 合法多网关布局照常工作
- **陈旧锁回收**：持有者 pid 已消失则回收一次；`EPERM` 视为存活（失败关闭方向）
- **失败关闭**：锁文件不可读 / 格式非法 / 存活的外部持有者 → 抛错拒绝启动，绝不静默共享
- `dispose()` 释放；另注册 `process.on('exit')` 兜底，正常退出不留锁

生产改动量：`lib/index.mjs` +5/−1、`lib/devices.js` +15/−2、`lib/gateway-state.mjs` +4，
外加两个新模块。`save()` 的临时文件名加了随机后缀，避免同进程两个写者互相踩临时文件。

### 2.3 行为变更边界（**需要知会**）

第二个独立进程指向同一注册表时，**网关插件拒绝加载**（DSH web 仍可启动，但没有移动网关）。
这是有意的失败关闭：该配置正是不安全的那种。错误信息直接给出处置办法：

```
failed to lock gateway identity <path>: already owned by live process <pid>.
Two independent instances must not share one device registry: ...
Give each instance its own DSH_HOME or deviceFile.
If that process is gone, remove <path>.lock and retry.
```

单实例用户、以及各用独立 `deviceFile` 的多网关用户，**行为完全不变**。

---

## 3. 部署与维护

### 3.1 应用

```powershell
# 只检查状态（退出码 1 = 未打）
node patches/mobile-gateway-home-isolation/apply.mjs --check

# 应用（幂等、全有或全无）
node patches/mobile-gateway-home-isolation/apply.mjs --apply

# 指定隔离 profile，而不是正式 profile
node patches/mobile-gateway-home-isolation/apply.mjs --apply --path=E:\work\p4-0-security\dsh-home\profiles\p40iso\node_modules\dsh-plugin-mobile-gateway

# 重启该 DSH 实例后生效
```

默认目标是 `~/.dsh/profiles/web/node_modules/dsh-plugin-mobile-gateway`（**正式**）。
本轮**未对正式实例应用**；正式应用需单独批准。

### 3.2 校验与回退

```powershell
node patches/mobile-gateway-home-isolation/apply.mjs --check    # 1 = 未打 / 打后被改动
node patches/mobile-gateway-home-isolation/apply.mjs --revert   # 从专属备份还原
```

备份后缀是 **`.pre-home-isolation.orig`**，不是 `.orig`。
这一点很关键：mgmt-auth 补丁已经占用了 `.orig`，若共用备份名，`--revert` 会把文件还原成
**pristine**，从而**静默删掉管理接口认证**。专属后缀保证回滚只撤销本补丁。

### 3.3 与 mgmt-auth 补丁组合

`KNOWN_SOURCES` 为 0.10.3 登记了**两个已审阅变体**：

| 变体 | `lib/index.mjs` SHA-256 |
|---|---|
| `pristine` | `7f9f38f3…cb7413` |
| `mgmt-auth-patched` | `602a3ed1…5cb9fcb` |

两个补丁的锚点互不重叠，标记不同（`DSH_OUTPOST_MGW_AUTH_PATCH` / `DSH_OUTPOST_HOME_ISOLATION_PATCH`），
可先后应用。已实测：组合应用成功，回滚本补丁后 mgmt-auth 文件**逐字节不变**（门禁 G7）。

### 3.4 插件升级后怎么办

文本锚点 + 源文件 SHA-256 白名单双重保护：

- 版本不在白名单 → 拒绝，并打印当前各文件哈希
- 没有任一已审阅变体匹配 → 拒绝，逐文件列出期望/实际
- 锚点出现次数 ≠ 1 → 拒绝
- 已部分打补丁 → 拒绝，要求先 revert

**任何拒绝都不写盘**（先算完所有变换再落盘）。不会出现「悄悄退回隔离失效状态」而没人知道的情况 —— `--check` 会失败。

---

## 4. 已验证

### 4.1 上游源码测试（`test/home-isolation.test.mjs`，14 项）

RED（pristine 0.10.3）：7 失败 / 7 通过 → GREEN（修复后）：**14 通过 / 0 失败**。
通过的 7 项在 RED 阶段就通过，正是兼容性护栏（旧默认、空白 env、显式优先、损坏失败关闭、同进程复用）。

覆盖：DSH_HOME 隔离、无 DSH_HOME 旧行为、显式优先、空白 env、派生跟随、
gatewayId 不共享、跨进程吊销权威、跨进程并发不回滚、跨进程 mode 不分歧、
注册表损坏/不可读失败关闭、gateway 身份损坏失败关闭、跨进程独占 + 陈旧回收、同进程复用合法。

全部使用 `mkdtempSync` 虚构目录 + 子进程 `USERPROFILE` 指向虚构正式 home，
**真实 `~/.dsh` 全程不可达**；设备、Token、gatewayId 均为虚构。

### 4.2 补丁门禁（`scripts/validate-patch-gates.sh`）

G1 幂等 / G2 未知版本拒绝 / G3 指纹不符拒绝 / G4 锚点缺失拒绝 /
G5 精确回滚（逐字节）/ G7 与 mgmt-auth 组合且回滚不伤认证 —— **全部 PASS**。

### 4.3 仓库回归（`dsh-mobile/tests/mobile-gateway-home-isolation-spec.mjs`）

**55 项断言全通过**，已挂入 `npm test`（`test:mgwHomeIsolation`）。
覆盖锚点完整性、fail-closed、语法有效、解析器语义、锁语义、apply.mjs 门禁、组合与回滚。

### 4.4 真实 DSH 实例（隔离，非正式）

- 无 pin 的 `p40iso` profile + 独立 `DSH_HOME` → 启动日志 `devices=0`，
  注册表锁与 gateway 身份落在 `$DSH_HOME`，gatewayId 与正式不同
- **同一 `DSH_HOME` 启动第二个真实实例 → 网关插件失败关闭**，第一实例所有权与身份不变
- 正式注册表与 gateway 状态 SHA-256 全程与基线一致，正式目录**没有新增任何文件**

---

## 5. 残留风险

1. **同进程内两个独立注册表对象共用一个文件**仍会各自持有内存快照。
   锁是同进程可重入的（为了不阻断合法组件共享），所以这种用法不被拒绝。
   DSH 的模型是「一个 profile 一个进程一个插件实例」，生产中不可达；
   已在报告中标注为 STATIC_REVIEW 残留项。
2. **PID 复用**：崩溃后若 pid 被无关进程复用，锁会被判为「存活」而拒绝启动。
   方向是失败关闭（安全），错误信息给出处置办法。
3. **Windows 权限位**：`chmodSync(0o600)` 在 Windows 不设置 ACL，注册表继承父目录 ACL。
   这是上游既有行为，本补丁未改变；上游测试中 `0o600` 断言在 Windows 因此失败（见回归报告）。
4. 锁文件是数据目录里的**新增文件**（`*.lock`）。不含凭据，只含 pid/token/路径。