/**
 * 审批授权的「本地撤销状态」。
 *
 * ## 解决什么问题
 *
 * 用户在这台手机上主动撤销自己的设备授权后，本地只是没了 gateway token。
 * 但 `ApprovalGateway.connect()` 的逻辑是「没有 token 就向服务端申请配对码」，
 * 而申请配对码用的是**仍然有效的会话 Cookie** —— 于是：
 *
 *   撤销授权 → 网关重连 → 自动申请配对码 → 配对成功 → 设备重新获得审批权
 *
 * 也就是说「撤销」这个动作会在几秒内被自己撤销掉。服务端那边确实删了
 * 旧记录，但立刻又建了一条新的，用户看到的是「撤销了但没生效」。
 *
 * 根因是「没有 token」被当成了「需要配对」，而这两种状态必须区分：
 *
 *   · 没有 token，但用户从没撤销过 → 首次使用，应该自动配对
 *   · 没有 token，且用户主动撤销过 → **必须等用户再次明确授权**
 *
 * ## 三态，不是布尔值
 *
 * 撤销标记存在 AsyncStorage 里。**读存储这件事本身会失败**：
 * 磁盘满、系统正在清理、进程被杀在写入中途、文件损坏……
 * 这些情况下「读不到」不等于「没撤销」。
 *
 * 所以状态是三个，不是一个布尔值：
 *
 *   · `not-revoked`  存储读取成功，且确认没有撤销标记  → 允许自动配对
 *   · `revoked`      存储读取成功，且撤销标记有效      → **禁止**自动配对
 *   · `unknown`      读失败 / 数据损坏 / 存储不可用    → **禁止**自动配对，等存储恢复
 *
 * `unknown` 绝不能被当成 `not-revoked`。这是一个 fail-open：
 *
 *   用户撤销自己 → 服务端撤销请求失败（serverOk=false）→ 本地标记是唯一屏障
 *   → 下次启动存储抖动一下 → 程序认为「没撤销过」→ 自动申请配对码
 *   → 设备重新获得审批权限。而这次**没有** 4003 会来兜底，因为服务端
 *     根本没删掉那条记录 —— 屏障从头到尾只有本地这一个。
 *
 * 之前这里读失败就返回 `NOT_REVOKED`，注释写的理由是「最坏情况多连一次，
 * 服务端仍会 4003 拒绝」。那句话只在「服务端撤销成功」时成立。
 *
 * ## 怎么实现
 *
 * 一个持久化的标记（AsyncStorage，不是秘密，不需要进 Keychain）：
 *
 *   置位：用户撤销自己 / 服务端以 4003 + 'device revoked' 踢掉我们
 *   清除：用户主动执行授权流程（重新扫码配对、或点「重新授权」）
 *
 * 标记只在**用户明确动作**时清除，网络恢复、重连、切前后台都不会清。
 * 这样「Cookie 依然有效」也不会绕过用户的撤销决定。
 *
 * ## 与 Cookie 的关系
 *
 * 撤销审批授权**不等于**退出登录：
 *   · Cookie 继续用（聊天、看会话不受影响）
 *   · 只是不再自动建立审批连接
 *
 * 这是有意的 —— 用户撤销的是「这台手机能批准命令执行」，
 * 不是「这台手机不能用了」。
 *
 * ## 真正的保证，以及它的边界（P0-1）
 *
 * 撤销标记是**本地唯一屏障**（服务端撤销失败时没有 4003 兜底），
 * 所以它不能只写一处：
 *
 *    · 主通道：AsyncStorage `@dsh/approvalRevoked`
 *    · 降级通道：Keystore `CredentialKey.revocationMarker`
 *
 * 两个通道都是**写后回读校验**：写进去必须读得出来、且内容一致，
 * 才算持久化成功。`markApprovalRevoked()` 的返回值会如实说明落到了
 * 哪个通道（`persisted`）、是否只在本进程内存里有效（`memoryOnly`）。
 * 调用方**必须**检查它 —— 写失败不能提示「已撤销并保存」。
 *
 * 读取同样是双通道的（`loadRevocationState()`）：
 *   · 任一通道给出**确认的**标记      → `revoked`
 *   · 两个通道都**读取成功且确认没有** → `not-revoked`
 *   · 其余（读失败 / 数据损坏 / 通道不可用） → `unknown`（禁止自动配对）
 *
 * ⚠️ **这条保证的上限**：如果 AsyncStorage 和 Keystore **同时**不可用，
 *   跨重启的拦截就**无法保证** —— 标记写不进任何地方，下次启动读到的
 *   只会是「没有标记」。这种情况下代码能做的是：
 *     1. 本次运行仍把内存状态保持为 `revoked`（不自动配对）
 *     2. 照常删除 gateway token + 历史明文副本（少一份可用凭据）
 *     3. 把失败**报告给调用方**（`ok:false` / `persisted:'none'`），
 *        由界面明确警告「重启后撤销可能失效」
 *   缺了第 3 步，用户会以为撤销成功，而设备重启后会静默重新配对 ——
 *   那才是真正危险的失败模式。
 *
 * 另一个已知边界：`secureStore.loadCredential()` 把「Keystore 读失败」
 * 映射成 `undefined`（和「没有这个值」无法区分）。所以当它返回空值时，
 * 这里会再用 `isSecureStorageAvailable()` 探一次通道是否可读 —— 探不通
 * 就按 `unknown` 处理，绝不把「读不到」当成「没有」。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CredentialKey,
  clearCredential,
  isSecureStorageAvailable,
  loadCredential,
  saveCredential,
} from './secureStore';
import { clearLegacyCredentialStorage } from './credentialMigration';

/**
 * 撤销标记的**主**存储键（AsyncStorage）。
 *
 * 这个键本身不含凭据，所以主副本放 AsyncStorage 就行。但「主」不等于
 * 「唯一」：AsyncStorage 写失败时，标记会落到 Keystore
 * （`CredentialKey.revocationMarker`）作为降级通道。
 */
