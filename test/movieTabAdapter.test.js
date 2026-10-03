import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// Solid's default Node entry is nonreactive SSR. Run the production adapter
// against its browser-condition signal scheduler, without a browser or DOM.
const harness = `
  import assert from 'node:assert/strict';
  import {createRoot,createSignal} from 'solid-js';
  import {createMovieTabAdapter,completedMovieFrame} from './src/services/movie/movieTabAdapter.js';
  import {createRenderedFrameGate} from './src/services/movie/renderedFrameGate.js';
  const tick=()=>new Promise(resolve=>queueMicrotask(resolve));
  function fixture() {
    const gate=createRenderedFrameGate(), events=[], waitKeys=[];
    let dispose,adapter,onCaptureReady,activeRequest,publishState,requestTime,readTime,readTask,changeTask;
    const renderer={
      prepare(){events.push(['prepare']);},
      renderReady:(key,options)=>{waitKeys.push(key);return gate.wait(key,options);},
      capture(key){assert.equal(gate.current,key);events.push(['capture',key.request.time]);return {data:new Uint8ClampedArray(4),width:1,height:1};},
      restore(){events.push(['restore']);},
    };
    createRoot(cleanup=>{
      dispose=cleanup;
      const [task,setTask]=createSignal({general:{countTimeSteps:2,timeStep:.1}});
      const [time,setTime]=createSignal(2),[state,setState]=createSignal({});
      readTime=time;readTask=task;changeTask=setTask;publishState=setState;
      requestTime=index=>{
        events.push(['time',index]);setTime(index);activeRequest={task:task(),time:index};
        setState({requested:activeRequest,frame:null,loading:true,error:''});
      };
      requestTime(2);
      const connection=createMovieTabAdapter({
        get task(){return task();},get time(){return time();},setMovieTime:requestTime,
        registerMovieAdapter:value=>{adapter=value;return()=>events.push(['unregister']);},
      },{title:'Test plot',readFrame:index=>completedMovieFrame(state(),{task:task(),index})});
      onCaptureReady=connection.onCaptureReady;
    });
    onCaptureReady(renderer);
    const publish=(overrideRequest)=>{
      const frame={request:overrideRequest??activeRequest,value:{step:activeRequest.time}};
      publishState({requested:activeRequest,frame,loading:false,error:''});return frame;
    };
    const render=frame=>{events.push(['render',frame.request.time]);gate.rendered(frame);};
    return {adapter,gate,events,waitKeys,publish,render,dispose,time:readTime,task:readTask,
      request:()=>activeRequest,
      replaceTask(){changeTask({general:{countTimeSteps:5,timeStep:.2}});requestTime(0);},
      async prepare(){const key=publish();render(key);await adapter.prepare();return key;},
    };
  }
`;
function run(body) {
  const output = execFileSync(process.execPath, ["--conditions=browser", "--input-type=module", "-e", harness + body],
    { cwd: new URL("../", import.meta.url), encoding: "utf8", stdio: "pipe", timeout: 10_000 });
  assert.equal(output, "");
}

test("tab movie capture waits for both exact data request and rendered publication identity", () => run(`
  const h=fixture();
  try {
    const initial=h.publish();let prepared=false;
    const preparation=h.adapter.prepare().then(()=>prepared=true);
    await tick();assert.equal(prepared,false);
    h.render({...initial});await tick();assert.equal(prepared,false,'equal time is not equal rendered publication');
    h.render(initial);await preparation;
    let captured=false;
    const capture=h.adapter.capture(0).then(()=>captured=true);
    await tick();assert.equal(h.time(),0);assert.equal(captured,false);
    const wrong=h.publish({...h.request()});h.render(wrong);await tick();
    assert.equal(captured,false,'frame.request must equal state.requested, not just carry the same index');
    const frame=h.publish();await tick();assert.equal(captured,false,'data publication alone cannot prove a draw');
    h.render({...frame});await tick();assert.equal(captured,false);
    h.render(frame);await capture;
    assert.deepEqual(h.events.filter(e=>e[0]==='capture'),[['capture',0]]);
  } finally {h.dispose();}
`));

