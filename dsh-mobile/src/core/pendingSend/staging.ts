/**
 * 附件私有暂存层。
 *
 * 相册/文件选择器给的 URI 可能在 App 重启后失效；发送前必须把附件复制
 * 到应用私有目录，并在 PendingSendRecord 中保存 `stagedUri` + 内容 SHA-256。
 *
 * 这里只存文件，不把文件字节放进 Keychain；Keychain 只存元数据和引用。
 */

import type { AttachmentDraft, PendingAttachment } from './types';

export type PendingSendStagingErrorCode =
  | 'staging-unavailable'
  | 'attachment-copy-failed'
  | 'attachment-too-large'
  | 'staging-full'
  | 'attachment-missing'
  | 'attachment-changed'
  | 'cleanup-failed';

export class PendingSendStagingError extends Error {
  readonly code: PendingSendStagingErrorCode;

  constructor(code: PendingSendStagingErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'PendingSendStagingError';
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

interface BlobFs {
  dirs: { DocumentDir: string };
  mkdir(path: string): Promise<void>;
  cp(path: string, dest: string): Promise<boolean>;
  mv(path: string, dest: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number }>;
  hash(path: string, algorithm: 'sha256'): Promise<string>;
  ls(path: string): Promise<string[]>;
  copyToInternal?(contentUri: string, destPath: string): Promise<string>;
}

interface BlobModule {
  fs: BlobFs;
}

function getBlobFs(): BlobFs {
  // 延迟 require：Node 测试不加载 RN 原生模块。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('react-native-blob-util') as BlobModule | { default: BlobModule };
  const blob = 'default' in mod ? mod.default : mod;
  return blob.fs;
}

export function bareFilePath(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
}

export interface PendingSendStaging {
  stage(draft: AttachmentDraft): Promise<PendingAttachment>;
  verify(attachment: PendingAttachment): Promise<void>;
  removeAttachments(attachments: PendingAttachment[]): Promise<void>;
  clearAll(): Promise<void>;
  cleanupOrphans(referencedStagedUris: string[]): Promise<number>;
}

/**
 * 生产实现：DocumentDir/dsh-pending-send。
 *
 * 该目录位于应用私有存储；AndroidManifest allowBackup=false，不会进入
 * 系统备份。暂存上限由 stage() 检查，清理由 PendingSendStore 的
 * prune/clearAll 调用。
 */
export class ReactNativePendingSendStaging implements PendingSendStaging {
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;

  constructor(options: { maxFileBytes?: number; maxTotalBytes?: number } = {}) {
    this.maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
  }

  private get dir(): string {
    return `${getBlobFs().dirs.DocumentDir}/dsh-pending-send`;
  }

  private async ensureDir(): Promise<string> {
    const fs = getBlobFs();
    const dir = this.dir;
    const exists = await fs.exists(dir).catch(() => false);
    if (!exists) {
      await fs.mkdir(dir).catch(() => {
        // 并发创建时目录可能已经存在；下一次 stat 会暴露真实问题
      });
    }
    return dir;
  }

  private normalizeStagedUri(uri: string): string {
    const value = String(uri ?? '');
    if (!value) throw new PendingSendStagingError('attachment-missing', '附件暂存路径为空');
    return value;
  }

  private assertInsideDir(path: string): void {
    const dir = this.dir.replace(/\\/g, '/').replace(/\/+$/, '');
    const p = bareFilePath(path).replace(/\\/g, '/');
    if (!p.startsWith(`${dir}/`)) {
      throw new PendingSendStagingError('cleanup-failed', '拒绝操作暂存目录之外的路径');
    }
  }

  private async totalStagedBytes(): Promise<number> {
    const fs = getBlobFs();
    const dir = this.dir;
    let total = 0;
    let names: string[] = [];
    try {
      names = await fs.ls(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const p = name.includes('/') || name.includes('\\') ? name : `${dir}/${name}`;
      try {
        total += (await fs.stat(p)).size;
      } catch {
        // 正在被其他操作删除的文件不计入
      }
    }
    return total;
  }

  async stage(draft: AttachmentDraft): Promise<PendingAttachment> {
    const fs = getBlobFs();
    const source = String(draft.uri ?? '');
    if (!source) throw new PendingSendStagingError('attachment-missing', '附件源地址为空');
    const dir = await this.ensureDir();
    const safeName = String(draft.name || 'attachment')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 80);
    const target = `${dir}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`;

    try {
      if (source.startsWith('content://')) {
        if (!fs.copyToInternal) {
          throw new PendingSendStagingError('attachment-copy-failed', '当前平台不支持 content:// 复制');
        }
        await fs.copyToInternal(source, target);
      } else {
        // 不同平台实现可能返回 boolean/undefined；以复制后的 stat 为准。
        await fs.cp(bareFilePath(source), target);
      }
      const stat = await fs.stat(target);
      if (stat.size > this.maxFileBytes) {
        await fs.unlink(target).catch(() => undefined);
        throw new PendingSendStagingError(
          'attachment-too-large',
          `附件超过单文件上限：${stat.size} > ${this.maxFileBytes}`,
        );
      }
      const total = await this.totalStagedBytes();
      if (total > this.maxTotalBytes) {
        await fs.unlink(target).catch(() => undefined);
        throw new PendingSendStagingError(
          'staging-full',
          `附件暂存空间超过上限：${total} > ${this.maxTotalBytes}`,
        );
      }
      const contentSha256 = (await fs.hash(target, 'sha256')).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
        await fs.unlink(target).catch(() => undefined);
        throw new PendingSendStagingError('attachment-copy-failed', '附件哈希计算失败');
      }
      return {
        kind: draft.kind,
        localUri: source,
        stagedUri: target,
        name: draft.name,
        size: stat.size,
        mime: draft.mime,
        contentSha256,
      };
    } catch (e) {
      await fs.unlink(target).catch(() => undefined);
      if (e instanceof PendingSendStagingError) throw e;
      throw new PendingSendStagingError('attachment-copy-failed', '附件暂存失败', e);
    }
  }

  async verify(attachment: PendingAttachment): Promise<void> {
    const fs = getBlobFs();
    const path = this.normalizeStagedUri(attachment.stagedUri);
    this.assertInsideDir(path);
    try {
      if (!(await fs.exists(bareFilePath(path)))) {
        throw new PendingSendStagingError('attachment-missing', `附件已不存在：${attachment.name}`);
      }
      const stat = await fs.stat(bareFilePath(path));
      if (stat.size !== attachment.size) {
        throw new PendingSendStagingError(
          'attachment-changed',
          `附件大小已变化：${attachment.name}`,
        );
      }
      const hash = (await fs.hash(bareFilePath(path), 'sha256')).toLowerCase();
      if (hash !== attachment.contentSha256.toLowerCase()) {
        throw new PendingSendStagingError(
          'attachment-changed',
          `附件内容已变化：${attachment.name}`,
        );
      }
    } catch (e) {
      if (e instanceof PendingSendStagingError) throw e;
      throw new PendingSendStagingError('attachment-missing', `无法读取附件：${attachment.name}`, e);
    }
  }

  async removeAttachments(attachments: PendingAttachment[]): Promise<void> {
    const fs = getBlobFs();
    for (const attachment of attachments) {
      const path = this.normalizeStagedUri(attachment.stagedUri);
      this.assertInsideDir(path);
      await fs.unlink(bareFilePath(path)).catch(() => undefined);
    }
  }

  async clearAll(): Promise<void> {
    const fs = getBlobFs();
    const dir = this.dir;
    let names: string[] = [];
    try {
      names = await fs.ls(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = name.includes('/') || name.includes('\\') ? name : `${dir}/${name}`;
      this.assertInsideDir(p);
      await fs.unlink(bareFilePath(p)).catch(() => undefined);
    }
  }

  async cleanupOrphans(referencedStagedUris: string[]): Promise<number> {
    const fs = getBlobFs();
    const dir = this.dir;
    const refs = new Set(
      referencedStagedUris.map((p) => bareFilePath(p).replace(/\\/g, '/')),
    );
    let names: string[] = [];
    try {
      names = await fs.ls(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const p = name.includes('/') || name.includes('\\') ? name : `${dir}/${name}`;
      const normalized = bareFilePath(p).replace(/\\/g, '/');
      if (refs.has(normalized)) continue;
      try {
        await fs.unlink(bareFilePath(p));
        removed += 1;
      } catch {
        // 下次启动再清理
      }
    }
    return removed;
  }
}

/** 测试/无文件环境使用；生产 App 必须注入 ReactNativePendingSendStaging。 */
export class NoopPendingSendStaging implements PendingSendStaging {
  async stage(draft: AttachmentDraft): Promise<PendingAttachment> {
    return {
      kind: draft.kind,
      localUri: draft.uri,
      stagedUri: draft.uri,
      name: draft.name,
      size: draft.size ?? 0,
      mime: draft.mime,
      contentSha256: '0'.repeat(64),
    };
  }
  async verify(): Promise<void> {}
  async removeAttachments(): Promise<void> {}
  async clearAll(): Promise<void> {}
  async cleanupOrphans(): Promise<number> {
    return 0;
  }
}
