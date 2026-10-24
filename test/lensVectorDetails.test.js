import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createLensVectorDetails, lensDepthOpacity, LENS_VECTOR_FAR_OPACITY } from "../src/services/visualization/lensVectorDetails.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
function fixture() {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 100);
  camera.position.set(0, 0, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  return { scene, camera, detail: createLensVectorDetails(THREE) };
}
function lines(segments, stride = 1) {
  const values = segments.flatMap(pair => Array.from({length: stride}, () => pair.flat()).flat());
  const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(values, 3));
  const object = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({color: 0xff2200, transparent: true}));
  object.userData.resultVectors = segments.map(() => ({})); object.userData.segmentsPerVector = stride;
  return object;
}
function endpoints(mesh, index) {
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix);
  return [[0,0,0],[0,1,0]].map(p => new THREE.Vector3(...p).applyMatrix4(matrix).toArray());
}
function capture(f, check) {
  return f.detail.render(f.scene, f.camera, () => check(f.scene.getObjectByName("lens-detailed-vectors")));
}

test("lens substitutes complete arrows, keeps world endpoints/color, and restores original visibility even on failure", () => {
  const f = fixture(), parent = new THREE.Group(); parent.position.set(1, 2, 0); f.scene.add(parent);
  const object = lines([[[0,0,2],[1,0,2]], [[0,0,-2],[0,-1,-2]]], 5); parent.add(object);
  const hidden = lines([[[0,0,0],[1,0,0]]]); hidden.visible = false; f.scene.add(hidden);
  const hover = new THREE.Group(); hover.name = "hovered-thin-vector"; f.scene.add(hover);
  const saved = object.geometry.attributes.position.array.slice(); let mesh;
  capture(f, actual => {
    mesh = actual; assert.equal(mesh.count, 2); assert.equal(object.visible, false); assert.equal(hover.visible, false);
    assert.equal(hidden.visible, false); assert.deepEqual(endpoints(mesh, 0), [[1,2,-2],[1,1,-2]]);
    const near = endpoints(mesh, 1); near.flat().forEach((value, i) => close(value, [1,2,2,2,2,2][i]));
    const color = new THREE.Color(); mesh.getColorAt(0, color); color.toArray().forEach((value, i) => close(value, object.material.color.toArray()[i]));
    close(mesh.geometry.attributes.lensOpacity.getX(0), LENS_VECTOR_FAR_OPACITY);
    close(mesh.geometry.attributes.lensOpacity.getX(1), 1);
    assert.equal(mesh.material.depthWrite, false); assert.equal(mesh.material.depthTest, true);
  });
  assert.equal(mesh.parent, null); assert.equal(object.visible, true); assert.equal(hover.visible, true); assert.equal(hidden.visible, false);
  assert.deepEqual(object.geometry.attributes.position.array, saved);
  assert.throws(() => capture(f, () => { throw Error("draw failed"); }), /draw failed/);
  assert.equal(object.visible, true); assert.equal(hover.visible, true); assert.equal(mesh.parent, null);
  let freed = 0; mesh.geometry.addEventListener("dispose", () => freed++); mesh.material.addEventListener("dispose", () => freed++);
  f.detail.dispose(); assert.equal(freed, 2);
});

test("depth transparency is monotonic, respects existing opacity and reverses with camera direction", () => {
  close(lensDepthOpacity(1, 1, 3), 1); close(lensDepthOpacity(3, 1, 3), .18);
  assert.ok(lensDepthOpacity(1.5, 1, 3) > lensDepthOpacity(2.5, 1, 3));
  close(lensDepthOpacity(2, 2, 2), 1);
  const f = fixture(), object = lines([[[0,0,2],[1,0,2]], [[0,0,-2],[1,0,-2]]]); object.material.opacity = .5; f.scene.add(object);
  capture(f, mesh => { close(endpoints(mesh, 0)[0][2], -2); close(mesh.geometry.attributes.lensOpacity.getX(0), .09); close(mesh.geometry.attributes.lensOpacity.getX(1), .5); });
  f.camera.position.z = -10; f.camera.lookAt(0,0,0); f.camera.updateMatrixWorld();
  capture(f, mesh => { close(endpoints(mesh, 0)[0][2], 2); close(mesh.geometry.attributes.lensOpacity.getX(0), .09); });
  f.detail.dispose();
});

