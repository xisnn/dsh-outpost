/**
 * 应用内更新：检查 GitHub Releases 是否有新版本，并下载安装。
 *
 * 流程：
 *   1. GET /repos/{owner}/{repo}/releases/latest  拿到 tag_name 和 apk 下载链接
 *   2. 比较版本号，比当前大就提示用户
 *   3. 用户确认后下载 APK 到缓存目录，校验 SHA-256
 *   4. 用系统安装器打开
 *
 * ## 签名前提（v0.16.7 起已变更）
 *
 * 更新包的签名必须和已安装的一致，否则 Android 会拒绝覆盖
 * （`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）。
 *
 * **历史情况**：v0.16.3 及更早的正式包都用仓库里公开的 debug.keystore 签名。
 * **现在**：正式包改用私有 keystore。这意味着从旧版本升级上来的用户
 * **必须卸载重装**一次 —— 见 `signatureMismatchError()` 对这条路径的处理。
 *
 * 为什么这是必要的：用公开密钥签的包，任何拿到仓库的人都能伪造一个
 * Android 会接受的「更新」。宁可让现有用户重装一次，也不能继续发这种包。
 */
import { Linking, Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { isNewer } from './semver';
import {
  fileNameOfUrl,
  hashMatches,
  resolveExpectedHash,
} from './update-integrity';

const OWNER = 'xisnn';
const REPO = 'dsh-outpost';
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

export interface ReleaseInfo {
  /** 例如 v0.2.0 */
  tag: string;
  /** 去掉 v 的版本号，例如 0.2.0 */
  version: string;
  notes: string;
  /** APK 直链 */
  apkUrl: string;
  apkSize?: number;
  publishedAt: string;
  /** SHA256SUMS.txt 的直链（缺失时为 undefined，见 verifyApkIntegrity 的说明） */
  sumsUrl?: string;
  /** release body 里内联的 APK SHA-256（可选，作为 sums 文件之外的第二个锚点） */
  sha256FromNotes?: string;
}

// 版本比较是纯逻辑，单独放在 semver.ts 里方便单测
export { isNewer, parseVersion } from './semver';

/** 查最新 release；没有 release 或网络失败返回 null */
export async function checkForUpdate(currentVersion: string): Promise<ReleaseInfo | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      tag_name?: string;
      body?: string;
      published_at?: string;
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
    };
    const tag = json.tag_name ?? '';
    const version = tag.replace(/^v/i, '');
    if (!version || !isNewer(version, currentVersion)) return null;

    // 找 release 里的 apk 资产
    const asset = (json.assets ?? []).find((a) => (a.name ?? '').toLowerCase().endsWith('.apk'));
    if (!asset?.browser_download_url) return null;

    // SHA256SUMS.txt 由 CI 生成并随 release 发布（见 android.yml 的
    // "Prepare release files"）。它是**独立于 APK 的第二个文件**，
    // 所以「APK 被替换但 sums 没被替换」这种情况能被发现 ——
    // 但两者都在同一个 GitHub Release 里，所以它挡不住「整个账号被接管」。
    // 这一点在 verifyApkIntegrity 的注释里说清楚，不假装它是完整方案。
    const sums = (json.assets ?? []).find(
      (a) => (a.name ?? '').toLowerCase() === 'sha256sums.txt',
    );

    // release body 里 CI 会写一行 "SHA-256: <64 hex>"（见 android.yml 的 body）
    const body = json.body ?? '';
    const noteHash = /SHA-?256[:\s]+([a-f0-9]{64})/i.exec(body)?.[1];

    return {
      tag,
      version,
      notes: body,
      apkUrl: asset.browser_download_url,
      apkSize: asset.size,
      publishedAt: json.published_at ?? '',
      sumsUrl: sums?.browser_download_url,
      sha256FromNotes: noteHash,
    };
  } catch {
    // 网络问题/限流都当作「没有更新」，不打扰用户
    return null;
  }
}

