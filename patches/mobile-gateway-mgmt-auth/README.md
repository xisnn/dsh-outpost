# DSH Mobile Gateway —— 管理接口认证补丁

> 状态：**受控补丁（不是 fork）**。补丁内容在版本控制里，可重放、可校验、可回退。
> 对应问题：P0-2「未经认证的网关配对码生成」。

---

## 1. 为什么需要这个补丁

上游插件 `dsh-plugin-mobile-gateway` 把 `/mgw/*` 管理路由注册在 **DSH 自己的 web server** 上。
这些路由能做的事情包括：铸造配对码、列出/撤销设备、开关网关、装卸插件。

上游只给它们两道防线，实测**都不够**：

| 防线 | 上游实现 | 实测强度 |
|---|---|---|
| `adminLoopbackOnly` | `isLoopback(req)` 判断源地址 | ❌ 在本项目部署形态下**会让所有人（含本机）都不可达** |
| `isSameOrigin(req)` | 非 GET 时比较 Origin 与 Host | ❌ `if (origin === undefined) return true` —— 脚本直接放行 |

### 1.1 为什么 `adminLoopbackOnly` 不可用（这是本方案的前提）

DSH **只接受一个具体 IP**，不接受 `0.0.0.0`：

```
$ dsh --profile web --host 0.0.0.0 --port 39095
error: --host 0.0.0.0 is an unspecified (wildcard) address, which is not supported:
       binding every interface would expose remote code execution to the network;
       bind one concrete IPv4 or IPv6 address instead
```

而绑定具体 LAN IP 之后，**回环根本没有监听**：

```
Get-NetTCPConnection -LocalPort 3095 -State Listen   -> LocalAddress = 192.168.190.223
TcpClient 127.0.0.1:3095                             -> CONNECT FAIL
```

更关键的是：**即使在本机访问自己的 LAN IP，服务端看到的源地址也不是回环**。
用隔离探针验证：

```
客户端 = 本机 -> http://192.168.190.223:39011/
服务端 remoteAddress = 192.168.190.223
=> isLoopback() === false
```

**结论：`adminLoopbackOnly: true` 会让 `/mgw/*` 对所有人不可达，包括本机的桌面助手。**
它不是「更安全」，而是让首次配对彻底失效。

所以要么 `false`（配对可用，但管理接口无认证），要么 `true`（安全，但配对不可用）。
上游没有第三条路 —— 这就是本补丁要解决的问题。

### 1.2 未打补丁时的实际暴露面

本机实测（不带任何凭据、不带 Origin 的局域网请求）：

```
GET  /mgw/status   -> 200
GET  /mgw/devices  -> 200
POST /mgw/auth     -> 200   ← 处理器确实执行
```

`POST /mgw/pair` 同属这条链路，且**没有任何鉴权**（上游 0.10.3 与最新的 0.11.1 都一样）。
配对成功 = 受信设备，可发提示词（agent 在你电脑上跑命令）、切 `permission`
（`danger-full-access` 直接关闭审批）、装卸插件。

---

## 2. 方案：把访问控制交给 DSH 自己的会话认证

### 2.1 核心思路

DSH 核心对外暴露了一个公开方法：

```
ctx.connection.requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection
```

DSH 官方类型文档对它的描述是：

> Apply Connection's Host/Origin checks and browser authentication to another Web route.

返回 `undefined` 表示放行，返回 `401` / `403` 表示拒绝。内部走 `admit(request)`：

```
isTrusted(request)   → Host 白名单 + Sec-Fetch-Site + Origin 同源栅栏
browserAuth.isAuthenticated(request, secure)   → 校验 dsh-auth-* 会话 cookie
browserAuth.authenticateApi(request, secure)   → 或校验 API 凭据
```

**补丁做的事**：在 `/mgw/*` 路由分派之前调用它。
这样「能不能访问管理接口」由 **DSH 的会话认证**回答，
而不是靠来源 IP 或 Origin 这类可伪造、可绕过的信号。

### 2.2 为什么正常用户不会被挡住（逐条验证）

| 客户端 | 是否带凭据 | 依据 |
|---|---|---|
| **手机 App 首次配对** | ✅ 带 | `approvalGateway.ts` 的 `requestPairingCode()` 用 `credentials: 'include'`；它此前已通过 `loginWithToken` 拿到 DSH 会话 cookie |
| **网页插件**（DSH 侧边栏） | ✅ 带 | `client.js` 的 `request()` 用 `credentials: 'same-origin'`，同源自动带 cookie |
| **手机重连** | ✅ 不受影响 | 走的是 `/ws/mobile` WebSocket，不经过 `/mgw/*` |
| **桌面助手设备列表** | ⚠️ 需改 | 它用 Node 的 `fetch` 直连 `/mgw/devices`，不带 cookie → 已在 `main.js` 中改为走带会话凭据的路径；拿不到时降级提示，不阻塞主流程 |

### 2.3 Host/Origin 栅栏不会误伤局域网

`isTrustedApiRequest` 接受「监听地址本身」作为合法 Host：

```
if (!isLoopbackHostname(hostname)
    && !isTrustedAuthority(hostUrl, trustedHosts, protocol)
    && !isBindAddressAuthority(hostUrl, bindHost)) return false;
```

