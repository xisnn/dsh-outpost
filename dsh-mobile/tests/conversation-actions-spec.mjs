import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationActionsApi, ConversationActionsProtocolError,
  parseFileReferenceCandidates, formatFileMention,
  encodeSessionReferenceUri, formatSessionMention, validateSessionMention, parseSessionReferenceCandidates,
  parseHostQueue, replyForkPoint, parseForkResponse,
} from '../src/core/conversationActions.ts';

const clone = value => JSON.parse(JSON.stringify(value));
const text = value => ({type: 'text', text: value});
const message = (id = 'host-item', content = [text('first'), text('\nsecond')], source = {kind: 'user', rpcId: 'request-not-item-id'}) => ({id, role: 'user', content, source});
const projections = (nextTurn = [message()], nextStep = []) => ({kind: 'sequenced', asOfSeq: 20, values: {inbox: {'next-turn': nextTurn, 'next-step': nextStep}}});
const reference = (sessionId = 'other', label = 'Fix ] \\ 标题', extra = {}) => ({sessionId, label, sameWorkspace: true, createdAt: 123, mention: formatSessionMention(sessionId, label), ...extra});
const event = (type, seq, data) => ({type: 'event', event: {type, seq, time: 1000 + seq, data}});
const assistant = (turn = 1, step = 1, content = [text('Finished reply')]) => ({turn, step, message: {id: `answer-${turn}-${step}`, role: 'assistant', source: {kind: 'model'}, content}});
function history() {
  return [
    event('request/header', 0, {}), event('turn/start', 1, {turn: 1}),
    event('agent/inbox/spliced', 2, {target: 'next-turn', start: 0, removedCount: 1, inserted: []}),
    event('step/start', 3, {turn: 1, step: 1}),
    event('system/message', 4, {turn: 1, step: 1, message: {role: 'system', content: [text('system')]}}),
    event('user/message', 5, message('durable-user')),
    event('assistant/message', 6, assistant()), event('step/end', 7, {turn: 1, step: 1}),
    event('turn/end', 8, {turn: 1, reason: {kind: 'completed'}}),
  ];
}
const state = (records, extra = {}) => ({hasMore: false, synchronized: true, cursor: records.at(-1).event.seq, ...extra});
function fakeRpc(handler) {
  const calls = [];
  return {calls, call: async (endpoint, args) => {calls.push({endpoint, args}); return handler(endpoint, args);}};
}

test('file candidates require exact array/kind/path and safe grammar; directory quote stays open', () => {
  assert.deepEqual(parseFileReferenceCandidates([{path: 'src/a.ts', kind: 'file', ignored: true}]), [{path: 'src/a.ts', kind: 'file'}]);
  assert.equal(formatFileMention({path: 'src/a.ts', kind: 'file'}), '@src/a.ts');
  assert.equal(formatFileMention({path: '目录/file name.ts', kind: 'file'}), '@"目录/file name.ts"');
  assert.equal(formatFileMention({path: 'my folder', kind: 'directory'}), '@"my folder/');
  assert.equal(formatFileMention({path: 'src', kind: 'directory'}), '@src/');
  assert.equal(formatFileMention({path: 'src', kind: 'directory'}, true), '@"src/');
  for (const path of ['', ' ', 'x"y', 'x\ny', 'x\ry', 'x\u0000y', 'x\u0085y']) {
    assert.throws(() => parseFileReferenceCandidates([{path, kind: 'file'}]), ConversationActionsProtocolError);
  }
  for (const value of [null, {}, {items: []}, [null], [{path: 'x'}], [{path: 'x', kind: 'symlink'}], [{path: 1, kind: 'file'}]]) assert.throws(() => parseFileReferenceCandidates(value));
});

