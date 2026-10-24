import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createThinVectorHover, thinVectorSegment } from "../src/services/visualization/thinVectorHover.js";

test("hover adds three CSS pixels only to the chosen thin vector and restores it without changing source buffers", () => {
  const scene = new THREE.Scene(); let frames = 0;
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 0),
  ]), new THREE.LineBasicMaterial({ color: 0xff0000 }));
  lines.userData.resultVectors = [{}, {}]; scene.add(lines);
  const before = lines.geometry.attributes.position.array.slice();
  const hover = createThinVectorHover({ scene, requestRender: () => frames++ });
  hover.set({ object: lines, index: 2 }); hover.resize(400, 300, 1);
  const overlay = scene.getObjectByName("hovered-thin-vector"), geometry = overlay.geometry;
  const buffer = geometry.attributes.instanceStart.data;
  assert.equal(overlay.material.linewidth, 4); assert.equal(geometry.instanceCount, 1);
  assert.deepEqual(Array.from(buffer.array.slice(0, 6)), [0, 1, 0, 1, 1, 0]);
  hover.set({ object: lines, index: 0 });
  assert.equal(overlay.geometry, geometry); assert.equal(geometry.attributes.instanceStart.data, buffer);
  assert.deepEqual(lines.geometry.attributes.position.array, before);
  hover.resize(400, 300, 2); assert.equal(overlay.material.linewidth, 3.5);
  hover.clear(); assert.equal(overlay.visible, false);
  hover.dispose(); assert.equal(scene.children.length, 1); assert.ok(frames >= 3);
  assert.equal(thinVectorSegment({ object: lines, index: 4 }), null);
});


test("hovering any shaft/head segment highlights the whole vector at DPR 2", () => {
  const scene = new THREE.Scene(), geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 10,0,0, 10,0,0, 8,1,0, 10,0,0, 8,-1,0],3));
  const vector = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial());
  vector.userData.resultVectors = [{}]; vector.userData.segmentsPerVector = 3; scene.add(vector);
  const hover = createThinVectorHover({ scene, requestRender() {} }); hover.resize(800, 500, 2);
  for (const index of [0, 2, 4]) {
    hover.set({ object: vector, index });
    const overlay = scene.getObjectByName("hovered-thin-vector");
    assert.equal(overlay.geometry.instanceCount, 3); assert.equal(overlay.material.linewidth, 3.5);
  }
  hover.dispose(); geometry.dispose(); vector.material.dispose();
});

test("hover keeps the palette color of the selected normalized vector", () => {
  const scene = new THREE.Scene(), geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 1,1,0],3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute([.1,.2,.3, .1,.2,.3, .7,.8,.9, .7,.8,.9],3));
  const object = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, color: 0xffffff }));
  object.userData.resultVectors = [{}, {}]; scene.add(object);
  const hover = createThinVectorHover({ scene, requestRender() {} }); hover.set({ object, index: 2 });
  const color = scene.getObjectByName("hovered-thin-vector").material.color;
  color.toArray().forEach((v, i) => assert.ok(Math.abs(v - [.7,.8,.9][i]) < 1e-6));
  hover.dispose(); geometry.dispose(); object.material.dispose();
});
