import {createSignal} from 'solid-js';
import {render} from 'solid-js/web';
import {SourcesFields3D} from '/src/tabs/SourcesFields3D.jsx';
import {createGeometryViewSetting} from '/src/services/visualization/geometryViewSettings.js';
import {createMovieExportController} from '/src/services/movie/movieExportController.js';
import {createMovieGifEncoder} from '/src/services/movie/movieGifEncoder.js';
import {globalRangesTask} from '/scripts/test-support/globalRangesFixture.js';
import '/src/App.css';
import 'tabulator-tables/dist/css/tabulator.min.css';
const settings={};
for(const [key,init] of Object.entries({resultElementsQuantity:'J',resultRegionsQuantity:'Bs',resultVirtualQuantity:'Av',resultVectorColorMap:true,resultVectorScale:1})) settings[key]=createGeometryViewSetting(key,init);
const setSetting=(name,value)=>{const [,write]=settings[name]??createGeometryViewSetting(name,value);write(value);};
let readCount=0,readyFrames=0;
function taskFixture(kind='complete',staticTask=false){
 const task=globalRangesTask();
 task.elements=task.elements.map((e,i)=>({...e,geoType:0,geo:[[0,0,0],[2,0,0],[0,2,0],[2,2,0],[0,0,2],[2,0,2],[0,2,2],[2,2,2]].map(p=>[p[0]+i*5,p[1],p[2]]),dr:[[0],[0],[0]],symVi:[[0],[0],[0]],symR0:[[0],[0],[0]],indMove:0}));
 task.regions=task.regions.map((r,i)=>({...r,geoType:0,geo:[[0,0,4+i*3],[2,0,4+i*3],[0,2,4+i*3],[2,2,4+i*3]],dr:[[0],[0],[0]],symVi:[[0],[0],[0]],symR0:[[0],[0],[0]]}));
 const oldRead=task.reader.read;task.reader.read=async req=>{readCount++;const data=await oldRead(req);readyFrames++;return data;};
 for(const meta of Object.values(task.metadata)){
  if(kind==='missing')delete meta.ranges;else if(kind!=='complete')meta.ranges.state=kind;
  if(staticTask){meta.steps=[{index:0,key:'000000'}];if(meta.ranges){meta.ranges.stepIds=[0];meta.ranges.times=[0];}}
 }
 if(staticTask)task.general={countTimeSteps:0,timeStep:0};return task;
}
function Fixture(){
 const [task,setTask]=createSignal(taskFixture()),[time,setTime]=createSignal(0),[elements,setElements]=createSignal([1]),[regions,setRegions]=createSignal([1]);
 const [busy,setBusy]=createSignal(false);const controller=createMovieExportController({createEncoder:createMovieGifEncoder});
 const props={get task(){return task();},get elements(){return elements();},get regions(){return regions();},get time(){return time();},setTime,setElements,setRegions,get movieBusy(){return busy();},setMovieTime:setTime,registerMovieAdapter:controller.register};
 window.minmax={setTime,setElements,setRegions,setSetting,load:(kind='complete',stat=false)=>{setTime(0);setTask(taskFixture(kind,stat));},
  snapshot:()=>({time:time(),readCount,readyFrames,elements:elements(),regions:regions(),busy:busy()}),
  movie:async()=>{setBusy(true);try{const result=await controller.run({intervalMs:100});return {frames:result.frameCount,bytes:Array.from(new Uint8Array(await result.blob.arrayBuffer()))};}finally{setBusy(false);}}
 };
 return <div class="app-container"><header class="task-info-bar">Viewer 3D minmax — проверка</header><main class="tabs-body"><SourcesFields3D {...props}/></main></div>;
}
render(()=><Fixture/>,document.getElementById('root'));
