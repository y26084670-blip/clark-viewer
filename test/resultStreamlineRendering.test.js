import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import * as THREE from "three";
import { streamlinePointerHandlers, updateStreamlineMeshes } from "../src/services/visualization/resultStreamlineRenderer.js";
import { sourcesFields3DSetup } from "../scripts/test-support/sourcesFields3DSetup.js";
import { resultHitScalar, resultHitVector, formatResultScalarTooltip, formatResultVectorTooltip } from "../src/services/visualization/geometryPicking.js";

const server=await createServer({configFile:false,plugins:[solid({ssr:true})],root:fileURLToPath(new URL("..",import.meta.url)),server:{middlewareMode:true,hmr:false}});
after(()=>server.close());
const {intersectResultLayers}=await server.ssrLoadModule("/src/components/geometry/ThreeGeometryViewport.jsx");
const source=readFileSync(new URL("../src/components/geometry/ThreeGeometryViewport.jsx",import.meta.url),"utf8");
const pickSource=source.slice(source.indexOf("  const pickAtPointer ="),source.indexOf("  const queuePointerPick ="));
const makePick=new Function("deps",`const {renderer,camera,controls,raycaster,pointerNdc,props,resultLayerStates,
  resultHitScalar,resultHitVector,formatResultScalarTooltip,formatResultVectorTooltip,intersectResultLayers,
  setHoverTooltip,showTooltip,streamlineRoot}=deps;
  const AXES_GIZMO_MARGIN=8,axesGizmoSize=()=>0,worldUnitsPerPixel=()=>.01;
  const activeRenderMode="solid",geometryOpacity=.5,geometryPickTargets=[],resultVectorColorMap=true;
  ${pickSource} return pickAtPointer;`);

test("actual viewport picker seeds exactly the saved node used by its tooltip, for vector sticks and colour points",()=>{
  for(const points of [true,false]) {
    const item={source:{schemaId:"elements",recordIndex:3},instance:{ls:1,as:0,ps:0},node:9,quantityKey:"J",
      origin:[0,0,0],vector:[1,0,0],magnitude:1,unit:"А/мм²",quantity:"J"};
    const geometry=new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute(points?[0,0,0]:[0,0,0,1,0,0],3));
    const root=points?new THREE.Points(geometry,new THREE.PointsMaterial({size:8})):new THREE.LineSegments(geometry,new THREE.LineBasicMaterial());
    root.userData.resultVectors=[item];root.userData.style=points?"points":"thin";root.updateMatrixWorld();
    const camera=new THREE.OrthographicCamera(-2,2,2,-2,.1,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const tips=[],seeds=[],props={resultPickingOnly:true,onResultNodeDoubleClick:item=>seeds.push(item)};
    const pick=makePick({renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:400,height:400})}},
      camera,controls:{target:new THREE.Vector3()},raycaster:new THREE.Raycaster(),pointerNdc:new THREE.Vector2(),props,
      resultLayerStates:new Map([["elements",{vectorRoot:root,scalarRoot:null,scene:{},scale:1}]]),
      resultHitScalar,resultHitVector,formatResultScalarTooltip,formatResultVectorTooltip,intersectResultLayers,
      setHoverTooltip(){},showTooltip:text=>tips.push(text),streamlineRoot:null});
    const pointer={clientX:200,clientY:200};pick(pointer);pick(pointer,"seed");
    assert.equal(tips[0],formatResultVectorTooltip(item,{showMagnitude:true}));assert.equal(seeds[0],item);
    geometry.dispose();root.material.dispose();
  }
});

const line=(id,offset=0)=>({id,paths:[{source:{schemaId:"elements",recordIndex:id-1},instance:{ls:0,as:0,ps:0},
  positions:new Float64Array([offset,0,0,offset+1,0,0,offset+2,1,0])}]});
