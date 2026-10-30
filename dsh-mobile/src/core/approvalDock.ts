/**
 * F-01 审批面板纯逻辑：
 *   1. 严格按 sessionId 隔离当前会话审批与跨会话待审批汇总；
 *   2. 完整提取待执行命令、目标路径与附加参数（绝不隐藏关键参数）；
 *   3. 高危操作识别与二次确认（Arm-then-Commit，仅作为额外防误触措施，不替代原有权限校验）；
 *   4. 提交状态机：防重复点击、断线/401/403/发送失败立即报错并保持待审批、超时未确认自动回滚恢复待审批。
 *
 * 本模块不依赖 React Native，可直接由 Node 单测覆盖全部边界。
 */

export const HIGH_RISK_ARM_TIMEOUT_MS = 4000;
export const APPROVAL_COMMIT_TIMEOUT_MS = 8000;

export type ApprovalDecision = 'allowed-once' | 'rejected';

export interface ApprovalCandidate {
  id: string;
  sessionId?: string;
  approvalId?: string;
  toolName: string;
  reason?: string;
  displayReason?: Record<string, string>;
  replay?: boolean;
}

export interface SessionTitleLike {
  sessionId: string;
  projections?: { values?: { title?: unknown } };
}

export interface OtherSessionApprovalGroup {
  sessionId: string;
  title: string;
  count: number;
  firstToolName: string;
}

export interface PartitionedApprovals<T extends ApprovalCandidate = ApprovalCandidate> {
  /** 当前会话可见的待审批（已剔除正在等待服务端确认的乐观提交项） */
  current: T[];
  /** 其他会话的待审批原始列表 */
  other: T[];
  /** 按其他会话聚合后的跳转摘要 */
  otherGroups: OtherSessionApprovalGroup[];
}

/**
 * 严格按 sessionId 拆分待审批。
 *
 * - 当前会话只展示 `sessionId === currentSessionId`（或会话内 fold 出的无 sessionId 只读项）；
 * - 其他会话的审批绝不混入当前会话卡片，而是聚合为 `otherGroups` 供跳转入口展示；
 * - 处于 `inFlightIds`（已发送响应、正等待服务端 `approval-resolved`）的条目暂时隐藏，
 *   一旦超时或断线则从 `inFlightIds` 移除并立即恢复显示。
 */
export function partitionApprovalsBySession<T extends ApprovalCandidate>(
  approvals: readonly T[],
  currentSessionId: string,
  opts?: {
    inFlightIds?: ReadonlySet<string>;
    sessions?: readonly SessionTitleLike[];
  },
): PartitionedApprovals<T> {
  const inFlight = opts?.inFlightIds;
  const titleMap = new Map<string, string>();
  for (const s of opts?.sessions ?? []) {
    const raw = s.projections?.values?.title;
    if (typeof raw === 'string' && raw.trim()) {
      titleMap.set(s.sessionId, raw.trim());
    }
  }

  const current: T[] = [];
  const other: T[] = [];
  const groupMap = new Map<string, OtherSessionApprovalGroup>();

  for (const item of approvals) {
    if (!item.sessionId || item.sessionId === currentSessionId) {
      if (inFlight?.has(item.id)) continue;
      current.push(item);
    } else {
      other.push(item);
      const sid = item.sessionId;
      const existing = groupMap.get(sid);
      if (existing) {
        existing.count += 1;
      } else {
        groupMap.set(sid, {
          sessionId: sid,
          title: titleMap.get(sid) ?? '未命名会话',
          count: 1,
          firstToolName: item.toolName || 'tool',
        });
      }
    }
  }

  return {
    current,
    other,
    otherGroups: [...groupMap.values()],
  };
}

export interface ApprovalDetails {
  /** 待执行命令（若有） */
  command: string | null;
  /** 目标文件/目录路径（若有） */
  targetPath: string | null;
  /** 除命令与路径外的全部参数键值（不隐藏任何字段） */
  extraEntries: Array<{ key: string; value: string }>;
  /** 审批原因说明 */
  reasonText: string | null;
  /** 供等宽代码框完整展示的汇总文本（不截断） */
  fullSpecText: string;
}

