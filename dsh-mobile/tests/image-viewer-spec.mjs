import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function harness(initialProps={}){
 const slots=[],effects=[];let cursor=0,dirty=false,tree,dead=false,springs=0;
 const env={reduced:false,closed:0,retried:0,saved:[],scrolls:[]},props={visible:true,images:[{uri:'data:first',caption:'first'},{uri:'data:second',caption:'second'}],onClose:()=>env.closed++,...initialProps};
 const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={createElement:(type,props,...children)=>{if(type==='FlatList'&&props.ref)props.ref.current={scrollToOffset:value=>env.scrolls.push(value)};return {type,props:props||{},children};},useRef:value=>slots[cursor++]??={current:value},
  useState(initial){const i=cursor++;const slot=slots[i]??={value:typeof initial==='function'?initial():initial};return [slot.value,value=>{assert.ok(!dead);const next=typeof value==='function'?value(slot.value):value;if(!Object.is(next,slot.value)){slot.value=next;dirty=true;}}];},
  useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={value:fn(),deps};return slots[i].value;},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
 react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps);react.default=react;
 class Value{constructor(value){this.value=value;}setValue(value){this.value=value;}}
 const native={FlatList:'FlatList',ActivityIndicator:'Spinner',Alert:{alert(){}},Animated:{Value,ValueXY:class {constructor(){this.x=new Value(0);this.y=new Value(0);}setValue(value){this.x.setValue(value.x);this.y.setValue(value.y);}},View:'Animated',spring(value,options){springs++;return {start(){value.setValue(options.toValue);},stop(){}};},parallel:list=>({start:()=>list.forEach(x=>x.start()),stop:()=>list.forEach(x=>x.stop())})},Image:'Image',PanResponder:{create:panHandlers=>({panHandlers})},StyleSheet:{create:x=>x},Text:'Text',View:'View'};
 function load(file){const code=ts.transpileModule(fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,jsx:ts.JsxEmit.React}}).outputText;const exports={};vm.runInNewContext(code,{exports,require(name){if(name==='react')return react;if(name==='react-native')return native;if(name==='react-native-safe-area-context')return {useSafeAreaInsets:()=>({top:0,bottom:0})};if(name==='./MotionModal')return {MotionModal:'Modal'};if(name==='./MotionPressable')return {MotionPressable:'Pressable'};if(name==='../core/fileSave')return {saveImageToGallery:async(...args)=>{env.saved.push(args);return {ok:true,where:'gallery'};}};if(name==='../design/motion')return {useMotionPreference:()=>env.reduced};if(name==='../core/imageViewport')return load('core/imageViewport.ts');throw Error(name);}});return exports;}
 const {ImageViewer}=load('components/ImageViewer.tsx');
 const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.type==='FlatList'?node.props.data.map((item,index)=>node.props.renderItem({item,index})):node.children).flat(Infinity).flatMap(nodes)];
 const render=(patch={})=>{Object.assign(props,patch);let attempts=0;do{assert.ok(attempts++<20);dirty=false;cursor=0;tree=ImageViewer(props);while(effects.length)effects.shift()();}while(dirty);return tree;};
 const find=predicate=>nodes(tree).find(predicate);
 const stage=()=>find(n=>n.props.onPanResponderMove);
 const button=label=>find(n=>n.props.accessibilityLabel===label);
 const pager=()=>find(n=>n.type==='FlatList');
 const image=()=>find(n=>n.props.testID===`viewer-image-${pager()?.props.extraData.index}`);
 const transform=()=>{const t=find(n=>n.props.testID===`image-transform-${pager().props.extraData.index}`).props.style.transform;return {scale:t[2].scale.value,x:t[0].translateX.value,y:t[1].translateY.value};};
 const pageTo=(index)=>{pager().props.onMomentumScrollEnd({nativeEvent:{contentOffset:{x:index*400}}});render();};
 const layout=(width=400,height=600)=>{const node=stage();node.props.ref.current={measureInWindow:fn=>fn(0,0,width,height)};node.props.onLayout({nativeEvent:{layout:{width,height}}});render();};
 render();if(stage())layout();if(image())image().props.onLoad({nativeEvent:{source:{width:1200,height:600}}});render();
 return {env,render,find,stage,button,image,transform,layout,pager,pageTo,get springs(){return springs;},unmount(){for(const slot of slots)slot?.cleanup?.();dead=true;}};
}
const touches=(...points)=>({nativeEvent:{touches:points.map(([pageX,pageY])=>({pageX,pageY}))}});
test('actual viewer pinch starts without a jump and zoomed drag clamps to bitmap edges',()=>{const h=harness();h.stage().props.onPanResponderGrant(touches([160,300],[240,300]));h.stage().props.onPanResponderMove(touches([160,300],[240,300]));assert.equal(h.transform().scale,1);h.stage().props.onPanResponderMove(touches([120,300],[280,300]));assert.equal(h.transform().scale,2);h.stage().props.onPanResponderRelease({}, {dx:0,dy:0});h.stage().props.onPanResponderGrant(touches([200,300]));h.stage().props.onPanResponderMove(touches([1200,1300]));assert.deepEqual(h.transform(),{scale:2,x:200,y:0});h.unmount();});
test('pinch-to-single transition cannot close or switch the gallery',()=>{const h=harness();h.stage().props.onPanResponderGrant(touches([100,300],[300,300]));h.stage().props.onPanResponderMove(touches([180,300],[220,300]));h.stage().props.onPanResponderMove(touches([220,300]));h.stage().props.onPanResponderMove(touches([600,800]));h.stage().props.onPanResponderRelease({}, {dx:500,dy:500});h.render();assert.equal(h.env.closed,0);assert.ok(h.find(n=>n.type==='Text'&&n.children.includes('1 / 2')));assert.deepEqual(h.transform(),{scale:1,x:0,y:0});h.unmount();});
test('horizontal movement belongs to native paging while vertical drag and zoom stay with the image',()=>{const h=harness();assert.equal(h.stage().props.onMoveShouldSetPanResponderCapture(touches([100,300]),{dx:-120,dy:4}),false);assert.equal(h.stage().props.onMoveShouldSetPanResponderCapture(touches([100,300]),{dx:4,dy:120}),true);assert.equal(h.pager().props.pagingEnabled,true);assert.equal(h.pager().props.bounces,false);h.pageTo(1);assert.ok(h.find(n=>n.type==='Text'&&n.children.includes('2 / 2')));assert.deepEqual(h.transform(),{scale:1,x:0,y:0});h.button('放大图片').props.onPress();h.render();assert.equal(h.pager().props.scrollEnabled,false);assert.equal(h.stage().props.onMoveShouldSetPanResponderCapture(touches([100,300]),{dx:-120,dy:4}),true);h.unmount();});
test('accessible zoom resets on resize and respects live reduced motion',()=>{const h=harness();h.env.reduced=true;h.render();const count=h.springs;h.button('放大图片').props.onPress();h.render();assert.equal(h.transform().scale,2.5);assert.equal(h.springs,count);h.layout(600,400);assert.deepEqual(h.transform(),{scale:1,x:0,y:0});h.unmount();});
test('closed viewer rejects a late gesture release',()=>{const h=harness();const old=h.stage().props;old.onPanResponderGrant(touches([200,300]));h.render({visible:false});old.onPanResponderRelease({}, {dx:0,dy:200});assert.equal(h.env.closed,0);h.unmount();});
test('same-URI parent refresh preserves zoom and late image callbacks are ignored after close/unmount',()=>{const h=harness();h.button('放大图片').props.onPress();h.render({images:[{uri:'data:first',caption:'updated'},{uri:'data:second'}]});assert.equal(h.transform().scale,2.5);const old=h.image().props;h.render({visible:false});old.onError();old.onLoad({nativeEvent:{source:{width:999,height:999}}});assert.ok(h.image());h.unmount();old.onError();old.onLoad({nativeEvent:{source:{width:999,height:999}}});});
test('long press saves only images with a local path',async()=>{const h=harness();h.find(n=>n.type==='Pressable'&&n.props.onLongPress).props.onLongPress();assert.equal(h.env.saved.length,0);h.render({images:[{uri:'data:first',save:{fsPath:'/cache/test.png',name:'test.png'}}]});h.find(n=>n.type==='Pressable'&&n.props.onLongPress).props.onLongPress();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(h.env.saved,[['/cache/test.png','test.png']]);h.unmount();});
test('initial loading and empty galleries tolerate unknown bitmap dimensions',()=>{const h=harness({images:[{caption:'loading'}]});assert.ok(h.find(n=>n.type==='Spinner'));h.env.reduced=true;h.render();h.unmount();const empty=harness({images:[]});assert.equal(empty.find(()=>true),undefined);empty.unmount();});
test('failed gallery entry exposes a usable retry action',()=>{const h=harness();h.render({images:[{caption:'failed',failed:true,onRetry:()=>h.env.retried++}]});assert.ok(h.find(n=>n.type==='Text'&&n.children.includes('图片加载失败')));h.button('重试加载图片').props.onPress();assert.equal(h.env.retried,1);h.unmount();});

