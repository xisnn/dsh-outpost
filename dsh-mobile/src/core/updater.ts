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
import { Platform } from 'react-native';
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

/**
 * 下载 APK 并唤起系统安装器。
 * onProgress 会收到 0-1 的进度。
 */
export async function downloadAndInstall(
  release: ReleaseInfo,
  onProgress?: (ratio: number) => void,
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

    task.progress({ interval: 250 }, (received, total) => {
      const t = Number(total);
      if (t > 0) onProgress?.(Math.min(1, Number(received) / t));
    });

    await task;
  }

  // 唤起系统安装界面。Android 8+ 需要「安装未知应用」权限，
  // 没有权限时系统会自己弹授权页。
  await ReactNativeBlobUtil.android.actionViewIntent(
    `file://${path}`,
    'application/vnd.android.package-archive',
  );
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
