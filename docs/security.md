# 安全模型

本文说明 DSH Outpost 的网络通信安全边界、明文 HTTP 的取舍、以及 token 的保护措施。

---

## 一、威胁模型

**要保护的是**：DSH 服务的 token。拿到它等于拿到这台电脑上 DSH 的操作权
（能读文件、执行命令、看会话记录）。

**主要风险**：

| 风险 | 场景 |
|---|---|
| **明文传输** | 局域网里有人抓包，直接读到 token 和全部对话内容 |
| **token 泄漏到日志** | 日志文件被其他人读到，或者被意外提交/上传 |
| **意外的公网明文** | App 某处拼错地址，把 token 明文发到公网 |
| **中间人** | 公共 WiFi 上有人冒充 DSH 服务 |

**不防的**：

- 电脑本身被攻破（那是 DSH 自己的安全边界）
- 用户自己把 token 截图发给别人
- DSH 本体和插件的漏洞（见 [dsh-plugin-mobile-gateway 的文档](mobile-gateway.md)）

---

## 二、三种连接方式的安全边界

| 方式 | 传输 | 加密 | 适用场景 |
|---|---|---|---|
| **局域网** | `http://192.168.x.x:3095` | ❌ **明文** | 自己家/办公室的可信 WiFi |
| **Tailscale** | `http://100.x.x.x:3095` | ✅ WireGuard 端到端加密 | 任何网络（含公共 WiFi） |
| **Cloudflare 隧道** | `https://xxx.trycloudflare.com` | ✅ TLS | 任何网络，手机不用装东西 |

### 局域网明文的风险有多大

在**自己的** WiFi 上：风险低（除非 WiFi 密码泄露，或者有恶意设备在同一网段）。

在**公共** WiFi 上：**不要用局域网模式**。同一个 WiFi 下的任何人
（包括商场 WiFi 的其他顾客）都可能抓到你发的 token。

**判断标准**：这个 WiFi 是你控制的吗？不是就用 Tailscale 或隧道。

### 为什么 App 允许明文

Android 9+ 默认禁止明文，但 DSH 的局域网和 Tailscale 模式都是 `http://`。
如果全部禁掉，这两个模式直接不可用（表现为 `Network request failed`，极难排查）。

所以 `network_security_config.xml` 允许明文，但**真正的边界放在应用层**：

---

## 三、应用层的地址校验

`src/core/net-security.ts` 里的 `checkBaseUrlSecurity()` 在**每次连接前**检查地址：

| 协议 | 地址类型 | 结果 |
|---|---|---|
| `https://` | 任何 | ✅ 允许 |
| `http://` | 私有地址（10/8、172.16/12、192.168/16、100.64/10、169.254/16、127/8） | ✅ 允许 |
| `http://` | localhost / 10.0.2.2 | ✅ 允许 |
| `http://` | **公网 IP 或域名** | ❌ **拒绝，请求根本不发** |
| 其他协议 | — | ❌ 拒绝 |

### 为什么这条规则有效

攻击场景：App 某处拼错域名、或者被注入一个 `http://evil.com` 链接，
token 会明文发到公网。有了这个校验，那种请求在**发出去之前**就被拦下。

### 正常使用完全不受影响

```
局域网    http://192.168.151.223:3095   → 192.168/16，放行
Tailscale http://100.101.102.103:3095   → 100.64/10，放行
模拟器    http://10.0.2.2:3095          → 10/8，放行
隧道      https://xxx.trycloudflare.com → https，放行
```

---

## 四、Android 配置

### network_security_config.xml

```xml
<base-config cleartextTrafficPermitted="true">   <!-- 局域网必需 -->
    <trust-anchors><certificates src="system" /></trust-anchors>
</base-config>

<debug-overrides>
    <trust-anchors>
        <certificates src="system" />
        <certificates src="user" />   <!-- 只在 debug 生效，用于抓包调试 -->
    </trust-anchors>
</debug-overrides>
```

**要点**：

- `release` 构建**不信任**用户安装的证书 → 防止中间人
- `debug` 构建信任 → 方便用 Charles / mitmproxy 抓包排查

