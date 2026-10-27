/**
 * 网络通信安全：地址校验。
 *
 * ## 为什么需要这个
 *
 * Android 的 `network-security-config` 必须允许明文（局域网就是 http），
 * 但它**不支持 CIDR 网段**，没法只对私有地址放行。
 *
 * 所以真正的边界放在这里：**明文 HTTP 只允许发往私有地址**。
 * 公网地址必须用 https。
 *
 * ## 为什么这条规则有意义
 *
 * 攻击场景：如果 App 某处拼错域名、或者被注入一个 `http://evil.com` 链接，
 * token 会明文发到公网。有了这个校验，那种请求在发出去之前就被拦下。
 *
 * 正常使用不受影响：
 *   · 局域网 `http://192.168.x.x:3095` → 私有地址，放行
 *   · Tailscale `http://100.x.x.x:3095` → CGNAT 段，放行
 *   · 隧道 `https://xxx.trycloudflare.com` → 本来就是 https，放行
 *   · 模拟器 `http://10.0.2.2:3095` → 私有地址，放行
 */

/** 判断一个 IPv4 字面量是否属于私有/保留地址 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts;

  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 —— Tailscale / 运营商级 NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 169.254.0.0/16 —— 链路本地（模拟器、直连网线）
  if (a === 169 && b === 254) return true;
  // 127.0.0.0/8 —— 回环
  if (a === 127) return true;
  // 0.0.0.0
  if (a === 0) return true;

  return false;
}

/** 这些主机名视为本机/内网 */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '10.0.2.2', // Android 模拟器访问宿主机
]);

/**
 * 判断这个 baseUrl 是否安全可用。
 *
 * 规则：
 *   · https → 永远可以
 *   · http  → 只允许私有地址 / localhost
 *   · 其他协议 → 不允许
 *
 * @returns null 表示可以；否则返回给用户看的错误原因
 */
export function checkBaseUrlSecurity(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return '地址格式不对';
  }

  const proto = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();

  if (proto === 'https:') return null;

  if (proto !== 'http:') {
    return `不支持的协议 ${proto}（只接受 http 或 https）`;
  }

  // http 只允许私有地址
  if (LOCAL_HOSTNAMES.has(host)) return null;

  // IPv4 字面量
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return isPrivateIPv4(host)
      ? null
      : `拒绝用明文 HTTP 连接公网地址 ${host}。请改用 https，或用局域网/Tailscale 地址。`;
  }

  // IPv6 回环
  if (host === '[::1]' || host === '::1') return null;

  // 其他域名：http 一律拒绝
  return (
    `拒绝用明文 HTTP 连接公网域名 ${host}。\n` +
    '公网访问请用 https（例如 Cloudflare 隧道），或者改用局域网 / Tailscale 地址。'
  );
}

/** 这个地址是不是明文 HTTP（用于在界面上给提醒） */
export function isPlainHttp(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol.toLowerCase() === 'http:';
  } catch {
    return false;
  }
}

/** 这个地址是不是公网（用于显示「已加密 / 未加密」提示） */
export function isPublicHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (LOCAL_HOSTNAMES.has(host)) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !isPrivateIPv4(host);
    return true;
  } catch {
    return true;
  }
}

/**
 * 发请求前的强制校验：不合格就抛错，请求根本不发出去。
 *
 * ## 为什么需要这个（而不只是 `checkBaseUrlSecurity`）
 *
 * `checkBaseUrlSecurity()` 只在**两个入口**被调用过：
 *   · `DshConnection.loginWithToken()`（配对时）
 *   · `PairScreen`（用户填地址时）
 *
 * 但真正带凭据发请求的地方远不止这两处：
 *   · `DshConnection.call()` —— 所有 HTTP RPC，带 Cookie
 *   · `DshConnection.ensureSocket()` —— 会话流 WS
 *   · `UploadApi` / `fileUrl` —— 带 Cookie 上传和下载
 *   · `deviceAuth` / `serverIdentity` —— 带 Cookie 查设备和撤销
 *   · `ApprovalGateway.requestPairingCode()` —— 带 Cookie 换配对码
 *
 * 于是「明文只发私有网段」这条规则实际上是**入参时刻的策略**，不是
 * **出口时刻的强制**。任何一条新加的裸 fetch、或者一个由旧版本/备份写进
 * `@dsh/baseUrl` 的公网 `http://` 地址，都会绕过它 —— 正是这条规则要防的场景。
 *
 * 这个函数就是出口时刻的那道闸：所有发请求的地方都调它。
 */
export function assertSecureUrl(url: string, what = '请求'): void {
  const insecure = checkBaseUrlSecurity(url);
  if (insecure) {
    throw new Error(`${what}被拒绝：${insecure}`);
  }
}

/**
 * 把可能含敏感信息的 URL 变成可安全显示/记录的文本。
 *
 * 用于错误提示和日志：`http://ip:3095/?token=xxx` → `http://ip:3095/?token=***`
 */
export function redactUrl(text: string): string {
  return String(text ?? '')
    // 查询串里的 token / key / secret
    .replace(/([?&](?:token|key|secret|password|auth|code)=)[^&\s"'<>]+/gi, '$1***')
    // Cookie 值
    .replace(/(Cookie:\s*)[^\s;]+/gi, '$1***')
    // 形如 dsh-auth-xxx=v1.xxx 的 cookie
    .replace(/(dsh-auth-[\w-]+=)[^\s;]+/gi, '$1***')
    // 裸的长 token（40+ 字符的 base64url），避免误伤普通文本，要求前后是边界
    .replace(/\b[A-Za-z0-9_-]{43,}\b/g, '***');
}

/**
 * 脱敏后的错误消息。
 *
 * 所有给用户看、或可能进日志的错误信息都应该过一遍这个，
 * 防止 token 通过异常文本泄露。
 */
export function safeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return redactUrl(raw);
}
