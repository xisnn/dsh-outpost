/**
 * Rurea C4 错误分类与可恢复动作规划（纯 TS，零原生依赖，可完整单测）：
 *
 * 将 native Run 失败、在途中断、动作拒绝、状态读取失败、后台虚拟屏/Shizuku 故障、
 * 无障碍未连接、崩溃恢复原因以及执行时间线归一化为清晰中文提示与一步直达恢复按钮。
 *
 * 严格约束：只能使用 `import type` 引入类型，绝不触发 `react-native` 运行时加载。
 */
import type {
  AgentRecovery,
  AgentRunEvent,
  BackgroundDisplayStatus,
} from './agent';

export type AgentFailureCategory =
  | 'model_config'
  | 'model_auth'
  | 'model_rate_limit'
  | 'network'
  | 'model_provider'
  | 'background_display'
  | 'accessibility'
  | 'step_limit'
  | 'interrupted'
  | 'approval_state'
  | 'snapshot_read'
  | 'runtime';

export type AgentRecoveryTone = 'danger' | 'warning';

export type AgentRecoveryActionId =
  | 'retry_goal'
  | 'edit_goal'
  | 'open_settings'
  | 'retry_background'
  | 'open_shizuku'
  | 'open_background'
  | 'disable_auto_start'
  | 'open_accessibility'
  | 'refresh_snapshot'
  | 'dismiss';

export interface AgentRecoveryAction {
  id: AgentRecoveryActionId;
  label: string;
  emphasis: 'primary' | 'secondary';
}

export interface AgentFailureInput {
  raw: string | null | undefined;
  code?: string | null;
  source: 'run' | 'interrupted' | 'action' | 'read';
  goal?: string | null;
  hasSideEffects?: boolean;
  background?: BackgroundDisplayStatus | null;
  autoStartEnabled?: boolean;
}

export interface AgentRecoveryPlan {
  category: AgentFailureCategory;
  tone: AgentRecoveryTone;
  title: string;
  hint: string;
  sideEffectWarning: string | null;
  detail: string | null;
  actions: AgentRecoveryAction[];
}

const READ_ONLY_TOOLS = new Set([
  'workspace_read',
  'workspace_list',
  'phone_screen',
  'phone_apps',
  'phone_handoff',
]);

const SIDE_EFFECT_WARNING_TEXT =
  '本次任务已执行过部分操作，重新发起会从头开始；建议先确认当前状态，或填入输入框调整后再发。';

const DISMISS_ACTION: AgentRecoveryAction = {
  id: 'dismiss',
  label: '知道了',
  emphasis: 'secondary',
};

const RECOVERABLE_INTERRUPTED_REASONS = new Set([
  'run-deadline-exceeded',
  'fgs-system-timeout',
  'screen-off',
]);

const STOPPABLE_BACKGROUND_STATES = new Set([
  'binding',
  'retrying',
  'retry_exhausted',
  'permission_required',
  'permission_revoked',
  'permission_denied',
]);

const FAILURE_BACKGROUND_STATES = new Set([
  'error',
  'disconnected',
  'retry_exhausted',
  'retrying',
  'permission_revoked',
  'permission_denied',
  'permission_required',
  'shizuku_stopped',
  'shizuku_not_running',
]);

export function extractAgentError(failure: unknown): { code: string | null; message: string } {
  const rawCode = (failure as { code?: unknown } | null | undefined)?.code;
  const code = typeof rawCode === 'string' && rawCode.trim().length > 0 ? rawCode.trim() : null;
  const rawMessage =
    failure instanceof Error
      ? failure.message
      : (failure as { message?: unknown } | null | undefined)?.message ?? failure;
  const message = typeof rawMessage === 'string' ? rawMessage : String(rawMessage ?? '');
  return { code, message };
}

