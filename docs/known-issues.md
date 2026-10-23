# 已知问题

集成测试驱动真实产品代码时发现的问题。这些都是**读了源码看不出来、静态检查也测不到**的，
必须真的发请求、真的握手才会暴露。

---

## 1. 审批网关断线后无法重连（较严重）

**现象**：审批通道第一次能连上，断线后**永远重连不回来**。

**根因**：`ApprovalGateway.scheduleRetry(pairingCode)` 把**旧配对码**传下去复用，
而网关的配对码是**一次性**的：

```typescript
// approvalGateway.ts
ws.onclose = () => {
  ...
  this.scheduleRetry(pairingCode);   // ← 复用已作废的码
};

private scheduleRetry(pairingCode?: string): void {
  this.retryTimer = setTimeout(() => {
    void this.connect(pairingCode);   // ← 拿着旧码重连
  }, delay);
}
```

`connect(pairingCode)` 拿到参数后就不会再走「申请新配对码」的分支，
于是每次重连都拿已作废的码 → 服务端 401 → 无限失败。

**服务端侧证据**：DSH 网关的 `claimPairing` 里是
`pairings.delete(codeHash)`，配对成功后立即删除，所以码只能用一次。

**正确做法**：重连时应该用 `dsh-token.<deviceToken>` 子协议
（配对成功时服务端会下发 `{kind:'paired', token}`，已经存进 AsyncStorage 了）。

**测试覆盖**：
- `integration-gateway.mjs` → 「旧配对码不能重复使用」
- `integration-product.mjs` → 「断线后服务端接受 dsh-token 重连（协议层验证）」

这两项证明**协议层面支持用 token 重连**，只是 Gateway 的实现没用上。

**影响**：用户网络抖动一次（切 WiFi、锁屏休眠、服务重启），
审批通道就再也起不来，只能杀掉 App 重进。

---

## 2. 失效 token 的自愈可能触发不了

**现象**：本地存着一个已失效的 device token 时，
`onclose` 里检测 `reason` 是否包含 401 来决定「清 token 重连」。

**根因**：握手阶段的 401 是 **HTTP 层拒绝**，WebSocket 客户端
只会收到 `close code 1006`，**`reason` 是空的**：

```typescript
// approvalGateway.ts
const why = String(ev?.reason ?? '');
const unauthorized = /401|unauthorized|invalid|expired/i.test(why);
// ← why 是空串时，这里永远 false
```

**测试证据**：`integration-product.mjs` → 「失效 token 的重连会被服务端拒绝」
用一个服务端不认识的 token 连，客户端拿到的是 1006 而不是 401。

**正确做法**：握手被拒时不要依赖 `reason`。
可以：
- 在 `onerror` 里也检查（ws 库会带 HTTP 状态）
- 或者退一步：只要连续失败 N 次就清 token 重新配对

**影响**：用户重装网关/换 DSH 实例后，手机端会一直用旧 token 重试，
表现为「审批通道一直是灰的、点不动」。

---

## 3. Android `network-security-config` 不支持 CIDR（不可修）

**现象**：想让「明文 HTTP 只允许私有网段」，但配置文件写不了网段。

**根因**：Android 的 `network-security-config` 只支持：
- 具体域名（`example.com`）
- 具体 IP 字面量（`192.168.1.1`）
- 子域名通配（`includeSubdomains`）

**不支持** `192.168.0.0/16` 这种 CIDR，也没法写 IP 段通配。

**现状**：配置里全局允许明文，真正的边界放在应用层
（`src/core/net-security.ts` 的 `checkBaseUrlSecurity`）。

**这是平台限制，不是我们的 bug。** 但意味着：
如果 App 某处绕过 `DshConnection` 直接 fetch（比如将来新增的功能），
就失去了这层保护。

**建议**：新增任何网络请求都走 `DshConnection`，不要裸 fetch。

---

## 4. 状态目录名保留 dsh-pocket（有意为之）

项目已改名为 DSH Outpost，但运行时状态目录仍是
`%LOCALAPPDATA%\dsh-pocket`。

**原因**：里面是用户已有的 `tunnel.json` / `pairing.json` / 日志。
改名会让所有老用户「隧道突然没了、要重新配对」。

**这是有意保留的**，不是遗漏。代码里有专门的保护逻辑
（`_rename.cjs` 的占位替换）。

---

## 记录格式

发现新问题时按这个结构写：

```
## N. 一句话现象

**现象**：用户能看到什么
**根因**：代码层面为什么
**测试覆盖**：哪个测试守住了
**影响**：多严重、什么场景触发
**建议**：怎么修
```
