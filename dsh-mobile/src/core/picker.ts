/**
 * 选文件 / 选图片。
 *
 * 用 @react-native-documents/picker（Android 走 SAF，v12 默认 `mode:'import'`
 * 会把选中项复制到 app 缓存并返回 `file://` 路径，这样 blob-util 才能读到）。
 */
import { pick, types, isErrorWithCode, errorCodes } from '@react-native-documents/picker';

export interface PickedFile {
  /** file:// 本地副本路径 */
  uri: string;
  name: string;
  size?: number;
  mime?: string;
}

export type PickMode = 'images' | 'files';

/**
 * Pick one runtime package for the local runtime importer.
 *
 * `mode:'open'` returns the provider's `content://` URI with a temporary read
 * grant. That is exactly what LocalDshModule.install consumes; the native side
 * still validates the trusted manifest and the archive, not the URI.
 */
export async function pickRuntimePackage(): Promise<PickedFile | null> {
  try {
    const [picked] = await pick({
      type: [types.allFiles],
      allowMultiSelection: false,
      mode: 'open',
    });
    return {
      uri: picked.uri,
      name: picked.name ?? 'runtime.tar',
      size: picked.size ?? undefined,
      mime: picked.type ?? undefined,
    };
  } catch (e) {
    if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return null;
    throw e;
  }
}

export async function pickAttachments(mode: PickMode): Promise<PickedFile[]> {
  try {
    const res = await pick({
      type: mode === 'images' ? [types.images] : [types.allFiles],
      allowMultiSelection: true,
      mode: 'import',
    });
    return res.map((r) => ({
      uri: r.uri,
      name: r.name ?? `file-${Date.now()}`,
      size: r.size ?? undefined,
      mime: r.type ?? undefined,
    }));
  } catch (e) {
    // 用户点「取消」不算错误
    if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return [];
    throw e;
  }
}

/** 人类可读的大小 */
export function formatBytes(n: number | undefined): string {
  if (!n || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
