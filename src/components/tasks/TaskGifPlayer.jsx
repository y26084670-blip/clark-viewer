import { createEffect,createSignal,onCleanup,Show } from "solid-js";
import { createTaskGifPlayback } from "../../services/taskGifPlayback.js";

export function TaskGifPlayer(props) {
  let canvas;
  const [state,setState]=createSignal({loading:true,playing:false,loop:false,count:0,index:-1,error:""});
  const player=createTaskGifPlayback({publish:setState,draw:frame=>{
    canvas.width=frame.width;canvas.height=frame.height;
    canvas.getContext("2d").putImageData(new ImageData(frame.pixels,frame.width,frame.height),0,0);
  }});
  createEffect(()=>{if(props.url)player.open(props.url);});
  onCleanup(()=>player.dispose());
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
