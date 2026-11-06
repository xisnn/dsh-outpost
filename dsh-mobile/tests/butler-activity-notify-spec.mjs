import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './support/component-harness.mjs';
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
const activity={running:1,waiting:0,completed:0,failed:0,cancelled:0};
function fixture() {
 const calls=[], opened=[];let listener, background, initial=null, slow, permission=1;
 const nf={requestPermission:async()=>{calls.push(['permission']);return {authorizationStatus:permission}},getNotificationSettings:async()=>({authorizationStatus:permission}),
  onBackgroundEvent:fn=>{background=fn},createChannel:async c=>calls.push(['channel',c]),
  cancelNotification:async id=>calls.push(['cancel',id]),
  displayNotification:async n=>{calls.push(['display',n]);if(slow)await slow;return n.id},
  getInitialNotification:async()=>initial,onForegroundEvent:fn=>{listener=fn;return()=>{listener=null}}};
 const exports=loadSource('core/notify.ts',{
  'react-native':{AppState:{currentState:'active'},Platform:{OS:'android'},Vibration:{vibrate(){}}},
  'react-native-notify-kit':{default:nf},
 });
 return {api:exports,calls,opened, async init(){const ready=await exports.initNotifications();this.off=await exports.onNotificationOpen(sid=>opened.push(sid));return ready},
  press:data=>listener({type:1,detail:{notification:{data}}}),backgroundPress:data=>background({type:1,detail:{notification:{data}}}),
  setPermission:value=>{permission=value},setInitial:data=>{initial={notification:{data}}},
  delayDisplay:promise=>{slow=promise},latest:()=>calls.filter(c=>c[0]==='display').at(-1)?.[1]};
}

function hooks(run, initial) {
 const slots=[],effects=[];let cursor=0,dirty=false,dead=false,props=initial,result;
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={
  createElement:(type,props,...children)=>({type,props:props??{},children}),
  useRef(value){const i=cursor++;return slots[i]??={current:value}},
  useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value},
  useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{assert.ok(!dead);slots[i].value=typeof value==='function'?value(slots[i].value):value;dirty=true}]},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()}})},
 };react.default=react;
 const callback=run(react);
 const render=(patch={})=>{props={...props,...patch};do{dirty=false;cursor=0;result=callback(props);while(effects.length)effects.shift()()}while(dirty);return result};
 render();return{render,unmount(){for(const slot of slots)slot?.cleanup?.();dead=true}};
}

test('real observer invalidates its scope for service/project/revocation/offline/disabled transitions',()=>{
 let notify=true,listener;const owners=[],polls=[];
 const store={fileBaseUrl:'http://local.test',connection:'connected',gatewayStatus:'online',authInvalidated:false,
  sessions:[{sessionId:'main',cwd:'/one'}],listButlerTasks:async()=>[]};
 const h=hooks(react=>loadSource('components/useButlerActivity.ts',{
  react,'react-native':{Platform:{OS:'android'}},
  '../core/notify':{isNotifyEnabled:()=>notify,subscribeNotifyEnabled:fn=>{listener=fn;return()=>{listener=null}},
   beginButlerActivity:(sid,current)=>{const owner={sid,current,closed:false,published:[],publish:v=>owner.published.push(v),close:()=>{owner.closed=true}};owners.push(owner);return owner}},
  '../core/butlerActivity':{watchButlerActivity:options=>{const poll={...options,stopped:false};polls.push(poll);return()=>{poll.stopped=true}}},
 }).useButlerActivity,{store,baseUrl:'http://local.test',workspace:'/one',sessionId:'main',enabled:true});
 const first=owners[0];assert.equal(first.current(),true);
 store.sessions=[{sessionId:'main',cwd:'/two'}];h.render({workspace:'/two'});assert.equal(first.current(),false);assert.equal(first.closed,true);assert.equal(polls[0].stopped,true);
 polls[0].publish(activity);assert.equal(first.published.length,0);
 store.gatewayStatus='offline';assert.equal(owners.at(-1).current(),false);h.render();assert.equal(owners.at(-1).closed,true);
 store.gatewayStatus='online';h.render();assert.equal(owners.at(-1).current(),true);
 store.authInvalidated=true;h.render();assert.equal(owners.at(-1).closed,true);store.authInvalidated=false;h.render();
 h.render({enabled:false});assert.equal(owners.at(-1).closed,true);h.render({enabled:true});
 const before=owners.at(-1);notify=false;listener();h.render();assert.equal(before.closed,true);
 notify=true;listener();h.render();h.render({baseUrl:'http://local.test/'});assert.equal(owners.at(-1).current(),true);
 const previous=owners.at(-1);store.sessions=[];h.render();assert.equal(previous.closed,true);
 store.sessions=[{sessionId:'main',cwd:'/two'}];h.render();const last=owners.at(-1);store.fileBaseUrl='http://different.test';assert.equal(last.current(),false);
 h.unmount();assert.equal(last.closed,true);assert.equal(listener,null);
});

