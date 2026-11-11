# 01 · D-3 网关注册表隔离：根因、策略比较与修复

- 状态：**PASS（已实施生产修复，RED→GREEN，真实隔离 DSH 实例验证）**
- 证据级别：UNIT_TEST（虚构数据、真实上游模块）+ REAL_HOST_EMULATOR 无关；真实 DSH 进程级验证见 §6
- 修复载体：**上游源码修复**（可维护）+ **受控本地补丁**（可重放/校验/失败关闭/回滚）
- 本轮**未对正式 DSH 应用补丁**，未修改正式设备注册表

---

## 1. 基线核实（先复核证据，再动手）

上一轮 D-3 调查（`2026-11-11-p3-final-closure/04_D3_GATEWAY_ISOLATION_REVIEW.md`）的结论**全部复核成立**，
但本轮把证据强度从「三行逐表达式转录」提升到**真实上游源码**：

| 项 | 上一轮 | 本轮 |
|---|---|---|
| 生产模块来源 | `devices.js`/`gateway-state.mjs` 直接 import；`index.mjs:2255/2265/3220` 三行**转录** | 克隆上游仓库，定位与安装版**逐字节一致**的提交 `9ce0b33`（0.10.3），四个模块全部 MATCH |
| 默认路径断言 | 转录表达式 | 真实 `plugin.apply(ctx, config)` + 真实 HTTP `/mgw/status`、`/mgw/devices`、`/mgw/pair` + 真实 WS 认领 |
| 写可达证明 | `connected()`/`setMode()` | **真实配对码 → WS 子协议 `dsh-pair.<code>` 认领 → `claimPairing()` 落盘** |

上游基线校验（`logs/upstream-baseline.txt`）：

```
7f9f38f36183fa4621675d49de2f3c2456452c048bdc6a38412a7a2724cb7413  lib/index.mjs
633957558c0fb05fced1b73cfa8b76f7fdfb9bad8cb09fbd9f1af5d82bae3503  lib/devices.js
971fbc1052ee49a1585db7124c20f16b36dddfe4c49759e4a6c48ca13b553c75  lib/gateway-state.mjs
b0a66d8b9bf0c91c0cd0e14aed68719f1ba7d631a96ec577ae9f1b321e7c38f4  lib/cloudflare-tunnel.mjs
RESULT: all four MATCH -> fix is authored against real upstream 0.10.3 source
```

> 注：Windows checkout 默认 CRLF 会让哈希不符；已设 `core.autocrlf=false` 后逐字节一致。

---

## 2. 根因

### 2.1 A1 根因：默认路径只认 `os.homedir()`

`lib/index.mjs:2255`（修复前）：

```js
const deviceFile = options.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json')
```

派生文件跟着它走，所以**只改这一处即可级联隔离**：

- `:2265` `createGatewayState(options.gatewayStateFile || `${deviceFile}.gateway.json`)`
- `:3182` `createCloudflareTunnel({ file: options.cloudflareStateFile || `${deviceFile}.cloudflare.json`, ... })`

全插件 `DSH_HOME` 引用 **0 处**；`os.homedir()` 仅 2 处（另一处 `:974` 是目录浏览，与凭据无关）。
schema 默认空串：`:218`/`:230`/`:240`。

**上游缺陷，非本地补丁引入**：`lib/index.mjs.orig` 与安装版逐字一致，mgmt-auth 补丁注入点在 2704 行之后。

### 2.2 A2 根因：整表覆盖写回 + 只查内存的认证

`lib/devices.js`：

```js
// :52-58 save()：把内存里的整张表覆盖写回
const tmp = `${file}.${process.pid}.tmp`
fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, devices }, null, 2), { mode: 0o600 })
fs.renameSync(tmp, file)

// :177 authenticate()：只查内存，从不重读磁盘
const device = devices.find((candidate) => !candidate.revokedAt && safeEqualHex(candidate.tokenHash, tokenHash))
```

