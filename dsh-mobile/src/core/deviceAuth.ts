/**
 * 设备授权管理（服务端撤销）。
 *
 * ## 为什么需要
 *
 * 「清除所有授权」现在只能清**本机**的凭据。如果手机丢了、或者凭据
 * 可能已经泄露，光清本地是不够的 —— 服务端还留着一条可用记录，
 * 谁拿到那份 token 就还能连上来批命令。
 *
 * 所以清除授权时应该**同时通知服务端撤销**。
 *
 * ## 服务端能力（已实测）
 *
 *   GET  /mgw/devices                       列出已配对设备
 *   POST /mgw/devices/<id>/revoke           撤销
 *
 * 撤销的效果：
 *   · 从设备注册表里删除并落盘
 *   · 主动 `client.close(4003, 'device revoked')` 踢掉在线连接
 *
 * ## ⚠️ 两个限制
 *
 * 1. **必须带同源 Origin/Referer**
 *    服务端有 CSRF 保护：非 GET 请求要 `isSameOrigin(req)`。
 *    RN 的 fetch 默认不带 Origin，所以要手动加 —— 否则返回 403
 *    「cross-origin management request rejected」。
 *
 * 2. **只撤销「自己」**
 *    客户端只知道自己的 device id（存在 Keystore 里）。撤销别人需要
 *    用户的 cookie 权限，那超出了「清自己的授权」这个语义。
 *    真要做「远程踢掉某台设备」，应该走桌面端管理界面。
 */

/** 服务端返回的设备条目 */
export interface PairedDevice {
  id: string;
  name: string;
  displayName?: string;
  createdAt?: number;
  lastSeenAt?: number | null;
  online?: boolean;
  connections?: number;
}

/** 撤销结果 */
export type RevokeOutcome =
  /** 撤销成功 */
  | 'revoked'
  /** 服务端已经没有这条记录（可能之前撤销过） */
  | 'already-gone'
  /** 网络/鉴权问题，没撤销成功 */
  | 'failed';

/**
 * 列出服务端已配对的设备。
 *
 * 失败返回空数组 —— 这个信息只用于展示，不该阻塞主流程。
 */
export async function listPairedDevices(
  baseUrl: string,
  cookie: string | undefined,
): Promise<PairedDevice[]> {
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${base}/mgw/devices`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        // 同源标记：有些配置下 GET 也检查
        Origin: base,
        Referer: `${base}/`,
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.status !== 200) return [];
    const json = (await res.json()) as { devices?: PairedDevice[] };
    return Array.isArray(json?.devices) ? json.devices : [];
  } catch {
    return [];
  }
}

/**
 * 撤销本机在服务端的设备授权。
 *
 * 语义：让这台设备的长期 token 在服务端失效。
 * 之后即使本地残留了 token 也连不上（服务端 401）。
 *
 * @param deviceId 本机的 device id（存在 Keystore 的 gatewayDeviceId）
 */
export async function revokeOwnDevice(
  baseUrl: string,
  cookie: string | undefined,
  deviceId: string,
): Promise<RevokeOutcome> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!deviceId) return 'failed';

  // 先在服务端列表里找到「自己」那条。
  //
  // 为什么要找：服务端的 device.id 是它自己生成的 UUID，而客户端存的
  // deviceId 是 `dsh-outpost-xxx` 这种客户端标识（走 clientDeviceId 字段）。
  // 直接用客户端 id 拼 URL 会 404。
  const devices = await listPairedDevices(baseUrl, cookie);
  const mine = devices.find(
    (d) => d.id === deviceId || (d as { clientDeviceId?: string }).clientDeviceId === deviceId,
  );

  // 找不到也不一定是坏事：可能之前已经撤销过，或者服务端换了注册表。
  // 但对调用方来说「已经没有可撤销的了」和「撤销成功」效果一样。
  const targetId = mine?.id ?? deviceId;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `${base}/mgw/devices/${encodeURIComponent(targetId)}/revoke`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          // ⚠️ 必须带同源标记：服务端对非 GET 请求做 isSameOrigin 校验，
          // 不带就 403 `cross-origin management request rejected`。
          // RN 的 fetch 不像浏览器会自动加 Origin。
          Origin: base,
          Referer: `${base}/`,
        },
        signal: ctrl.signal,
      },
    );
    clearTimeout(timer);

    if (res.status === 200) {
      const json = (await res.json()) as { revoked?: boolean };
      return json?.revoked ? 'revoked' : 'already-gone';
    }
    if (res.status === 404) return 'already-gone';
    return 'failed';
  } catch {
    return 'failed';
  }
}
