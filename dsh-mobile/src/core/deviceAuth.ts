/**
 * 设备授权管理（服务端撤销 + 设备列表）。
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
 * ## ⚠️ 三个限制
 *
 * 1. **必须带同源 Origin/Referer**
 *    服务端有 CSRF 保护：非 GET 请求要 `isSameOrigin(req)`。
 *    RN 的 fetch 默认不带 Origin，所以要手动加 —— 否则返回 403
 *    「cross-origin management request rejected」。
 *
 * 2. **只撤销「自己」需要 id 映射**
 *    服务端的 device.id 是它自己生成的 UUID，客户端存的是
 *    `dsh-outpost-xxx` 这种客户端标识（走 clientDeviceId 字段）。
 *    直接用客户端 id 拼 URL 会 404。
 *
 * 3. **列表失败 ≠ 空列表**
 *    这一点曾经写错过：`listPairedDevices()` 失败时返回 `[]`，
 *    界面就把「网络不通」显示成「还没有设备配对过」。
 *    用户看到的是「我的设备都没了」，实际上只是请求失败。
 *    现在返回明确的联合类型，错误和空列表彻底分开。
 *
 * 4. **404 ≠ 已经撤销**
 *    服务端返回 404 只说明「这个 UUID 在它的注册表里没有」，有两种
 *    完全不同的原因：设备确实撤销过，或者这个 UUID 根本是**另一台**
 *    服务器给的。后者意味着当前服务器上这台设备的授权**还在**。
 *    所以必须先确认 UUID 与服务器的归属关系 —— 见 core/serverIdentity.ts
 *    和 `revokeOwnDeviceDetailed()`。
 */

import {
  canTrustNotFound,
  fetchServerGatewayId,
  mayUseStoredDeviceId,
  resolveBinding,
} from './serverIdentity';

/** 服务端返回的设备条目 */
export interface PairedDevice {
  id: string;
  name: string;
  displayName?: string;
  createdAt?: number;
  lastSeenAt?: number | null;
  online?: boolean;
  connections?: number;
  /** 客户端自己生成的稳定标识（用来认出「这台手机」） */
  clientDeviceId?: string;
}

/**
 * 撤销结果（**粗粒度**，保留给旧调用方）。
 *
 * ⚠️ 这个三值联合有一处会丢失信息：`already-gone` 既可能是
 * 「服务端确认这条记录不存在」，也可能是「这个 UUID 不属于这台服务器」。
 * 新代码请用 `revokeOwnDeviceDetailed()` —— 它返回判别联合，
 * 把「确认撤销」「确认不存在且身份匹配」「撤销失败」「无法确认」彻底分开。
 */
export type RevokeOutcome =
  /** 撤销成功 */
  | 'revoked'
  /** 服务端已经没有这条记录（可能之前撤销过） */
  | 'already-gone'
  /** 网络/鉴权问题，或**无法确认**设备身份 —— 都没撤销成功 */
  | 'failed';

/**
 * 撤销的**精确**结果（P0-2 / P1-1 用）。
 *
 * 为什么要单独一套：`RevokeOutcome` 的三个字符串承载不了下面这些
 * 真正不同的情况，而它们对用户的含义完全不同 ——
 *
 *   · 确认撤销成功      → 可以告诉用户「已经撤掉了」
 *   · 确认本就不存在    → 同上（幂等），但**必须先确认设备身份**
 *   · 撤销失败          → 必须提示「电脑上的授权还在」
 *   · 无法确认          → 也必须提示，且不能声称成功
 *
 * 把它们压成一个布尔或三值枚举，就是「把撤销失败报成成功」的来源。
 */
