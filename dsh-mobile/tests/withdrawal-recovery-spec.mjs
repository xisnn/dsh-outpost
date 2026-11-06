import test from 'node:test';
import assert from 'node:assert/strict';
import {WithdrawalRecovery, withdrawalScope, mergeWithdrawnDraft, WITHDRAWAL_STORAGE_KEY} from '../src/core/withdrawalRecovery.ts';
const item = {sessionId:'s',itemId:'host-message',text:'原排队文字'};
function harness(){const data=new Map();let fail=false; const storage={getItem:async k=>data.get(k)??null,setItem:async(k,v)=>{if(fail)throw Error('disk');data.set(k,v);},removeItem:async k=>data.delete(k)};return {data,storage,store:new WithdrawalRecovery(()=>storage),fail:()=>{fail=true;}};}
test('prepare survives restart but never restores a draft before an accepted receipt',async()=>{
 const h=harness(), scope=withdrawalScope('http://host','cookie');
 await h.store.prepare(scope,item);
 const next=new WithdrawalRecovery(()=>h.storage);await next.hydrate();
 const copy=next.list(scope,'s')[0];assert.equal(copy.state,'unconfirmed');
 assert.throws(()=>mergeWithdrawnDraft('现有草稿',copy,20000),/未确认/);
 assert.equal(next.list(withdrawalScope('http://other','cookie'),'s').length,0);
 assert.equal(next.list(withdrawalScope('http://host','other-cookie'),'s').length,0);
 assert.ok(!h.data.get(WITHDRAWAL_STORAGE_KEY).includes('cookie'));
});
test('accepted withdrawal appends exact fresh Host text, retains backup and refuses truncation',async()=>{
 const h=harness();const ticket=await h.store.prepare('scope',item);
 const copy=await h.store.confirm(ticket,{...item,text:'新鲜的原文字'});
 assert.equal(mergeWithdrawnDraft('现有草稿',copy,20000),'现有草稿\n\n新鲜的原文字');
 assert.throws(()=>mergeWithdrawnDraft('长草稿',copy,5),/副本/);
 await h.store.markRestored(copy);
 const next=new WithdrawalRecovery(()=>h.storage);await next.hydrate();
 assert.equal(next.list('scope','s')[0].restored,true);
 assert.equal(next.list('scope','s')[0].text,'新鲜的原文字');
 await assert.rejects(h.store.prepare('scope',item),/核对/);
});
test('storage failure stops preparation; late receipt cannot resurrect cleared authorization',async()=>{
 const bad=harness();bad.fail();await assert.rejects(bad.store.prepare('scope',item),/disk/);
 const h=harness(),ticket=await h.store.prepare('scope',item);
 await h.store.clearAll();await assert.rejects(h.store.confirm(ticket,item),/授权已清除/);
 assert.equal(h.data.get(WITHDRAWAL_STORAGE_KEY),undefined);
 assert.deepEqual(h.store.list('scope','s'),[]);
});
test('unmatched receipt cannot confirm another message and cleanup is explicit',async()=>{
 const h=harness(),ticket=await h.store.prepare('scope',item);
 await assert.rejects(h.store.confirm(ticket,{...item,itemId:'other'}),/身份/);
 const copy=h.store.list('scope','s')[0];assert.equal(copy.state,'unconfirmed');
 await h.store.discard(copy);assert.deepEqual(h.store.list('scope','s'),[]);
});
