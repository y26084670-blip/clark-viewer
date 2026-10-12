import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { pickGeometryFlightPivot } from "../src/services/visualization/geometryFlightPivot.js";

const vertices=Float64Array.from(Array.from({length:8},(_,n)=>[n&1?1:-1,n&2?1:-1,n&4?1:-1]).flat());
const indices=Uint16Array.from([0,4,6,0,6,2,1,3,7,1,7,5,0,2,3,0,3,1,4,5,7,4,7,6,0,1,5,0,5,4,2,6,7,2,7,3]);
const ray=(origin=[0,0,10],direction=[0,0,-1])=>new THREE.Ray(new THREE.Vector3(...origin),new THREE.Vector3(...direction).normalize());
const batch=(z=0,id=0)=>({primitive:{kind:"element-volume",vertices,indices,source:{schemaId:"elements",recordIndex:id}},instances:[{matrix:new THREE.Matrix4().makeTranslation(0,0,z).toArray(),ls:0,as:0,ps:0}]});
const close=(actual,expected)=>actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-9,`${actual} != ${expected}`));

test("nearest surface wins regardless of object order; a ray miss or empty scene has no pivot",()=>{
  const front=batch(3,1),back=batch(-3,2);
  for(const batches of [[front,back],[back,front]]) {
    const hit=pickGeometryFlightPivot(THREE,ray(),batches);close(hit.point,[0,0,4]);assert.equal(hit.distance,6);assert.equal(hit.source.recordIndex,1);
  }
  assert.equal(pickGeometryFlightPivot(THREE,ray([5,0,10]),[front,back]),null);
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[]),null);
  assert.equal(pickGeometryFlightPivot(THREE,ray([0,0,10],[0,0,1]),[front]),null);
});

test("a camera inside an object uses its nearest exit surface and clipping limits constrain the depth",()=>{
  const box=batch();close(pickGeometryFlightPivot(THREE,ray([0,0,0],[1,0,0]),[box]).point,[1,0,0]);
  close(pickGeometryFlightPivot(THREE,ray(),[box],{near:9.5,far:12}).point,[0,0,-1]);
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[box],{far:8}),null);
});

test("wireframe bodies use their logical faces rather than distances to edges or centres",()=>{
  const box=batch();const geometry=new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute([-1,-1,1,1,-1,1],3));
  const object=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial());box.object=object;
  const before=geometry.getAttribute("position").array.slice();
  close(pickGeometryFlightPivot(THREE,ray(),[box]).point,[0,0,1]);assert.deepEqual(geometry.getAttribute("position").array,before);
  assert.deepEqual(vertices,box.primitive.vertices);geometry.dispose();object.material.dispose();
});

test("transparent visible bodies participate, hidden objects/parents and fully invisible bodies do not",()=>{
  const front=batch(3,1),back=batch(-3,2),geometry=new THREE.BufferGeometry();
  const object=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({transparent:true,opacity:.01}));front.object=object;
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[front,back]).source.recordIndex,1);
  object.visible=false;assert.equal(pickGeometryFlightPivot(THREE,ray(),[front,back]).source.recordIndex,2);
  object.visible=true;object.material.opacity=0;assert.equal(pickGeometryFlightPivot(THREE,ray(),[front,back]).source.recordIndex,2);
  const edgeMaterial=new THREE.LineBasicMaterial(),edges=new THREE.LineSegments(geometry,edgeMaterial);object.add(edges);
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[front,back]).source.recordIndex,1,"visible edges retain a logical surface");
  const parent=new THREE.Group();parent.add(object);parent.visible=false;
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[front,back]).source.recordIndex,2);
  geometry.dispose();object.material.dispose();edgeMaterial.dispose();
});

test("mirrored and scaled instances preserve physical depth and their identity",()=>{
  const box=batch();box.instances=[{matrix:new THREE.Matrix4().makeScale(-2,3,4).setPosition(5,2,-10).toArray(),ls:2,as:1,ps:0}];
  const hit=pickGeometryFlightPivot(THREE,ray([5,2,10]),[box]);close(hit.point,[5,2,-6]);assert.equal(hit.distance,16);assert.equal(hit.instance,box.instances[0]);
  assert.equal(pickGeometryFlightPivot(THREE,ray([5,2,10]),[box],{far:15}),null);
});

test("motion updates and scene-parent transforms use current retained instances without rebuilding a picker",()=>{
  const box=batch();box.instances=[{matrix:new THREE.Matrix4().makeTranslation(10000.125,-20000.25,3).toArray()}];
  close(pickGeometryFlightPivot(THREE,ray([10000.125,-20000.25,10]),[box]).point,[10000.125,-20000.25,4]);
  box.instances=[{matrix:new THREE.Matrix4().makeTranslation(0,0,-3).toArray()}];
  const geometry=new THREE.BufferGeometry(),material=new THREE.MeshBasicMaterial();box.object=new THREE.Mesh(geometry,material);box.object.position.x=7;
  close(pickGeometryFlightPivot(THREE,ray([7,0,10]),[box]).point,[7,0,-2]);
  geometry.dispose();material.dispose();
});

test("planes are hit from either side; lines, points and collapsed triangles do not invent a surface",()=>{
  const plane={primitive:{kind:"region-surface",vertices:[-1,-1,0,1,-1,0,0,1,0],indices:[0,1,2],source:{schemaId:"regions",recordIndex:0}},instances:batch().instances};
  close(pickGeometryFlightPivot(THREE,ray(),[plane]).point,[0,0,0]);close(pickGeometryFlightPivot(THREE,ray([0,0,-10],[0,0,1]),[plane]).point,[0,0,0]);
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[{...plane,primitive:{...plane.primitive,kind:"region-line"}}]),null);
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[{...plane,primitive:{...plane.primitive,vertices:[0,0,0,0,0,0,0,0,0]}}]),null);
  assert.equal(pickGeometryFlightPivot(THREE,ray(),[{...plane,primitive:{...plane.primitive,indices:[]}}]),null);
});
