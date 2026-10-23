# 协议兼容性

说明客户端依赖 DSH 的哪些接口、上游变更时会发生什么、以及怎么把影响降到最小。

---

## 一、依赖清单

### RPC 接口（15 个必需）

| 接口 | 用途 | 缺失后果 |
|---|---|---|
| `session/list` | 会话列表 | **完全不可用** |
| `session/create` | 新建会话 | 不能新建 |
| `session/page` | 分页加载历史 | 打不开会话 |
| `session/prompt` | 发消息 | 不能聊天 |
| `session/cancel` | 中断生成 | 不能停 |
| `session/rename` | 重命名 | 不能改名 |
| `session/attachment` | 上传附件 | 不能发图/文件 |
| `session/modelCatalog` | 模型列表 | 不能切模型 |
| `session/selectModel` | 切模型 | 不能切模型 |
| `session/updateQueue` | 排队消息 | 排队功能没了 |
| `workspace/create` | 打开工作区 | 不能换目录 |
| `workspace/archiveSession` | 归档会话 | 不能归档 |
| `workspace/unarchiveSession` | 取消归档 | 不能恢复归档 |
| `account/getState` | 账户状态 | 「我的」页信息缺失 |
| `account/getBalance` | 余额 | 看不到余额 |

### 事件类型（来自 `session/follow` 的流式推送）

`turn/start`、`turn/end`、`step/start`、`assistant/message`、`user/message`、
`tool/call`、`tool/result`、`approval/asked`、`approval/decided`、`deliverables/presented`

**未知事件不会崩溃** —— fold 层会忽略认不出的类型。但如果核心事件
（`assistant/message`）改名了，表现是「消息不显示」。

### 网关协议（审批功能）

| 项 | 值 |
|---|---|
| 端点 | `ws://<host>:3081/ws/mobile`（或 endpoints 里同源的那条） |
| 子协议 | `dsh-mobile-v1` + `dsh-pair.<code>` / `dsh-token.<token>` |
| 必需头 | `X-DSH-Device-ID`（**只读 header，不放查询串**） |
| 配对码 | **一次性**，用过即失效 |

---

## 二、上游变更时会发生什么

### 场景 A：接口改名 / 删除

```
用户操作 → transport 收到 gateway/not-found
        → makeRpcError 分类为「接口不存在」
        → 界面显示：
            ⚠ 这个版本的 DSH 不支持该功能
              电脑上的 DSH 可能比你装的 App 老，或者接口改过名。
              建议把 DSH 更新到最新版。
```

**不会**只给用户一句 `session/page: gateway/not-found`。

### 场景 B：返回结构变了

```
能拿到 HTTP 200，但响应里没有 result 字段
→ 分类为 malformed
→ 显示「DSH 返回的数据格式变了，建议更新 App」
```

### 场景 C：新增了必需字段

这种情况客户端不会报错（多余字段被忽略），但可能功能不完整。
**这是最难发现的** —— 靠真机测试和用户反馈。

### 场景 D：事件类型改名

不会报错，但对应内容不显示。症状是「发了消息但聊天记录里没有」。
`protocol.ts` 里的 `KNOWN_EVENT_KINDS` 用于诊断这类问题。

---

## 三、兼容性自检

连接成功后，`Store.checkCompatibility()` 会探一次关键接口：

```typescript
const probes = [
  { endpoint: 'session/list',        run: () => this.api.list() },
  { endpoint: 'session/modelCatalog', run: () => this.models.catalog() },
  { endpoint: 'account/getState',    run: () => this.account.getState() },
];
```

**只探只读接口**，绝不产生副作用（不建会话、不改状态）。

判定规则：

| 缺失数量 | 判定 |
|---|---|
| 0 | 正常，不显示任何提示 |
| 1-3 | 部分降级，显示「有 N 个功能不可用：xxx」 |
| ≥4 | 整体不兼容，显示「建议更新 DSH 或 App」 |

结果展示在会话列表页顶部（`CompatBanner`），**可关闭**——
部分功能不可用通常不影响主流程，不该一直占地方。

---

## 四、错误分类与提示

`src/core/protocol.ts` 的 `classifyError()` 把任意错误归到五类：

| 类型 | 触发条件 | 给用户的提示 |
|---|---|---|
| `endpoint-missing` | `not-found` / `unknown method` / `unimplemented` | 「这个 DSH 版本不支持该功能」+ 建议更新 |
| `auth` | `401` / `403` / `unauthorized` / `invalid token` | 「登录状态失效了」+ 建议重新配对 |
| `network` | `Network request failed` / `timeout` / `ECONNREFUSED` | 「连不上电脑」+ 检查网络/重新扫码 |
| `shape-changed` | `malformed` / `undefined` / JSON 解析失败 | 「数据格式变了」+ 建议更新 App |
| `server` | `5xx` / `internal` | 「DSH 那边出错了」+ 看日志/重启 |

**关键设计**：网络问题**不会**被说成版本问题。
否则用户在 WiFi 断了的时候会去折腾重装 App。

`RpcError` 还带 `retryable` 标记：
- 网络类 → 可重试（自动重连有意义）
- 接口缺失 → 不可重试（重试一万次也是 404）

---

## 五、避免「上游一变就全挂」

### 已做的

1. **错误分类** —— 不会给用户看内部错误码
2. **能力探测** —— 连接时主动发现缺失接口，提前告知
3. **优雅降级** —— 单个接口失败不影响其他功能
4. **未知事件忽略** —— fold 层不会因为认不出事件类型而崩
5. **依赖清单锁定** —— `protocol-compat-spec.mjs` 会在接口名被改时立即失败

### 没做（和为什么）

| 想法 | 为什么没做 |
|---|---|
| 版本号协商 | DSH 没暴露协议版本号接口；语义化版本也不可靠（patch 版本也可能改接口）。用**能力探测**比版本号准 |
| 多版本适配 | 维护成本高，而且没有真实的多版本测试环境。不如把错误提示做好 |
| 自动降级到旧接口 | 不知道旧接口长什么样，容易写出更脆的代码 |

### 未来可以考虑

- 如果上游开始提供协议版本号，加一层「最低版本」检查
- 记录上游每次变更的影响范围（现在靠 `docs/protocol-notes.md` 手工维护）

---

## 六、上游变更时的检查清单

发现 DSH 升级后行为异常，按这个顺序查：

1. **看错误提示** —— 分类是 `endpoint-missing` 还是 `shape-changed`？
2. **跑兼容性测试** —— `npm run test:compat`，会告诉你依赖清单有没有被破坏
3. **抓一个真实请求** —— 用 `docs/protocol-notes.md` 里的方法
4. **对比接口清单** —— `protocol.ts` 里的 `REQUIRED_ENDPOINTS`
5. **更新清单和文档** —— 改了接口就同步改这三处：
   - `src/core/protocol.ts` 的清单
   - `docs/protocol-notes.md` 的协议说明
   - `tests/protocol-compat-spec.mjs`（通常不用改，它读清单）

---

## 七、测试

```bash
npm run test:compat     # 20 项，单独跑
npm test                # 包含在完整测试链里
```

覆盖：

- 代码里用的接口都在清单里（有人新增接口忘了登记 → 失败）
- 清单没被误删（接口数量下限）
- `KNOWN_EVENT_KINDS` 覆盖 fold 认识的类型
- 五类错误分类都正确
- 每条提示都带可操作建议
- 兼容性报告的三档判定
- `RpcError` 的 `retryable` 语义
- **兼容性探测不产生副作用**（不含 create/rename/delete）