/**
 * 本地缓存的文件是否完整。
 *
 * 判据：文件存在 **且** 大小等于 release 声明的 size。
 * release 没给 size 时退化成「存在即用」（无法校验，只能信任）。
 */
async function isComplete(path: string, expectedSize?: number): Promise<boolean> {
  try {
    if (!(await ReactNativeBlobUtil.fs.exists(path))) return false;
    if (!expectedSize || expectedSize <= 0) return true;
    const stat = await ReactNativeBlobUtil.fs.stat(path);
    return Number(stat.size) === Number(expectedSize);
  } catch {
    return false;
  }
}

/**
 * 从 SHA256SUMS.txt 里取出指定文件名的哈希。
 *
 * 实现在 `update-integrity.ts`（纯逻辑，可单测）；这里转出保持向后兼容。
 */
export { parseSumsFile, fileNameOfUrl as fileNameOf } from './update-integrity';

/**
 * 校验下载下来的 APK 与 release 声明的 SHA-256 一致。
 *
 * ## 这个校验能防什么、不能防什么（重要，别高估）
 *
 * 能防：
 *   · 传输损坏（半截文件、CDN 截断）—— 这是最常见的真实故障
 *   · 单个 APK 资产被替换（而 SHA256SUMS.txt / release body 没被一起替换）
 *   · 大小相同但内容不同的替换（旧实现只比 size，这种能过）
 *
 * **不能防**：
 *   · GitHub Release 整体被接管（哈希和 APK 都来自同一渠道，攻击者可以
 *     两个一起换）。要真正解决这个问题需要**签名**而不是哈希 ——
 *     即用正式发布证书签名 APK，让 Android 的签名校验成为信任锚。
 *     这正是 P1-1 的另一半（release 必须用正式 keystore，见 build.gradle
 *     与 android.yml 的硬门禁）。
 *
 * 所以本函数是「纵深的一层」，不是「唯一防线」。Android 系统对 APK 签名的
 * 强制校验才是最后一环 —— 前提是正式包用的是**非公开**的签名密钥。
 *
 * @returns 校验通过返回期望的哈希；失败抛错（调用方不得继续安装）
 */
export async function verifyApkIntegrity(
  path: string,
  release: ReleaseInfo,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sha256: string; source: 'sums' | 'notes' }> {
  const apkName = fileNameOfUrl(release.apkUrl);

  // 1. 拉 SHA256SUMS.txt（独立文件，能发现「只换了 APK」）。
  //    拉不到不算失败 —— 交给 resolveExpectedHash 决定能否退到 body 哈希。
  let sumsText: string | undefined;
  if (release.sumsUrl) {
    try {
      const res = await fetchImpl(release.sumsUrl, { headers: { Accept: 'text/plain' } });
      if (res.ok) sumsText = await res.text();
    } catch {
      // 网络问题：下面会退到 release body 的哈希；两者都没有就拒绝安装
    }
  }

  // 2. 决定期望值（纯逻辑，见 update-integrity.ts）
  const expected = resolveExpectedHash({
    sumsText,
    notesHash: release.sha256FromNotes,
    apkFileName: apkName,
  });

  if (!expected) {
    throw new Error(
      '这个版本没有提供可用的 SHA-256 校验信息，无法确认安装包完整性，已拒绝安装。\n' +
        '请稍后重试，或到 Release 页面手动下载。',
    );
  }

  // 3. 算实际哈希（blob-util 走原生实现，不把整个 APK 读进 JS 内存）
  const actual = String(await ReactNativeBlobUtil.fs.hash(path, 'sha256'));

  if (!hashMatches(actual, expected.sha256)) {
    const a = String(actual).toLowerCase();
    throw new Error(
      `安装包校验失败（哈希不匹配），已拒绝安装。\n` +
        `期望 ${expected.sha256.slice(0, 16)}…（来源：${expected.source}），` +
        `实际 ${a.slice(0, 16)}…\n` +
        '可能是下载被篡改或损坏，请重试。',
    );
  }

  return { sha256: expected.sha256, source: expected.source };
}

