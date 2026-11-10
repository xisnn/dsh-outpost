import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalRuntimeClient,
  LocalRuntimeError,
  buildCommandEnvelope,
  decodeSnapshot,
  normalizeRuntimeCode,
} from '../src/core/localRuntime.ts';

const GENERATION = '00000000-0000-4000-8000-000000000001';

const snapshot = (over = {}) => ({
  phase: 'running', generation: GENERATION, reason: '', requiresReconciliation: false,
  observedAt: 1, ...over,
});

function fake(options = {}) {
  let phase = options.phase ?? 'running';
  const requiresReconciliation = options.requiresReconciliation ?? false;
  const calls = [];
  let active = 0, maxActive = 0;
  const bridge = {
    async snapshot() { calls.push({ kind: 'snapshot' }); return snapshot({ phase, requiresReconciliation }); },
    async events(after) { calls.push({ kind: 'events', after }); return { snapshot: snapshot({ phase, requiresReconciliation }), events: [], cursor: after, gap: false }; },
    async start(acknowledged) { calls.push({ kind: 'start', acknowledged }); phase = 'running'; return snapshot(); },
    async stop() { calls.push({ kind: 'stop' }); phase = 'stopped'; },
    async query(generation, operation, argsText) {
      calls.push({ kind: 'query', generation, operation, argsText });
      if (options.query) {
        active += 1; maxActive = Math.max(maxActive, active);
        try { return await options.query({ generation, operation, args: JSON.parse(argsText) }); }
        finally { active -= 1; }
      }
      return { ok: true, body: {} };
    },
  };
  return { bridge, calls, get phase() { return phase; }, get maxActive() { return maxActive; } };
}

test('unsupported runtime fails closed without calling a bridge', async () => {
  const client = new LocalRuntimeClient(null);
  assert.equal(client.supported, false);
  await assert.rejects(() => client.snapshot(), error => error instanceof LocalRuntimeError && error.code === 'LOCAL_RUNTIME_UNSUPPORTED');
  await assert.rejects(() => client.query('health'), error => error.code === 'LOCAL_RUNTIME_UNSUPPORTED');
});

test('start acknowledges only when the journal requires reconciliation', async () => {
  const first = fake({ phase: 'stopped', requiresReconciliation: true });
  await new LocalRuntimeClient(first.bridge).start();
  assert.deepEqual(first.calls.find(call => call.kind === 'start'), { kind: 'start', acknowledged: GENERATION });

  const second = fake({ phase: 'stopped', requiresReconciliation: false });
  await new LocalRuntimeClient(second.bridge).start();
  assert.deepEqual(second.calls.find(call => call.kind === 'start'), { kind: 'start', acknowledged: null });
});

test('queries are serialized; concurrent calls never overlap on the bridge', async () => {
  const f = fake({ query: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, body: { ok: true } }; } });
  const client = new LocalRuntimeClient(f.bridge);
  await Promise.all([client.query('health'), client.query('reconcile'), client.query('task', { id: `task-${GENERATION}` })]);
  assert.equal(f.maxActive, 1);
  assert.deepEqual(f.calls.filter(call => call.kind === 'query').map(call => call.operation), ['health', 'reconcile', 'task']);
});

test('read operations require a running generation', async () => {
  for (const phase of ['stopped', 'starting', 'interrupted', 'stop-unconfirmed']) {

    const f = fake({ phase });
    const client = new LocalRuntimeClient(f.bridge);
    await assert.rejects(
      () => client.query('reconcile'),
      error => error.code === (phase === 'starting' ? 'RUNTIME_STARTING' : 'RUNTIME_NOT_RUNNING'),
    );
    assert.equal(f.calls.some(call => call.kind === 'query'), false);
  }
});

test('business and native errors normalize to one machine code', async () => {
  const business = fake({ query: async () => ({ ok: false, code: 'STALE_RUNTIME' }) });
  await assert.rejects(
    () => new LocalRuntimeClient(business.bridge).query('reconcile'),
    error => error instanceof LocalRuntimeError && error.code === 'STALE_RUNTIME',
  );
  assert.equal(normalizeRuntimeCode(new LocalRuntimeError('BRIDGE_BUSY')), 'BRIDGE_BUSY');
  assert.equal(normalizeRuntimeCode(new Error('BRIDGE_BUSY')), 'BRIDGE_BUSY');
  assert.equal(normalizeRuntimeCode(new Error('boom: secret text')), 'LOCAL_RUNTIME_ERROR');
});

test('commands bind the current generation and preserve the caller commandId', async () => {
  const f = fake({ query: async ({ generation, operation, args }) => ({
    ok: true,
    body: { receipt: { version: 1, commandId: args.commandId, generation, operation, state: 'completed', digest: 'd', taskId: 'task-1', at: 1 } },
  }) });
  const client = new LocalRuntimeClient(f.bridge);
  const receipt = await client.command('create', { objective: 'do it' }, 'business_command-1');
  assert.equal(receipt.commandId, 'business_command-1');
  const call = f.calls.find(entry => entry.kind === 'query');
  assert.equal(call.generation, GENERATION);
  assert.equal(call.operation, 'command');
  assert.deepEqual(JSON.parse(call.argsText), buildCommandEnvelope(GENERATION, 'create', { objective: 'do it' }, 'business_command-1'));
});

test('unknown receipts cross the client unchanged for the caller to reconcile', async () => {
  const f = fake({ query: async ({ args }) => ({
    ok: true,
    body: { receipt: { version: 1, commandId: args.commandId, generation: GENERATION, operation: 'create', state: 'unknown', digest: 'd', taskId: 'task-1', at: 1 } },
  }) });
  const receipt = await new LocalRuntimeClient(f.bridge).command('create', { objective: 'x' }, 'cmd-unknown');
  assert.equal(receipt.state, 'unknown');
});

test('a malformed or mismatched receipt is rejected instead of trusted', async () => {
  const f = fake({ query: async () => ({ ok: true, body: { receipt: { commandId: 'other', state: 'completed' } } }) });
  await assert.rejects(
    () => new LocalRuntimeClient(f.bridge).command('cancel', {}, 'mine'),
    error => error.code === 'COMMAND_RECEIPT_INVALID',
  );
});

test('start is idempotent while starting and refuses to overlap stopping', async () => {
  const starting = fake({ phase: 'starting' });
  const current = await new LocalRuntimeClient(starting.bridge).start();
  assert.equal(current.phase, 'starting');
  assert.equal(starting.calls.some(call => call.kind === 'start'), false);

  const stopping = fake({ phase: 'stopping' });
  await assert.rejects(
    () => new LocalRuntimeClient(stopping.bridge).start(),
    error => error instanceof LocalRuntimeError && error.code === 'RUNTIME_STOPPING',
  );
  assert.equal(stopping.calls.some(call => call.kind === 'start'), false);
});

test('snapshot decoding rejects corrupt journals and preserves installed metadata', () => {
  assert.throws(() => decodeSnapshot({ phase: 'unknown' }), /LOCAL_RUNTIME_STATE/);
  assert.throws(() => decodeSnapshot(null), /LOCAL_RUNTIME_STATE/);
  const decoded = decodeSnapshot({ phase: 'running', generation: GENERATION, requiresReconciliation: true, installed: { installed: true, id: 'p1-verification', version: 'p2-1' } });
  assert.equal(decoded.generation, GENERATION);
  assert.equal(decoded.requiresReconciliation, true);
  assert.equal(decoded.installed.version, 'p2-1');
});
