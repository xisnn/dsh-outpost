import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, loadSource } from './support/component-harness.mjs';
const core=loadSource('core/approvalDock.ts');
const ownership=loadSource('core/butlerApprovalScope.ts');
const main={id:'main-rpc',sessionId:'main',approvalId:'main-approval',toolName:'read',reason:'读取项目说明'};
const child={id:'child-rpc',sessionId:'task-session',approvalId:'child-approval',toolName:'fetch',displayReason:{url:'https://docs.example.test/guide'}};
const other={id:'other-rpc',sessionId:'elsewhere',toolName:'read'};
const task=(sessionId,cwd='/project')=>({id:'task-'+sessionId,sessionId,cwd});
function setup(patch={}){
 const controller=new core.ApprovalSubmitController(),sent=[];
 const h=componentHarness('components/ApprovalBanner.tsx','ApprovalBanner',{
  sessionId:'main',inline:true,approvals:[child,other],relatedSessionIds:new Set(['task-session']),gatewayOnline:true,
  onAnswer:(item,outcome)=>{sent.push([item,outcome]);return true;},...patch,
 },{'../core/approvalDock':{...core,ApprovalSubmitController:class{constructor(){return controller;}}}});
 return {h,controller,sent};
}
function click(h,label){assert.ok(h.button(label),label);h.button(label).props.onPress();h.render();}

test('Host mapping accepts only the exact project; Windows spelling normalizes without prefix matching',()=>{
 assert.deepEqual([...ownership.butlerTaskApprovalSessions([task('own'),task('prefix','/project-copy'),task('other','/other'),task(null)],'/project/')],['own']);
 assert.deepEqual([...ownership.butlerTaskApprovalSessions([task('win','e:\\Project\\'),task('wrong','e:\\Project2')],'E:/project')],['win']);
 assert.equal(ownership.butlerTaskApprovalSessions([task('x')],'').size,0);
 assert.equal(ownership.butlerTaskApprovalSessions([task('x','/Project')],'/project').size,0,'POSIX paths remain case-sensitive');
});

test('main butler explicitly accepts owned task sessions, keeps actual source IDs and excludes all others',()=>{
 const scoped=core.partitionApprovalsBySession([main,child,other,{id:'unknown',toolName:'read'}],'main',{relatedSessionIds:new Set(['task-session'])});
 assert.deepEqual(Array.from(scoped.current,a=>a.id),['main-rpc','child-rpc']);
 assert.equal(scoped.current[1].sessionId,'task-session');
 assert.deepEqual(Array.from(scoped.other,a=>a.id),['other-rpc']);assert.equal(scoped.unknown.length,1);
 assert.equal(core.partitionApprovalsBySession([child],'main').current.length,0,'ordinary chats cannot aggregate task requests');
 assert.equal(core.partitionApprovalsBySession([child],'',{relatedSessionIds:new Set(['task-session'])}).current.length,0);
});

test('inline card submits the original task request, disappears, and never navigates to an approval page',()=>{
 const {h,sent}=setup({onOpenSession:()=>assert.fail('no navigation')});
 assert.ok(h.find(n=>n.props.testID==='chat-approval-card'));assert.match(h.text(),/docs.example.test/);
 assert.equal(h.button('下一条待审批'),undefined,'unrelated request never enters queue');
 assert.ok(!h.nodes().some(n=>String(n.props.accessibilityLabel).includes('其他会话待审批')));
 click(h,'允许一次');assert.equal(sent.length,1);assert.equal(sent[0][0],child);assert.equal(sent[0][0].sessionId,'task-session');
 assert.equal(h.find(n=>n.props.testID==='chat-approval-card'),undefined);
 h.render({approvals:[other],serverResolvedIds:new Set(['child-rpc'])});assert.equal(h.nodes().length,0);
});

test('reject also disappears; failed sending stays inline with an actionable error',()=>{
 const rejected=setup();click(rejected.h,'拒绝');assert.equal(rejected.sent[0][1],'rejected');assert.equal(rejected.h.nodes().length,0);
 const failed=setup({onAnswer:()=>false});click(failed.h,'允许一次');assert.match(failed.h.text(),/未能送达电脑/);assert.ok(failed.h.button('允许一次'));assert.ok(failed.h.find(n=>n.props.testID==='chat-approval-card'));
});

