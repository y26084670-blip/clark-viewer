import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createThinVectorHover, thinVectorSegment } from "../src/services/visualization/thinVectorHover.js";

test("hover doubles only the chosen thin vector and restores it without changing source buffers", () => {
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
  assert.equal(overlay.material.linewidth, 2); assert.equal(geometry.instanceCount, 1);
  assert.deepEqual(Array.from(buffer.array.slice(0, 6)), [0, 1, 0, 1, 1, 0]);
  hover.set({ object: lines, index: 0 });
  assert.equal(overlay.geometry, geometry); assert.equal(geometry.attributes.instanceStart.data, buffer);
  assert.deepEqual(lines.geometry.attributes.position.array, before);
  hover.resize(400, 300, 2); assert.equal(overlay.material.linewidth, 1);
  hover.clear(); assert.equal(overlay.visible, false);
  hover.dispose(); assert.equal(scene.children.length, 1); assert.ok(frames >= 3);
  assert.equal(thinVectorSegment({ object: lines, index: 4 }), null);
});