构造即 `load()`（`:98`）。因此两个独立进程共用一个 `deviceFile` 时：

| 危险 | 机制 |
|---|---|
| 吊销失效 | A `revoke()` 改内存+写盘；B 内存里该行仍在 → **B 继续接受已吊销 Token** |
| 状态回滚 | B `save()` 写回自己的陈旧快照 → A 的 `lastSeenAt` 被抹掉 |
| 设备复活 | B 的快照含已删除行 → 覆盖后该行重新出现在磁盘 |
| gatewayId 共享 | 同一 `.gateway.json` → 两实例同一安装身份 |
| mode 分歧 | `gateway-state.mjs` `setMode()` 用 rename → 磁盘 disabled 而 A 内存 persistent |
| 临时文件互踩 | `save()` 的 tmp 名只含 pid，**同进程**两个注册表对象会写同一个 tmp |

`gateway-state.mjs` 的首次创建已有 `linkSync` 保护（不覆盖并发创建的身份），但**后续 `setMode` 没有**。

---

## 3. A2 策略比较（按要求逐项评估）

| # | 策略 | 能否证明安全 | 兼容成本 | 实现复杂度 | 结论 |
|---|---|---|---|---|---|
| **1** | **同一路径禁止多个独立实例同时使用** | ✅ **可证明**：任一时刻只有一个写者 ⇒ 不存在快照互相覆盖，也不存在陈旧吊销视图 | **低**：合法多网关本来就各用独立 `deviceFile`（上游 `multi-gateway.test.mjs:26` 即 `${name}-devices.json`）；单实例用户完全无感 | **低**：一个锁模块 + 两处 acquire + dispose | ✅ **选用** |
| 2 | 文件锁 + 并发版本校验 | ⚠️ 只有合并逻辑本身正确才安全；需要引入 generation 字段并处理冲突合并 | 中：改文件格式/版本号，老文件需迁移 | 高：跨平台 flock 语义差异、部分写、冲突解决 | ❌ |
| 3 | 共享权威注册表 + 读时重验吊销 | ⚠️ **不完整**：堵住了吊销，但 `save()` 仍是整表覆盖 ⇒ `lastSeenAt` 回滚与设备复活依旧 | 中：每次认证读盘（性能与语义变化） | 中 | ❌ |

**选择理由**：策略 1 把「不安全配置」变成**启动期失败关闭**，而不是在运行期试图修补并发语义。
它的安全论证不依赖合并算法的正确性，只依赖「单一写者」这一可验证不变量。

### 3.1 如何不误阻断合法用法（关键约束）

| 用法 | 是否合法 | 处置 | 证据 |
|---|---|---|---|
| 同一进程内多个组件打开同一文件 | ✅ 合法 | **可重入**（引用计数），不拒绝 | S14；上游 `multi-gateway.test.mjs:105/108` 顺序复用同一 `statePath` 仍通过 |
| 同一进程内顺序复用（读回身份） | ✅ 合法 | 同上 | 同上 |
| 多网关各用独立 `deviceFile` | ✅ 合法 | 不同路径互不干扰 | S13「distinct file is never blocked」 |
| **两个独立进程共用一个文件** | ❌ 危险 | **失败关闭**，拒绝加载网关插件 | S7/S8/S9/S13；真实 DSH 第二实例被拒 |
| 持有者崩溃后遗留锁 | — | pid 已消失 → **回收一次** | S13「stale lock must be recovered」 |

锁实现要点（`lib/registry-lock.js`）：

- `fs.openSync(lockPath, 'wx')` 原子创建，Windows/POSIX 通用
- 记录 `{version, pid, token, label, file, createdAt}`；路径经父目录 `realpathSync` 规范化，避免同一文件的两种拼写绕过
- 同进程可重入；`dispose()` 释放；`process.on('exit')` 兜底
- **失败关闭**：锁不可读 / 格式非法 / 存活外部持有者 → 抛错，绝不静默共享
- `process.kill(pid, 0)` 判活；`EPERM` 视为**存活**（宁可拒绝，不可误共享）