test("double-click dispatches the same pick coordinates; orbit drags, right clicks and movie capture cannot seed lines",()=>{
  const actions=[];let blocked=false;
  const h=streamlinePointerHandlers((event,action)=>actions.push([event.clientX,event.clientY,action]),()=>blocked);
  const p={clientX:20,clientY:40,button:0};h.pointerdown(p);h.click(p);h.dblclick(p);
  assert.deepEqual(actions,[[20,40,"select"],[20,40,"seed"]]);
  h.pointerdown(p);h.dblclick({...p,clientX:30});h.pointerdown({...p,button:2});h.dblclick({...p,button:2});
  blocked=true;h.pointerdown(p);h.dblclick(p);assert.equal(actions.length,2);
});
test("adding/selecting/removing lines retains the others, highlights only the selection and releases removed resources",()=>{
  const root=new THREE.Group(),a=line(1,1e12),b=line(2,1e12+10);
  updateStreamlineMeshes(THREE,root,[a]);const first=root.children[0],geometry=first.geometry,material=first.material;
  updateStreamlineMeshes(THREE,root,[a,b],{selected:2});assert.equal(root.children[0],first);assert.equal(first.geometry,geometry);
  assert.notEqual(first.material.color.getHex(),root.children[1].material.color.getHex());
  const second=root.children[1];let disposed=0;second.geometry.addEventListener("dispose",()=>disposed++);second.material.addEventListener("dispose",()=>disposed++);
  const attrs=geometry.getAttribute("position");assert.deepEqual([...attrs.array],[0,0,0,1,0,0,2,1,0]);
  root.updateMatrixWorld(true);const ray=new THREE.Raycaster(new THREE.Vector3(1e12+.5,0,10),new THREE.Vector3(0,0,-1));
  ray.params.Line.threshold=.1;assert.equal(ray.intersectObjects(root.children)[0].object.userData.streamlineId,1);
  updateStreamlineMeshes(THREE,root,[a],{selected:1});assert.equal(disposed,2);assert.equal(root.children[0].material,material);
  updateStreamlineMeshes(THREE,root,[]);assert.equal(root.children.length,0);
});
test("path pieces use their own element and symmetry visibility; a time update retains compatible geometry",()=>{
  const root=new THREE.Group(),a=line(1);a.paths.push({...line(2).paths[0],instance:{ls:1,as:0,ps:0}});
  updateStreamlineMeshes(THREE,root,[a],{filters:{symmetry:{local:false}}});assert.equal(root.children[0].visible,true);assert.equal(root.children[1].visible,false);
  const geometry=root.children[0].geometry,material=root.children[0].material;
  updateStreamlineMeshes(THREE,root,[line(1,5)],{filters:{objectModes:{elements:"exceptSelected"},selections:{elements:[0]}}});
  assert.equal(root.children[0].visible,false);assert.equal(root.children[0].geometry,geometry);assert.equal(root.children[0].material,material);
  assert.equal(root.children[0].position.x,5);updateStreamlineMeshes(THREE,root,[]);
});
test("actual 3D setup accumulates double-click seeds, deletes only the selected line and clears on task change",()=>{
  const props={task:{elements:[{id:1,targ:0}],regions:[]},elements:[1],regions:[],time:0};
  const ui=sourcesFields3DSetup(props);
  ui.setResultState({frame:{request:{task:props.task,time:0},value:{layers:[]}},loading:false,error:""});
  const vector={quantityKey:"J",source:{schemaId:"elements",recordIndex:0},instance:{ls:0,as:0,ps:0},node:4};
  ui.addStreamline(vector);ui.addStreamline({...vector,node:7});
  assert.deepEqual(ui.request().streamlineSeeds.map(s=>s.node),[4,7]);assert.equal(ui.selectedStreamline(),2);
  ui.addStreamline({...vector,quantityKey:"JEdot"});ui.addStreamline({...vector,source:{schemaId:"regions",recordIndex:0}});
  assert.equal(ui.streamlineSeeds().length,2);
  ui.setSelectedStreamline(1);ui.deleteStreamline();assert.deepEqual(ui.streamlineSeeds().map(s=>s.id),[2]);
  ui.changeStreamlineTolerance({currentTarget:{valueAsNumber:.001}});assert.equal(ui.request().streamlineTolerance,.00001);
  props.task={elements:[],regions:[]};ui.flushEffects();assert.equal(ui.streamlineSeeds().length,0);assert.equal(ui.selectedStreamline(),null);
  ui.close();
});
test("returning to the 3D tab restores seeds and tolerance without retaining workers or sharing them with another task",()=>{
  const props={task:{elements:[{id:1,targ:0}],regions:[]},elements:[1],regions:[],time:0};
  const vector={quantityKey:"H",source:{schemaId:"elements",recordIndex:0},instance:{ls:0,as:0,ps:0},node:4};
  let closed=0;
  const open=()=>sourcesFields3DSetup(props,{}, {readerFactory:()=>({close(){closed++;}})});
  let ui=open();
  ui.setResultState({frame:{request:{task:props.task,time:0},value:{layers:[]}},loading:false,error:""});
  ui.addStreamline(vector);ui.changeStreamlineTolerance({currentTarget:{valueAsNumber:.001}});ui.close();
  assert.equal(closed,1);
  ui=open();assert.equal(ui.streamlineSeeds().length,1);assert.equal(ui.selectedStreamline(),1);
  assert.equal(ui.request().streamlineTolerance,.00001);
  ui.setResultState({frame:{request:{task:props.task,time:0},value:{layers:[]}},loading:false,error:""});
  ui.addStreamline({...vector,node:7});assert.deepEqual(ui.streamlineSeeds().map(s=>s.id),[1,2]);ui.close();
  assert.equal(closed,2);
  props.task={elements:[],regions:[]};ui=open();assert.equal(ui.streamlineSeeds().length,0);
  assert.equal(ui.selectedStreamline(),null);assert.equal(ui.request().streamlineTolerance,.0001);ui.close();
});
