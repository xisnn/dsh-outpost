import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function fixture() {
  const slots = [], pending = [], animations = [];
  let cursor = 0, unmounted = false;
  const env = { reduced: false, listener: null, removed: false, initial: null };
  const equal = (a,b) => a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    forwardRef: fn => props => fn(props, props.forwardedRef),
    createContext: value => ({ value, Provider: 'Provider' }),
    useContext: ctx => ctx.value,
    useRef: value => slots[cursor++] ??= {current:value},
    useState(initial) {
      const i=cursor++;
      const slot=slots[i] ??= {value:typeof initial==='function'?initial():initial};
      return [slot.value, value => { assert.equal(unmounted,false,'state update after unmount'); slot.value=typeof value==='function'?value(slot.value):value; }];
    },
    useMemo(fn,deps) { const i=cursor++; if(!slots[i] || !equal(slots[i].deps,deps))slots[i]={value:fn(),deps}; return slots[i].value; },
    useEffect(fn,deps) { const i=cursor++; if(!slots[i]||!equal(slots[i].deps,deps))pending.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};}); },
  };
  class Value { constructor(value){this.value=value;} setValue(value){this.value=value;} interpolate(config){return {value:this,...config};} }
  const native={
    Pressable:'Pressable',Modal:'Modal',View:'View',
    StyleSheet:{flatten(value){if(!Array.isArray(value))return value;return Object.assign({},...value.filter(Boolean).map(v=>this.flatten(v)));}},
    Easing:{quad:'quad',cubic:'cubic',out:x=>x,in:x=>x},
    Animated:{Value,View:'AnimatedView',createAnimatedComponent:x=>x,multiply:(a,b)=>({a,b}),timing(value,config){
      const animation={value,config,start(callback){this.callback=callback;animations.push(this);},stop(){this.stopped=true;this.callback?.({finished:false});},finish(){value.value=config.toValue;this.callback?.({finished:true});}};
      return animation;
    }},
    AccessibilityInfo:{
      isReduceMotionEnabled:()=>new Promise(resolve=>{env.initial=resolve;}),
      addEventListener(_event,listener){env.listener=listener;return {remove(){env.removed=true;}};},
    },
  };
  function load(file,extra='') {
    const source=fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2021}}).outputText;
    const exports={};
    vm.runInNewContext(code+extra,{exports,require(name){
      if(name==='react')return {...react,default:react};
      if(name==='react-native')return native;
      if(name==='../design/motion')return {MOTION:{press:100,enter:160,exit:120},useMotionPreference:()=>env.reduced};
      throw new Error('Unexpected import '+name);
    }});
    return exports;
  }
  return {env,animations,load,render(Component,props){cursor=0;const tree=Component(props);while(pending.length)pending.shift()();return tree;},unmount(){unmounted=true;for(const slot of slots)slot?.cleanup?.();}};
}

test('press feedback preserves the root target, styles, children and callbacks',()=>{
  const h=fixture(), calls=[];
  const {MotionPressable}=h.load('components/MotionPressable.tsx');
  const ref={current:null}, child=()=>null;
  const props={forwardedRef:ref,children:child,hitSlop:12,onPress(){},onPressIn:e=>calls.push(e),onPressOut:e=>calls.push(e),style:({pressed})=>({flex:1,transform:[{translateX:4}],opacity:pressed?0.7:1})};
  let tree=h.render(MotionPressable,props);
  assert.equal(tree.type,'Pressable');assert.equal(tree.props.ref,ref);assert.equal(tree.props.children,child);assert.equal(tree.props.hitSlop,12);
  assert.equal(tree.props.style[0].flex,1);assert.equal(tree.props.style[1].transform[0].translateX,4);
  tree.props.onPressIn('down');tree=h.render(MotionPressable,props);
  assert.equal(tree.props.style[0].opacity,0.7);
  tree.props.onPressOut('up');assert.deepEqual(calls,['down','up']);
  assert.equal(h.animations.at(-1).config.toValue,0);
});

test('disabled, reduced-motion and backdrop targets do not animate',()=>{
  for(const extras of [{disabled:true},{accessible:false},{feedback:'none'},{style:{position:'absolute'}}]){
    const h=fixture();const {MotionPressable}=h.load('components/MotionPressable.tsx');
    const tree=h.render(MotionPressable,{onPress(){},...extras});tree.props.onPressIn({});assert.equal(h.animations.length,0);
  }
  const h=fixture();h.env.reduced=true;const {MotionPressable}=h.load('components/MotionPressable.tsx');h.render(MotionPressable,{onPress(){}}).props.onPressIn({});assert.equal(h.animations.length,0);
});