### 3.2 行为变更边界（需知会，不属于「无法兼容」）

第二个独立进程指向同一注册表时，**网关插件拒绝加载**（DSH web 仍可启动，但没有移动网关）。
这正是任务列举的危险配置，失败关闭是安全正确的结果。错误信息直接给出处置办法。

**未擅自修改生产授权语义**：`requireAuth`、审批链、Token 生成/校验算法、配对 TTL、
`/mgw/*` 认证（mgmt-auth 补丁）**全部未改**。改动只涉及「路径解析」与「谁能打开这个文件」。

---

## 4. 实施的修复

### 4.1 上游源码（可维护，单一真源）

分支 `fix/p4-0-device-file-isolation`，提交 `9d26cb9`（基于 `9ce0b33` = 0.10.3）：

```
lib/devices.js                   |  15 +-
lib/gateway-state.mjs            |   4 +
lib/home-paths.mjs               |  49 +++++   (新增)
lib/index.mjs                    |   5 +-
lib/registry-lock.js             | 189 +++++   (新增)
package.json                     |   2 +-      (挂入新测试)
test/helpers/isolation-child.mjs | 268 +++++   (新增)
test/helpers/registry-holder.mjs |  96 ++++    (新增)
test/home-isolation.test.mjs     | 391 +++++   (新增)
```

生产代码净改动：**21 行插入 / 3 行删除**（三个既有文件）+ 两个新模块。