const REVOKED_KEY = '@dsh/approvalRevoked';

/** 撤销原因（只用于界面文案，不参与安全判断） */
export type RevocationReason =
  /** 用户在这台手机上撤销了自己 */
  | 'self-revoked'
  /** 服务端主动踢掉（4003 device revoked） */
  | 'server-revoked'
  /** 用户执行了「退出并清除所有授权」 */
  | 'cleared';

/**
 * 撤销状态的三种取值。
 *
 * ⚠️ 不要退回成 `boolean` —— 那样「读失败」只能被迫归到两边之一，
 * 归哪边都错：归「已撤销」会让所有老用户失去审批功能（存储抖一下就废），
 * 归「未撤销」就是上面说的 fail-open。
 */
export type RevocationStatus =
  /** 读成功，确认没有撤销标记 */
  | 'not-revoked'
  /** 读成功，确认撤销标记有效 */
  | 'revoked'
  /** 读失败 / 数据损坏 / 存储不可用 —— **不可当作未撤销** */
  | 'unknown';

export interface RevocationState {
  /** 三态结论（安全判断只看这个） */
  status: RevocationStatus;
  /** `status === 'revoked'` 的便捷写法（界面与旧调用方用） */
  revoked: boolean;
  /** 撤销时间戳 */
  at?: number;
  reason?: RevocationReason;
}

/**
 * 撤销标记的持久化结果（`markApprovalRevoked()` 的返回值）。
 *
 * ## 为什么要返回对象而不是 void
 *
 * 「撤销了」是三件**互相独立**的事，UI 要能分别告诉用户：
 *
 *   1. `ok`        标记是否**确认写进了**至少一个持久化存储（写后回读校验通过）
 *   2. `persisted` 落在哪个通道：`async-storage` / `secure-store` / `none`
 *   3. `memoryOnly` 是否**只在本进程内存里有效**（重启后可能失效）
 *
 * 三种典型界面文案：
 *
 *   · `ok:true,  memoryOnly:false`  → 「已撤销（已保存）」
 *   · `ok:false, persisted:'none'`  → 「已撤销（本次运行有效，但没能写入存储，
 *                                      重启后可能失效）」← **必须警告用户**
 *   · 存储整体不可用（连内存态也保不住时由调用方结合
 *     `loadRevocationState()` 的 `unknown` 判断）→「无法确认撤销状态」
 *
 * ⚠️ `ok:false` 绝不等于「撤销失败」—— 内存态仍然是 `revoked`，本次运行
 *    仍然拒绝自动配对。它等于「**重启后**可能不再拦得住」，所以必须让
 *    用户知道，而不是静默当成功。
 */
