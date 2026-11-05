import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const slots=[],effects=[],timers=new Map(),listeners=new Map(),calls=[];
 let cursor=0,serial=0,clock=0,dead=false;
 const env={reduced:false,state:'active',keyboardHeight:0,platform:'android',dismisses:0,screen:{width:412,height:915},window:{width:412,height:915}};
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={
  useRef(value){return slots[cursor++]??={current:value};},
  useState(initial){const i=cursor++;const slot=slots[i]??={value:typeof initial==='function'?initial():initial};return [slot.value,value=>{assert.equal(dead,false,'no state updates after unmount');slot.value=typeof value==='function'?value(slot.value):value;}];},
  useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
 };
 react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps);
 const subscribe=(name,fn)=>{const set=listeners.get(name)??new Set();listeners.set(name,set);set.add(fn);return {remove(){set.delete(fn);}};};
 const native={AppState:{get currentState(){return env.state;},addEventListener:(_event,fn)=>subscribe('state',fn)},Keyboard:{metrics:()=>env.keyboardHeight?{height:env.keyboardHeight}:undefined,isVisible:()=>env.keyboardHeight>0,dismiss:()=>{env.dismisses++;},addListener:subscribe},Platform:{get OS(){return env.platform;}},Dimensions:{get:name=>env[name],addEventListener:(_event,fn)=>subscribe('dimensions',fn)}};
 function load(file){const code=ts.transpileModule(fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}}).outputText;const exports={};vm.runInNewContext(code,{exports,require(name){if(name==='react')return react;if(name==='react-native')return native;if(name==='../design/motion')return {useMotionPreference:()=>env.reduced};if(name==='../core/scrollFollow')return load('core/scrollFollow.ts');throw Error('Unexpected '+name);},setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,at:clock+ms,ms});return id;},clearTimeout(id){timers.delete(id);}});return exports;}
 return {env,calls,timers,load,render(fn,...args){cursor=0;const value=fn(...args);while(effects.length)effects.shift()();return value;},emit(name,value){if(name==='state')env.state=value;for(const listener of [...(listeners.get(name)??[])])listener(value);},advance(ms){const end=clock+ms;for(let n=0;n<100;n++){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;clock=next[1].at;timers.delete(next[0]);next[1].fn();}clock=end;},unmount(){for(const slot of slots)slot?.cleanup?.();dead=true;},listenerCount(){return [...listeners.values()].reduce((n,s)=>n+s.size,0);}};
}
const items=[{key:'a',kind:'user',text:'a'},{key:'b',kind:'assistant',blocks:[{text:'b'}]}];
function scroll(){const h=fixture(),{useChatScroll}=h.load('components/useChatScroll.ts');let data=items,key='session-a',visible=true;const render=()=>{const value=h.render(useChatScroll,data,key,visible);value.scrollRef.current={scrollToEnd:options=>h.calls.push(options)};return value;};return {...h,render,update(value){if(value.items)data=value.items;if(value.key)key=value.key;if('visible'in value)visible=value.visible;return render();}};}
const history={contentHeight:6000,offsetY:800,viewportHeight:1000};

test('reading history + keyboard, resize and new content never forces bottom',()=>{const h=scroll();let v=h.render();h.advance(100);h.calls.length=0;v.beginDrag();v.applyScrollMetrics(history);v.endDrag();h.emit('keyboardDidShow',{endCoordinates:{height:420}});v.viewportChanged();v.contentSizeChanged();h.advance(200);assert.equal(h.calls.length,0);v=h.update({items:[...items,{key:'c',kind:'user',text:'new'}]});h.advance(200);v=h.render();assert.equal(h.calls.length,0);assert.equal(v.hasNewContent,true);assert.equal(v.awayFromBottom,true);assert.equal(v.kbHeight,420);});
test('keyboard resize preserves bottom intent and latest reduced-motion preference',()=>{const h=scroll();let v=h.render();h.advance(100);h.calls.length=0;v.applyScrollMetrics(history);h.emit('keyboardDidShow',{endCoordinates:{height:400}});h.env.reduced=true;v=h.render();h.advance(150);assert.equal(h.calls.length,1);assert.equal(h.calls[0].animated,false);v.jumpToBottom();assert.equal(h.calls.at(-1).animated,false);h.env.reduced=false;v=h.render();v.jumpToBottom();assert.equal(h.calls.at(-1).animated,true);});
test('programmatic momentum does not become a user history scroll',()=>{const h=scroll();const v=h.render();h.advance(100);h.calls.length=0;v.jumpToBottom();h.calls.length=0;v.beginMomentum();v.applyScrollMetrics(history);v.endMomentum();h.emit('keyboardDidShow',{endCoordinates:{height:400}});h.advance(150);assert.equal(h.calls.length,1);});
test('user drag invalidates an already queued keyboard scroll',()=>{const h=scroll();const v=h.render();h.advance(100);h.calls.length=0;h.emit('keyboardDidShow',{endCoordinates:{height:400}});const stale=[...h.timers.values()].find(t=>t.ms===120).fn;v.beginDrag();v.applyScrollMetrics(history);v.endDrag();stale();h.advance(200);assert.equal(h.calls.length,0);});
test('hidden and background chat stop scroll callbacks; foreground retains reading intent',()=>{const h=scroll();let v=h.render();h.advance(100);v.beginDrag();v.applyScrollMetrics(history);v.endDrag();h.calls.length=0;h.update({visible:false});h.emit('keyboardDidShow',{endCoordinates:{height:300}});h.advance(200);assert.equal(h.calls.length,0);v=h.update({visible:true});h.emit('state','background');v.jumpToBottom();h.advance(200);assert.equal(h.calls.length,0);h.emit('state','active');h.advance(200);assert.equal(h.calls.length,0);});
test('session change and unmount reject old delayed callbacks and old send follow',()=>{const h=scroll();const old=h.render();h.advance(100);h.calls.length=0;h.emit('keyboardDidShow',{endCoordinates:{height:300}});const stale=[...h.timers.values()].find(t=>t.ms===120).fn;h.update({key:'session-b'});old.jumpToBottom();stale();assert.equal(h.calls.length,0);h.unmount();stale();assert.equal(h.listenerCount(),0);assert.equal(h.calls.length,0);});
test('initial empty list does not enable anchoring; first content does',()=>{const h=scroll();let v=h.update({items:[]});v.contentSizeChanged();h.advance(900);assert.equal(h.render().anchorReady,false);v=h.update({items});v.contentSizeChanged();h.advance(80);assert.equal(h.render().anchorReady,true);});
test('loading older items preserves reading intent and does not mark new content',()=>{const h=scroll();let v=h.render();h.advance(100);v.beginDrag();v.applyScrollMetrics(history);v.endDrag();h.calls.length=0;v=h.update({items:[{key:'older',kind:'user',text:'old'},...items]});v.contentSizeChanged();h.advance(200);assert.equal(h.calls.length,0);assert.equal(h.render().hasNewContent,false);v.jumpToBottom();assert.equal(h.render().awayFromBottom,false);});

