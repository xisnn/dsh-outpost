/**
 * 服务端身份绑定：把「服务端设备 UUID」和「它是哪台服务器给的」绑在一起。
 *
 * ## 解决什么问题
 *
 * `gatewayServerDeviceId`（服务端注册表主键 UUID）之前是**全局凭据**：
 * 只存了 UUID，没存它是哪台服务器分配的。于是下面这些场景会出错：
 *
 *   1. 用户把 DSH 地址从电脑 A 改成电脑 B
 *      → Keychain 里还是 A 的 UUID → 拿它去打 B
 *   2. 电脑 A 重装 DSH / 重装网关插件
 *      → 设备注册表被重建，旧 UUID 在 A 上也不存在了，但本地还留着
 *   3. 同一个 IP 换了机器（DHCP 重新分配）
 *      → baseUrl 字符串完全一样，但已经是另一台服务器
 *
 * 这三种情况的表现是同一条：撤销请求打过去得到 **404**。
 * 而 `revokeOwnDevice()` 把 404 归类成 `already-gone`（「本来就没有」），
 * 上层当成撤销成功 —— 用户看到「已撤销」，而**新服务器上这台设备的
 * 授权其实还在**，手机丢了也踢不掉。
 *
 * ## 真实服务端有没有可用的实例身份？有
 *
 * 查了插件源码（`dsh-plugin-mobile-gateway`），服务端有两个类似字段，
 * **只有一个能用**：
 *
 * | 字段 | 出处 | 稳定性 | 能不能当身份 |
 * |---|---|---|---|
 * | `gatewayId` | `gateway-state.mjs` 写在独立状态文件里，`write(initial=true)` 用 `linkSync` 保证**永不覆盖**已有身份 | **跨重启、跨设备撤销都稳定** | ✅ 用这个 |
 * | `gatewayInstanceId` | `lib/index.mjs` 里 `crypto.randomUUID()`，每次进程启动重新生成 | **每次重启都变** | ❌ 不能用 |
 *
 * `gatewayId` 出现在四个地方的**线上帧/响应**里：
 *   · `paired` 帧：`{ kind:'paired', token, device:{...}, ...gatewayIdentity }`
 *   · `hello` 帧：`{ kind:'hello', ...gatewayIdentity, device:{...} }`
 *   · `GET /mgw/status`：`{ ...gatewayIdentity, gatewayInstanceId, ... }`
 *   · `POST /mgw/pair`：`{ payload: { ..., ...gatewayIdentity, ... } }`
 *
 * （`gatewayIdentity = { gatewayId, gatewayName }`）
 *
 * 所以「UUID 属于哪台服务器」这个问题**能被真实验证**，不需要虚构字段。
 *
 * ## 绑定的内容
 *
 * ```
 * { v:1, baseUrl, gatewayId, deviceId }
 * ```
 *
 * 三者必须**同时**匹配，才认为这份 UUID 可以用在这台服务器上。
 *
 * ## 保守规则（P1-1 的核心）
 *
 * | 情况 | 结论 | 撤销结果怎么报 |
 * |---|---|---|
 * | 绑定存在，baseUrl + gatewayId 都匹配 | `confirmed` | 服务端结果可信 |
 * | 没有绑定（全新安装 / 老版本升级） | `unbound` | 只能走「列表里找自己」，且 404 **不算**成功 |
 * | 绑定存在但 baseUrl 变了 | `foreign` | **禁止**复用旧 UUID；404 不算成功 |
 * | 绑定存在但 gatewayId 变了 | `foreign` | 同上（服务器重建 / 换机器） |
 * | 只是 baseUrl 相同、绑定里没有 gatewayId | `assumed` | baseUrl 相同**不等于**同一台服务器，404 不算成功 |
 * | 读绑定失败 / 数据损坏 | `unverifiable` | fail-closed，404 不算成功 |
 *
 * ⚠️ 「baseUrl 相同」绝不能证明是同一台服务器 —— DHCP 会把同一个 IP
 * 分给另一台机器，用户也可能把新机器配成同一个地址。
 *
 * ⚠️ 「服务端返回 404」也绝不能证明当前设备已经安全撤销 —— 它同样
 * 可能只是「这个 UUID 不属于这台服务器」。只有 `confirmed` 时，
 * 404 才能被解释成「本来就没有」。
 *
 * ## 协议限制（诚实说明）
 *
 * 老版本插件（或不带 `gatewayId` 的自建/模拟网关）不会发这个字段。
 * 那种情况下绑定只能退化到 `assumed`（仅 baseUrl），**不满足**
 * 「确认身份」的强度。我们选择：仍然允许撤销请求发出去（否则老用户
 * 永远撤不掉），但**拒绝把 404 报成成功** —— 宁可让用户去电脑上确认，
 * 也不能给出一个假的「已撤销」。
 *
 * 这不是过度设计：绑定只多存一个 JSON 对象，撤销时多一次字符串比较。
 */

