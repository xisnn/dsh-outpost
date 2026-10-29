# P0-3 Cookie、认证与连接状态一致性验收报告

日期：2026-10-29
分支：`feat/v0.17`
前置基线：`c897257`（P0-1 COMPLETE）、`f62813b`（P0-2 PASS）
测试 APK：`dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk`
APK SHA-256：`56E1092BDF3527CE35E2E7A11C73F8264661DF0B564ADA3EDA61F0609C00C627`
模拟器：`dsh_verify`（`emulator-5584`）+ 隔离 DSH 实例（`127.0.0.1:3097`）

---

## 1. 凭据同步与生命周期检查及修复

1. **Keychain ↔ Android `CookieManager` ↔ HTTP RPC ↔ WebSocket 凭据同步**：
   - 在 `src/core/cookieJar.ts` 中新增 `syncNativeCookieJar(baseUrl, cookieHeader)`：先清除当前 `baseUrl` 下旧的 `dsh-auth*` Cookie，再写入当前生效的 Cookie；
   - 在 `App.tsx` 的冷启动自动恢复（`autoResume`）、手动恢复（`resumePairing`）和首次/重新配对（`saveCookie`）中均调用 `syncNativeCookieJar()`；
   - 在 `ApprovalGateway.requestPairingCode()` 与 `probeServerGatewayId()` 中显式传入 `Cookie` 请求头（以及同源 `Origin`/`Referer`），确保不因原生 `CookieManager` 异步刷新延迟而出现不一致；
   - 在 `DshConnection.call()` 中检测成功响应的 `set-cookie` 头，当服务端轮换 `dsh-auth` Cookie 时自动更新 `this.cookie` 并同步到 `CookieManager`；
   - 新增 `DshConnection.setCookie()` 与 `Store.syncCookie()`：当凭据更新或退出清空时，立即调用 `resetSocket()` 关闭旧 WebSocket 并终止旧流，避免旧连接继续使用旧身份。

2. **401（凭据失效）与 403（`trustedHosts` / Origin 限制）精确区分**：
   - DSH 服务端（`dsh-client-connection`）仅在 Cookie/Token 无效或缺失时返回 `401`；而 `403` 来自 `isTrustedApiRequest()`（Host 未列入 `trustedHosts` 或跨源请求），**此时本地 Cookie 仍然有效**；
   - 更新 `src/core/rpc-error.ts`：`isAuthFailure()` 仅匹配明确 `401 / unauthorized`，新增 `isForbiddenRejection()` 单独识别 `403 / forbidden`；
   - 更新 `src/core/transport/index.ts`、`src/core/protocol.ts`、`src/core/store.ts` 与 `src/screens/PairScreen.tsx`：遇到 `403` 时明确提示 `服务地址未被允许访问（HTTP 403：Host 未列入 trustedHosts），当前登录凭据仍保留`，**绝不清除 Keychain 凭据，也不误报“登录凭据已失效”**。

3. **旧连接、迟到回调、旧 Store 隔离与防无限重连循环**：
   - 在 `App.tsx` 中增加 `useEffect(() => () => store.close(), [store])`：当 `baseUrl` 或 `cookie` 变化重建 `Store` 时，自动关闭旧 `Store`（停止后台 `noticeScan` 定时器、审批网关及所有会话流重连定时器）；
   - 在 `PairScreen.tsx` 中增加 `connectSeq` 请求序号防护，防止旧的并发/迟到配对回调覆盖新状态；
   - 在 `Store` 中新增 `authInvalidated` 终止态：当 HTTP RPC 或 WebSocket 遇到 `401` 或 `403` 时，立即调用 `markAuthTerminal()` 停止后台 `noticeScan` 轮询和所有会话流重连定时器，避免无效请求风暴；并在 RN 环境下通过轻量探针确保 WebSocket 握手被 401 拒绝时能可靠收敛到终止态。

---

## 2. 自动化测试结果

新增 `dsh-mobile/tests/cookie-auth-state-consistency-spec.mjs`（`npm run test:authConsistency`），**3/3 PASS**：

