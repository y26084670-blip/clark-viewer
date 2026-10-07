import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import h5wasm from 'h5wasm/node';
import { globalRangesTask } from '../scripts/test-support/globalRangesFixture.js';
import { globalResultRange, resultGlobalScale, applyResultGlobalRange, workingPointGlobalMRange } from '../src/services/results/resultGlobalScale.js';
import { resultDisplaySelection } from '../src/services/results/resultRequests.js';
import { Hdf5ResultFile } from '../src/services/results/hdf5ResultFile.js';
import { sourcesFields3DSetup } from '../scripts/test-support/sourcesFields3DSetup.js';
import { QUANTITIES, MU0 } from '../src/services/results/resultMappings.js';
import { resultVectorLength } from '../src/services/visualization/resultVectorScale.js';

test('all/selected/except/none load different original IDs for physical, virtual and region groups', async () => {
  const task=globalRangesTask(); const props={task,elements:[1],regions:[2],time:0};
  const settings={resultElementsQuantity:'J',resultRegionsQuantity:'Bs',resultVirtualQuantity:'Av'};
  const ui=sourcesFields3DSetup(props, settings);
  const ids=()=>ui.requestedLayers().map(layer=>layer.selected);
  assert.deepEqual(ids(), [[1,2,4],[1,2],[3]]);
  let frame=await ui.load(ui.request());
  assert.deepEqual(frame.layers.map(l=>l.state),['ready','ready','ready']);
  assert.equal(new Set(frame.layers[0].scene.vectors.map(v=>v.source.recordIndex)).size,3);
  settings.elementsMode='selected';settings.regionsMode='selected';
  assert.deepEqual(ids(), [[1],[2],[]]);
  settings.elementsMode='exceptSelected';settings.regionsMode='exceptSelected';
  assert.deepEqual(ids(), [[2,4],[1],[3]]);
  settings.elementsMode='none';settings.regionsMode='none';
  assert.deepEqual(ids(), [[],[],[]]);
  frame=await ui.load(ui.request());assert.ok(frame.layers.every(l=>l.state==='empty'));
  assert.deepEqual(props.elements,[1]);assert.deepEqual(props.regions,[2]);ui.close();
});

test('global vector ranges use selected source IDs, saved norms and display units exactly once', () => {
  const task=globalRangesTask();
  for (const [key,ids,min,max] of [['M',[1],5,50],['J',[4],15,150],['E',[2,4],30,300],['Bs',[1,2],5,100],['As',[1,2],5*MU0,100*MU0],['Bv',[3],5,50],['Av',[3],5*MU0,50*MU0]]) {
    const range=globalResultRange(task,key,ids);assert.equal(range.available,true,key);
    assert.equal(range.minimum,min,key);assert.equal(range.maximum,max,key);
  }
  assert.equal(globalResultRange(task,'E',[2]).state,'empty');
});

test('working points use min(0, Mmin) and Mmax for the selected FMM set', () => {
  const task=globalRangesTask();
  const range=workingPointGlobalMRange(task,[1]);
  assert.equal(range.available,true);
  assert.equal(range.minimum,0);
  assert.equal(range.maximum,50);
  const combined=workingPointGlobalMRange(task,[1,4]);
  assert.equal(combined.minimum,0);
  assert.equal(combined.maximum,100);
  assert.equal(workingPointGlobalMRange(task,[]).available,false);
});

test('derived global maps deliberately multiply modulus bounds and ignore stored exact dot extrema', () => {
  const task=globalRangesTask();
  for (const key of ['MHdot','JEdot']) {
    const range=globalResultRange(task,key,[1]);
    assert.equal(range.minimum,QUANTITIES[key].factor*5*10);
    assert.equal(range.maximum,QUANTITIES[key].factor*50*100);
    assert.equal(range.approximate,true);
    assert.equal(range.minimum>0,true);
  }
});

test('global mode is unavailable for missing, partial, stale, wrong-model, wrong-time or nonfinite indexes', () => {
  const changes=[t=>delete t.metadata.MH.ranges,
    t=>t.metadata.MH.ranges.state='partial',t=>t.metadata.MH.ranges.available=false,
    t=>t.metadata.MH.ranges.objectIds.reverse(),t=>t.general.countTimeSteps=3,
    t=>t.general.timeStep=.2,t=>t.metadata.MH.ranges.invalidCount[3]=1,
    t=>t.metadata.MH.ranges.minimum[3]=-1,t=>t.metadata.MH.ranges.maximum[3]=Infinity];
  for(const change of changes){const task=globalRangesTask();change(task);assert.equal(globalResultRange(task,'M',[1]).available,false);}
  const task=globalRangesTask(); task.metadata.JE.ranges.runId='another-run';
  assert.equal(resultGlobalScale(task,[{key:'elements',quantityKey:'J',selected:[1]},{key:'regions',quantityKey:'Bs',selected:[1]}]).available,false);
  assert.equal(resultGlobalScale(task,[]).available,false);
  assert.equal(resultGlobalScale(task,[{quantityKey:'none',selected:[1]}]).available,false);
});

