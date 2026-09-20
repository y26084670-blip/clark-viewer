import test from "node:test";
import assert from "node:assert/strict";
import { createResultFrameController, sameFrameContext } from "../src/services/results/resultFrameController.js";
import { readObjectFrames } from "../src/services/results/resultRequests.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const scheduled = new Map(), reads = [], states = [];
  let id = 0;
  const controller = createResultFrameController({
    publish: state => states.push(state),
    schedule: callback => { scheduled.set(++id, callback); return id; },
    cancel: id => scheduled.delete(id),
    load: request => new Promise((resolve, reject) => reads.push({ request, resolve, reject })),
  });
  const task = {};
  return { controller, reads, states, scheduled,
    request: (time, extra = {}) => controller.request({ task, time, quantityKey: "M", selected: [1, 2], budget: 5000, ...extra }),
    start() { for (const [id, callback] of scheduled) { scheduled.delete(id); void callback(); } },
    state: () => states.at(-1),
  };
}

test("time bursts keep the complete frame and read only the latest pending step", async () => {
  const h = harness();
  h.request(0); h.start(); h.reads[0].resolve("frame zero"); await tick();
  const zero = h.state().frame;
  h.request(1); h.start();
  for (let time = 2; time <= 100; time++) h.request(time);
  assert.equal(h.reads.length, 2);
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.state().frame, zero);
  assert.equal(h.state().requested.time, 100);
  assert.equal(h.state().loading, true);
  h.reads[1].resolve("obsolete"); await tick();
  assert.equal(h.state().frame, zero);
  h.start();
  assert.deepEqual(h.reads.map(read => read.request.time), [0, 1, 100]);
  h.reads[2].resolve("frame hundred"); await tick();
  assert.equal(h.state().frame.request.time, 100);
  assert.equal(h.state().frame.value, "frame hundred");
  assert.equal(h.state().loading, false);
});

test("requests before the next animation frame coalesce", async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.request(i);
  assert.equal(h.scheduled.size, 1);
  h.start(); assert.equal(h.reads.length, 1); assert.equal(h.reads[0].request.time, 99);
  h.reads[0].resolve(99); await tick();
  assert.equal(h.state().frame.value, 99);
});

test("task, quantity, selection and budget changes clear incompatible frames", async () => {
  for (const extra of [{task:{}}, {quantityKey:"H"}, {selected:[2]}, {budget:100}]) {
    const h = harness(); h.request(0); h.start(); h.reads[0].resolve(0); await tick();
    h.request(1, extra);
    assert.equal(h.state().frame, null);
    assert.equal(h.state().loading, true);
    h.controller.close();
  }
  const h = harness(); h.request(0); h.start(); h.reads[0].resolve(0); await tick();
  h.request(1, {selected:[2, 1]});
  assert.equal(h.state().frame.value, 0);
  assert.ok(sameFrameContext(h.state().frame.request, h.state().requested));
  h.controller.close();
});

test("current read errors retain the old labelled frame; obsolete errors are ignored", async () => {
  const h = harness(); h.request(0); h.start(); h.reads[0].resolve(0); await tick();
  h.request(1); h.start(); h.reads[1].reject(new Error("disk failure")); await tick();
  assert.equal(h.state().frame.request.time, 0);
  assert.equal(h.state().error, "disk failure"); assert.equal(h.state().loading, false);
  h.request(2); h.start(); h.request(3);
  h.reads[2].reject(new Error("obsolete failure")); await tick();
  assert.equal(h.state().error, ""); assert.equal(h.state().loading, true);
  h.start(); h.reads[3].resolve(3); await tick();
  assert.equal(h.state().frame.value, 3);
});

test("empty context cancels pending work; closing ignores an active completion", async () => {
  const h = harness(); h.request(0); h.controller.request(null);
  assert.equal(h.scheduled.size, 0); assert.equal(h.state().loading, false);
  h.request(1); h.start(); h.request(2); h.controller.close();
  const count = h.states.length;
  h.reads[0].resolve(1); await tick();
  h.request(3);
  assert.equal(h.states.length, count); assert.equal(h.scheduled.size, 0);
});