1. `Cookie 同步与轮换：syncNativeCookieJar 清理旧 Cookie 并写入新 Cookie；HTTP 响应 Set-Cookie 自动轮换内存与原生容器` — **OK**
2. `401 与 403 精确区分：403（trusted-host 限制）不当作凭据失效，且 401/403 均停止无效轮询与重连循环` — **OK**
3. `重新配对、凭据更新与退出登录：syncCookie 重置旧 WebSocket，旧流迟到回调不覆盖新状态，恢复后不重复订阅或重复发消息` — **OK**

全量单元测试与回归门禁全部通过：
- `npm run test:authConsistency`：**3/3 PASS**
- `npm run test:wsReconnect`（P0-2）：**5/5 PASS**
- `npm run test:cookiejar`：**29/29 PASS**
- `npm run test:loginintent`：**22/22 PASS**
- `npm run test:pairing`：**13/13 PASS**
- `npm run test:compat`：**20/20 PASS**
- `npm run test:chaterror`：**10/10 PASS**
- `npm run test:pendingSendWiring`：**5/5 PASS**
- `npm run test:pendingSendStore` / `test:pendingSendFlow` / `test:pendingSendAttachments`：**15/15、9/9、23/23 PASS**
- `npm run typecheck`：**PASS**

---

## 3. 真实 Android 模拟器（`dsh_verify`）端到端验收证据

1. **配对 → 断开连接（保留凭据）→ App 重启状态一致性 → 直接继续恢复**：
   - 在 `dsh_verify`（`emulator-5584`）配对连接 `http://127.0.0.1:3097` 成功；
   - 进入「我的」页面点击「断开连接」确认断开，随后执行 `adb shell am force-stop com.dshpocket` 并重新启动 App；
   - 重启后 App 稳定停在配对页，不自动登录，且保留 Keychain 凭据并显示「上次的配对还在 · 直接继续」卡片（截图：[P0-3-SIGNED-OUT-RESUME-CARD.png](P0-3-SIGNED-OUT-RESUME-CARD.png)）；
   - 点击「直接继续」，验证通过并同步 `CookieManager`，直接恢复进入工作区首页。
2. **服务端 Cookie 失效（HTTP 401）→ 停止重连与轮询并明确提示**：
   - 轮换隔离 DSH 3097 的 `client-connection/browser-session` 密钥后重启服务，使 App 持有的旧 Cookie 失效（返回 `HTTP 401`）；
   - App 立即停止后台轮询与无效重连循环，界面清晰显示 `加载失败：登录凭据已失效。请在电脑上重新获取带 token 的链接，回到配对页重新连接。`（截图：[P0-3-AUTH-401-STOPPED.png](P0-3-AUTH-401-STOPPED.png)）。
3. **重新配对恢复 → 发送消息不重复订阅、不重复执行任务（P0-1 & P0-2 不回归）**：
   - 断开连接并使用新进程的 launch token 重新配对；
   - 进入会话 `session-a35e6f54-98fc-4896-a046-22b44ad0072a` 发送消息 `P03_RePaired_OK`；
   - `adb logcat` 与服务端 `session/page` 确认仅产生单次订阅与单条用户消息（`seq=9, rpcId=req-mvtb9qhv-1-0mo0qql1j7ie0e`），客户端顺利进入 `confirmed` 并完成 Keychain 未决记录清理：
     ```text
     10-29 08:58:53.320 I ReactNativeJS: [p0-verify] sending requestId=req-mvtb9qhv-1-0mo0qql1j7ie0e attachments=0
     10-29 08:59:00.288 I ReactNativeJS: [p0-verify] confirmed requestId=req-mvtb9qhv-1-0mo0qql1j7ie0e
     10-29 08:59:09.057 I ReactNativeJS: [p0-verify] pruned-from-keychain requestId=req-mvtb9qhv-1-0mo0qql1j7ie0e
     SERVER_AFTER_REPAIR: AS_OF_SEQ=23 USER_MESSAGES=1
     USER_MSG seq=9 rpcId=req-mvtb9qhv-1-0mo0qql1j7ie0e text=P03_RePaired_OK
     ```
   - 重新配对恢复后发送并确认的真实 UI 截图：[P0-3-REPAIRED-CONFIRMED.png](P0-3-REPAIRED-CONFIRMED.png)

---

## 4. 结论

**P0-3 PASS**