export interface RevocationPersistResult {
  /** 是否已确认写入至少一个持久化存储（回读校验通过） */
  ok: boolean;
  /** 标记落在哪个存储；`none` 表示两个存储都没写成功 */
  persisted: 'async-storage' | 'secure-store' | 'none';
  /** 标记是否只在本进程内存里有效（重启后会丢） */
  memoryOnly: boolean;
  /**
   * 失败原因（只在 `ok === false` 时出现）。
   *
   * ⚠️ 只描述**类别**（哪个存储、哪一步失败），绝不含凭据值。
   * `ok === true` 时**不会**有这个字段 —— 避免 UI 把「降级通道生效」
   * 误当成失败来渲染。
   */
  error?: string;
}

const NOT_REVOKED: RevocationState = { status: 'not-revoked', revoked: false };
const UNKNOWN: RevocationState = { status: 'unknown', revoked: false };

/**
 * 标记的结构版本。
 *
 * v2 = 双通道 + 回读校验（P0-1）。v1 的数据没有 `v` 字段，但结构
 * 兼容（同样是 `{revoked:true, at, reason}`），读取时按「有 revoked:true
 * 就算标记存在」处理 —— 不能因为版本号高一点就把老用户的撤销决定作废。
 */
const MARKER_VERSION = 2;

/** 落在存储里的标记形状 */
interface RevocationMarker {
  v: number;
  revoked: true;
  at: number;
  reason: RevocationReason;
}

/**
 * 一次「读某个通道」的结果。
 *
 * ⚠️ 关键：`absent`（读成功、确认没有）和 `unusable`（读不出来 / 数据
 * 无法识别）**必须分开**。合并成 `undefined` 就是 fail-open 的起点 ——
 * 那正是 P0-1 要消灭的东西。
 */
type MarkerRead =
  | { kind: 'absent' }
  | { kind: 'marker'; at?: number; reason?: RevocationReason }
  | { kind: 'unusable'; error: string };

/** 把存储里读到的原始串解析成三态结果 */
function parseMarker(raw: string | null | undefined): MarkerRead {
  // 空/不存在 = 读成功，明确没有标记
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 不是合法 JSON：可能是写了一半（崩溃/掉电），也可能被别的东西覆盖了。
    return { kind: 'unusable', error: 'marker is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unusable', error: 'marker is not an object' };
  }

  const obj = parsed as { revoked?: unknown; at?: unknown; reason?: unknown };

  // 只有明确的 `revoked: true` 才算已撤销。
  // 我们自己只会写 revoked:true（清除时是删键），所以「能解析成对象但不是
  // revoked:true」说明这份数据不是我们写的 —— 无法识别，按未知处理。
  if (obj.revoked !== true) {
    return { kind: 'unusable', error: 'marker does not say revoked:true' };
  }

  return {
    kind: 'marker',
    at: typeof obj.at === 'number' ? obj.at : undefined,
    reason: obj.reason as RevocationReason | undefined,
  };
}

/** 读主通道（AsyncStorage） */
async function readMarkerFromAsyncStorage(): Promise<MarkerRead> {
  try {
    return parseMarker(await AsyncStorage.getItem(REVOKED_KEY));
  } catch {
    return { kind: 'unusable', error: 'async-storage read failed' };
  }
}

/**
 * 读降级通道（Keystore / Keychain）。
 *
 * ⚠️ 这里有一个必须补的洞：`secureStore.loadCredential()` 把
 * **「读失败」和「没有这个值」都映射成 `undefined`**（它的注释写的是
 * 「Keystore 读失败当作没有」）。对凭据来说那个取舍可以接受，对撤销标记
 * 不行 —— 那正好会把「读不到」说成「没撤销」。
 *
 * 所以拿到 `undefined` 之后**再探一次通道可用性**：
 *   · 探测成功 → 确实没有标记（`absent`）
 *   · 探测失败 → 通道不可读（`unusable`）→ 上层结论会是 `unknown`
 */
async function readMarkerFromSecureStore(): Promise<MarkerRead> {
  let raw: string | undefined;
  try {
    raw = await loadCredential(CredentialKey.revocationMarker);
  } catch {
    return { kind: 'unusable', error: 'secure-store read failed' };
  }

  if (raw === undefined || raw === '') {
    let available = false;
    try {
      available = await isSecureStorageAvailable();
    } catch {
      available = false;
    }
    return available
      ? { kind: 'absent' }
      : { kind: 'unusable', error: 'secure-store unavailable (probe failed)' };
  }

  return parseMarker(raw);
}

/** 回读校验：写进去的那份必须原样读得出来（时间戳 + 原因都一致） */
function sameMarker(a: RevocationMarker, b: RevocationMarker): boolean {
  return a.revoked === b.revoked && a.at === b.at && a.reason === b.reason;
}

