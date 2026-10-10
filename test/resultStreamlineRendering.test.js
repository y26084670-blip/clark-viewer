import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import * as THREE from "three";
import { loadStreamlineRenderer, resizeStreamlineMaterials, streamlinePointerHandlers, updateStreamlineMeshes } from "../src/services/visualization/resultStreamlineRenderer.js";
import { resultScalarColor } from "../src/services/visualization/resultScalarColors.js";
import { sourcesFields3DSetup } from "../scripts/test-support/sourcesFields3DSetup.js";
import { resultHitScalar, resultHitVector, formatResultScalarTooltip, formatResultVectorTooltip } from "../src/services/visualization/geometryPicking.js";

await loadStreamlineRenderer();
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

const line=(id,offset=0)=>({id,quantityKey:"M",quantity:"M",unit:"кА/м",paths:[{source:{schemaId:"elements",recordIndex:id-1},instance:{ls:0,as:0,ps:0},
  positions:new Float64Array([offset,0,0,offset+1,0,0,offset+2,1,0]),magnitudes:new Float64Array([1,3,5])}]});
const seededLine=(id,start=[0,0,0])=>{
  const value=line(id,start[0]);
  return {...value,start,source:value.paths[0].source,instance:value.paths[0].instance};
};
const startMarkers=root=>root.children.filter(object=>object.userData.streamlineStart);
test("one flat seed diamond serves both branches, follows the saved node and uses the seed's visibility",()=>{
  const root=new THREE.Group(),a=seededLine(1,[1e12+.25,3,4]);
  a.paths.push({...line(2).paths[0],instance:{ls:1,as:0,ps:0}});
  updateStreamlineMeshes(THREE,root,[a],{selected:1,resolution:[800,600]});
  const [marker]=startMarkers(root),geometry=marker.geometry,material=marker.material;
  assert.equal(startMarkers(root).length,1);assert.equal(marker.isPoints,true);
  assert.deepEqual(marker.position.toArray(),a.start);
  assert.deepEqual([...geometry.getAttribute("position").array],[0,0,0]);
  assert.equal(material.size,12);assert.equal(material.sizeAttenuation,false);
  assert.equal(material.color.getHex(),0xffdd38);assert.equal(material.depthTest,true);
  const image=material.map.image,pixel=(x,y)=>Array.from(image.data.subarray((y*image.width+x)*4,(y*image.width+x+1)*4));
  assert.deepEqual(pixel(32,32),[255,255,255,255]);assert.equal(pixel(0,0)[3],0);
  assert.deepEqual(pixel(58,32),[20,20,20,255]);
  const moved={...a,start:[1e12+.5,7,8]};
  updateStreamlineMeshes(THREE,root,[moved],{width:10,colorMap:false,
    filters:{objectModes:{elements:"exceptSelected"},selections:{elements:[0]}}});
  assert.equal(startMarkers(root)[0],marker);assert.equal(marker.geometry,geometry);assert.equal(marker.material,material);
  assert.deepEqual(marker.position.toArray(),moved.start);assert.equal(material.size,12);
  assert.equal(material.color.getHex(),0xffffff);assert.equal(marker.visible,false);
  assert.equal(root.children.find(object=>object.userData.streamlinePart==="1:1").visible,true);
  updateStreamlineMeshes(THREE,root,[{...moved,instance:{ls:1,as:0,ps:0}}],{filters:{symmetry:{local:false}}});
  assert.equal(marker.visible,false);
  updateStreamlineMeshes(THREE,root,[{...moved,paths:[]}]);
  assert.deepEqual(root.children,[marker]);assert.equal(marker.visible,true,"a zero field still has a saved seed");
  updateStreamlineMeshes(THREE,root,[{...moved,error:"invalid field"},{...seededLine(2),start:[NaN,0,0]}]);
  assert.equal(startMarkers(root).length,0,"errors must not invent a starting coordinate");
  updateStreamlineMeshes(THREE,root,[]);
});
test("seed diamonds share one texture and release it only after the last line is removed",()=>{
  const root=new THREE.Group(),a=seededLine(1),b=seededLine(2,[5,0,0]);
  updateStreamlineMeshes(THREE,root,[a,b]);
  const [first,second]=startMarkers(root),texture=first.material.map;
  assert.equal(second.material.map,texture);
  let firstReleased=0,secondReleased=0,textureReleased=0;
  for(const resource of [first.geometry,first.material])resource.addEventListener("dispose",()=>firstReleased++);
  for(const resource of [second.geometry,second.material])resource.addEventListener("dispose",()=>secondReleased++);
  texture.addEventListener("dispose",()=>textureReleased++);
  updateStreamlineMeshes(THREE,root,[b],{selected:2});
  assert.deepEqual(startMarkers(root),[second]);assert.equal(firstReleased,2);assert.equal(secondReleased,0);assert.equal(textureReleased,0);
  updateStreamlineMeshes(THREE,root,[]);updateStreamlineMeshes(THREE,root,[]);
  assert.equal(secondReleased,2);assert.equal(textureReleased,1);assert.equal(root.userData.startMarkerTexture,undefined);
});
test("diamond picking retains its screen footprint through camera changes and takes priority over a crossing curve",()=>{
  for(const perspective of [false,true]) {
    const root=new THREE.Group(),a=line(1),b={...seededLine(2),paths:[]};
    const camera=perspective?new THREE.PerspectiveCamera(40,1,.1,1000):new THREE.OrthographicCamera(-2,2,2,-2,.1,1000);
    updateStreamlineMeshes(THREE,root,[a,b],{resolution:[400,400]});root.updateMatrixWorld(true);
    const marker=startMarkers(root)[0],ray=new THREE.Raycaster();ray.params.Points.threshold=1e6;
    for(const [position,zoom,width,height] of [[[0,0,10],1,400,400],[[20,30,40],2,800,600]]) {
      camera.position.fromArray(position);camera.zoom=zoom;camera.lookAt(0,0,0);camera.updateProjectionMatrix();camera.updateMatrixWorld();
      resizeStreamlineMaterials(root,width,height);
      const hit=(x,y)=>{ray.setFromCamera(new THREE.Vector2(2*x/width,2*y/height),camera);return ray.intersectObject(marker,false);};
      assert.equal(hit(5,0).length,1);assert.equal(hit(0,5).length,1);
      assert.equal(hit(9,0).length,0);assert.equal(hit(6,6).length,0);
    }
    camera.position.set(0,0,10);camera.zoom=1;camera.lookAt(0,0,0);camera.updateProjectionMatrix();camera.updateMatrixWorld();
    resizeStreamlineMaterials(root,400,400);
    const selected=[];
    const pick=makePick({renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:400,height:400})}},
      camera,controls:{target:new THREE.Vector3()},raycaster:ray,pointerNdc:new THREE.Vector2(),
      props:{resultPickingOnly:true,onSelectStreamline:id=>selected.push(id)},resultLayerStates:new Map(),
      resultHitScalar,resultHitVector,formatResultScalarTooltip,formatResultVectorTooltip,intersectResultLayers,
      setHoverTooltip(){},showTooltip(){},streamlineRoot:root});
    pick({clientX:200,clientY:200},"select");assert.equal(selected.at(-1),2);
    marker.visible=false;pick({clientX:200,clientY:200},"select");assert.equal(selected.at(-1),1);
    marker.visible=true;marker.position.z=20;root.updateMatrixWorld(true);
    ray.setFromCamera(new THREE.Vector2(),camera);assert.equal(ray.intersectObject(marker,false).length,0);
    updateStreamlineMeshes(THREE,root,[]);
  }
});
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
  const colors=geometry.getAttribute("instanceColorStart").data.array.slice();
  updateStreamlineMeshes(THREE,root,[a,b],{selected:2});assert.equal(root.children[0],first);assert.equal(first.geometry,geometry);
  assert.equal(first.children.length,0);assert.equal(root.children[1].children.filter(child=>child.visible).length,2);
  assert.deepEqual(geometry.getAttribute("instanceColorStart").data.array,colors);
  const second=root.children[1];let disposed=0;second.geometry.addEventListener("dispose",()=>disposed++);second.material.addEventListener("dispose",()=>disposed++);
  for(const child of second.children)child.material.addEventListener("dispose",()=>disposed++);
  const attrs=geometry.getAttribute("instanceStart");assert.deepEqual([...attrs.data.array],[0,0,0,1,0,0,1,0,0,2,1,0]);
  root.updateMatrixWorld(true);const ray=new THREE.Raycaster(new THREE.Vector3(1e12+.5,0,10),new THREE.Vector3(0,0,-1));
  // World-unit mode only for this large-coordinate ray; screen-space picking is
  // exercised separately with a real camera and the actual viewport function.
  for(const object of root.children){object.material.worldUnits=true;object.material.linewidth=.1;}
  assert.equal(ray.intersectObjects(root.children)[0].object.userData.streamlineId,1);
  updateStreamlineMeshes(THREE,root,[a],{selected:1});assert.equal(disposed,4);assert.equal(root.children[0].material,material);
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
test("wide line picking follows pixel width in both projections and the real viewport selects the curve",()=>{
  for(const perspective of [false,true]) {
    const root=new THREE.Group(),a=line(1);
    const camera=perspective?new THREE.PerspectiveCamera(2*Math.atan(.2)*180/Math.PI,1,.1,100)
      :new THREE.OrthographicCamera(-2,2,2,-2,.1,100);
    camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    updateStreamlineMeshes(THREE,root,[a],{width:2,resolution:[400,400]});root.updateMatrixWorld(true);
    const object=root.children[0],geometry=object.geometry,ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(.25,.0175),camera); // 3.5 pixels above the horizontal segment.
    assert.equal(ray.intersectObjects(root.children,false).length,0);
    updateStreamlineMeshes(THREE,root,[a],{width:10,resolution:[400,400]});
    assert.equal(object.geometry,geometry);assert.equal(object.material.linewidth,10);
    assert.equal(ray.intersectObjects(root.children,false)[0].object.userData.streamlineId,1);
    const selected=[];
    const pick=makePick({renderer:{domElement:{getBoundingClientRect:()=>({left:0,top:0,width:400,height:400})}},
      camera,controls:{target:new THREE.Vector3()},raycaster:ray,pointerNdc:new THREE.Vector2(),
      props:{resultPickingOnly:true,onSelectStreamline:id=>selected.push(id)},resultLayerStates:new Map(),
      resultHitScalar,resultHitVector,formatResultScalarTooltip,formatResultVectorTooltip,intersectResultLayers,
      setHoverTooltip(){},showTooltip(){},streamlineRoot:root});
    pick({clientX:250,clientY:196.5},"select");assert.equal(selected.at(-1),1);
    resizeStreamlineMaterials(root,800,600);assert.deepEqual(object.material.resolution.toArray(),[800,600]);
    object.onBeforeRender({getViewport:target=>target.set(0,0,640,480)});
    assert.deepEqual(object.material.resolution.toArray(),[640,480]);
    assert.equal(object.material.linewidth,10);updateStreamlineMeshes(THREE,root,[]);
  }
});
test("palette scales are shared per visible quantity; selection, width and mono mode preserve data colours and buffers",()=>{
  const root=new THREE.Group(),a=line(1),b=line(2,5),c={...line(3,10),quantityKey:"H",quantity:"H"};
  b.paths[0].magnitudes=new Float64Array([5,7,9]);c.paths[0].magnitudes=new Float64Array([100,200,300]);
  const hidden={...line(4,15),quantityKey:"J",unit:"А/мм²"},lines=[a,b,c,hidden];
  const options={filters:{objectModes:{elements:"exceptSelected"},selections:{elements:[3]}},palette:"Rainbow",resolution:[800,600]};
  updateStreamlineMeshes(THREE,root,lines,options);
  assert.deepEqual(root.userData.colorLegends.map(l=>[l.key,l.minimum,l.maximum,l.unit]),[
    ["streamline:M",1,9,"кА/м"],["streamline:H",100,300,"кА/м"]]);
  const first=root.children[0],colors=first.geometry.getAttribute("instanceColorStart").data;
  const read=(object,name,index)=>new THREE.Color().fromBufferAttribute(object.geometry.getAttribute(name),index);
  const assertColor=(actual,value,min,max,palette)=>{
    const expected=new THREE.Color().setRGB(...resultScalarColor(value,min,max,palette),THREE.SRGBColorSpace);
    assert.ok(Math.hypot(actual.r-expected.r,actual.g-expected.g,actual.b-expected.b)<1e-7);
  };
  assertColor(read(first,"instanceColorStart",0),1,1,9,"Rainbow");
  assertColor(read(first,"instanceColorEnd",1),5,1,9,"Rainbow");
  assert.deepEqual(read(first,"instanceColorEnd",1).toArray(),read(root.children[1],"instanceColorStart",0).toArray());
  const before=colors.array.slice();
  updateStreamlineMeshes(THREE,root,lines,{...options,selected:1,width:8});
  assert.deepEqual(colors.array,before);assert.equal(first.geometry.getAttribute("instanceColorStart").data,colors);
  assert.equal(first.material.linewidth,8);assert.equal(first.children.length,2);
  assert.ok(first.children.every(child=>child.geometry===first.geometry&&child.visible&&child.material.linewidth>8));
  updateStreamlineMeshes(THREE,root,lines,{...options,colorMap:false});
  assert.equal(first.material.vertexColors,false);assert.deepEqual(root.userData.colorLegends,[]);
  updateStreamlineMeshes(THREE,root,lines,{...options,palette:"Inferno"});
  assert.equal(first.material.vertexColors,true);assert.equal(first.geometry.getAttribute("instanceColorStart").data,colors);
  assertColor(read(first,"instanceColorEnd",1),5,1,9,"Inferno");
  const oldGeometry=first.geometry;let released=0;oldGeometry.addEventListener("dispose",()=>released++);
  const longer={...a,paths:[{...a.paths[0],positions:new Float64Array([0,0,0,1,0,0,2,1,0,3,1,0]),magnitudes:new Float64Array([1,3,5,7])}]};
  updateStreamlineMeshes(THREE,root,[longer,b,c,hidden],{...options,selected:1});
  assert.equal(released,1);assert.ok(first.children.every(child=>child.geometry===first.geometry));
  updateStreamlineMeshes(THREE,root,[]);
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
  ui.addStreamline(vector);ui.changeStreamlineTolerance({currentTarget:{valueAsNumber:.001}});
  ui.changeStreamlineMethod({currentTarget:{value:"trilinear-boundary"}});ui.close();
  assert.equal(closed,1);
  ui=open();assert.equal(ui.streamlineSeeds().length,1);assert.equal(ui.selectedStreamline(),1);
  assert.equal(ui.request().streamlineTolerance,.00001);assert.equal(ui.request().streamlineMethod,"trilinear-boundary");
  ui.setResultState({frame:{request:{task:props.task,time:0},value:{layers:[]}},loading:false,error:""});
  ui.addStreamline({...vector,node:7});assert.deepEqual(ui.streamlineSeeds().map(s=>s.id),[1,2]);ui.close();
  assert.equal(closed,2);
  props.task={elements:[],regions:[]};ui=open();assert.equal(ui.streamlineSeeds().length,0);
  assert.equal(ui.selectedStreamline(),null);assert.equal(ui.request().streamlineTolerance,.0001);
  assert.equal(ui.request().streamlineMethod,"trilinear");ui.close();
});

