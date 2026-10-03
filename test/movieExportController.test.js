import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createMovieExportController } from "../src/services/movie/movieExportController.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const pixels = value => ({ width: 2, height: 1, data: new Uint8ClampedArray([value, 0, 0, 255, value, 0, 0, 255]) });

function harness({ frameCount = 3, encoder = {}, adapter: changes = {}, limits } = {}) {
  const events = [], task = {}, originalTime = frameCount - 1;
  let time = originalTime, frozen = false, closed = 0;
  const adapter = {
    getContext: () => ({ task, title: "Поле", frameCount, originalTime: time, timeStep: .25, filenamePrefix: "areas" }),
    async prepare() { events.push("prepare"); frozen = true; },
    async capture(index, options) { events.push(["capture", index, options.caption]); time = index; return pixels(index); },
    async restore(index) { events.push(["restore", index]); time = index; frozen = false; },
    ...changes,
  };
  const controller = createMovieExportController({ limits, createEncoder: () => ({
    async addFrame(image, { delayMs }) { events.push(["encoded", image.data[0], delayMs]); },
    async finish() { events.push("finish"); return new Blob(["GIF89a"], { type: "image/gif" }); },
    close() { closed++; events.push("close"); }, ...encoder,
  }) });
  const unregister = controller.register(adapter);
  return { controller, adapter, unregister, events, originalTime, frozen: () => frozen, time: () => time, closed: () => closed };
}

test("movie captures every requested step exactly once and waits for each encoding before advancing", async () => {
  const gates = [], h = harness({ encoder: { addFrame(image, options) {
    const gate = deferred(); gates.push({ image, options, ...gate }); return gate.promise;
  } } });
  const progress = [];
  const result = h.controller.run({ intervalMs: 120, onProgress: value => progress.push(value) });
  await tick();
  assert.equal(gates.length, 1); assert.equal(h.time(), 0); assert.equal(h.frozen(), true);
  gates[0].resolve(); await tick(); assert.equal(gates.length, 2); assert.equal(h.time(), 1);
  gates[1].resolve(); await tick(); assert.equal(gates.length, 3); assert.equal(h.time(), 2);
  gates[2].resolve(); const gif = await result;
  assert.deepEqual(h.events.filter(event => Array.isArray(event) && event[0] === "capture").map(event => event[1]), [0, 1, 2]);
  assert.ok(gates.every(gate => gate.options.delayMs === 120));
  assert.match(h.events.find(event => Array.isArray(event) && event[1] === 1)[2], /t = 0.25 с/);
  assert.match(gif.filename, /^areas_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.gif$/); assert.equal(gif.frameCount, 3);
  assert.equal(gif.width, 2); assert.equal(gif.height, 1); assert.equal(gif.blob.type, "image/gif");
  assert.equal(h.time(), h.originalTime); assert.equal(h.frozen(), false); assert.equal(h.closed(), 1);
  assert.equal(progress.at(-1).phase, "restoring"); assert.equal(progress.at(-1).completed, 3);
});

test("a missing or failed frame is never replaced by a preceding capture, and restores the original view", async () => {
  const h = harness({ adapter: { async capture(index) {
    if (index === 1) throw new Error("MH.h5: нет данных для момента 1");
    return pixels(index);
  } } });
  await assert.rejects(h.controller.run({ intervalMs: 100 }), /MH.h5: нет данных для момента 1/);
  assert.deepEqual(h.events.filter(event => Array.isArray(event) && event[0] === "encoded"), [["encoded", 0, 100]]);
  assert.equal(h.time(), h.originalTime); assert.equal(h.frozen(), false); assert.equal(h.closed(), 1);
  assert.equal(h.events.filter(event => Array.isArray(event) && event[0] === "restore").length, 1);
});

test("abort while waiting for a frame restores promptly and cannot capture subsequent steps", async () => {
  const waiting = deferred(); let captures = 0;
  const h = harness({ adapter: { capture() { captures++; return waiting.promise; } } });
  const abort = new AbortController();
  const result = h.controller.run({ intervalMs: 100, signal: abort.signal });
  await tick(); abort.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(h.frozen(), false); assert.equal(h.time(), h.originalTime); assert.equal(captures, 1);
  waiting.resolve(pixels(0)); await tick(); assert.equal(captures, 1);
});

test("unregister aborts an active encoder, while a stale unregister cannot remove a replacement adapter", async () => {
  const pending = deferred(); let closes = 0;
  const h = harness({ encoder: { addFrame: () => pending.promise,
    close() { closes++; pending.reject(Object.assign(new Error("stopped"), { name: "AbortError" })); } } });
  const result = h.controller.run({ intervalMs: 100 });
  await tick(); h.unregister();
  await assert.rejects(result, { name: "AbortError" });
  assert.ok(closes >= 1); assert.equal(h.frozen(), false);
  await assert.rejects(h.controller.run({ intervalMs: 100 }), /текущей вкладки/);
  const states = [], controller = createMovieExportController({ createEncoder: () => {}, onAdapterChange: value => states.push(value) });
  const first = {}, second = {};
  const removeFirst = controller.register(first); controller.register(second); removeFirst();
  assert.equal(states.at(-1), second); controller.dispose(); assert.equal(states.at(-1), null);
});