export function hasRunSideEffects(events: readonly AgentRunEvent[] | null | undefined): boolean {
  if (!events || events.length === 0) return false;
  return events.some(
    (event) =>
      event.type === 'tool_finished' &&
      event.status === 'OK' &&
      (!event.toolName || !READ_ONLY_TOOLS.has(event.toolName)),
  );
}

export function hasAccessibilityToolError(events: readonly AgentRunEvent[] | null | undefined): boolean {
  if (!events || events.length === 0) return false;
  return events
    .slice(-8)
    .some(
      (event) =>
        event.type === 'tool_finished' &&
        event.status === 'ERROR' &&
        /ACCESSIBILITY_NOT_CONNECTED|SCREEN_LOCKED/i.test(event.detail ?? ''),
    );
}

export function isRecoverableInterruptedReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return RECOVERABLE_INTERRUPTED_REASONS.has(reason.trim());
}

export function canStopBackgroundDisplay(
  status: Pick<BackgroundDisplayStatus, 'connected' | 'state'> | null | undefined,
): boolean {
  if (!status) return false;
  return Boolean(status.connected) || STOPPABLE_BACKGROUND_STATES.has(status.state);
}

export function isBackgroundFailureState(state: string | null | undefined): boolean {
  if (!state) return false;
  return FAILURE_BACKGROUND_STATES.has(state);
}

export function formatCrashRecoveryReason(
  recovery: Pick<AgentRecovery, 'reason' | 'requiresReconciliation'>,
): string {
  const reason = recovery.reason?.trim() ?? '';
  if (/tool result unknown/i.test(reason)) {
    return '上次进程意外终止，当时可能正在执行有副作用的工具，实际结果未知；请先核对手机屏幕或工作区文件。';
  }
  if (/pending approval discarded/i.test(reason)) {
    return '上次进程中断时正在等待你的审批；旧审批已全部作废，不会自动恢复执行。';
  }
  if (/read-only tool was interrupted/i.test(reason)) {
    return '上次进程中断时正在执行只读查询，任务未自动恢复。';
  }
  if (/run was not resumed/i.test(reason)) {
    return '上次进程意外中断，任务未继续执行。';
  }
  if (reason.length > 0) return reason;
  return recovery.requiresReconciliation
    ? '上次进程意外终止，部分操作结果未知。'
    : '上次进程中断，任务没有恢复。';
}

export function formatTimelineEvent(
  event: AgentRunEvent,
): { label: string; tone: 'pending' | 'ok' | 'warning' | 'error' } {
  const toolName = event.toolName ?? '工具';
  const detail = event.detail ?? '';

  if (event.type === 'tool_started') {
    return { label: `调用 ${toolName}`, tone: 'pending' };
  }
  if (event.type === 'approval_expired') {
    return { label: `${toolName} · 审批超时已自动拒绝`, tone: 'warning' };
  }
  if (event.type === 'tool_finished') {
    if (event.status === 'OK') {
      return { label: `${toolName} · 完成`, tone: 'ok' };
    }
    if (event.status === 'DENIED') {
      if (/PAYMENT_HARD_DENIED/i.test(detail)) {
        return { label: `${toolName} · 支付操作已硬禁止`, tone: 'warning' };
      }
      if (/SENSITIVE_SCREEN|OPEN_SENSITIVE_PACKAGE|PASSWORD_FIELD/i.test(detail)) {
        return { label: `${toolName} · 敏感页面已转交接管`, tone: 'warning' };
      }
      return { label: `${toolName} · 已拒绝`, tone: 'warning' };
    }
    if (/ACCESSIBILITY_NOT_CONNECTED/i.test(detail)) {
      return { label: `${toolName} · 无障碍未连接`, tone: 'error' };
    }
    if (/BACKGROUND_DISPLAY_LOST|BACKGROUND_DISPLAY_UNAVAILABLE/i.test(detail)) {
      return { label: `${toolName} · 后台屏已断开`, tone: 'error' };
    }
    if (/STALE_NODE|STALE_SCREEN/i.test(detail)) {
      return { label: `${toolName} · 页面已变化`, tone: 'error' };
    }
    if (/SCREEN_LOCKED/i.test(detail)) {
      return { label: `${toolName} · 屏幕已锁定`, tone: 'error' };
    }
    if (/OPEN_TIMEOUT/i.test(detail)) {
      return { label: `${toolName} · 打开应用超时`, tone: 'error' };
    }
    if (/CANCELLED/i.test(detail)) {
      return { label: `${toolName} · 已取消`, tone: 'error' };
    }
    return { label: `${toolName} · 执行错误`, tone: 'error' };
  }
  return { label: `${toolName} · ${event.type}`, tone: 'pending' };
}