/** 写主通道 + 回读校验 */
async function writeMarkerToAsyncStorage(
  serialized: string,
  marker: RevocationMarker,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await AsyncStorage.setItem(REVOKED_KEY, serialized);
  } catch {
    return { ok: false, error: 'async-storage write failed' };
  }
  let back: string | null;
  try {
    back = await AsyncStorage.getItem(REVOKED_KEY);
  } catch {
    return { ok: false, error: 'async-storage read-back failed' };
  }
  const parsed = parseMarker(back);
  if (parsed.kind !== 'marker') {
    return { ok: false, error: 'async-storage read-back has no usable marker' };
  }
  const backMarker: RevocationMarker = {
    v: MARKER_VERSION,
    revoked: true,
    at: parsed.at ?? 0,
    reason: parsed.reason ?? marker.reason,
  };
  return sameMarker(marker, backMarker)
    ? { ok: true }
    : { ok: false, error: 'async-storage read-back mismatch' };
}

/** 写降级通道 + 回读校验 */
async function writeMarkerToSecureStore(
  serialized: string,
  marker: RevocationMarker,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await saveCredential(CredentialKey.revocationMarker, serialized);
  } catch {
    return { ok: false, error: 'secure-store write failed' };
  }
  const back = await readMarkerFromSecureStore();
  if (back.kind === 'marker') {
    const backMarker: RevocationMarker = {
      v: MARKER_VERSION,
      revoked: true,
      at: back.at ?? 0,
      reason: back.reason ?? marker.reason,
    };
    return sameMarker(marker, backMarker)
      ? { ok: true }
      : { ok: false, error: 'secure-store read-back mismatch' };
  }
  return {
    ok: false,
    error:
      back.kind === 'unusable'
        ? `secure-store read-back unusable (${back.error})`
        : 'secure-store read-back is empty',
  };
}

/**
 * 把标记写进**至少一个**存储（写后回读校验）。
 *
 * 顺序：先主通道 AsyncStorage，失败再降级到 Keystore。
 * **不做重试循环** —— 存储故障通常在毫秒级不会自愈，重试只会拖慢撤销；
 * 而撤销路径上「慢」本身就是安全问题（用户以为没生效会重复点）。
 *
 * `ok === true` 的充要条件：某个通道**回读校验通过**。
 * 写调用没抛错不算成功 —— 部分设备的 Keystore 会「返回成功但实际没写」。
 */
async function persistMarker(
  serialized: string,
  marker: RevocationMarker,
): Promise<Pick<RevocationPersistResult, 'ok' | 'persisted' | 'error'>> {
  const failures: string[] = [];

  const primary = await writeMarkerToAsyncStorage(serialized, marker);
  if (primary.ok) return { ok: true, persisted: 'async-storage' };
  failures.push(primary.error ?? 'async-storage failed');

  const fallback = await writeMarkerToSecureStore(serialized, marker);
  if (fallback.ok) return { ok: true, persisted: 'secure-store' };
  failures.push(fallback.error ?? 'secure-store failed');

  return {
    ok: false,
    persisted: 'none',
    error: `撤销标记未能持久化（${failures.join('；')}）`,
  };
}

/**
 * 内存缓存。
 *
 * 网关每次重连都会问一次，AsyncStorage 是异步的 —— 缓存一份避免
 * 重连路径上多一次 IO。写入时同步更新缓存，保证「撤销后立刻生效」。
 *
 * ⚠️ **只有拿到确定结论（not-revoked / revoked）才进缓存**。
 * `unknown` 永远不缓存 —— 缓存了就等于把「暂时读不到」钉死成
 * 一个进程级的结论，存储恢复后也不会再读（要求 5：存储恢复后应允许
 * 重新读取状态）。
 */
let cached: RevocationState | null = null;

/**
 * 读当前撤销状态。
 *
 * 返回值一定是三态之一，**绝不会**把「读不到」说成「没撤销」。
 *
 * 判定流程（双通道，fail-closed）：
 *
 *   1. 读 AsyncStorage：拿到**确认的**标记 → `revoked`（不再读降级通道，
 *      省掉一次 Keystore 探测）
 *   2. 否则读 Keystore：拿到确认的标记 → `revoked`
 *   3. 两个通道都**读成功且都确认没有** → `not-revoked`（允许自动配对）
 *   4. 其余任何情况（读失败 / 数据损坏 / 通道不可用）→ `unknown`
 *
 * 第 3 条是这条规则的全部意义：只有**两个**存储都被成功读到、且都没有
 * 标记，才敢说「用户没撤销过」。单独一个存储读成功是不够的 —— 标记可能
 * 正躺在另一个里（比如上次 AsyncStorage 写失败、降级写进了 Keystore）。
 */
