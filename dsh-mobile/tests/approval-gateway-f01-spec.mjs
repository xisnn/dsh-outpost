/**
 * F-01 审批安全收尾：真实 ApprovalGateway + 隔离模拟 DSH 移动网关集成验证。
 *
 * 这里不使用手搓 WebSocket 客户端，而是驱动产品真实的 ApprovalGateway，
 * 验证普通允许、高危二次确认、拒绝、断线回滚、超时与恢复，以及在途防重复提交。
 * 不执行任何真实命令，真实 LLM 调用 0 次。
 */
import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

register('./support/rn-module-hook.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);
const SHIM_DIR = path.join(__dirname, 'support');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(SHIM_DIR, '_async-storage-shim.cjs');
  }
  if (request === '@react-native-cookies/cookies') {
    return path.join(SHIM_DIR, '_cookie-manager-shim.cjs');
  }
  if (request === 'react-native-keychain') {
    return path.join(SHIM_DIR, '_keychain-shim.cjs');
  }
  return origResolve.call(this, request, parent, ...rest);
};

const cookieMod = await imp(path.join(__dirname, 'support', 'cookie-fetch.mjs'));
globalThis.fetch = cookieMod.makeCookieFetch();
const wsMod = await imp(path.join(__dirname, 'support', 'ws-compat.mjs'));
wsMod.ensureWebSocket();

const { ApprovalGateway } = await imp(path.join(__dirname, '..', 'src', 'core', 'approvalGateway.ts'));
const { ApprovalSubmitController } = await imp(path.join(__dirname, '..', 'src', 'core', 'approvalDock.ts'));
const { startFakeDsh } = await imp(path.join(__dirname, 'support', 'fake-dsh.mjs'));

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  OK    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await sleep(40);
  }
  return fn();
}

const srv = await startFakeDsh({ port: 3081, gatewayId: 'f01-isolated-gateway' });
const statuses = [];
const pending = new Map();
const resolved = new Set();
const responses = [];
const autoResolve = new Set(['ap-normal', 'ap-high', 'ap-reject']);
srv.onGatewayMessage((frame) => {
  if (frame?.type !== 'approval-response') return;
  responses.push(frame);
  if (autoResolve.has(frame.rpcId)) {
    setTimeout(() => {
      srv.pushGateway({
        kind: 'approval-resolved',
        rpcId: frame.rpcId,
        sessionId: frame.sessionId,
        approvalId: frame.approvalId,
        outcome: frame.outcome,
      });
    }, 30);
  }
});

const gw = new ApprovalGateway(srv.baseUrl, {
  onStatus: (status) => statuses.push(status),
  onApproval: (approval) => pending.set(approval.rpcId, approval),
  onResolved: (rpcId) => {
    resolved.add(rpcId);
    pending.delete(rpcId);
  },
});
const controller = new ApprovalSubmitController({ commitTimeoutMs: 500 });
const candidate = (id) => {
  const a = pending.get(id);
  if (!a) throw new Error(`审批 ${id} 不在待审批列表`);
  return {
    id: a.rpcId,
    sessionId: a.sessionId,
    approvalId: a.approvalId,
    toolName: a.toolName,
    reason: a.reason,
    displayReason: a.displayReason,
  };
};
const submit = (id, outcome = 'allowed-once') =>
  controller.submit({
    approval: candidate(id),
    outcome,
    gatewayOnline: statuses.at(-1) === 'online',
    send: (approval, decision) => {
      const original = pending.get(approval.id);
      return original ? gw.respond(original, decision) : false;
    },
  });
const reconcile = (gatewayOnline = statuses.at(-1) === 'online') =>
  controller.reconcile({
    serverPendingIds: new Set(pending.keys()),
    serverResolvedIds: resolved,
    gatewayOnline,
  });
const pushApproval = (rpcId, toolName, reason) => {
  srv.pushGateway({
    kind: 'approval-requested',
    rpcId,
    sessionId: 'f01-real-gateway',
    approvalId: `approval-${rpcId}`,
    toolName,
    reason,
    displayReason: toolName === 'pwsh' ? { command: reason } : undefined,
  });
};
const responseCount = (id) => responses.filter((r) => r.rpcId === id).length;

