import assert from 'node:assert/strict';
import test from 'node:test';
import {register} from 'node:module';
import Module from 'node:module';
import {fileURLToPath} from 'node:url';
register('./support/rn-module-hook.mjs',import.meta.url);
const resolve=Module._resolveFilename;
const shims={'@react-native-async-storage/async-storage':'_async-storage-shim.cjs','@react-native-cookies/cookies':'_cookie-manager-shim.cjs','react-native-keychain':'_keychain-shim.cjs','react-native':'_react-native-shim.cjs','react-native-blob-util':'_blob-util-shim.cjs'};
Module._resolveFilename=function(name,parent,...rest){return shims[name]?fileURLToPath(new URL('./support/'+shims[name],import.meta.url)):resolve.call(this,name,parent,...rest);};
const {Store}=await import('../src/core/store.ts');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function make(){const store=new Store({baseUrl:'http://127.0.0.1:9',hasCookie:true,currentCookie:'test',call:async()=>({})});store.archivedLoaded=true;return store;}
function row(id,status='in_progress'){return {sessionId:id,cwd:'/mock',updatedAt:1,running:false,projections:{kind:'cached',asOfSeq:1,values:{agentTeam:{tasks:[{id:'t',subject:'work-'+id,ownerName:'agent',status}]}}}};}
function cache(store,id,status='in_progress'){store.chats.set(id,{...store.getChat(id),agentTeam:row(id,status).projections.values.agentTeam,running:true,turns:[{running:true}]});}

test('same-session requests share complete refresh and side effects; distinct sessions share one snapshot',async()=>{const store=make();cache(store,'a');cache(store,'b');let finish,calls=0,wakes=0;store.api.list=()=>{calls++;return new Promise(resolve=>finish=resolve);};store.wakeButler=async()=>{wakes++;};const first=store.refreshChatMeta('a');assert.equal(store.refreshChatMeta('a'),first);const second=store.refreshChatMeta('b');await flush();assert.equal(calls,1);finish([row('a','completed'),row('b','completed')]);await Promise.all([first,second]);assert.equal(wakes,2);assert.equal(store.teamNotices.length,2);assert.equal(store.getChat('a').running,false);assert.equal(store.getChat('a').turns[0].running,false);assert.equal(store.getChat('b').agentTeam.tasks[0].status,'completed');const again=store.refreshChatMeta('a');await flush();assert.equal(calls,2);finish([row('a','completed'),row('b','completed')]);await again;assert.equal(wakes,2);});

test('global monitoring retains hidden team completion and wakes exactly once',async()=>{const store=make();cache(store,'hidden');let wakes=0;store.wakeButler=async()=>{wakes++;};store.api.list=async()=>[row('hidden','completed')];await store.scanOnce();assert.equal(store.getChat('hidden').agentTeam.tasks[0].status,'completed');assert.equal(store.getChat('hidden').running,false);assert.equal(wakes,1);await store.scanOnce();assert.equal(wakes,1);assert.equal(store.teamNotices.length,1);});

test('global scan and visible refresh coalesce network and completion effects',async()=>{const store=make();cache(store,'a');let finish,calls=0,wakes=0;store.api.list=()=>{calls++;return new Promise(resolve=>finish=resolve);};store.wakeButler=async()=>{wakes++;};const a=store.refreshChatMeta('a'),b=store.scanOnce();await flush();assert.equal(calls,1);finish([row('a','completed')]);await Promise.all([a,b]);assert.equal(wakes,1);assert.equal(store.teamNotices.length,1);});

test('failed projection requests release coalescing state and permit retry',async()=>{const store=make();let calls=0;store.api.list=async()=>{calls++;if(calls===1)throw Error('temporary');return [row('a')];};await store.refreshChatMeta('a');await store.refreshChatMeta('a');assert.equal(calls,2);assert.equal(store.getChat('a').agentTeam.tasks[0].status,'in_progress');});

test('archive filtering remains authoritative and terminal auth prevents polling',async()=>{const store=make();store.archived.add('archived');let calls=0;store.api.list=async()=>{calls++;return [row('live'),row('archived')];};await store.refreshChatMeta('live');assert.deepEqual(store.workspaces.flatMap(w=>w.sessions.map(s=>s.sessionId)),['live']);store.authInvalidated=true;await store.refreshChatMeta('live');assert.equal(calls,1);});
