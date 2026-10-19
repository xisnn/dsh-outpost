/**
 * 应用内更新：检查 GitHub Releases 是否有新版本，并下载安装。
 *
 * 流程：
 *   1. GET /repos/{owner}/{repo}/releases/latest  拿到 tag_name 和 apk 下载链接
 *   2. 比较版本号，比当前大就提示用户
 *   3. 用户确认后下载 APK 到缓存目录，用系统安装器打开
 *
 * 前提：更新包的签名必须和已安装的一致，否则 Android 会拒绝覆盖。
 * 目前 CI 统一用仓库里的 debug.keystore 签名，所以能直接覆盖安装。
 */
import { Linking, Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { isNewer } from './semver';

const OWNER = 'xisnn';
const REPO = 'dsh-pocket';
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

    return {
      tag,
      version,
      notes: json.body ?? '',
      apkUrl: asset.browser_download_url,
      apkSize: asset.size,
      publishedAt: json.published_at ?? '',
    };
  } catch {
    // 网络问题/限流都当作「没有更新」，不打扰用户
    return null;
  }
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
  const path = `${dir}/dsh-pocket-${release.version}.apk`;

  // 已经下过就直接装，省一次流量
  const exists = await ReactNativeBlobUtil.fs.exists(path);
  if (!exists) {
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
    if (/permission|denied|install|unknown|not allowed/i.test(msg)) {
      throw new InstallPermissionError(msg);
    }
    throw e;
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
        .filter((n) => /^dsh-pocket-.*\.apk$/i.test(n))
        .map((n) => ReactNativeBlobUtil.fs.unlink(`${dir}/${n}`).catch(() => undefined)),
    );
  } catch {
    // 清理失败无所谓
  }
}
