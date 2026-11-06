import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './support/component-harness.mjs';
const {navigationColumns}=loadSource('core/adaptiveNavigation.ts');
const screens=(...names)=>names.map(name=>({name}));
test('columns require both window dimensions, finite values and readable font space',()=>{
 for(const [w,h,s]of [[899,800,1],[1200,599,1],[1200,800,1.5],[NaN,800,1],[1200,Infinity,1],[1200,800,0]])assert.equal(navigationColumns(screens('Home','Chat'),w,h,true,s),null);
 const c=navigationColumns(screens('Home','Chat'),1200,800,true);assert.equal(c.masterIndex,0);assert.equal(c.detailIndex,1);assert.equal(c.masterWidth,336);assert.equal(c.detailWidth,864);
 const large=navigationColumns(screens('Home','Chat'),1600,1000,true,1.5);assert.ok(large.masterWidth>=450);assert.ok(large.detailWidth>=600);
});
test('only a list and current top Chat split; butler root never becomes a second active chat',()=>{
 assert.equal(navigationColumns(screens('Home','Chat'),1200,800,false),null);
 assert.equal(navigationColumns(screens('Home','Sessions'),1200,800,true),null);
 assert.equal(navigationColumns([],1200,800,true),null);
 const c=navigationColumns(screens('Home','Workspaces','Sessions','Chat','Chat'),1200,800,false);assert.equal(c.masterIndex,2);assert.equal(c.detailIndex,4);
 assert.equal(navigationColumns(screens('Home','Workspaces','Chat'),1200,800,false).masterIndex,1);
});
