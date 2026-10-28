# PAIRING-401-ROOT-CAUSE

日期：2026-10-28
项目：`E:\work\dsBot`
分支：`feat.v0.17`

## 1. 结论摘要

**P0-1 FINAL: BLOCKED**

- DSH 的 launch token **不是一次性 token**；它是每个 DSH 进程生成一次的 256-bit 随机值，进程存活期间可重复匹配。
- DSH 的 `dsh-auth-*` cookie 默认有效期为 **30 天**（`cookieMaxAgeDays` 默认 30）。
- 本次 401 不能简单归因于“Token 已过期/一次性消费”。
- 使用隔离 DSH 测试实例，**Token B 未在主机侧交换、只交给 Android App 首次配对**，App 仍返回 `token exchange failed: HTTP 401`。
- 当前证据指向 Android App 的 303 重定向 / native Cookie Jar 处理，而不是 Token 本身。未通过关闭认证、硬编码或复用旧 Cookie 绕过。

## 2. Token 生命周期源码证据

源码：`dsh-client-connection/lib/index.js`（从 DSH `app.asar` 提取核对）

| 行号 | 证据 |
|---|---|
| 274 | `DAY_MILLISECONDS = 1440 * 60 * 1e3` |
| 294-299 | `processLaunchToken(owner)` 使用 `randomBytes(32)`，按 process owner 存在 `WeakMap` 中；同一进程复用，不产生一次性消费状态 |
| 330-334 | `tokenMatches(actual, expected)` 是 `timingSafeEqual` 比较，不修改/销毁 token |
| 458-478 | `authorizeIndex()` 对根路径 token 进行匹配，成功后 303 + `Set-Cookie`；可再次匹配同一 launch token |
| 505-536 | `authorizeConnect()` 同样只匹配 launch token，不消费 token |
| 1017-1034 | `cookieMaxAgeDays` 默认 `30`；`maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS` |

结论：

- launch token 生命周期 = 当前 DSH 进程生命周期，不是一次性；
- 主机侧先 GET Token A 不会导致 Token B 失效；
- dsh-auth cookie 默认 30 天有效。

## 3. 独立测试设计

### Token A（仅主机侧）

- 在隔离 DSH 测试实例（独立 profile/state，port 3097，未重启用户 DSH）生成；
- 主机侧 `GET /?token=...` 返回 **303 + Set-Cookie**；
- 说明主机侧链接有效。

### Token B（仅 Android App 首次配对）

- 重启同一隔离 DSH 实例生成全新 token；
- **不在主机侧 curl/fetch/浏览器访问 Token B 的交换 URL**；
- 直接输入 release APK 配对页；
- App 返回 `token exchange failed: HTTP 401`；
- 说明即使 Token B 全新且未消费，App 仍无法完成交换。

测试中未输出、记录或提交任何完整 Token/Cookie。

## 4. 401 的结构性位置

App 代码路径：

```text
DshConnection.loginWithToken(token)
  → clearCookieJar()
  → fetch(baseUrl + '/?token=...', credentials: 'include')
  → 303 自动跟随
  → readCookieFromJar()
  → 若没有 dsh-auth cookie，最终 401
```

源码注释已说明历史误判：303 被自动跟随后的最终 401 不能单独作为 token 失败依据；应先看 cookie jar。本次现象符合：

- 303 已经由 DSH 返回；
- 自动跟随后的请求没有带有效 dsh-auth cookie，被 DSH 返回 401；
- App 把最终 `res.status` 报成 `token exchange failed: HTTP 401`；
- 需要区分 **配对交换失败 / Cookie 保存失败 / Cookie 读回失败 / 后续身份验证失败**。

## 5. 正确/错误 Token 结果

| 用例 | 结果 |
|---|---|
| 主机侧 Token A 直接交换 | HTTP 303 + Set-Cookie（PASS） |
| Android App 使用未消费 Token B | HTTP 401（FAIL） |
| 错误 Token（本轮未单独执行 App 用例） | NOT TESTED |
| 已消费 Token（源码证明 launch token 不消费；未做“已消费”App 用例） | NOT TESTED |

## 6. 是否需要代码修改

**需要，但只应修改认证路径中最小范围。** 当前没有修改认证安全补丁，也没有关闭验证。最小修复方向：

1. 在 release APK 中验证 `@react-native-cookies/cookies` 的 `get(baseUrl)` 能否读到 dsh-auth cookie；
2. 在 `DshConnection.loginWithToken` 中区分“303 已返回”和“最终 401”，并记录（脱敏）cookie jar 状态；
3. 如果 native CookieManager 没有保存 303 的 Set-Cookie，修复原生 cookie 接收/读取路径，而不是跳过 token 交换；
4. 回归正确 Token、错误 Token、旧 Cookie 清理、303 Set-Cookie、HTTP + WebSocket 配对。

本轮没有提交认证修复；修复前 P0-1 保持 BLOCKED。

## 7. 当前 P0-1 剩余阻断项

- 最新 APK 真实配对仍未通过；需要修复/验证 Android 303/native cookie jar。
- 因此真实 ChatScreen 文本 accepted/confirmed、unknown 安全重试、force-stop 恢复、App 附件选择器链路都未完成。
- 真实磁盘满/256MiB 压力注入仍为 NOT TESTED。

## 8. 测试环境

- 模拟器：`dsh_verify`（独立测试 AVD）
- 隔离 DSH：独立 profile/state、port 3097；不重启用户 DSH
- APK：release 测试变体（debug 签名，不可发布）
- 相关证据：`PHASE-3-REAL-DSH-EVIDENCE.md`、`PHASE-4-ACTUAL-CHATSCREEN-FAILED.png`
