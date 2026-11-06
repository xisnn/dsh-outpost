import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './support/component-harness.mjs';
const core=loadSource('core/sharedComposer.ts');
const {SharedComposerInbox,mergeSharedMessage}=core;
const id='11111111-1111-4111-8111-111111111111';
const file={kind:'file',uri:'file:///private/shared.txt',name:'shared.txt',size:4,mime:'text/plain'};
const message=(key=id,text='shared')=>({id:key,text,files:[file],textFile:{...file,name:'分享文字.txt'},receivedAt:1,skipped:[]});
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
function hooks(run,initial){
 const slots=[],effects=[];let cursor=0,dirty=false,dead=false,props=initial,result;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={createElement:(type,props,...children)=>({type,props:props??{},children}),
  useRef(value){const i=cursor++;return slots[i]??={current:value}},
  useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value},
  useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{assert.ok(!dead);slots[i].value=typeof value==='function'?value(slots[i].value):value;dirty=true}]},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()}})},
 };react.default=react;const callback=run(react);
 const render=(patch={})=>{props={...props,...patch};do{dirty=false;cursor=0;result=callback(props);while(effects.length)effects.shift()()}while(dirty);return result};
 render();return{render,unmount(){for(const slot of slots)slot?.cleanup?.();dead=true}};
}
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(nodes)];

