import test from 'node:test';
import assert from 'node:assert/strict';
import { ButlerActivityTracker, watchButlerActivity, butlerActivityText } from '../src/core/butlerActivity.ts';
import { LatestNotification } from '../src/core/latestNotification.ts';
import { listButlerTasks } from '../src/core/butlerTasks.ts';
const task = (id, status = 'running', revision = 1, cwd = 'E:/work/project') => ({
  id, status, revision, cwd, sessionId: id + '-chat', pendingApproval: null,
});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };

test('exact workspace identity, Windows case/separators, POSIX case, approvals and historical endings', () => {
  const tracker = new ButlerActivityTracker('e:\\WORK\\project\\');
  const result = tracker.update([
    task('run'), task('wait','blocked'), {...task('approval'),pendingApproval:{id:'a'}},
    task('child','running',1,'E:/work/project/child'), task('sibling','running',1,'E:/work/project2'),
    task('old','completed'),
  ]);
  assert.deepEqual(result,{running:1,waiting:2,completed:0,failed:0,cancelled:0});
  assert.equal(new ButlerActivityTracker('/Work').update([task('case','running',1,'/work')]),null);
  assert.equal(new ButlerActivityTracker('/').update([task('root','completed',1,'/')]),null);
});

test('POSIX literal backslashes stay distinct and Windows UNC spelling matches exactly', () => {
  assert.equal(new ButlerActivityTracker('/srv/a/b').update([task('wrong','running',1,'/srv/a\\b')]),null);
  assert.equal(new ButlerActivityTracker('\\\\NAS\\Share\\Project').update([task('unc','running',1,'\\\\nas\\share\\project')]).running,1);
  assert.equal(new ButlerActivityTracker('\\\\NAS\\Share\\Project').update([task('child','running',1,'\\\\nas\\share\\project\\child')]),null);
});

test('only authoritative observed transitions count; missing rows and regressed revisions never finish work', () => {
  const tracker = new ButlerActivityTracker('E:/work/project');
  tracker.update([task('a'),task('b')],0);
  assert.equal(tracker.update([],1),null);
  assert.deepEqual(tracker.update([task('a','failed',2),task('b','cancelled',2)],2),
    {running:0,waiting:0,completed:0,failed:1,cancelled:1});
  assert.equal(tracker.update([task('a','running',1)],3).running,0);
  assert.equal(tracker.update([task('a','failed',2),task('b','cancelled',2)],30003),null);
  assert.equal(tracker.update([task('a','completed',3)],30004),null);
  assert.equal(tracker.update([task('a','running',4)],30005).running,1);
  assert.equal(tracker.update([task('a','completed',5)],30006).completed,1);
});

test('malformed snapshots are rejected and never interpreted as an empty task list', async () => {
  const tracker=new ButlerActivityTracker('E:/work/project');
  for(const value of [undefined,null,{},[null],[task('a','surprise')],[{...task('a'),revision:NaN}]]) {
    assert.throws(()=>tracker.update(value),/Invalid/);
  }
  for(const response of [undefined,{}, {tasks:null}]) {
    await assert.rejects(listButlerTasks({request:async()=>response}),/Invalid/);
  }
});

test('notification text uses counts and generic state, including mixed end states', () => {
  const text=butlerActivityText({running:2,waiting:1,completed:0,failed:0,cancelled:0});
  assert.equal(text.ongoing,true);assert.match(text.title,/需要你处理/);assert.match(text.body,/2 项执行中/);
  assert.match(butlerActivityText({running:0,waiting:0,completed:1,failed:2,cancelled:1}).body,/2 项失败/);
});

test('single-flight polling ignores a late response after stop and clears its timer', async () => {
  const pending=deferred(); const values=[], timers=[];let calls=0;
  const stop=watchButlerActivity({workspace:'E:/work/project',list:()=>{calls++;return pending.promise},
    publish:v=>values.push(v), schedule:(fn,ms)=>{timers.push({fn,ms});return 1},unschedule:()=>{}});
  assert.equal(calls,1);stop();pending.resolve([task('a')]);await tick();
  assert.deepEqual(values,[null]);assert.equal(timers.length,0);
});

test('failed polls clear status without completion; future authoritative endings remain valid', async () => {
  const values=[], timers=[];let calls=0, cleared;
  const stop=watchButlerActivity({workspace:'E:/work/project',
    list:async()=>{calls++;if(calls===2)throw new Error('offline');return [task('a',calls===1?'running':'completed',calls)];},
    publish:v=>values.push(v),schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length},unschedule:id=>{cleared=id}});
  await tick();assert.equal(timers[0].ms,3000);
  timers[0].fn();await tick();assert.equal(values[1],null);assert.equal(timers[1].ms,15000);
  timers[1].fn();await tick();assert.equal(values[2].completed,1);stop();assert.equal(cleared,3);
});

test('native late display finishes before cancellation; replacement collapses intermediate scopes', async () => {
  const first=deferred(), calls=[];
  const writer=new LatestNotification(async value=>{calls.push(value);if(value==='old')await first.promise});
  writer.set('old');await tick();writer.set('unused');const done=writer.set(null);
  assert.deepEqual(calls,['old']);first.resolve();await done;
  assert.deepEqual(calls,['old',null]);
  const replacement=writer.set('new');await replacement;assert.deepEqual(calls,['old',null,'new']);
  await writer.set('new');assert.equal(calls.length,3);
});

test('failed native display can retry; changes at completion cannot get lost', async () => {
  const calls=[];let fail=true;
  const writer=new LatestNotification(async value=>{calls.push(value);if(fail){fail=false;throw new Error('permission')}});
  await writer.set('live');await writer.set('live');assert.deepEqual(calls,['live','live']);
  const pending=writer.set('other');const next=pending.then(()=>writer.set(null));await next;
  assert.deepEqual(calls,['live','live','other',null]);
});
