# 移动网关配置（审批必需）

手机端要能**回答**审批，必须装 `dsh-plugin-mobile-gateway` 并开启网关。

## 为什么需要它

DSH 的审批是 Host 侧的 `approval/request` waterfall，结果靠 Remote Event
监听器的**返回值**回传，没有任何 HTTP RPC 可以调（我把 asar 里 12 个候选
端点名都试过，全部 `not found`）。

而这个插件在 Host 内部接入了那个 waterfall，再通过独立 WebSocket 把审批
投影给手机，手机回帧即可。**这是目前唯一可行的方法。**

## 一、安装插件

```powershell
# 在 DSH 里装（网页端「插件管理」搜 dsh-plugin-mobile-gateway 也行）
npx dsh plugin add dsh-plugin-mobile-gateway
```

或者用本文开头的 `setup-gateway.ps1`（自动装 + 改配置 + 重启）。

## 二、改配置

插件自带的默认配置是 `gatewayEnabled: false`（关闭）和
`adminLoopbackOnly: true`（管理接口只允许本机回环）。

但 DSH 的 web server 绑在**局域网 IP** 上，回环地址连不进去，
所以管理接口打不开。必须改这两个：

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`，在末尾追加：

```yaml
- id: mobile-gateway
  name: 'dsh-plugin-mobile-gateway'
  config:
    gatewayEnabled: true      # 开启网关（默认关）
    gatewayMode: persistent   # 常驻，不自动关
    gatewayName: DSH Pocket
    requireAuth: true         # 手机仍需配对码（安全边界不变）
    adminLoopbackOnly: false  # 允许从局域网访问管理接口
    lanEnabled: true
    lanHost: 0.0.0.0
    lanPort: 3081
    pairingTtlMs: 300000
```

然后重启 DSH Web。

## 三、验证

```powershell
# 网关状态（应看到 gatewayEnabled: true）
curl "http://<你的IP>:3095/mgw/status"

# 看已配对设备
curl "http://<你的IP>:3095/mgw/devices"
```

手机 App 进聊天页时会自动配对（用 `X-DSH-Device-ID` 换长期 token）。

## 协议要点

网关端口 **3081**，WebSocket 路径 `/ws/mobile`。

**配对**：子协议 `['dsh-mobile-v1', 'dsh-pair.<配对码>']`，
请求头 `X-DSH-Device-ID: <稳定设备id>`。
配对成功收到 `{"kind":"paired","token":"..."}`，这个 token 存起来，
下次用子协议 `dsh-auth.<token>` 重连，不用再配对。

**收审批**：
```json
{"kind":"approval-requested","rpcId":"...","sessionId":"...",
 "approvalId":"...","toolName":"bash","reason":"...","replay":true}
```

**回审批**：
```json
{"type":"approval-response","rpcId":"...","sessionId":"...",
 "approvalId":"...","outcome":"allowed-once"}
```

`outcome` **只能**是 `allowed-once` 或 `rejected`。
`cancelled` / `unavailable` 是宿主侧状态，客户端不许发。

**最终状态广播**：
```json
{"kind":"approval-resolved","rpcId":"...","outcome":"rejected"}
```

重连时服务端会重放未决的审批（带 `replay: true`），
所以客户端必须按 `rpcId` 去重。

## 图片下载

管家发的图片是**工作区相对路径**（`cover_out/x.png`），
`/api/file?path=` 只认绝对路径，遇到中文名还会失败。
网关提供了按会话解析的下载通道：

```json
{"type":"file-download-open","sessionId":"...","path":"cover_out/x.png","requestId":"r1"}
→ {"kind":"file-download-opened","transferId":"...","size":2506055,"chunkBytes":524288,"name":"x.png"}

{"type":"file-download-read","transferId":"...","offset":0}
→ {"kind":"file-download-chunk","transferId":"...","offset":0,"data":"<base64>","eof":false}
```

**offset 必须严格是「上一块 offset + 解码后字节数」**，
协议不支持断线续传。写错会报
`file-transfer-offset offset must match the next unread byte`。

## 已知限制

- 审批**不支持「始终允许」**，只有一次性决定。
- 网关的快速隧道（插件自带 `/mgw/cloudflare`）和我们的
  `start-tunnel.ps1` 是两套，别混用。
- `hello.capabilities` 里**没有** `approvals` 这一项 ——
  审批是无条件推送的帧类型，不看 capability。
