/**
 * Rurea C4 错误恢复 UX 回归与故障注入测试（归入 test:agentChain）：
 *
 * 覆盖：
 *   1. 纯逻辑（src/core/agentRecovery.ts）：
 *      - 模型/网络故障注入分类（配置/HTTPS/401/403/429/DNS/超时/TLS/5xx/协议400/截断）；
 *      - 副作用感知（只读可直重 vs 已有写入/点击警示 + edit_goal 优先 vs DENIED/ERROR 不误报）；
 *      - 后台屏/Shizuku 故障适配与关闭自动后台屏逃生出口；
 *      - 无障碍未连接 / 锁屏 / 审批过期与陈旧 / 步数上限 / 可恢复中断 / 读取失败 / 队列满；
 *      - RunRecovery 崩溃英文原因为中文可读 + 时间线语义格式化；
 *   2. UI 组件（src/components/AgentRecoveryCard.tsx）：
 *      - 恢复标题、建议、副作用警示、折叠技术详情切换、忙碌态下 dismiss 仍可点；
 *   3. 跨层接线校验：AgentRuntime / AgentService / agent.ts / AgentButlerScreen /
 *      AgentDemoScreen / BackgroundDisplayScreen 端到端闭环。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { componentHarness, loadSource } from './support/component-harness.mjs';

const recovery = loadSource('core/agentRecovery.ts');
const {
  canStopBackgroundDisplay,
  classifyAgentFailure,
  extractAgentError,
  formatCrashRecoveryReason,
  formatTimelineEvent,
  hasAccessibilityToolError,
  hasRunSideEffects,
  isBackgroundFailureState,
  isRecoverableInterruptedReason,
} = recovery;

const baseBg = (overrides = {}) => ({
  supported: true,
  installed: true,
  shizukuRunning: true,
  permissionGranted: true,
  connected: false,
  displayId: -1,
  frameAvailable: false,
  state: 'idle',
  error: null,
  ...overrides,
});

const actionIds = (plan) => plan.actions.map((a) => a.id);

test('classifyAgentFailure handles model config, auth (401 vs 403), rate limit, network, and provider faults', () => {
  const unconfigured = classifyAgentFailure({
    raw: 'MODEL_NOT_CONFIGURED',
    code: 'MODEL_NOT_CONFIGURED',
    source: 'action',
    goal: '帮我总结消息',
  });
  assert.equal(unconfigured.category, 'model_config');
  assert.equal(unconfigured.tone, 'danger');
  assert.equal(unconfigured.actions[0].id, 'open_settings');
  assert.ok(actionIds(unconfigured).includes('edit_goal'));

  const insecure = classifyAgentFailure({
    raw: 'insecure-base-url: cloud model base URL must use HTTPS',
    source: 'run',
    goal: '读取日程',
  });
  assert.equal(insecure.category, 'model_config');
  assert.match(insecure.title, /HTTPS/);
  assert.equal(insecure.actions[0].id, 'open_settings');

  const auth401 = classifyAgentFailure({
    raw: 'http-401: Incorrect API key provided',
    source: 'run',
    goal: '读屏',
  });
  assert.equal(auth401.category, 'model_auth');
  assert.match(auth401.title, /401/);
  assert.equal(auth401.actions[0].id, 'open_settings');

  const auth403 = classifyAgentFailure({
    raw: 'http-403: permission_error on model gpt-x',
    source: 'run',
    goal: '读屏',
  });
  assert.equal(auth403.category, 'model_auth');
  assert.match(auth403.title, /403/);
  assert.match(auth403.hint, /保留/);

  const rate429 = classifyAgentFailure({
    raw: 'http-429: Too Many Requests rate_limit_exceeded',
    source: 'run',
    goal: '刷新邮件',
  });
  assert.equal(rate429.category, 'model_rate_limit');
  assert.equal(rate429.tone, 'warning');
  assert.equal(rate429.actions[0].id, 'retry_goal');

  const dnsErr = classifyAgentFailure({
    raw: 'model-transport: Unable to resolve host "api.example.com": UnknownHostException',
    source: 'run',
    goal: '查天气',
  });
  assert.equal(dnsErr.category, 'network');
  assert.match(dnsErr.title, /解析/);
  assert.equal(dnsErr.actions[0].id, 'retry_goal');

  const timeoutErr = classifyAgentFailure({
    raw: 'model-transport: java.net.SocketTimeoutException: timeout',
    source: 'run',
    goal: '查天气',
  });
  assert.equal(timeoutErr.category, 'network');
  assert.match(timeoutErr.title, /超时/);

  const sslErr = classifyAgentFailure({
    raw: 'model-transport: javax.net.ssl.SSLHandshakeException: Trust anchor not found',
    source: 'run',
    goal: '查天气',
  });
  assert.equal(sslErr.category, 'network');
  assert.match(sslErr.title, /证书|HTTPS/);

  const http503 = classifyAgentFailure({
    raw: 'http-503: upstream connect timeout',
    source: 'run',
    goal: '打开设置',
  });
  assert.equal(http503.category, 'model_provider');
  assert.match(http503.title, /暂时不可用/);
  assert.equal(http503.actions[0].id, 'retry_goal');

  const http400 = classifyAgentFailure({
    raw: 'http-400: invalid parameter protocol-error',
    source: 'run',
    goal: '打开设置',
  });
  assert.equal(http400.category, 'model_provider');
  assert.equal(http400.actions[0].id, 'open_settings');

  const blocked = classifyAgentFailure({
    raw: 'provider-blocked: safety filter triggered',
    source: 'run',
    goal: '写一段话',
  });
  assert.equal(blocked.category, 'model_provider');
  assert.equal(blocked.tone, 'warning');
  assert.equal(blocked.actions[0].id, 'edit_goal');

  const emptyReply = classifyAgentFailure({
    raw: 'empty-reply: model returned no text or tool calls',
    source: 'run',
    goal: '总结',
  });
  assert.equal(emptyReply.category, 'model_provider');
  assert.equal(emptyReply.actions[0].id, 'retry_goal');
});

test('hasRunSideEffects enforces side-effect warning before retry on mutating tools', () => {
  const readOnlyEvents = [
    { seq: 1, type: 'tool_finished', toolName: 'phone_screen', status: 'OK', detail: '', at: 1 },
    { seq: 2, type: 'tool_finished', toolName: 'workspace_read', status: 'OK', detail: '', at: 2 },
    { seq: 3, type: 'tool_finished', toolName: 'phone_handoff', status: 'OK', detail: '', at: 3 },
  ];
  assert.equal(hasRunSideEffects(readOnlyEvents), false);

  const deniedMutatingEvents = [
    { seq: 1, type: 'tool_finished', toolName: 'phone_tap', status: 'DENIED', detail: 'PAYMENT_HARD_DENIED', at: 1 },
    { seq: 2, type: 'tool_finished', toolName: 'workspace_write', status: 'ERROR', detail: 'disk full', at: 2 },
  ];
  assert.equal(hasRunSideEffects(deniedMutatingEvents), false);

  const okMutatingEvents = [
    { seq: 1, type: 'tool_finished', toolName: 'phone_tap', status: 'OK', detail: 'TAPPED e1', at: 1 },
  ];
  assert.equal(hasRunSideEffects(okMutatingEvents), true);

  const safePlan = classifyAgentFailure({
    raw: 'http-503: server overloaded',
    source: 'run',
    goal: '看新闻',
    hasSideEffects: false,
  });
  assert.equal(safePlan.sideEffectWarning, null);
  assert.equal(safePlan.actions[0].id, 'retry_goal');

  const sideEffectPlan = classifyAgentFailure({
    raw: 'http-503: server overloaded',
    source: 'run',
    goal: '整理笔记',
    hasSideEffects: true,
  });
  assert.ok(sideEffectPlan.sideEffectWarning);
  assert.equal(sideEffectPlan.actions[0].id, 'edit_goal');
  assert.equal(sideEffectPlan.actions[1].id, 'retry_goal');
  assert.equal(sideEffectPlan.actions[1].label, '从头重试');
});

test('background display faults adapt to Shizuku state and expose escape hatches without main-screen fallback', () => {
  const notRunning = classifyAgentFailure({
    raw: '后台模式已开启，但后台屏未就绪',
    code: 'BACKGROUND_NOT_READY',
    source: 'action',
    background: baseBg({ shizukuRunning: false, state: 'shizuku_not_running' }),
    autoStartEnabled: true,
  });
  assert.equal(notRunning.category, 'background_display');
  assert.equal(notRunning.actions[0].id, 'open_shizuku');
  assert.ok(actionIds(notRunning).includes('retry_background'));
  assert.ok(actionIds(notRunning).includes('disable_auto_start'));

  const notInstalled = classifyAgentFailure({
    raw: 'BACKGROUND_NOT_READY',
    code: 'BACKGROUND_NOT_READY',
    source: 'action',
    background: baseBg({ installed: false, shizukuRunning: false, permissionGranted: false }),
    autoStartEnabled: true,
  });
  assert.equal(notInstalled.actions[0].id, 'open_background');
  assert.ok(actionIds(notInstalled).includes('disable_auto_start'));

  const noPerm = classifyAgentFailure({
    raw: 'BACKGROUND_DISPLAY_LOST',
    source: 'run',
    background: baseBg({ permissionGranted: false, state: 'permission_revoked' }),
    autoStartEnabled: false,
  });
  assert.equal(noPerm.category, 'background_display');
  assert.equal(noPerm.actions[0].id, 'retry_background');
  assert.equal(actionIds(noPerm).includes('disable_auto_start'), false);

  assert.equal(canStopBackgroundDisplay(baseBg({ connected: false, state: 'binding' })), true);
  assert.equal(canStopBackgroundDisplay(baseBg({ connected: false, state: 'retrying' })), true);
  assert.equal(canStopBackgroundDisplay(baseBg({ connected: false, state: 'retry_exhausted' })), true);
  assert.equal(canStopBackgroundDisplay(baseBg({ connected: false, state: 'idle' })), false);
  assert.equal(canStopBackgroundDisplay(baseBg({ connected: true, state: 'running' })), true);

  assert.equal(isBackgroundFailureState('disconnected'), true);
  assert.equal(isBackgroundFailureState('retry_exhausted'), true);
  assert.equal(isBackgroundFailureState('idle'), false);
  assert.equal(isBackgroundFailureState('running'), false);
});

test('accessibility, approvals, step limit, interruptions, snapshot reads, crash recovery, and timeline formatters work accurately', () => {
  const a11y = classifyAgentFailure({
    raw: 'ACCESSIBILITY_NOT_CONNECTED',
    source: 'run',
    goal: '打开微信',
  });
  assert.equal(a11y.category, 'accessibility');
  assert.equal(a11y.actions[0].id, 'open_accessibility');

  const locked = classifyAgentFailure({
    raw: 'SCREEN_LOCKED: unlock first',
    source: 'run',
    goal: '查看通知',
  });
  assert.equal(locked.category, 'accessibility');
  assert.equal(locked.tone, 'warning');
  assert.equal(locked.actions[0].id, 'retry_goal');

  const approvalExpired = classifyAgentFailure({
    raw: 'APPROVAL_EXPIRED',
    code: 'APPROVAL_EXPIRED',
    source: 'action',
  });
  assert.equal(approvalExpired.category, 'approval_state');
  assert.equal(approvalExpired.tone, 'warning');
  assert.equal(approvalExpired.actions[0].id, 'refresh_snapshot');

  const stepLimit = classifyAgentFailure({
    raw: 'step-limit',
    source: 'run',
    goal: '长流程操作',
  });
  assert.equal(stepLimit.category, 'step_limit');
  assert.equal(stepLimit.tone, 'warning');
  assert.equal(stepLimit.actions[0].id, 'edit_goal');

  assert.equal(isRecoverableInterruptedReason('run-deadline-exceeded'), true);
  assert.equal(isRecoverableInterruptedReason('fgs-system-timeout'), true);
  assert.equal(isRecoverableInterruptedReason('screen-off'), true);
  assert.equal(isRecoverableInterruptedReason('stopped-by-user'), false);
  assert.equal(isRecoverableInterruptedReason(null), false);

  const screenOff = classifyAgentFailure({
    raw: 'screen-off',
    source: 'interrupted',
    goal: '继续看设置',
  });
  assert.equal(screenOff.category, 'interrupted');
  assert.equal(screenOff.tone, 'warning');
  assert.match(screenOff.title, /息屏/);
  assert.equal(screenOff.actions[0].id, 'edit_goal');

  const readFail = classifyAgentFailure({
    raw: 'bridge offline',
    source: 'read',
  });
  assert.equal(readFail.category, 'snapshot_read');
  assert.equal(readFail.actions[0].id, 'refresh_snapshot');

  const queueFull = classifyAgentFailure({
    raw: 'QUEUE_FULL',
    code: 'QUEUE_FULL',
    source: 'action',
    goal: '新任务',
  });
  assert.equal(queueFull.category, 'runtime');
  assert.match(queueFull.title, /已满/);

  const parsed = extractAgentError(Object.assign(new Error('BACKGROUND_NOT_READY'), { code: 'BACKGROUND_NOT_READY' }));
  assert.equal(parsed.code, 'BACKGROUND_NOT_READY');
  assert.equal(parsed.message, 'BACKGROUND_NOT_READY');

  const crashMsg = formatCrashRecoveryReason({
    reason: 'process-interrupted: tool result unknown; old approval discarded; not replayed',
    requiresReconciliation: true,
  });
  assert.match(crashMsg, /副作用/);

  const payEvt = formatTimelineEvent({
    seq: 1,
    type: 'tool_finished',
    toolName: 'phone_tap',
    status: 'DENIED',
    detail: 'PAYMENT_HARD_DENIED: checkout',
    at: 1,
  });
  assert.equal(payEvt.tone, 'warning');
  assert.match(payEvt.label, /支付操作已硬禁止/);

  const a11yEvt = formatTimelineEvent({
    seq: 2,
    type: 'tool_finished',
    toolName: 'phone_screen',
    status: 'ERROR',
    detail: 'ACCESSIBILITY_NOT_CONNECTED',
    at: 2,
  });
  assert.equal(a11yEvt.tone, 'error');
  assert.match(a11yEvt.label, /无障碍未连接/);

  assert.equal(
    hasAccessibilityToolError([{ seq: 1, type: 'tool_finished', toolName: 'phone_screen', status: 'ERROR', detail: 'ACCESSIBILITY_NOT_CONNECTED', at: 1 }]),
    true,
  );
  assert.equal(
    hasAccessibilityToolError([{ seq: 1, type: 'tool_finished', toolName: 'phone_screen', status: 'OK', detail: 'done', at: 1 }]),
    false,
  );
});

test('AgentRecoveryCard renders plan copy, collapsible technical details, and keeps dismiss enabled while busy', () => {
  const dispatched = [];
  const plan = classifyAgentFailure({
    raw: 'http-503: upstream error',
    source: 'run',
    goal: '整理文件夹',
    hasSideEffects: true,
  });

  const h = componentHarness(
    'components/AgentRecoveryCard.tsx',
    'AgentRecoveryCard',
    {
      plan,
      busy: false,
      onAction: (id) => dispatched.push(id),
    },
    { '../core/agentRecovery': recovery },
  );

  const initialText = h.text();
  assert.match(initialText, /模型服务商暂时不可用/);
  assert.match(initialText, /已执行过部分操作/);
  // Technical detail is collapsed by default.
  assert.doesNotMatch(initialText, /http-503: upstream error/);

  const expandBtn = h.button('查看技术详情');
  assert.ok(expandBtn, 'expected detail toggle button');
  expandBtn.props.onPress();
  h.render();
  assert.match(h.text(), /http-503: upstream error/);
  assert.ok(h.button('收起技术详情'));

  const editBtn = h.button('填入输入框');
  assert.ok(editBtn);
  editBtn.props.onPress();
  assert.deepEqual(dispatched, ['edit_goal']);

  // While busy, retry/edit are disabled, but dismiss stays clickable.
  h.render({ busy: true });
  assert.equal(h.button('从头重试').props.disabled, true);
  const dismissBtn = h.button('知道了');
  assert.equal(dismissBtn.props.disabled, false);
  dismissBtn.props.onPress();
  assert.deepEqual(dispatched, ['edit_goal', 'dismiss']);
});

test('C4 wiring spans AgentRuntime, AgentService, agent.ts, and all three Agent UI screens', () => {
  const runtime = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentRuntime.kt', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /\.put\("goal", currentGoal \?: run\?\.goal \?: JSONObject\.NULL\)/);
  assert.match(runtime, /"screen-off" ->/);

  const service = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentService.kt', import.meta.url),
    'utf8',
  );
  assert.match(service, /\.stop\("screen-off"\)/);

  const agentTs = fs.readFileSync(new URL('../src/core/agent.ts', import.meta.url), 'utf8');
  assert.match(agentTs, /err\.code = code/);
  assert.match(agentTs, /goal\?: string \| null/);

  const butler = fs.readFileSync(new URL('../src/screens/AgentButlerScreen.tsx', import.meta.url), 'utf8');
  assert.match(butler, /<AgentRecoveryCard\b/);
  assert.match(butler, /AppState\.addEventListener\('change'/);
  assert.match(butler, /formatCrashRecoveryReason\(/);
  assert.match(butler, /formatTimelineEvent\(/);
  assert.match(butler, /hasAccessibilityToolError\(/);
  assert.match(butler, /openAccessibility/);

  const demo = fs.readFileSync(new URL('../src/screens/AgentDemoScreen.tsx', import.meta.url), 'utf8');
  assert.match(demo, /<AgentRecoveryCard\b/);
  assert.match(demo, /formatCrashRecoveryReason\(/);

  const bg = fs.readFileSync(new URL('../src/screens/BackgroundDisplayScreen.tsx', import.meta.url), 'utf8');
  assert.match(bg, /canStopBackgroundDisplay\(status\)/);
  assert.match(bg, /agentClient\.backgroundRetry\(\)/);
  assert.match(bg, /取消连接/);
});
