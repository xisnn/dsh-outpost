/**
 * 电脑上的目录浏览 / 创建。
 *
 * DSH 暴露了 `directoryPicker` 命名空间（桌面端「新建工作区」用的就是这个）：
 *
 *   directoryPicker/list { path }
 *     → { path, home, crumbs: [{name,path}], entries: [{name,path,hidden}] }
 *
 *   directoryPicker/createDirectory { path, name }
 *     → 新目录的完整路径
 *
 * 有了它，手机上就能像桌面端一样「点进去选目录」，不用手敲 Windows 路径。
 */
import type { DshConnection } from '../transport';

export interface DirCrumb {
  name: string;
  path: string;
  hidden?: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirListing {
  path: string;
  /** 电脑上的用户主目录，用于「回到首页」 */
  home?: string;
  /** 面包屑（从盘符到当前目录） */
  crumbs: DirCrumb[];
  entries: DirEntry[];
}

interface RawListing {
  path?: string;
  home?: string;
  crumbs?: Array<{ name?: string; path?: string; hidden?: boolean }>;
  entries?: Array<{ name?: string; path?: string; hidden?: boolean }>;
}

export class DirectoryPickerApi {
  constructor(private conn: DshConnection) {}

  /** 列出某个目录的直接子目录（只返回目录，不含文件） */
  async list(path: string): Promise<DirListing> {
    const res = await this.conn.call<RawListing>('directoryPicker/list', { path });
    const r = res ?? {};
    return {
      path: r.path ?? path,
      home: r.home,
      crumbs: (r.crumbs ?? [])
        .filter((c) => c.path)
        .map((c) => ({ name: c.name ?? c.path ?? '', path: c.path as string, hidden: c.hidden })),
      entries: (r.entries ?? [])
        .filter((e) => e.path)
        .map((e) => ({
          name: e.name ?? e.path ?? '',
          path: e.path as string,
          hidden: e.hidden === true,
        })),
    };
  }

  /** 在当前目录下新建一个文件夹，返回新目录的完整路径 */
  async createDirectory(path: string, name: string): Promise<string> {
    const res = await this.conn.call<string>('directoryPicker/createDirectory', { path, name });
    return typeof res === 'string' ? res : '';
  }
}