test('canonical session URI matches independent UTF-8/base64url oracle without runtime Node dependencies', () => {
  for (const id of ['id', 'UUID-123', '会话/😀', '\ud800', '\\"id']) {
    assert.equal(encodeSessionReferenceUri(id), 'dsh-session:' + Buffer.from(JSON.stringify(id), 'utf8').toString('base64url'));
    const mention = formatSessionMention(id, 'a]b\\c');
    assert.equal(mention, `@[a\\]b\\\\c](${encodeSessionReferenceUri(id)})`);
    assert.equal(validateSessionMention(mention, id, 'a]b\\c'), mention);
  }
  for (const bad of ['', ' ', 'x\n']) assert.throws(() => encodeSessionReferenceUri(bad));
});

test('session candidate validates complete mention, encoded identity, display label and mandatory metadata', () => {
  const row = reference();
  assert.deepEqual(parseSessionReferenceCandidates([row], 'current'), [row]);
  const display = reference('child', 'log title', {displayTitle: 'Creation name', mention: formatSessionMention('child', 'Creation name'), cwd: 'E:/work'});
  assert.deepEqual(parseSessionReferenceCandidates([display]), [display]);
  const badMentions = [row.mention + ' trailing', 'prefix ' + row.mention, formatSessionMention('foreign', row.label),
    formatSessionMention('other', 'spoofed label'), row.mention.replace(')', '=)'), '@[x](https://evil.test)',
    row.mention.replace(encodeSessionReferenceUri('other'), 'dsh-session:eyJpZCI6MX0')];
  for (const mention of badMentions) assert.throws(() => parseSessionReferenceCandidates([{...row, mention}]));
  for (const patch of [{sameWorkspace: 'true'}, {createdAt: '123'}, {createdAt: -1}, {displayTitle: null}, {label: ''}, {cwd: 3}, {mention: undefined}]) assert.throws(() => parseSessionReferenceCandidates([{...row, ...patch}]));
  for (const value of [null, {}, {items: []}, [null], [row, row]]) assert.throws(() => parseSessionReferenceCandidates(value));
  assert.throws(() => parseSessionReferenceCandidates([reference('current')], 'current'));
});

test('Host queue uses durable message id, preserves all attachment/future JSON and orders steering before queued', () => {
  const file = {type: 'file', attachment: {attachmentId: 'att-file', name: 'report.pdf', bytes: 99}};
  const image = {type: 'image', attachment: {attachmentId: 'att-image', mediaType: 'image/png', width: 40}};
  const unknown = {type: 'future-audio', metadata: {reference: 'keep-me'}};
  const raw = projections([message('mixed', [text('caption'), file, image, unknown])], [message('steering')]);
  const parsed = parseHostQueue(raw, 'source');
  assert.equal(parsed.asOfSeq, 20);
  assert.deepEqual(parsed.items.map(item => [item.itemId, item.slot]), [['steering', 'next-step'], ['mixed', 'next-turn']]);
  const item = parsed.items[1];
  assert.equal(item.origin, 'host'); assert.equal(item.sessionId, 'source');
  assert.equal(item.requestId, 'request-not-item-id'); assert.equal(item.text, 'caption');
  assert.equal(item.eligible, false); assert.equal(item.ineligibleReason, 'non-text-content');
  assert.deepEqual(item.attachments, [file, image, unknown]);
  assert.deepEqual(item.message, raw.values.inbox['next-turn'][0]);
  raw.values.inbox['next-turn'][0].content[1].attachment.name = 'mutated';
  assert.equal(item.attachments[0].attachment.name, 'report.pdf');
});

test('queue eligibility requires human plain text; automatic, unknown and empty content remain ineligible', () => {
  const sourceKinds = ['runtime-context', 'tool-jobs', 'goal', 'future-source'];
  for (const sourceKind of sourceKinds) {
    const item = parseHostQueue(projections([message('auto', [text('task')], {kind: sourceKind})]), 's').items[0];
    assert.equal(item.eligible, false); assert.equal(item.ineligibleReason, 'non-human-source');
  }
  for (const content of [[], [text(' ')], [{type: 'image', data: 'bytes'}], [{type: 'text', text: 'hi', attachment: {id: 'never-drop'}}]]) assert.equal(parseHostQueue(projections([message('x', content)]), 's').items[0].eligible, false);
  const item = parseHostQueue(projections(), 's').items[0];
  assert.equal(item.eligible, true); assert.equal(item.text, 'first\nsecond');
  assert.deepEqual(parseHostQueue(projections([], []), 's').items, []);
});