/** 下载进度：比例 + 已下载/总字节（总大小可能拿不到，那就是 0） */
export interface DownloadProgress {
  ratio: number;
  received: number;
  total: number;
}

/**
 * 下载 APK 并唤起系统安装器。
 * onProgress 会持续收到进度，用于显示「已下载 45.2 MB / 70.1 MB」。
 */
export async function downloadAndInstall(
  release: ReleaseInfo,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const dir = ReactNativeBlobUtil.fs.dirs.CacheDir;
  const path = `${dir}/dsh-outpost-${release.version}.apk`;

  // 缓存能不能用，必须校验大小。
  //
  // 曾经出过这个 bug：网络中断留下一半的 APK，下次点更新时
  // `fs.exists` 为 true 就直接拿去装，系统报
  // 「解析软件包时出现问题 / PackageInfo is null」。
  // 所以这里要求「文件大小 == release 给的 size」，不一致就重新下载。
  const usable = await isComplete(path, release.apkSize);
  if (usable) {
    // 缓存命中：直接给 100%，让 UI 知道「不用等下载」
    onProgress?.({
      ratio: 1,
      received: release.apkSize ?? 0,
      total: release.apkSize ?? 0,
    });
  } else {
    // 先删掉残缺文件，避免 blob-util 往旧文件后面追加
    await ReactNativeBlobUtil.fs.unlink(path).catch(() => undefined);

    const task = ReactNativeBlobUtil.config({
      fileCache: true,
      path,
      // GitHub 的下载链接会 302 到 CDN，blob-util 默认跟随
    }).fetch('GET', release.apkUrl, { Accept: 'application/octet-stream' });

    task.progress({ interval: 200 }, (received, total) => {
      const rx = Number(received);
      // total 有时是 -1（服务器没给 Content-Length），这时用 release.apkSize 兜底
      const tt = Number(total) > 0 ? Number(total) : (release.apkSize ?? 0);
      onProgress?.({
        ratio: tt > 0 ? Math.min(1, rx / tt) : 0,
        received: rx,
        total: tt,
      });
    });

    await task;

    // 下载完再校验一次：网络中途断开时 blob-util 可能不抛错
    if (!(await isComplete(path, release.apkSize))) {
      await ReactNativeBlobUtil.fs.unlink(path).catch(() => undefined);
      throw new Error('安装包下载不完整，请重试');
    }
  }

  // ── 完整性校验（大小对了不代表内容对）────────────────────────
  //
  // 这里才真正验证「这个 APK 就是我发布的那个」。
  // 校验失败必须删文件 + 抛错，绝不能继续进安装器。
  try {
    await verifyApkIntegrity(path, release);
  } catch (e) {
    await ReactNativeBlobUtil.fs.unlink(path).catch(() => undefined);
    throw e;
  }

  // 唤起系统安装界面。
  //
  // 注意：必须传**文件系统路径**，不能带 file:// 前缀。
  // actionViewIntent 内部走 FileProvider.getUriForFile(path)，
  // 带 scheme 会拼成 "/file:/data/..."，报
  // "Failed to find configured root that contains /file:/data/..."。
  //
  // 没授权「安装未知应用」时，系统可能直接抛异常而不是弹授权页，
  // 这里转成带标记的错误，UI 好据此引导用户去设置。
  try {
    await ReactNativeBlobUtil.android.actionViewIntent(
      path,
      'application/vnd.android.package-archive',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 签名不一致：旧版本（公开 debug 证书）升级到新版本（私有证书）时必然发生。
    // Android 只给出一个很晦涩的码（INSTALL_FAILED_UPDATE_INCOMPATIBLE /
    // "signatures do not match"），用户完全看不懂该怎么办 ——
    // 这里翻译成「必须卸载重装」，并说明会丢什么。
    if (/UPDATE_INCOMPATIBLE|signatures? do not match|签名不一致|INSTALL_FAILED_UPDATE/i.test(msg)) {
      throw new SignatureMismatchError(msg);
    }
    if (/permission|denied|install|unknown|not allowed/i.test(msg)) {
      throw new InstallPermissionError(msg);
    }
    throw e;
  }
}

/**
 * 安装包签名与已安装版本不一致 —— 必须卸载重装。
 *
 * ## 为什么会出现
 *
 * v0.16.3 及更早的正式包都用仓库里**公开的** debug.keystore 签名；
 * 现在改用私有 keystore。Android 不允许签名变化的覆盖安装，所以
 * 老用户第一次升到这个版本时会撞上 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。
 *
 * ## 用户会失去什么（必须在 UI 里说清楚）
 *
 * · 会话、任务、工作区文件 —— **不丢**（都在电脑上）
 * · 配对凭据、工作区别名、已删除会话标记、主题设置 —— **会丢**，
 *   重装后重新扫码配对即可恢复绝大部分
 *
 * 另外要提醒：旧设备在电脑上会留下一条「孤儿但受信」的记录，
 * 重装后应到「我的 → 设备管理」把它撤销。
 */
export class SignatureMismatchError extends Error {
  constructor(detail: string) {
    super(
      '这个更新包与已安装版本的签名不一致，无法直接覆盖安装。\n\n' +
        '这是因为旧版本使用了公开的调试签名，新版本改用了正式签名。\n' +
        '请卸载当前 App 后，用新下载的安装包装一次。\n\n' +
        '· 你的会话、任务、工作区文件都在电脑上，不会丢失\n' +
        '· 需要重新扫码配对（原来的配对凭据随卸载清除）\n' +
        '· 重装后建议到「我的 → 设备管理」撤销旧设备记录\n\n' +
        `（系统信息：${detail}）`,
    );
    this.name = 'SignatureMismatchError';
  }
}

/** 缺少「安装未知应用」权限。UI 捕获后引导用户去设置页开启 */
export class InstallPermissionError extends Error {
  constructor(detail: string) {
    super(`需要授权「安装未知应用」才能完成更新（${detail}）`);
    this.name = 'InstallPermissionError';
  }
}

/**
 * 打开「安装未知应用」权限设置页。
 *
 * 为什么需要这个：Android 8+ 装 APK 必须用户手动授权，
 * 而各家 ROM 把这个开关藏在不同位置（小米尤其深）。
 * manifest 里声明了 REQUEST_INSTALL_PACKAGES 之后，系统才会把本 App
 * 列进这个名单；否则用户根本找不到。
 *
 * 依次尝试：
 *   1. 直接跳本 App 的安装权限页（最理想，用户一进来就是自己）
 *   2. 普通设置页
 *   3. 应用详情页（兜底，用户自己找「安装未知应用」）
 */
export async function openInstallPermissionSettings(packageName: string): Promise<boolean> {
  const candidates = [
    // 精确跳转到本 App 的「安装未知应用」页
    `package:${packageName}`,
    // 全部应用的安装权限列表
    'package:',
    // 兜底：应用详情页
    `package:${packageName}`,
  ];

  for (const url of candidates) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // 这个 URL 不被支持，试下一个
    }
  }
  return false;
}

/** 清掉下载过的旧 APK（装完或用户取消后调用） */
export async function cleanupApks(): Promise<void> {
  try {
    const dir = ReactNativeBlobUtil.fs.dirs.CacheDir;
    const list = await ReactNativeBlobUtil.fs.ls(dir);
    await Promise.all(
      list
        .filter((n) => /^dsh-outpost-.*\.apk$/i.test(n))
        .map((n) => ReactNativeBlobUtil.fs.unlink(`${dir}/${n}`).catch(() => undefined)),
    );
  } catch {
    // 清理失败无所谓
  }
}