function formatDetail(code: string | null | undefined, raw: string | null | undefined): string | null {
  const cleanCode = code?.trim() ?? '';
  const cleanRaw = raw?.trim() ?? '';
  if (!cleanCode && !cleanRaw) return null;
  if (!cleanCode) return cleanRaw;
  if (!cleanRaw || cleanRaw === cleanCode) return cleanCode;
  if (cleanRaw.startsWith(`${cleanCode}:`) || cleanRaw.startsWith(`${cleanCode}：`)) {
    return cleanRaw;
  }
  return `${cleanCode}: ${cleanRaw}`;
}

function buildGoalActions(
  goal: string | null | undefined,
  hasSideEffects: boolean,
  primaryPreferred: boolean,
): { actions: AgentRecoveryAction[]; sideEffectWarning: string | null } {
  if (!goal || goal.trim().length === 0) {
    return { actions: [], sideEffectWarning: null };
  }
  const firstEmphasis = primaryPreferred ? 'primary' : 'secondary';
  if (hasSideEffects) {
    return {
      sideEffectWarning: SIDE_EFFECT_WARNING_TEXT,
      actions: [
        { id: 'edit_goal', label: '填入输入框', emphasis: firstEmphasis },
        { id: 'retry_goal', label: '从头重试', emphasis: 'secondary' },
      ],
    };
  }
  return {
    sideEffectWarning: null,
    actions: [{ id: 'retry_goal', label: '重试任务', emphasis: firstEmphasis }],
  };
}

function dedupeActions(rawActions: AgentRecoveryAction[]): AgentRecoveryAction[] {
  const seen = new Set<AgentRecoveryActionId>();
  const out: AgentRecoveryAction[] = [];
  for (const action of rawActions) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    out.push(action);
  }
  if (!seen.has('dismiss')) {
    out.push(DISMISS_ACTION);
  }
  return out;
}