test('projection absence, migration hints, unknown shapes and local PendingSend cannot masquerade as empty or Host queue', () => {
  const local = {id: 'local-send', requestId: 'request', text: 'local', status: 'queued', parts: []};
  for (const value of [null, {}, [], {values: {}}, {kind: 'cached', asOfSeq: 20, values: projections().values},
    {...projections(), kind: 'migration-required'}, {...projections(), asOfSeq: NaN},
    {...projections(), values: {inbox: {}}}, {...projections(), values: {inbox: {'next-turn': []}}},
    projections([local]), projections([message('', [text('x')])]), projections([message('x', null)]),
    projections([message('x', [text(3)])]), projections([message('x', [null])]),
    projections([message('x', [text('x')], {})]), projections([message()], [message()]),
    projections([{itemId: 'guessed', message: message()}]), projections([{...message(), role: 'tool'}])]) {
    assert.throws(() => parseHostQueue(value, 's'), ConversationActionsProtocolError);
  }
});

test('API reference and projection endpoints use verified envelopes without fabricated success fallbacks', async () => {
  const rpc = fakeRpc(endpoint => endpoint === 'fileReferences/list' ? [{path: 'file', kind: 'file'}] : endpoint === 'sessionReferenceResolver/candidates' ? [reference()] : projections());
  const api = new ConversationActionsApi(rpc);
  await api.fileReferences('source', 'foo'); await api.sessionReferences('source', 'fix'); await api.queue('source');
  assert.deepEqual(rpc.calls, [
    {endpoint: 'fileReferences/list', args: {agentId: 'source', query: 'foo'}},
    {endpoint: 'sessionReferenceResolver/candidates', args: {agentId: 'source', query: 'fix'}},
    {endpoint: 'session/projections', args: {request: {sessionId: 'source'}}},
  ]);
  await assert.rejects(() => api.fileReferences('', 'x')); await assert.rejects(() => api.sessionReferences('s', 'x\n'));
  assert.equal(rpc.calls.length, 3);
  for (const method of ['fileReferences', 'sessionReferences', 'queue']) await assert.rejects(() => new ConversationActionsApi(fakeRpc(() => undefined))[method]('s', ''));
});

test('withdraw returns preserved draft only after fresh Host eligibility and explicit accepted:true', async () => {
  const rpc = fakeRpc(endpoint => endpoint === 'session/projections' ? projections() : {accepted: true});
  const api = new ConversationActionsApi(rpc);
  const removed = await api.removeQueuedText('source', 'host-item');
  assert.equal(removed.text, 'first\nsecond'); assert.equal(removed.itemId, 'host-item');
  assert.deepEqual(rpc.calls, [
    {endpoint: 'session/projections', args: {request: {sessionId: 'source'}}},
    {endpoint: 'session/updateQueue', args: {request: {sessionId: 'source', itemId: 'host-item', action: {kind: 'remove'}}}},
  ]);
  await api.editQueuedText('source', 'host-item', ' edited\ntext ');
  assert.deepEqual(rpc.calls.at(-1).args.request.action, {kind: 'edit', content: [text(' edited\ntext ')]});
});

test('attachment/automatic/missing items never mutate; failed reads never become queue removal', async () => {
  for (const projection of [projections([], []), projections([message('host-item', [{type: 'file', attachment: {attachmentId: 'a'}}])]),
    projections([message('host-item', [text('engine')], {kind: 'tool-jobs'})]), null, {}]) {
    for (const method of ['removeQueuedText', 'editQueuedText']) {
      const rpc = fakeRpc(() => projection);
      await assert.rejects(() => new ConversationActionsApi(rpc)[method]('s', 'host-item', 'replacement'));
      assert.deepEqual(rpc.calls.map(call => call.endpoint), ['session/projections']);
    }
  }
  const rpc = fakeRpc(() => {throw new Error('offline read')});
  await assert.rejects(() => new ConversationActionsApi(rpc).removeQueuedText('s', 'host-item'), /offline read/);
  assert.equal(rpc.calls.length, 1);
});