test("frame and interval limits fail before preparation; pixel and output limits still restore after preparation", async () => {
  const many = harness({ frameCount: 2001 });
  await assert.rejects(many.controller.run({ intervalMs: 100 }), /2000 кадров/); assert.deepEqual(many.events, []);
  const interval = harness();
  await assert.rejects(interval.controller.run({ intervalMs: 55 }), /шагом 10/); assert.deepEqual(interval.events, []);
  const large = harness({ adapter: { capture: async () => ({ width: 1281, height: 1, data: new Uint8ClampedArray(1281 * 4) }) } });
  await assert.rejects(large.controller.run({ intervalMs: 100 }), /1280×960/); assert.equal(large.frozen(), false);
  const output = harness({ limits: { outputBytes: 5 } });
  await assert.rejects(output.controller.run({ intervalMs: 100 }), /Размер GIF/); assert.equal(output.frozen(), false);
});

test("a resized frame, encoder failure and an observer exception do not strand frozen controls", async () => {
  const resized = harness({ adapter: { capture: async index => index ? { width: 1, height: 1, data: new Uint8ClampedArray(4) } : pixels(0) } });
  await assert.rejects(resized.controller.run({ intervalMs: 100 }), /Размер кадра изменился/); assert.equal(resized.frozen(), false);
  const broken = harness({ encoder: { finish: async () => { throw new Error("encoder failed"); } } });
  await assert.rejects(broken.controller.run({ intervalMs: 100 }), /encoder failed/); assert.equal(broken.frozen(), false);
  const observer = harness();
  await observer.controller.run({ intervalMs: 100, onProgress() { throw new Error("observer failed"); } });
  assert.equal(observer.frozen(), false);
});

test("cancel during restoration suppresses the completed GIF and keeps restoration awaited", async () => {
  const restore = deferred();
  const h = harness({ adapter: { restore: () => restore.promise } });
  const abort = new AbortController(); let restoring = false;
  const run = h.controller.run({ intervalMs: 100, signal: abort.signal, onProgress: progress => { restoring ||= progress.phase === "restoring"; } });
  await tick(); assert.equal(restoring, true);
  abort.abort(); restore.resolve(); await assert.rejects(run, { name: "AbortError" });
});

test("real Solid readiness observes exact asynchronous request identity and disposes after success or abort", () => {
  execFileSync(process.execPath, ["--conditions=browser", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {createRoot,createSignal} from 'solid-js';
    import {useAsyncResult} from './src/services/results/resultRequests.js';
    import {waitForMovieCondition} from './src/services/movie/movieWait.js';
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    let dispose,setTime,result; const pending=[]; const task={};
    createRoot(cleanup=>{
      dispose=cleanup; const [time,change]=createSignal(0);setTime=change;
      result=useAsyncResult(()=>({task,time:time()}),request=>new Promise((resolve,reject)=>pending.push({request,resolve,reject})));
    });
    await tick(); pending[0].resolve('zero'); await tick();
    assert.equal(result.state().frame.request.time,0);
    let settled=false,observations=0;
    const target=waitForMovieCondition(()=>{
      observations++;const state=result.state();
      return {ready:!state.loading&&state.frame?.request.time===2,value:state.frame,error:state.requested?.time===2?state.error:''};
    }).then(value=>{settled=true;return value;});
    setTime(1);await tick();setTime(2);await tick();
    pending[1].resolve('obsolete');await tick();assert.equal(settled,false);
    pending[2].resolve('two');const frame=await target;
    assert.equal(frame.request.time,2);assert.equal(frame.value,'two');assert.equal(result.value(),'two');
    const observed=observations;setTime(3);await tick();assert.equal(observations,observed,'resolved observer must be disposed');
    const abort=new AbortController();let abortedReads=0;
    const waiting=waitForMovieCondition(()=>{abortedReads++;return {ready:false,value:result.state()};},{signal:abort.signal});
    abort.abort();await assert.rejects(waiting,{name:'AbortError'});const old=abortedReads;
    pending[3].resolve('three');await tick();assert.equal(abortedReads,old,'aborted observer must be disposed');
    const failed=waitForMovieCondition(()=>({ready:false,error:'failed frame'}));await assert.rejects(failed,/failed frame/);
    setTime(4);await tick();pending[4].reject(new Error('read failed'));await tick();
    assert.equal(result.state().requested.time,4);assert.equal(result.state().frame,null);assert.equal(result.error(),'read failed');
    dispose();
  `], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});