export type RevokeDetail =
  /** 服务端明确返回 revoked:true */
  | { kind: 'revoked' }
  /**
   * 服务端确认没有这条记录，**且设备身份已确认属于这台服务器**。
   *
   * `how` 说明是靠哪条证据确认的：
   *   · identity     —— 绑定里的 gatewayId 与服务端当前实例一致
   *   · empty-list   —— 服务端列表成功返回且**一台设备都没有**
   */
  | { kind: 'already-gone'; how: 'identity' | 'empty-list' }
  /** 撤销没成功（网络 / 鉴权 / 服务端错误 / 404 但身份无法确认） */
  | {
      kind: 'failed';
      reason:
        | 'network'
        | 'unauthorized'
        | 'server'
        /** 404，但无法确认这个 UUID 属于当前服务器 —— 不能算成功 */
        | 'not-found-unverified'
        /** 响应体不可信（200 但解析不出来） */
        | 'untrusted-response';
      status?: number;
    }
  /** 根本没发出请求：缺少必要条件 */
  | {
      kind: 'unconfirmed';
      reason:
        | 'no-target'
        | 'missing-base-url'
        | 'missing-cookie'
        | 'identity-unresolved';
    };

/**
 * 列表失败的原因分类。
 *
 * 分开的原因：界面要给不同的提示和不同的下一步动作 ——
 * 「换个网络重试」和「重新配对」完全是两件事。
 */
export type DeviceListErrorKind =
  /** 连不上服务端：断网、超时、DNS、地址不可达 */
  | 'network'
  /** 服务端在，但不认我们的凭据（401/403） */
  | 'unauthorized'
  /** 服务端其它错误（5xx、返回体不合法等） */
  | 'server';

/** 设备列表请求结果 */
export type DeviceListResult =
  | { ok: true; devices: PairedDevice[] }
  | { ok: false; kind: DeviceListErrorKind; status?: number; message: string };

/** 请求超时（毫秒）—— 和网关探测保持一致的量级 */
const LIST_TIMEOUT_MS = 5000;

/**
 * 列出服务端已配对的设备。
 *
 * **不再用空数组表示失败** —— 调用方必须显式处理 `ok: false`。
 */
