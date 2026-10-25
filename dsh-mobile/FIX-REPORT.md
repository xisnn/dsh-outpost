# DSH Outpost 安全与稳定性专项修复报告

- 仓库：`https://github.com/xisnn/dsh-outpost`
- 基线：`main` @ `5d34541`（v0.16.2），工作区干净、无未提交修改
- 本轮改动：**未提交、未推送、未打 tag**，等待审查
- 执行日期：2026-10-25

---

## 1. 原始问题核查

四条线索全部**实测确认存在**，另发现 2 个此前未记录的缺陷（见 1.5）。

### 1.1 P0-1 旧版明文凭据未完整迁移和清理 —— ✅ 确实存在

| 历史键 | 当前代码是否还引用 | 升级后会不会被清理 |
|---|---|---|
| `@dsh/cookie` | 仅剩常量定义（`App.tsx:49`） | ❌ 从不清 |
| `@dsh/gatewayToken` | 仅剩常量定义（`approvalGateway.ts:40`） | ❌ 从不清 |
| `@dsh/gatewayDeviceId` | 仅剩常量定义（`approvalGateway.ts:37`） | ❌ 从不清 |
| `@dsh/lastCookie` | 仅在 `clearAuthorization` 里删 | ⚠️ 只在「彻底清除授权」时删 |

**根因**：v0.16.0 把凭据搬进 Keychain 时，只改了**写入路径**，没有迁移逻辑。
老版本升级上来的用户，凭据仍躺在 AsyncStorage（明文 SQLite/SharedPreferences）。

**双重影响**：

1. **功能**：新版本只读 Keychain → 读不到 → 被踢回配对页，必须重新扫码。
2. **安全**：那份明文**永远不会被删**。只有用户主动点「退出并清除所有授权」
   才会顺手清掉 `lastCookie`，另外三个键一个都没清。

**`@dsh/lastCookie` 的语义问题**（任务特别点名）：旧版 `signOut` 会把当前 cookie
**复制**到 `lastCookie` 再删 `@dsh/cookie`，用于「退出后一键恢复」。问题在于它是
一份完整可用的明文认证凭据 —— 用户点了「断开连接」，它还在。这确实是一个
**退出登录后残留的认证入口**。

### 1.2 P0-2 设备撤销后可能自动重新配对 —— ✅ 确实存在，且是最严重的一条

`ApprovalGateway.connect()` 的逻辑是：

```
没有 token → 向服务端申请配对码 → 配对 → 拿到新 token
```

而 `requestPairingCode()` 用的是**仍然有效的会话 Cookie**。于是：

```
用户撤销授权 → 本地 token 被清 → 网关自动重连
            → 没有 token → 自动申请配对码 → 配对成功
            → 设备重新获得审批权限   ← 几秒内撤销被自己撤销掉
```

**关键点**：撤销审批权限**不影响 Cookie**（这是有意的设计 —— 聊天还要用），
所以「Cookie 有效」恰好成了绕过用户撤销决定的通道。

**附加缺陷**：`revokeOwnDevice()` 在列表请求失败时会拿客户端 id 直接去撤销，
服务端返回 404 → 被归类成 `already-gone`（「本来就没有」）→ **上层当成撤销成功**。
网络不通时用户看到「已清除」，实际服务端记录还在。

**竞态**：`ws.onclose` 回调不校验自己是不是当前连接，旧连接的迟到回调会
把新建连接的状态踩掉。

### 1.3 P1 设备列表错误状态 —— ✅ 确实存在

```typescript
// 修复前
async function listPairedDevices(...): Promise<PairedDevice[]> {
  try {
    if (res.status !== 200) return [];   // ← 错误返回空数组
    ...
  } catch {
    return [];                            // ← 网络失败也返回空数组
  }
}
```

设备管理页因此把「断网 / 401 / 500」全部渲染成 **「还没有设备配对过」**。
在一个「谁能批准电脑执行命令」的安全页面上，把「读不到」伪装成「没有」
是误导性的 —— 用户会以为设备记录被清空了。

### 1.4 P1 审批 WebSocket 异常恢复 —— ✅ 部分已修，但仍有严重缺陷

v0.16.0 已经把「连续失败 2 次就清 token」改成了「先探测服务端可达性」。
**但那个判据本身是错的**：

```typescript
const res = await fetch(`${base}/mgw/devices`, ...);
return res.status > 0;   // 任何 HTTP 响应都算「可达」
```

`/mgw/devices` 用 **Cookie** 鉴权，而失效的是**网关 device token**。
两者完全独立。所以：

