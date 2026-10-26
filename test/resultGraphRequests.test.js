import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createResultGraphReader } from "../src/services/results/resultGraphRequests.js";
import { createResultGraphProcessor } from "../src/services/results/resultGraphProcessor.js";
import { calculateResultGraphs, graphSurfaceDomain } from "../src/services/visualization/resultGraphField.js";
import { graph3DTask } from "../scripts/test-support/graph3DFixture.js";

const options = { processorFactory: () => ({ process: async input => calculateResultGraphs(input), close() {} }) };
const request = f => ({ task: f.task, axes: [f.axis], time: 0, method: "trilinear", quantities: { elements: "J", regions: "Bs", virtual: "none" } });
const close = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test("all streamline methods reproduce an affine field along an arbitrary oblique segment, with one strided image read", async () => {
  for (const method of ["trilinear", "trilinear-boundary", "quadratic", "tricubic"]) {
    const f = graph3DTask(), reader = createResultGraphReader(options);
    const result = (await reader.read({ ...request(f), method, axes: [{ ...f.axis, instance: { ...f.axis.instance, ps: 1 } }] }))[0];
    assert.equal(result.error, undefined, method); assert.equal(f.reads.length, 1); assert.equal(f.reads[0].every, 2); assert.equal(f.reads[0].start, 1);
    close(result.distances[0], 0); close(result.distances.at(-1), result.length);
    for (let i = 0; i < result.distances.length; i++) {
      const t = i / (result.distances.length - 1), p = result.start.map((v,k) => v * (1-t) + result.end[k] * t);
      close(result.values[i*3], p[0]); close(result.values[i*3+1], 2*p[1]); close(result.values[i*3+2], -p[2]);
    }
    reader.close();
  }
});

test("nodal observation surfaces use the same reconstruction methods without treating nodes as cell centres", async () => {
  for (const method of ["trilinear", "trilinear-boundary", "quadratic", "tricubic"]) {
    const f = graph3DTask(), reader = createResultGraphReader(options);
    const axis = { ...f.axis, source: { schemaId: "regions", recordIndex: 0 }, points: [0,19] };
    const result = (await reader.read({ ...request(f), axes: [axis], method }))[0];
    assert.equal(result.error, undefined, method); assert.deepEqual(result.start, [0,40,0]); assert.deepEqual(result.end, [40,60,0]);
    for (let i = 0; i < result.distances.length; i++) { const t = i / (result.distances.length - 1); close(result.values[i*3],40*t); close(result.values[i*3+1],80+40*t); }
    reader.close();
  }
});

test("building caches unchanged axes and invalidates changed endpoints, time, method and quantity", async () => {
  const f = graph3DTask(), reader = createResultGraphReader(options), r = request(f);
  const first = await reader.read(r); await reader.read(r); assert.equal(f.reads.length, 1);
  const second = { ...f.axis, id: 2, points: [1,20] };
  const both = await reader.read({ ...r, axes: [f.axis,second] }); assert.equal(f.reads.length, 2); assert.equal(both[0], first[0]);
  await reader.read({ ...r, axes: [{ ...f.axis, points: [2,21] }] }); assert.equal(f.reads.length, 3);
  await reader.read({ ...r, time: 1 }); assert.equal(f.reads.length, 4);
  await reader.read({ ...r, time: 1, method: "tricubic" }); assert.equal(f.reads.length, 5);
  const scalar = (await reader.read({ ...r, quantities: { ...r.quantities, elements: "JEdot" } }))[0];
  assert.equal(scalar.components, 1); assert.equal(f.reads.length, 6);
  close(scalar.values[0], (2*scalar.start[0]-2*scalar.start[1]-.5*scalar.start[2])*.001);
  reader.close();
});

test("mirrors transform vector components and preserve the clicked image, including magnetic versus electric parity", async () => {
  const f = graph3DTask({ mirror: 0 }), reader = createResultGraphReader(options);
  const axis = { ...f.axis, instance: { ...f.axis.instance, mirrorX: 1 } };
  const result = (await reader.read({ ...request(f), axes: [axis] }))[0]; assert.equal(result.error, undefined);
  close(result.start[0], -5); close(result.values[0], 5); close(result.values[1], -20/3); close(result.values[2], 2.5);
  reader.close();
});

test("missing steps and malformed slices report errors and cannot reuse stale curves", async () => {
  const f = graph3DTask(), reader = createResultGraphReader(options), r = request(f);
  await reader.read(r);
  const missing = (await reader.read({ ...r, time: 9 }))[0]; assert.match(missing.error, /Нет сохранённого момента/); assert.equal(f.reads.length, 1);
  const read = f.task.reader.read; f.task.reader.read = async r => ({ ...await read(r), count: 1 });
  const malformed = (await reader.read({ ...r, time: 1 }))[0]; assert.match(malformed.error, /Неполная сетка/); reader.close();
});