test('merging retains existing text and attachments; overflow keeps all incoming text as TXT',()=>{
 const existing={...file,id:'existing'};
 const result=mergeSharedMessage('draft',[existing],message(),20000);
 assert.equal(result.text,'draft\n\nshared');assert.equal(result.files.length,2);assert.equal(result.files[0],existing);
 const overflow=mergeSharedMessage('x'.repeat(20000),[existing],message(),20000);
 assert.equal(overflow.text,'x'.repeat(20000));assert.equal(overflow.files.length,3);assert.equal(overflow.files.at(-1).name,'分享文字.txt');assert.equal(overflow.textAsFile,true);
 assert.throws(()=>mergeSharedMessage('full',[],{...message(),textFile:undefined},4),/TXT/);
});
test('queue deduplicates receipts, isolates Store and presentation, and permits retry after cancellation',async()=>{
 const inbox=new SharedComposerInbox(),a={},b={};
 assert.equal(inbox.enqueue(a,'main',message(),'butler'),true);assert.equal(inbox.enqueue(a,'other',message()),false);
 assert.equal(inbox.take(b,'main','butler').length,0);assert.equal(inbox.take(a,'main').length,0);
 const wait=inbox.waitApplied(a,id);assert.equal(inbox.take(a,'main','butler').length,1);inbox.cancel(a,id);assert.equal(await wait,false);
 assert.equal(inbox.enqueue(a,'main',message()),true);inbox.complete(a,id);inbox.cancel(a,id);assert.equal(await inbox.waitApplied(a,id),true);
 assert.equal(inbox.enqueue(a,'main',message()),false);assert.equal(inbox.enqueue(b,'main',message()),true);
});
test('native envelopes reject malformed/oversized data and require a complete text fallback',()=>{
 const {parseSharedMessages}=loadSource('core/shareIntake.ts',{'react-native':{Platform:{OS:'android'},NativeModules:{}}});
 assert.equal(parseSharedMessages(JSON.stringify([message()]))[0].text,'shared');
 for(const value of [[{...message(),textFile:undefined}],[{...message(),files:[{...file,uri:'content://external/file'}]}],[{...message(),files:[{...file,size:51*1024*1024}]}],Array(9).fill(message()),[{...message(),id:'../private'}]])assert.throws(()=>parseSharedMessages(JSON.stringify(value)));
});
test('real composer waits for hydration and visible destination, merges consecutive arrivals and confirms after commit',async()=>{
 const inbox=new SharedComposerInbox(),source={},applied=[];
 const h=hooks(react=>loadSource('components/useSharedComposer.ts',{react,'../core/draftStore':{MAX_DRAFT_CHARS:20000},'../core/sharedComposer':{...core,sharedComposerInbox:inbox}}).useSharedComposer,
  {source,sessionId:'main',presentation:'butler',ready:false,enabled:false,text:'existing',files:[],apply:value=>applied.push(value),onError:assert.fail});
 inbox.enqueue(source,'main',message(),'butler');assert.equal(applied.length,0);
 h.render({ready:true});assert.equal(applied.length,0);h.render({enabled:true});assert.equal(applied[0].text,'existing\n\nshared');assert.equal(await inbox.waitApplied(source,id),true);
 const next='22222222-2222-4222-8222-222222222222';h.render({text:applied.at(-1).text,files:applied.at(-1).files});
 inbox.enqueue(source,'main',message(next,'two'),'butler');inbox.enqueue(source,'main',message('33333333-3333-4333-8333-333333333333','three'),'butler');
 assert.equal(applied.at(-1).text,'existing\n\nshared\n\ntwo\n\nthree');h.render();assert.equal(await inbox.waitApplied(source,next),true);h.unmount();
});
test('unmount before a pending draft commit releases the receipt for a safe retry',async()=>{
 const inbox=new SharedComposerInbox(),source={};
 const h=hooks(react=>loadSource('components/useSharedComposer.ts',{react,'../core/draftStore':{MAX_DRAFT_CHARS:20000},'../core/sharedComposer':{...core,sharedComposerInbox:inbox}}).useSharedComposer,
 {source,sessionId:'main',presentation:'chat',ready:true,enabled:true,text:'',files:[],apply(){},onError:assert.fail});
 inbox.enqueue(source,'main',message());const wait=inbox.waitApplied(source,id);h.unmount();assert.equal(await wait,false);assert.equal(inbox.enqueue(source,'main',message()),true);
});
function host(){
 const inbox=new SharedComposerInbox(),calls=[],events=new Set();let entries=[message()],failAck=false;
 const store={fileBaseUrl:'http://local.test',connection:'connected',gatewayStatus:'online',authInvalidated:false,
  sessions:[{sessionId:'main',cwd:'/one',agentAvailable:true},{sessionId:'child',parentSessionId:'main',agentAvailable:true}],subscribe:()=>()=>{},requestOpenSession:sid=>calls.push(['open',sid]),sendPending:()=>assert.fail('must never send'),upload:()=>assert.fail('must never upload')};
 const context={store,baseUrl:'http://local.test',butlerMode:true,butlerSessionId:'main'};
 const tokens=loadSource('design/tokens.ts');
 const h=hooks(react=>()=>loadSource('components/SharedInboxHost.tsx',{
  react,'react-native':{ActivityIndicator:'Spinner',AppState:{addEventListener:()=>({remove(){}})},ScrollView:'ScrollView',Text:'Text',View:'View',StyleSheet:{create:x=>x,hairlineWidth:1}},
  '../App':{useApp:()=>context},'../design/theme':{useTheme:()=>({...tokens,colors:tokens.lightPalette})},'./MotionModal':{MotionModal:'Modal'},'./MotionPressable':{MotionPressable:'Pressable'},'./CredentialText':{CredentialText:'CredentialText'},
  '../core/picker':{formatBytes:String},'../core/sharedComposer':{...core,sharedComposerInbox:inbox},
  '../core/shareIntake':{listSharedMessages:async()=>entries,subscribeSharedMessages:fn=>{events.add(fn);return()=>events.delete(fn)},
   acknowledgeSharedMessage:async key=>{calls.push(['ack',key]);if(failAck)throw Error('disk');entries=entries.filter(item=>item.id!==key)},discardSharedMessage:async key=>{calls.push(['discard',key]);entries=[]}},
 }).SharedInboxHost(),{});
 const render=()=>nodes(h.render());
 return{h,inbox,store,context,calls,render,failAck:value=>{failAck=value},async ready(){await tick();return render()}};
}
test('real share dialog requires a target, then opens and waits for draft application without sending',async()=>{
 const f=host();let tree=await f.ready();const getAdd=()=>tree.find(n=>n.props.accessibilityLabel==='加入草稿');
 assert.equal(getAdd().props.disabled,true);assert.equal(tree.filter(n=>n.props.accessibilityRole==='radio').length,1);
 tree.find(n=>n.props.accessibilityRole==='radio').props.onPress();tree=f.render();assert.equal(getAdd().props.disabled,false);
 getAdd().props.onPress();getAdd().props.onPress();await tick();assert.equal(f.calls.filter(c=>c[0]==='open').length,1);assert.equal(f.calls.filter(c=>c[0]==='ack').length,0);
 assert.equal(f.inbox.take(f.store,'main','butler').length,1);f.inbox.complete(f.store,id);await tick();assert.equal(f.calls.filter(c=>c[0]==='ack').length,1);assert.equal(f.render().length,0);f.h.unmount();
});
test('failed acknowledgement retries the receipt without appending a second copy',async()=>{
 const f=host();let tree=await f.ready();tree.find(n=>n.props.accessibilityRole==='radio').props.onPress();tree=f.render();f.failAck(true);
 tree.find(n=>n.props.accessibilityLabel==='加入草稿').props.onPress();assert.equal(f.inbox.take(f.store,'main','butler').length,1);f.inbox.complete(f.store,id);await tick();tree=f.render();
 const discardButton=tree.find(n=>n.type==='Pressable'&&nodes(n).some(child=>child.children.includes('丢弃这次分享')));assert.equal(discardButton.props.disabled,true);discardButton.props.onPress();await tick();assert.equal(f.calls.filter(c=>c[0]==='discard').length,0);
 f.store.sessions.push({sessionId:'other',cwd:'/other',agentAvailable:true});tree=f.render();const radios=tree.filter(n=>n.props.accessibilityRole==='radio');assert.ok(radios.every(n=>n.props.disabled));radios[1].props.onPress();tree=f.render();assert.equal(tree.filter(n=>n.props.accessibilityRole==='radio')[0].props.accessibilityState.checked,true);
 f.failAck(false);tree.find(n=>n.props.accessibilityLabel==='加入草稿').props.onPress();await tick();assert.equal(f.inbox.take(f.store,'main','butler').length,0);assert.equal(f.calls.filter(c=>c[0]==='ack').length,2);assert.equal(f.calls.filter(c=>c[0]==='open').length,1);f.h.unmount();
});
test('chat sharing works while approval authorization is disabled, but rejects invalid chat login',async()=>{
 const f=host();f.store.gatewayStatus='revoked';let tree=await f.ready();tree.find(n=>n.props.accessibilityRole==='radio').props.onPress();tree=f.render();assert.equal(tree.find(n=>n.props.accessibilityLabel==='加入草稿').props.disabled,false);
 const old=tree.find(n=>n.props.accessibilityLabel==='加入草稿').props.onPress;f.store.authInvalidated=true;old();assert.equal(f.calls.length,0);f.h.unmount();
});
test('closing the share host cancels undelivered work and never acknowledges a late callback',async()=>{
 const f=host();let tree=await f.ready();tree.find(n=>n.props.accessibilityRole==='radio').props.onPress();tree=f.render();tree.find(n=>n.props.accessibilityLabel==='加入草稿').props.onPress();
 f.h.unmount();await tick();assert.equal(f.inbox.take(f.store,'main','butler').length,0);assert.equal(await f.inbox.waitApplied(f.store,id),false);assert.equal(f.calls.filter(c=>c[0]==='ack').length,0);
});
test('a stale selection and callback cannot deliver to a replacement service',async()=>{
 const f=host();let tree=await f.ready();tree.find(n=>n.props.accessibilityRole==='radio').props.onPress();tree=f.render();const stale=tree.find(n=>n.props.accessibilityLabel==='加入草稿').props.onPress;
 f.context.store={...f.store,fileBaseUrl:'http://other.test'};f.context.baseUrl='http://other.test';f.render();stale();await tick();assert.equal(f.calls.length,0);f.h.unmount();
});