### 已移除 usesCleartextTraffic

原来 manifest 里有 `android:usesCleartextTraffic="true"`，
它和 `networkSecurityConfig` 同时存在时语义会打架（前者会削弱后者的限制）。

现在只保留 `networkSecurityConfig` 作为唯一准绳。

---

## 五、token 保护

### 1. 不出现在日志里

| 位置 | 措施 |
|---|---|
| 手机 App | 全项目只有 2 处 `console.*`，都不打印 token |
| 错误信息 | 所有含地址的错误都过 `redactUrl()` 脱敏 |
| 网关 close reason | 服务端返回的 reason 先脱敏再显示 |
| 桌面助手 | 不打印 token，只放进剪贴板和二维码 |

`redactUrl()` 会处理：

```
?token=xxx        → ?token=***
Cookie: xxx       → Cookie: ***
dsh-auth-xxx=v1.x → dsh-auth-xxx=***
裸的长 token      → ***
```

### 2. 落盘位置加固

**日志文件**（含 token）：

| | 之前 | 现在 |
|---|---|---|
| 位置 | `%TEMP%\dsh-web-3095.log` | `%LOCALAPPDATA%\dsh-pocket\logs\` |
| 权限 | 继承 ACL，本机其他用户可读可写 | 只有 当前用户 / SYSTEM / Administrators |

**pairing.json**（含明文 token）：

同样从「继承 ACL（实测 `XIS\CodexSandboxUsers` 可读）」收紧到只有上面三个主体。

### 3. 传输时怎么带

- **HTTP RPC**：走 `Cookie` 请求头（不是 URL 参数），避免进访问日志
- **WebSocket**：靠原生 cookie 容器自动携带
- **网关 WS**：用子协议 `dsh-pair.<code>` / `dsh-auth.<token>`
  （子协议不进入常见的 URL access log，比查询串安全）

---

## 六、已知限制

| 限制 | 说明 |
|---|---|
| **局域网仍是明文** | 这是 DSH 服务端决定的（它默认只提供 http）。要么用 Tailscale/隧道，要么自己给 DSH 配 HTTPS |
| **NSC 不支持 IP 网段** | Android 的 `network-security-config` 不能写 CIDR，所以只能全局允许明文，靠应用层校验兜底 |
| **状态目录权限依赖用户** | 脚本会尝试收紧 ACL，但在 FAT32 / 网络盘上会失败（会打印提示） |
| **token 在二维码里** | 扫给别人 = 把钥匙给别人。截图分享前先想想 |

---

## 七、部署建议

### 家里 / 办公室（可信网络）

```
局域网模式就行。防火墙只放行自己的网段更稳。
```

### 外面 / 公共 WiFi

```
优先 Cloudflare 隧道（https，手机零配置）
次选 Tailscale（端到端加密）
绝对不要用局域网模式
```

### 想给局域网也上 HTTPS

DSH 本身支持绑定 HTTPS，但需要自己准备证书。简单做法是前面挂个
Caddy / nginx 做 TLS 终止：

```powershell
# Caddy 自动申请 Let's Encrypt 证书
caddy reverse-proxy --from dsh.yourdomain.com --to 127.0.0.1:3095
```

然后用 `https://dsh.yourdomain.com/?token=xxx` 配对。
注意 DSH 需要 `--trusted-host dsh.yourdomain.com`，否则 `/api` 会返回 403。

---

## 八、自查清单

部署后建议过一遍：

- [ ] 手机上的服务地址是 `https://`，或者是明确的私有网段 `http://`
- [ ] 没在公共 WiFi 下用局域网明文模式
- [ ] `%LOCALAPPDATA%\dsh-pocket\pairing.json` 的权限只有自己可读
- [ ] 日志目录 `%LOCALAPPDATA%\dsh-pocket\logs\` 里没有过期的旧日志
- [ ] 没把带 token 的二维码截图发到群里
- [ ] 不用的时候把 DSH 服务停掉（或者把 token 换掉）
