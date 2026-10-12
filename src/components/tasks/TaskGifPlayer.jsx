import { createEffect,createSignal,onCleanup,Show } from "solid-js";
import { createTaskGifPlayback } from "../../services/taskGifPlayback.js";

export function TaskGifPlayer(props) {
  let canvas;
  const [state,setState]=createSignal({loading:true,playing:false,loop:false,count:0,index:-1,error:""});
  let surfaces=[];
  function surface(frame,slot) {
    if(surfaces[slot]?.frame===frame)return surfaces[slot].canvas;
    const buffer=surfaces[slot]?.canvas||document.createElement("canvas");
    if(buffer.width!==frame.width)buffer.width=frame.width;
    if(buffer.height!==frame.height)buffer.height=frame.height;
    buffer.getContext("2d").putImageData(new ImageData(frame.pixels,frame.width,frame.height),0,0);
    surfaces[slot]={frame,canvas:buffer};return buffer;
  }
  const player=createTaskGifPlayback({publish:setState,draw:(frame,next,alpha=0)=>{
    if(canvas.width!==frame.width)canvas.width=frame.width;
    if(canvas.height!==frame.height)canvas.height=frame.height;
    if(surfaces[1]?.frame===frame)surfaces=[surfaces[1],surfaces[0]];
    const current=surface(frame,0),following=next?surface(next,1):null;
    if(!next)surfaces[1]=null;
    const context=canvas.getContext("2d");
    context.clearRect(0,0,canvas.width,canvas.height);
    try {
      context.globalAlpha=1-alpha;context.drawImage(current,0,0);
      if(following) {
        // Sum weighted premultiplied pixels, including transparent GIF regions.
        context.globalCompositeOperation="lighter";context.globalAlpha=alpha;
        context.drawImage(following,0,0);
      }
    } finally {context.globalAlpha=1;context.globalCompositeOperation="source-over";}
  }});
  createEffect(()=>{if(props.url)player.open(props.url);});
  createEffect(()=>player.setCrossfade(props.crossfade));
  onCleanup(()=>{player.dispose();surfaces=[];});
  return <div class="task-gif-player">
    <div class="task-gif-playback-controls">
      <button type="button" disabled={state().loading||!!state().error||state().count<2}
        aria-label={state().playing?"Остановить GIF":"Запустить GIF"} onClick={player.toggle}>
        {state().playing?"Стоп":"Старт"}
      </button>
      <label><input type="checkbox" checked={state().loop} onChange={event=>player.setLoop(event.currentTarget.checked)} /> Циклически</label>
      <span>{state().index>=0?`${state().index+1} / ${state().count}`:""}</span>
    </div>
    <div class="task-gif-frame">
      <canvas ref={canvas} aria-label={props.name} hidden={state().loading||!!state().error} />
      <Show when={state().loading||state().error}><p role={state().error?"alert":"status"}>{state().error||"Загрузка…"}</p></Show>
    </div>
  </div>;
}