- WS 握手 401（device token 失效）→ HTTP 探测 200（Cookie 正常）
  → 判定「服务端在拒我们」→ 清 token ✅ 这条碰巧对了
- **但反过来**：WS 不可达（防火墙拦 3081 / 代理不支持 Upgrade）、
  HTTP 正常 → 探测返回 200 → **判定「服务端在拒我们」→ 清掉有效 token** ❌

也就是说「HTTP 通但 WS 不通」这个场景仍会误删有效凭据。

**新发现的更严重缺陷（1.5-A）**：token 重连用的子协议是 `dsh-token.<token>`，
而真实插件只认 `dsh-auth.<token>`。

### 1.5 额外发现的两个缺陷（超出原始清单，已一并修复）

#### A. token 重连子协议前缀写错（Critical，功能全断）

| 位置 | 前缀 |
|---|---|
| 产品代码 `approvalGateway.ts` | `dsh-token.` ❌ |
| 插件 `lib/index.mjs` `extractCredential()` | `dsh-auth.` / `dsh-pair.` ✅ |
| 插件 `PROTOCOL.md` 第 90-91 行 | `dsh-auth.<token>` ✅ |
| 项目自己的 `docs/mobile-gateway.md` | `dsh-auth.<token>` ✅ |
| 项目自己的 `docs/security.md` | `dsh-auth.<token>` ✅ |
| 测试 `fake-dsh.mjs` | `dsh-token.` ❌（跟着产品代码一起错） |

**影响**：服务端认为「没带凭据」→ 401 → 客户端以为 token 失效 → 清 token 重新配对。
表现就是**每次断线都掉审批权限**，并且每次重连都要重新配对。

**为什么一直没被发现**：模拟服务端 `fake-dsh.mjs` 也用了 `dsh-token.`，
所以产品代码和测试「互相印证」了一个真实服务端不认的协议。
这是「用模拟服务端测协议」的典型陷阱。

#### B. `connect()` 并发无保护

`connect()` 里有一串 `await`（读 deviceId / 读 token / 查撤销标记 / 申请配对码），
期间 `this.ws` 还是空的。两个并发调用都会通过「没连接」检查，各建一条 WS。
服务端会看到两条「同一台设备」的连接，撤销时只踢掉一条。

---

### 1.6 独立安全复核（第二轮）发现的问题

第一轮修复完成后做了一次**独立只读复核**，又找出 2 个 Critical + 若干 Major。
全部已修复，见第 2.6 节。复核同时确认了三个方向**没有缺陷**：
代次（generation）机制下的旧连接回调竞态、网络失败误删 token、凭据泄漏到日志/UI。

| 编号 | 问题 | 严重度 |
|---|---|---|
| C1 | **「清除所有授权」漏了原生 cookie 容器** —— 第三个凭据存储 | Critical |
| C2 | `approvalRevoked` 是 UI 镜像，4003 路径不同步 → 两个事实来源 | Critical |
| M1 | 撤销标记**读失败**被缓存成「未撤销」，钉死整个进程 | Major |
| M2 | `clearApprovalRevoked` 先清缓存再删存储 → 删失败时当前进程直接放行 | Major |
| M3 | 4003 异步清理与 `clearAuthorization` 抢 deviceId → 服务端撤销被静默跳过 | Major |
| M4 | `disconnect()` 不放开 `connecting` → `reauthorize()` **静默什么都不做** | Major |
| M5 | `reauthorizeApprovals` 忽略传入的 baseUrl | Minor |
| M6 | 明文清理失败不可见 | Major |
| M7 | `devices:null` 当成服务端错误；200+坏响应体被当成撤销成功 | Major |
| m2 | `fromLastCookie` 算出来却没用 → 旧版点过「断开连接」的用户被自动登录 | Minor→安全 |
| m7 | `isCredentialRejection` 认裸 `forbidden` → 代理 403 误清有效 token | Minor |

---

## 2. 实际修复内容

### 2.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/core/credentialMigration.ts` | 旧版明文凭据的一次性迁移 + 全量清理 |
| `src/core/deviceRevocation.ts` | 持久化「审批授权已撤销」标记，阻止自动重新配对 |

### 2.2 P0-1：凭据迁移与清理

**`credentialMigration.ts` 的核心约束**（顺序不可变）：

```
① 先写安全存储
② 回读校验写入成功
③ 才删明文
```

1. **安全存储不可用 → 直接判失败，绝不降级**
   `isSecureStorageAvailable()` 先探一次；不可用就返回 `failed`，
   明文原样保留等下次启动重试。**不拿明文值去登录**（那就是静默降级）。
