import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { readResultStreamlines, streamlineVertexOrder } from "../src/services/results/resultStreamlineRequests.js";
import { createResultStreamlineProcessor } from "../src/services/results/resultStreamlineProcessor.js";
import { calculateStreamlines } from "../src/services/visualization/resultStreamlineField.js";
import { createResultLayerReader } from "../src/services/results/resultLayerRequests.js";
import { vectorScene } from "../src/services/results/resultPlots.js";
import { QUANTITIES, elementLayout } from "../src/services/results/resultMappings.js";
import { createResultFrameController } from "../src/services/results/resultFrameController.js";
import { completedMovieFrame } from "../src/services/movie/movieTabAdapter.js";

function fixture({quantityKey="M",indAmp=0,copies=2,Type=Float64Array}={}) {
  const virtual=["Bv","Av"].includes(quantityKey), q=QUANTITIES[quantityKey];
  const record={id:1,recordIndex:0,name:"box",targ:virtual?3:0,xapName:"steel",rv:1,geoType:0,
    geo:[[0,0,0],[2,0,0],[0,3,0],[2,3,0],[0,0,4],[2,0,4],[0,3,4],[2,3,4]],dp:[[2],[3],[4]],
    dr:[[0],[0],[0]],symVi:[[0],[0],[0]],symR0:[[0],[0],[0]],symLs:1,symAs:1,symPs:copies,
    symKya:0,symKyp:0,symTx:10,indMove:0,indAmp};
  const layout=elementLayout(record,virtual),[n1,n2,n3]=layout.dimensions,stride=virtual?6:9;
  const reads=[], frames=[];
  for(let time=0;time<2;time++) {
    const values=new Type(layout.count*stride);let row=0;
    for(let i=0;i<n1;i++)for(let j=0;j<n2;j++)for(let k=0;k<n3;k++)for(let image=0;image<copies;image++) {
      const a=(i+.5)/n1,b=(j+.5)/n2,c=(k+.5)/n3;
      // Independent FieldV loop coordinates for a rectangular hexahedron.
      const p=virtual&&indAmp===1?[2*c,3*b,4*(1-a)]
        :virtual&&indAmp===2?[2*b,3*c,4*a]
        :virtual&&indAmp===3?[2*b,3*(1-a),4*c]:[2*a,3*b,4*c];
      p[0]+=image*10; values.set(p,row*stride);
      values.set(time?[0,2,0]:[1,0,0],row*stride+q.offset);row++;
    }
    frames.push({values,count:layout.count,stride,every:1});
  }
  const task={elements:[record],regions:[],general:{timeStep:1,countTimeSteps:1},metadata:{[q.file]:{
    header:{inds1:[1],numbs:[layout.count]},steps:[0,1]}},reader:{async read(req){
      reads.push(req);const frame=frames[req.step],values=[];
      for(let i=req.start;i<req.start+req.count;i+=req.every??1)values.push(...frame.values.subarray(i*stride,(i+1)*stride));
      return {values:new Type(values),stride,count:values.length/stride,every:req.every??1};
    }}};
  const seed={id:1,quantityKey,source:{schemaId:"elements",recordIndex:0},instance:{ls:0,as:0,ps:copies-1},node:0};
  return {task,seed,reads,frames,record};
}
const processor={process:async input=>calculateStreamlines(input)};

