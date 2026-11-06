/** Real Store + protocol API; mocked Host RPC/streams only, no Host or model calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from 'node:module';
import Module from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

register('./support/rn-module-hook.mjs', import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const originalResolve = Module._resolveFilename;
const shims = {
  '@react-native-async-storage/async-storage': '_async-storage-shim.cjs',
  '@react-native-cookies/cookies': '_cookie-manager-shim.cjs',
  'react-native-keychain': '_keychain-shim.cjs',
  'react-native': '_react-native-shim.cjs',
  'react-native-blob-util': '_blob-util-shim.cjs',
};
Module._resolveFilename = function (request, parent, ...rest) {
  return shims[request] ? path.join(testDir, 'support', shims[request]) : originalResolve.call(this, request, parent, ...rest);
};
const {Store} = await import('../src/core/store.ts');
const {RpcError} = await import('../src/core/rpc-error.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const text = value => ({type: 'text', text: value});
const message = (id = 'queued', content = [text('original\ntext')], source = {kind: 'user', rpcId: 'request-id'}) => ({id, role: 'user', source, content});
const projection = (turn = [], step = [], asOfSeq = 100) => ({kind: 'sequenced', asOfSeq, values: {inbox: {'next-turn': turn, 'next-step': step}}});
const ev = (type, data = {}) => ({type: 'event', event: {type, data, seq: 0, time: 1000}});
const splice = (target, start, inserted = [], extra = {}) => ev('agent/inbox/spliced', {target, start, inserted, ...extra});
const answer = (id = 'reply', turn = 1, step = 1) => ev('assistant/message', {turn, step, message: {id, role: 'assistant', content: [text(id)]}});
const number = records => records.map((record, seq) => ({...clone(record), event: {...clone(record.event), seq, time: 1000 + seq}}));
function history({prefix = [], inside = [], suffix = [], replies = [answer()]} = {}) {
  return number([
    ev('request/header'), ...prefix, ev('turn/start', {turn: 1}), ev('step/start', {turn: 1, step: 1}),
    ...inside, ...replies, ev('step/end', {turn: 1, step: 1}), ev('turn/end', {turn: 1, reason: {kind: 'completed'}}), ...suffix,
  ]);
}
const reply = {turn: 1, step: 1};
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, bad) => {resolve = ok; reject = bad;});
  return {promise, resolve, reject};
}
async function harness(t, {records = history(), hasMore = false, followRecords = records, handler, verify} = {}) {
  const calls = [], identities = [], follows = [];
  const conn = {
    baseUrl: 'http://mock.invalid', currentCookie: 'mock-auth',
    call: async (endpoint, args) => {
      calls.push({endpoint, args: clone(args)});
      if (handler) return handler(endpoint, args);
      if (endpoint === 'session/projections') return projection(args.request.sessionId === 'source' ? [message()] : [], [], records.at(-1)?.event.seq ?? -1);
      if (endpoint === 'session/updateQueue') return {accepted: true};
      if (endpoint === 'session/fork') return {sessionId: 'derived'};
      throw new Error(`Unexpected RPC ${endpoint}`);
    },
    close() {}, resetSocket() {},
  };
  const binding = {baseUrl: conn.baseUrl, gatewayId: 'mock-host', authContextHash: 'a'.repeat(64), identityQuality: 'confirmed'};
  const store = new Store(conn, {
    pendingSendStore: {list: async () => []},
    loadPendingBinding: async baseUrl => {identities.push(['load', baseUrl]); return binding;},
    verifyPendingBinding: async (...args) => {identities.push(['verify', ...args]); if (verify) await verify(...args);},
  });
  store.api.follow = async sessionId => {
    follows.push(sessionId);
    return {handle: {close() {}}, snapshot: {cursor: records.at(-1)?.event.seq ?? -1, records: followRecords, hasMore, projections: projection()}, next: () => new Promise(() => {})};
  };
  // Block the unrelated eager UI backfill; fork must fetch its own guarded prefix.
  const loadOlder = store.loadOlder.bind(store);
  store.loadOlder = async () => {};
  await store.openChat('source');
  store.loadOlder = loadOlder;
  t.after(() => store.close());
  return {store, conn, calls, identities, follows, binding};
}
const writes = h => h.calls.filter(call => ['session/updateQueue', 'session/fork'].includes(call.endpoint));

test('queue verifies Host identity, reads fresh projections each time, preserves attachments separately from local pending sends', async t => {
  const file = {type: 'file', attachment: {name: 'keep.pdf', attachmentId: 'att'}};
  const h = await harness(t, {handler: () => projection([message('mixed', [text('caption'), file])], [message('steer')])});
  const first = await h.store.conversationQueue('source');
  const second = await h.store.conversationQueue('source');
  assert.deepEqual(first.items.map(item => [item.itemId, item.slot, item.eligible]), [['steer', 'next-step', true], ['mixed', 'next-turn', false]]);
  assert.deepEqual(first.items[1].attachments, [file]);
  assert.notEqual(first, second);
  assert.equal(h.identities.filter(row => row[0] === 'verify').length, 2);
  assert.equal(h.calls.length, 2);
  assert.equal(writes(h).length, 0);
});

test('stale or absent projection baseline fails closed', async t => {
  for (const raw of [projection([], [], 0), {values: {inbox: {'next-turn': [], 'next-step': []}}}]) {
    const h = await harness(t, {handler: () => raw});
    await assert.rejects(h.store.conversationQueue('source'));
    await assert.rejects(h.store.withdrawQueuedText('source', 'queued'));
    assert.equal(writes(h).length, 0);
  }
});

test('identity verification failure prevents all queue and fork RPC writes', async t => {
  const h = await harness(t, {verify: async () => {throw new Error('Host instance mismatch');}});
  await assert.rejects(h.store.conversationQueue('source'), /mismatch/);
  await assert.rejects(h.store.withdrawQueuedText('source', 'queued'), /mismatch/);
  await assert.rejects(h.store.forkReply('source', reply), /mismatch/);
  assert.equal(h.calls.length, 0);
});

test('withdraw single-flight returns exact original item only after accepted and does not change drafts/chat', async t => {
  const entered = deferred(), receipt = deferred();
  const original = message('queued', [text('first'), text('\nsecond')]);
  const h = await harness(t, {handler: endpoint => {
    if (endpoint === 'session/projections') return projection([original]);
    entered.resolve(); return receipt.promise;
  }});
  const chat = h.store.getChat('source');
  const first = h.store.withdrawQueuedText('source', 'queued');
  const second = h.store.withdrawQueuedText('source', 'queued');
  assert.equal(first, second);
  await entered.promise;
  receipt.resolve({accepted: true});
  const item = await first;
  assert.equal(item.text, 'first\nsecond');
  assert.deepEqual(item.message, original);
  assert.equal(h.store.getChat('source'), chat);
  assert.deepEqual(writes(h).map(row => row.args.request), [{sessionId: 'source', itemId: 'queued', action: {kind: 'remove'}}]);
});

test('closeChat during write preserves accepted receipt; close during fresh read prevents write', async t => {
  for (const phase of ['read', 'write']) {
    const entered = deferred(), release = deferred();
    const h = await harness(t, {handler: endpoint => {
      if ((phase === 'read') === (endpoint === 'session/projections')) {entered.resolve(); return release.promise;}
      return endpoint === 'session/projections' ? projection([message()]) : {accepted: true};
    }});
    const task = h.store.withdrawQueuedText('source', 'queued');
    await entered.promise;
    h.store.closeChat('source');
    release.resolve(phase === 'read' ? projection([message()]) : {accepted: true});
    if (phase === 'read') {await assert.rejects(task, /连接已变化/); assert.equal(writes(h).length, 0);}
    else {assert.equal((await task).itemId, 'queued'); assert.equal(writes(h).length, 1);}
  }
});

test('stream generation change between fresh projection and withdrawal prevents write', async t => {
  const h = await harness(t, {handler: () => {h.store.streams.get('source').generation++; return projection([message()]);}});
  await assert.rejects(h.store.withdrawQueuedText('source', 'queued'), /连接已变化/);
  assert.equal(writes(h).length, 0);
});

test('Host/cookie identity changes invalidate even an accepted write', async t => {
  for (const change of [h => {h.conn.currentCookie = 'new-auth';}, h => {h.conn.baseUrl = 'http://other.invalid';}, h => h.store.close()]) {
    const h = await harness(t, {handler: endpoint => {
      if (endpoint === 'session/projections') return projection([message()]);
      change(h); return {accepted: true};
    }});
    await assert.rejects(h.store.withdrawQueuedText('source', 'queued'), /身份已变化/);
    assert.equal(writes(h).length, 1);
  }
});

test('failed/unknown receipt never retries or turns disappearance into successful withdrawal', async t => {
  for (const failure of [undefined, {}, {accepted: false}, new Error('timeout')]) {
    let disappeared = false;
    const h = await harness(t, {handler: endpoint => {
      if (endpoint === 'session/projections') return projection(disappeared ? [] : [message()]);
      disappeared = true;
      if (failure instanceof Error) throw failure;
      return failure;
    }});
    await assert.rejects(h.store.withdrawQueuedText('source', 'queued'));
    assert.deepEqual((await h.store.conversationQueue('source')).items, []);
    await assert.rejects(h.store.withdrawQueuedText('source', 'queued'), /no longer exists/);
    assert.equal(writes(h).length, 1);
  }
});

test('automatic, mixed attachment, and missing Host items cannot be withdrawn', async t => {
  for (const queued of [[], [message('queued', [text('auto')], {kind: 'tool-jobs'})], [message('queued', [text('caption'), {type: 'image', data: 'x'}])]]) {
    const h = await harness(t, {handler: () => projection(queued)});
    await assert.rejects(h.store.withdrawQueuedText('source', 'queued'));
    assert.equal(writes(h).length, 0);
  }
});

test('queue auth failure enters terminal auth state', async t => {
  const h = await harness(t, {handler: () => {throw new RpcError({endpoint: 'session/projections', kind: 'http', raw: 'HTTP 401', userTitle: 'auth', userHint: '', retryable: false});}});
  await assert.rejects(h.store.conversationQueue('source'));
  assert.equal(h.store.authInvalidated, true);
  assert.equal(writes(h).length, 0);
});

test('fork selects maximum persistent assistant/message seq at exact turn/step and leaves original chat intact', async t => {
  const records = history({replies: [answer('earlier'), answer('latest')]});
  const h = await harness(t, {records});
  const chat = h.store.getChat('source');
  assert.equal(h.store.canForkReply('source', reply), true);
  assert.deepEqual(await h.store.forkReply('source', reply), {sessionId: 'derived'});
  assert.equal(h.store.getChat('source'), chat);
  assert.deepEqual(h.follows, ['source']);
  assert.deepEqual(writes(h).map(row => row.args.request), [{sessionId: 'source', atSeq: records.length - 1}]);
  assert.deepEqual(h.calls.map(row => row.endpoint), ['session/fork', 'session/projections']);
  assert.equal(h.calls[1].args.request.sessionId, 'derived');
  assert.equal(h.store.canForkReply('source', {turn: 99, step: 1}), false);
  await assert.rejects(h.store.forkReply('source', {turn: 99, step: 1}), /持久回答/);
  assert.equal(writes(h).length, 1);
});

test('fork safely replays consumed and canceled splices in both slots; missing removedCount inserts zero-deletion', async t => {
  const records = history({prefix: [
    splice('next-turn', 0, [message('a'), message('b')]),
    splice('next-turn', 1, [message('c')]),
    splice('next-step', 0, [message('steer')]),
    splice('next-turn', 1, [], {removedCount: 1, outcome: 'canceled'}),
  ], inside: [
    splice('next-turn', 0, [], {removedCount: 2}),
    splice('next-step', 0, [], {removedCount: 1}),
  ]});
  const h = await harness(t, {records});
  assert.equal(h.store.canForkReply('source', reply), true);
  assert.deepEqual(await h.store.forkReply('source', reply), {sessionId: 'derived'});
});

test('pending inbox at inclusive cut blocks fork even if later history empties current queue', async t => {
  for (const target of ['next-turn', 'next-step']) {
    const records = history({prefix: [splice(target, 0, [message()])], suffix: [splice(target, 0, [], {removedCount: 1})]});
    const h = await harness(t, {records});
    assert.equal(h.store.canForkReply('source', reply), false);
    await assert.rejects(h.store.forkReply('source', reply), /切点仍有排队消息/);
    assert.equal(writes(h).length, 0);
  }
});

test('later pending work does not contaminate an earlier empty fork prefix', async t => {
  const records = history({suffix: [splice('next-turn', 0, [message()])]});
  const h = await harness(t, {records});
  assert.equal(h.store.canForkReply('source', reply), true);
  await h.store.forkReply('source', reply);
  assert.equal(writes(h)[0].args.request.atSeq, records.length - 2);
});

test('malformed, out-of-range, duplicate-id, and unknown inbox histories fail closed', async t => {
  const invalid = [
    [splice('next-turn', 1)], [splice('next-turn', -1)], [splice('next-turn', 0, [], {removedCount: 1})],
    [splice('next-turn', 0, [], {removedCount: null})], [splice('future-slot', 0)],
    [splice('next-turn', 0, [], {outcome: 'future'})],
    [splice('next-turn', 0, [message('duplicate')]), splice('next-step', 0, [message('duplicate')])],
    [splice('next-turn', 0, [{id: 'bad'}]), splice('next-turn', 0, [], {removedCount: 1})],
    [ev('agent/inbox/future')],
  ];
  for (const prefix of invalid) {
    const h = await harness(t, {records: history({prefix})});
    assert.equal(h.store.canForkReply('source', reply), false);
    await assert.rejects(h.store.forkReply('source', reply));
    assert.equal(writes(h).length, 0);
  }
});

test('fork fills older history with bounded read-only pagination without changing source records/chat', async t => {
  const records = history({prefix: [splice('next-turn', 0, [message()])], inside: [splice('next-turn', 0, [], {removedCount: 1})]});
  const h = await harness(t, {records, followRecords: records.slice(3), hasMore: true});
  const chat = h.store.getChat('source');
  const pages = [];
  h.store.api.page = async args => {pages.push(args); return {records: records.slice(0, 3), hasMore: false};};
  assert.equal(h.store.canForkReply('source', reply), false);
  assert.equal(h.store.canPrepareForkReply('source', reply), true, 'completed visible reply may request guarded history backfill');
  assert.equal(h.store.canPrepareForkReply('source', {turn: 99, step: 1}), false);
  await h.store.forkReply('source', reply);
  assert.deepEqual(pages, [{sessionId: 'source', address: undefined, throughSeq: records.length - 1, beforeSeq: 3, maxMessages: 200}]);
  assert.equal(h.store.streams.get('source').records.size, records.length - 3);
  assert.equal(h.store.getChat('source'), chat);
});

test('missing middle seq is repaired even if UI hasMore is false', async t => {
  const records = history();
  const h = await harness(t, {records, followRecords: records.filter(r => r.event.seq !== 2)});
  h.store.api.page = async args => {assert.equal(args.beforeSeq, 3); return {records: records.slice(0, 3), hasMore: false};};
  await h.store.forkReply('source', reply);
  assert.equal(writes(h).length, 1);
});

test('empty/conflicting/failed historical pages cannot fabricate a dense fork prefix', async t => {
  const records = history();
  for (const page of [async () => ({records: [], hasMore: false}), async () => {throw new Error('page timeout');}, async () => ({records: [ev('bad')], hasMore: false})]) {
    const h = await harness(t, {records, followRecords: records.slice(3), hasMore: true});
    h.store.api.page = page;
    await assert.rejects(h.store.forkReply('source', reply));
    assert.equal(writes(h).length, 0);
  }
});

test('pagination is bounded and never activates a Host agent while backfilling', async t => {
  const records = number([ev('request/header'), ...Array.from({length: 34}, () => ev('request/header')), ...history().slice(1)]);
  const h = await harness(t, {records, followRecords: records.slice(35), hasMore: true});
  let pages = 0;
  h.store.api.page = async args => {pages++; return {records: [records[args.beforeSeq - 1]], hasMore: true};};
  await assert.rejects(h.store.forkReply('source', reply), /历史过长/);
  assert.equal(pages, 32);
  assert.equal(writes(h).length, 0);
  assert.deepEqual(h.follows, ['source']);
});

test('stream changes during fork backfill prevent fork write', async t => {
  const records = history();
  const h = await harness(t, {records, followRecords: records.slice(3), hasMore: true});
  h.store.api.page = async () => {h.store.streams.get('source').generation++; return {records: records.slice(0, 3), hasMore: false};};
  await assert.rejects(h.store.forkReply('source', reply), /连接已变化/);
  assert.equal(writes(h).length, 0);
});

test('incomplete, interrupted, replaced or non-final durable replies cannot fork', async t => {
  const incomplete = history().slice(0, -1);
  const interrupted = history(); interrupted.find(r => r.event.type === 'assistant/message').event.data.interrupted = true;
  const replacement = history(); replacement.at(-1).event.surfaceOp = 'replace';
  const notFinal = number([...history(), ev('turn/start', {turn: 2}), ev('step/start', {turn: 2, step: 1}), answer('other', 2, 1)]);
  for (const records of [incomplete, interrupted, replacement]) {
    const h = await harness(t, {records});
    assert.equal(h.store.canForkReply('source', reply), false);
    await assert.rejects(h.store.forkReply('source', reply));
    assert.equal(writes(h).length, 0);
  }
  const h = await harness(t, {records: notFinal});
  await assert.rejects(h.store.forkReply('source', {turn: 2, step: 1}));
  assert.equal(writes(h).length, 0);
});

test('nonempty/unverifiable derived queue exposes fork identity and never opens, clears or prompts it', async t => {
  for (const result of [projection([message()]), projection([], [message()]), projection([], [], 0), {}, new Error('projection timeout')]) {
    const h = await harness(t, {handler: endpoint => {
      if (endpoint === 'session/fork') return {sessionId: 'derived'};
      if (result instanceof Error) throw result;
      return result;
    }});
    await assert.rejects(h.store.forkReply('source', reply), error => {
      assert.equal(error.forkSessionId, 'derived'); assert.equal(error.forkQueueUnsafe, true);
      assert.match(error.message, /未自动打开，请勿重复创建/); return true;
    });
    assert.deepEqual(h.follows, ['source']);
    assert.deepEqual(h.calls.map(row => row.endpoint), ['session/fork', 'session/projections']);
  }
});

test('fork timeout is not retried; overlapping forks share one write', async t => {
  const entered = deferred(), release = deferred();
  const h = await harness(t, {handler: () => {entered.resolve(); return release.promise;}});
  const first = h.store.forkReply('source', reply);
  assert.equal(h.store.forkReply('source', reply), first);
  await entered.promise;
  release.reject(new Error('fork timeout'));
  await assert.rejects(first, /fork timeout/);
  assert.equal(writes(h).length, 1);
});

test('closing original page after fork receipt still checks derived projections without opening', async t => {
  const h = await harness(t, {handler: endpoint => {
    if (endpoint === 'session/fork') {h.store.closeChat('source'); return {sessionId: 'derived'};}
    return projection();
  }});
  assert.deepEqual(await h.store.forkReply('source', reply), {sessionId: 'derived'});
  assert.deepEqual(h.follows, ['source']);
});

test('known subagent and Host-managed identities cannot fork, including late ownership discovery', async t => {
  const child = await harness(t);
  child.store.sessions = [{sessionId: 'source', origin: 'subagent'}];
  assert.equal(child.store.canForkReply('source', reply), false);
  await assert.rejects(child.store.forkReply('source', reply));
  await assert.rejects(child.store.conversationQueue('source'));
  assert.equal(child.calls.length, 0);

  const managed = await harness(t);
  managed.store.butlerOwnership.remember({sessionId: 'source'});
  assert.equal(managed.store.canForkReply('source', reply), false);
  await assert.rejects(managed.store.forkReply('source', reply), /管家/);
  assert.equal(managed.calls.length, 0);

  const discovered = deferred(), resume = deferred();
  const late = await harness(t, {verify: async () => {discovered.resolve(); await resume.promise;}});
  const task = late.store.forkReply('source', reply);
  await discovered.promise;
  late.store.butlerOwnership.remember({sessionId: 'source'});
  resume.resolve();
  await assert.rejects(task, /管家/);
  assert.equal(writes(late).length, 0);
});

test('phone Butler markers in loaded or newly paged durable history prevent fork', async t => {
  const {buildButlerPrime} = await import('../src/core/butler.ts');
  const records = history({prefix: [ev('user/message', message('butler-prime', [text(buildButlerPrime())]))]});
  for (const paged of [false, true]) {
    const h = await harness(t, {records, followRecords: paged ? records.slice(2) : records, hasMore: paged});
    h.store.api.page = async () => ({records: records.slice(0, 2), hasMore: false});
    assert.equal(h.store.canForkReply('source', reply), false);
    await assert.rejects(h.store.forkReply('source', reply), /管家/);
    assert.equal(writes(h).length, 0);
  }
});

test('close/reconnect while verifying Host identity prevents subsequent projections', async t => {
  const entered = deferred(), release = deferred();
  const h = await harness(t, {verify: async () => {entered.resolve(); await release.promise;}});
  const task = h.store.conversationQueue('source');
  await entered.promise;
  h.store.streams.get('source').generation++;
  release.resolve();
  await assert.rejects(task, /连接已变化/);
  assert.equal(h.calls.length, 0);
});

test('conflicting overlapping page records cannot overwrite durable history during fork', async t => {
  const records = history();
  const h = await harness(t, {records, followRecords: records.filter(r => r.event.seq !== 2)});
  const changed = clone(records[0]); changed.event.data = {changed: true};
  h.store.api.page = async () => ({records: [changed, ...records.slice(1, 3)], hasMore: false});
  await assert.rejects(h.store.forkReply('source', reply), /seq 冲突/);
  assert.equal(writes(h).length, 0);
});

test('fork includes newly arrived durable events and rejects later surface replacement', async t => {
  const records = history();
  const h = await harness(t, {records, followRecords: records.slice(3), hasMore: true});
  h.store.api.page = async () => {
    const later = {...ev('request/header'), event: {...ev('request/header').event, seq: records.length, surfaceOp: 'replace'}};
    h.store.streams.get('source').records.set(later.event.seq, later);
    h.store.streams.get('source').cursor = later.event.seq;
    return {records: records.slice(0, 3), hasMore: false};
  };
  await assert.rejects(h.store.forkReply('source', reply), /替换/);
  assert.equal(writes(h).length, 0);
});

test('reference wrapper retains protocol behavior and marks directory choices', async t => {
  const h = await harness(t, {handler: () => [{path: 'src/core/', kind: 'directory'}, {path: 'src/core/store.ts', kind: 'file'}]});
  const rows = await h.store.conversationReferences('source', 'file', 'src');
  assert.deepEqual(rows.map(row => [row.label, row.directory]), [['core', true], ['store.ts', false]]);
});
