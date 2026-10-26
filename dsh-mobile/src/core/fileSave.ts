/**
 * 把文件保存到手机，以及分享出去。
 *
 * ## 两种保存方式，用途不同
 *
 * | 方式 | 存到哪 | 用户能找到吗 | 用途 |
 * |---|---|---|---|
 * | 保存到下载目录 | 系统「下载」集合 | 文件管理器里能看到 | 长期留存 |
 * | 系统分享 | 交给别的 App | 目标 App 自己处理 | 发微信、发邮件 |
 *
 * Android 10+ 用 MediaStore（`copyToMediaStore`），不需要存储权限 ——
 * 这是系统的按文件授权机制。低于 10 的版本退回应用私有目录 + 分享。
 *
 * ## 为什么要单独一个模块
 *
 * 保存/分享的失败原因很杂（没权限、目标目录不存在、文件名非法、
 * 系统没有能处理该类型的 App），每一种给用户的提示都不一样。
 * 散在 UI 里会重复且容易漏。
 */

import { Platform, Share, type ShareOptions } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';

import { mimeOf } from './fileUrl';

/** 保存结果 */
export type SaveOutcome =
  /** 保存成功，path 是用户能看到的位置描述 */
  | { ok: true; where: string; uri?: string }
  /** 保存失败，reason 是可以直接给用户看的话 */
  | { ok: false; reason: string };

/**
 * 保存到手机「下载」目录。
 *
 * @param fsPath  本地缓存里的文件路径（不带 file://）
 * @param name    展示用的文件名（含扩展名）
 */
export async function saveToDownloads(fsPath: string, name: string): Promise<SaveOutcome> {
  const mime = mimeOf(name);

  // ⚠️ 文件名清洗：非法字符会让 MediaStore 直接抛异常，
  // 而且错误信息很难懂（"invalid filedata"）。
  const safeName = sanitizeFileName(name);

  if (Platform.OS !== 'android') {
    // iOS 没有「下载目录」的概念。交给系统分享面板，
    // 用户自己选「存储到文件」。
    return shareFile(fsPath, name);
  }

  try {
    // Android 10+：走 MediaStore.Downloads，无需权限
    if (Number(Platform.Version) >= 29) {
      const uri = await ReactNativeBlobUtil.MediaCollection.copyToMediaStore(
        {
          name: stripExtension(safeName),
          parentFolder: '',
          mimeType: mime,
        },
        'Download',
        fsPath,
      );
      return { ok: true, where: '下载目录', uri: String(uri) };
    }

    // Android 9 及以下：MediaStore 需要 WRITE_EXTERNAL_STORAGE，
    // 而为了避免申请这个敏感权限，直接交给系统分享让用户决定存哪。
    return shareFile(fsPath, safeName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 常见失败：同名文件已存在且系统不给覆盖、目标集合不可写
    if (/exist|already/i.test(msg)) {
      return { ok: false, reason: '下载目录里已经有同名文件了，换个名字再试' };
    }
    if (/permission|denied|EACCES/i.test(msg)) {
      return { ok: false, reason: '没有写入下载目录的权限' };
    }
    return { ok: false, reason: `保存失败：${msg}` };
  }
}

/**
 * 转发文件（调系统分享面板，ACTION_SEND）。
 *
 * ## 为什么用 RN 的 Share 而不是 blob-util
 *
 * blob-util 只提供 `actionViewIntent`（ACTION_VIEW，"用某个 App 打开"），
 * 它**不是分享**。用 VIEW 发给微信，微信根本不会出现在选择列表里 ——
 * 用户会以为「转发」坏了。
 *
 * RN 内置的 `Share.share({ url })` 在 Android 上走 ACTION_SEND，
 * 微信、QQ、邮件、蓝牙都能正常收到。不需要额外装库。
 *
 * ## url 的格式
 *
 * Android 要 `file://` 前缀的完整 URI。传纯路径会变成纯文本，
 * 接收方只看到一串路径而不是文件。
 */
export async function shareFile(fsPath: string, name: string): Promise<SaveOutcome> {
  const uri = fsPath.startsWith('file://') ? fsPath : `file://${fsPath}`;
  const mime = mimeOf(name);
  try {
    const res = await Share.share(
      {
        title: name,
        message: name,
        // Android 用 url；iOS 也认 url
        url: uri,
      },
      {
        // Android 的分享面板标题
        dialogTitle: '转发到',
        subject: name,
        // ⚠️ 必须给 mimeType，否则部分 App 不认这个文件类型，
        // 在列表里是灰的或者干脆不出现。
        type: mime,
      } as ShareOptions,
    );
    if (res.action === Share.dismissedAction) {
      return { ok: true, where: '已取消' };
    }
    return { ok: true, where: '已发送' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no activity|ActivityNotFound/i.test(msg)) {
      return { ok: false, reason: '手机上还没有能接收这种文件的应用' };
    }
    return { ok: false, reason: `转发失败：${msg}` };
  }
}

/**
 * 把图片保存到相册。
 *
 * 和 saveToDownloads 的区别：图片进相册（`MediaCollection.Image`），
 * 用户在相册里就能看到，比去下载目录找更符合直觉。
 */
export async function saveImageToGallery(fsPath: string, name: string): Promise<SaveOutcome> {
  const mime = mimeOf(name);
  const safeName = sanitizeFileName(name);

  if (Platform.OS !== 'android') {
    return shareFile(fsPath, safeName);
  }

  try {
    if (Number(Platform.Version) >= 29) {
      const uri = await ReactNativeBlobUtil.MediaCollection.copyToMediaStore(
        {
          name: stripExtension(safeName),
          parentFolder: '',
          mimeType: mime.startsWith('image/') ? mime : 'image/jpeg',
        },
        'Image',
        fsPath,
      );
      return { ok: true, where: '相册', uri: String(uri) };
    }
    return shareFile(fsPath, safeName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/permission|denied|EACCES/i.test(msg)) {
      return { ok: false, reason: '没有写入相册的权限' };
    }
    return { ok: false, reason: `保存到相册失败：${msg}` };
  }
}

/**
 * 清洗文件名。
 *
 * Android 的 MediaStore 对文件名比较宽容，但以下字符仍会出问题：
 *   · `/` `\` —— 路径分隔符，会被当成目录
 *   · `:` —— 某些 ROM 会拒绝（ADB push 时会）
 *   · `?` `*` `"` `<` `>` `|` —— Windows 兼容层可能报错
 *   · 控制字符 —— 直接非法
 *
 * 另外保留中文和空格（用户能看懂更重要）。
 */
function sanitizeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '') // 别以点开头（隐藏文件）
    .trim();
  return cleaned || 'download';
}

/** 去掉扩展名（MediaStore 会自己按 mimeType 补） */
function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}
