# 测试体系

这个项目有**四层**测试，职责不同，跑的方式也不同。

| 层 | 目录/文件 | 依赖 | 跑多久 | 测什么 |
|---|---|---|---|---|
| **静态检查** | 各 `*-spec.mjs` 里的 `readFileSync` 断言 | 无 | < 1 秒 | 代码里有没有某句话、配置对不对 |
| **单元测试** | `fold-spec` / `semver` / `fileref` / `butler-rules` 等 | 无 | < 2 秒 | 纯函数的行为 |
| **协议集成** | `integration-transport` / `-gateway` / `-long-session` | 本地起 HTTP+WS | 5-10 秒 | 手搓请求，验证协议形状 |
| **产品集成** | `integration-product.mjs` | 本地起 HTTP+WS | 8-15 秒 | **import 真实产品代码**，验证它能不能正确对接 |
| **端到端** | `e2e.mjs` | **真实 DSH 服务** | 手工跑 | 完整链路 |

---

## 静态检查能测什么、不能测什么

**能测**（有价值的部分）：

- 配置文件里该有的项有没有（`cleartextTrafficPermitted`、`extraResources`）
- 危险写法有没有被引入（`usesCleartextTraffic`、渲染层直接 `require`）
- 关键约束有没有被违反（`imageWrap` 不能有 `overflow:hidden`）

**不能测**：

- 行为对不对。比如「WS 握手带没带 header」——
  代码里写了 `headers: {...}`，但可能因为用的库不支持而被忽略

所以静态检查是**下限保障**，不能替代集成测试。

---

## 协议集成 vs 产品集成（重要区别）

这两个容易混，但价值完全不同。

### 协议集成（`integration-transport` / `-gateway` / `-long-session`）

手搓 `fetch` / `WebSocket`，验证**服务端行为**：

```js
const res = await fetch(`${srv.baseUrl}/mgw/pair`, ...);
assert(res.status === 201);   // 服务端返回对了
```

测的是「协议长什么样」，**不碰产品代码**。

### 产品集成（`integration-product.mjs`）

import 真实的 `DshConnection` / `ApprovalGateway`，让它们跑在模拟服务端上：

```js
import { ApprovalGateway } from '../src/core/approvalGateway.ts';
const gw = new ApprovalGateway(srv.baseUrl, {...});
await gw.connect();
assert(statuses.includes('online'));   // 我的代码能不能连上
```

测的是「**我的代码能不能正确对接**」。

**差别很实在**：

| 问题 | 协议测试 | 产品测试 |
|---|---|---|
| 服务端返回 401 | ✅ 能验证 | ✅ 能验证 |
| 我的代码收到 401 后会清理 token 吗 | ❌ 测不到 | ✅ 能验证 |

**这个文件抓到了两个真实缺陷**（见 [docs/known-issues.md](../../docs/known-issues.md)），
都是读源码看不出来的。

---

## 怎么让产品代码跑在 Node 里

`core/` 下的代码大部分是纯逻辑，但有几处 RN 依赖需要处理。
`integration-product.mjs` 里做了三件事：

### 1. AsyncStorage → 内存 stub

用 Node 的 **ESM loader hook**（`register()`）把模块重定向：

```js
// tests/support/rn-module-hook.mjs
const MAPPING = {
  '@react-native-async-storage/async-storage': './_async-storage-shim.cjs',
  '@react-native-cookies/cookies': './_cookie-manager-shim.cjs',
};
```

> ⚠️ **不能用 `Module._resolveFilename`** —— 那个只拦 `require()`，
> 拦不到 `await import('...')`。产品代码里 `readCookieFromJar` 用的正是动态 import。

### 2. fetch → 带 cookie 语义的版本

Node 的 fetch **不处理 Set-Cookie**，RN 里由原生实现负责。
`tests/support/cookie-fetch.mjs` 补上：