test("real graph worker transfers results while preserving the source HDF-style buffers, and closes cleanly", async () => {
  const url = new URL("../src/workers/resultGraph.worker.js",import.meta.url).href;
  const worker = new Worker(`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(d,t)=>parentPort.postMessage(d,t)};import(${JSON.stringify(url)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`,{eval:true});
  let bridge;
  const reader = createResultGraphReader({ processorFactory: () => createResultGraphProcessor({ workerFactory: () => {
    bridge = { postMessage: (d,t) => worker.postMessage(d,t), terminate: () => worker.terminate() };
    worker.on("message", data => bridge.onmessage?.({data})); worker.on("error", e => bridge.onerror?.(e)); return bridge;
  } }) });
  const f = graph3DTask(); try {
    const result = (await reader.read(request(f)))[0]; assert.equal(result.error, undefined);
    assert.ok(result.values instanceof Float64Array); assert.ok(result.distances instanceof Float64Array);
    assert.equal(f.buffers.JE[0].length, 2*4*3*2*2*9);
  } finally { reader.close(); }
});

test("quadratic reconstruction follows a known curved field rather than a straight interpolation of the endpoints", async () => {
  const field = ([x,y,z]) => [x*x+y*z, y*y-x*z, z*z+x*y];
  const f = graph3DTask({ dimensions: [6,5,4], field }), reader = createResultGraphReader(options);
  try {
    const result = (await reader.read({ ...request(f), method: "quadratic" }))[0];
    assert.equal(result.error, undefined);
    for (let i=0; i<result.distances.length; i++) {
      const t=result.distances[i]/result.length, expected=field(result.start.map((v,k)=>v*(1-t)+result.end[k]*t));
      expected.forEach((v,c)=>close(result.values[i*3+c],v,1e-6));
    }
  } finally { reader.close(); }
});

test("line regions keep their endpoint nodes for all four interpolation methods", () => {
  const start=[2,3,4], end=[22,13,9], dimensions=[1,5,1];
  const positions=Float64Array.from(Array.from({length:5},(_,n)=>start.map((v,k)=>v+(end[k]-v)*n/4)).flat());
  const vectors=Float64Array.from(positions,v=>v*2);
  const domain={...graphSurfaceDomain([start,end],dimensions,true),key:"line",positions,vectors,invalid:new Uint8Array(5)};
  for(const method of ["trilinear","trilinear-boundary","quadratic","tricubic"]) {
    const [result]=calculateResultGraphs({domains:[domain],axes:[{key:"line",start,end,components:3}],method});
    assert.equal(result.error,undefined,method);
    for(let i=0;i<result.distances.length;i++) for(let c=0;c<3;c++) close(result.values[i*3+c],2*(start[c]+(end[c]-start[c])*i/(result.distances.length-1)));
  }
});

test("undefined conductivity creates gaps, never fictitious zeros in the plotted scalar", async () => {
  const f=graph3DTask({images:1,dimensions:[12,1,1],field:()=>[1,0,0]});
  f.task.elements[0].model=2;
  const handle={getDirectoryHandle:async()=>handle,getFileHandle:async()=>({getFile:async()=>({text:async()=>JSON.stringify({j_gmin:1})})})};
  f.task.handle=handle; f.buffers.JE[0].fill(0,5*9+6,5*9+9);
  const reader=createResultGraphReader(options);
  try { for(const method of ["trilinear","trilinear-boundary","quadratic","tricubic"]) {
    const [result]=await reader.read({...request(f),method,quantities:{elements:"sigmaRelative"}});
    assert.equal(result.error,undefined,method); assert.ok(result.values.some(Number.isNaN),method);
    assert.ok(Number.isFinite(result.values[0]),method); assert.ok(Number.isFinite(result.values.at(-1)),method);
    assert.ok([...result.values].filter(Number.isFinite).every(v=>v>0),method);
  } } finally {reader.close();}
});

test("closing a reader during a pending file read rejects without starting interpolation", async () => {
  const f=graph3DTask(), original=f.task.reader.read; let release, processed=false;
  f.task.reader.read=r=>new Promise(resolve=>{release=async()=>resolve(await original(r));});
  const reader=createResultGraphReader({processorFactory:()=>({process(){processed=true;},close(){}})});
  const pending=reader.read(request(f)); reader.close(); await release();
  await assert.rejects(pending,{name:"AbortError"}); assert.equal(processed,false);
});