test('mutation timeout/disconnection/business rejection/malformed receipt never succeeds or retries', async () => {
  for (const outcome of [undefined, null, {}, false, {accepted: false}, {accepted: 'true'}, {ok: true},
    new Error('timeout'), new Error('disconnected'), new Error('session/queue-item-not-found')]) {
    for (const method of ['removeQueuedText', 'editQueuedText']) {
      const rpc = fakeRpc(endpoint => {
        if (endpoint === 'session/projections') return projections();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      await assert.rejects(() => new ConversationActionsApi(rpc)[method]('s', 'host-item', 'edit'));
      assert.equal(rpc.calls.filter(call => call.endpoint === 'session/updateQueue').length, 1);
    }
  }
});

test('fork cut comes from final persisted assistant message through inclusive completed turn/end', () => {
  const records = history();
  const expected = {eligible: true, replySeq: 6, atSeq: 8, turn: 1, step: 1};
  assert.deepEqual(replyForkPoint(records, 6, state(records)), expected);
  assert.deepEqual(replyForkPoint([...records].reverse().concat(clone(records[6])), 6, state(records)), expected);
  const later = records.concat(event('turn/start', 9, {turn: 2}));
  assert.deepEqual(replyForkPoint(later, 6, state(later)), expected); // An older completed reply remains branchable.
  const completedLater = later.concat(event('step/start', 10, {turn: 2, step: 1}),
    event('assistant/message', 11, assistant(2, 1)), event('step/end', 12, {turn: 2, step: 1}),
    event('turn/end', 13, {turn: 2, reason: {kind: 'completed'}}));
  assert.deepEqual(replyForkPoint(completedLater, 6, state(completedLater)), expected);
  const unrelated = clone(records); unrelated[0].event.type = 'plugin/unrelated-setting';
  assert.deepEqual(replyForkPoint(unrelated, 6, state(unrelated)), expected);
  for (const replySeq of [undefined, -1, 6.5, 7, 99]) assert.equal(replyForkPoint(records, replySeq, state(records)).eligible, false);
});

test('fork rejects incomplete pages, stale generation, missing seqs, duplicate conflicts and live deltas', () => {
  const records = history();
  for (const metadata of [undefined, {}, state(records, {hasMore: true}), state(records, {synchronized: false}),
    state(records, {cursor: 9}), state(records, {cursor: 7})]) assert.equal(replyForkPoint(records, 6, metadata).eligible, false);
  for (const broken of [records.slice(1), records.filter(r => r.event.seq !== 4), records.slice(0, -1),
    records.concat(event('assistant/message', 6, assistant(1, 1, [text('conflict')]))),
    records.map(r => r.event.seq === 6 ? {...r, type: 'assistant-stream'} : r)]) assert.equal(replyForkPoint(broken, 6, state(records)).eligible, false);
});

test('fork rejects interrupted, failed, token-limited, unfinished and unknown turn states', () => {
  for (const kind of ['error', 'aborted', 'interrupted', 'blocked', 'max-tokens', 'forked', 'future']) {
    const records = history(); records[8].event.data.reason = {kind};
    assert.equal(replyForkPoint(records, 6, state(records)).eligible, false, kind);
  }
  for (const mutate of [
    rows => {rows[6].event.data.interrupted = true},
    rows => {rows[6].event.data.message.content = [text(' ')]},
    rows => {rows[6].event.data.message.content = [{type: 'reasoning', text: 'thinking'}]},
    rows => {rows[6].event.data.message.content = [{type: 'future-part', text: 'untrusted'}]},
    rows => {rows[6].event.data.message.content = [text('partial'), {type: 'tool-call', id: 't', name: 'tool'}]},
    rows => {rows[6].event.data.message.id = ''},
    rows => {rows[6].event.surfaceOp = {op: 'replace', startSeq: 4, endSeq: 5}},
    rows => {rows[7].event.type = 'assistant/attempt'},
    rows => {rows[7].event.type = 'future/unknown'; rows[7].event.ignorable = true},
    rows => {rows[7].event.data.step = 2},
    rows => {rows[8].event.data.turn = 2},
    rows => {rows[1].event.type = 'missing/start'},
  ]) {
    const records = history(); mutate(records);
    assert.equal(replyForkPoint(records, 6, state(records)).eligible, false);
  }
  const live = history().slice(0, -1);
  assert.equal(replyForkPoint(live, 6, state(live)).eligible, false);
});

test('later transcript events prevent branching from an earlier step; complete tool history permits its final reply', () => {
  const rows = history().slice(0, 6);
  const append = (type, data) => rows.push(event(type, rows.length, data));
  append('assistant/message', assistant(1, 1, [{type: 'tool-call', id: 't', name: 'lookup', arguments: '{}'}]));
  append('tool/call', {turn: 1, step: 1, callId: 't', name: 'lookup', arguments: '{}'});
  append('tool/result', {turn: 1, step: 1, message: {toolCallId: 't', role: 'tool', content: [text('result')]}});
  append('step/end', {turn: 1, step: 1}); append('step/start', {turn: 1, step: 2});
  append('assistant/message', assistant(1, 2)); append('step/end', {turn: 1, step: 2});
  append('turn/end', {turn: 1, reason: {kind: 'completed'}});
  assert.deepEqual(replyForkPoint(rows, 11, state(rows)), {eligible: true, replySeq: 11, atSeq: 13, turn: 1, step: 2});
  assert.equal(replyForkPoint(rows, 6, state(rows)).eligible, false);
  const broken = clone(rows); broken[8].event.data.message.toolCallId = 'wrong';
  assert.equal(replyForkPoint(broken, 11, state(broken)).eligible, false);
  for (const indices of [[7], [8], [7, 8]]) {
    const unfinished = clone(rows);
    for (const index of indices) unfinished[index].event = {...unfinished[index].event, type: 'request/header', data: {}};
    assert.equal(replyForkPoint(unfinished, 11, state(unfinished)).eligible, false, `missing tool evidence ${indices}`);
  }
  const replaced = rows.concat(event('system/message', 14, {message: {}})); replaced[14].event.surfaceOp = {op: 'replace', startSeq: 11, endSeq: 11};
  assert.equal(replyForkPoint(replaced, 11, state(replaced)).eligible, false);
});

test('fork response must carry a new nonblank identity and API never starts inference or retries', async () => {
  for (const value of [null, undefined, {}, {sessionId: ''}, {sessionId: ' '}, {sessionId: 'source'}, {sessionId: 3}, {sessionId: 'child\n'}]) assert.throws(() => parseForkResponse(value, 'source'));
  assert.deepEqual(parseForkResponse({sessionId: 'child', unused: true}, 'source'), {sessionId: 'child'});
  const rows = history();
  const rpc = fakeRpc(() => ({sessionId: 'child'}));
  assert.deepEqual(await new ConversationActionsApi(rpc).forkAfterReply('source', rows, 6, state(rows)), {sessionId: 'child'});
  assert.deepEqual(rpc.calls, [{endpoint: 'session/fork', args: {request: {sessionId: 'source', atSeq: 8}}}]);
  for (const outcome of [new Error('timeout'), new Error('disconnected'), {}, {sessionId: 'source'}]) {
    const failing = fakeRpc(() => {if (outcome instanceof Error) throw outcome; return outcome});
    await assert.rejects(() => new ConversationActionsApi(failing).forkAfterReply('source', rows, 6, state(rows)));
    assert.equal(failing.calls.length, 1);
  }
  const blocked = fakeRpc(() => ({sessionId: 'child'}));
  await assert.rejects(() => new ConversationActionsApi(blocked).forkAfterReply('source', rows, 6, state(rows, {hasMore: true})));
  assert.equal(blocked.calls.length, 0);
});
