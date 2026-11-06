import BlobUtil from 'react-native-blob-util';
import {saveToDownloads} from './fileSave';
import {MAX_LOCAL_EXPORT_CHARS} from './exportText';

export type LocalExportResult = {kind: 'saved' | 'shared' | 'cancelled' | 'failed'; message: string};
let sequence = 0;
/** No network or chat access. Only call after the user has reviewed and chosen Save. */
export async function saveLocalText(text: string, name: string): Promise<LocalExportResult> {
  if (!text.trim() || text.length > MAX_LOCAL_EXPORT_CHARS) return {kind: 'failed', message: '正文为空或过长，无法导出'};
  const path = `${BlobUtil.fs.dirs.CacheDir}/outpost-export-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}.tmp`;
  let preserveForReceiver = false;
  try {
    await BlobUtil.fs.writeFile(path, text, 'utf8');
    const result = await saveToDownloads(path, name);
    if (!result.ok) return {kind: 'failed', message: '无法保存，请检查存储空间和文件权限后重试'};
    if (result.where === '已取消') return {kind: 'cancelled', message: '已取消保存'};
    if (result.where === '下载目录') return {kind: 'saved', message: `已保存到下载目录：${name}`};
    if (result.where === '已发送') {
      // The receiver can read after the system sheet closes. Leave this app-cache
      // file to normal cache eviction rather than invalidating the granted source.
      preserveForReceiver = true;
      return {kind: 'shared', message: '已交给系统处理，请在所选应用中确认'};
    }
    return {kind: 'failed', message: '未能确认保存结果，请重试'};
  } catch {
    return {kind: 'failed', message: '无法保存，请检查存储空间和文件权限后重试'};
  } finally {
    if (!preserveForReceiver) await BlobUtil.fs.unlink(path).catch(() => undefined);
  }
}