test("retained detail mesh follows updated positions, replaced buffers, movement and zero frames", () => {
  const f = fixture(), object = lines([[[0,0,0],[1,0,0]]]); f.scene.add(object); let first;
  capture(f, mesh => { first = mesh; });
  const position = object.geometry.attributes.position;
  position.setXYZ(1, 0, 2, 0); position.needsUpdate = true;
  capture(f, mesh => { assert.equal(mesh, first); close(endpoints(mesh,0)[1][1], 2); });
  object.geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0,0,-2,0], 3));
  object.position.x = 2;
  capture(f, mesh => { assert.equal(mesh, first); close(endpoints(mesh,0)[1][0], 2); close(endpoints(mesh,0)[1][1], -2); });
  object.geometry.setDrawRange(0,0); capture(f, mesh => assert.equal(mesh, undefined));
  assert.equal(object.visible, true); f.detail.dispose();
});

test("solid shaft and cone become one detailed arrow with their current transformed endpoints", () => {
  const f = fixture(), parent = new THREE.Group(); parent.position.set(1,1,0); parent.rotation.z = Math.PI/2; f.scene.add(parent);
  const shaft = new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1), new THREE.MeshLambertMaterial({color:0x33ff55}), 1);
  const head = new THREE.InstancedMesh(new THREE.ConeGeometry(1,1), shaft.material, 1);
  shaft.name = "prescribed-source-current-shaft"; head.name = "prescribed-source-current-head";
  shaft.userData.lensVectorPart = "shaft"; head.userData.lensVectorPart = "head";
  shaft.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3(0,.75,0), new THREE.Quaternion(), new THREE.Vector3(.05,1.5,.05)));
  head.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3(0,1.75,0), new THREE.Quaternion(), new THREE.Vector3(.25,.5,.25)));
  parent.add(shaft,head);
  capture(f, mesh => {
    assert.equal(mesh.count,1); assert.equal(shaft.visible,false); assert.equal(head.visible,false);
    endpoints(mesh,0).flat().forEach((value,i)=>close(value,[1,1,0,-1,1,0][i]));
  });
  assert.equal(shaft.visible,true); assert.equal(head.visible,true); f.detail.dispose();
});

test("no vector thinning; clipped vectors and arrows crossing the near plane are handled conservatively", () => {
  const f = fixture(), count = 10001;
  const object = lines(Array.from({length:count},()=>[[0,0,0],[1,0,0]])); f.scene.add(object);
  capture(f, mesh => assert.equal(mesh.count,count));
  object.visible = false;
  const outside = lines([[[100,0,0],[101,0,0]]]); f.scene.add(outside);
  capture(f, mesh => assert.equal(mesh,undefined));
  const crossing = lines([[[0,0,13],[0,0,9]]]); f.scene.add(crossing);
  capture(f, mesh => assert.equal(mesh.count,1)); f.detail.dispose();
});

test("palette cones retain their endpoints and individual colours in the detailed lens pass", () => {
  const f = fixture();
  const cone = new THREE.InstancedMesh(new THREE.ConeGeometry(1,1), new THREE.ShaderMaterial(), 1);
  cone.userData.lensVectorPart = "cone";
  cone.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3(1,1,0), new THREE.Quaternion(), new THREE.Vector3(.3,2,.3)));
  const expected = new THREE.Color(.2,.4,.6); cone.setColorAt(0,expected); f.scene.add(cone);
  capture(f, mesh => {
    assert.equal(cone.visible,false);
    endpoints(mesh,0).flat().forEach((value,i)=>close(value,[1,0,0,1,2,0][i]));
    const actual = new THREE.Color(); mesh.getColorAt(0,actual);
    actual.toArray().forEach((v,i)=>close(v,expected.toArray()[i]));
  });
  assert.equal(cone.visible,true); f.detail.dispose(); cone.dispose(); cone.geometry.dispose(); cone.material.dispose();
});