2. **不覆盖安全存储里已有的值** —— 那可能比明文副本新（用户升级后重新配对过）。
3. **幂等** —— 迁移成功后旧键已删，再跑什么都不做。
4. **`lastCookie` 语义明确化**：
   - `@dsh/cookie` 存在 → 用它（当前登录态），`lastCookie` 直接删
   - 只有 `lastCookie` → 迁进 Keychain，但标记 `fromLastCookie=true`，
     **不自动登录**，只提供「直接继续」入口
   - 迁移失败时**保留** `lastCookie`（那是用户仅剩的凭据副本，
     删掉等于让他彻底丢失登录态），下次启动重试
5. **报告只含键名，不含任何值** —— 专门加了测试断言。

**`App.tsx` 启动流程**：`migrateLegacyCredentials()` → 失败则显示
`secureStorageError`（「我的」页顶部红色警告条）。

**`clearAuthorization()`**：现在调用 `clearAllCredentials()` +
`clearLegacyCredentialStorage()` —— **两个存储都不留**。

### 2.3 P0-2：撤销后不得自动重新授权

**`deviceRevocation.ts`**：一个持久化标记（AsyncStorage，不是秘密）。

```
置位：用户撤销自己 / 服务端 4003 踢掉 / 彻底清除授权
清除：用户扫码配对 / 用户点「重新授权审批」   ← 只有这两种
```

网络恢复、重连、切前后台**都不会**清它。

**`ApprovalGateway.connect()`** 在申请配对码之前先查这个标记：

```typescript
if (!pairingCode && (await isApprovalRevoked())) {
  this.events.onStatus?.('revoked', '审批授权已撤销，需要重新授权');
  return;   // 绝不自动配对
}
```

**`4003` 语义**：插件撤销设备时 `client.close(4003, 'device revoked')`。
这是唯一能确定「授权被作废」的强信号 —— 收到就置撤销标记、清凭据、**不重连**。

**撤销其他设备**：只走服务端 `revokeDevice()`，完全不碰本地状态，
当前连接不受影响（有测试覆盖）。

**服务端失败 vs 本地清理**：`revokeOwnApproval()` 返回
`{ serverOk, localOk }` 两个独立结果，UI 分别提示。服务端撤销失败时
**绝不提示「撤销成功」**，但本地仍会停止自动连接（否则用户无法自救）。

**`store.ts`**：`gatewayStatus` 增加 `'revoked'`，并区分
「断开连接」（不改授权状态）和「撤销授权」。

### 2.4 P1：设备列表状态

`listPairedDevices()` 返回判别联合，**不再用空数组表示失败**：

```typescript
type DeviceListResult =
  | { ok: true; devices: PairedDevice[] }          // success / empty
  | { ok: false; kind: 'network' | 'unauthorized' | 'server'; status?; message }
```

`DevicesScreen` 状态机：

| 状态 | 界面 |
|---|---|
| `loading` | 转圈 |
| `ready` + 空数组 | 「还没有设备配对过」（只有真·空才显示） |
| `ready` + 数据 | 列表 |
| `error` + 无历史数据 | 整页错误 + 「重新加载」按钮 |
| `error` + 有历史数据 | **顶部错误条 + 保留旧列表** |

错误**不清空**最后一次成功的数据（`lastGood`）。三种错误分开提示文案和下一步。

**`revokeOwnDevice()` 修正**：列表请求失败时返回 `failed`，
不再退回「拿客户端 id 直接撤」→ 不会再把 404 误判成 `already-gone`。

### 2.5 P1：WebSocket 异常恢复

**判据换成「服务端明确拒绝」**（`isCredentialRejection()`）：

```typescript
// 只认这些：
/(^|[^0-9])(401|403)([^0-9]|$)/        // 401/403，前后不能紧邻数字
/unauthorized|forbidden|invalid device credential|invalid or expired token/i

// 明确不算：timeout / ECONNREFUSED / 1006 / Network request failed / ...
```

**失败次数彻底退出决策** —— `consecutiveFailures` 降级为纯诊断字段
（注释里写明「只用于状态提示，绝不用于判定 token 失效」）。

其他改动：

| 要求 | 实现 |
|---|---|
| 旧连接不得影响新连接 | `generation` 代次 + `isCurrent()` 校验所有回调 |
| 切前后台不重复建连 | `connect()` 入口去重 + `connecting` 在途标记 |
| 不允许无限申请配对码 | `MAX_PAIRING_ATTEMPTS = 3`，超限后转入 60 秒冷却慢速重试 |
| 断网恢复后自动重连 | 指数退避 1→2→4→8→16→30 秒封顶 |
| 撤销后不自动恢复 | 4003 直接 return，不 `scheduleRetry()` |
| 不动 Cookie | 撤销只清 gateway token + device id |

