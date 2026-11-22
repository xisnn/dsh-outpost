/**
 * Rurea C2 安全门回归测试（归入 test:agentChain）：
 *
 * 覆盖：
 *   1. 纯逻辑（src/core/agentApproval.ts）：审批 TTL 倒计时、过期禁用与边界；
 *   2. 跨层接线校验：
 *      - AgentRuntime：ActionSafetyPolicy 接入 + preExecute 支付双层复核 +
 *        有界 awaitApproval TTL 自动过期 + 有界 RunDeadline 暂停/接管等待 +
 *        实时 networkInFlight/toolLoopRunning 取消判定；
 *      - PhoneBridge：SENSITIVE_PACKAGES 去重（setOf）+ waitForPackage/stableSnapshot 可取消；
 *      - PhoneTools：5 个手机工具保留 ToolRisk.PHONE + sleepCancellable；
 *      - AgentService：onTimeout 传参 fgs-system-timeout；
 *      - AgentOverlayController / AgentButlerScreen / AgentDemoScreen：消费 expiresAt 与过期禁用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSource } from './support/component-harness.mjs';

const agentApproval = loadSource('core/agentApproval.ts');
const {
  approvalRemainingMs,
  isApprovalExpired,
  isApprovalAllowDisabled,
  formatApprovalCountdown,
} = agentApproval;

test('agentApproval computes TTL remaining time, expiry, and disable state accurately', () => {
  const now = 1_000_000;
  assert.equal(approvalRemainingMs(null, now), null);
  assert.equal(approvalRemainingMs({ expiresAt: undefined }, now), null);
  assert.equal(approvalRemainingMs({ expiresAt: 0 }, now), null);

  assert.equal(approvalRemainingMs({ expiresAt: now + 65_000 }, now), 65_000);
  assert.equal(approvalRemainingMs({ expiresAt: now }, now), 0);
  assert.equal(approvalRemainingMs({ expiresAt: now - 10 }, now), 0);

  assert.equal(isApprovalExpired({ expiresAt: now + 1 }, now), false);
  assert.equal(isApprovalExpired({ expiresAt: now }, now), true);
  assert.equal(isApprovalExpired({ expiresAt: now - 5_000 }, now), true);
  assert.equal(isApprovalExpired({ expiresAt: undefined }, now), false);

  assert.equal(isApprovalAllowDisabled({ backgroundLost: false, expiresAt: now + 10_000 }, now), false);
  assert.equal(isApprovalAllowDisabled({ backgroundLost: true, expiresAt: now + 10_000 }, now), true);
  assert.equal(isApprovalAllowDisabled({ backgroundLost: false, expiresAt: now }, now), true);

  assert.equal(formatApprovalCountdown({ expiresAt: now + 65_000 }, now), '剩余 1:05 后自动拒绝');
  assert.equal(formatApprovalCountdown({ expiresAt: now + 1 }, now), '剩余 0:01 后自动拒绝');
  assert.equal(formatApprovalCountdown({ expiresAt: now }, now), '审批已超时失效');
  assert.equal(formatApprovalCountdown({ expiresAt: undefined }, now), null);
});

test('AgentRuntime wires ActionSafetyPolicy, bounded TTL/RunDeadline waits, and InterruptPolicy flight state', () => {
  const runtime = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentRuntime.kt', import.meta.url),
    'utf8',
  );
  assert.match(runtime, /ActionSafetyPolicy\.evaluate\(buildSafetyContext\(tool, call\)\)/);
  assert.match(runtime, /ActionSafetyPolicy\.Tier\.HARD_DENY/);
  assert.match(runtime, /approvalChanged\.await\(waitMs, TimeUnit\.MILLISECONDS\)/);
  assert.match(runtime, /approval_expired/);
  assert.match(runtime, /RunDeadline\.remainingMs\(runStartedAt, now\)/);
  assert.match(runtime, /InterruptPolicy\.decision\(true, networkInFlight, toolLoopRunning\)/);
  assert.match(runtime, /override fun isStopped\(\): Boolean/);
  assert.match(runtime, /override fun stopReason\(\): String/);
});

test('PhoneBridge, PhoneTools, and AgentService enforce C2 safety invariants and cancellable waits', () => {
  const bridge = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/PhoneBridge.kt', import.meta.url),
    'utf8',
  );
  assert.match(bridge, /SENSITIVE_PACKAGES = setOf\(/);
  assert.match(bridge, /fun isCancelled\(\): Boolean/);
  assert.match(bridge, /if \(isCancelled\(\)\) return cancelledSnapshot\(\)/);

  const tools = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/PhoneTools.kt', import.meta.url),
    'utf8',
  );
  const phoneRiskMatches = tools.match(/override val risk = ToolRisk\.PHONE/g) || [];
  assert.equal(phoneRiskMatches.length, 5, `expected all 5 action tools to keep ToolRisk.PHONE, got ${phoneRiskMatches.length}`);
  assert.match(tools, /private fun sleepCancellable\(/);

  const service = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentService.kt', import.meta.url),
    'utf8',
  );
  assert.match(service, /\.stop\("fgs-system-timeout"\)/);
});

test('Approval UI surfaces (overlay + RN screens) enforce expiresAt countdown and disable on expiry', () => {
  const overlay = fs.readFileSync(
    new URL('../android/app/src/main/java/com/dshpocket/agent/AgentOverlayController.kt', import.meta.url),
    'utf8',
  );
  assert.match(overlay, /approval\.optLong\("expiresAt", 0L\)/);
  assert.match(overlay, /val allowDisabled = backgroundLost \|\| expired/);

  for (const rel of ['../src/screens/AgentButlerScreen.tsx', '../src/screens/AgentDemoScreen.tsx']) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /isApprovalExpired\(/, `${rel} should check isApprovalExpired`);
    assert.match(src, /isApprovalAllowDisabled\(/, `${rel} should check isApprovalAllowDisabled`);
    assert.match(src, /formatApprovalCountdown\(/, `${rel} should render formatApprovalCountdown`);
    assert.match(src, /审批已超时失效，本次操作不会执行。/, `${rel} should show expiry warning`);
  }
});