- 收到 `Set-Cookie` → 写进 jar
- 发请求 → 从 jar 取 cookie 放 `Cookie` 头
- **手动接管 303 重定向**（因为产品代码注释里说 RN 不支持 `redirect: 'manual'`，
  但 Node 支持，且 follow 会吞掉中间那次 Set-Cookie）

### 3. WebSocket → 支持自定义 header

`ApprovalGateway` 用 RN 的扩展：`new WebSocket(url, protocols, { headers })`。
Node 的全局 WebSocket **静默忽略**第三个参数。

`tests/support/ws-with-headers.mjs` 用 `ws` 库实现同样签名，
并适配 DOM 风格事件（`ws.onopen = ...` 而不是 `.on('open')`）。

---

## 建测试基础设施时踩的坑

这些坑各花了不少时间，都写进注释了：

| 坑 | 表现 | 教训 |
|---|---|---|
| **两份 AsyncStorage** | ESM stub 和 CJS shim 各有 Map，`__reset()` 清不到产品代码读的那份 | 只能有一份存储 → 挂到 `globalThis` |
| **WS 握手不回子协议** | 客户端报 `Server sent no subprotocol` 并 1006 | 服务端必须回 `Sec-WebSocket-Protocol` |
| **裸 socket 写 JSON** | 客户端收不到 | 必须编码成 WebSocket 帧 |
| **字段名猜错** | 服务端发 `deviceToken`，客户端读 `frame.token` | 读产品源码确认字段名，不要猜 |
| **方法名猜错** | 写了 `gw.close()`，实际是 `gw.disconnect()` | 同上 |
| **Node WebSocket 不传 header** | 网关握手 400 | 用 `ws` 库 |
| **`Module._resolveFilename` 拦不到动态 import** | stub 不生效 | 用 ESM loader hook |

---

## 四个集成测试文件

### `integration-transport.mjs`（15 项）

协议层：配对换 cookie、鉴权 401、RPC 形状、WS 建连/断开/重连、分页边界、并发不串号。

### `integration-gateway.mjs`（14 项）

协议层：网关配对、`X-DSH-Device-ID` 必需、配对码一次性、
审批帧收发、`outcome` 枚举、replay 帧、设备列表。

### `integration-long-session.mjs`（10 项）

协议层：90 条记录分页不丢不重、`throughSeq` 边界、`address` 形状、
空会话、50KB 长文本、中文/emoji 往返、并发分页。

### `integration-product.mjs`（16 项）

**产品代码层**：`parsePairingText` + `DshConnection` 全链路配对、
地址安全校验生效、RPC 错误透传、`ApprovalGateway` 连接/收审批/回审批、
长会话分页走真实 `DshConnection`。

---

## 怎么跑

```bash
cd dsh-mobile

npm test                      # 静态检查 + 单测（约 40 秒，CI 跑这个）
npm run test:integration      # 全部集成测试（约 25 秒，需要本地端口）
npm run test:integration:protocol   # 只跑协议层
npm run test:integration:product    # 只跑产品层
npm run test:e2e              # 端到端（需要真 DSH，见下）
```

集成测试只需要本地端口，**不需要 DSH**，可以进 CI。

`e2e.mjs` 需要真服务：

```powershell
$env:DSH_HOST='192.168.1.10'
$env:DSH_PORT='3095'
$env:DSH_TOKEN='<启动日志里的 token>'
node tests/e2e.mjs
```

---

## 分层原则

写新测试时先想清楚放哪一层：

| 想验证 | 放哪 |
|---|---|
| 纯函数算得对不对 | 单元测试（直接 import） |
| 代码里有没有某句话 | 静态检查（但尽量少写这类） |
| 请求发出去对不对、收到什么 | 协议集成（手搓 fetch/WS） |
| **我的代码能不能正确对接** | **产品集成（import 产品代码）** |
| 整个 App 在真机上能不能用 | 真机回归清单（`docs/device-checklist.md`） |