export function classifyAgentFailure(input: AgentFailureInput): AgentRecoveryPlan {
  const raw = input.raw?.trim() ?? '';
  const code = input.code?.trim() ?? '';
  const combined = [code, raw].filter(Boolean).join('\n');
  const goal = input.goal?.trim() ? input.goal.trim() : null;
  const hasSideEffects = Boolean(input.hasSideEffects);
  const bg = input.background ?? null;
  const detail = formatDetail(code, raw);

  const finalize = (
    plan: Omit<AgentRecoveryPlan, 'detail' | 'actions' | 'sideEffectWarning'> & {
      actions: AgentRecoveryAction[];
      sideEffectWarning?: string | null;
    },
  ): AgentRecoveryPlan => ({
    category: plan.category,
    tone: plan.tone,
    title: plan.title,
    hint: plan.hint,
    sideEffectWarning: plan.sideEffectWarning ?? null,
    detail,
    actions: dedupeActions(plan.actions),
  });

  // 1. State read failure
  if (input.source === 'read') {
    return finalize({
      category: 'snapshot_read',
      tone: 'danger',
      title: '无法读取 Agent 运行状态',
      hint: '本机状态快照读取失败；任务本身可能仍在后台继续，点「立即刷新」重新同步。',
      actions: [{ id: 'refresh_snapshot', label: '立即刷新', emphasis: 'primary' }],
    });
  }

  // 2. Background display / Shizuku faults
  if (/BACKGROUND_NOT_READY|BACKGROUND_DISPLAY_LOST|BACKGROUND_DISPLAY_UNAVAILABLE|shizuku|后台屏|后台模式/i.test(combined)) {
    let title = '后台副屏暂时不可用';
    let hint = '后台虚拟屏已断开或尚未就绪，任务不会悄悄切到主屏操作；可重试连接或打开后台屏设置查看原因。';
    const actions: AgentRecoveryAction[] = [];

    if (bg && !bg.installed) {
      title = '未安装 Shizuku';
      hint = '已开启后台虚拟屏模式，但手机尚未安装 Shizuku。请先安装 Shizuku，或在后台屏设置中调整。';
      actions.push({ id: 'open_background', label: '后台屏设置', emphasis: 'primary' });
    } else if (bg && !bg.shizukuRunning) {
      title = 'Shizuku 未运行，后台屏无法启动';
      hint = '请先打开 Shizuku 并保持其服务运行，再返回重试后台屏；不会绕过后台屏切回主屏。';
      actions.push(
        { id: 'open_shizuku', label: '打开 Shizuku', emphasis: 'primary' },
        { id: 'retry_background', label: '重试后台屏', emphasis: 'secondary' },
        { id: 'open_background', label: '后台屏设置', emphasis: 'secondary' },
      );
    } else if (bg && !bg.permissionGranted) {
      title = '缺少 Shizuku 授权';
      hint = '后台屏需要获得 Shizuku 授权后才能继续使用，不会擅自退回主屏；请重新授权后再试。';
      actions.push(
        { id: 'retry_background', label: '重新授权后台屏', emphasis: 'primary' },
        { id: 'open_background', label: '后台屏设置', emphasis: 'secondary' },
      );
    } else {
      actions.push(
        { id: 'retry_background', label: '重试后台屏', emphasis: 'primary' },
        { id: 'open_background', label: '后台屏设置', emphasis: 'secondary' },
      );
    }

    if (input.autoStartEnabled) {
      actions.push({ id: 'disable_auto_start', label: '关闭自动后台屏', emphasis: 'secondary' });
    }

    return finalize({
      category: 'background_display',
      tone: 'danger',
      title,
      hint,
      actions,
    });
  }

  // 3. Accessibility & lock-screen faults
  if (/ACCESSIBILITY_NOT_CONNECTED|ACCESSIBILITY_NO_ACTIVE_WINDOW|SCREEN_LOCKED/i.test(combined)) {
    if (/SCREEN_LOCKED/i.test(combined)) {
      const goalPlan = buildGoalActions(goal, hasSideEffects, true);
      const actions: AgentRecoveryAction[] = [
        ...(goalPlan.actions.length > 0
          ? goalPlan.actions
          : [{ id: 'refresh_snapshot' as const, label: '刷新状态', emphasis: 'primary' as const }]),
        { id: 'open_settings', label: '检查手机能力', emphasis: 'secondary' },
      ];
      return finalize({
        category: 'accessibility',
        tone: 'warning',
        title: '手机屏幕已锁定',
        hint: '锁屏状态下系统安全门禁止执行手机控制；请先解锁屏幕后再重试任务。',
        sideEffectWarning: goalPlan.sideEffectWarning,
        actions,
      });
    }

    const goalPlan = buildGoalActions(goal, hasSideEffects, false);
    return finalize({
      category: 'accessibility',
      tone: 'danger',
      title: '无障碍服务未连接',
      hint: '系统无障碍服务未开启或已被系统回收；请前往无障碍设置重新开启本应用服务后重试。',
      sideEffectWarning: goalPlan.sideEffectWarning,
      actions: [
        { id: 'open_accessibility', label: '打开无障碍设置', emphasis: 'primary' },
        { id: 'open_settings', label: '检查手机能力', emphasis: 'secondary' },
        ...goalPlan.actions,
      ],
    });
  }

  // 4. Approval handshake / TTL faults
  if (/APPROVAL_EXPIRED|APPROVAL_TTL_UNVERIFIABLE|STALE_APPROVAL|NO_PENDING_APPROVAL|DECISION_IN_PROGRESS/i.test(combined)) {
    let title = '审批状态已变化';
    let hint = '请刷新最新运行状态确认当前待处理卡片。';
    if (/APPROVAL_EXPIRED/i.test(combined)) {
      title = '审批已超时失效';
      hint = '该审批已超过 5 分钟有效期并自动拒绝，本次操作不会执行；请刷新状态查看后续安排。';
    } else if (/APPROVAL_TTL_UNVERIFIABLE/i.test(combined)) {
      title = '无法校验审批有效期';
      hint = '系统未能校验这条审批的签发时间，按安全策略拒绝放行；请刷新状态。';
    } else if (/STALE_APPROVAL/i.test(combined)) {
      title = '待审批操作已变更';
      hint = '页面上的审批卡片已过期或已被其他操作更新，请刷新同步最新状态。';
    } else if (/NO_PENDING_APPROVAL/i.test(combined)) {
      title = '当前没有待审批操作';
      hint = '该审批可能已在悬浮窗完成处理或随任务结束清理，请刷新确认当前状态。';
    } else if (/DECISION_IN_PROGRESS/i.test(combined)) {
      title = '审批正在处理中';
      hint = '上一条审批决定正在提交给本机运行时，请稍后刷新查看进度。';
    }
    return finalize({
      category: 'approval_state',
      tone: 'warning',
      title,
      hint,
      actions: [{ id: 'refresh_snapshot', label: '刷新状态', emphasis: 'primary' }],
    });
  }

  // 5. Recoverable interruptions (deadline / FGS timeout / screen-off)
  if (input.source === 'interrupted' || /run-deadline-exceeded|fgs-system-timeout|screen-off/i.test(combined)) {
    let title = '任务已中断';
    let hint = '任务已安全停下，不会自动重放未完成步骤；如需继续，请填入输入框确认后再发。';
    if (/run-deadline-exceeded/i.test(combined)) {
      title = '任务已超时自动停止';
      hint = '单次运行已达到 30 分钟安全上限并优雅收尾，不会继续消耗额度；如需继续，请填入输入框确认后再发。';
    } else if (/fgs-system-timeout/i.test(combined)) {
      title = '系统超时，任务已优雅停止';
      hint = 'Android 系统对前台服务时间做出限制，运行时已主动收尾并保存结果；可填入输入框后重新发起。';
    } else if (/screen-off/i.test(combined)) {
      title = '息屏已自动停止任务';
      hint = '息屏时当前任务与手机手势会立即中止，亮屏后不会自动重放；如需继续，请填入输入框重新发起。';
    }
    return finalize({
      category: 'interrupted',
      tone: 'warning',
      title,
      hint,
      sideEffectWarning: hasSideEffects && goal ? SIDE_EFFECT_WARNING_TEXT : null,
      actions: [
        goal
          ? { id: 'edit_goal', label: '填入输入框', emphasis: 'primary' }
          : { id: 'refresh_snapshot', label: '刷新状态', emphasis: 'primary' },
      ],
    });
  }

  // 6. Step limit
  if (/step-limit/i.test(combined)) {
    return finalize({
      category: 'step_limit',
      tone: 'warning',
      title: '已达到单次执行步数上限',
      hint: '任务在单次最大步数边界处安全停下，可把指令填入输入框补充限定条件或接着执行。',
      sideEffectWarning: hasSideEffects && goal ? SIDE_EFFECT_WARNING_TEXT : null,
      actions: [
        goal
          ? { id: 'edit_goal', label: '填入输入框继续', emphasis: 'primary' }
          : { id: 'refresh_snapshot', label: '刷新状态', emphasis: 'primary' },
      ],
    });
  }

  // 7. Model configuration issues
  if (/MODEL_NOT_CONFIGURED|missing-key|missing-model|invalid-base-url|insecure-base-url|invalid-model/i.test(combined)) {
    let title = '模型设置需要完善';
    let hint = '请前往「模型与凭据」检查协议、服务地址、模型名与 API Key。';
    if (/insecure-base-url/i.test(combined)) {
      title = '模型服务地址必须使用 HTTPS';
      hint = '为保护 API Key 不在公网明文传输，仅 localhost / 127.0.0.1 允许使用 HTTP；请修改为 https:// 地址。';
    } else if (/invalid-base-url/i.test(combined)) {
      title = '模型服务地址格式无效';
      hint = 'Base URL 必须以 https:// 开头（本机回环测试可用 http://127.0.0.1），请检查拼写。';
    } else if (/invalid-model/i.test(combined)) {
      title = '模型名称格式不支持';
      hint = '当前模型名包含服务商协议不允许的字符，请在模型设置中核对后保存。';
    } else if (/missing-key/i.test(combined)) {
      title = '未配置 API Key';
      hint = '当前尚未保存可用的 API Key（仅存放在本机 Keystore），请前往模型设置填写。';
    } else if (/MODEL_NOT_CONFIGURED|missing-model/i.test(combined)) {
      title = '尚未配置云端模型';
      hint = '运行前需要配置云端模型名称与 API Key，请前往模型设置完成配置。';
    }
    const actions: AgentRecoveryAction[] = [
      { id: 'open_settings', label: '检查模型设置', emphasis: 'primary' },
    ];
    if (goal) {
      actions.push({ id: 'edit_goal', label: '保留到输入框', emphasis: 'secondary' });
    }
    return finalize({
      category: 'model_config',
      tone: 'danger',
      title,
      hint,
      actions,
    });
  }

  // 8. Model authentication & authorization (401 vs 403)
  if (/http-401|http-403|\bunauthorized\b|invalid[_\s-]*api[_\s-]*key|authentication_error|permission_error/i.test(combined)) {
    const is403 = /http-403|permission_error/i.test(combined);
    const goalPlan = buildGoalActions(goal, hasSideEffects, false);
    return finalize({
      category: 'model_auth',
      tone: 'danger',
      title: is403 ? '模型服务拒绝访问（403）' : '模型 API Key 认证失败（401）',
      hint: is403
        ? '当前账号或 API Key 无权调用该模型、受来源限制或余额已停用；本机 Key 仍保留，请核对账户权限或更换模型。'
        : '服务商拒绝了当前 API Key（无效、已过期或与服务地址不匹配），请前往模型设置更新 Key。',
      sideEffectWarning: goalPlan.sideEffectWarning,
      actions: [
        { id: 'open_settings', label: '检查模型设置', emphasis: 'primary' },
        ...goalPlan.actions,
      ],
    });
  }

  // 9. Rate limit / quota exhaustion (429)
  if (/http-429|rate[_\s-]*limit|too many requests|insufficient_quota|\bquota\b/i.test(combined)) {
    const goalPlan = buildGoalActions(goal, hasSideEffects, true);
    return finalize({
      category: 'model_rate_limit',
      tone: 'warning',
      title: '模型请求频率或额度受限',
      hint: '服务商返回限流或额度不足（429），可稍等片刻后重试，或前往模型设置核对计费与模型配额。',
      sideEffectWarning: goalPlan.sideEffectWarning,
      actions: [
        ...goalPlan.actions,
        { id: 'open_settings', label: '检查模型设置', emphasis: 'secondary' },
      ],
    });
  }

  // 10. Transport / network faults (avoid swallowing explicit non-network HTTP 3xx/4xx/5xx statuses)
  const hasExplicitProviderHttp = /\bhttp-(?:3\d\d|400|404|408|422|5\d\d)\b/i.test(combined);
  if (
    !hasExplicitProviderHttp &&
    /model-transport|unknownhost|sockettimeout|connectexception|sslexception|sslhandshake|eofexception|socketexception|timed out|\btimeout\b|\bnetwork\b|unreachable|connection reset|connection refused|broken pipe|failed to connect/i.test(
      combined,
    )
  ) {
    let title = '网络连接中断';
    let hint = '无法连接模型服务器或流式传输中途断开；请检查当前网络、代理设置后重试。';
    if (/unknownhost|nodename nor servname|name or service not known|unable to resolve host/i.test(combined)) {
      title = '无法解析模型服务器地址';
      hint = '请检查手机网络或代理连通性，并确认模型设置中的 Base URL 域名拼写正确。';
    } else if (/ssl|tls|cert|handshake|trust anchor/i.test(combined)) {
      title = '模型服务 HTTPS / 证书握手失败';
      hint = '安全连接建立失败；请检查网络代理、手机系统时间，或核对模型服务地址是否合法。';
    } else if (/sockettimeout|timed out|\btimeout\b/i.test(combined)) {
      title = '模型请求超时';
      hint = '等待云端模型响应超时，当前任务状态已安全保存；可直接重试或切换更稳定的网络。';
    }
    const goalPlan = buildGoalActions(goal, hasSideEffects, true);
    return finalize({
      category: 'network',
      tone: 'danger',
      title,
      hint,
      sideEffectWarning: goalPlan.sideEffectWarning,
      actions: [
        ...goalPlan.actions,
        { id: 'open_settings', label: '检查服务地址', emphasis: 'secondary' },
      ],
    });
  }

  // 11. Model provider / protocol / response faults
  if (
    hasExplicitProviderHttp ||
    /provider-error|provider-blocked|provider-stop|protocol-error|tool-arguments|empty-reply|empty-tool-calls|model-error/i.test(
      combined,
    )
  ) {
    if (/http-400|http-404|http-422|http-3\d\d|protocol-error/i.test(combined)) {
      const goalPlan = buildGoalActions(goal, hasSideEffects, false);
      return finalize({
        category: 'model_provider',
        tone: 'danger',
        title: '模型接口协议或参数不匹配',
        hint: '服务端返回协议或请求错误（如路径 404、参数 400 或不遵循预期 SSE 格式）；请核对接口协议、Base URL 与模型名。',
        sideEffectWarning: goalPlan.sideEffectWarning,
        actions: [
          { id: 'open_settings', label: '检查模型与协议', emphasis: 'primary' },
          ...goalPlan.actions,
        ],
      });
    }

    if (/provider-blocked|provider-stop/i.test(combined)) {
      return finalize({
        category: 'model_provider',
        tone: 'warning',
        title: '模型服务商中止了本次回复',
        hint: '服务商因安全审核或异常停止条件中断了输出；建议调整任务描述后再试，避免重复触发拦截。',
        sideEffectWarning: hasSideEffects && goal ? SIDE_EFFECT_WARNING_TEXT : null,
        actions: goal
          ? [
              { id: 'edit_goal', label: '修改后重试', emphasis: 'primary' },
              { id: 'retry_goal', label: '直接重试', emphasis: 'secondary' },
              { id: 'open_settings', label: '检查模型设置', emphasis: 'secondary' },
            ]
          : [{ id: 'open_settings', label: '检查模型设置', emphasis: 'secondary' }],
      });
    }

    if (/http-5\d\d|http-408/i.test(combined)) {
      const goalPlan = buildGoalActions(goal, hasSideEffects, true);
      return finalize({
        category: 'model_provider',
        tone: 'danger',
        title: '模型服务商暂时不可用',
        hint: '云端模型服务返回临时错误（5xx / 408），通常稍候重试或检查服务商状态即可恢复。',
        sideEffectWarning: goalPlan.sideEffectWarning,
        actions: [
          ...goalPlan.actions,
          { id: 'open_settings', label: '检查模型设置', emphasis: 'secondary' },
        ],
      });
    }

    const goalPlan = buildGoalActions(goal, hasSideEffects, true);
    return finalize({
      category: 'model_provider',
      tone: 'danger',
      title: '模型返回异常',
      hint: '模型返回了空回复、不合法的工具调用参数或服务商报错；可重试任务或检查当前模型设置。',
      sideEffectWarning: goalPlan.sideEffectWarning,
      actions: [
        ...goalPlan.actions,
        { id: 'open_settings', label: '检查模型设置', emphasis: 'secondary' },
      ],
    });
  }

  // 12. Runtime & fallback errors
  if (/QUEUE_FULL/i.test(combined)) {
    return finalize({
      category: 'runtime',
      tone: 'warning',
      title: '排队任务已满（最多 8 条）',
      hint: '当前已有较多排队任务；请等待前面任务完成，或刷新状态后清空重发。',
      actions: [
        { id: 'refresh_snapshot', label: '刷新状态', emphasis: 'primary' },
        ...(goal ? [{ id: 'edit_goal' as const, label: '留存到输入框', emphasis: 'secondary' as const }] : []),
      ],
    });
  }
  if (/AGENT_UNSUPPORTED/i.test(combined)) {
    return finalize({
      category: 'runtime',
      tone: 'danger',
      title: '当前系统版本不支持本机 Agent',
      hint: '本机手机管家需要 Android 8.0（API 26）及以上系统环境；可刷新检查设备能力。',
      actions: [{ id: 'refresh_snapshot', label: '刷新状态', emphasis: 'primary' }],
    });
  }
  if (/EMPTY_GOAL/i.test(combined)) {
    return finalize({
      category: 'runtime',
      tone: 'warning',
      title: '请先输入任务内容',
      hint: '不能发送空白任务；请在下方输入框告诉管家你要做什么。',
      actions: [{ id: 'refresh_snapshot', label: '刷新状态', emphasis: 'secondary' }],
    });
  }
  if (/NO_ACTIVE_RUN|NO_PENDING_HANDOFF/i.test(combined)) {
    return finalize({
      category: 'runtime',
      tone: 'warning',
      title: '任务状态已更新',
      hint: '当前操作对应的运行或接管状态已结束，请刷新同步最新界面。',
      actions: [{ id: 'refresh_snapshot', label: '立即刷新', emphasis: 'primary' }],
    });
  }
  if (/workspace-error/i.test(combined)) {
    const goalPlan = buildGoalActions(goal, hasSideEffects, true);
    return finalize({
      category: 'runtime',
      tone: 'danger',
      title: '工作区文件读写失败',
      hint: '本机工作区目录或文件暂时无法读写，请检查存储空间后重试，或刷新运行状态。',
      sideEffectWarning: goalPlan.sideEffectWarning,
      actions:
        goalPlan.actions.length > 0
          ? [...goalPlan.actions, { id: 'refresh_snapshot', label: '刷新状态', emphasis: 'secondary' }]
          : [{ id: 'refresh_snapshot', label: '刷新状态', emphasis: 'primary' }],
    });
  }

  const goalPlan = buildGoalActions(goal, hasSideEffects, true);
  return finalize({
    category: 'runtime',
    tone: 'danger',
    title: '执行遇到异常',
    hint: raw || '运行时发生未预期错误；可查看技术详情，并重试任务或刷新最新状态。',
    sideEffectWarning: goalPlan.sideEffectWarning,
    actions:
      goalPlan.actions.length > 0
        ? [...goalPlan.actions, { id: 'refresh_snapshot', label: '刷新状态', emphasis: 'secondary' }]
        : [{ id: 'refresh_snapshot', label: '刷新状态', emphasis: 'primary' }],
  });
}