function modalFixture(){const h=fixture();const {Fading}=h.load('components/MotionModal.tsx','\nexports.Fading=FadingModal;');return {...h,Fading};}

test('overlay waits for native presentation and preserves content while exiting',()=>{
  const h=modalFixture();let close=0;
  let tree=h.render(h.Fading,{visible:true,children:'first',onRequestClose(){close++;}});
  assert.equal(h.animations.length,0);tree.props.onShow({});
  assert.equal(h.animations.at(-1).config.toValue,1);h.animations.at(-1).finish();
  tree=h.render(h.Fading,{visible:false,children:null,onRequestClose(){close++;}});
  assert.equal(tree.children[0].children[0],'first');assert.equal(tree.children[0].props.pointerEvents,'none');
  tree.props.onRequestClose({});assert.equal(close,0);
  h.animations.at(-1).finish();assert.equal(h.render(h.Fading,{visible:false,children:null}),null);
});

test('rapid overlay reopening ignores stale exit completion',()=>{
  const h=modalFixture();let tree=h.render(h.Fading,{visible:true,children:'old'});tree.props.onShow({});h.animations.at(-1).finish();
  h.render(h.Fading,{visible:false,children:null});const exit=h.animations.at(-1);
  tree=h.render(h.Fading,{visible:true,children:'new'});exit.finish();
  tree=h.render(h.Fading,{visible:true,children:'new'});assert.notEqual(tree,null);assert.equal(tree.children[0].children[0],'new');
});

test('closing before native onShow cannot leave an invisible modal mounted',()=>{
  const h=modalFixture();const opening=h.render(h.Fading,{visible:true,children:'old'});
  h.render(h.Fading,{visible:false,children:null});opening.props.onShow({});
  assert.equal(h.render(h.Fading,{visible:false,children:null}),null);
  h.render(h.Fading,{visible:true,children:'new'});assert.notEqual(h.render(h.Fading,{visible:true,children:'new'}),null);
});

test('reduced-motion overlays settle immediately; stale callbacks after unmount are inert',()=>{
  const h=modalFixture();let tree=h.render(h.Fading,{visible:true,children:'old'});tree.props.onShow({});h.animations.at(-1).finish();
  h.render(h.Fading,{visible:false,children:null});const exit=h.animations.at(-1);h.unmount();exit.finish();
  const reduced=modalFixture();reduced.env.reduced=true;
  tree=reduced.render(reduced.Fading,{visible:true,children:'still'});tree.props.onShow({});
  reduced.render(reduced.Fading,{visible:false,children:null});assert.equal(reduced.render(reduced.Fading,{visible:false,children:null}),null);assert.equal(reduced.animations.length,0);
});

test('native onShow reads the latest motion preference',()=>{
  const h=modalFixture();const old=h.render(h.Fading,{visible:true,children:'content'});
  h.env.reduced=true;h.render(h.Fading,{visible:true,children:'content'});old.props.onShow({});
  assert.equal(h.animations.length,0);
});

test('full-screen modals preserve native presentation and callbacks',()=>{
  const h=fixture();const {MotionModal}=h.load('components/MotionModal.tsx');const close=()=>{};
  const props={visible:true,presentationStyle:'fullScreen',animationType:'slide',onRequestClose:close};
  let tree=h.render(MotionModal,props);assert.equal(tree.type,'Modal');assert.equal(tree.props.animationType,'slide');assert.equal(tree.props.onRequestClose,close);assert.equal(tree.props.presentationStyle,'fullScreen');
  h.env.reduced=true;tree=h.render(MotionModal,props);assert.equal(tree.props.animationType,'none');
});

test('one accessibility subscription ignores a stale initial read and cleans up',async()=>{
  const h=fixture();const {MotionPreferenceProvider}=h.load('design/useReduceMotion.ts');
  h.render(MotionPreferenceProvider,{children:'app'});h.env.listener(true);h.env.initial(false);await Promise.resolve();
  const tree=h.render(MotionPreferenceProvider,{children:'app'});assert.equal(tree.props.value,true);
  h.env.listener(false);assert.equal(h.render(MotionPreferenceProvider,{children:'app'}).props.value,false);
  h.unmount();assert.equal(h.env.removed,true);h.env.listener(true);
});