### 2.6 第二轮：独立复核发现的缺陷

#### C1. 原生 cookie 容器 —— 第三个凭据存储（新增 `src/core/cookieJar.ts`）

登录流程是「`credentials: 'include'` → RN 原生层自动保存 Set-Cookie →
CookieManager 读回来」。所以 `dsh-auth-*` 同时存在于**三个**地方：

| # | 存储 | 之前「清除授权」清了吗 |
|---|---|---|
| 1 | Keystore（`CredentialKey.cookie`） | ✅ |
| 2 | AsyncStorage 明文副本 | ✅（本轮第一轮修的） |
| 3 | **RN 原生 cookie 容器** | ❌ **漏了** |

后果很具体：用户点「退出并清除所有授权」（界面文案是「如果要把手机给别人用、
或者怀疑凭据泄露，选这个」）→ Keystore 清了、界面退回配对页 → 但原生容器里
还有一份可用 cookie → 下次启动 `readCookieFromJar()` 读回来 → 任何带
`credentials: 'include'` 的请求（含 `POST /mgw/pair`）仍以老用户身份通过鉴权。

**修复**：`clearNativeCookieJar(baseUrl)` 三步走：

1. `clearByName` 按名字精准清 `dsh-auth*`
2. `clearAll` 兜底（部分平台对 HttpOnly cookie 的 clearByName 不生效）
3. **再 `getAll` 复核一次** —— 只信「读不到」，不信 API 返回值

返回值是布尔：清不掉时 `clearAuthorization` 会弹
「本机可能还有残留」，**不再静默失败**。

#### C2. 撤销状态的两个事实来源

`approvalRevoked` 是 React state，而 4003（服务端撤销）在网关内部直接置
`store.gatewayStatus = 'revoked'`，**不会**回来更新 React state。于是：

- 「我的」页审批通道显示「已撤销授权」
- 但「重新授权审批」入口不出现（它看的是 React state）

**修复**：`store` 成为唯一事实来源。App 订阅 store 并镜像到 React state；
启动时用 `store.syncRevokedState()` 把持久化标记灌进 store。

#### M1. 读失败不能缓存

`cached = NOT_REVOKED` 是模块级单例，只由测试函数清空 —— 一次瞬时 IO 失败
就把「未撤销」钉死在整个进程生命周期。用户主动撤销且服务端撤销失败时，
**本地标记是唯一屏障**，丢了就是自动重新配对。

**修复**：读失败**不进缓存**，下次重新读。同时收紧解析：只有明确的
`revoked: true` 才算撤销（之前任何能 JSON.parse 成对象的值都算）。

#### M2. 清除撤销标记的顺序

之前先 `cached = NOT_REVOKED` 再删存储，删失败时注释说「下次启动仍然禁止
自动配对」—— 那句话对下次启动成立，对**当前进程**恰好相反。

**修复**：存储删成功才清缓存，返回 `boolean`；失败时 UI 明确告知
「重新授权没生效」，而不是假装成功。

#### M3. deviceId 竞态

4003 会异步 `markApprovalRevoked()`，它原来会清 `gatewayDeviceId`。
如果它抢在 `clearAuthorization` 读取之前落地 → 读到 `undefined` →
`if (cookie && deviceId)` 为假 → **服务端撤销被静默跳过**，且
`revokeFailed` 保持 false，用户连提示都看不到。

**修复**：
- `markApprovalRevoked` **不再清 deviceId**（它不是秘密；而且重新配对时
  服务端靠 clientDeviceId 复用记录）
- `clearAuthorization` **先把凭据读进局部变量**，再停网关

#### M4. `disconnect()` 不放开 `connecting`

`reauthorize()` = `disconnect()` + `connect()`。如果此刻正卡在 `connect()`
的 `await` 里，`connecting` 仍为 true → 新 `connect()` 命中
`if (this.connecting) return` → **静默什么都不做**。用户点了「重新授权」，
撤销标记已清，但永远连不上，必须重开 App。

**修复**：`disconnect()` 立刻放开 `connecting`；同时引入 `connectOwner`
代次，`finally` 只清自己那一代，避免旧 connect 醒来时清掉新 connect 的标记。

#### 其余

