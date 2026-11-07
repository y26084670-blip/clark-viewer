import {createSignal} from 'solid-js';
import {render} from 'solid-js/web';
import { ThreeGeometryViewport } from '/src/components/geometry/ThreeGeometryViewport.jsx';
import { buildGeometryScene } from '/src/services/visualization/geometrySceneModel.js';
import {SourcesFields3D} from '/src/tabs/SourcesFields3D.jsx';
import {createGeometryViewSetting} from '/src/services/visualization/geometryViewSettings.js';
import {createMovieExportController} from '/src/services/movie/movieExportController.js';
import {createMovieWebmEncoder} from '/src/services/movie/movieWebmEncoder.js';
import {globalRangesTask} from '/scripts/test-support/globalRangesFixture.js';
import '/src/App.css';
import 'tabulator-tables/dist/css/tabulator.min.css';
import * as THREE from 'three';
import {updateResultSurfaceMeshes, disposeResultSurfaceMesh} from '/src/services/visualization/resultSurfaceRenderer.js';
import {updateResultVolumeMeshes, disposeResultVolumeMesh} from '/src/services/visualization/resultVolumeRenderer.js';
import {resultLogScale, resultScalarColor} from '/src/services/visualization/resultScalarColors.js';

// Check the colour of a physical midpoint, which differs from the average of
// the colours at its endpoints on a log scale. Both shaders run on real WebGL2.
function checkLargeOverlay() {
 const model = taskFixture();
 const element = {...model.elements[0], dp:[[65_537],[2],[1]], symLs:1, symAs:1, symPs:1, symYl:0, symYa:0, symTx:0};
 const scene = buildGeometryScene({general:{mirrorSymmetryX:-1,mirrorSymmetryY:-1}, elements:[element]});
 if (scene.diagnostics.length) throw new Error(JSON.stringify(scene.diagnostics));
 const host = document.createElement('div');
 host.style.cssText = 'position:fixed;inset:0;background:#222'; document.body.append(host);
 return new Promise((resolve, reject) => {
   let dispose;
   const timer = setTimeout(() => finish(reject, new Error("Large overlay did not draw")), 15000);
   const finish = (fn, value) => queueMicrotask(() => { clearTimeout(timer); dispose?.(); host.remove(); fn(value); });
   dispose = render(() => <ThreeGeometryViewport scene={scene} showDiscretizationLines showCentersAndNodes
     performanceEnabled onError={message => { if (message) finish(reject, new Error(message)); }}
     onPerformance={stats => { if (stats.points >= 131074) finish(resolve, stats); }} />, host);
 });
}

