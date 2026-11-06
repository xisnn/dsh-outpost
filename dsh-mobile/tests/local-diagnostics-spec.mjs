import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './support/component-harness.mjs';
import {hookHarness} from './support/hook-harness.mjs';
const {buildLocalDiagnostics}=loadSource('core/localDiagnostics.ts');
const secret='private-unrecognized-value-do-not-export';
test('diagnostics constructs an explicit schema and never serializes a Store, raw error or identity',()=>{
 const input={version:'0.18.3',platform:'android',platformVersion:35,connection:'connected',authInvalidated:false,gatewayStatus:'revoked',butlerMode:true,missingEndpoints:['session/page','session/search','https://private.test/'+secret,secret],notifyEnabled:true,notifyState:'就绪',baseUrl:'https://'+secret,cookie:secret,sessions:[{text:secret}],attachments:[secret],env:{secret}};
 Object.defineProperty(input,'rawError',{get(){throw Error('must not touch raw error');}});
 const result=buildLocalDiagnostics(input);const encoded=JSON.stringify(result);assert.ok(!encoded.includes(secret));assert.ok(!encoded.includes('private.test'));assert.equal(result.appVersion,'0.18.3');assert.equal(result.chat.connection,'connected');assert.equal(result.approval.status,'revoked');assert.deepEqual(Array.from(result.compatibility.missingEndpoints),['session/page','session/search']);
 assert.deepEqual(Object.keys(result).sort(),['format','generatedAt','appVersion','platform','platformVersion','chat','approval','butlerMode','compatibility','notifications'].sort());assert.equal(input.missingEndpoints.length,4);
});
test('unknown values cannot inject private strings through allowed fields',()=>{
 const result=buildLocalDiagnostics({version:secret,platform:secret,platformVersion:secret,connection:secret,gatewayStatus:secret,notifyState:'原生模块加载失败：'+secret,notifyEnabled:secret,missingEndpoints:[{},secret]});
 assert.ok(!JSON.stringify(result).includes(secret));assert.equal(result.appVersion,'unknown');assert.equal(result.platform,'other');assert.equal(result.platformVersion,null);assert.equal(result.chat.connection,'unknown');assert.equal(result.notifications.initialization,'unavailable');
});
test('actual entry previews without network/file activity and invalidates a replaced service',()=>{
 const tokens=loadSource('design/tokens.ts');const store={connection:'error',authInvalidated:false,gatewayStatus:'offline',compatMissing:['session/page'],rawError:secret,baseUrl:'https://'+secret,ping(){assert.fail('no requests');},sessions:[secret]};
 const context={store,baseUrl:'https://'+secret,butlerMode:false};
 const h=hookHarness(react=>()=>loadSource('components/LocalDiagnosticsButton.tsx',{
 react,'react-native':{Platform:{OS:'android',Version:35},Text:'Text',StyleSheet:{create:x=>x,hairlineWidth:1}},'../App':{useApp:()=>context},'../design/theme':{useTheme:()=>({...tokens,colors:tokens.lightPalette})},'../core/version':{APP_VERSION:'0.18.3'},'../core/notify':{isNotifyEnabled:()=>true,notifyDebugState:()=> '就绪'},'./MotionPressable':{MotionPressable:'Pressable'},'./LocalExportPanel':{LocalExportSheet:'ExportSheet'},
 }).LocalDiagnosticsButton({}),{});
 const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(nodes)];
 const tree=()=>nodes(h.render());let entry=tree().find(n=>n.props.accessibilityLabel==='本地诊断包');assert.equal(tree().find(n=>n.type==='ExportSheet').props.visible,false);entry.props.onPress();let sheet=tree().find(n=>n.type==='ExportSheet');assert.equal(sheet.props.visible,true);assert.equal(sheet.props.allowOriginal,false);assert.match(sheet.props.fileName,/\.json$/);assert.ok(!sheet.props.text.includes(secret));assert.equal(JSON.parse(sheet.props.text).chat.errorCategory,'connection-error');
 const stale=entry.props.onPress;context.store={...store};context.baseUrl='https://replacement.test';h.render();stale();assert.equal(tree().find(n=>n.type==='ExportSheet').props.visible,false);h.unmount();stale();
});
test('coarse error categories come only from connection state; notifications retain no raw exception',()=>{
 assert.equal(buildLocalDiagnostics({connection:'error',authInvalidated:true}).chat.errorCategory,'access-blocked');
 assert.equal(buildLocalDiagnostics({connection:'error'}).chat.errorCategory,'connection-error');
 assert.equal(buildLocalDiagnostics({connection:'connected'}).chat.errorCategory,'none');
 for(const [state,expected]of [['未初始化','not-initialized'],['通道未就绪：'+secret,'channel-unavailable'],['就绪','ready'],[secret,'unknown']])assert.equal(buildLocalDiagnostics({notifyState:state}).notifications.initialization,expected);
});