test("one saved image is read in full by stride; all six fields preserve factors, symmetry and time",async()=>{
  for(const quantityKey of ["M","H","J","E","Bv","Av"])for(const Type of [Float32Array,Float64Array]) {
    const f=fixture({quantityKey,Type});let received;
    const p={process:async input=>{received=input;return calculateStreamlines(input);}};
    const first=(await readResultStreamlines({task:f.task,time:0,streamlineSeeds:[f.seed]},p))[0];
    assert.equal(first.error,undefined,quantityKey);assert.equal(f.reads.length,1);
    assert.equal(f.reads[0].start,1);assert.equal(f.reads[0].every,2);assert.equal(f.reads[0].count,47);
    assert.ok(received.domains[0].vectors[0]=== (QUANTITIES[quantityKey].factor??1));
    assert.ok(first.paths.every(path=>path.instance.ps===1));
    const factor=QUANTITIES[quantityKey].factor??1;
    assert.ok(first.paths.every(path=>path.magnitudes.every(value=>Math.abs(value-factor)<factor*1e-12)));
    const later=(await readResultStreamlines({task:f.task,time:1,streamlineSeeds:[f.seed]},p))[0];
    assert.equal(later.error,undefined);assert.notDeepEqual(later.paths[0].positions,first.paths[0].positions);
    assert.deepEqual(later.start,first.start);
    assert.ok(later.paths.every(path=>path.magnitudes.every(value=>Math.abs(value-2*factor)<factor*1e-12)));
  }
});
test("all virtual coil directions respect solver axis reversals, unequal dimensions and centre coordinates",async()=>{
  for(const indAmp of [0,1,2,3]) {
    const f=fixture({quantityKey:"Bv",indAmp});
    const line=(await readResultStreamlines({task:f.task,time:0,streamlineSeeds:[f.seed]},processor))[0];
    assert.equal(line.error,undefined,`indAmp=${indAmp}`);assert.ok(line.paths.length);
    assert.ok(line.paths.flatMap(p=>[p.positions[0],p.positions.at(-3)]).every(x=>x>=10-1e-7&&x<=12+1e-7));
    assert.deepEqual([...streamlineVertexOrder(f.record,true)].sort((a,b)=>a-b),[0,1,2,3,4,5,6,7]);
  }
});
test("trace reads the touching neighbour even when it is not selected for the point display",async()=>{
  const f=fixture();
  f.task.elements.push({...f.record,id:2,recordIndex:1,dr:[[2],[0],[0]]});
  f.task.metadata.MH.header={inds1:[1,49],numbs:[48,48]};
  for(const frame of f.frames) {
    const values=new Float64Array(frame.values.length*2);values.set(frame.values);values.set(frame.values,frame.values.length);
    for(let row=48;row<96;row++)values[row*9]+=2;
    frame.values=values;frame.count=96;
  }
  const line=(await readResultStreamlines({task:f.task,time:0,streamlineSeeds:[f.seed],selected:[1]},processor))[0];
  assert.equal(line.error,undefined);assert.deepEqual(f.reads.map(r=>r.start),[1,49]);
  assert.ok(line.paths.some(path=>path.source.recordIndex===1));
  assert.ok(Math.abs(Math.max(...line.paths.map(path=>path.positions.at(-3)))-14)<1e-7);
});
test("sampled display node retains the exact saved image and node index for double-click",()=>{
  const f=fixture({copies:2}),frame=f.frames[0];
  const rows=[1,12,33],values=new Float64Array(rows.flatMap(row=>Array.from(frame.values.subarray(row*9,row*9+9))));
  const vectors=vectorScene([{record:f.record,frame:{values,stride:9,count:3,rowIndices:rows,every:1}}],QUANTITIES.M).vectors;
  assert.deepEqual(vectors.map(v=>[v.savedRow,v.node,v.instance.ps,v.quantityKey]),[[1,0,1,"M"],[12,6,0,"M"],[33,16,1,"M"]]);
});
test("atomic reader caches previous curves when adding/deleting a seed, and recomputes them for a new time",async()=>{
  const f=fixture();let runs=0,closed=0;
  const reader=createResultLayerReader({streamlineProcessorFactory:()=>({process:async input=>{runs++;return calculateStreamlines(input);},close(){closed++;}})});
  const request={task:f.task,time:0,layers:[],streamlineSeeds:[f.seed],streamlineTolerance:1e-4};
  const first=await reader.read(request);assert.equal(runs,1);
  const next={...f.seed,id:2,node:6};
  const added=await reader.read({...request,streamlineSeeds:[f.seed,next]});
  assert.equal(runs,2);assert.equal(added.streamlines[0],first.streamlines[0]);assert.equal(added.streamlines.length,2);
  const removed=await reader.read({...request,streamlineSeeds:[next]});assert.equal(runs,2);assert.equal(removed.streamlines[0],added.streamlines[1]);
  await reader.read({...request,time:1});assert.equal(runs,3);
  await reader.read({...request,streamlineSeeds:[]});assert.equal(closed,1);reader.close();
});
test("missing or scalar fields cannot be silently reused as a vector; cancellation releases the worker",async()=>{
  const f=fixture();
  for(const quantityKey of ["JEdot","Bv"]) {
    const result=await readResultStreamlines({task:f.task,time:0,streamlineSeeds:[{...f.seed,quantityKey}]},processor);
    assert.ok(result[0].error);assert.equal(result[0].paths.length,0);
  }
  let fake,terminated=0;
  const p=createResultStreamlineProcessor({workerFactory:()=>fake={postMessage(){},terminate(){terminated++;}}});
  const pending=p.process({domains:[],seeds:[]});p.close();await assert.rejects(pending,{name:"AbortError"});
  assert.equal(terminated,1);assert.equal(fake.onmessage,null);
});
test("real worker transfers independent input buffers and returns full curves without detaching HDF5 frames",async()=>{
  const workerUrl=new URL("../src/workers/resultStreamline.worker.js",import.meta.url).href;
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};
    import(${JSON.stringify(workerUrl)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`,{eval:true});
  let bridge;
  const p=createResultStreamlineProcessor({workerFactory:()=>{
    bridge={postMessage:(data,transfer)=>worker.postMessage(data,transfer),terminate:()=>worker.terminate()};
    worker.on("message",data=>bridge.onmessage?.({data}));worker.on("error",error=>bridge.onerror?.(error));return bridge;
  }});
  const f=fixture({quantityKey:"Av",indAmp:1});
  try {
    const lines=await readResultStreamlines({task:f.task,time:0,streamlineSeeds:[f.seed]},p);
    assert.equal(lines[0].error,undefined);assert.ok(lines[0].paths[0].positions instanceof Float64Array);
    assert.ok(lines[0].paths[0].magnitudes instanceof Float64Array);
    assert.equal(lines[0].paths[0].magnitudes.length,lines[0].paths[0].positions.length/3);
    assert.ok(lines[0].paths.every(path=>path.magnitudes.every(Number.isFinite)));
    assert.equal(f.frames[0].values.byteLength,48*6*8);
  } finally {p.close();}
});

test("frame publication and movie readiness wait for the current step's lines, and discard a late old step",async()=>{
  const f=fixture();let entered,release,finished,state;
  const started=new Promise(resolve=>entered=resolve), gate=new Promise(resolve=>release=resolve), done=new Promise(resolve=>finished=resolve);
  const reader=createResultLayerReader({streamlineProcessorFactory:()=>({async process(input){
    if(!state.frame){entered();await gate;}return calculateStreamlines(input);
  },close(){}})});
  const controller=createResultFrameController({load:r=>reader.read(r),publish:s=>{state=s;if(s.frame?.request.time===1&&!s.loading)finished();},
    schedule:callback=>{queueMicrotask(callback);return 1;},cancel(){}});
  const request={task:f.task,time:0,layers:[],streamlineSeeds:[f.seed]};controller.request(request);await started;
  controller.request({...request,time:1});
  assert.equal(completedMovieFrame(state,{task:f.task,index:1}).ready,false);assert.equal(state.frame,null);
  release();await done;
  assert.equal(state.frame.request.time,1);assert.equal(state.frame.value.streamlines[0].error,undefined);
  assert.equal(completedMovieFrame(state,{task:f.task,index:1}).ready,true);
  controller.close();reader.close();
});

test("motion reanchors the same saved node at each time, and saved coordinates are not transformed twice",async()=>{
  const f=fixture();f.record.indMove=1;
  f.task.moves=[{position:[[0,0,0,0],[1,5,0,0]],angle:[[0,0,0,0],[1,0,0,0]]}];
  for(let i=0;i<f.frames[1].count;i++)f.frames[1].values[i*9]+=5;
  const first=(await readResultStreamlines({task:f.task,time:0,streamlineSeeds:[f.seed]},processor))[0];
  const later=(await readResultStreamlines({task:f.task,time:1,streamlineSeeds:[f.seed]},processor))[0];
  assert.equal(later.error,undefined);assert.equal(later.start[0]-first.start[0],5);
  assert.ok(later.paths.every(path=>path.positions[0]>=15&&path.positions[0]<=17));
});

test("each field method reaches the worker with the unchanged saved seeds, data and tolerance",async()=>{
  for(const method of ["trilinear","trilinear-boundary"]) {
    const f=fixture(),tolerance=1e-5;let received;
    const lines=await readResultStreamlines({task:f.task,time:0,streamlineSeeds:[f.seed],streamlineTolerance:tolerance,
      streamlineMethod:method},{process:async input=>{received=input;return calculateStreamlines(input);}});
    assert.equal(received.method,method);assert.equal(received.tolerance,tolerance);
    assert.deepEqual(received.seeds.map(seed=>[seed.id,seed.node,seed.quantityKey,seed.source,seed.instance]),
      [[f.seed.id,f.seed.node,f.seed.quantityKey,f.seed.source,f.seed.instance]]);
    assert.equal(received.domains[0].positions.length,24*3);assert.equal(f.frames[0].values.byteLength,48*9*8);
    assert.equal(lines[0].method,method);assert.ok(Array.isArray(lines[0].fallbacks));assert.equal(lines[0].error,undefined);
  }
});

test("curve cache normalizes the control default, invalidates the method and retains matching seeds",async()=>{
  const f=fixture(),inputs=[];
  const reader=createResultLayerReader({streamlineProcessorFactory:()=>({
    process:async input=>{inputs.push(input);return calculateStreamlines(input);},close(){}})});
  const request={task:f.task,time:0,layers:[],streamlineSeeds:[f.seed],streamlineTolerance:1e-4};
  try {
    const original=await reader.read(request);
    const explicit=await reader.read({...request,streamlineMethod:"trilinear"});
    assert.equal(inputs.length,1);assert.equal(explicit.streamlines[0],original.streamlines[0]);
    const changed=await reader.read({...request,streamlineMethod:"trilinear-boundary"});
    assert.equal(inputs.length,2);assert.notEqual(changed.streamlines[0],original.streamlines[0]);
    assert.equal(changed.streamlines[0].method,"trilinear-boundary");
    assert.deepEqual(changed.streamlines[0].start,original.streamlines[0].start);
    const other={...f.seed,id:2,node:6},two={...request,streamlineMethod:"trilinear-boundary",streamlineSeeds:[f.seed,other]};
    const added=await reader.read(two);
    assert.equal(inputs.length,3);assert.equal(added.streamlines[0],changed.streamlines[0]);
    assert.deepEqual(inputs.at(-1).seeds.map(seed=>seed.id),[2]);assert.equal(inputs.at(-1).method,"trilinear-boundary");
    await reader.read({...two,streamlineTolerance:1e-5});
    assert.equal(inputs.length,4);assert.deepEqual(inputs.at(-1).seeds.map(seed=>seed.id),[1,2]);
    const restored=await reader.read({...request,streamlineMethod:"trilinear"});
    assert.equal(inputs.length,5);assert.equal(restored.streamlines[0].method,"trilinear");
    assert.deepEqual(restored.streamlines[0].start,original.streamlines[0].start);
  } finally {reader.close();}
});