test("tab captures sequential requested steps and awaits the original rendered frame before releasing view locks", () => run(`
  const h=fixture();
  try {
    await h.prepare();
    const frames=[];
    for(let index=0;index<3;index++) {
      const capture=h.adapter.capture(index);await tick();
      assert.equal(h.time(),index);
      assert.equal(h.events.filter(e=>e[0]==='capture').length,index);
      const key=h.publish();await tick();h.render(key);await capture;frames.push(key);
    }
    assert.deepEqual(h.events.filter(e=>e[0]==='capture').map(e=>e[1]),[0,1,2]);
    const restore=h.adapter.restore(2);await tick();
    assert.equal(h.time(),2);assert.equal(h.events.some(e=>e[0]==='restore'),false);
    const original=h.publish();await tick();
    assert.equal(h.events.some(e=>e[0]==='restore'),false,'restored data must be drawn before view unlock');
    h.render(original);await restore;
    assert.deepEqual(h.events.slice(-2),[['render',2],['restore']]);
    await h.adapter.restore(2);
    assert.equal(h.events.filter(e=>e[0]==='restore').length,1,'restore is idempotent');
  } finally {h.dispose();}
`));

test("WebGL failure rejects pending capture while restoration still releases renderer state in finally", () => run(`
  const h=fixture();
  try {
    await h.prepare();
    const capture=h.adapter.capture(0), failure=assert.rejects(capture,/WebGL lost/);
    await tick();h.publish();await tick();h.gate.fail(new Error('WebGL lost'));await failure;
    assert.equal(h.events.some(e=>e[0]==='capture'),false);
    const restore=h.adapter.restore(2), restorationFailure=assert.rejects(restore,/WebGL lost/);
    await tick();h.publish();await restorationFailure;
    assert.equal(h.time(),2);
    assert.equal(h.events.filter(e=>e[0]==='restore').length,1);
  } finally {h.dispose();}
`));

test("replacing the task skips old-time requests and awaits no new-task frame while restoring the old renderer", () => run(`
  const h=fixture();
  try {
    await h.prepare();const oldTask=h.task();
    h.replaceTask();assert.notEqual(h.task(),oldTask);assert.equal(h.time(),0);
    const count=h.events.length;
    await h.adapter.restore(2);
    assert.equal(h.time(),0,'old task time must not be written into the replacement task');
    assert.deepEqual(h.events.slice(count),[['restore']]);
  } finally {h.dispose();}
`));

test("early renderer registration turns initialization errors into rejected preparation without freezing", () => run(`
  const h=fixture();
  try {
    h.publish();
    const preparation=h.adapter.prepare(), failure=assert.rejects(preparation,/WebGL initialization/);
    await tick();h.gate.fail(new Error('WebGL initialization'));await failure;
    assert.equal(h.events.some(e=>e[0]==='prepare'),false);
    await h.adapter.restore(2);
    assert.equal(h.events.some(e=>e[0]==='restore'),false);
  } finally {h.dispose();}
`));

test("task replacement during restored-frame rendering aborts the old waiter and releases renderer state exactly once", () => run(`
  const h=fixture();
  try {
    await h.prepare();
    const restore=h.adapter.restore(2);
    const aborted=assert.rejects(restore,{name:'AbortError'});
    await tick();
    const original=h.publish();await tick();
    assert.equal(h.waitKeys.at(-1),original,'restoration has reached the old renderer gate');
    assert.equal(h.events.some(e=>e[0]==='restore'),false);
    h.replaceTask();
    await aborted;
    assert.equal(h.time(),0,'the replacement task keeps its own selected time');
    assert.equal(h.events.filter(e=>e[0]==='restore').length,1);
    h.render(original);await tick();
    assert.equal(h.events.filter(e=>e[0]==='restore').length,1,'a late old render cannot repeat restoration');
  } finally {h.dispose();}
`));
