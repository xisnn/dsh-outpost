import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {PassThrough} from 'node:stream';
import {serveDshRuntime} from '../runtime/host.mjs';

function fixture({tasks = [{id:'existing-task',status:'waiting_user',revision:1,pendingApproval:null}], fetch: fetchOverride} = {}) {
  const input=new PassThrough(), output=new PassThrough();
  const key=crypto.randomBytes(32),generation=crypto.randomUUID();
  process.env.OUTPOST_LAUNCH_ID=generation;process.env.OUTPOST_PIPE_TOKEN=key.toString('base64');
  const frames=[],calls=[];let exits=[];let disposed=0;
  output.on('data',chunk=>{for(const text of chunk.toString().trim().split('\n'))frames.push(JSON.parse(text));});
  const ctx={fiber:{async dispose(){disposed++;}},connection:{createPeer:identity=>identity,createSharedFetchHandler:prefix=>{
    assert.equal(prefix,'/api');
    return {async fetch(request,peer){
      assert.equal(peer.principal.kind,'owner');
      const call={url:request.url,method:request.method,contentType:request.headers.get('Content-Type'),body:await request.text()};
      calls.push(call);
      if(fetchOverride)return fetchOverride(call);
      return new Response(JSON.stringify(request.url.endsWith('health')?{status:'ok'}:{tasks}));
    }};
  }}};
  const host=serveDshRuntime(ctx,{input,output,exit:code=>exits.push(code)});
  let n=0;
  function request(op,{id=crypto.randomUUID(),frameGeneration=generation,signingKey=key,number=++n,args={}}={}) {
    const payload=Buffer.from(JSON.stringify({op,args})).toString('base64');
    const mac=crypto.createHmac('sha256',signingKey).update(`1\n${frameGeneration}\n${number}\nrequest\n${id}\n${payload}`).digest('base64');
    input.write(JSON.stringify({v:1,generation:frameGeneration,n:number,kind:'request',id,payload,mac})+'\n');return id;
  }
  return{input,output,key,generation,frames,calls,host,request,get exits(){return exits;},get disposed(){return disposed;}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
{
  const f=fixture();assert.equal(process.env.OUTPOST_PIPE_TOKEN,undefined);assert.equal(process.env.OUTPOST_LAUNCH_ID,undefined);
  assert.equal(f.frames[0].kind,'ready');const id=f.request('health');await settle();
  assert.equal(f.frames.at(-1).id,id);assert.deepEqual(JSON.parse(Buffer.from(f.frames.at(-1).payload,'base64')),{ok:true,body:{status:'ok'}});
  const body=f.frames.at(-1);const expected=crypto.createHmac('sha256',f.key).update(`1\n${f.generation}\n${body.n}\n${body.kind}\n${body.id}\n${body.payload}`).digest('base64');assert.equal(body.mac,expected);
  f.request('snapshot');await settle();assert.equal(JSON.parse(Buffer.from(f.frames.at(-1).payload,'base64')).body.tasks[0].id,'existing-task');
  f.host.changed();assert.equal(f.frames.at(-1).kind,'changed');f.request('shutdown');await settle();assert.deepEqual(f.exits,[0]);assert.equal(f.disposed,1);
}
for(const options of [{frameGeneration:crypto.randomUUID()},{signingKey:crypto.randomBytes(32)},{number:3}]) {
  const f=fixture();f.request('health',options);await settle();assert.deepEqual(f.exits,[1]);assert.equal(f.disposed,1);assert.equal(f.frames.length,1);
}
{
  const f=fixture();const id=f.request('health');await settle();f.request('health',{id,number:1});await settle();assert.deepEqual(f.exits,[1]);
}
{
  const f=fixture();f.request('shell');await settle();assert.deepEqual(f.exits,[1]);
}
{
  const f=fixture();f.input.write('x'.repeat(262145));await settle();assert.deepEqual(f.exits,[1]);
}
{
  const f=fixture();f.input.end();await settle();assert.deepEqual(f.exits,[1]);assert.equal(f.disposed,1);
}
{
  const tasks=Array.from({length:300},(_,i)=>({id:'task-'+String(i).padStart(4,'0'),status:'waiting_user',revision:1,objective:'中'.repeat(20000),latestAssistantMessage:'x'.repeat(20000),pendingApproval:{id:'legacy'},pendingApprovals:i===0?[{id:'one'},{id:'two'}]:[]}));
  const f=fixture({tasks});const read=()=>JSON.parse(Buffer.from(f.frames.findLast(frame=>frame.kind==='response').payload,'base64'));
  let cursor,firstCursor,ids=[];
  do {
    f.request('snapshot',{args:{limit:128,...(cursor?{cursor}:{})}});await settle();const response=read();assert.equal(response.ok,true);
    assert.equal(response.body.scope,'task-status');assert.equal(response.body.total,300);assert.ok(Buffer.byteLength(JSON.stringify(f.frames.at(-1)))<262144);
    assert.ok(response.body.tasks.every(t=>!('objective' in t)&&!('latestAssistantMessage' in t)));
    if(!ids.length)assert.equal(response.body.tasks[0].pendingApprovalCount,2);
    ids.push(...response.body.tasks.map(t=>t.id));cursor=response.body.nextCursor;if(!firstCursor)firstCursor=cursor;
  }while(cursor);
  assert.deepEqual(ids,tasks.map(t=>t.id));assert.equal(new Set(ids).size,300);
  const other=fixture({tasks});other.request('snapshot',{args:{cursor:firstCursor}});await settle();assert.equal(JSON.parse(Buffer.from(other.frames.at(-1).payload,'base64')).code,'SNAPSHOT_CHANGED');await other.host.close();
  tasks[0].revision++;f.request('snapshot',{args:{cursor:firstCursor}});await settle();assert.equal(read().code,'SNAPSHOT_CHANGED');
  for(const args of [{limit:129},{cursor:'invalid'},{unexpected:true}]){f.request('snapshot',{args});await settle();assert.equal(read().code,'QUERY_ARGUMENTS');}
  f.request('health');await settle();assert.equal(read().ok,true);await f.host.close();
}
const responseOf=f=>JSON.parse(Buffer.from(f.frames.findLast(frame=>frame.kind==='response').payload,'base64'));
const jsonResponse=(body,status=200)=>new Response(JSON.stringify(body),{status});
const envelope=(f,overrides={})=>({version:1,commandId:'business_command-1',generation:f.generation,operation:'create',args:{objective:'transport only'},...overrides});
const butlerUrl='http://127.0.0.1/api/outpost/butler/';
{
  // Each operation has one fixed URL/method. All command variants use Butler's API.
  const f=fixture({fetch:call=>jsonResponse({accepted:true,path:new URL(call.url).pathname})});
  for(const [op,path,args] of [
    ['capabilities','capabilities',{}],
    ['receipt','commands/get?commandId=Receipt_123-abc',{commandId:'Receipt_123-abc'}],
    ['reconcile','reconcile',{}],
  ]) {
    const id=f.request(op,{args});await settle();
    assert.equal(f.frames.at(-1).id,id);assert.equal(responseOf(f).ok,true);
    assert.deepEqual(f.calls.at(-1),{url:butlerUrl+path,method:'GET',contentType:null,body:''});
  }
  for(const operation of ['create','enqueue','resume','interrupt','cancel','approval']) {
    const command=envelope(f,{operation,args:{taskId:'existing-task',text:'中',nested:{url:'https://example.invalid',file:'/private/file',shell:'never execute'}}});
    f.request('command',{args:command});await settle();
    assert.equal(responseOf(f).ok,true);
    assert.deepEqual(f.calls.at(-1),{url:butlerUrl+'commands',method:'POST',contentType:'application/json',body:JSON.stringify(command)});
  }
  await f.host.close();
}
{
  // Explicit retransmission preserves the envelope, but uses a fresh wire attempt ID.
  // Host does not implement receipts/deduplication: Butler sees both attempts.
  const f=fixture({fetch:()=>jsonResponse({state:'accepted'})});
  const command=Object.freeze(envelope(f,{args:Object.freeze({objective:'same business command'})}));
  const before=JSON.stringify(command);
  const first=f.request('command',{args:command});await settle();
  assert.equal(f.frames.at(-1).id,first);
  const second=f.request('command',{args:command});await settle();
  assert.equal(f.frames.at(-1).id,second);assert.notEqual(first,second);
  assert.notEqual(first,command.commandId);assert.notEqual(second,command.commandId);
  assert.equal(JSON.stringify(command),before);assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls.map(call=>call.body),[before,before]);
  await f.host.close();
}
{
  // P3: one bounded task-detail projection. No path or wildcard is accepted,
  // and every text field/deliverable list is capped before crossing the pipe.
  const taskId = 'task-' + crypto.randomUUID();
  const oversized = {
    id: taskId, title: 'T'.repeat(600), objective: 'O'.repeat(9000), status: 'waiting_user',
    cwd: '/outpost-data/workspace', sessionId: 'session-1', goalId: 'goal-1', goalRevision: 2,
    goalPhase: 'active', maxGoalRounds: 32, autoResume: false, createdAt: 1, updatedAt: 2, revision: 3,
    lastAssistantText: 'A'.repeat(17000), lastError: 'E'.repeat(600),
    deliverables: Array.from({ length: 40 }, (_, i) => ({ path: `file-${i}.txt`, relativePath: `out/file-${i}.txt`, size: i, sha256: 'a'.repeat(64), description: 'd'.repeat(600), hidden: 'never' })),
    pendingApprovals: Array.from({ length: 12 }, (_, i) => ({ id: `approval-${i}`, toolName: 'write', askedAt: i, arguments: {secret: 'never'} })),
    queueOrder: 4, authorized: true, recoveryRequired: false, internalSecret: 'never exposed',
  };
  const f = fixture({ fetch: call => jsonResponse({ task: oversized }) });
  f.request('task', { args: { id: taskId } }); await settle();
  assert.equal(responseOf(f).ok, true);
  assert.deepEqual(f.calls.at(-1), { url: butlerUrl + 'tasks/get?id=' + encodeURIComponent(taskId), method: 'GET', contentType: null, body: '' });
  const detail = responseOf(f).body;
  assert.equal(detail.scope, 'task-detail'); assert.equal(detail.task.id, taskId);
  assert.equal(detail.task.title.length, 512); assert.equal(detail.task.objective.length, 8192);
  assert.equal(detail.task.lastAssistantText.length, 16384); assert.equal(detail.task.lastError.length, 512);
  assert.equal(detail.task.deliverables.length, 32); assert.equal(detail.task.deliverables[0].description.length, 512);
  assert.equal('hidden' in detail.task.deliverables[0], false);
  assert.equal(detail.task.pendingApprovals.length, 8); assert.equal('arguments' in detail.task.pendingApprovals[0], false);
  assert.equal('internalSecret' in detail.task, false); assert.equal(detail.task.queueOrder, 4); assert.equal(detail.task.authorized, true);
  assert.ok(Buffer.byteLength(JSON.stringify(f.frames.at(-1))) < 262144);
  await f.host.close();

  const rejects = fixture();
  for (const args of [
    {}, { id: 'existing-task' }, { id: 'task-short' }, { id: 'task-' + crypto.randomUUID(), extra: true },
    { id: 'task-' + crypto.randomUUID() + '/../health' }, { id: 7 }, null, [],
  ]) {
    rejects.request('task', { args }); await settle();
    assert.deepEqual(responseOf(rejects), { ok: false, code: 'QUERY_ARGUMENTS' });
  }
  assert.equal(rejects.calls.length, 0); await rejects.host.close();

  const invalid = fixture({ fetch: () => jsonResponse({ task: { id: 'existing-task', status: 'unknown' } }) });
  invalid.request('task', { args: { id: taskId } }); await settle();
  assert.deepEqual(responseOf(invalid), { ok: false, code: 'BUTLER_QUERY' }); await invalid.host.close();
}
{
  // P3 history includes terminal tasks that reconcile deliberately omits.
  const now = Date.now();
  const many = Array.from({ length: 70 }, (_, i) => ({
    id: 'task-' + crypto.randomUUID(), title: 'T'.repeat(300), objective: 'O'.repeat(700),
    status: i % 2 ? 'completed' : 'failed', revision: i, updatedAt: now + i, lastError: 'E'.repeat(300),
    pendingApprovals: [], queueOrder: i, authorized: true, recoveryRequired: false,
    lastAssistantText: 'never', deliverables: [{ path: 'secret.txt' }],
  }));
  const f = fixture({ fetch: () => jsonResponse({ tasks: many }) });
  f.request('tasks', { args: {} }); await settle();
  const response = responseOf(f);
  assert.equal(response.ok, true);
  assert.deepEqual(f.calls.at(-1), { url: butlerUrl + 'tasks', method: 'GET', contentType: null, body: '' });
  assert.equal(response.body.scope, 'task-history');
  assert.equal(response.body.tasks.length, 64); assert.equal(response.body.total, 70); assert.equal(response.body.truncated, true);
  assert.equal(response.body.tasks[0].updatedAt, now + 69);
  assert.equal(response.body.tasks[0].title.length, 256);
  assert.equal(response.body.tasks[0].objective.length, 512);
  assert.equal(response.body.tasks[0].lastError.length, 256);
  assert.equal('lastAssistantText' in response.body.tasks[0], false);
  assert.equal('deliverables' in response.body.tasks[0], false);
  assert.ok(Buffer.byteLength(JSON.stringify(f.frames.at(-1))) < 262144);
  await f.host.close();

  const argsReject = fixture();
  for (const args of [{ limit: 1 }, null, [], 'x']) {
    argsReject.request('tasks', { args }); await settle();
    assert.deepEqual(responseOf(argsReject), { ok: false, code: 'QUERY_ARGUMENTS' });
  }
  assert.equal(argsReject.calls.length, 0); await argsReject.host.close();

  const invalid = fixture({ fetch: () => jsonResponse({ tasks: [{ id: 'evil', status: 'completed' }] }) });
  invalid.request('tasks', { args: {} }); await settle();
  assert.deepEqual(responseOf(invalid), { ok: false, code: 'BUTLER_QUERY' }); await invalid.host.close();
}
{
  // P4 memory is a fixed, bounded, owner-authenticated channel; no generic proxy.
  const memoryId = 'mem-' + crypto.randomUUID();
  const memory = { butlerId: crypto.randomUUID(), revision: 1, entries: [
    { id: memoryId, kind: 'preference', key: 'k', value: 'v', source: 'user', createdAt: 1, updatedAt: 1, revision: 1 },
  ] };
  const f = fixture({ fetch: call => {
    const path = new URL(call.url).pathname;
    if (path.endsWith('/memory')) return jsonResponse(memory);
    if (path.endsWith('/memory/history')) return jsonResponse({ changes: [] });
    if (path.endsWith('/memory/set')) return jsonResponse({ entry: memory.entries[0], revision: 2 });
    if (path.endsWith('/memory/delete')) return jsonResponse({ deleted: memoryId, revision: 3 });
    return jsonResponse({});
  } });
  f.request('memory', { args: {} }); await settle();
  assert.deepEqual(responseOf(f), { ok: true, body: memory });
  assert.deepEqual(f.calls.at(-1), { url: butlerUrl + 'memory', method: 'GET', contentType: null, body: '' });
  f.request('memory-history', { args: {} }); await settle();
  assert.equal(f.calls.at(-1).url, butlerUrl + 'memory/history');
  f.request('memory-history', { args: { id: memoryId } }); await settle();
  assert.equal(f.calls.at(-1).url, butlerUrl + 'memory/history?id=' + encodeURIComponent(memoryId));
  const setBody = { kind: 'preference', key: 'k', value: 'v' };
  f.request('memory-set', { args: setBody }); await settle();
  assert.deepEqual(f.calls.at(-1), { url: butlerUrl + 'memory/set', method: 'POST', contentType: 'application/json', body: JSON.stringify(setBody) });
  const deleteBody = { id: memoryId, expectedRevision: 1 };
  f.request('memory-delete', { args: deleteBody }); await settle();
  assert.deepEqual(f.calls.at(-1), { url: butlerUrl + 'memory/delete', method: 'POST', contentType: 'application/json', body: JSON.stringify(deleteBody) });
  const before = f.calls.length;
  const bad = [
    ['memory', { extra: true }], ['memory', null], ['memory', []],
    ['memory-history', { id: 'mem-short' }], ['memory-history', { id: memoryId, extra: 1 }],
    ['memory-set', { kind: 'secret', key: 'k', value: 'v' }],
    ['memory-set', { kind: 'preference', key: '', value: 'v' }],
    ['memory-set', { kind: 'preference', key: 'k', value: 'v', extra: 1 }],
    ['memory-set', { kind: 'preference', key: 'k', value: 'v'.repeat(2049) }],
    ['memory-set', { kind: 'preference', key: 'k', value: 'v', id: 'mem-bad' }],
    ['memory-set', { kind: 'preference', key: 'k', value: 'v', expectedRevision: -1 }],
    ['memory-delete', { id: 'mem-bad' }], ['memory-delete', { id: memoryId, extra: 1 }],
  ];
  for (const [op, args] of bad) {
    f.request(op, { args }); await settle();
    assert.deepEqual(responseOf(f), { ok: false, code: 'QUERY_ARGUMENTS' }, op + ' ' + JSON.stringify(args));
  }
  assert.equal(f.calls.length, before);
  await f.host.close();
}
{
  // HTTP and business failures expose a machine code only, including approval denial.
  for(const [status,body,expected] of [
    [409,{ok:false,code:'COMMAND_ID_CONFLICT',message:'SECRET objective',stack:'SECRET stack',content:'SECRET content'},'COMMAND_ID_CONFLICT'],
    [200,{ok:false,code:'APPROVAL_DENIED',details:{token:'SECRET'}},'APPROVAL_DENIED'],
    [400,{code:'INVALID_COMMAND',error:'SECRET'},'INVALID_COMMAND'],
    [500,{error:'SECRET',stack:'SECRET'},'QUERY_FAILED'],
    [400,{code:'SECRET content\nstack'},'QUERY_FAILED'],
    [400,{code:'X'.repeat(129)},'QUERY_FAILED'],
  ]) {
    const f=fixture({fetch:()=>jsonResponse(body,status)});
    f.request('command',{args:envelope(f)});await settle();
    assert.deepEqual(responseOf(f),{ok:false,code:expected});
    assert.equal(f.calls.length,1);assert.equal(f.exits.length,0);
    await settle();assert.equal(f.calls.length,1); // no implicit retransmission on failure
    await f.host.close();
  }
  for(const fetch of [()=>new Response('SECRET non-JSON error',{status:500}),()=>{throw Error('SECRET exception stack');}]) {
    const f=fixture({fetch});f.request('command',{args:envelope(f)});await settle();
    assert.deepEqual(responseOf(f),{ok:false,code:'QUERY_FAILED'});assert.equal(f.calls.length,1);
    await f.host.close();
  }
  // Envelope schema belongs to Butler, not a parallel host implementation.
  const f=fixture({fetch:()=>jsonResponse({ok:false,code:'INVALID_COMMAND'},400)});
  const invalid=envelope(f,{version:999,operation:'not-a-typed-operation'});
  f.request('command',{args:invalid});await settle();
  assert.deepEqual(JSON.parse(f.calls[0].body),invalid);
  assert.deepEqual(responseOf(f),{ok:false,code:'INVALID_COMMAND'});await f.host.close();
}
{
  const f=fixture();
  for(const args of [
    {},{commandId:''},{commandId:'a'.repeat(129)},{commandId:'../health'},
    {commandId:'abc?url=https://example.invalid'},{commandId:'abc&other=value'},
    {commandId:'中'},{commandId:'abc\n'},{commandId:7},
    {commandId:'valid',url:'https://example.invalid'},null,[],
  ]) {
    f.request('receipt',{args});await settle();assert.deepEqual(responseOf(f),{ok:false,code:'QUERY_ARGUMENTS'});
  }
  for(const op of ['capabilities','reconcile'])for(const args of [{url:'https://example.invalid'},{cursor:'anything'},null,[],'']) {
    f.request(op,{args});await settle();assert.deepEqual(responseOf(f),{ok:false,code:'QUERY_ARGUMENTS'});
  }
  assert.equal(f.calls.length,0);
  f.request('receipt',{args:{commandId:'A'.repeat(128)}});await settle();
  assert.equal(responseOf(f).ok,true);assert.equal(f.calls[0].url,butlerUrl+'commands/get?commandId='+'A'.repeat(128));
  await f.host.close();
}
{
  const f=fixture();
  for(const args of [envelope(f,{generation:crypto.randomUUID()}),envelope(f,{generation:null}),envelope(f,{generation:undefined})]) {
    f.request('command',{args});await settle();assert.deepEqual(responseOf(f),{ok:false,code:'STALE_RUNTIME'});
  }
  for(const args of [null,[],false]) {
    f.request('command',{args});await settle();assert.deepEqual(responseOf(f),{ok:false,code:'QUERY_ARGUMENTS'});
  }
  assert.equal(f.calls.length,0);assert.equal(f.exits.length,0);await f.host.close();
  // Even an envelope matching the old wire generation cannot bypass wire fencing.
  const stale=fixture();stale.request('command',{frameGeneration:crypto.randomUUID(),args:envelope(stale)});await settle();
  assert.deepEqual(stale.exits,[1]);assert.equal(stale.calls.length,0);
}
{
  // The 48 KiB budget measures serialized UTF-8, not JS string length.
  const f=fixture({fetch:()=>jsonResponse({state:'accepted'})});
  const base=envelope(f,{args:{text:''}});
  const remaining=48*1024-Buffer.byteLength(JSON.stringify(base));
  for(const text of ['x'.repeat(remaining),'中'.repeat(Math.floor(remaining/3))+'x'.repeat(remaining%3)]) {
    const command={...base,args:{text}};
    assert.equal(Buffer.byteLength(JSON.stringify(command)),48*1024);
    f.request('command',{args:command});await settle();assert.equal(responseOf(f).ok,true);
    f.request('command',{args:{...command,args:{text:text+'x'}}});await settle();
    assert.deepEqual(responseOf(f),{ok:false,code:'QUERY_ARGUMENTS'});
  }
  assert.equal(f.calls.length,2);
  // JSON escaping itself counts toward the serialized budget.
  f.request('command',{args:{...base,args:{text:'\n'.repeat(25000)}}});await settle();
  assert.deepEqual(responseOf(f),{ok:false,code:'QUERY_ARGUMENTS'});assert.equal(f.calls.length,2);
  assert.ok(f.frames.every(frame=>Buffer.byteLength(JSON.stringify(frame)+'\n')<=262144));
  await f.host.close();
}
{
  // A pending command is never queued again by host transport; another attempt gets BUSY.
  let finish;
  const f=fixture({fetch:()=>new Promise(resolve=>{finish=resolve;})});
  const first=f.request('command',{args:envelope(f)});await settle();
  const second=f.request('command',{args:envelope(f)});await settle();
  assert.equal(f.frames.at(-1).id,second);assert.deepEqual(responseOf(f),{ok:false,code:'BRIDGE_BUSY'});
  assert.equal(f.calls.length,1);
  finish(jsonResponse({state:'accepted'}));await settle();
  assert.equal(f.frames.at(-1).id,first);assert.equal(responseOf(f).ok,true);
  assert.equal(f.calls.length,1);await f.host.close();
}
for(const op of ['url','fetch','file','shell','exec','approval','shutdown?url=https://example.invalid']) {
  const f=fixture();f.request(op);await settle();assert.deepEqual(f.exits,[1]);assert.equal(f.calls.length,0);
}
console.log('Local DSH host: P1 auth/replay fencing and bounded task pages; P2 fixed Butler routes, unchanged command retransmission, redacted business errors, stale generation, strict receipt args, UTF-8 limits and no implicit retries passed; real model calls=0');
