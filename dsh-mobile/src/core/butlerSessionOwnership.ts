import type { DshConnection } from './transport';
import type { ButlerTask } from './butlerTasks';
import { RpcError } from './rpc-error';

const TASK_LIST_PATH = '/api/outpost/butler/tasks';

/** Host 的任务表持久保存 task → session；每次自动驱动前重新查询，不缓存否定结果。 */
export class ButlerSessionOwnership {
  private readonly managed = new Set<string>();
  private hostTasksObserved = false;

  remember(task: Pick<ButlerTask, 'sessionId'>): void {
    this.hostTasksObserved = true;
    if (task.sessionId) this.managed.add(task.sessionId);
  }

  isManaged(sessionId: string): boolean {
    return this.managed.has(sessionId);
  }

  async assertPhoneMayDrive(conn: DshConnection, sessionId: string): Promise<void> {
    if (this.isManaged(sessionId)) throw new Error('Host 管理的会话不接受手机管家自动驱动');

    let verified = false;
    try {
      // 不使用 listButlerTasks 的缺省 []：格式错误不能当作「没有托管会话」。
      // 无 status 过滤，completed / cancelled 等终态会话仍由 Host 管理。
      const result = await conn.request<{ tasks?: unknown }>(TASK_LIST_PATH);
      if (!Array.isArray(result?.tasks)) throw new Error('invalid task mapping');
      for (const task of result.tasks) {
        if (!task || typeof task !== 'object' ||
            typeof task.id !== 'string' || !task.id ||
            !(task.sessionId === null ||
              (typeof task.sessionId === 'string' && task.sessionId.length > 0))) {
          throw new Error('invalid task mapping');
        }
        this.remember(task);
      }
      this.hostTasksObserved = true;
      verified = true;
    } catch (error) {
      // 只有从未见过 Host 任务能力、且列表路由明确不存在，才兼容旧服务器。
      // 网络 / 超时 / 401 / 403 / 5xx / 非 JSON 均不能证明会话无人管理。
      verified = !this.hostTasksObserved && error instanceof RpcError &&
        error.endpoint === TASK_LIST_PATH && error.kind === 'http' &&
        /^HTTP 404$/.test(error.raw);
    }

    // 查询期间 create/get/list 可能已经返回了该会话的归属，始终以肯定归属为准。
    if (this.isManaged(sessionId)) throw new Error('Host 管理的会话不接受手机管家自动驱动');
    if (!verified) throw new Error('无法确认会话归属，已跳过手机管家自动驱动');
  }
}
