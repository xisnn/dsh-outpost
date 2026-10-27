/**
 * DSH Mobile Gateway —— 管理接口认证补丁（受控补丁，非 fork）
 *
 * ## 解决的问题
 *
 * 上游 `dsh-plugin-mobile-gateway`（0.10.3 / 0.11.1 均如此）把 `/mgw/*`
 * 管理路由注册在 **DSH 自己的 web server** 上。这些路由只有两道防线：
 *
 *   1. `adminLoopbackOnly` —— 只允许回环访问
 *   2. `isSameOrigin(req)` —— 非 GET 请求要求 Origin 与 Host 同源
 *
 * 两道的实际强度都不够：
 *
 *   · **回环不可用**。DSH 只接受「一个具体 IP」（`--host 0.0.0.0` 会被 DSH
 *     自己拒绝），绑定局域网 IP 后 127.0.0.1 **根本没有监听**。所以
 *     `adminLoopbackOnly: true` 不是「更安全」，而是让 `/mgw/*` 对所有人
 *     （包括本机桌面助手）都不可达 —— 首次配对直接失效。
 *   · **`isSameOrigin` 对脚本无效**。它的实现是
 *     `if (origin === undefined) return true`，任何非浏览器客户端
 *     （curl / python / 任意进程）不带 Origin 就能通过。
 *
 * 结果是：要保持配对可用就必须 `adminLoopbackOnly: false`，而那样
 * **同网段任何设备都能调用 `POST /mgw/pair` 铸造配对码** —— 无需任何凭据。
 * 配对成功后即为受信设备，可发提示词（agent 在电脑上执行命令）、
 * 切 `permission`（`danger-full-access` 直接关闭审批）、装卸插件。
 * 这不是理论风险：`/mgw/status`、`/mgw/devices`、`/mgw/auth` 在实测中
 * 对不带任何凭据的局域网请求均返回 200。
 *
 * ## 补丁做什么
 *
 * 在每个 `/mgw/*` 请求进入路由分派**之前**，调用 DSH 自己的认证 API：
 *
 *     ctx.connection.requestRejection(req)
 *
 * 这是 DSH 核心对外暴露的公开方法（`Connection` 服务），文档原文：
 *
 *     "Apply Connection's Host/Origin checks and browser authentication
 *      to another Web route."
 *
 * 它内部走 `admit(request)`：
 *
 *     isTrusted(request)   → Host 白名单 + Sec-Fetch-Site + Origin 同源
 *     browserAuth.isAuthenticated(request, secure)  → 校验 dsh-auth-* cookie
 *     browserAuth.authenticateApi(request, secure)  → 或校验 API 凭据
 *
 * 返回 `undefined` 表示放行，返回 401/403 表示拒绝。
 *
 * 也就是说：**补丁把「能不能访问管理接口」这个问题，交给 DSH 自己的
 * 会话认证来回答**，而不是靠来源 IP 或 Origin 这类可伪造/可绕过的信号。
 *
 * ## 为什么这个方案可行（关键前提，逐条验证过）
 *
 * 1. **手机端已经带凭据**：`approvalGateway.ts` 的 `requestPairingCode()`
 *    调用 `/mgw/pair` 时用的是 `credentials: 'include'`，而它在此之前
 *    已经用配对 token 换到了 DSH 的会话 cookie（`loginWithToken`）。
 *    所以正常用户走这条路会**自动带上 cookie**，不需要任何改动。
 * 2. **网页插件已经带凭据**：`client.js` 的 `request()` 用
 *    `credentials: 'same-origin'`，同源请求自然带 cookie。
 * 3. **Host/Origin 校验不会误伤局域网访问**：`isTrustedApiRequest` 接受
 *    「绑定地址本身」作为合法 Host（`isBindAddressAuthority(hostUrl, bindHost)`），
 *    所以手机用 `http://192.168.x.x:3095` 访问是合法的。
 * 4. **没有旁路**：网关自己的 3081 监听器只处理 `/ws/mobile` 的 upgrade，
 *    对任何普通 HTTP 请求返回 404，不存在第二条 `/mgw/*` 路径。
 *
 * ## 保留但降级为「额外一层」的旧防线
 *
 * `adminLoopbackOnly` 的判断原样保留（默认值不动），只是不再是唯一防线。
 * 补丁后即使把 `adminLoopbackOnly` 设为 `false`（配对可用所必需），
 * 未认证请求仍会被 `requestRejection` 拦下。
 *
 * ## 兼容性
 *
 * - 不改变任何 wire 协议、路由路径、响应结构。
 * - 已配对设备：不受影响（它们走 WS，不经过 `/mgw/*`）。
 * - 已安装的网页插件 / 桌面助手：只要请求带 cookie 就照常工作。
 * - DSH 升级：本补丁只依赖 `ctx.connection.admit/requestRejection`，
 *   这两个方法在 DSH 0.2.1-rc.2 起就存在（插件本身已要求 ≥ 该版本）。
 * - 插件升级：补丁以「锚点 + 哈希」方式应用，升级后需重新 apply；
 *   不匹配会**拒绝打补丁**而不是静默跳过。
 */

