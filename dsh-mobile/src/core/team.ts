/**
 * 团队成员的展示状态。
 *
 * 数据只来自会话投影 `agentTeam`，不需要额外请求：
 * 「在干什么」优先取该成员名下 status=in_progress 的任务，
 * 其次看他完成了多少，最后才是待命。
 */
import type { AgentTeam, TeamMember, TeamTask } from './types';

export type MemberStatus = 'working' | 'done' | 'idle' | 'failed';

export interface MemberState {
  member: TeamMember;
  status: MemberStatus;
  /** 正在做的任务 */
  doing?: TeamTask;
  /** 已完成任务数 */
  doneCount: number;
  /** 一句话说明在干什么 */
  desc: string;
}

export const STATUS_LABEL: Record<MemberStatus, string> = {
  working: '进行中',
  done: '已完成',
  idle: '待命',
  failed: '失败',
};

/** 排序权重：干活的排前面，完成的排后面 */
const ORDER: Record<MemberStatus, number> = { working: 0, idle: 1, failed: 2, done: 3 };

export function memberStates(team?: AgentTeam): MemberState[] {
  if (!team) return [];
  const tasks = (team.tasks ?? []).filter((t) => t.status !== 'deleted');
  const states: MemberState[] = (team.members ?? [])
    .filter((m) => m.role === 'teammate')
    .map((m) => {
      const mine = tasks.filter((t) => t.ownerName === m.name);
      const doing = mine.find((t) => t.status === 'in_progress');
      const doneCount = mine.filter((t) => t.status === 'completed').length;
      const status: MemberStatus =
        m.phase === 'failed' ? 'failed' : doing ? 'working' : doneCount > 0 ? 'done' : 'idle';
      const desc = doing
        ? doing.subject
        : doneCount > 0
          ? `已完成 ${doneCount} 项，待命中`
          : '待命中，暂未分配任务';
      return { member: m, status, doing, doneCount, desc };
    });
  return states.sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.member.name.localeCompare(b.member.name),
  );
}

/** 有多少人在干活 / 已完成 */
export function teamSummary(states: MemberState[]) {
  return {
    working: states.filter((s) => s.status === 'working').length,
    done: states.filter((s) => s.status === 'done').length,
  };
}
