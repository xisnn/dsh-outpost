import test from 'node:test';
import assert from 'node:assert/strict';
import {fitImage,clampImage,pinchImage} from '../src/core/imageViewport.ts';
const viewport={width:400,height:600}, landscape={width:1200,height:600};
test('contain fit uses actual image aspect ratio',()=>{assert.deepEqual(fitImage(viewport,landscape),{width:400,height:200});assert.deepEqual(fitImage(viewport,{width:200,height:1000}),{width:120,height:600});});
test('zoomed drag stays within the visible image, including letterboxing',()=>{assert.deepEqual(clampImage(viewport,landscape,{scale:2,x:10000,y:10000}),{scale:2,x:200,y:0});assert.deepEqual(clampImage(viewport,landscape,{scale:1,x:-10000,y:10000}),{scale:1,x:0,y:0});});
test('pinch starts at measured finger spacing without a scale jump',()=>{for(const distance of [40,80,240,400])assert.deepEqual(pinchImage({scale:1.5,x:20,y:-30},distance,distance,{x:45,y:50},{x:0,y:0}),{scale:1.5,x:20,y:-30});});
test('pinch preserves its focal point and finger translation',()=>{assert.deepEqual(pinchImage({scale:1,x:0,y:0},80,160,{x:50,y:40},{x:10,y:-5}),{scale:2,x:-40,y:-45});});
test('pinch scale clamps to 1 through 4 and malformed transform values cannot escape bounds',()=>{assert.equal(pinchImage({scale:1,x:0,y:0},10,1000,{x:0,y:0},{x:0,y:0}).scale,4);assert.equal(pinchImage({scale:2,x:0,y:0},200,1,{x:0,y:0},{x:0,y:0}).scale,1);assert.deepEqual(clampImage(viewport,landscape,{scale:NaN,x:Infinity,y:NaN}),{scale:1,x:0,y:0});});