import { CredentialKey, clearCredential, loadCredential, saveCredential } from './secureStore';

/** 绑定记录的存储结构版本 */
const BINDING_VERSION = 1;

/**
 * 一份「服务端设备 UUID ↔ 服务器身份」的绑定。
 *
 * 不含任何秘密（URL + 两个标识符），但和 device id 一起存在 Keystore，
 * 「彻底清除授权」时一并清掉（见 secureStore.clearAllCredentials）。
 */
export interface ServerDeviceBinding {
  v: number;
  /** 这台服务器的主地址（已归一化） */
  baseUrl: string;
  /**
   * 服务端实例标识（插件的 `gatewayId`）。
   *
   * `null` 表示**当时也没拿到**（老版本插件不带这个字段）——
   * 这种绑定的强度只有 `assumed`，不足以把 404 解释成「本来就没有」。
   */
  gatewayId: string | null;
  /** 服务端注册表里的设备 UUID */
  deviceId: string;
  /** 写入时间（诊断用） */
  at: number;
}

/**
 * 绑定解析结果 —— 判别联合，不要退回成布尔值。
 *
 * 每一种都对应不同的撤销语义，混成一个 boolean 就又回到
 * 「404 被当成撤销成功」那个坑里。
 */
export type BindingResolution =
  /** 绑定存在，且 baseUrl + gatewayId 都匹配 —— 服务端结果可信 */
  | { kind: 'confirmed'; deviceId: string; gatewayId: string }
  /** 没有绑定：全新安装，或从没有 gatewayId 的老版本升级上来 */
  | { kind: 'unbound'; reason: string }
  /** 绑定属于**别的**服务器（换了地址 / 服务器重建 / 绑定里的 gatewayId 不同） */
  | { kind: 'foreign'; reason: string; boundBaseUrl: string; boundGatewayId: string | null }
  /** baseUrl 相同但绑定里没有 gatewayId（老协议）——「大概同一台」，无法确认 */
  | { kind: 'assumed'; deviceId: string; reason: string }
  /** 读不到 / 数据损坏 —— **不可当作没有绑定**，也不可当作确认 */
  | { kind: 'unverifiable'; reason: string };

/**
 * 归一化服务器地址，用于比较。
 *
 * 只做安全的等价变换：去尾部斜杠、scheme/host 小写、去掉默认端口。
 * **不**做「同 IP 就认为同一台」这种推断 —— 那正是要防的。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  let out = trimmed.replace(/\/+$/, '');
  try {
    const u = new URL(out);
    const scheme = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase();
    // URL 会把默认端口丢掉（http:80 / https:443），这里保持它的一致行为
    const port = u.port ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '');
    out = `${scheme}//${host}${port}${path}`;
  } catch {
    // 不是合法 URL：只做去斜杠 + 小写，别抛错（撤销路径不该因地址格式崩）
    out = out.toLowerCase();
  }
  return out;
}

/** 从任意帧/响应里安全取出 gatewayId（可能是 undefined / 非字符串） */
export function readGatewayId(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const v = (source as { gatewayId?: unknown }).gatewayId;
  return typeof v === 'string' && v ? v : undefined;
}

