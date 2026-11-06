import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './support/component-harness.mjs';
import {hookHarness} from './support/hook-harness.mjs';
const tokens=loadSource('design/tokens.ts');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function harness(initial){
 const h=hookHarness(react=>loadSource('components/ReferenceSuggestions.tsx',{
  react,'react-native':{...Object.fromEntries(['ActivityIndicator','ScrollView','Text','TextInput','View'].map(x=>[x,x])),StyleSheet:{create:x=>x,hairlineWidth:1}},
  './MotionPressable':{MotionPressable:'Pressable'},'../design/theme':{useTheme:()=>({...tokens,colors:tokens.lightPalette})},
  '../core/credentialDisplay':{maskCredentials:x=>x},
 }).ReferenceSuggestions,initial);
 const nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flat(Infinity).flatMap(nodes)];
 return{...h,button:label=>nodes(h.render()).find(n=>n.props.accessibilityLabel===label),text:()=>nodes(h.render()).filter(n=>n.type==='Text').map(n=>n.children.join('')).join(' ')};
}
test('late reference candidates cannot cross draft scope, query, tab, session or unmount',async()=>{
 const calls=[], picks=[];
 const source={conversationReferences:(...args)=>{const d=deferred();calls.push({args,...d});return d.promise;}};
 const h=harness({source,sessionId:'first',query:'a',scope:{},onPick:r=>picks.push(r),onClose:()=>{}});
 await pause(280);assert.equal(calls.length,1);
 h.render({query:'b',scope:{}});calls[0].resolve([{key:'old',label:'old',mention:'@old'}]);await pause(1);
 assert.ok(!h.text().includes('old'));
 await pause(280);calls[1].resolve([{key:'new',label:'new',mention:'@new'}]);await pause(1);
 h.button('插入引用：new').props.onPress();assert.equal(picks[0].mention,'@new');
 h.button('引用会话').props.onPress();h.render();assert.ok(!h.text().includes('new'));
 await pause(280);assert.deepEqual(calls[2].args,['first','session','b']);
 h.render({sessionId:'second',scope:{}});calls[2].resolve([{key:'foreign',label:'foreign',mention:'@foreign'}]);await pause(1);assert.ok(!h.text().includes('foreign'));
 await pause(280);h.unmount();calls[3].resolve([]);await pause(1);
});
test('optional endpoint failure is visible and only explicit retry fetches again',async()=>{
 let count=0;const source={conversationReferences:async()=>{count++;throw Error('unsupported');}};
 const h=harness({source,sessionId:'s',query:'',scope:{},onPick:()=>{},onClose:()=>{}});
 await pause(280);assert.match(h.text(),/接口支持/);assert.equal(count,1);
 h.button('重试获取引用').props.onPress();h.render();await pause(280);assert.equal(count,2);h.unmount();
});
