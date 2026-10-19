/**
 * 工作区注册表 API。
 *
 * 为什么需要它：
 * DSH 有两份「会话清单」——
 *  1. `session/list`：扫磁盘，返回全部会话（App 一直用的是这个）
 *  2. `~/.dsh/storages/workspace.json`：工作区注册表，记录每个工作区登记了哪些会话
 *     （桌面端按这份渲染）
 *
 * `session/create` 只传 `cwd` 时，会话会落盘但**不会**登记进注册表，
 * 于是桌面端看不到手机上建的会话 —— 这就是「电脑没同步手机对话」的根因。
 *
 * 实测（probes/exp-create-workspace-session.mjs）：
 *   session/create { cwd }          → 磁盘有、注册表没有
 *   session/create { workspaceId }  → 磁盘有、注册表也有（sessionIds +1）
 *   workspace/create { path }       → 幂等，已存在时返回 created:false + 既有 workspaceId
 *
 * 所以建会话前先 `workspace/create { path }` 解析出 workspaceId，
 * 再用 workspaceId 建，桌面端就能看到了。
 */
import type { DshConnection } from '../transport';

export interface WorkspaceInfo {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
}

export class WorkspaceApi {
  constructor(private readonly conn: DshConnection) {}

  /**
   * 按目录路径解析（或创建）工作区，返回 workspaceId。
   * 服务端是幂等的：目录已有工作区时返回 created:false 和既有的 id。
   */
  async ensureForPath(path: string): Promise<WorkspaceInfo | null> {
    const res = await this.conn.call<{ workspace?: WorkspaceInfo }>('workspace/create', {
      request: { path },
    });
    return res?.workspace ?? null;
  }

  /**
   * 归档会话（用户视角的「删除」）。
   *
   * 注意：DSH 没有真正的会话删除接口，只有归档。
   * 归档后 `session/list` **仍然返回**这个会话 —— DSH 不会告诉我们哪些被归档了，
   * 所以调用方必须自己把 id 存起来并在渲染时过滤。
   * 返回归档后的完整 id 列表，便于调用方同步本地状态。
   */
  async archiveSession(sessionId: string): Promise<string[]> {
    const res = await this.conn.call<{ archivedSessionIds?: string[] }>(
      'workspace/archiveSession',
      { request: { sessionId } },
    );
    return res?.archivedSessionIds ?? [];
  }

  /** 取消归档（从「已删除」里恢复） */
  async unarchiveSession(sessionId: string): Promise<string[]> {
    const res = await this.conn.call<{ archivedSessionIds?: string[] }>(
      'workspace/unarchiveSession',
      { request: { sessionId } },
    );
    return res?.archivedSessionIds ?? [];
  }
}