export async function loadRevocationState(): Promise<RevocationState> {
  if (cached) return cached;

  const primary = await readMarkerFromAsyncStorage();
  if (primary.kind === 'marker') {
    cached = {
      status: 'revoked',
      revoked: true,
      at: primary.at,
      reason: primary.reason,
    };
    return cached;
  }

  // 主通道没给出确认标记（没读到 / 读不到 / 数据坏了）→ 必须再查降级通道。
  // 「主通道读不到」不等于「没撤销」：上次可能正是主通道写失败才写到
  // Keystore 里的。
  const fallback = await readMarkerFromSecureStore();
  if (fallback.kind === 'marker') {
    cached = {
      status: 'revoked',
      revoked: true,
      at: fallback.at,
      reason: fallback.reason,
    };
    return cached;
  }

  // 两个通道都没有确认的标记。只有**两边都读成功、都确认没有**才算未撤销。
  if (primary.kind === 'absent' && fallback.kind === 'absent') {
    cached = NOT_REVOKED;
    return cached;
  }

  // 至少一个通道读不出来 / 数据无法识别 → 未知（不缓存，下次重读）。
  return UNKNOWN;
}

/**
 * 是否**确认**处于「已撤销」状态（网关 connect 前必查）。
 *
 * ⚠️ 返回 false 不代表「可以自动配对」—— 也可能是 `unknown`。
 * 需要做「能不能自动配对」的判断时，请用 `getApprovalRevocationStatus()`
 * 或直接看 `loadRevocationState().status`。
 */
export async function isApprovalRevoked(): Promise<boolean> {
  const s = await loadRevocationState();
  return s.status === 'revoked';
}

/**
 * 拿三态结论（网关用来决定「能不能自动配对」）。
 *
 * 判定规则（fail-closed）：
 *   · `revoked`     → 不配对
 *   · `unknown`     → 不配对（等存储恢复后重读）
 *   · `not-revoked` → 允许配对
 */
export async function getApprovalRevocationStatus(): Promise<RevocationStatus> {
  const s = await loadRevocationState();
  return s.status;
}

/**
 * 标记「审批授权已被撤销」，并清掉本地设备凭据。
 *
 * 这是**本地**那半边；服务端那半边由调用方（deviceAuth.revokeDevice）
 * 负责。两边都做完才算真的撤销。
 *
 * 清理范围：
 *   · Keychain 里的 gateway token（能在手机上批准命令执行的凭据）
 *   · AsyncStorage 里所有历史明文副本（迁移失败的残留）
 *
 * **刻意保留 device id**（`CredentialKey.gatewayDeviceId`）：
 *
 *   1. 它**不是秘密** —— `secureStore.ts` 里写明「稳定设备 id（不是秘密）」
 *   2. 它是「撤销自己」时在服务端列表里认出本机的唯一线索。
 *      如果在这里就删掉，紧接着的「退出并清除所有授权」会读不到
 *      deviceId → 服务端撤销被静默跳过 → 电脑上留一条可用记录。
 *      （这正是 review 里指出的竞态：4003 的异步清理抢在
 *       clearAuthorization 读 deviceId 之前把值删了。）
 *   3. 用户重新配对时，服务端靠 clientDeviceId 复用同一条设备记录，
 *      不会产生重复行。
 *
 * 真正「彻底清除」时由 `clearAllCredentials()` 一并删掉它。
 *
 * **不动 Cookie** —— 聊天还能继续用，只是审批不再自动连。
 *
 * @returns 持久化结果。⚠️ **调用方必须检查它**：
 *   · `ok:true`                     → 标记已确认落盘，可以提示「已撤销」
 *   · `ok:false, persisted:'none'`  → 本次运行仍拦得住（内存态 revoked），
 *     但**重启后可能失效**，必须警告用户，不能提示成功
 */
