/**
 * 「这个文件是不是可安装的 Android 包」——纯逻辑，无平台依赖。
 *
 * 单独抽出来是为了能直接单测：`fileUrl.ts` 顶层 import 了
 * `react-native-blob-util`，Node 侧加载不了。
 */

/** 可安装/疑似安装包的扩展名 */
const INSTALLABLE_EXTS = new Set(['apk', 'apks', 'xapk', 'aab', 'apkm']);

/**
 * 文件名是否指向一个 Android 安装包。
 *
 * 判据只看扩展名：内容嗅探需要读文件头，而这里的目的只是
 * 「不要在 App 内把附件直接交给系统安装器」，扩展名足够。
 */
export function isInstallablePackage(name: string): boolean {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return false;
  const ext = n.split('.').pop() ?? '';
  return INSTALLABLE_EXTS.has(ext);
}
