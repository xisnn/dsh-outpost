import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './support/component-harness.mjs';
import {hookHarness} from './support/hook-harness.mjs';
const key='sk-'+ 'FabricatedExportOnly0123456789';
const original='# Reply\n\n**Selected body**\n\n'+key;
function fixture(outcome={ok:true,where:'下载目录',uri:'content://downloads/1'}){
 const calls=[];
 const {saveLocalText}=loadSource('core/localExport.ts',{
  'react-native-blob-util':{default:{fs:{dirs:{CacheDir:'/private/cache'},writeFile:async(...args)=>calls.push(['write',...args]),unlink:async path=>calls.push(['unlink',path])}}},
  './fileSave':{saveToDownloads:async(...args)=>{calls.push(['save',...args]);if(outcome instanceof Error)throw outcome;return outcome;}},
 });return{saveLocalText,calls};
}
test('message export keeps Markdown and protects the complete selected body by default',()=>{
 const {prepareTextExport}=loadSource('core/exportText.ts');
 const value=prepareTextExport(original);assert.match(value.text,/# Reply\n\n\*\*Selected body\*\*/);assert.ok(!value.text.includes(key));assert.match(value.text,/凭据 1 已隐藏/);assert.equal(value.hasCredentials,true);
 assert.equal(prepareTextExport(original,true).text,original);assert.equal(original.includes(key),true);
 assert.throws(()=>prepareTextExport('x'.repeat(2*1024*1024+1)),/过长/);
});
test('local export writes the reviewed UTF-8 body, saves only on request and deletes its private copy after Downloads copy',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);const result=await f.saveLocalText('# chosen\n','outpost-message.md');assert.equal(result.kind,'saved');
 assert.equal(f.calls[0][0],'write');assert.equal(f.calls[0][2],'# chosen\n');assert.equal(f.calls[0][3],'utf8');assert.equal(f.calls[1][2],'outpost-message.md');assert.equal(f.calls[2][0],'unlink');assert.equal(f.calls[0][1],f.calls[2][1]);
});
test('cancel is not reported as saved; private cache cleanup also runs on failure',async()=>{
 for(const outcome of [{ok:true,where:'已取消'},{ok:false,reason:'raw private detail'},new Error('raw private detail')]){
  const f=fixture(outcome);const result=await f.saveLocalText('body','message.md');assert.equal(result.kind,outcome.where==='已取消'?'cancelled':'failed');assert.ok(!JSON.stringify(result).includes('raw private'));assert.equal(f.calls.at(-1)[0],'unlink');
 }
});
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(nodes)];
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function panel(){
 const tokens=loadSource('design/tokens.ts'),calls=[],listeners=new Set(),env={state:'active'};let resolve;
 const h=hookHarness(react=>loadSource('components/LocalExportPanel.tsx',{
 react,'react-native':{AppState:{get currentState(){return env.state;},addEventListener:(_event,fn)=>{listeners.add(fn);return{remove:()=>listeners.delete(fn)};}},ScrollView:'ScrollView',Switch:'Switch',Text:'Text',View:'View',StyleSheet:{create:x=>x,hairlineWidth:1}},
 '../design/theme':{useTheme:()=>({...tokens,colors:tokens.lightPalette})},'./MotionPressable':{MotionPressable:'Pressable'},'./MotionModal':{MotionModal:'Modal'},
 '../core/localExport':{saveLocalText:(...args)=>{calls.push(args);return new Promise(r=>{resolve=r;});}},
 }).LocalExportPanel,{title:'Export',text:original,fileName:'message.md',onClose(){}});
 const tree=()=>nodes(h.render()),button=()=>tree().find(n=>n.props.accessibilityLabel==='保存到手机');
 return{h,calls,tree,button,done:()=>resolve({kind:'saved',message:'saved'}),emit(state){env.state=state;for(const fn of listeners)fn(state);},body:()=>tree().filter(n=>n.type==='Text').flatMap(n=>n.children).join('\n')};
}
test('real panel saves only the previewed snapshot and blocks same-frame duplicate saves',async()=>{
 const f=panel();assert.equal(f.calls.length,0);assert.ok(!f.body().includes(key));const save=f.button().props.onPress;save();save();assert.equal(f.calls.length,1);assert.ok(!f.calls[0][0].includes(key));f.done();await tick();assert.match(f.body(),/saved/);f.h.unmount();
});
test('original export is explicit, resets on background/text changes and rejects stale save callbacks',async()=>{
 const f=panel();f.tree().find(n=>n.type==='Switch').props.onValueChange(true);assert.ok(f.body().includes(key));const stale=f.button().props.onPress;
 f.emit('background');f.emit('active');stale();assert.equal(f.calls.length,0);assert.ok(!f.body().includes(key));
 f.tree().find(n=>n.type==='Switch').props.onValueChange(true);const previous=f.button().props.onPress;f.h.render({text:'another body'});previous();assert.equal(f.calls.length,0);f.button().props.onPress();assert.equal(f.calls[0][0],'another body');f.h.unmount();f.done();await tick();
});
test('Downloads preserves the exact Markdown extension at the native MediaStore boundary',async()=>{
 const calls=[];const {saveToDownloads}=loadSource('core/fileSave.ts',{'react-native':{Platform:{OS:'android',Version:35}},'react-native-blob-util':{default:{MediaCollection:{copyToMediaStore:async(...args)=>{calls.push(args);return'content://downloads/1';}}}},'./fileUrl':{mimeOf:()=> 'text/markdown'}});
 assert.equal((await saveToDownloads('/cache/source','outpost-message.md')).ok,true);assert.equal(calls[0][0].name,'outpost-message.md');assert.equal(calls[0][0].mimeType,'text/markdown');assert.equal(calls[0][1],'Download');
});
test('fallback sharing preserves its private source for deferred receiver reads',async()=>{
 const f=fixture({ok:true,where:'已发送'});assert.equal((await f.saveLocalText('body','message.md')).kind,'shared');assert.equal(f.calls.some(c=>c[0]==='unlink'),false);
});
