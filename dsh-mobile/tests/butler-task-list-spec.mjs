import assert from 'node:assert/strict';
import {filterTasks,reconcileTasks,upsertTask,taskFilterCounts,taskBucket,taskPollDelay,taskListSummary} from '../src/core/butlerTaskList.ts';
const make=(id,extra={})=>({id,title:id,status:'completed',revision:1,createdAt:1,updatedAt:2,deliverables:[],pendingApproval:null,pendingApprovals:[],lastError:null,...extra});
let checks=0;
function check(name,fn){fn();checks++;console.log('PASS '+name);}
check('unchanged 5000-task refresh preserves list and every row identity',()=>{
 const old=Array.from({length:5000},(_,i)=>make('task-'+i));
 const next=reconcileTasks(old,JSON.parse(JSON.stringify(old)));
 assert.equal(next,old);assert.ok(next.every((t,i)=>t===old[i]));
});
check('one revision update replaces exactly one row',()=>{
 const old=Array.from({length:5000},(_,i)=>make('task-'+i));
 const incoming=JSON.parse(JSON.stringify(old));incoming[3400].revision=2;incoming[3400].status='running';
 const next=reconcileTasks(old,incoming);assert.notEqual(next,old);
 assert.equal(next.filter((t,i)=>t!==old[i]).length,1);assert.equal(next[3400].status,'running');
});
check('older snapshots cannot roll back a completed action',()=>{
 const updated=make('a',{revision:5,status:'cancelled'});
 const next=reconcileTasks([updated],[make('a',{revision:4,status:'running'})]);assert.equal(next[0],updated);
 assert.equal(upsertTask(next,make('a',{revision:3,status:'running'})),next);
});
check('refresh follows authoritative membership and order',()=>{
 const a=make('a'),b=make('b');const next=reconcileTasks([a,b],[{...b},make('c')]);assert.equal(next[0],b);assert.equal(next.length,2);assert.equal(next[1].id,'c');
});
check('immediate action update retains other rows and Host creation order',()=>{
 const a=make('a',{createdAt:3}),b=make('b',{createdAt:1});const next=upsertTask([a,b],{...b,revision:2});assert.equal(next[0],a);assert.equal(next[1].revision,2);
 const added=upsertTask(next,make('c',{createdAt:5}));assert.deepEqual(added.map(t=>t.id),['c','a','b']);
});
check('all status buckets and counts cover each task exactly once',()=>{
 const tasks=['created','preparing','running','waiting_user','blocked','completed','failed','cancelled'].map(s=>make(s,{status:s}));
 assert.deepEqual(taskFilterCounts(tasks),{all:8,attention:2,running:3,ended:3});
 assert.equal(filterTasks(tasks,'all'),tasks);
 assert.deepEqual(filterTasks(tasks,'ended').map(t=>t.id),['completed','failed','cancelled']);
});
check('approval takes precedence even when task is running or only plural approvals exist',()=>{
 const t=make('a',{status:'running',pendingApprovals:[{id:'approval',toolName:'write_file'}]});assert.equal(taskBucket(t),'attention');assert.match(taskListSummary(t),/write_file/);assert.equal(taskPollDelay([t]),3000);
});
check('polling remains fast for queued/preparing/running tasks regardless of selected filter',()=>{
 for(const status of ['created','preparing','running'])assert.equal(taskPollDelay([make('a',{status})]),3000);
 assert.equal(taskPollDelay([make('done'),make('active',{status:'running'})]),3000);
});
check('empty, completed and paused histories poll slowly',()=>{
 assert.equal(taskPollDelay([]),15000);
 for(const status of ['waiting_user','blocked','completed','failed','cancelled'])assert.equal(taskPollDelay([make('a',{status})]),15000);
});
check('known approval errors are readable and unknown details stay behind the detail view',()=>{
 for(const code of ['approval-rejected','approval-cancelled','approval-unavailable','approval-timeout','approval-interrupted'])assert.ok(!taskListSummary(make('a',{lastError:code})).includes(code));
 for(const code of ['internal transport error','constructor','toString','__proto__'])assert.equal(taskListSummary(make('a',{lastError:code})),'任务遇到问题，打开详情查看原因');
});
check('approval is never hidden by a previous error summary',()=>{
 const t=make('a',{lastError:'approval-rejected',pendingApproval:{toolName:'test'}});assert.equal(taskListSummary(t),'待审批：test');
});
console.log('butler-task-list-spec: '+checks+' passed');