| 编号 | 修复 |
|---|---|
| M5 | `reauthorizeApprovals` 检测 baseUrl 变化则重建网关实例 |
| M6 | 明文清理失败 → `notifyLocalCleanupIncomplete()` 明确提示 |
| M7 | `devices:null` 当空列表；200+坏响应体**不再**乐观当成撤销成功 |
| m2 | `fromLastCookie` 时**不自动登录**（旧版点过「断开连接」的用户） |
| m7 | `isCredentialRejection` 不再认裸 `forbidden`；403 需带鉴权上下文 |
| m6 | DevicesScreen 订阅 store，撤销提示不再延迟 |

---

## 3. 测试情况

### 3.1 执行环境说明（重要）

本机 `npm test` **无法运行**，原因是环境限制而非代码问题：

```
TransformError: spawn EPERM
  at ensureServiceIsRunning (node_modules/esbuild/lib/main.js:2272)
```

tsx 依赖 esbuild，esbuild 启动时会 `spawn` 子进程，当前受限沙箱拒绝该操作。

**解决办法**：用 Node 自带的 TypeScript 类型剥离跑同一批测试，
并补上两个 tsx 会自动做、Node 不会做的事（见
`tests/support/node-ts-bootstrap.mjs`）：

- 目录 import / 无扩展名 import 解析
- ESM 里补 `require`（`secureStore.ts` 延迟加载 Keychain 用 `require`）

```bash
node --experimental-transform-types \
  --import ./tests/support/node-ts-bootstrap.mjs \
  tests/<spec>.mjs
```

⚠️ 这是**测试引导**，不改变产品代码。CI（Ubuntu + Node 20 + 正常 spawn）
跑 `npm test` 不受影响。

### 3.2 单元 / 静态测试：32 个 spec，554 项，全部通过

```
fold 37 · cwd 6 · pairing 12 · semver 8 · teammate 8 · fileref 19
archive 4 · approval 7 · deliverable 5 · notify 15 · bugfix 15
chaterror 10 · gesture 28 · image 23 · imgrender 9 · gwconnect 16
docview 30 · searchrename 24 · wsfilter 26 · netsec 39 · butler 32
compat 20 · creds 13 · migration 16 · revoke 9 · revocation 17
devices 14 · devicestate 24 · secreview 19 · runtime 11
approval-gateway 25 · recovery 13
```

**本轮新增 5 个 spec（88 项）**，全部驱动真实产品函数：

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `credential-migration-spec.mjs` | 16 | 全新安装 / 升级 / 共存 / 写入失败 / 幂等 / 退出后重启 / 彻底清除 / 不泄露 |
| `device-revocation-spec.mjs` | 17 | 撤销自己 / 保持打开 / 重启 / Cookie 仍有效 / 撤销别人 / 服务端失败 / 网络中断 / 手动重新授权 / 4003 |
| `device-list-state-spec.mjs` | 24 | success / empty / network / unauthorized / server / 超时 / 页面状态机 / `isSameDevice` |
| `gateway-recovery-spec.mjs` | 13 | 断网 30 秒 / 切网络 / 服务重启 / WS 不可用 / 401 自愈 / 主动断开 / 竞态 / 重复 connect / 配对码上限 |
| `security-review-fixes-spec.mjs` | 19 | **第二轮复核缺陷**：cookie 容器 / 读失败不缓存 / 清标记顺序 / connecting 死锁 / 代理 403 / devices:null / 200 坏响应体 / deviceId 竞态 |

`security-review-fixes-spec.mjs` 里有一个值得记录的坑：注入 AsyncStorage
失败必须替换 **CJS shim** 的方法，替换 ESM stub 不会影响产品代码
（两者共享存储但是不同对象）—— 和项目里既有的两个存储陷阱同源。

### 3.3 集成测试：5 个文件，61 项，全部通过

```
integration-transport 15 · integration-gateway 14
integration-long-session 10 · integration-product 16
integration-gateway-reconnect 6
```

### 3.4 类型检查 / Lint

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 通过，0 错误 |
| `npx eslint <本轮改动的 8 个文件>` | ✅ 0 错误 |
| `npx eslint src`（全量） | 16 错误 / 145 问题 |
| 全量基线（改动前，`git stash` 实测） | **21 错误 / 146 问题** |

全量 lint 的错误全部是**改动前就存在**的（未使用变量、hooks 依赖等），
本轮**没有新增任何 lint 错误**，且顺手减少了 5 个（`App.tsx` 的
`clearCredential` 未使用导入等）。

`npx prettier --check` 全项目本来就不通过（改动前实测所有文件都不符合格式），
属于既有状态，本轮未改变。

### 3.5 明确「未执行」的测试