/** 从任意帧里安全取出 `device.id`（服务端 UUID） */
export function readServerDeviceId(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const dev = (source as { device?: unknown }).device;
  if (!dev || typeof dev !== 'object') return undefined;
  const id = (dev as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : undefined;
}

/** 查服务端实例标识的超时（毫秒）—— 和撤销请求保持同一量级 */
const STATUS_TIMEOUT_MS = 5000;

/**
 * 问服务端「你是哪个实例」—— `GET /mgw/status` 的 `gatewayId`。
 *
 * ## 为什么需要主动问
 *
 * 绑定里记了 `{ baseUrl, gatewayId, deviceId }`，但那只是**上次**连接时
 * 服务端自报的身份。撤销的时候我们需要知道**现在**这台服务器是谁，
 * 才能判断「存下来的 UUID 是不是它给的」。
 *
 * 正常情况下网关会一直连着、hello 帧不断刷新身份，但撤销场景往往是
 * 「网关已经断开 / 从没连上过」，这时只能主动问一次。
 *
 * ## 失败怎么办
 *
 * 返回 `undefined`，**不抛错、不重试**。调用方会把「拿不到当前身份」
 * 当成 `assumed`（无法确认），于是 404 不会被采信 —— 安全方向是对的。
 * 不能因为查身份失败就把撤销整个堵死：用户仍然应该能清掉本地凭据，
 * 只是界面要如实说「服务端那边没能确认」。
 *
 * @returns gatewayId；拿不到返回 undefined
 */
export async function fetchServerGatewayId(
  baseUrl: string,
  cookie?: string,
): Promise<string | undefined> {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return undefined;
  // normalizeBaseUrl 产出的是 «scheme»//host[:port][/path]，
  // 拼 path 时要注意它已经去掉了尾斜杠，这里直接接上去即可。
  const url = `${base}/mgw/status`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS);
    let res: Response;
    try {
      // React Native 的 fetch 使用原生 cookie 容器；显式 Cookie 头在部分 RN
      // 版本会被忽略/拒绝，因此 RN 侧依赖 credentials:'include'，Node 侧
      // 仍用显式 Cookie 头保证真实 DSH 探针可认证。
      const isReactNative =
        typeof navigator !== 'undefined' &&
        (navigator as { product?: string }).product === 'ReactNative';
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          ...(cookie && !isReactNative ? { Cookie: cookie } : {}),
          // RN 的 fetch 对 Cookie/Origin/Referer 等浏览器受控头支持不一致；
          // RN 侧依靠原生 cookie 容器（credentials: include），不设置这些头。
          ...(!isReactNative
            ? {
                Origin: baseUrl.replace(/\/+$/, ''),
                Referer: `${baseUrl.replace(/\/+$/, '')}/`,
              }
            : {}),
        },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) return undefined;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return undefined;
    }
    return readGatewayId(json);
  } catch {
    // 网络不通 / 超时 / 明文 HTTP 被拦 —— 都只是「问不到」，不是错误
    return undefined;
  }
}

/** 把绑定序列化成存储值（字段顺序固定，便于断言与排错） */
function serialize(b: ServerDeviceBinding): string {
  return JSON.stringify({
    v: b.v,
    baseUrl: b.baseUrl,
    gatewayId: b.gatewayId,
    deviceId: b.deviceId,
    at: b.at,
  });
}

/**
 * 读取当前已持久化的服务端绑定快照。
 *
 * 与 `resolveBinding()` 的区别：这里不比较“当前连接地址”，只返回上次
 * 配对/连接时保存的真实绑定，供 P0-1 的发送身份绑定使用。读失败或格式
 * 非法时返回 `undefined`，调用方必须按“身份不可用”拒绝，而不是猜。
 */
