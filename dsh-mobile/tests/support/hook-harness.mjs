// Minimal hook lifecycle for boundary tests; deliberately does not simulate native layout.
import assert from 'node:assert/strict';
export function hookHarness(load, initial) {
  const slots=[],effects=[];let cursor=0,dirty=false,dead=false,props=initial,result;
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const react={
    createElement: (type, props, ...children) => ({type, props: props ?? {}, children}),
    useRef(value){const i=cursor++;return slots[i]??={current:value};},
    useMemo(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},
    useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return[slots[i].value,value=>{assert.ok(!dead,'no update after unmount');slots[i].value=typeof value==='function'?value(slots[i].value):value;dirty=true;}];},
    useEffect(fn,deps){const i=cursor++;if(!slots[i]||!equal(slots[i].deps,deps))effects.push(()=>{slots[i]?.cleanup?.();slots[i]={deps,cleanup:fn()};});},
  };
  react.default = react;
  const callback=load(react);
  function render(patch={}){props={...props,...patch};do{dirty=false;cursor=0;result=callback(props);while(effects.length)effects.shift()();}while(dirty);return result;}
  render();return{render,unmount(){for(const slot of slots)slot?.cleanup?.();dead=true;}};
}