| 项目 | 原因 |
|---|---|
| **Android 真机测试** | 当前环境无 Android 设备 / 模拟器 |
| **Android APK 构建** | 需要 Android SDK + NDK 27.1.12297006，本环境未配置 |
| **Windows 桌面助手联调** | 需要运行中的 DSH 实例 + 真机 |
| **`npm test` / `npm run test:integration` 原样命令** | esbuild `spawn EPERM`（见 3.1），已用等价跑法覆盖同一批测试 |
| **`npm run test:node20`** | 依赖 tsx，同上 |
| **`tests/e2e.mjs`** | 需要真实 DSH 服务 + 真实 token |

> ⚠️ 上表中「未执行」的项**没有**被声称通过。

---

## 4. 兼容性与风险

### 4.1 旧版本升级：会不会丢数据 / 要不要重新登录

| 场景 | 行为 |
|---|---|
| 全新安装 | 无历史键，迁移什么都不做（不碰安全存储） |
| 旧版升级（只有明文 `@dsh/cookie`） | ✅ **自动迁移，无需重新登录** |
| 旧版升级（只有 `lastCookie`，即旧版点过「断开连接」） | ✅ 迁移进 Keychain，但**不自动登录**，配对页出现「直接继续」 |
| 旧版升级（明文 + 安全存储都有） | ✅ 用安全存储的（更新），删掉明文副本 |
| 安全存储不可用（极少数设备） | ⚠️ **需要重新登录**。明文保留待重试，界面显示明确警告 —— 这是刻意的「安全失败」而非静默降级 |

**结论：正常情况下不需要重新登录，也不会丢数据。**

### 4.2 审批授权：升级后会不会被撤销

不会。撤销标记是**新增**的 AsyncStorage 键（`@dsh/approvalRevoked`），
升级后默认不存在 = 未撤销 = 行为与之前一致。

**但请注意**：修好 `dsh-auth.` 前缀后，之前「每次断线都掉审批权限」的
用户会发现审批通道**稳定多了**。已存的有效 token 现在能正常重连。

### 4.3 Android 身份与签名

- `applicationId "com.dshpocket"` —— **未改动**
- `signingConfig` / `versionCode` 逻辑 —— **未改动**
- `android/` 目录整体 —— **零改动**（`git diff --stat` 确认为空）
- `README.md` / `SECURITY.md` / `docs/` —— **零改动**
- 新增依赖 —— **无**（只用已有库）

### 4.4 剩余安全风险

| 风险 | 说明 | 状态 |
|---|---|---|
| 局域网明文 HTTP | DSH 服务端只提供 http；靠 `checkBaseUrlSecurity()` 应用层兜底 | 既有设计，未变 |
| 安全存储不可用时的失败模式 | 凭据留在明文存储等重试，期间用户无法登录 | **刻意取舍**（安全优先），有 UI 警告 |
| 撤销标记读失败 | 按「未撤销」处理（否则老用户会卡死），但**不再缓存**该结论，下次重读 | 已修复（M1） |
| 原生 cookie 清不掉 | `clearAll` 在极少数机型可能失败 | 已复核 + 明确提示，不再静默 |
| 服务端撤销失败 | 本地会停连，但电脑上仍留一条记录 —— 用 Alert 明确告知并引导去电脑上手动移除 | 已如实告知 |
| 设备名在服务端注册表 | 插件用 `X-DSH-Device-Name` 存设备名，本项目未发送（设备显示为「未命名设备」） | 未改动（非本轮范围） |
| **未做真机验证** | cookie 容器的 `clearAll/clearByName` 行为在不同 ROM 上可能有差异 | 🔴 **必须真机验证**（见 5.1 第 5 步） |

---

## 5. 人工验收清单

### 5.1 升级路径（最重要，请在真机上做）

前置：装一个 **v0.15.x 或更早** 的 APK，完成配对并登录。

- [ ] 1. 覆盖安装本轮修复的 APK（不要卸载）
- [ ] 2. 打开 App → **应该直接进主界面，不需要重新扫码**
- [ ] 3. 进「我的 → 连接状态」→ 显示「正常」
- [ ] 4. 进「我的 → 审批通道」→ 应能连上（或短暂连接中后变「已连通」）
- [ ] 5. **验证明文已清除**（关键）：
      ```bash
      adb shell run-as com.dshpocket ls -la databases/ shared_prefs/
      adb shell run-as com.dshpocket cat shared_prefs/RCTAsyncLocalStorage*.xml
      ```
      确认输出里**没有** `@dsh/cookie`、`@dsh/gatewayToken`、
      `@dsh/gatewayDeviceId`、`@dsh/lastCookie` 这几个键。

