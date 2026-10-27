/**
 * 读取电脑上的文件（图片 / PDF 等）。
 *
 * DSH 提供 `GET /api/file?path=<绝对路径>`，但**只认 Cookie 鉴权**
 * （实测：URL 里带 token 返回 401）。而 React Native 的 <Image>
 * 不能自定义请求头，所以图片走不了直连。
 *
 * 方案：用 blob-util 带 Cookie 把文件下载到本地缓存，再用 file:// 显示。
 * 非图片文件同理 —— 下载后交给系统应用打开。
 *
 * 缓存按「路径 + mtime 近似」存：同一个文件多次渲染不会重复下载。
 */
import ReactNativeBlobUtil from 'react-native-blob-util';
import { assertSecureUrl } from './net-security';
import { isInstallablePackage } from './installable';

/** 把路径转成一个安全的本地文件名（避免中文/冒号在文件系统里出问题） */
function cacheName(path: string): string {
  // 简单的 djb2 哈希，碰撞概率可忽略
  let h = 5381;
  for (let i = 0; i < path.length; i += 1) {
    h = ((h << 5) + h + path.charCodeAt(i)) | 0;
  }
  const ext = (path.split('.').pop() ?? 'bin').toLowerCase().slice(0, 5);
  const base = (path.split(/[\\/]/).pop() ?? 'file').replace(/[^\w.-]/g, '_').slice(0, 24);
  return `${base}-${(h >>> 0).toString(36)}.${ext}`;
}

export interface RemoteFile {
  /** 本地缓存路径（file:// 前缀已加好，可直接给 Image 用） */
  uri: string;
  /** 纯文件系统路径（给 actionViewIntent 用，不能带 file://） */
  fsPath: string;
  name: string;
}

/**
 * 确保文件已下载到本地缓存，返回本地路径。
 * 已经下载过就直接返回，不重复拉取。
 */
export async function fetchRemoteFile(
  baseUrl: string,
  cookie: string | undefined,
  remotePath: string,
): Promise<RemoteFile> {
  const dir = ReactNativeBlobUtil.fs.dirs.CacheDir;
  const name = cacheName(remotePath);
  const fsPath = `${dir}/${name}`;
  // 这条路径直接用 blob-util 发（不经过 DshConnection.call），带的是 Cookie，
  // 所以出口校验要自己补一次。
  assertSecureUrl(baseUrl, '文件地址');
  const url = `${baseUrl}/api/file?${new URLSearchParams({ path: remotePath }).toString()}`;

  // 缓存校验：存在**且非空**才算命中。
  //
  // ⚠️ 之前只判断 `exists()`，踩过坑：上一次下载失败留下的
  // 半截文件（或者 0 字节文件）会被当成「已缓存」，
  // 于是后面永远读到一个坏文件 —— 表现就是「文件一直打不开」，
  // 而且怎么重试都没用（因为根本不会再下载）。
  let usable = false;
  if (await ReactNativeBlobUtil.fs.exists(fsPath)) {
    try {
      const st = await ReactNativeBlobUtil.fs.stat(fsPath);
      usable = Number(st.size) > 0;
    } catch {
      usable = false;
    }
    if (!usable) {
      // 坏缓存，删掉重下
      await ReactNativeBlobUtil.fs.unlink(fsPath).catch(() => undefined);
    }
  }

  if (!usable) {
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    // 必须 fileCache: true。设成 false 时 blob-util 只把响应留在内存，
    // 不会写进 path 指定的文件 —— 后面 Image 读 file:// 拿到的是空文件，
    // 界面上就是一块灰色空白（用户报的「图片看不见」）。
    const res = await ReactNativeBlobUtil.config({ fileCache: true, path: fsPath }).fetch(
      'GET',
      url,
      headers,
    );
    const status = res.info().status;
    if (status !== 200) {
      // 失败清掉半截文件，避免下次误判为「已缓存」
      await ReactNativeBlobUtil.fs.unlink(fsPath).catch(() => undefined);
      throw new Error(
        status === 403
          ? '没有权限读这个文件（Host 校验失败，检查 DSH 的 --trusted-host）'
          : status === 404
            ? '文件不存在'
            : `读取失败（${status}）`,
      );
    }
    // 再校验：文件得真的落盘且非空
    if (!(await ReactNativeBlobUtil.fs.exists(fsPath))) {
      throw new Error('文件下载失败');
    }
    const st = await ReactNativeBlobUtil.fs.stat(fsPath);
    if (Number(st.size) === 0) {
      await ReactNativeBlobUtil.fs.unlink(fsPath).catch(() => undefined);
      throw new Error('文件为空，请重试');
    }
  }

  const displayName = remotePath.split(/[\\/]/).pop() ?? name;
  return { uri: `file://${fsPath}`, fsPath, name: displayName };
}

/**
 * 是否是可安装的 Android 包。
 *
 * ## 为什么需要单独判断
 *
 * 聊天附件里的文件会走 `openLocalFile` → `actionViewIntent`，而
 * `mimeOf('.apk')` 返回 `application/vnd.android.package-archive`。
 * 也就是说：**对方（或 agent）发一个 APK 到聊天里，点一下就进系统安装器**。
 *
 * 这条路径完全不经过 `updater.ts` 的 SHA-256 校验 —— 是一个「第二条安装路径」。
 * 在签名密钥是公开 debug 证书的情况下，任何能往会话里丢文件的人都能投递
 * 一个 Android 会接受的更新（私钥修好后这条风险自动消失，但校验缺失本身
 * 仍然应该被堵）。
 *
 * 处理：不在 App 内直接安装附件里的 APK。用户想装就自己去文件管理器装 ——
 * 那至少是用户显式、脱离 App 语境的主动决定，而不是「点开一个附件」。
 *
 * 实现见 `installable.ts`（纯逻辑，可单测）；这里转出保持调用方不变。
 */
export { isInstallablePackage } from './installable';

/**
 * 用系统应用打开已下载的文件（PDF / docx / 图片等）。
 *
 * ⚠️ 拒绝安装 APK 类文件 —— 见 `isInstallablePackage` 的说明。
 */
export async function openLocalFile(file: RemoteFile): Promise<void> {
  if (isInstallablePackage(file.name)) {
    throw new Error(
      '出于安全考虑，不能在 App 内直接安装附件里的安装包。\n' +
        '请到「保存到手机」后用文件管理器手动安装。',
    );
  }
  const mime = mimeOf(file.name);
  await ReactNativeBlobUtil.android.actionViewIntent(file.fsPath, mime);
}

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xls':
      return 'application/vnd.ms-excel';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'ppt':
      return 'application/vnd.ms-powerpoint';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'zip':
      return 'application/zip';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'txt':
      return 'text/plain';
    // 下面这些之前落到 application/octet-stream —— 保存到手机后
    // 系统不知道用什么打开，文件管理器里点它会提示「无法打开」。
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'csv':
      return 'text/csv';
    case 'json':
      return 'application/json';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'xml':
      return 'text/xml';
    case 'log':
      return 'text/plain';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'heic':
      return 'image/heic';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'apk':
      return 'application/vnd.android.package-archive';
    case 'rar':
      return 'application/vnd.rar';
    case '7z':
      return 'application/x-7z-compressed';
    case 'tar':
      return 'application/x-tar';
    case 'gz':
      return 'application/gzip';
    default:
      return 'application/octet-stream';
  }
}
