# PAIRING-401-ROOT-CAUSE

日期：2026-10-28
项目：`E:\work\dsBot`
分支：`feat/v0.17`
修复提交：`5d38cdf`

## 1. 结论

**配对 401 已修复；P0-1 其他真实 App 项仍 BLOCKED。**

- DSH Launch Token **不是一次性**，进程内存活期间可重复匹配；cookie 默认 30 天。
- Android 第一次 Token 交换实际上**成功**：服务端返回 303 + Set-Cookie，跟随重定向返回 200，Native Cookie Jar 读到了 `dsh-auth`。
- 最终 401 不是第一次交换失败，也不是 Cookie Jar 没有保存；而是 **PairScreen 在 `/api/session/list` 返回 403 后，用 token 的 `-`/`_` 变体再次调用 `loginWithToken`，第二次请求没有有效 token，返回 401 并覆盖了真实的 403 错误**。
- 已做最小修复：登录成功后，ping 失败不再回退到变体 token。

## 2. Token 生命周期源码证据

从 DSH `app.asar` 提取的 `dsh-client-connection/lib/index.js`：

| 行号 | 证据 |
|---|---|
| 274 | `DAY_MILLISECONDS = 1440 * 60 * 1e3` |
| 294-299 | `processLaunchToken(owner)` 用 `randomBytes(32)`，按 process owner 缓存在 WeakMap；同进程复用，不产生一次性消费 |
| 330-334 | `tokenMatches()` 只做 timingSafeEqual，不修改/销毁 token |
| 458-478 | `authorizeIndex()` 对 `/?token=` 匹配成功即 303 + Set-Cookie；同一 launch token 可再次匹配 |
| 505-536 | `authorizeConnect()` 同样只匹配，不消费 |
| 1017-1034 | `cookieMaxAgeDays` 默认 30，cookie 有效期 30 天 |

因此主机侧先 GET Token A 不会导致 Token B 失效；401 不能直接归因于 token 一次性或过期。

## 3. 脱敏链路证据

测试环境：独立 DSH 实例 + 主机侧透明 HTTP 代理（只记录路径、Host、Cookie 是否存在、状态码、Set-Cookie 是否存在，不记录值）。

代理日志：

```text
GET  /?token=...        host=10.0.2.2:3098 cookie=no  -> 303 set-cookie=yes
GET  /                  host=10.0.2.2:3098 cookie=yes -> 200
POST /api/session/list host=10.0.2.2:3098 cookie=yes -> 403
GET  /                  host=10.0.2.2:3098 cookie=no  -> 401
```

App 脱敏日志（instrumented debug APK）：

```text
[auth-diag] jar-clear=true
[auth-diag] response status=200
[auth-diag] cookie-manager total=1 dsh-auth=1
[auth-diag] jar dsh-auth=present finalStatus=200
[auth-diag] jar-clear=true
[auth-diag] response status=401
[auth-diag] cookie-manager total=0 dsh-auth=0
[auth-diag] jar dsh-auth=absent finalStatus=401
```

解释：

1. 第一次 `GET /?token=...` 收到 **303 + Set-Cookie**；
2. 跟随重定向的 `GET /` 携带 cookie，返回 **200**；
3. Android Native Cookie Jar 实际保存并读回了 `dsh-auth`；
4. 随后 `POST /api/session/list` 返回 **403**（测试代理 Host `10.0.2.2:3098` 不在 DSH trusted hosts）；
5. `PairScreen` 的候选 token 循环捕获了 ping 的 403，将其当成首个 token 失败，清空 Cookie Jar 并用 `-`/`_` 变体重试；
6. 变体 token 的 `loginWithToken` 返回 **401**，覆盖 `lastErr`，UI 最终只显示 `token exchange failed: HTTP 401`。

## 4. 准确发生位置

`dsh-mobile/src/screens/PairScreen.tsx` 原逻辑：

```text
for candidate:
  loginWithToken(candidate)
  ping()
  → 任何异常都 catch: lastErr=e; cookie=undefined
```

因此第一个正确 token 成功、ping 403 后，下一次候选 token 的 401 成为最终错误。

修复提交 `5d38cdf`：

```text
for candidate:
  loginWithToken(candidate)
  → 只有 login 失败才 continue
  ping()
  → ping 失败直接抛出，不再尝试变体 token
```

回归测试提交 `9b641da`（`pairing-spec` 13/13）覆盖该行为：登录成功后的 ping 403/超时不得触发 token 变体重试，不能以后续 401 覆盖原始错误。

这不会绕过认证；只是防止真实 403/网络错误被变体 token 的 401 掩盖。

## 5. 正确/错误 Token

| 用例 | 结果 |
|---|---|
| 正确新 Token，第一次 Android 交换 | **PASS**：303 + Set-Cookie，跟随 200，Cookie Jar 有 dsh-auth |
| 正确 Token 后续 `/api/session/list`（代理 Host） | 403，原因是代理 Host 未加入 DSH trusted-host，不是 token 失败 |
| 变体错误 Token 第二次登录 | 401（被旧逻辑当成最终错误） |
| **正确 Token 直连 `127.0.0.1:3097`（adb reverse）完整配对** | **PASS**：首次 303 + Set-Cookie → 200；`/api/session/list` 成功；首页出现 2 个会话 |
| 错误 Token App 首次交换（独立） | NOT TESTED |
| 已消费 Token | 源码证明 launch token 不消费；未单独执行 App 用例 |

## 6. Android 配对 / HTTP / WebSocket

- Android 配对：**PASS**。修复后直接使用 `127.0.0.1:3097` + `adb reverse`（不经代理），首次交换 200、Cookie Jar 有 dsh-auth、`/api/session/list` 成功、首页加载 2 个会话。
- HTTP RPC：**PASS**（`session/list`、`session/create`、`session/page`）。
- WebSocket：**PASS**（真实 ChatScreen 接收模型运行事件并显示“进行中/继续中”）。
- 修复后 debug APK：
  - APK SHA-256：`1C0E51D3408E7AF93F2026AE08F42DE17E9B40F9B836D9F68CA2D092C1A5C59A`
  - versionCode 1 / versionName 1.0 / debug 签名
  - 该 APK 用于功能验收，不可作为正式发布包。

## 7. 当前 P0-1 剩余阻断项

1. 真实 ChatScreen unknown 安全重试（force-stop 发送未成功落地，尚未获得 unknown UI）。
2. 真实 ChatScreen force-stop 后持久化恢复。
3. App 附件选择器图片/文件/混合发送。
4. `/mgw/status` 的完整 App 侧 gatewayId 记录、错误 Token App 首次交换用例。
5. 真实磁盘满/256MiB 压力注入仍 NOT TESTED。

真实 ChatScreen 文本已 PASS：消息 `P0-1finaltext`，服务端 user rpcId `req-mvs8lr4r-1-1en7ldl1lf720s`，1 条用户消息；截图 `P0-1-FINAL-CHATSCREEN-TEXT.png`。

## 8. 最小修复结论

- 已确认根因不是 Token 一次性/过期，也不是 Native Cookie Jar 未保存首次 cookie。
- 需要的最小代码修复已完成：PairScreen 不再掩盖 ping 403；真实 App 直连配对已通过。
- 仍需完成真实 ChatScreen unknown/force-stop 和附件选择器验收，才能评估 P0-1 COMPLETE。
- 不修改 main、不移动 Tag、不创建 Release。