### 5.2 撤销当前设备（P0 核心）

- [ ] 1. 手机和电脑都联网，App 进「我的 → 设备管理」，能看到「这台手机」
- [ ] 2. 点「这台手机」的「撤销授权」→ 确认
- [ ] 3. **立刻观察**：审批通道变成「已撤销授权」
- [ ] 4. **在电脑上看** `curl http://<你的IP>:3095/mgw/devices`
      → 这台手机**不应该**再出现
- [ ] 5. **等 2 分钟**（让自动重连跑几轮），再 `curl` 一次
      → **仍然不出现**（这是原 bug 的核心，务必确认）
- [ ] 6. 杀掉 App 重开 → 「审批通道」仍显示「已撤销授权」，
      `curl` 里仍然没有这台手机
- [ ] 7. 此时聊天功能**仍然正常**（Cookie 没被清）
- [ ] 8. 进「我的」→ 点「重新授权审批」→ 确认
      → 审批通道恢复「已连通」，`curl` 里重新出现

### 5.3 撤销其他设备

- [ ] 1. 准备两台手机，都配对到同一台电脑
- [ ] 2. 在 A 上撤销 B
- [ ] 3. A 的审批通道**不受影响**（仍「已连通」）
- [ ] 4. B 的审批通道变成「已撤销授权」

### 5.4 设备列表错误态

- [ ] 1. 进「设备管理」，正常加载出列表
- [ ] 2. **关掉电脑上的 DSH 服务**（或手机开飞行模式）
- [ ] 3. 下拉刷新 → **应显示「连不上电脑 · 下面是上次读到的结果」+ 列表仍在**，
      而**不是**「还没有设备配对过」
- [ ] 4. 点「重试」→ 仍然报错（正常）
- [ ] 5. 恢复网络 → 点「重试」→ 列表正常

### 5.5 WebSocket 异常恢复

- [ ] 1. 审批通道「已连通」
- [ ] 2. **手机开关一次飞行模式（保持 30 秒再恢复）**
      → 恢复后审批通道应自动回到「已连通」，**不需要重新扫码**
- [ ] 3. **重启电脑上的 DSH 服务**
      → 手机端自动重连回「已连通」
- [ ] 4. **手机从 Wi-Fi 切到移动网络**
      → 自动重连回「已连通」
- [ ] 5. **关掉电脑上的移动网关插件**（或在防火墙上拦掉 3081）
      → 审批通道显示「未连通」，但**「我的 → 设备管理」里设备仍在**
      （token 没被误删）
- [ ] 6. 恢复网关 → 审批通道自动恢复

### 5.6 清除所有授权（含 cookie 容器，第二轮新增）

- [ ] 1. 「我的 → 退出并清除所有授权」→ 确认
- [ ] 2. 用 5.1 第 5 步的 `adb` 命令检查 → **四个历史键全都不存在**
- [ ] 3. **验证原生 cookie 容器也清了**（关键，C1）：
      ```bash
      adb shell run-as com.dshpocket ls -la app_webview/Cookies databases/
      # 或者直接在电脑上查服务端有没有收到新配对：
      curl http://<你的IP>:3095/mgw/devices
      ```
      重开 App 后应该停在配对页，且**不应该**出现「直接继续」以外的任何自动登录。
- [ ] 4. 重开 App → 停在配对页，没有「直接继续」入口
- [ ] 5. **如果界面弹出「本机可能还有残留」** → 说明 cookie 容器清不掉，
      记录机型 + Android 版本，这是需要跟进的兼容性问题

### 5.7 服务端撤销失败

- [ ] 1. 手机开飞行模式
- [ ] 2. 进「设备管理」（此时会报「连不上电脑」）
- [ ] 3. 恢复网络后立刻断开电脑的 DSH，再点撤销
- [ ] 4. **应弹「撤销失败 · 电脑上的授权还在」**，
      而**不是**「撤销成功」（这是原有的虚假成功提示，本轮已修）

### 5.8 旧版「断开连接」用户不应被自动登录（m2，第二轮新增）

- [ ] 1. 装一个 v0.15.x APK，配对成功后点「断开连接」
- [ ] 2. 覆盖安装本轮 APK
- [ ] 3. **应该停在配对页**（显示「上次的配对还在 · 直接继续」），
      而**不是**直接进主界面
- [ ] 4. 点「直接继续」→ 能正常恢复登录

---

## 6. 最终结论

### 是否达到发布条件

**代码层面：达到可审查状态。建议审查 + 真机验收后发布。**