test('Home consumes main-butler clicks into its existing root and selects the butler tab',()=>{
 const listeners=new Set(),calls=[];let request=null;
 const context={butlerMode:true,butlerSessionId:'main',butlerBusy:false,butlerNeedWorkspace:false,
  store:{workspaces:[],consumeOpenSession:()=>{const sid=request;request=null;return sid},subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}}};
 const nav={stack:[{name:'Home'}],push:(...args)=>calls.push(['push',...args]),popToRoot:()=>calls.push(['root'])};
 const h=hooks(react=>loadSource('screens/HomeScreen.tsx',{
  react,'react-native':{ActivityIndicator:'ActivityIndicator',StyleSheet:{create:x=>x},Text:'Text',View:'View'},
  '../components/TabBar':{TabBar:'TabBar'},'../design/theme':{useTheme:()=>({colors:{}})},
  '../components/ButlerWorkspacePicker':{ButlerWorkspacePicker:'Picker'},'../App':{useApp:()=>context},
  '../nav/NavHost':{useNav:()=>nav},'./ChatScreen':{ChatScreen:'Chat'},'./ProfileScreen':{ProfileScreen:'Profile'},'./WorkspacesScreen':{WorkspacesScreen:'Workspaces'},
 }).HomeScreen,{});
 const tab=tree=>tree.children.flat().find(n=>n?.type==='TabBar');
 tab(h.render()).props.onChange('me');h.render();request='main';for(const fn of listeners)fn();
 assert.equal(tab(h.render()).props.tab,'butler');assert.deepEqual(calls,[['root']]);
 request='ordinary';for(const fn of listeners)fn();assert.deepEqual(calls.at(-1).slice(0,2),['push','Chat']);assert.equal(calls.at(-1)[2].sessionId,'ordinary');
 nav.stack.push({name:'Chat',params:{sessionId:'ordinary'}});const count=calls.length;request='ordinary';for(const fn of listeners)fn();assert.equal(calls.length,count);
 context.butlerMode=false;nav.stack=[{name:'Home'}];h.render();tab(h.render()).props.onChange('me');h.render();
 request='normal-from-profile';for(const fn of listeners)fn();assert.equal(tab(h.render()).props.tab,'workspaces');
 nav.stack.push({name:'Chat'});tab(h.render()).props.onChange('me');assert.deepEqual(calls.at(-1),['root']);h.unmount();
});

test('fixed low-priority status only carries counts and opaque binding; current click routes to main chat',async()=>{
 const h=fixture();await h.init();const owner=h.api.beginButlerActivity('main');owner.publish(activity);await tick();
 const n=h.latest();assert.equal(n.id,'dsh-butler-activity');assert.equal(n.android.channelId,'dsh-butler-status');
 assert.equal(n.android.ongoing,true);assert.equal(n.android.onlyAlertOnce,true);assert.equal(n.android.visibility,0);
 assert.equal(n.android.timeoutAfter,90000);assert.match(n.body,/1 项执行中/);
 assert.deepEqual(Object.keys(n.data).sort(),['binding','kind','sessionId']);
 h.press(n.data);assert.deepEqual(h.opened,['main']);owner.close();await tick();h.press(n.data);assert.equal(h.opened.length,1);
});

test('switching to same session name on another identity rejects old presses and old publishers',async()=>{
 const h=fixture();await h.init();const old=h.api.beginButlerActivity('main');old.publish(activity);await tick();const first=h.latest();
 const next=h.api.beginButlerActivity('main');next.publish({...activity,waiting:1});await tick();const current=h.latest();
 old.publish({...activity,running:99});old.close();await tick();assert.equal(h.latest(),current);
 h.press(first.data);assert.equal(h.opened.length,0);h.press(current.data);assert.deepEqual(h.opened,['main']);next.close();
});

test('revocation guard and disabled notifications invalidate clicks immediately',async()=>{
 const h=fixture();await h.init();let valid=true;
 const owner=h.api.beginButlerActivity('main',()=>valid);owner.publish(activity);await tick();const first=h.latest();
 valid=false;h.press(first.data);assert.equal(h.opened.length,0);valid=true;
 h.api.setNotifyEnabled(false);h.press(first.data);await tick();assert.equal(h.opened.length,0);
 assert.equal(h.calls.at(-1)[0],'cancel');owner.close();
});

test('a native display that finishes after disabling is followed by cancellation',async()=>{
 const h=fixture();await h.init();let release;h.delayDisplay(new Promise(resolve=>{release=resolve}));
 const owner=h.api.beginButlerActivity('main');owner.publish(activity);await tick();assert.ok(h.latest());
 h.api.setNotifyEnabled(false);release();await tick();assert.equal(h.calls.at(-1)[0],'cancel');owner.close();
});

test('background delivery routes in the live process and unsubscribes with its owner',async()=>{
 const h=fixture();await h.init();const owner=h.api.beginButlerActivity('main');owner.publish(activity);await tick();
 await h.backgroundPress(h.latest().data);assert.deepEqual(h.opened,['main']);h.off();
 await h.backgroundPress(h.latest().data);assert.equal(h.opened.length,1);owner.close();
});

test('a queued press survives reconnect cleanup only while its exact identity is still current',async()=>{
 const h=fixture();await h.init();let online=true,owns=true;
 const owner=h.api.beginButlerActivity('main',()=>online&&owns,()=>owns);owner.publish(activity);await tick();const data=h.latest().data;
 online=false;owner.close();await h.backgroundPress(data);assert.deepEqual(h.opened,['main']);
 owns=false;await h.backgroundPress(data);assert.equal(h.opened.length,1);
});

test('a denied system permission can be rechecked after grant without another permission request',async()=>{
 const h=fixture();h.setPermission(0);assert.equal(await h.init(),false);
 assert.equal(await h.api.refreshNotificationPermission(),false);h.setPermission(1);
 assert.equal(await h.api.refreshNotificationPermission(),true);h.setPermission(0);
 assert.equal(await h.api.refreshNotificationPermission(),false);assert.equal(h.calls.filter(c=>c[0]==='permission').length,1);h.off();
});

test('old-process notification data is ignored on startup; ordinary notifications still work',async()=>{
 const h=fixture();h.setInitial({kind:'butler-activity',binding:'old-process',sessionId:'main'});await h.init();
 assert.equal(h.opened.length,0);assert.ok(h.calls.some(c=>c[0]==='cancel'));
 h.press({sessionId:'ordinary'});assert.deepEqual(h.opened,['ordinary']);
});