const COMMAND_KEYS = new Set(['command', 'cmd', 'script', 'commandLine', 'shellCommand']);
const PATH_KEYS = new Set([
  'path',
  'file_path',
  'filePath',
  'target',
  'targetPath',
  'workdir',
  'cwd',
  'directory',
]);
const SHELL_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'cmd', 'zsh']);

/**
 * 提取审批中的完整命令、目标路径与附加参数。
 *
 * 保证不截断、不丢弃任何 `displayReason` 字段或 `reason` 原文。
 */
export function extractApprovalDetails(a: ApprovalCandidate): ApprovalDetails {
  const dr = a.displayReason ?? {};
  let command: string | null = null;
  let targetPath: string | null = null;
  const extraEntries: Array<{ key: string; value: string }> = [];

  for (const [key, rawVal] of Object.entries(dr)) {
    if (rawVal === undefined || rawVal === null) continue;
    const val = String(rawVal).trim();
    if (!val) continue;
    if (!command && COMMAND_KEYS.has(key)) {
      command = val;
    } else if (!targetPath && PATH_KEYS.has(key)) {
      targetPath = val;
    } else {
      extraEntries.push({ key, value: val });
    }
  }

  const rawReason = typeof a.reason === 'string' ? a.reason.trim() : '';
  let reasonText: string | null = rawReason || null;

  // 若是命令行工具且 displayReason 未单独拆出 command，则把 reason 作为完整待执行命令展示
  if (!command && SHELL_TOOLS.has((a.toolName || '').toLowerCase()) && rawReason) {
    command = rawReason;
  }

  // 若仍无 targetPath，尝试从 reason 中提取常见 Windows / POSIX 路径展示辅助定位
  if (!targetPath && rawReason) {
    const winMatch = rawReason.match(/[A-Za-z]:\\[^\s"'`<>|]+/);
    const posixMatch = rawReason.match(/(?:^|\s)(\/[A-Za-z0-9._\-/]+)(?=\s|$)/);
    if (winMatch) targetPath = winMatch[0];
    else if (posixMatch) targetPath = posixMatch[1]!.trim();
  }

  if (reasonText && reasonText === command) {
    reasonText = null;
  }

  const lines: string[] = [];
  if (command) lines.push(`命令: ${command}`);
  if (targetPath) lines.push(`路径: ${targetPath}`);
  for (const entry of extraEntries) {
    lines.push(`${entry.key}: ${entry.value}`);
  }
  if (reasonText) lines.push(`说明: ${reasonText}`);
  if (lines.length === 0) {
    lines.push(`工具: ${a.toolName || 'tool'}`);
  }

  return {
    command,
    targetPath,
    extraEntries,
    reasonText,
    fullSpecText: lines.join('\n'),
  };
}

export interface ApprovalRiskAssessment {
  highRisk: boolean;
  riskLevel: 'high' | 'normal';
  riskReasons: string[];
}

const DESTRUCTIVE_FILE_RE =
  /\b(rm\s+-[^\n]*[rf]|del\s+\/[fsq]|erase\s+|rmdir\s+\/s|rd\s+\/s|Remove-Item\b|ri\b\s+.*-Recurse|unlink\b|shred\b|format\s+[a-z]:|mkfs\b|dd\s+if=)/i;
const DESTRUCTIVE_GIT_RE =
  /\bgit\s+(reset\s+--hard|clean\s+-[^\n]*f|push\s+(--force|-f\b)|checkout\s+--\s+\.|branch\s+-D\b)/i;
const PROCESS_SYSTEM_RE =
  /\b(Stop-Process|kill\s+-9|killall\b|taskkill\b|shutdown\b|reboot\b|Restart-Computer|Stop-Computer)\b/i;
const PRIVILEGE_PERM_RE =
  /\b(chmod\s+777|chown\b|icacls\b|Set-Acl\b|sudo\b|runas\b|reg\s+(delete|add)|sc\s+(stop|delete))\b/i;
const SENSITIVE_PATH_RE =
  /(^|[\\/])(\.ssh|\.gnupg|\.dsh|\.env(\.|$)|id_rsa|\.credentials|System32|Windows[\\/]System32|etc[\\/](passwd|shadow|sudoers))([\\/]|$)/i;
const REMOTE_EXEC_RE =
  /\b(Invoke-Expression|iex\b|curl\b[^\n]*\|\s*(sh|bash|pwsh)|wget\b[^\n]*\|\s*(sh|bash|pwsh))/i;

/**
 * 评估审批风险等级与原因。
 *
 * 注意：该规则仅用于客户端 UI 增加高危警示与二次点击防误触（Arm-then-Commit），
 * 绝不自动放行任何审批，也不替代服务端或网关原有的安全权限校验。
 */
export function assessApprovalRisk(a: ApprovalCandidate): ApprovalRiskAssessment {
  const details = extractApprovalDetails(a);
  const corpus = [
    a.toolName ?? '',
    a.reason ?? '',
    details.command ?? '',
    details.targetPath ?? '',
    ...details.extraEntries.map((e) => `${e.key}=${e.value}`),
  ].join('\n');

  const reasons: string[] = [];
  if (DESTRUCTIVE_FILE_RE.test(corpus)) {
    reasons.push('包含删除、递归清理或磁盘格式化等破坏性文件操作');
  }
  if (DESTRUCTIVE_GIT_RE.test(corpus)) {
    reasons.push('包含不可逆的 Git 历史重置、强制推送或工作区清理');
  }
  if (PROCESS_SYSTEM_RE.test(corpus)) {
    reasons.push('包含终止进程或系统关机/重启控制指令');
  }
  if (PRIVILEGE_PERM_RE.test(corpus)) {
    reasons.push('涉及系统权限、ACL、注册表或提权操作');
  }
  if (SENSITIVE_PATH_RE.test(corpus)) {
    reasons.push('目标路径涉及敏感凭据、密钥配置或系统核心目录');
  }
  if (REMOTE_EXEC_RE.test(corpus)) {
    reasons.push('包含动态脚本执行或远程下载管道执行');
  }

  return {
    highRisk: reasons.length > 0,
    riskLevel: reasons.length > 0 ? 'high' : 'normal',
    riskReasons: reasons,
  };
}

export function isHighRiskApproval(a: ApprovalCandidate): boolean {
  return assessApprovalRisk(a).highRisk;
}

/**
 * 校正队列游标，确保列表增删后始终落在有效范围内。
 */
export function clampQueueIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

export type SubmitActionResult =
  | { status: 'armed'; rpcId: string; expiresAt: number }
  | { status: 'sent'; rpcId: string; outcome: ApprovalDecision }
  | { status: 'duplicate'; rpcId: string }
  | { status: 'failed'; rpcId: string; error: string };

/**
 * 审批提交与回滚状态机（可独立在 Node 单测中验证）：
 *   - 高危操作「允许一次」必须先 arm，有效期内第二次点击才真正发送；
 *   - 同一 `rpcId` 在途期间（`inFlightIds`）拒绝重复点击；
 *   - 断线 / 401 / 403 / `send` 返回 `false` 时，不进入 `inFlightIds`，保持待审批并写入明确错误；
 *   - 发送成功后若超时未收到服务端 `approval-resolved`，或中途网关断线 / 401 / 403，
 *     立即从 `inFlightIds` 移除恢复待审批状态，并记录明确错误提示。
 */
export class ApprovalSubmitController {
  private armedRpcId: string | null = null;
  private armedUntil = 0;
  private readonly inFlight = new Map<string, { outcome: ApprovalDecision; sentAt: number }>();
  private readonly errors = new Map<string, string>();
  private readonly armTimeoutMs: number;
  private readonly commitTimeoutMs: number;

  constructor(opts?: { armTimeoutMs?: number; commitTimeoutMs?: number }) {
    this.armTimeoutMs = opts?.armTimeoutMs ?? HIGH_RISK_ARM_TIMEOUT_MS;
    this.commitTimeoutMs = opts?.commitTimeoutMs ?? APPROVAL_COMMIT_TIMEOUT_MS;
  }

  get inFlightIds(): ReadonlySet<string> {
    return new Set(this.inFlight.keys());
  }

  isArmed(rpcId: string, now = Date.now()): boolean {
    if (!rpcId || this.armedRpcId !== rpcId) return false;
    if (now >= this.armedUntil) {
      this.armedRpcId = null;
      this.armedUntil = 0;
      return false;
    }
    return true;
  }

  disarm(): void {
    this.armedRpcId = null;
    this.armedUntil = 0;
  }

  errorFor(rpcId: string): string | null {
    return this.errors.get(rpcId) ?? null;
  }

  clearError(rpcId: string): void {
    this.errors.delete(rpcId);
  }

  /**
   * 触发一次审批决策（允许一次 / 拒绝）。
   */
  submit(params: {
    approval: ApprovalCandidate;
    outcome: ApprovalDecision;
    gatewayOnline: boolean;
    authInvalidated?: boolean;
    now?: number;
    send: (approval: ApprovalCandidate, outcome: ApprovalDecision) => boolean;
  }): SubmitActionResult {
    const { approval, outcome, gatewayOnline, authInvalidated = false, send } = params;
    const now = params.now ?? Date.now();
    const rpcId = approval.id;

    if (this.inFlight.has(rpcId)) {
      return { status: 'duplicate', rpcId };
    }

    // 高危操作点「允许一次」必须两步确认（拒绝无需二次确认）
    if (outcome === 'allowed-once' && isHighRiskApproval(approval)) {
      if (!this.isArmed(rpcId, now)) {
        this.armedRpcId = rpcId;
        this.armedUntil = now + this.armTimeoutMs;
        this.errors.delete(rpcId);
        return { status: 'armed', rpcId, expiresAt: this.armedUntil };
      }
    }

    this.disarm();

    if (authInvalidated) {
      const error = '审批提交失败：登录状态已失效或访问受限（401/403），请重新连接后再试';
      this.errors.set(rpcId, error);
      return { status: 'failed', rpcId, error };
    }

    if (!gatewayOnline) {
      const error = '审批提交失败：审批通道未连接，待审批状态已保留，请等待重连后重试';
      this.errors.set(rpcId, error);
      return { status: 'failed', rpcId, error };
    }

    let ok = false;
    try {
      ok = send(approval, outcome);
    } catch {
      ok = false;
    }

    if (!ok) {
      const error = '审批提交失败：未能送达电脑，待审批状态已保留，请重试';
      this.errors.set(rpcId, error);
      return { status: 'failed', rpcId, error };
    }

    this.errors.delete(rpcId);
    this.inFlight.set(rpcId, { outcome, sentAt: now });
    return { status: 'sent', rpcId, outcome };
  }

  /**
   * 与当前服务端仍在等待的 `pendingApprovals` 对账：
   *   - 若某条在途 `rpcId` 已经不在服务端待审批列表中（且当前未断线/未 401），说明服务端已确认解决；
   *   - 若网关断线或发生 401/403，但该 `rpcId` 仍未解决，则立即回滚恢复为待审批并提示失败；
   *   - 若超过 `commitTimeoutMs` 仍未收到服务端 `approval-resolved`，自动回滚恢复待审批并提示超时。
   *
   * @returns 是否有在途状态发生回滚或完成变更
   */
  reconcile(params: {
    serverPendingIds: ReadonlySet<string>;
    gatewayOnline: boolean;
    authInvalidated?: boolean;
    now?: number;
  }): boolean {
    const { serverPendingIds, gatewayOnline, authInvalidated = false } = params;
    const now = params.now ?? Date.now();
    let changed = false;

    for (const [rpcId, meta] of [...this.inFlight.entries()]) {
      if (!serverPendingIds.has(rpcId)) {
        // 服务端已移除该待审批
        this.inFlight.delete(rpcId);
        this.errors.delete(rpcId);
        changed = true;
        continue;
      }

      if (authInvalidated) {
        this.inFlight.delete(rpcId);
        this.errors.set(
          rpcId,
          '审批提交未完成：登录状态已失效或受限（401/403），已恢复待审批状态',
        );
        changed = true;
        continue;
      }

      if (!gatewayOnline) {
        this.inFlight.delete(rpcId);
        this.errors.set(
          rpcId,
          '审批通道在确认前断开，未收到电脑确认，已恢复待审批状态，请重连后重试',
        );
        changed = true;
        continue;
      }

      if (now - meta.sentAt >= this.commitTimeoutMs) {
        this.inFlight.delete(rpcId);
        this.errors.set(
          rpcId,
          '审批响应超时（电脑未确认），已恢复待审批状态，请检查电脑端状态后重试',
        );
        changed = true;
      }
    }

    return changed;
  }
}