test('neighbour pages exist before swiping and retain their image keys across a page change',()=>{
 const h=harness();const list=h.pager().props;
 assert.ok(h.find(n=>n.props.testID==='viewer-image-1'));
 const keys=list.data.map(list.keyExtractor);
 assert.equal(list.getItemLayout(null,1).offset,400);
 assert.equal(h.find(n=>n.props.testID==='image-page-1').props.importantForAccessibility,'no-hide-descendants');
 h.pageTo(1);
 assert.deepEqual(h.pager().props.data.map(h.pager().props.keyExtractor),keys);
 assert.equal(h.image().props.source.uri,'data:second');
 assert.equal(h.find(n=>n.props.testID==='image-page-1').props.importantForAccessibility,'auto');
 h.unmount();
});

test('button navigation animates the native offset without an immediate corrective jump',()=>{
 const h=harness();h.env.scrolls.length=0;
 h.button('下一张图片').props.onPress();h.render();
 assert.equal(h.env.scrolls.length,1);assert.equal(h.env.scrolls[0].offset,400);assert.equal(h.env.scrolls[0].animated,true);
 h.env.reduced=true;h.render();h.env.scrolls.length=0;
 h.button('上一张图片').props.onPress();h.render();
 assert.equal(h.env.scrolls.length,1);assert.equal(h.env.scrolls[0].offset,0);assert.equal(h.env.scrolls[0].animated,false);
 h.unmount();
});

