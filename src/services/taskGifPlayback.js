export function createTaskGifPlayback({publish,draw,
  workerFactory=()=>new Worker(new URL("../workers/taskGifDecode.worker.js",import.meta.url),{type:"module"}),
  now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout,
  requestFrame=callback=>requestAnimationFrame(callback),cancelFrame=id=>cancelAnimationFrame(id),
}) {
  let worker=null,timer=null,animation=null,deadline=0,remaining=0,startedAt=0;
  let frame=null,pending=null,inFlight=false,crossfade=false;
  let state={loading:false,playing:false,loop:false,ended:false,index:-1,count:0,error:""};
  const emit=()=>publish({...state});
  const canAdvance=()=>state.count>1&&(state.index<state.count-1||state.loop);
  function clearAnimation(){if(animation!==null)cancelFrame(animation);animation=null;}
  function clearTimer(){if(timer!==null)cancel(timer);timer=null;clearAnimation();}
  function close(){clearTimer();worker?.terminate();worker=null;frame=null;pending=null;inFlight=false;remaining=0;}
  function fail(error){close();state={...state,playing:false,loading:false,error:error.message||String(error)};emit();}
  function requestNext(reset=state.index===state.count-1) {
    if(!worker||inFlight||pending)return;
    inFlight=true;worker.postMessage({type:"next",reset});
  }
  function blend() {
    if(crossfade&&pending&&canAdvance())
      draw(frame,pending,Math.max(0,Math.min(1,(now()-startedAt)/frame.delay)));
  }
  function animate() {
    if(animation!==null||!crossfade||!state.playing||timer===null||!pending||!canAdvance())return;
    animation=requestFrame(()=>{
      animation=null;
      if(!state.playing||timer===null||!crossfade)return;
      try {blend();animate();}catch(error){fail(error);}
    });
  }
  function presentPending(start=now()) {
    const next=pending;pending=null;present(next,start);
  }
  function arm(target) {
    clearTimer();deadline=target;remaining=Math.max(0,target-now());
    timer=schedule(()=>{
      timer=null;remaining=0;clearAnimation();
      if(!state.playing||!worker)return;
      try {
        if(!canAdvance()){state.playing=false;state.ended=true;emit();return;}
        if(pending)presentPending(crossfade?deadline:now());
        else requestNext();
      }catch(error){fail(error);}
    },remaining);
    if(crossfade&&canAdvance())requestNext();
    animate();
  }
  function present(next,start=now()) {
    frame=next;startedAt=start;draw(frame);
    state={...state,loading:false,index:frame.index,count:frame.count,error:"",ended:frame.count===1};
    if(frame.count===1)state.playing=false;
    remaining=frame.delay;
    emit();if(state.playing)arm(start+frame.delay);
  }
  function open(url) {
    close();state={loading:true,playing:true,loop:false,ended:false,index:-1,count:0,error:""};emit();
    try {
      const current=worker=workerFactory();
      current.onmessage=({data})=>{
        if(worker!==current)return;
        inFlight=false;
        if(data.error){fail(new Error(data.error));return;}
        try {
          if(state.index<0)present(data);
          else {
            pending=data;
            if(state.playing&&timer===null&&remaining===0)presentPending(crossfade?deadline:now());
            else animate();
          }
        }catch(error){fail(error);}
      };
      current.onerror=event=>{if(worker===current)fail(new Error(event.message||"Не удалось декодировать GIF."));};
      inFlight=true;current.postMessage({type:"open",url});
    }catch(error){fail(error);}
  }
  function toggle() {
    if(!worker||state.loading||state.error||state.count<2)return;
    try {
      if(state.playing) {
        if(timer!==null){remaining=Math.max(0,deadline-now());blend();}
        clearTimer();state.playing=false;emit();return;
      }
      state.playing=true;
      if(state.ended) {
        state.ended=false;remaining=0;deadline=now();emit();
        if(pending)presentPending();else requestNext(true);
      } else {
        emit();
        if(remaining>0){startedAt=now()-(frame.delay-remaining);arm(now()+remaining);}
        else if(pending)presentPending();
        else deadline=now(); // An existing decode request will resume here.
      }
    }catch(error){fail(error);}
  }
  function setLoop(value) {
    state.loop=!!value;emit();
    try {
      if(crossfade&&frame) {
        if(canAdvance()){requestNext();animate();}
        else {clearAnimation();draw(frame);}
      }
    }catch(error){fail(error);}
  }
  function setCrossfade(value) {
    if(crossfade===!!value)return;
    crossfade=!!value;
    try {
      if(crossfade&&frame){if(canAdvance())requestNext();animate();}
      else {clearAnimation();if(frame)draw(frame);}
    }catch(error){fail(error);}
  }
  return {open,toggle,setLoop,setCrossfade,dispose:close};
}