try {
  await gw.connect(srv.makePairingCode());
  check('真实 ApprovalGateway 已在隔离 DSH 移动网关上配对并上线', await waitFor(() => statuses.includes('online')));

  pushApproval('ap-normal', 'read', '读取 E:\\work\\dsBot\\README.md');
  check('普通审批已送达真实网关客户端', await waitFor(() => pending.has('ap-normal')));
  check('普通审批允许一次提交成功', submit('ap-normal').status === 'sent');
  check('普通审批在途重复点击被拦截', submit('ap-normal').status === 'duplicate');
  check('普通审批收到权威 resolved 后完成且只提交一次', await waitFor(() => {
    reconcile();
    return resolved.has('ap-normal') && !controller.inFlightIds.has('ap-normal');
  }) && responseCount('ap-normal') === 1);

  pushApproval('ap-high', 'pwsh', 'Remove-Item -Recurse -Force E:\\work\\dsBot\\_mock-only');
  await waitFor(() => pending.has('ap-high'));
  check('高危审批第一次点击只 armed 不发送', submit('ap-high').status === 'armed' && responseCount('ap-high') === 0);
  check('高危审批第二次点击才发送，在途重复点击被拦截', submit('ap-high').status === 'sent' && submit('ap-high').status === 'duplicate');
  check('高危审批 resolved 后完成且只提交一次', await waitFor(() => {
    reconcile();
    return resolved.has('ap-high') && !controller.inFlightIds.has('ap-high');
  }) && responseCount('ap-high') === 1);

  pushApproval('ap-reject', 'read', '读取审计日志');
  await waitFor(() => pending.has('ap-reject'));
  check('拒绝无需二次确认，一次点击提交 rejected', submit('ap-reject', 'rejected').status === 'sent');
  check('拒绝审批 resolved 后完成且只提交一次', await waitFor(() => {
    reconcile();
    return resolved.has('ap-reject') && !controller.inFlightIds.has('ap-reject');
  }) && responseCount('ap-reject') === 1 && responses.find((r) => r.rpcId === 'ap-reject')?.outcome === 'rejected');

  pushApproval('ap-drop', 'read', '断线测试审批');
  await waitFor(() => pending.has('ap-drop'));
  check('断线场景首次提交已写入真实 WebSocket', submit('ap-drop').status === 'sent' && await waitFor(() => responseCount('ap-drop') === 1));
  srv.dropConnections();
  check('真实网关断线后回滚待审批状态', await waitFor(() => statuses.at(-1) === 'offline') && reconcile(false) && !controller.inFlightIds.has('ap-drop'));
  check('断线期间重试明确失败且不产生重复提交', submit('ap-drop').status === 'failed' && responseCount('ap-drop') === 1);
  check('真实网关自动重连恢复', await waitFor(() => statuses.at(-1) === 'online', 35000));
  autoResolve.add('ap-drop');
  check('恢复后可重试且仅新增一次显式提交', submit('ap-drop').status === 'sent' && await waitFor(() => responseCount('ap-drop') === 2));
  check('断线恢复后的审批 resolved 正常完成', await waitFor(() => {
    reconcile();
    return resolved.has('ap-drop') && !controller.inFlightIds.has('ap-drop');
  }));

  pushApproval('ap-timeout', 'read', '超时测试审批');
  await waitFor(() => pending.has('ap-timeout'));
  check('超时场景首次提交已发送', submit('ap-timeout').status === 'sent' && await waitFor(() => responseCount('ap-timeout') === 1));
  await sleep(180);
  check('超时前权威 pending 仍存在时继续等待，不误判已处理', !reconcile(true) && controller.inFlightIds.has('ap-timeout'));
  await sleep(420);
  check('超过确认窗口后回滚待审批并提示超时', reconcile(true) && !controller.inFlightIds.has('ap-timeout') && /超时/.test(controller.errorFor('ap-timeout') ?? ''));
  autoResolve.add('ap-timeout');
  check('超时恢复允许显式重试且只新增一次提交', submit('ap-timeout').status === 'sent' && await waitFor(() => responseCount('ap-timeout') === 2));
  check('超时重试 resolved 后完成且没有额外线程重复提交', await waitFor(() => {
    reconcile();
    return resolved.has('ap-timeout') && !controller.inFlightIds.has('ap-timeout');
  }) && responseCount('ap-timeout') === 2);
} finally {
  gw.disconnect();
  await srv.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败（真实 ApprovalGateway，真实 LLM 调用 0 次）`);
process.exit(fail === 0 ? 0 : 1);