test("a failed frame drains its sibling HDF5 slices before releasing the queue", async () => {
  const base = { targ:0, rv:0, xapName:"steel", dp:[[1],[1],[1]], symLs:1, symAs:1, symPs:1, symKya:0, symKyp:0 };
  let finish;
  const task = { elements:[{...base,id:1},{...base,id:2}], regions:[],
    metadata:{MH:{steps:[0],header:{inds1:[1,2],numbs:[1,1]}}},
    reader:{read: ({start}) => start === 0 ? Promise.reject(new Error("slice error")) : new Promise(resolve => {finish=resolve;})} };
  let settled = false;
  const result = readObjectFrames({task,quantityKey:"M",selected:[1,2],time:0}).catch(error => {settled=true;return error;});
  await tick(); assert.equal(settled,false);
  finish({values:new Float64Array(9),stride:9,count:1,every:1});
  assert.match((await result).message,/slice error/); assert.equal(settled,true);
});

test("replacing a task during a read never publishes the previous task's response", async () => {
  const h = harness();
  h.request(0); h.start();
  const nextTask = {};
  h.request(4, {task:nextTask});
  h.reads[0].resolve("old task"); await tick();
  assert.equal(h.state().frame,null); assert.equal(h.state().requested.task,nextTask);
  h.start(); h.reads[1].resolve("new task"); await tick();
  assert.equal(h.state().frame.request.task,nextTask);
  assert.equal(h.state().frame.value,"new task");
});

test("line plot choices invalidate frames, but a time change retains the labelled curves", async () => {
  const context = {quantityKey:"Bs",component:"norm",direction:"i2",copy:0,allCopies:false};
  for (const changed of [{component:"0"},{direction:"i1"},{copy:1},{allCopies:true}]) {
    const h = harness();
    h.request(0, context); h.start(); h.reads[0].resolve({series:["initial curves"]}); await tick();
    const frame = h.state().frame;
    h.request(1, context);
    assert.equal(h.state().frame, frame);
    h.request(2, {...context,...changed});
    assert.equal(h.state().frame, null);
    h.start(); h.reads[1].resolve({series:["new context"]}); await tick();
    assert.equal(h.state().frame.request.time, 2);
    h.controller.close();
  }
});

test("line frame reads the selected local image and reports unavailable images", async () => {
  const {readLineFrame} = await import("../src/services/results/resultRequests.js");
  const records = [
    {id:1,name:"A",dp:[[1],[2]],symLs:2},
    {id:2,name:"B",dp:[[1],[2]],symLs:1},
  ];
  const reads=[];
  const task={regions:records,metadata:{HS:{steps:[0],header:{inds1:[1,5],numbs:[4,2]}}},
    reader:{read:async request=>{reads.push(request);return {stride:6,count:request.count,every:1,
      values:new Float64Array(Array.from({length:request.count},()=>[0,0,0,3,0,0]).flat())};}}};
  const request={task,quantityKey:"Bs",selected:[1,2],time:0,component:"0",direction:"i2",copy:1,allCopies:false};
  const result=await readLineFrame(request);
  assert.deepEqual(reads,[{name:"HS",step:0,start:2,count:2}]);
  assert.deepEqual(result.skipped,["№2"]);
  assert.equal(result.series.length,1);
  assert.deepEqual(result.series[0].points.map(p=>p.y),[3,3]);
  const unfolded=await readLineFrame({...request,allCopies:true});
  assert.deepEqual(unfolded.skipped,[]);
  assert.equal(unfolded.series.length,3);
});

test("a failed line image drains other regions before the next frame can start", async () => {
  const {readLineFrame} = await import("../src/services/results/resultRequests.js");
  let finish,settled=false;
  const task={regions:[1,2].map(id=>({id,name:String(id),dp:[[1],[2]],symLs:1})),
    metadata:{HS:{steps:[0],header:{inds1:[1,3],numbs:[2,2]}}},
    reader:{read:({start})=>start===0?Promise.reject(new Error("line read failure")):new Promise(resolve=>{finish=resolve;})}};
  const result=readLineFrame({task,quantityKey:"Bs",selected:[1,2],time:0,component:"norm",direction:"i2",copy:0,allCopies:false})
    .catch(error=>{settled=true;return error;});
  await tick();assert.equal(settled,false);
  finish({values:new Float64Array(12),stride:6,count:2});
  assert.match((await result).message,/line read failure/);
  assert.equal(settled,true);
});