function sampledColors() {
 const renderer=new THREE.WebGLRenderer({antialias:false});
 renderer.setSize(65,65); renderer.setClearColor(0);
 const camera=new THREE.OrthographicCamera(-1,1,1,-1,0.1,10);
 camera.position.z=3; camera.updateMatrixWorld();
 const scene=new THREE.Scene(), group=new THREE.Group(); scene.add(group);
 const pixel=()=>{
   renderer.render(scene,camera);
   const gl=renderer.getContext(), rgba=new Uint8Array(4);
   gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgba);return [...rgba].slice(0,3);
 };
 const surface={key:'surface',positions:[-1,-1,0,1,-1,0,1,1,0,-1,1,0],indices:[0,1,2,0,2,3]};
 const volume={key:'volume',bounds:{min:[-1,-1,-1],max:[1,1,1]},dimensions:[2,2,2],mask:new Uint8Array(8).fill(1)};
 const samples=[];
 try {
  for (const [lo,hi,left,right] of [[1,100,1,100],[-100,-1,-100,-1],[-10,100,-10,100],[0,100,0,100]]) {
   const settings={minimum:lo,maximum:hi,palette:'Rainbow',logScale:resultLogScale(lo,hi,true),manual:true,opacity:1};
   const expected=resultScalarColor((left+right)/2,lo,hi,settings.palette,settings.logScale).map(x=>Math.round(x*255));
   surface.values=[left,right,right,left];
   updateResultSurfaceMeshes(THREE,group,[surface],settings);
   const face=pixel();disposeResultSurfaceMesh(group.children[0]);group.clear();
   volume.values=[left,right,left,right,left,right,left,right];
   updateResultVolumeMeshes(THREE,group,[volume],settings);
   const body=pixel();disposeResultVolumeMesh(group.children[0]);group.clear();
   samples.push({lo,hi,expected,face,body});
  }
  return samples;
 } finally {renderer.dispose();}
}
const settings={};
for(const [key,init] of Object.entries({resultElementsQuantity:'J',resultRegionsQuantity:'Bs',resultVirtualQuantity:'Av',resultVectorColorMap:true,resultVectorScale:1})) settings[key]=createGeometryViewSetting(key,init);
const setSetting=(name,value)=>{const [,write]=settings[name]??createGeometryViewSetting(name,value);write(value);};
let readCount=0,readyFrames=0;
const jeSteps = new WeakMap();
function taskFixture(kind='complete',staticTask=false){
 const task=globalRangesTask();
 task.elements=task.elements.map((e,i)=>({...e,geoType:0,geo:[[0,0,0],[2,0,0],[0,2,0],[2,2,0],[0,0,2],[2,0,2],[0,2,2],[2,2,2]].map(p=>[p[0]+i*5,p[1],p[2]]),dr:[[0],[0],[0]],symVi:[[0],[0],[0]],symR0:[[0],[0],[0]],indMove:0}));
 task.regions=task.regions.map((r,i)=>({...r,geoType:0,geo:[[0,0,4+i*3],[2,0,4+i*3],[0,2,4+i*3],[2,2,4+i*3]],dr:[[0],[0],[0]],symVi:[[0],[0],[0]],symR0:[[0],[0],[0]]}));
 if (kind === 'conductivity') {
  Object.assign(task.elements[0], {model:2, xapName:'HTS'});
  const material = {getDirectoryHandle:async () => material,getFileHandle:async file => {
   if (file !== 'HTS.txt') throw new DOMException('fixture', 'NotFoundError');
   return {getFile:async () => ({text:async () => JSON.stringify({j_gmin:1})})};
  }};
  task.handle=material;
 }
 const steps = [];
 jeSteps.set(task, steps);
 const oldRead=task.reader.read;task.reader.read=async req=>{
  readCount++;
  if(req.name==='JE')steps.push(req.step);
  const data=await oldRead(req);
  if (kind==='conductivity' && req.name==='JE') for(let i=0;i<data.count;i++){
    const offset=i*data.stride;
    data.values.set([1 + req.step, 0, 0, 0.1, 0, 0],offset+3);
  }
  readyFrames++;return data;};
 for(const meta of Object.values(task.metadata)){
  if(kind==='missing')delete meta.ranges;else if(kind==='partial')meta.ranges.state=kind;
  if(staticTask){meta.steps=[{index:0,key:'000000'}];if(meta.ranges){meta.ranges.stepIds=[0];meta.ranges.times=[0];}}
 }
 if(staticTask)task.general={countTimeSteps:0,timeStep:0};return task;
}
function Fixture(){
 const [task,setTask]=createSignal(taskFixture()),[time,setTime]=createSignal(0),[elements,setElements]=createSignal([1]),[regions,setRegions]=createSignal([1]);
 const [busy,setBusy]=createSignal(false);const controller=createMovieExportController({createEncoder:createMovieWebmEncoder});
 const props={get task(){return task();},get elements(){return elements();},get regions(){return regions();},get time(){return time();},setTime,setElements,setRegions,get movieBusy(){return busy();},setMovieTime:setTime,registerMovieAdapter:controller.register};
 window.minmax={checkLargeOverlay,sampledColors,setTime,setBusy,setElements,setRegions,setSetting,load:(kind='complete',stat=false)=>{setTime(0);setTask(taskFixture(kind,stat));},
  snapshot:()=>({time:time(),readCount,readyFrames,jeSteps:[...jeSteps.get(task())],elements:elements(),regions:regions(),busy:busy()}),
  movie:async()=>{setBusy(true);try{const result=await controller.run({intervalMs:100});return {frames:result.frameCount,bytes:Array.from(new Uint8Array(await result.blob.arrayBuffer()))};}finally{setBusy(false);}}
 };
 return <div class="app-container"><header class="task-info-bar">Viewer 3D minmax — проверка</header><main class="tabs-body"><SourcesFields3D {...props}/></main></div>;
}
render(()=><Fixture/>,document.getElementById('root'));