export async function listPairedDevices(
  baseUrl: string,
  cookie: string | undefined,
): Promise<DeviceListResult> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) {
    return { ok: false, kind: 'network', message: '还没有连接到电脑' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/mgw/devices`, {
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
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        kind: 'unauthorized',
        status: res.status,
        message: '登录状态已失效，需要重新配对',
      };
    }
    if (res.status !== 200) {
      return {
        ok: false,
        kind: 'server',
        status: res.status,
        message: `服务端返回 ${res.status}`,
      };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, kind: 'server', status: res.status, message: '返回内容无法解析' };
    }

    // 两种返回形状都要认：
    //   · 真实网关（management 路由）：{ devices: [...] }
    //   · 网关 WS 侧 / 部分版本：      { payload: { devices: [...] } }
    //
    // ⚠️ `devices: null` 也要当成「空列表」而不是「服务端出错」。
    // 有些序列化路径会把空集合写成 null（Go 的 nil slice、Java 的 null
    // collection 都是这样）。把它报成 server 错误会让用户看到
    // 「电脑那边出错了」，而实际上只是「一台设备都没有」。
    const outer = json as { devices?: unknown; payload?: { devices?: unknown } };
    const pick = (v: unknown): unknown[] | undefined => {
      if (Array.isArray(v)) return v;
      if (v === null) return [];
      return undefined;
    };
    const raw = pick(outer?.devices) ?? pick(outer?.payload?.devices);
    if (!raw) {
      return { ok: false, kind: 'server', status: res.status, message: '返回内容里没有设备列表' };
    }

    const devices = raw.filter(
      (d): d is PairedDevice =>
        !!d && typeof d === 'object' && typeof (d as PairedDevice).id === 'string',
    );
    return { ok: true, devices };
  } catch {
    // 网络层失败：连不上、超时、DNS、明文 HTTP 被系统拦等
    return { ok: false, kind: 'network', message: '连不上电脑，检查网络后重试' };
  }
}

/**
 * 发撤销请求（内部共用），返回**精确**结果。
 *
 * @param targetId **服务端**的 device id（UUID），不是客户端标识
 */
async function postRevokeDetailed(
  baseUrl: string,
  cookie: string | undefined,
  targetId: string,
): Promise<RevokeDetail> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return { kind: 'unconfirmed', reason: 'missing-base-url' };
  if (!targetId) return { kind: 'unconfirmed', reason: 'no-target' };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
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
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 200) {
      let json: { revoked?: boolean } | undefined;
      try {
        json = (await res.json()) as { revoked?: boolean };
      } catch {
        // 200 但响应体解析不了。
        //
        // ⚠️ 这里**不能**乐观当成 'revoked'。
        // 之前那样写，理由是「revoke 是幂等的删记录，服务端确实处理了」。
        // 但 200 + 非 JSON 完全可能是代理/网关返回的错误页（有些 CDN
        // 会把后端 502 包装成 200 的 HTML 错误页）。而 revokeDevice 的
        // 结果直接驱动「从列表移除 + 认为已撤销」这个破坏性动作 ——
        // 乐观方向搞反了代价很大：用户以为踢掉了，实际服务端记录还在。
        //
        // 按失败处理：让用户重试一次。真的撤销成功时重试会得到
        // 404 → already-gone，同样收敛到正确结果。
        return { kind: 'failed', reason: 'untrusted-response', status: 200 };
      }
      // 明确拿到 {revoked:true} 才算撤销成功
      if (json?.revoked === true) return { kind: 'revoked' };
      // 200 但 revoked !== true：等同于「服务端说没有这条记录」。
      // 这里**不**直接下结论 —— 由调用方结合身份解析判断能不能采信。
      return { kind: 'failed', reason: 'not-found-unverified', status: 200 };
    }
    if (res.status === 404) {
      // 404 有两种含义，这里只报告**事实**，能不能采信由调用方决定：
      //   a) 这条设备记录确实不存在了（之前撤销过）→ 可以算成功
      //   b) 这个 UUID 根本不属于这台服务器 → 服务端上记录**还在**
      // 见 core/serverIdentity.ts 的 canTrustNotFound()。
      return { kind: 'failed', reason: 'not-found-unverified', status: 404 };
    }
    if (res.status === 401 || res.status === 403) {
      return { kind: 'failed', reason: 'unauthorized', status: res.status };
    }
    // 5xx / 其它：都是「没撤销成功」，必须让上层如实告知用户
    return { kind: 'failed', reason: 'server', status: res.status };
  } catch {
    return { kind: 'failed', reason: 'network' };
  }
}

/**
 * 把精确结果压成旧的三值枚举（保持旧调用方行为）。
 *
 * `unconfirmed` 归到 `failed`：没确认等于没成功。
 */
function toRevokeOutcome(detail: RevokeDetail): RevokeOutcome {
  if (detail.kind === 'revoked') return 'revoked';
  if (detail.kind === 'already-gone') return 'already-gone';
  return 'failed';
}

/**
 * 撤销本机在服务端的设备授权（**精确结果**，推荐使用）。
 *
 * 语义：让这台设备的长期 token 在服务端失效。
 * 之后即使本地残留了 token 也连不上（服务端 401/4003）。
 *
 * ## 两套 id，别搞混
 *
 *   · `deviceId`       客户端安装标识 `dsh-outpost-xxx`（X-DSH-Device-ID 头）
 *   · `serverDeviceId` 服务端注册表主键 UUID（撤销接口认这个）
 *
 * ## 为什么需要 serverDeviceId
 *
 * `GET /mgw/devices` 返回的条目里**没有**客户端标识 —— 真实插件的
 * `publicDevice()` 只返回 id / name / createdAt / lastSeenAt / online /
 * connections（见 tests/protocol-contract-spec.mjs 的契约测试）。
 *
 * 所以「在列表里按 dsh-outpost-xxx 找自己」这条路在真机上**永远失败**：
 * 找不到 → 返回 already-gone → 上层把它当成撤销成功 → 用户看到
 * 「已撤销」，而服务端记录还在、设备仍然能连、仍然能批命令。
 *
 * 服务端在 `paired` / `hello` 帧里会给它的 UUID（`frame.device.id`），
 * 客户端存进 Keystore 的 `gatewayServerDeviceId`，撤销时直接用。
 *
 * ## P1-1：UUID 必须和「哪台服务器」绑在一起
 *
 * 光有 UUID 不够 —— 它还可能是**另一台**服务器给的：
 *
 *   · 用户把地址从电脑 A 改成电脑 B
 *   · 电脑 A 重装 DSH / 重装插件，注册表被重建
 *   · 同一个 IP 换了机器（DHCP）
 *
 * 这三种情况下拿旧 UUID 去打，服务端都会返回 **404**。而 404 被
 * 归类成 `already-gone`（「本来就没有」）→ 上层当成撤销成功 →
 * 新服务器上这台设备的授权**其实还在**，手机丢了也踢不掉。
 *
 * 所以这里先解析绑定（core/serverIdentity.ts）：
 *
 * | 绑定状态 | 能不能用已存 UUID | 404 能不能算成功 |
 * |---|---|---|
 * | confirmed（baseUrl + gatewayId 都对上） | ✅ | ✅ |
 * | assumed（只有 baseUrl 对上） | ✅ | ❌ |
 * | unbound（没绑定） | 不适用 | ❌（除非列表确认空） |
 * | foreign（属于别的服务器） | ❌ 禁止 | ❌ |
 * | unverifiable（读不到/损坏） | ❌ | ❌ |
 *
 * 「baseUrl 相同」不等于「同一台服务器」；「404」也不等于「已经撤销」。
 *
 * @param deviceId       本机的客户端标识（Keystore 的 gatewayDeviceId）
 * @param serverDeviceId 服务端分配的设备 UUID（Keystore 的 gatewayServerDeviceId）
 */
export async function revokeOwnDeviceDetailed(
  baseUrl: string,
  cookie: string | undefined,
  deviceId: string,
  serverDeviceId?: string,
): Promise<RevokeDetail> {
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return { kind: 'unconfirmed', reason: 'missing-base-url' };
  if (!deviceId && !serverDeviceId) return { kind: 'unconfirmed', reason: 'no-target' };
  if (!cookie) {
    // 没有 Cookie 就没法让服务端认我们 —— 撤销一定做不成。
    // ⚠️ 必须如实报「没发请求」，不能静默跳过再回去报「全部成功」。
    return { kind: 'unconfirmed', reason: 'missing-cookie' };
  }

  // ── 身份绑定解析 ─────────────────────────────────────────────
  //
  // ⚠️ 这里必须**先问服务端现在是谁**（`GET /mgw/status` 的 gatewayId），
  // 不能只拿存储里的绑定自己跟自己比 —— 那样只能发现「地址变了」，
  // 发现不了「同一地址换了服务器 / 注册表被重建」。而后者恰恰是最危险的
  // 一种：baseUrl 一个字符都没变，但服务器内部已经是一张空注册表。
  //
  // 问不到（网络不通 / 老插件没有这个路由 / 没带 gatewayId）就传
  // undefined，解析会退化成 `assumed`，此时 404 不会被采信 —— 方向安全。
  //
  // 读绑定失败 => unverifiable（不是 unbound）。把读失败当成「没绑定」，
  // 就等于把「可能是别的服务器的 UUID」当成「可以放心用」。
  const currentGatewayId = await fetchServerGatewayId(base, cookie);
  const resolution = await resolveBinding(base, currentGatewayId);

  // ── 快路径：直接拿服务端 UUID 撤 ─────────────────────────────
  //
  // 不需要先拉列表。少一次请求，也少一个「列表失败就撤不了」的失败点。
  //
  // ⚠️ 但只有能确认「这个 UUID 是当前服务器的」时才走快路径。
  // `mayUseStoredDeviceId()` 排除了 foreign / unverifiable —— 拿别人的
  // UUID 去执行破坏性操作是绝不能做的事，哪怕概率极低。
  if (serverDeviceId && mayUseStoredDeviceId(resolution)) {
    const direct = await postRevokeDetailed(base, cookie, serverDeviceId);
    if (direct.kind === 'revoked') return direct;
    if (direct.kind === 'failed' && direct.reason === 'not-found-unverified') {
      // 404：只有身份被确认过，才能解释成「本来就没有」。
      if (canTrustNotFound(resolution)) {
        return { kind: 'already-gone', how: 'identity' };
      }
      // 身份没确认 → 这个 404 什么也证明不了。落到下面走列表核对。
    } else if (direct.kind !== 'failed') {
      return direct;
    } else if (direct.reason !== 'network') {
      // 鉴权 / 服务端错误：列表这条路也救不了，直接如实返回。
      return direct;
    }
    // 网络失败 → 落到下面走列表匹配再试一次（列表这条路可能能通）
  }

  // ── 慢路径：在列表里找自己 ───────────────────────────────────
  //
  // 只有在没有可用 serverDeviceId 时才可能成功（比如老版本升级上来、
  // 还没重连过）。客户端标识匹配仍然保留：服务端将来如果开始返回
  // clientDeviceId，这条路会重新生效。
  const listed = await listPairedDevices(base, cookie);

  if (!listed.ok) {
    // ⚠️ 列表失败时**不能**退回「拿 deviceId 直接撤」。
    //
    // 之前这里是 `const devices = await listPairedDevices(...)`，
    // 失败时拿到空数组 → 找不到自己 → 用客户端 id 去撤 → 服务端 404
    // → 被归类成 already-gone（「本来就没有」）→ 上层当成撤销成功。
    // 用户看到「已清除」，实际服务端那条记录还在。
    //
    // 网络/鉴权问题必须如实报 failed，让上层提示「没撤销成功」。
    return {
      kind: 'failed',
      reason: listed.kind === 'unauthorized' ? 'unauthorized' : listed.kind,
      status: listed.status,
    };
  }

  const mine = listed.devices.find((d) => isSameDevice(d, deviceId, serverDeviceId));

  if (!mine) {
    // 列表拿到了但没有自己。
    //
    // ⚠️ 这里**不能**直接返回 already-gone。
    //
    // 「列表里没有自己」有两种可能，必须区分：
    //   a) 之前确实撤销过（服务端没这条记录了）→ already-gone 是诚实的
    //   b) 我们根本认不出自己（服务端不返回 clientDeviceId）→ 记录其实还在
    //
    // 真实插件属于 (b)：列表条目只有 UUID。如果这里返回 already-gone，
    // 上层会提示「撤销成功」，而设备仍在服务端注册表里 —— 手机丢了
    // 的用户以为踢掉了，实际没有。
    //
    // 判据：只有**列表里确实一台设备都没有**时，才能确定「没有可撤的」。
    // 列表非空却找不到自己 → 我们认不出自己 → 如实报 failed。
    //
    // ⚠️ 空列表还要再筛一层：它只证明「**这台**服务器上没有可撤的记录」，
    // 证明不了「所有服务器上都没有」。所以只有在**没有**「来源不明的
    // 已存 UUID」时才能采信：
    //
    //   · 没传 serverDeviceId      → 本机根本没存过任何服务端 UUID，
    //                                没有「另一个服务器上还有记录」的可能 ✓
    //   · confirmed / assumed      → 已存 UUID 可以归到这台服务器 ✓
    //   · foreign                  → 已存 UUID 明确属于**别台**服务器，
    //                                那条记录还在，绝不能报成功 ✗
    //   · unverifiable             → 不知道已存 UUID 属于谁 ✗
    //   · unbound + 传了 serverDeviceId
    //                              → 有一份来源不明的 UUID 在手上 ✗
    if (listed.devices.length === 0) {
      const attributable =
        resolution.kind === 'confirmed' || resolution.kind === 'assumed';
      if (!serverDeviceId || attributable) {
        return { kind: 'already-gone', how: 'empty-list' };
      }
      return { kind: 'failed', reason: 'not-found-unverified' };
    }
    return { kind: 'failed', reason: 'not-found-unverified' };
  }

  const viaList = await postRevokeDetailed(base, cookie, mine.id);
  if (viaList.kind === 'revoked') return viaList;
  if (viaList.kind === 'failed' && viaList.reason === 'not-found-unverified') {
    // 这次我们是从**当前服务器**的列表里拿到的 id，所以这个 404
    // 只可能是「列表之后被别的客户端抢先撤销了」—— 那个 id 是
    // 服务端自己刚告诉我们的，身份问题不存在。
    return { kind: 'already-gone', how: 'identity' };
  }
  return viaList;
}

/**
 * 撤销本机在服务端的设备授权（**粗粒度**，保留给旧调用方）。
 *
 * 内部走 `revokeOwnDeviceDetailed()`，只把「确认类」结果映射成成功。
 *
 * @param deviceId       本机的客户端标识（Keystore 的 gatewayDeviceId）
 * @param serverDeviceId 服务端分配的设备 UUID（Keystore 的 gatewayServerDeviceId）
 */
export async function revokeOwnDevice(
  baseUrl: string,
  cookie: string | undefined,
  deviceId: string,
  serverDeviceId?: string,
): Promise<RevokeOutcome> {
  return toRevokeOutcome(await revokeOwnDeviceDetailed(baseUrl, cookie, deviceId, serverDeviceId));
}

/**
 * 撤销**任意**设备的授权（设备管理页用），返回精确结果。
 *
 * 和 revokeOwnDevice 的区别：这个直接拿服务端返回的 device.id 去撤，
 * 不做 clientDeviceId 匹配 —— 因为管理页拿到的就是服务端 id，
 * 而且是从**当前服务器**的列表里读出来的，不存在跨服务器串号问题。
 */
export async function revokeDeviceDetailed(
  baseUrl: string,
  cookie: string | undefined,
  deviceId: string,
): Promise<RevokeDetail> {
  const detail = await postRevokeDetailed(baseUrl, cookie, deviceId);
  if (detail.kind === 'failed' && detail.reason === 'not-found-unverified') {
    // 管理页的 id 来自当前服务器的列表 —— 404 就是「已经没了」。
    return { kind: 'already-gone', how: 'identity' };
  }
  return detail;
}

/**
 * 撤销**任意**设备的授权（粗粒度，保留给旧调用方）。
 */
export async function revokeDevice(
  baseUrl: string,
  cookie: string | undefined,
  deviceId: string,
): Promise<RevokeOutcome> {
  return toRevokeOutcome(await revokeDeviceDetailed(baseUrl, cookie, deviceId));
}

/**
 * 判断某个设备条目是不是「这台手机」。
 *
 * 抽成纯函数是为了能直接单测。
 *
 * ## 两个 id 都要认
 *
 *   · `selfServerDeviceId` 服务端 UUID —— **主判据**。
 *     真实插件的列表条目只有这个（publicDevice() 不返回客户端标识）。
 *   · `selfDeviceId` 客户端标识 `dsh-outpost-xxx` —— 兜底。
 *     服务端将来如果开始返回 clientDeviceId，这条路会重新生效；
 *     老版本/自建网关也可能返回它。
 *
 * ⚠️ 只靠客户端标识匹配在真机上**永远认不出自己** —— 那不是「可能」，
 * 是已经用真实插件源码验证过的事实（tests/protocol-contract-spec.mjs
 * 和 tests/crosscheck-revoke-self-spec.mjs）。
 */
export function isSameDevice(
  device: Pick<PairedDevice, 'id' | 'clientDeviceId'>,
  selfDeviceId: string | undefined,
  selfServerDeviceId?: string,
): boolean {
  // 服务端 UUID 优先：这是列表里真实存在的字段
  if (selfServerDeviceId && device.id === selfServerDeviceId) return true;
  if (!selfDeviceId) return false;
  if (device.clientDeviceId === selfDeviceId) return true;
  // 也接受把 UUID 直接当 selfDeviceId 传进来的旧调用方式
  return device.id === selfDeviceId;
}
