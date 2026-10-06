import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { GEOMETRY_CAMERA_COMMANDS as C, INITIAL_GEOMETRY_CAMERA_FRAME, geometryCameraFrame,
  orientGeometryCamera, geometryCameraCommandFromKeyboardEvent } from '../src/services/visualization/geometryCameraView.js';
import { referenceResultVectorLayers, resultVectorLength } from '../src/services/visualization/resultVectorScale.js';
import { movie3DFilenamePrefix, movieFilename } from '../src/services/movie/movieFilename.js';
import { createMovieGifSession } from '../src/services/movie/movieGifCore.js';
import { createMovieExportController } from '../src/services/movie/movieExportController.js';

const axes=[C.VIEW_POSITIVE_X,C.VIEW_NEGATIVE_X,C.VIEW_POSITIVE_Y,C.VIEW_NEGATIVE_Y,C.VIEW_POSITIVE_Z,C.VIEW_NEGATIVE_Z];
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
for(const perspective of [false,true])for(const command of axes) {
  test(`${perspective?'perspective':'orthographic'} ${command}: target, distance, zoom and frustum unchanged`,()=>{
    const camera=perspective?new THREE.PerspectiveCamera(43,1.8,.02,1e6):new THREE.OrthographicCamera(-25,17,18,-9,.02,1e6);
    const controls={target:new THREE.Vector3(12,-4,7)};
    camera.position.set(36,18,42);camera.zoom=2.75;
    const distance=camera.position.distanceTo(controls.target),target=controls.target.toArray();
    const frustum=[camera.left,camera.right,camera.top,camera.bottom,camera.near,camera.far,camera.fov];
    assert.equal(orientGeometryCamera(camera,controls,command),true);
    near(camera.position.distanceTo(controls.target),distance);assert.equal(camera.zoom,2.75);
    assert.deepEqual(controls.target.toArray(),target);
    assert.deepEqual([camera.left,camera.right,camera.top,camera.bottom,camera.near,camera.far,camera.fov],frustum);
    const direction=camera.position.clone().sub(controls.target).normalize().toArray();
    const expected=new THREE.Vector3().fromArray(geometryCameraFrame(command).offset).normalize().toArray();
    direction.forEach((v,i)=>near(v,expected[i]));
  });
}
test('Ctrl+A uses the shared initial oblique frame; A remains fit only',()=>{
  for(const key of ['a','ф'])assert.equal(geometryCameraCommandFromKeyboardEvent({code:'KeyA',key,ctrlKey:true}),C.RESET_OBLIQUE);
  assert.equal(geometryCameraCommandFromKeyboardEvent({code:'KeyA'}),C.FIT_ALL);
  assert.deepEqual(geometryCameraFrame(C.RESET_OBLIQUE).offset,INITIAL_GEOMETRY_CAMERA_FRAME.offset);
  assert.deepEqual(INITIAL_GEOMETRY_CAMERA_FRAME.offset,[1,1,1]);
  assert.equal(geometryCameraCommandFromKeyboardEvent({code:'KeyA',ctrlKey:true,target:{tagName:'INPUT'}}),null);
});
const layer=(factor,quantityKey='J',key='elements')=>({key,quantityKey,state:'ready',scene:{
  vectors:[{origin:[1,2,3],vector:[0,factor,0],kind:'magnetization',magnitude:Math.abs(factor),characteristicSize:2}],
  maximumMagnitude:{current:0,magnetization:Math.abs(factor)},sceneDiagonal:100,
}});
test('normalization does not divide out an amplitude already present in the HDF5 values',()=>{
  const task={},refs=[];
  for(const factor of [0,2,1,-.5,0,4]) {
    const input=layer(factor),snapshot=structuredClone(input);
    const [out]=referenceResultVectorLayers(task,[input]);
    assert.deepEqual(input,snapshot);assert.equal(out.scene,input.scene);
    assert.deepEqual(out.scene.vectors[0].vector,[0,factor,0]);
    assert.equal(out.scene.maximumMagnitude.magnetization,Math.abs(factor));
    if(factor===0&&!refs.length)assert.equal(out.vectorLengthReference,undefined);
    else {refs.push(out.vectorLengthReference);assert.equal(out.vectorLengthReference.maximumMagnitude.magnetization,2);}
  }
  assert.ok(refs.every(ref=>ref===refs[0]));
});
test('reference survives a tab reader replacement; different tasks, groups and quantities remain independent',()=>{
  const task={},a=referenceResultVectorLayers(task,[layer(2)])[0].vectorLengthReference;
  assert.equal(referenceResultVectorLayers(task,[layer(7)])[0].vectorLengthReference,a);
  assert.equal(referenceResultVectorLayers(task,[layer(7,'M')])[0].vectorLengthReference.maximumMagnitude.magnetization,7);
  assert.equal(referenceResultVectorLayers(task,[layer(9,'J','virtual')])[0].vectorLengthReference.maximumMagnitude.magnetization,9);
  assert.equal(referenceResultVectorLayers({},[layer(8)])[0].vectorLengthReference.maximumMagnitude.magnetization,8);
});
test('length reference does not change colour values, original arrays, or quantity unit conversions',()=>{
  const task={},input=layer(3);const vectors=input.scene.vectors;
  referenceResultVectorLayers(task,[input]);
  const next=layer(12);next.scene.sceneDiagonal=900;next.scene.vectors[0].characteristicSize=10;
  const result=referenceResultVectorLayers(task,[next])[0];
  assert.equal(result.vectorLengthReference.sceneDiagonal,100);assert.equal(result.vectorLengthReference.characteristicSize,2);
  assert.equal(result.scene.vectors[0].magnitude,12);assert.equal(result.scene.maximumMagnitude.magnetization,12);
  assert.equal(input.scene.vectors,vectors);assert.equal(result.scene,next.scene);
});
test('filename prefixes include active fields and streamlines, deduplicate B/A and preserve other tabs',()=>{
  assert.equal(movie3DFilenamePrefix([{quantityKey:'J',selected:[1]}]),'J_3d');
  assert.equal(movie3DFilenamePrefix([{quantityKey:'M',selected:[1]},{quantityKey:'Bs',selected:[2]},{quantityKey:'Bv',selected:[3]}]),'M_B_3d');
  assert.equal(movie3DFilenamePrefix([{quantityKey:'none'},{quantityKey:'H',selected:[]}],[{quantityKey:'As'},{quantityKey:'Av'}]),'A_3d');
  assert.equal(movie3DFilenamePrefix([]),'3d');
  assert.equal(movie3DFilenamePrefix([{quantityKey:'MHdot'},{quantityKey:'JEdot'}]),'MH_JE_3d');
  const d=new Date(2026,9,6,18,10,0);
  assert.equal(movieFilename('M_B_3d',d),'M_B_3d_2026-10-06_18-10-00.gif');
  assert.equal(movieFilename('areas',d),'areas_2026-10-06_18-10-00.gif');
});
const pixels=()=>({width:2,height:2,data:new Uint8Array([255,0,0,255,0,255,0,255,0,0,255,255,255,255,255,255])});
test('static GIF has exactly one decoded image, delay=0 and no NETSCAPE loop extension',()=>{
  const session=createMovieGifSession();session.addFrame(pixels(),{delayMs:100,repeat:-1});
  const bytes=session.finish(),raw=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  const decoded=decompressFrames(parseGIF(raw),true);
  assert.equal(decoded.length,1);assert.equal(decoded[0].dims.width,2);assert.equal(decoded[0].dims.height,2);
  assert.equal(new TextDecoder('latin1').decode(bytes).includes('NETSCAPE'),false);
});
test('static session rejects a second frame; dynamic GIF keeps multiple frames and looping',()=>{
  const staticSession=createMovieGifSession();staticSession.addFrame(pixels(),{delayMs:100,repeat:-1});
  assert.throws(()=>staticSession.addFrame(pixels(),{delayMs:100,repeat:-1}),/Статический/);
  const dynamic=createMovieGifSession();dynamic.addFrame(pixels(),{delayMs:100});dynamic.addFrame(pixels(),{delayMs:200});
  const bytes=dynamic.finish(),raw=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  assert.equal(decompressFrames(parseGIF(raw),true).length,2);
  assert.equal(new TextDecoder('latin1').decode(bytes).includes('NETSCAPE'),true);
});
for(const frameCount of [1,3])test(`controller captures ${frameCount} frame(s), locks filename and restores once`,async()=>{
  const task={},calls=[],options=[];let prefix='M_3d';
  const controller=createMovieExportController({createEncoder:()=>({
    async addFrame(_image,option){options.push(option);},async finish(){return new Blob(['test'],{type:'image/gif'});},close(){calls.push('close');},
  })});
  controller.register({getContext:()=>({task,frameCount,originalTime:0,timeStep:frameCount===1?0:.1,filenamePrefix:prefix,title:'3D'}),
    async prepare(){calls.push('prepare');},async capture(index){calls.push(index);prefix='J_3d';return pixels();},
    async restore(index){calls.push(`restore:${index}`);}});
  const result=await controller.run({intervalMs:frameCount===1?NaN:120});
  assert.equal(result.frameCount,frameCount);assert.match(result.filename,/^M_3d_/);
  assert.deepEqual(calls.filter(x=>typeof x==='number'),Array.from({length:frameCount},(_,i)=>i));
  assert.deepEqual(calls.filter(x=>typeof x==='string'&&x.startsWith('restore')),['restore:0']);
  assert.ok(options.every(option=>(option.repeat??0)===(frameCount===1?-1:0)));
  assert.ok(options.every(option=>option.delayMs===(frameCount===1?100:120)));
  controller.dispose();
});

test('shared thin/solid length calculation preserves positive, zero and negative-amplitude magnitudes',()=>{
  const task={},reference=referenceResultVectorLayers(task,[layer(2)])[0].vectorLengthReference;
  for(const factor of [0,2,1,-.5,4]) {
    const item=layer(factor).scene.vectors[0];
    const length=resultVectorLength(item,1,{magnetization:Math.abs(factor)},100,reference);
    near(length,1.4*Math.abs(factor)/2);
    assert.equal(item.vector[1],factor);
    near(resultVectorLength(item,3,{magnetization:Math.abs(factor)},100,reference),length*3);
  }
});