手机用 `http://192.168.x.x:3095` 访问时，`Host` 就是这个绑定地址 → 通过。
所以 **局域网配对仍然可用**。

### 2.4 没有旁路

| 可能的绕过路径 | 结论 |
|---|---|
| 网关自己的 3081 监听器 | ✅ 只处理 `/ws/mobile` upgrade，普通 HTTP 一律 404，没有 `/mgw/*` |
| 直连 DSH 的其它端口 | ✅ `/mgw` 只注册在 DSH web server 上 |
| 不带 Origin 的脚本 | ✅ `requestRejection` 校验的是 cookie 而非 Origin，脚本同样需要凭据 |
| 伪造 Origin | ✅ Host/Origin 栅栏 + cookie 双重；cookie 是签名过的 |
| `adminLoopbackOnly: false` 后暴露 | ✅ 补丁后即使为 `false`，未认证请求仍被 401 拦下 |

### 2.5 失败关闭（fail-closed）

以下任一情况，补丁**拒绝服务**而不是放行：

- `ctx.connection` 不存在 → `503 mgmt-auth-unavailable`
- `requestRejection` 不是函数 → `503 mgmt-auth-unavailable`
- 认证过程抛错 → `503 mgmt-auth-error`

宁可管理接口不可用，也不能在没有认证的情况下继续暴露 `/mgw/pair`。

---

## 3. 为什么选「受控补丁」而不是 fork 或重写

| 方案 | 安全边界 | 改动量 | 维护成本 | 结论 |
|---|---|---|---|---|
| **A. 等上游加认证** | 最好 | 0 | 0 | ❌ 0.11.1 仍未修，发布日期不可控 |
| **B. 完整 fork 插件** | 好 | 大 | 高（每次上游更新都要合并） | ❌ 单人项目负担不起 |
| **C. 桌面端铸造配对码 + 本机确认** | 好 | 中 | 中 | ❌ **不可行**：回环不可用（§1.1），桌面端无法在本机以回环身份调用 |
| **D. 网络边界认证代理** | 好 | 大 | 高 | ❌ 需额外常驻进程 + 证书，且要保证代理不可绕过；复杂度远超收益 |
| **E. 受控补丁（本方案）** | 好 | **~40 行注入** | **低**（一个锚点 + 哈希白名单） | ✅ **选用** |

E 的关键优势：补丁是**纯文本注入**，不复制上游代码，因此
上游任何其它修复都能保留；同时用哈希白名单防止在未知版本上乱打。

---

## 4. 部署与维护

### 4.1 应用

```powershell
# 只检查状态
node patches/mobile-gateway-mgmt-auth/apply.mjs --check

# 应用（幂等）
node patches/mobile-gateway-mgmt-auth/apply.mjs --apply

# 重启 DSH Web 后生效
```

`setup-gateway.ps1` 已经把它接进流程：安装/更新插件后自动尝试打补丁，
并在补丁失败时**明确报错**（不会静默跳过）。

### 4.2 校验与回退

```powershell
node patches/mobile-gateway-mgmt-auth/apply.mjs --check    # 退出码 1 = 未打
node patches/mobile-gateway-mgmt-auth/apply.mjs --revert   # 从 .orig 备份还原
```

### 4.3 插件升级后怎么办

补丁靠**文本锚点 + 源文件 SHA-256 白名单**双重保护：

- 版本号不在白名单 → 拒绝打补丁，并打印当前文件哈希（提示人工核对）
- 锚点出现次数 ≠ 1 → 拒绝打补丁

升级插件后标准动作：
1. `--check` 会报「补丁未应用」（因为文件变了）
2. 人工确认锚点仍成立
3. 把新版本的 SHA-256 加进 `apply.mjs` 的 `KNOWN_SOURCES`
4. `--apply`

**不会出现「悄悄退回无认证状态」而没人知道的情况** —— `--check` 会失败。

### 4.4 对未来的影响

- 上游若给 `/mgw/*` 加了认证，本补丁可以安全移除（`--revert` 或直接不 apply）。
- 上游若改了 `/mgw` 注册方式导致锚点消失，补丁会拒绝应用并提示 —— 需要重新核对。
- 已配对设备、WS 协议、响应结构都不受影响。

---

## 5. 已验证 / 待验证

### 已通过自动化验证（`dsh-mobile/tests/mobile-gateway-patch-spec.mjs`）

- 补丁幂等（重复 apply 不叠加）
- 锚点缺失 / 重复 → 拒绝打补丁（fail-closed）
- 注入位置在所有 `/mgw/*` 路由分派之前
- 运行时控制流：无 connection → 503；无 requestRejection → 503；401 → 拒绝；403 → 拒绝；undefined → 放行；抛错 → 503

### 待真机验证（**本轮无法完成，见报告 §5**）

- 真实手机首次配对（带 cookie）能拿到配对码
- 未认证局域网请求对 `/mgw/pair` 返回 401
- 已配对设备 WS 重连正常
- 撤销后设备无法恢复

> 原因：本轮执行期间本机 DSH 进程绑定在一个**已从网卡消失的地址**上
> （`192.168.190.223` 不在任何接口上，连接被 ECONNRESET），
> 无法对它做端到端联调。补丁本身的控制流已用模拟 ctx 全量验证。