test('3D streamline colours use the optional global magnitude range and restore local bounds',()=>{
  const root=new THREE.Group(),a=line(1);const options={colorMap:true,resolution:[800,600]};
  updateStreamlineMeshes(THREE,root,[a],options);
  assert.deepEqual(root.userData.colorLegends.map(r=>[r.minimum,r.maximum]),[[1,5]]);
  updateStreamlineMeshes(THREE,root,[{...a,displayRange:{available:true,minimum:0,maximum:100}}],options);
  assert.deepEqual(root.userData.colorLegends.map(r=>[r.minimum,r.maximum]),[[0,100]]);
  assert.deepEqual([...a.paths[0].magnitudes],[1,3,5]);
  updateStreamlineMeshes(THREE,root,[a],options);
  assert.deepEqual(root.userData.colorLegends.map(r=>[r.minimum,r.maximum]),[[1,5]]);
  updateStreamlineMeshes(THREE,root,[],options);
});

test("quadratic and tricubic comparisons retain each method, seeds and tolerance across a tab replacement",()=>{
  for(const method of ["quadratic","tricubic"]) {
    const props={task:{elements:[{id:1,targ:0}],regions:[]},elements:[1],regions:[],time:0};
    const vector={quantityKey:"H",source:{schemaId:"elements",recordIndex:0},instance:{ls:0,as:0,ps:0},node:4};
    let ui=sourcesFields3DSetup(props);
    ui.setResultState({frame:{request:{task:props.task,time:0},value:{layers:[]}},loading:false,error:""});
    ui.addStreamline(vector);ui.changeStreamlineTolerance({currentTarget:{valueAsNumber:.001}});
    ui.changeStreamlineMethod({currentTarget:{value:method}});
    const seeds=ui.request().streamlineSeeds;ui.close();
    ui=sourcesFields3DSetup(props);
    try {
      assert.equal(ui.request().streamlineMethod,method);assert.equal(ui.request().streamlineSeeds,seeds);
      assert.equal(ui.request().streamlineTolerance,1e-5);assert.equal(ui.selectedStreamline(),seeds[0].id);
    } finally {ui.close();}
  }
});
