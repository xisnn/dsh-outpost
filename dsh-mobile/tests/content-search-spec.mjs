import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentSearchController, parseContentSearch, contentSearchUnsupported} from '../src/core/contentSearch.ts';
import {mergeContentSearch} from '../src/core/sessionSearch.ts';
import {SessionApi} from '../src/core/rpc/session.ts';
import {DshConnection} from '../src/core/transport/index.ts';
import {createRequire} from 'node:module';
// Node 20/tsx can instantiate separate ESM and CJS copies of this class.
// Match the dependency instance used by contentSearch.ts, preserving instanceof checks.
const {RpcError}=createRequire(new URL('../src/core/contentSearch.ts',import.meta.url))('./rpc-error');
import {componentHarness,loadSource} from './support/component-harness.mjs';
import {hookHarness} from './support/hook-harness.mjs';
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const page=(id='one')=>({items:[{sessionId:id,snippet:'message excerpt'}],hasMore:false});
const rpc=(raw,kind='rpc')=>new RpcError({endpoint:'session/search',kind,raw,userTitle:'',userHint:'',retryable:false});
function fixture(read){
 let now=0,id=0;const jobs=new Map(),states=[];
 const controller=new ContentSearchController(read,s=>states.push(s),(fn,ms)=>{const key=++id;jobs.set(key,{fn,at:now+ms});return key;},key=>jobs.delete(key));
 return{controller,states,advance(ms){now+=ms;for(const [key,job]of [...jobs])if(job.at<=now){jobs.delete(key);job.fn();}},last:()=>states.at(-1)};
}
test('parser validates envelopes, strips extra fields and keeps first ranked hit per session',()=>{
 assert.deepEqual(parseContentSearch({items:[{sessionId:'one',snippet:'first',secret:'drop'},{sessionId:'one',snippet:'second'}],hasMore:true}),{items:[{sessionId:'one',snippet:'first'}],hasMore:true});
 for(const value of [null,{}, {items:Array(21).fill(page().items[0])},{items:[{sessionId:'',snippet:'x'}]},{items:[{sessionId:'id',snippet:4}]},{items:[],hasMore:'yes'}])assert.throws(()=>parseContentSearch(value));
});
test('local ordering is preserved; ranked content hits only add still-visible sessions',()=>{
 const s=(sessionId,title)=>({sessionId,projections:{values:{title}}});
 const ws=[{name:'work',path:'/work',sessions:[s('local','needle'),s('two','other'),s('one','other')]}];
 const result=mergeContentSearch(ws,'needle',[{sessionId:'one',snippet:'first'},{sessionId:'deleted',snippet:'hidden'},{sessionId:'two',snippet:'second'},{sessionId:'local',snippet:'local excerpt'},{sessionId:'one',snippet:'duplicate'}]);
 assert.deepEqual(result.map(r=>r.session.sessionId),['local','one','two']);assert.equal(result[0].snippet,'local excerpt');assert.equal(ws[0].sessions[0].snippet,undefined);
 assert.equal(mergeContentSearch(ws,'',page().items).length,0);
});
test('only explicit unsupported responses disable the optional feature',()=>{
 for(const raw of ['gateway/not-found missing','gateway/method-unavailable disabled','gateway/internal session search is disabled by configuration','gateway/internal search_disabled'])assert.equal(contentSearchUnsupported(rpc(raw)),true,raw);
 for(const error of [rpc('HTTP 401','http'),rpc('HTTP 403','http'),rpc('HTTP 500','http'),rpc('offline','network'),rpc('gateway/internal database failed'),rpc('gateway/internal query: search is disabled'),new Error('gateway/not-found')])assert.equal(contentSearchUnsupported(error),false);
 assert.equal(contentSearchUnsupported(rpc('HTTP 404','http')),true);
});
test('committed queries coalesce, repeated pending submission is deduplicated, input never reads',async()=>{
 const calls=[],f=fixture(async q=>{calls.push(q);return page()});
 f.controller.input('composing');f.advance(1000);await tick();assert.equal(calls.length,0);
 f.controller.submit('first');f.advance(200);f.controller.submit('second');f.controller.submit('second');f.advance(249);await tick();assert.equal(calls.length,0);
 f.advance(1);await tick();assert.deepEqual(calls,['second']);assert.equal(f.last().status,'ready');f.controller.dispose();
});
test('changed input, timeout and disposal reject late replies',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>{resolve=r}));
 f.controller.submit('first');f.advance(250);await tick();f.controller.input('second');resolve(page());await tick();assert.equal(f.last().status,'idle');
 f.controller.submit('second');f.advance(250);await tick();f.advance(20000);assert.equal(f.last().status,'failed');resolve(page());await tick();assert.equal(f.last().status,'failed');
 f.controller.submit('third');f.advance(250);await tick();f.controller.dispose();const count=f.states.length;resolve(page());await tick();assert.equal(f.states.length,count);
});
test('unsupported is cached per controller and explicit retry probes again',async()=>{
 let calls=0;const f=fixture(async()=>{if(++calls===1)throw rpc('gateway/internal session search is disabled');return page()});
 f.controller.submit('one');f.advance(250);await tick();assert.equal(f.last().status,'unsupported');
 f.controller.submit('two');f.advance(250);await tick();assert.equal(calls,1);assert.equal(f.last().status,'unsupported');
 f.controller.submit('two',true);f.advance(250);await tick();assert.equal(calls,2);assert.equal(f.last().status,'ready');
 f.controller.submit('x'.repeat(501));f.advance(250);await tick();assert.equal(f.last().status,'too-long');assert.equal(calls,2);f.controller.dispose();
});
test('real hook isolates service changes, late replies and invalidated chat login',async()=>{
 const timers=new Map();let timerId=0,resolveA,resolveB;const reads=[];
 class Controlled extends ContentSearchController {constructor(read,publish){super(read,publish,(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},id=>timers.delete(id));}}
 const run=async()=>{for(const [id,job]of [...timers])if(job.ms===250){timers.delete(id);job.fn();}await tick();};
 const make=(url,resolve)=>({fileBaseUrl:url,connection:'connected',gatewayStatus:'revoked',authInvalidated:false,searchSessions:q=>{reads.push(q);return new Promise(resolve);}});
 const a=make('http://a.test',r=>{resolveA=r}),b=make('http://b.test',r=>{resolveB=r});
 const h=hookHarness(react=>{const {useContentSearch}=loadSource('components/useContentSearch.ts',{react,'../core/contentSearch':{ContentSearchController:Controlled,contentQueryKey:q=>q.trim(),emptyContentSearch:()=>({query:'',status:'idle',items:[],hasMore:false})}});return p=>useContentSearch(p.store,p.baseUrl,p.query);},{store:a,baseUrl:a.fileBaseUrl,query:'needle'});
 const old=h.render();assert.equal(old.available,true);old.submit('needle');await run();
 h.render({store:b,baseUrl:b.fileBaseUrl});old.submit('stale');resolveA(page('old'));await tick();assert.equal(h.render().state.status,'idle');assert.deepEqual(reads,['needle']);
 h.render().submit('needle');await run();resolveB(page('new'));await tick();assert.equal(h.render().state.items[0].sessionId,'new');
 b.authInvalidated=true;assert.equal(h.render().available,false);assert.equal(h.render().state.items.length,0);h.render().submit('blocked');await run();assert.equal(reads.length,2);h.unmount();
});
test('actual API and transport send only request.query to the optional read-only endpoint',async()=>{
 const calls=[];const conn=new DshConnection({baseUrl:'http://127.0.0.1:9',cookie:'dsh-auth=fixture',WebSocketImpl:class{},fetchImpl:async(url,init)=>{calls.push({url,init});return{ok:true,status:200,headers:{get:()=>null},json:async()=>({result:{ok:true,value:page()}})}}});
 const api=new SessionApi(conn);assert.equal((await api.search('  needle  ')).items[0].sessionId,'one');
 assert.equal(calls[0].url,'http://127.0.0.1:9/api/session/search');const body=JSON.parse(calls[0].init.body);assert.equal(body.method,'session/search');assert.deepEqual(body.payload.args,{request:{query:'needle'}});
 await assert.rejects(()=>api.search(' '));await assert.rejects(()=>api.search('x'.repeat(501)));assert.equal(calls.length,1);
});
test('actual transport errors retain optional-feature and authentication distinctions',async()=>{
 for(const [status,expected]of [[404,'unsupported'],[401,'failed']]){
  let reads=0;
  const conn=new DshConnection({baseUrl:'http://127.0.0.1:9',cookie:'isolated-test',WebSocketImpl:class{},fetchImpl:async()=>{reads++;return{ok:false,status,text:async()=>status===404?'not found':'unauthorized'};}});
  const api=new SessionApi(conn),f=fixture(query=>api.search(query));
  f.controller.submit('first');f.advance(250);await tick();assert.equal(f.last().status,expected);
  f.controller.submit('second');f.advance(250);await tick();assert.equal(reads,status===404?1:2);assert.equal(f.last().status,expected);f.controller.dispose();
 }
});
test('real screen defers button search until native final input and opens a hit without a fake message anchor',()=>{
 const submitted=[],input=[],pushes=[];
 const result={session:{sessionId:'hit',updatedAt:1,projections:{values:{title:'Result'}}},workspaceName:'work',workspacePath:'/work',snippet:'matched content'};
 const store={workspaces:[],pendingApprovals:[],sessionsLoading:false,sessionsError:null,connection:'connected',pendingSends:{},compatMissing:[]};
 const h=componentHarness('screens/WorkspacesScreen.tsx','WorkspacesScreen',{}, {
 'react-native-safe-area-context':{useSafeAreaInsets:()=>({top:0})},'@react-native-async-storage/async-storage':{default:{}},
 '../App':{useApp:()=>({store,baseUrl:'http://local.test'})},'../nav/NavHost':{useNav:()=>({stack:[],push:(...args)=>pushes.push(args)})},
 '../components/useContentSearch':{useContentSearch:()=>({available:true,state:{status:'ready',items:[{sessionId:'hit',snippet:'matched content'},{sessionId:'hidden',snippet:'filtered'}],hasMore:false},input:q=>input.push(q),submit:(...args)=>submitted.push(args)})},
 '../core/sessionSearch':{mergeContentSearch:()=>[result]},'../core/draftStore':{draftStore:{has:()=>false}},
 ...Object.fromEntries(['ui','WorkspaceSheet','NewWorkspaceSheet','CompatBanner','ConnectionBanner','ApprovalBanner'].map(name=>['../components/'+name,{}])),
 '../components/CredentialText':{CredentialText:'CredentialText'},'../components/MotionPressable':{MotionPressable:'Pressable'},
 });
 const findInput=()=>h.nodes().find(n=>n.props.placeholder==='搜索全部会话');
 findInput().props.onChangeText('zhong');h.render();assert.equal(submitted.length,0);assert.match(h.text(),/正文命中 1 个可见会话/);
 let blurred=0;findInput().props.ref.current={blur:()=>blurred++};findInput().props.onFocus();h.button('搜索正文').props.onPress();assert.equal(blurred,1);assert.equal(submitted.length,0);
 findInput().props.onEndEditing({nativeEvent:{text:'中文'}});assert.deepEqual(submitted,[['中文',false]]);h.render();
 const list=h.nodes().find(n=>n.props.renderItem);const row=list.props.renderItem({item:result});row.props.onPress();assert.deepEqual(JSON.parse(JSON.stringify(pushes)),[['Chat',{sessionId:'hit',title:'Result'}]]);
 findInput().props.onChangeText('next');h.render();h.button('清空搜索').props.onPress();assert.equal(input.at(-1),'');
});