test('a submitted task card returns inline as locked when confirmation is lost, then disappears on authority',()=>{
 const {h,controller}=setup();click(h,'允许一次');assert.equal(h.nodes().length,0);
 controller.reconcile({serverPendingIds:new Set([child.id]),gatewayOnline:false});h.render({gatewayOnline:false});
 assert.match(h.text(),/结果未知/);assert.equal(h.button('允许一次'),undefined);assert.equal(h.button('拒绝'),undefined);
 controller.reconcile({serverPendingIds:new Set(),gatewayOnline:true,serverResolvedIds:new Set([child.id])});
 h.render({approvals:[],serverResolvedIds:new Set([child.id]),gatewayOnline:true});assert.equal(h.nodes().length,0);
});

test('event approvalId and gateway rpcId remain one card, hidden after submission and late resolution',()=>{
 const {h,controller}=setup({approvals:[main],readonlyApprovals:[{id:'main-approval',toolName:'read'}]});
 assert.equal(h.button('下一条待审批'),undefined);click(h,'允许一次');assert.equal(h.nodes().length,0);
 controller.reconcile({serverPendingIds:new Set(),gatewayOnline:true,serverResolvedIds:new Set([main.id])});
 h.render({approvals:[],serverResolvedIds:new Set([main.id])});assert.equal(h.nodes().length,0,'stale history must not bring the card back');
});

test('unknown sources remain read-only and high risk still needs its second explicit confirmation',()=>{
 const unknown=setup({approvals:[{...main,sessionId:undefined}]});assert.equal(unknown.h.button('允许一次'),undefined);assert.match(unknown.h.text(),/来源不明/);
 const high=setup({approvals:[{...child,toolName:'bash',reason:'rm -rf /local/fixture-only'}]});
 click(high.h,'允许一次');assert.equal(high.sent.length,0);assert.ok(high.h.button('再次点击确认允许'));
 click(high.h,'再次点击确认允许');assert.equal(high.sent.length,1);assert.equal(high.h.nodes().length,0);
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function hookHarness(initial){
 const slots=[],effects=[];let cursor=0,dirty=false,dead=false,props=initial,result;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},useState(initial){const i=cursor++;slots[i]??={value:initial};return [slots[i].value,value=>{assert.ok(!dead,'no updates after unmount');slots[i].value=typeof value==='function'?value(slots[i].value):value;dirty=true;}];},useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
 const {useButlerApprovalSessions}=loadSource('components/useButlerApprovalSessions.ts',{react,'../core/butlerApprovalScope':ownership});
 const render=(patch={})=>{props={...props,...patch};do{dirty=false;cursor=0;result=useButlerApprovalSessions(props.source,props.sessionId,props.workspace,props.enabled,props.requests);while(effects.length)effects.shift()();}while(dirty);return result;};
 render();return {render,unmount(){for(const slot of slots)slot?.cleanup?.();dead=true;}};
}
const request=[{rpcId:'r',sessionId:'task-session'}];
test('late Host ownership cannot cross project, session or connection boundaries',async()=>{
 let finish;const source={listButlerTasks:()=>new Promise(resolve=>finish=resolve)};
 const h=hookHarness({source,sessionId:'main',workspace:'/project',enabled:true,requests:request});const old=finish;
 h.render({workspace:'/other'});old([task('old')]);await flush();assert.equal(h.render().size,0);
 finish([task('new','/other')]);await flush();assert.ok(h.render().has('new'));
 assert.equal(h.render({sessionId:'other-main',requests:[]}).size,0);
 assert.equal(h.render({source:{listButlerTasks:async()=>[]}}).size,0);h.unmount();
});

test('disabled or own-session-only scopes do not query Host, and failures never aggregate arbitrary sessions',async()=>{
 let calls=0;const source={listButlerTasks:async()=>{calls++;throw Error('offline');}};
 const h=hookHarness({source,sessionId:'main',workspace:'/project',enabled:false,requests:request});assert.equal(calls,0);
 h.render({enabled:true,requests:[{rpcId:'own',sessionId:'main'}]});assert.equal(calls,0);
 h.render({requests:request});await flush();assert.equal(calls,1);assert.equal(h.render().size,0);h.unmount();
});

test('unmounted and disabled scopes reject late Host task responses',async()=>{
 let finish;const source={listButlerTasks:()=>new Promise(resolve=>finish=resolve)};
 const h=hookHarness({source,sessionId:'main',workspace:'/project',enabled:true,requests:request});h.unmount();finish([task('late')]);await flush();
 const hidden=hookHarness({source,sessionId:'main',workspace:'/project',enabled:true,requests:request});hidden.render({enabled:false});finish([task('late')]);await flush();assert.equal(hidden.render().size,0);hidden.unmount();
});