test('Android display resize dismisses stale IME without changing history intent',()=>{
 const h=scroll();const v=h.render();h.advance(100);v.beginDrag();v.applyScrollMetrics(history);v.endDrag();h.calls.length=0;
 h.env.keyboardHeight=300;
 const resize=(screen,window)=>{h.env.screen=screen;h.env.window=window;h.emit('dimensions',{screen,window});};
 resize(h.env.screen,{width:412,height:615});assert.equal(h.env.dismisses,0,'normal keyboard window-height changes stay open');
 resize({width:335,height:747},{width:335,height:747});assert.equal(h.env.dismisses,1);
 h.emit('keyboardDidHide');h.advance(200);assert.equal(h.calls.length,0,'reading history stays anchored');
 h.update({visible:false});resize({width:412,height:915},{width:412,height:915});assert.equal(h.env.dismisses,1);
 h.update({visible:true});h.emit('state','background');resize({width:335,height:747},{width:335,height:747});assert.equal(h.env.dismisses,1);
 h.unmount();assert.equal(h.listenerCount(),0);
});

test('iOS display changes leave native keyboard handling in control',()=>{
 const h=scroll();h.env.platform='ios';h.env.keyboardHeight=300;h.render();
 h.emit('dimensions',{screen:{width:335,height:747},window:{width:335,height:747}});assert.equal(h.env.dismisses,0);h.unmount();
});

test('metadata polls settle before scheduling, idle 15s and busy 2s',async()=>{const h=fixture(),{useChatMetaPolling:usePoll}=h.load('components/useChatMetaPolling.ts'),requests=[];const source={refreshChatMeta:()=>new Promise(resolve=>requests.push(resolve))};h.render(usePoll,source,'a',true,true,false);assert.equal(requests.length,1);assert.equal(h.timers.size,0);requests[0]();await flush();assert.equal([...h.timers.values()][0].ms,15000);h.advance(15000);assert.equal(requests.length,2);h.render(usePoll,source,'a',true,true,true);assert.equal(requests.length,3,'new busy effect joins through Store coalescing');requests[1]();requests[2]();await flush();assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].ms,2000);h.unmount();});
test('metadata polling pauses in background, hidden tabs, covered entries and unmount',async()=>{const h=fixture(),{useChatMetaPolling:usePoll}=h.load('components/useChatMetaPolling.ts'),requests=[];const source={refreshChatMeta:()=>new Promise(resolve=>requests.push(resolve))};h.render(usePoll,source,'a',true,true,true);h.emit('state','background');requests[0]();await flush();assert.equal(h.timers.size,0);h.emit('state','active');assert.equal(requests.length,2);h.render(usePoll,source,'a',false,true,true);requests[1]();await flush();assert.equal(h.timers.size,0);h.render(usePoll,source,'a',true,false,true);assert.equal(requests.length,2);h.unmount();assert.equal(h.listenerCount(),0);});
test('late old-session metadata result cannot schedule another session poll',async()=>{const h=fixture(),{useChatMetaPolling:usePoll}=h.load('components/useChatMetaPolling.ts'),requests=[];const source={refreshChatMeta:id=>new Promise(resolve=>requests.push({id,resolve}))};h.render(usePoll,source,'a',true,true,true);h.render(usePoll,source,'b',true,true,false);requests[0].resolve();await flush();assert.equal(h.timers.size,0);requests[1].resolve();await flush();assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].ms,15000);h.unmount();});