四条原始问题全部确认为真实缺陷并已修复。此外：

- 第一轮额外修复 2 个缺陷（`dsh-auth.` 前缀错误影响最大）
- 第二轮独立复核又修复 **2 个 Critical + 6 个 Major**，其中
  「清除授权漏掉原生 cookie 容器」是本轮发现的最严重安全漏洞

全部 **615 项**自动化测试通过（554 单元 + 61 集成），类型检查通过，
改动文件 0 lint 错误，无新增依赖，Android 身份/签名/升级路径零改动，
无敏感信息泄露。

### 仍然阻止「立即发布」的问题

| # | 问题 | 严重度 | 说明 |
|---|---|---|---|
| 1 | **未做 Android 真机验证** | 🔴 阻塞 | 第 5 节清单必须真机过一遍。新增的重点：**5.6（cookie 容器清理）** 和 **5.8（旧版断开连接用户不自动登录）** —— 这两项是第二轮修复的核心，模拟环境无法验证原生 CookieManager 的真实行为 |
| 2 | **未构建 APK** | 🔴 阻塞 | 本环境无 Android SDK/NDK，无法验证打包产物 |
| 3 | **`npm test` 原样命令未跑通** | 🟡 需 CI 确认 | 本机 esbuild `spawn EPERM`，已用等价跑法覆盖同一批测试；CI 上仍需实际跑一次 |
| 4 | 全量 lint 仍有 16 个既有错误 | 🟢 不阻塞 | 改动前就有 21 个，本轮净减少；CI 目前不跑 eslint |
| 5 | Prettier 全项目不通过 | 🟢 不阻塞 | 改动前就是如此，未纳入 CI |
| 6 | cookie 容器清理的 ROM 兼容性 | 🟡 需真机确认 | `clearAll`/`clearByName` 在少数 ROM 上可能不生效；已加复核 + 提示，但需真机验证覆盖面 |

### 建议的发布流程

1. **审查本轮 diff**（`git diff` + 3 个新源文件 + 5 个新测试）
2. 在真机上走一遍第 5 节清单，**重点 5.1、5.2、5.6、5.8**
3. 推 CI 跑 `npm test` + `npm run test:integration` 确认环境差异
4. 全绿后再决定版本号与 tag（本轮**未**改动版本号，保持 0.16.2）

---

## 附：改动文件清单

### 新增（11）

```
src/core/credentialMigration.ts          旧版明文凭据迁移与清理
src/core/deviceRevocation.ts             撤销标记（阻止自动重新配对）
src/core/cookieJar.ts                    原生 cookie 容器清理（第二轮 C1）
tests/credential-migration-spec.mjs      16 项
tests/device-revocation-spec.mjs         17 项
tests/device-list-state-spec.mjs         24 项
tests/gateway-recovery-spec.mjs          13 项
tests/security-review-fixes-spec.mjs     19 项（第二轮复核缺陷）
tests/support/node-ts-bootstrap.mjs      无 esbuild 跑测试的引导
tests/support/ts-resolve.mjs             扩展名/目录 import 解析
FIX-REPORT.md                            本报告
```

### 修改（16）

```
src/App.tsx                              启动迁移 + 撤销/重新授权 + cookie 容器清理
src/core/approvalGateway.ts              重写连接状态机（判据/代次/4003/dsh-auth/connecting）
src/core/deviceAuth.ts                   结果类型化 + 撤销语义修正 + isSameDevice
src/core/store.ts                        gatewayStatus 加 'revoked' + syncRevokedState
src/screens/DevicesScreen.tsx            三态状态机 + 保留旧数据 + 订阅 store
src/screens/ProfileScreen.tsx            撤销状态 + 重新授权入口 + 安全存储告警
package.json                             新增 4 个 test:* 脚本并接入 test
tests/README.md                          记录新测试层与无 esbuild 跑法
tests/approval-gateway-spec.mjs          断言跟随重构（dsh-auth、Keystore）
tests/credential-security-spec.mjs       断言跟随重构（迁移模块、新判据）
tests/device-manager-spec.mjs            断言跟随新返回类型
tests/device-revoke-spec.mjs             断言跟随新返回类型 + 切片放宽
tests/gateway-bugfix-spec.mjs            断言跟随重构
tests/gateway-connect-spec.mjs           断言跟随重构
tests/gateway-recovery-spec.mjs          403 判据跟随收紧
tests/integration-product.mjs            dsh-token → dsh-auth（协议修正）
tests/support/fake-dsh.mjs               dsh-token → dsh-auth + killAllWithCode
```