/**
 * 应用补丁。签名与用法见 `apply.mjs`。
 *
 * @param {string} source 插件 `lib/index.mjs` 的原始内容
 * @returns {string} 打过补丁的内容
 * @throws {Error} 锚点不存在或不唯一时
 */
export function patchManagementAuth(source) {
  if (typeof source !== 'string' || source === '') {
    throw new Error('patchManagementAuth: source must be non-empty string');
  }

  // 幂等：已经打过了就直接返回
  if (source.includes('DSH_OUTPOST_MGW_AUTH_PATCH')) {
    return source;
  }

  const ANCHOR = [
    "          if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {",
  ].join('\n');

  const occurrences = source.split(ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `patchManagementAuth: anchor must appear exactly once, found ${occurrences}. ` +
        'The plugin version changed — re-derive the anchor before patching.',
    );
  }

  // 在 Origin 检查**之前**插入 DSH 会话认证。
  //
  // 顺序为什么重要：requestRejection 同时做 Host/Origin 栅栏与 cookie 校验，
  // 比只查 Origin 更强；放在它后面会先执行一个较弱的检查并提前返回 403，
  // 让「未认证」和「跨源」两类错误混在一起，不利于排查也不利于测试断言。
  const INJECT = [
    '          // ── DSH_OUTPOST_MGW_AUTH_PATCH ────────────────────────────────',
    '          // 把管理接口的访问控制交给 DSH 自己的会话认证（Host/Origin 栅栏',
    '          // + dsh-auth cookie）。见 patches/mobile-gateway-mgmt-auth/README.md。',
    '          //',
    '          // 这一段必须在任何路由分派之前：/mgw/pair 能铸造配对码，',
    '          // 配对成功即为受信设备（可执行命令、关审批、装插件）。',
    '          //',
    '          // 旧的两道防线都不够：adminLoopbackOnly 在「DSH 绑具体 IP」时',
    '          // 会把所有人（含本机）挡掉；isSameOrigin 对不带 Origin 的脚本直接放行。',
    '          try {',
    '            const connection = ctx.connection',
    '            if (typeof connection?.requestRejection !== \'function\') {',
    '              // 拿不到 DSH 认证能力时**必须失败关闭**：宁可管理接口不可用，',
    '              // 也不能在没有认证的情况下继续放行 /mgw/pair。',
    '              sendJson(res, 503, {',
    '                error: \'mgmt-auth-unavailable\',',
    '                message: \'management API requires DSH Connection authentication\',',
    '              })',
    '              return',
    '            }',
    '            const rejection = connection.requestRejection(req)',
    '            if (rejection !== undefined) {',
    '              const unauthorized = rejection === 401',
    '              sendJson(res, rejection, {',
    '                error: unauthorized ? \'unauthorized\' : \'forbidden\',',
    '                message: unauthorized',
    '                  ? \'management API requires an authenticated DSH session\'',
    '                  : \'management API rejected the request authority\',',
    '              })',
    '              return',
    '            }',
    '          } catch (error) {',
    '            // 认证过程本身抛错同样失败关闭',
    '            log(`management auth check failed: ${error && error.message ? error.message : error}`)',
    '            sendJson(res, 503, { error: \'mgmt-auth-error\', message: \'management API authentication failed\' })',
    '            return',
    '          }',
    '',
    ANCHOR,
  ].join('\n');

  return source.replace(ANCHOR, INJECT);
}