test('zero/static ranges and old files never block ordinary 3D viewing', async () => {
  const task=globalRangesTask();task.general={countTimeSteps:0,timeStep:0};
  const r=task.metadata.MH.ranges;r.stepIds=[0];r.times=[0];r.minimum.fill(0);r.maximum.fill(0);
  assert.equal(globalResultRange(task,'M',[1]).maximum,0);
  const ui=sourcesFields3DSetup({task,elements:[1],regions:[],time:0},{resultGlobalMinMax:true});
  assert.equal(ui.effectiveGlobalMinMax(),true);
  delete task.metadata.MH.ranges;
  assert.equal(ui.effectiveGlobalMinMax(),false);
  const frame=await ui.load(ui.request());assert.equal(frame.layers[0].state,'ready');ui.close();
});

test('global mode is display-only, keeps raw fields intact and replaces a tiny first-frame denominator', async () => {
  const task=globalRangesTask(),ui=sourcesFields3DSetup({task,elements:[1],regions:[],time:0},{elementsMode:'selected'});
  const request=ui.request(),frame=await ui.load(request);ui.setResultState({requested:request,frame:{request,value:frame},loading:false,error:''});
  const original=frame.layers[0],point=original.scene.vectors[0];
  const tiny={...original,vectorLengthReference:{characteristicSize:1,sceneDiagonal:100,maximumMagnitude:{current:0,magnetization:1e-12}}};
  const range=globalResultRange(task,'M',[1]), global=applyResultGlobalRange(tiny,range);
  assert.ok(Math.abs(resultVectorLength(point,1,{},0,global.vectorLengthReference)-.7*point.magnitude/50)<1e-15);
  assert.equal(global.scene,tiny.scene);assert.equal(tiny.vectorLengthReference.maximumMagnitude.magnetization,1e-12);
  assert.equal(applyResultGlobalRange(tiny,null),tiny);
  ui.setGlobalMinMax(true);assert.equal(ui.effectiveGlobalMinMax(),true);
  assert.equal(ui.resultLayers()[0].displayRange.maximum,50);
  assert.deepEqual(ui.request(),request);assert.equal(original.displayRange,undefined);
  ui.setGlobalMinMax(false);assert.equal(ui.resultLayers()[0].displayRange,undefined);ui.close();
});

for (const Type of [Float32Array,Float64Array]) test(`real ${Type.name} HDF5 headers reach 3D global ranges without scanning saved fields`, async () => {
  await h5wasm.ready;const dir=await mkdtemp(join(tmpdir(),'viewer-minmax-'));
  try { for(const [name,key] of [['MH','M'],['JE','JEdot'],['HS','Bs'],['AS','As'],['HV','Bv'],['AV','Av'],['Q','Q']]) {
    const task=globalRangesTask(),metadata=task.metadata[name],r=metadata.ranges,header=metadata.header;
    const path=join(dir,name+'.h5');let f=new h5wasm.File(path,'w');
    const hg=f.create_group('HEADER');
    for(const [name,val] of Object.entries({columns:header.columns,arrCount:header.arrCount,hasCoo:1})) hg.create_dataset({name,data:new BigInt64Array([BigInt(val)]),shape:[]});
    for(const name of ['inds1','numbs']) hg.create_dataset({name,data:new BigInt64Array(header[name].map(BigInt))});
    const g=hg.create_group('RANGES');
    for(const [dsName,data] of Object.entries({schema_version:1,quantity_definition_version:1,state:'complete',run_id:r.runId,
      object_kind:['HS','AS'].includes(name)?'regions':['HV','AV'].includes(name)?'virtual':'elements',
      data_revision:3,indexed_revision:3,last_step:2,time_step:.1})) g.create_dataset({name:dsName,data});
    for(const [name,data] of Object.entries({object_ids:new BigInt64Array(r.objectIds.map(BigInt)),channel_ids:r.channelIds,channel_units:r.channelUnits,
      step_ids:new BigInt64Array([0n,1n,2n]),times:new Float64Array(r.times)})) g.create_dataset({name,data});
    const gg=g.create_group('global'),shape=[r.objectIds.length,r.channelIds.length];
    for(const [name,data] of Object.entries({min:new Float64Array(r.minimum),max:new Float64Array(r.maximum),
      valid_count:new BigInt64Array(r.validCount.map(BigInt)),invalid_count:new BigInt64Array(r.invalidCount.map(BigInt))})) gg.create_dataset({name,data,shape});
    const count=header.numbs.reduce((a,b)=>a+b,0);
    for(const step of [0,1,2]) f.create_dataset({name:String(step).padStart(6,'0'),shape:[count,header.stride],data:new Type(count*header.stride).fill(step+1)});
    f.close();f=new h5wasm.File(path,'r');
    try {
      let fieldReads=0;const handle={keys:()=>f.keys(),get(path){const ds=f.get(path);if(!/^\d+$/.test(path))return ds;
        return {shape:ds.shape,get value(){fieldReads++;throw new Error('full field scan');},slice:s=>ds.slice(s)};}};
      const file=new Hdf5ResultFile(name,handle);assert.equal(file.ranges.available,true,`${name}: ${file.ranges.reason}`);
      task.metadata[name]=file.metadata;
      const result=globalResultRange(task,key,r.objectIds);assert.equal(result.available,true,`${name}: ${result.reason}`);
      assert.equal(fieldReads,0);assert.ok(file.read({step:0,start:0,count:1}).values instanceof Type);
    } finally{f.close();}
  }} finally{await rm(dir,{recursive:true,force:true});}
});
