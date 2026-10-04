export function createTaskGifPlayback({publish,draw,
  workerFactory=()=>new Worker(new URL("../workers/taskGifDecode.worker.js",import.meta.url),{type:"module"}),
  now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout,
}) {
  let worker=null,timer=null,deadline=0,remaining=0,pending=null;
  let state={loading:false,playing:false,loop:false,ended:false,index:-1,count:0,error:""};
  const emit=()=>publish({...state});
  function clearTimer(){if(timer!==null)cancel(timer);timer=null;}
  function close(){clearTimer();worker?.terminate();worker=null;pending=null;}
  function fail(error){close();state={...state,playing:false,loading:false,error:error.message||String(error)};emit();}
  function arm(delay) {
    clearTimer();remaining=delay;deadline=now()+delay;
    timer=schedule(()=>{
      timer=null;remaining=0;
      if(!state.playing||!worker)return;
      if(state.index===state.count-1&&!state.loop){state.playing=false;state.ended=true;emit();return;}
      worker.postMessage({type:"next",reset:state.index===state.count-1});
    },delay);
  }
  function present(frame) {
    draw(frame);
    state={...state,loading:false,index:frame.index,count:frame.count,error:"",ended:frame.count===1};
    if(frame.count===1)state.playing=false;
    remaining=frame.delay;
    emit();if(state.playing)arm(remaining);
  }
  function open(url) {
    close();state={loading:true,playing:true,loop:false,ended:false,index:-1,count:0,error:""};emit();
    try {
      const current=worker=workerFactory();
      current.onmessage=({data})=>{
        if(worker!==current)return;
        if(data.error){fail(new Error(data.error));return;}
        try {if(state.playing||state.index<0)present(data);else pending=data;}catch(error){fail(error);}
      };
      current.onerror=event=>{if(worker===current)fail(new Error(event.message||"Не удалось декодировать GIF."));};
      current.postMessage({type:"open",url});
    }catch(error){fail(error);}
  }
  function toggle() {
    if(!worker||state.loading||state.error||state.count<2)return;
    if(state.playing) {
      if(timer!==null)remaining=Math.max(0,deadline-now());
      clearTimer();state.playing=false;emit();return;
    }
    state.playing=true;emit();
    if(state.ended){state.ended=false;worker.postMessage({type:"next",reset:true});}
    else if(pending){const frame=pending;pending=null;try{present(frame);}catch(error){fail(error);}}
    else if(remaining>0)arm(remaining);
    // Otherwise one decode request is already in flight; do not request twice.
  }
  return {open,toggle,setLoop(value){state.loop=!!value;emit();},dispose:close};
}
