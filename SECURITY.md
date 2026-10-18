# 安全说明

## token 等于你电脑的钥匙

App 用 DSH Web 服务打印的 token 换取一个 30 天的 cookie。**token 和 cookie 都能完全控制那台机器上的 DSH**，
请当密码对待：

- 不要把带 token 的链接发到群里、贴到截图里、提交进仓库
- 二维码同理（它里面就是 token）
- 不要把带 token 的二维码图片提交进仓库

## 网络暴露面

`start-dsh-web.ps1` 会把服务绑到某个具体网卡地址：

| 绑定 | 谁能访问 |
|---|---|
| 局域网 IP | **同一个 WiFi 下的所有人**（如果他们知道地址和 token） |
| Tailscale IP | 只有你 tailnet 内的设备，且 WireGuard 加密 |
| `0.0.0.0` | 所有能路由到这台机器的地址，风险最高 |

建议：

- 家里/自己的网络：局域网模式足够
- 咖啡馆、公司、机场等不信任的网络：**用 Tailscale**，不要直接开局域网
- 用公网域名时务必套 HTTPS（App 本身走明文 HTTP）

## 权限模式

启动脚本的 `-PermissionMode` 默认 `workspace-write`，意味着 agent 只能在项目目录里写文件。

`danger-full-access` 会**关闭审批**，agent 可以直接执行任意命令。除非你完全清楚后果，
否则不要在开放网络上用这个模式。

## 报告漏洞

如果你发现了安全问题，请**不要**开公开 Issue，直接通过 GitHub 的
[私密漏洞报告](../../security/advisories/new) 功能联系维护者。
