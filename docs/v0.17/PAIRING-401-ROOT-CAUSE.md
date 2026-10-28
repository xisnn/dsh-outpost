# PAIRING-401-ROOT-CAUSE

日期：2026-10-28
项目：`E:\work\dsBot`
分支：`feat/v0.17`
修复提交：`5d38cdf`

## 1. 结论

**P0-1 FINAL: BLOCKED，但 401 的准确位置已定位。**

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

这不会绕过认证；只是防止真实 403/网络错误被变体 token 的 401 掩盖。

## 5. 正确/错误 Token

| 用例 | 结果 |
|---|---|
| 正确新 Token，第一次 Android 交换 | **PASS**：303 + Set-Cookie，跟随 200，Cookie Jar 有 dsh-auth |
| 正确 Token 后续 `/api/session/list`（代理 Host） | 403，原因是代理 Host 未加入 DSH trusted-host，不是 token 失败 |
| 变体错误 Token 第二次登录 | 401（被旧逻辑当成最终错误） |
| 错误 Token App 首次交换（独立） | NOT TESTED |
| 已消费 Token | 源码证明 launch token 不消费；未单独执行 App 用例 |

## 6. Android 配对 / HTTP / WebSocket

- Android 配对：第一次交换 PASS；完整配对仍被测试环境 Host/trust 与我方 UI 自动化阻断，未完成真实 ChatScreen 配对。
- HTTP RPC：代理下 `/api/session/list` 403（Host 未 trusted）；未完成真实 RPC PASS。
- WebSocket：未测试。
- 修复后 debug APK：
  - APK SHA-256：`01A30A444DACCC799A6F2DC0B3A9BBD93A10240E10FA091C4FDED05A7779745F`
  - versionCode 1 / versionName 1.0 / debug 签名
  - 该 APK 用于诊断日志，代码提交 `5d38cdf` 后重新构建；最终仍需重跑。

## 7. 当前 P0-1 剩余阻断项

1. 需要把测试代理 Host 加入 DSH `--trusted-host`，或直接使用 DSH 可信 Host，完成完整配对。
2. 配对后重新验证 `/mgw/status` gatewayId、HTTP RPC、WebSocket。
3. 真实 ChatScreen 文本 accepted/confirmed、unknown 安全重试、force-stop 恢复、图片/文件/混合附件选择器均未完成。
4. 真实磁盘满/256MiB 压力注入仍 NOT TESTED。

## 8. 最小修复结论

- 已确认根因不是 Token 一次性/过期，也不是 Native Cookie Jar 未保存首次 cookie。
- 需要的最小代码修复已完成：PairScreen 不再掩盖 ping 403。
- 仍需修复/配置测试环境 Host trust，然后重新跑真实 App 配对与 ChatScreen 验收。
- 不修改 main、不移动 Tag、不创建 Release。