export async function markApprovalRevoked(
  reason: RevocationReason,
): Promise<RevocationPersistResult> {
  const marker: RevocationMarker = {
    v: MARKER_VERSION,
    revoked: true,
    at: Date.now(),
    reason,
  };

  // ① 先更新内存缓存：即使后面落盘失败，本次运行期间也绝不自动重连。
  //    这是 P0-1 的另一半 —— 「持久化失败」不能退化成「这次也放行」。
  cached = { status: 'revoked', revoked: true, at: marker.at, reason };

  // ② 双通道持久化 + 回读校验（不做重试循环，见 persistMarker 注释）
  const persisted = await persistMarker(JSON.stringify(marker), marker);

  // ③ 清掉本地可用凭据。注意：这一步和持久化**互相独立** ——
  //    即使标记没写成功，token 也必须删掉（少一份可用凭据）。
  await clearCredential(CredentialKey.gatewayToken);
  await clearLegacyCredentialStorage();

  return {
    ok: persisted.ok,
    persisted: persisted.persisted,
    // 没落盘 → 当前这次运行只靠内存态拦着，重启后会丢
    memoryOnly: !persisted.ok,
    ...(persisted.ok ? {} : { error: persisted.error }),
  };
}

/**
 * 清除撤销标记 —— **只能由用户主动授权流程调用**。
 *
 * 调用点：
 *   · 用户在配对页扫码/粘贴 token 重新配对成功
 *   · 用户在「我的」页点「重新授权审批」
 *
 * 网络恢复、重连、切前后台**都不得**调用它。
 *
 * ## 顺序：先删存储，再清缓存
 *
 * 之前是先 `cached = NOT_REVOKED` 再删存储，删失败时注释写着
 * 「删不掉就保留 —— 下次启动仍然禁止自动配对」。那句话对**下次启动**
 * 成立，但对**当前进程**恰好相反：内存里已经是「未撤销」了，
 * 紧接着的 `connect()` 就会自动配对。
 *
 * 现在改成：存储删成功才清缓存。删失败 → 保持「已撤销」→
 * 用户的重新授权这次没生效，但**不会**变成一个绕过撤销的漏洞。
 * 返回布尔值让 UI 能如实告知。
 *
 * ## P0-1：两个通道都要删，而且都要回读校验
 *
 * 标记可能存在两个地方（AsyncStorage 主通道 / Keystore 降级通道）。
 * 只删一个的后果很具体：
 *
 *   · 上次 AsyncStorage 写失败 → 标记进了 Keystore
 *   · 用户点「重新授权」→ 只删了 AsyncStorage（本来就空）→ 返回 true
 *   · 内存态清了，但**重启后** Keystore 里那份又被读到 → 用户被莫名
 *     拦在「已撤销」，重新授权反复失效
 *
 * 所以：两个通道都删，且都**回读确认真的没了**。任一通道删不掉或无法
 * 确认 → 返回 `false`，并把内存态**保持**为「已撤销」（安全侧优先）。
 *
 * ⚠️ 注意这里和 `loadRevocationState()` 的非对称：读的时候「读不到」
 * 按 `unknown` fail-closed；清的时候「读不到」也按失败处理 —— 因为无法
 * 证明标记已经消失。两者方向一致：不确定就不要放行。
 */
export async function clearApprovalRevoked(): Promise<boolean> {
  const failures: string[] = [];

  // ── 1. 删主通道（AsyncStorage）+ 回读校验 ──────────────────
  try {
    await AsyncStorage.removeItem(REVOKED_KEY);
    const back = await readMarkerFromAsyncStorage();
    if (back.kind === 'marker') failures.push('async-storage marker survived');
    else if (back.kind === 'unusable') {
      // 「读不出来」不能证明删掉了（可能是存储整体坏了）
      failures.push(`async-storage read-back unusable (${back.error})`);
    }
  } catch {
    failures.push('async-storage remove failed');
  }

  // ── 2. 删降级通道（Keystore）+ 回读校验 ───────────────────
  //
  // 必须真的 `clearCredential`，不能只看「读出来是空的」——
  // loadCredential 会把读失败也当成空。
  try {
    await clearCredential(CredentialKey.revocationMarker);
    const back = await readMarkerFromSecureStore();
    if (back.kind === 'marker') failures.push('secure-store marker survived');
    else if (back.kind === 'unusable') {
      failures.push(`secure-store read-back unusable (${back.error})`);
    }
  } catch {
    failures.push('secure-store remove failed');
  }

  if (failures.length > 0) {
    // 删不干净 / 无法确认 → **保持**「已撤销」。
    // 用户会看到「重新授权没生效」，重试一次通常就好了；
    // 反过来（清成未撤销）会让当前进程立刻自动配对，是安全漏洞。
    return false;
  }

  cached = NOT_REVOKED;
  return true;
}

/** 仅用于测试：丢掉内存缓存，强制下次从存储读 */
export function __resetRevocationCache(): void {
  cached = null;
}