test('preloaded neighbour dimensions bound the first zoom after paging',()=>{
 const h=harness();h.find(n=>n.props.testID==='viewer-image-1').props.onLoad({nativeEvent:{source:{width:600,height:1200}}});
 h.pageTo(1);h.button('放大图片').props.onPress();h.render();
 h.stage().props.onPanResponderGrant(touches([200,300]));h.stage().props.onPanResponderMove(touches([1200,1300]));
 assert.deepEqual(h.transform(),{scale:2.5,x:175,y:450});h.unmount();
});

test('a neighbour decode failure does not hide the current image and stays retryable after paging',()=>{
 const h=harness({images:[{uri:'data:first'},{uri:'data:second',onRetry:()=>h.env.retried++}]});
 h.find(n=>n.props.testID==='viewer-image-1').props.onError();h.render();
 assert.equal(h.image().props.source.uri,'data:first');h.pageTo(1);assert.equal(h.image(),undefined);
 h.button('重试加载图片').props.onPress();h.render();assert.equal(h.env.retried,1);assert.equal(h.image().props.source.uri,'data:second');h.unmount();
});

test('a loading attachment gaining its URI does not interrupt the native swipe position',()=>{
 const h=harness({images:[{id:'a',uri:'data:first'},{id:'b'}]});h.env.scrolls.length=0;
 const keys=h.pager().props.data.map(h.pager().props.keyExtractor);
 h.render({images:[{id:'a',uri:'data:first'},{id:'b',uri:'data:second'}]});
 assert.deepEqual(h.pager().props.data.map(h.pager().props.keyExtractor),keys);
 assert.equal(h.env.scrolls.length,0);assert.ok(h.find(n=>n.props.testID==='viewer-image-1'));h.unmount();
});

test('resize keeps the selected page, reopening restores initial page, and stale native events are ignored',()=>{
 const h=harness();h.pageTo(1);h.layout(600,400);assert.equal(h.env.scrolls.at(-1).offset,600);
 const old=h.pager().props.onMomentumScrollEnd;
 h.render({visible:false});h.render({visible:true});assert.equal(h.pager().props.extraData.index,0);assert.equal(h.env.scrolls.at(-1).offset,0);
 old({nativeEvent:{contentOffset:{x:600}}});h.render();assert.equal(h.pager().props.extraData.index,0);
 const pending=h.pager().props.onMomentumScrollEnd;h.render({images:[{id:'replacement',uri:'data:new'}]});
 pending({nativeEvent:{contentOffset:{x:600}}});h.render();assert.equal(h.pager().props.extraData.index,0);
 h.unmount();pending({nativeEvent:{contentOffset:{x:600}}});
});