`lib/home-paths.mjs` 优先级与 DSH 核心 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome` 逐条对齐：

```
显式 deviceFile（非空字符串）  >  非空白 $DSH_HOME  >  ~/.dsh
```

- 空白/空串 `DSH_HOME` 视为未设（核心 `resolveRoot` 的 `fromEnv.trim().length > 0`）
- `~` / `~/` / `~\` 展开（核心 `expandHomePath`）
- **显式 `deviceFile` 原样返回**：不 resolve、不展开 tilde ⇒ 旧配置（含相对路径）拼写与派生兄弟文件完全不变
- 自包含而非硬依赖核心包：插件也会装在 Harness 树之外，那里解析不到核心包

`lib/devices.js` 另把 `save()` 的 tmp 名改为 `${file}.${pid}.${randomUUID()}.tmp`，
消除同进程两个写者互踩临时文件（与 `gateway-state.mjs` 既有做法一致）。

### 4.2 受控本地补丁（可部署到安装态插件）

`patches/mobile-gateway-home-isolation/`：`patch.mjs`（11 个唯一锚点）、`apply.mjs`、`files/`（两个新模块逐字副本）、`README.md`。

| 要求 | 实现 | 门禁 |
|---|---|---|
| 可重复应用 | 纯文本锚点变换，幂等 | G1 PASS |
| 版本校验 | `KNOWN_SOURCES` 版本 + 每文件 SHA-256；0.10.3 登记 `pristine` 与 `mgmt-auth-patched` **两个已审阅变体** | G2 PASS |
| 失败关闭 | 未知版本 / 指纹不符 / 锚点≠1 / 已部分打补丁 → 拒绝，**先算完所有变换再落盘**，任何拒绝都不写盘 | G3、G4 PASS |
| 回滚 | 专属备份后缀 **`.pre-home-isolation.orig`** | G5 PASS（逐字节还原） |
| 不破坏既有补丁 | 不共用 `.orig`（mgmt-auth 已占用），回滚只撤销本补丁 | G7 PASS（mgmt-auth 逐字节存活） |

> **`.orig` 共用是一个真实陷阱**：若沿用 `.orig`，`--revert` 会把文件还原成 pristine，
> 从而**静默删掉管理接口认证**。本轮改用专属后缀并加 G7 门禁守住这一点。

仓库回归：`dsh-mobile/tests/mobile-gateway-home-isolation-spec.mjs`，**55 项断言全通过**，
已挂入 `npm test`（`test:mgwHomeIsolation`，位于 `test:mgwPatch` 之后）。

---

## 5. 兼容性论证（老用户数据与配置）

| 场景 | 结论 | 断言 |
|---|---|---|
| 未设 `DSH_HOME` | 解析结果与修复前**逐字节相同** | S2；spec「no DSH_HOME reproduces the legacy default byte-for-byte」 |
| 显式 `deviceFile` | 原样优先，派生文件跟随 | S3 |
| 空白 `DSH_HOME` | 视为未设，不产生异常/相对路径 | S4；spec 三项 |
| 已有设备凭据 | **不迁移、不复制、不删除** | 代码中无任何迁移/复制逻辑；S1 断言正式文件字节不变 |
| 隔离实例首启 | **空表 `devices=0`**，不继承正式注册表 | S1；真实 DSH 日志 `devices=0` |
| 老格式注册表（v1/v2） | 既有迁移行为未改（`load()` 内 v1 明文→tokenHash） | 未触碰该分支 |
| 单实例正式用户 | 行为不变；数据目录新增 `*.lock`（不含凭据） | §7 残留项 |

---

## 6. 真实 DSH 实例验证（隔离，非正式）

profile `p40iso`，`DSH_HOME=E:\work\p4-0-security\dsh-home`，**故意不 pin 任何 deviceFile/gatewayStateFile**，
回环 127.0.0.1:3997（web）/ 3983（gateway）。证据：`logs/D3-real-dsh-verification.txt`。

| 断言 | 实测 |
|---|---|
| 隔离实例不继承正式设备 | 启动日志 `devices=0`（修复前同一配置会读到正式 35 台） |
| 注册表锁落在 `DSH_HOME` | `$DSH_HOME/mobile-gateway-devices.json.lock`，`pid=14496` |
| gateway 身份落在 `DSH_HOME` | `$DSH_HOME/mobile-gateway-devices.json.gateway.json` |
| gatewayId 与正式不同 | 隔离 `8eaecbeb-3541-476e-b942-c5a5b772be93` vs 正式 `99921c7e-74b7-4845-91ec-8d600675b55f` |
| **第二个真实实例共用同一 DSH_HOME** | **网关插件失败关闭**：`failed to lock gateway identity … already owned by live process 14496` |
| 第一实例不受影响 | 锁仍属 14496，gatewayId 不变，3997/3983 仍在监听 |
| 正式注册表完整性 | devices 与 gateway 状态 SHA-256 **与基线一致** |
| 正式目录无新增文件 | `~/.dsh/*.lock` 计数 **0** |

第二实例的 web 端口仍监听，但**没有移动网关**⇒ 不存在共享凭据面。这是失败关闭的正确形态。

---

## 7. 残留风险（如实标注）

1. **同进程内两个独立注册表对象共用一个文件**仍各持内存快照。锁同进程可重入（为不阻断合法组件共享），
   故不拒绝这种用法。DSH 模型是「一 profile 一进程一插件实例」，生产中不可达。
   证据级别：STATIC_REVIEW + 已记录的 RED 观测（`registry-shared` / `registry-lastseen-rollback` 场景）。
2. **PID 复用**：崩溃后 pid 被无关进程复用 → 判为存活 → 拒绝启动。方向是失败关闭（安全），
   错误信息给出处置办法。未做进程创建时间校验（复杂度不划算）。
3. **Windows 权限位**：`chmodSync(0o600)` 在 Windows 不设 ACL，注册表继承父目录 ACL。
   上游既有行为，本补丁未改变；上游 3 个 `0o600` 断言因此在 Windows 失败（见 07 文档）。
4. **锁文件是数据目录新增文件**（`*.lock`），含 pid/token/路径，不含凭据。
5. **正式实例尚未应用补丁**：本轮只在隔离实例应用。正式应用需单独批准（见 09 文档）。