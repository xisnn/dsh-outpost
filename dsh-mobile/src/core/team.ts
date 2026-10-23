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

// ── 队员复用兜底 ────────────────────────────────────────────────────
//
// Prompt 里要求「同一岗位只保留一个队员」，但这靠模型自觉 ——
// 它偶尔会建出 coder-1、coder-2、coder2 之类。一旦发生：
//   · token 白烧（每个新队员都要重新读项目）
//   · 团队栏变长，用户分不清谁是谁
//
// 这里在客户端做一层检测，发现重复就提示用户（不自动处理 ——
// 删队员是不可逆操作，交给用户决定）。

/** 固定四个岗位。名字里的数字/后缀会被剥掉后再比对 */
export const FIXED_ROLES = ['coder', 'scout', 'designer', 'writer'] as const;
export type FixedRole = (typeof FIXED_ROLES)[number];

/**
 * 从队员名字里抽出「岗位」。
 *
 * `coder` / `coder-1` / `Coder_2` / `coder2` / `coder (2)` 都归一成 `coder`。
 * 不是固定岗位的（比如用户自己起的名字）返回 null。
 */
export function roleOf(name: string): FixedRole | null {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[\s_\-()（）#]+/g, '') // 去掉分隔符
    .replace(/\d+$/, '') // 去掉结尾数字
    .trim();
  for (const role of FIXED_ROLES) {
    if (base === role || base.startsWith(role)) return role;
  }
  return null;
}

export interface DuplicateRole {
  role: FixedRole;
  /** 这个岗位下的所有队员名（按出现顺序） */
  names: string[];
}

/**
 * 找出重复的岗位。
 *
 * 返回空数组表示健康。有重复时，UI 可以提示用户清理。
 */
export function findDuplicateRoles(team?: AgentTeam): DuplicateRole[] {
  if (!team) return [];
  const byRole = new Map<FixedRole, string[]>();
  for (const m of team.members ?? []) {
    if (m.role !== 'teammate') continue;
    const role = roleOf(m.name);
    if (!role) continue;
    const list = byRole.get(role) ?? [];
    list.push(m.name);
    byRole.set(role, list);
  }
  const out: DuplicateRole[] = [];
  for (const [role, names] of byRole) {
    if (names.length > 1) out.push({ role, names });
  }
  return out;
}

/**
 * 给用户看的重复提示（没有重复时返回 null）。
 */
export function duplicateRoleHint(dups: DuplicateRole[]): string | null {
  if (dups.length === 0) return null;
  const parts = dups.map((d) => `${d.role}（${d.names.join('、')}）`);
  return `检测到重复岗位：${parts.join('；')}。建议只保留一个 —— 重复队员会重复读项目，费 token。`;
}
