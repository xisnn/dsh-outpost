import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {componentHarness, loadSource} from './support/component-harness.mjs';
import {hookHarness} from './support/hook-harness.mjs';
const tokens=loadSource('design/tokens.ts');
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function rowHarness(){
 const calls=[],blocks=[];const react={memo:fn=>fn,createElement:(type,props,...children)=>({type,props,children})};react.default=react;
 const exports={};const code=ts.transpileModule(fs.readFileSync(new URL('../src/screens/ChatScreen.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2021}}).outputText;
 vm.runInNewContext(code+'\nexports.testRow = ChatItemRow;', {exports,require:name=>{
  if(name==='react')return react;
  if(name==='react-native')return{View:'View',Text:'Text',StyleSheet:{create:x=>x}};
  if(name==='../core/copyText')return {buildAssistantCopyText:parts=>parts.filter(b=>b.kind==='text').map(b=>b.text).join('\n\n')};
  if(name==='../components/Message')return{UserBubble:'UserBubble'};
  return new Proxy({}, {get:(_t,key)=>String(key)});
 }});
 const render=patch=>exports.testRow({item:{kind:'assistant',turn:4,step:2,key:'key',blocks:[{kind:'text',text:'正文'}]},turnRunning:false,doneTaskCount:0,sessionId:'s',openMessageActions:(...args)=>calls.push(args),renderBlocks:(parts,_key,opts)=>{blocks.push(opts);return null;},...patch});
 return {render,calls,blocks,returnToForkSource:exports.returnToForkSource};
}
test('long-press carries assistant turn/step, including grouped final step rather than first tool step',()=>{
 const h=rowHarness();h.render();h.blocks.at(-1).onLongPressText();assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))),['正文',{turn:4,step:2}]);
 h.render({group:{finalBlocks:[{kind:'text',text:'最终回答'}],finalStep:8}});h.blocks.at(-1).onLongPressText();assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))),['最终回答',{turn:4,step:8}]);
 const user=h.render({item:{kind:'user',text:'用户文字',turn:4,key:'u'}});user.props.onLongPress('用户文字');assert.deepEqual(h.calls.at(-1),['用户文字']);
});
test('returning to source reuses the phone entry; wide replacement restores its original detail',()=>{
 const {returnToForkSource}=rowHarness(),calls=[];
 const source={sessionId:'source',title:'原会话'};
 returnToForkSource({stack:[{name:'Sessions'},{name:'Chat',params:{sessionId:'source'}},{name:'Chat',params:{sessionId:'fork'}}],pop:()=>calls.push('pop'),push:(...args)=>calls.push(args)},source);
 assert.deepEqual(calls,['pop']);
 calls.length=0;
 returnToForkSource({stack:[{name:'Sessions'},{name:'Chat',params:{sessionId:'fork'}}],pop:()=>calls.push('pop'),push:(...args)=>calls.push(args)},source);
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['Chat',{sessionId:'source',title:'原会话'}]]);
});
test('message sheet adds fork only when supplied and action itself does not copy or export',()=>{
 let forks=0,copies=0;
 const h=componentHarness('components/MessageActionSheet.tsx','MessageActionSheet',{visible:true,text:'正文',onClose:()=>{}},{
  './MotionModal':{MotionModal:'Modal'},'./clipboard':{copyTextToClipboard:()=>{copies++;return true;}},'./LocalExportPanel':{LocalExportPanel:'LocalExportPanel'},
 });
 assert.equal(h.button('从此回答分叉继续'),undefined);
 h.render({onFork:()=>forks++});h.button('从此回答分叉继续').props.onPress();assert.equal(forks,1);assert.equal(copies,0);
});
function queueHarness(withdraw){
 const restored=[],receipts=[],listeners=new Set(),scope={},item={sessionId:'s',itemId:'host-id',text:'排队文字',eligible:true,slot:'next-turn',message:{id:'host-id'}};
 let rows=[];
 const recovery={hydrate:async()=>{},list:()=>rows,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},prepare:async()=>{rows=[{...item,state:'unconfirmed',scope:'host',restored:false}];for(const f of listeners)f();return{};},confirm:async(_ticket,removed)=>{receipts.push(removed);rows=[{...removed,state:'confirmed',scope:'host',restored:false}];for(const f of listeners)f();return rows[0];}};
 const source={conversationQueue:async()=>({items:[item],asOfSeq:3}),withdrawQueuedText:withdraw};
 const h=hookHarness(react=>loadSource('components/HostQueuePanel.tsx',{
  react,'react-native':{View:'View',Text:'Text',ScrollView:'ScrollView',StyleSheet:{create:x=>x,hairlineWidth:1},AppState:{currentState:'active',addEventListener:()=>({remove(){}})}},
  './MotionPressable':{MotionPressable:'Pressable'},'./ConfirmSheet':{ConfirmSheet:'ConfirmSheet'},'../design/theme':{useTheme:()=>({...tokens,colors:tokens.lightPalette})},
  '../core/credentialDisplay':{maskCredentials:x=>x},'../core/withdrawalRecovery':{withdrawalRecovery:recovery},
 }).HostQueuePanel,{source,sessionId:'s',scope,recoveryScope:'host',enabled:true,busy:false,onRestore:c=>restored.push(c)});
 const nodes=n=>!n||typeof n!=='object'?[]:[n,...n.children.flat(Infinity).flatMap(nodes)];
 return {...h,restored,receipts,button:label=>nodes(h.render()).find(n=>n.props.accessibilityLabel===label),confirm:()=>nodes(h.render()).find(n=>n.type==='ConfirmSheet'&&n.props.visible)};
}
test('queue removal requires explicit confirmation and restores only after accepted success',async()=>{
 const d=deferred();let writes=0;const h=queueHarness(()=>{writes++;return d.promise;});await tick();
 h.button('撤回编辑：排队文字').props.onPress();assert.equal(writes,0);const task=h.confirm().props.onConfirm();await tick();assert.equal(writes,1);assert.equal(h.restored.length,0);
 d.resolve({sessionId:'s',itemId:'host-id',text:'排队文字'});await task;await tick();assert.equal(h.restored.length,1);h.unmount();
});
test('unknown withdrawal never recovers text; accepted receipt survives unmount without editing another screen',async()=>{
 const failed=queueHarness(async()=>{throw Error('timeout');});await tick();failed.button('撤回编辑：排队文字').props.onPress();failed.confirm().props.onConfirm();await tick();assert.equal(failed.restored.length,0);assert.equal(failed.receipts.length,0);failed.unmount();
 const d=deferred(),h=queueHarness(()=>d.promise);await tick();h.button('撤回编辑：排队文字').props.onPress();h.confirm().props.onConfirm();await tick();h.unmount();d.resolve({sessionId:'s',itemId:'host-id',text:'排队文字'});await tick();assert.equal(h.receipts.length,1);assert.equal(h.restored.length,0);
});
