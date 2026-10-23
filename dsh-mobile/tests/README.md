# 测试体系

这个项目有三层测试，职责不同，跑的方式也不同。

| 层 | 目录/文件 | 依赖 | 跑多久 | 测什么 |
|---|---|---|---|---|
| **静态检查** | 各 `*-spec.mjs` 里的 `readFileSync` 断言 | 无 | < 1 秒 | 代码里有没有某句话、配置对不对 |
| **单元测试** | `fold-spec` / `semver` / `fileref` / `butler-rules` 等 | 无 | < 2 秒 | 纯函数的行为 |
| **集成测试** | `integration-*.mjs` + `support/fake-dsh.mjs` | 本地起 HTTP+WS | 5-15 秒 | 真实网络协议行为 |
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

## 集成测试：为什么需要模拟服务端

现有测试的两个极端：

- 单元测试：快，但不碰网络
- `e2e.mjs`：碰真网络，但**必须连真 DSH**，CI 里跑不了

中间缺一层：**有真实网络行为，但不需要外部服务**。

`tests/support/fake-dsh.mjs` 填的就是这个空：

```
  你的代码                模拟 DSH
  ─────────              ──────────
  fetch  ────────────→   http.createServer
  WebSocket ─────────→   手写 RFC 6455 握手
                          （真的解析帧、真的回子协议）
```

它模仿的协议：

| 端点 | 用途 |
|---|---|
| `POST /api/<ns>/<method>` | unary RPC |
| `GET /?token=xxx` | 换 cookie（303） |
| `WS /api/remote.mux` | 流式通道 |
| `POST /mgw/pair` | 网关配对 |
| `WS /ws/mobile` | 审批网关 |

**不模仿**业务逻辑（事件折叠、模型调用）—— 那是 `e2e.mjs` 的事。

---

## 三个集成测试文件

### `integration-transport.mjs`（15 项）

测传输层和 RPC：

- 配对：换 cookie、错误 token 被拒、cookie 能访问 RPC
- 鉴权：没 cookie 的 RPC 返回 401（不静默成功）
- RPC 形状：`{type,rpcId,method,payload.args}`
- WS：建连、无 cookie 被拒、收帧、断开感知、**重连成功**
- 分页边界：`throughSeq` 超游标报错、`address` 形状必须对
- 并发：10 个 RPC 同时发不串号

### `integration-gateway.mjs`（14 项）

测审批网关 —— **这块坑最多**，之前踩过四个连环 bug：

- 配对：`/mgw/pair` 返回 code + endpoints
- 连接：子协议 + `X-DSH-Device-ID` 头才能连上
- **缺 header 必须被拒**（曾经以为能走查询串，结果服务端只读 header）
- **配对码一次性**（用第二次被拒）
- 审批帧：收 `approval-requested`、回 `approval-response` 服务端能收到
- `outcome` 只接受 `allowed-once` / `rejected`（协议里没有「始终允许」）
- `approval-resolved` 推送
- **replay 帧**（重连时补发未决审批，否则用户审批永远卡着）
- **自愈链路**：失效 token 必须连不上 → 清掉后重新配对能连上

### `integration-long-session.mjs`（10 项）

测长会话（「空调话」bug 的重灾区）：

- 90 条记录分页拉完，**不丢不重**、顺序连续
- `throughSeq` 等于游标 OK、超过报错（不静默返回空）
- `address` 必须是 `{kind,sessionId}`
- 空会话、单条记录 `hasMore=false`
- 50KB 长文本不截断
- 中文/emoji/引号往返一致
- 并发拉 5 页不串

---

## 两个关键教训

### 1. Node 内置 WebSocket 不支持自定义 header

```js
// 这样写，headers 会被静默忽略：
new WebSocket(url, protocols, { headers: { 'X-DSH-Device-ID': 'x' } })
```

所以网关测试用 `ws` 库。这点本身也是提醒：**RN 的 WebSocket 同样不能设 header**，
产品代码是靠「构造函数第三个参数」绕过去的。

### 2. 手写 WS 服务端容易漏两件事

- **握手响应必须回 `Sec-WebSocket-Protocol`**，否则客户端报
  `Server sent no subprotocol` 并 1006 断开
- **发数据必须编码成 WebSocket 帧**，裸 `socket.write(json)`
  客户端收不到

这两个坑各踩了一次，现在都有注释。

---

## 怎么跑

```bash
cd dsh-mobile

npm test                 # 静态检查 + 单元测试（约 40 秒，CI 跑这个）
npm run test:integration # 集成测试（约 15 秒，需要本地端口）
npm run test:e2e         # 端到端（需要真 DSH，见下）
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
| 请求发出去对不对、收到什么 | 集成测试（fake-dsh） |
| 整个 App 在真机上能不能用 | 真机回归清单（`docs/device-checklist.md`） |