export async function readServerBindingSnapshot(): Promise<ServerDeviceBinding | undefined> {
  let raw: string | undefined;
  try {
    raw = await loadCredential(CredentialKey.gatewayServerBinding);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const parsed = value as Partial<ServerDeviceBinding>;
    const baseUrl = typeof parsed.baseUrl === 'string' ? normalizeBaseUrl(parsed.baseUrl) : '';
    const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : '';
    const gatewayId =
      typeof parsed.gatewayId === 'string' && parsed.gatewayId ? parsed.gatewayId : null;
    if (parsed.v !== BINDING_VERSION || !baseUrl || !deviceId) return undefined;
    return {
      v: BINDING_VERSION,
      baseUrl,
      gatewayId,
      deviceId,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * 保存绑定，并**回读校验**。
 *
 * Keystore 在部分设备上会「返回成功但实际没写」，所以写入后必须读一次
 * 确认内容一致。校验失败按失败返回，调用方不能当成绑定成功。
 *
 * @returns true = 已确认落盘
 */
export async function saveServerBinding(input: {
  baseUrl: string;
  gatewayId?: string | null;
  deviceId: string;
}): Promise<boolean> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const deviceId = String(input.deviceId ?? '');
  if (!baseUrl || !deviceId) return false;

  const record: ServerDeviceBinding = {
    v: BINDING_VERSION,
    baseUrl,
    gatewayId: input.gatewayId ? String(input.gatewayId) : null,
    deviceId,
    at: Date.now(),
  };
  const encoded = serialize(record);

  try {
    await saveCredential(CredentialKey.gatewayServerBinding, encoded);
  } catch {
    return false;
  }

  // 回读校验：写进去必须原样读得出来
  try {
    const back = await loadCredential(CredentialKey.gatewayServerBinding);
    if (back !== encoded) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * 读绑定并解析成「相对当前服务器」的结论。
 *
 * @param currentBaseUrl 现在要操作的服务器地址
 * @param currentGatewayId 现在这台服务器自报的 gatewayId（还没连过就不传）
 *
 * ⚠️ 读失败返回 `unverifiable`，**不是** `unbound`。
 * 这两者的区别就是 P0-1 里「读不到 ≠ 没有」的同一条原则：
 * 把读失败当成「没有绑定」，等于把「可能是别的服务器的 UUID」当成
 * 「可以放心用」。
 */
export async function resolveBinding(
  currentBaseUrl: string,
  currentGatewayId?: string,
): Promise<BindingResolution> {
  let raw: string | undefined;
  try {
    raw = await loadCredential(CredentialKey.gatewayServerBinding);
  } catch {
    return { kind: 'unverifiable', reason: '读不到服务端身份绑定' };
  }

  // 没有绑定：全新安装 / 老版本升级
  if (!raw) return { kind: 'unbound', reason: '本机没有记录过服务端身份' };

  let parsed: Partial<ServerDeviceBinding>;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { kind: 'unverifiable', reason: '服务端身份绑定格式不合法' };
    }
    parsed = v as Partial<ServerDeviceBinding>;
  } catch {
    return { kind: 'unverifiable', reason: '服务端身份绑定无法解析' };
  }

  const boundBaseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '';
  const boundDeviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : '';
  const boundGatewayId =
    typeof parsed.gatewayId === 'string' && parsed.gatewayId ? parsed.gatewayId : null;

  if (parsed.v !== BINDING_VERSION || !boundBaseUrl || !boundDeviceId) {
    return { kind: 'unverifiable', reason: '服务端身份绑定字段不完整' };
  }

  const now = normalizeBaseUrl(currentBaseUrl);

  // ── 1. 地址不同 → 肯定是别的服务器 ──────────────────────────
  if (now !== boundBaseUrl) {
    return {
      kind: 'foreign',
      reason: '服务地址已经变了',
      boundBaseUrl,
      boundGatewayId,
    };
  }

  // ── 2. 地址相同，再比 gatewayId ─────────────────────────────
  //
  // gatewayId 是判定「是不是同一台服务器」的关键。baseUrl 相同只能说明
  // 「有个服务器在这个地址上」，说明不了它是同一台。
  if (boundGatewayId && currentGatewayId) {
    if (boundGatewayId === currentGatewayId) {
      return { kind: 'confirmed', deviceId: boundDeviceId, gatewayId: boundGatewayId };
    }
    return {
      kind: 'foreign',
      reason: '同一地址上的服务器实例已经变了（注册表可能已重建）',
      boundBaseUrl,
      boundGatewayId,
    };
  }

  // ── 3. 有一边缺 gatewayId → 只能「假定」─────────────────────
  //
  // 老版本插件不发 gatewayId。此时无法确认身份，但也不能因此让老用户
  // 完全撤不掉授权 —— 所以允许发请求，但**禁止**把 404 读成成功
  // （那正是「新的服务器上记录还在」被误报成撤销成功的地方）。
  if (!boundGatewayId || !currentGatewayId) {
    return {
      kind: 'assumed',
      deviceId: boundDeviceId,
      reason: boundGatewayId
        ? '服务端这次没有自报实例标识'
        : '绑定里没有服务端实例标识（老版本协议）',
    };
  }

  // 理论上不可达（上面两个分支已覆盖），保守收口
  return { kind: 'unverifiable', reason: '服务端身份无法判定' };
}

/**
 * 判断「服务端确认不存在」这个结论能不能被采信。
 *
 * 只有 `confirmed` 能。
 *
 * 为什么单独抽出来：这条规则是 P1-1 的核心，将来任何人想放宽它都
 * 应该先看到这段说明 —— 404 有两个完全不同的含义：
 *   a) 这台设备之前确实撤销过（服务端没这条记录了）→ 可以算成功
 *   b) 这个 UUID 根本不是这台服务器给的 → 服务端上记录**还在**
 *
 * 只有确认了「UUID 属于这台服务器」，404 才只可能是 (a)。
 */
export function canTrustNotFound(resolution: BindingResolution): boolean {
  return resolution.kind === 'confirmed';
}

/**
 * 撤销时能不能直接把存下来的 UUID 发出去。
 *
 * `foreign` 明确禁止：那是在拿 A 的 UUID 去打 B，最坏情况是误伤
 * B 上一条 UUID 恰好相同的记录（概率极低，但「不确认就不动手」是原则）。
 *
 * `unverifiable` 也禁止：不知道这个 UUID 属于谁，就不该拿它去做
 * 破坏性操作。调用方此时应退回「从当前服务器的列表里找自己」。
 */
export function mayUseStoredDeviceId(resolution: BindingResolution): boolean {
  return resolution.kind === 'confirmed' || resolution.kind === 'assumed';
}

/** 清除绑定（「彻底清除授权」时用；clearAllCredentials 也会清） */
export async function clearServerBinding(): Promise<boolean> {
  try {
    await clearCredential(CredentialKey.gatewayServerBinding);
  } catch {
    return false;
  }
  // 回读确认真的没了 —— 删不掉的绑定会让下次启动继续用错的 UUID
  try {
    const back = await loadCredential(CredentialKey.gatewayServerBinding);
    return !back;
  } catch {
    return false;
  }
}
