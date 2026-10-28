import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import h5wasm from "h5wasm/node";
import { readWorkResidualFrames } from "../src/services/results/workResiduals.js";
import { createResultLayerReader } from "../src/services/results/resultLayerRequests.js";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { QUANTITIES, sourceRecords } from "../src/services/results/resultMappings.js";
import { scalarScene } from "../src/services/results/resultPlots.js";

const material = { id: 1, recordIndex: 0, targ: 0, model: 0, xapName: "steel", rv: 1,
  dp: [[2],[1],[1]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
const metadata = { header: { columns: 1, arrCount: 1, hasCoo: true, stride: 4, inds1: [1], numbs: [2] },
  steps: [{ key: "000000", index: 0 }], pointCount: 2 };

test("read files produced by Solver's real Parallel HDF5 test", { skip: !process.env.CLARK_RESIDUAL_TEST_OUTPUT }, async () => {
  await h5wasm.ready;
  for (const [precision,Type] of [["Float32",Float32Array],["Float64",Float64Array]]) {
    for (const name of ["MH_work","JE_work"]) {
      const path=join(process.env.CLARK_RESIDUAL_TEST_OUTPUT,`${name}_${precision}.h5`);
      const reader=new Hdf5ResultFile(name,new h5wasm.File(path,"r"));
      try {
        assert.equal(reader.metadata.pointCount,9);
        const frame=reader.read({step:0,start:0,count:9});
        assert.ok(frame.values instanceof Type);
        assert.deepEqual(Array.from(frame.values),Array.from({length:9},(_,i)=>[i+1,2*(i+1),-(i+1),401+i]).flat());
      } finally { reader.close(); }
    }
  }
});

test("each selection reopens the current work file and uses the single snapshot at any slider time", async () => {
  let version = 0, closed = 0;
  const reads = [], opened = [];
  const task = { elements: [material], metadata: {}, reader: { read() { throw new Error("ordinary reader used"); } },
    handle: { async getDirectoryHandle(name) {
      assert.equal(name,"output3XX");
      return { async getFileHandle(name) { assert.equal(name,"MH_work.h5"); return { async getFile() { return { version: ++version }; } }; } };
    } } };
  const readerFactory = () => {
    let file;
    return { async open(files) { file = files.MH_work; opened.push(file); return { MH_work: metadata }; },
      async read(request) { reads.push(request); return { stride: 4, start: 0, count: 2,
        values: new Float64Array([1,2,3,file.version,4,5,6,file.version+10]) }; },
      close() { closed++; } };
  };
  for (const time of [97,0,42]) {
    const frames = await readWorkResidualFrames({ task, quantityKey: "MResidual", selected: [1], time }, { readerFactory });
    assert.equal(frames[0].frame.values[3], version);
  }
  assert.equal(opened.length,3); assert.equal(closed,3);
  assert.deepEqual(reads.map(read=>read.step),[0,0,0]);
  assert.deepEqual(task.metadata,{});
});

test("missing and damaged work files report errors and release their reader", async () => {
  const absent = { handle: { async getDirectoryHandle() { throw Object.assign(new Error(),{name:"NotFoundError"}); } } };
  await assert.rejects(readWorkResidualFrames({ task: absent, quantityKey: "JResidual" }),/Запросите запись/);
  let closed = false;
  const task = { elements: [material], handle: { async getDirectoryHandle() { return {
    async getFileHandle() { return { async getFile() { return {}; } }; } }; } } };
  await assert.rejects(readWorkResidualFrames({ task, quantityKey: "JResidual", selected: [1] },
    { readerFactory: () => ({ async open() { return { JE_work: { error: "damaged snapshot" } }; }, close() { closed=true; } }) }), /damaged snapshot/);
  assert.ok(closed);
});

test("work layers select unknowns only and display saved scalar nodes even at maximum map size", async () => {
  const task = { elements: [material,{ ...material,id:2,targ:1 },{ ...material,id:3,targ:2 }] };
  assert.deepEqual(sourceRecords(task,"MH_work"),[material]);
  assert.deepEqual(sourceRecords(task,"JE_work"),[material]);
  const requests=[];
  const reader=createResultLayerReader({ processorFactory() { throw new Error("volume interpolation used"); },
    async residualReader(request) { requests.push(request); return [{ record: material, originalCount: 2,
      frame: { start:0, stride:4, count:2, values: new Float64Array([7,8,9,5,10,11,12,13]) } }]; } });
  try {
    const result=await reader.read({ task,time:99,layers:[{ key:"elements",quantityKey:"MResidual",selected:[1,2,3],volumeMode:true }] });
    assert.equal(result.layers[0].state,"ready");
    assert.deepEqual(requests[0].selected,[1]);
    assert.deepEqual(result.layers[0].scalarScene.points.map(p=>[...p.origin,p.value]),[[7,8,9,5],[10,11,12,13]]);
    assert.equal(result.layers[0].scalarScene.unit,"кА/м");
    await reader.read({ task,layers:[{ key:"elements",quantityKey:"JResidual",selected:[2,3] }] });
    assert.equal(requests.length,1);
  } finally { reader.close(); }
});

for (const Type of [Float32Array,Float64Array]) test(`actual HDF5 work schema, coordinates and scalars ${Type.name}`, async () => {
  await h5wasm.ready;
  const directory=await mkdtemp(join(tmpdir(),"clark-residual-"));
  try {
    for (const key of ["MResidual","JResidual"]) {
      const quantity=QUANTITIES[key],path=join(directory,`${quantity.file}.h5`);
      const handle=new h5wasm.File(path,"w"),header=handle.create_group("HEADER");
      for (const [name,value] of Object.entries({ columns:1n,arrCount:1n,hasCoo:1n })) {
        header.create_dataset({ name,data:new BigInt64Array([value]),shape:[] });
      }
      header.create_dataset({ name:"inds1",data:new BigInt64Array([1n]) });
      header.create_dataset({ name:"numbs",data:new BigInt64Array([2n]) });
      handle.create_dataset({ name:"000000",data:new Type([1,2,3,5,4,5,6,13]),shape:[2,4] });
      handle.close();
      const file=new Hdf5ResultFile(quantity.file,new h5wasm.File(path,"r"));
      try {
        const frame=file.read({ step:0,start:0,count:2 });
        assert.ok(frame.values instanceof Type);
        const scene=scalarScene([{ frame,record:material }],quantity);
        assert.deepEqual(scene.points.map(p=>[...p.origin,p.value]),[[1,2,3,5],[4,5,6,13]]);
      } finally { file.close(); }
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});
