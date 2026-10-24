import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { meanResultCellSize } from "../src/services/visualization/resultCellSize.js";
import { updateResultCones } from "../src/services/visualization/resultConeVectors.js";
import { resultScalarColor } from "../src/services/visualization/resultScalarColors.js";
import { resultHitVector } from "../src/services/visualization/geometryPicking.js";
import { vectorScene } from "../src/services/results/resultPlots.js";
import { QUANTITIES } from "../src/services/results/resultMappings.js";

const record = { geoType: 2, geo: [12,6,.1], dp: [[6],[1],[3]] };
const vector = (value, size = (2 + 2 + .1) / 3) => ({ origin: [1,2,3], vector: [value,0,0],
  magnitude: Math.abs(value), kind: "magnetization", characteristicSize: 5, meanCellSize: size,
  quantity: "J", unit: "А/мм²" });
const options = { scales: { magnetization: 1 }, maximumMagnitude: { magnetization: 2 },
  sceneDiagonal: 100, displayRange: { minimum: 0, maximum: 2 }, palette: "Rainbow" };
const release = root => root.traverse(o => { o.dispose?.(); o.geometry?.dispose(); o.material?.dispose(); });

test("cone radius uses one third of each element's average EO dimension, including thin strips", () => {
  const expected = (2 + 2 + .1) / 3;
  assert.ok(Math.abs(meanResultCellSize(record) - expected) < 1e-12);
  const frames = [record, { ...record, geo: [24,12,.2] }].map((r, recordIndex) => ({ record: { ...r, recordIndex },
    frame: { values: new Float64Array([0,0,0, 1,0,0, 0,0,0]), stride: 9, count: 1 } }));
  const scene = vectorScene(frames, QUANTITIES.J);
  assert.equal(scene.vectors[0].meanCellSize, expected);
  assert.equal(scene.vectors[1].meanCellSize, expected * 2);
  const root = new THREE.Group(); updateResultCones(THREE, root, [vector(1), vector(-2, 3)], options);
  const mesh = root.children[0], matrix = new THREE.Matrix4();
  for (const [i, radius, length] of [[0, expected/3, 1.75], [1, 1, 3.5]]) {
    mesh.getMatrixAt(i, matrix);
    const base = new THREE.Vector3(0,-.5,0).applyMatrix4(matrix), tip = new THREE.Vector3(0,.5,0).applyMatrix4(matrix);
    assert.ok(base.distanceTo(new THREE.Vector3(1,2,3)) < 1e-6);
    assert.ok(Math.abs(new THREE.Vector3(1,-.5,0).applyMatrix4(matrix).distanceTo(base) - radius) < 1e-6);
    assert.ok(Math.abs(tip.x - base.x - (i ? -length : length)) < 1e-6);
    assert.equal(resultHitVector({object:mesh,instanceId:i}),mesh.userData.resultVectors[i]);
  }
  release(root);
});

test("cone palettes, time frames and zero reuse geometry; all vectors remain present", () => {
  const root = new THREE.Group(), values = [vector(1), vector(2)];
  updateResultCones(THREE, root, values, options);
  const mesh = root.children[0], geometry = mesh.geometry, material = mesh.material, matrices = mesh.instanceMatrix;
  const actual = new THREE.Color(); mesh.getColorAt(0, actual);
  const expected = new THREE.Color().setRGB(...resultScalarColor(1,0,2,"Rainbow"),THREE.SRGBColorSpace);
  actual.toArray().forEach((c,i)=>assert.ok(Math.abs(c - expected.toArray()[i]) < 1e-6));
  for (const frame of [[vector(-1)], [vector(0)], values]) {
    updateResultCones(THREE, root, frame, { ...options, palette: "Viridis" });
    assert.equal(root.children[0], mesh); assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material); assert.equal(mesh.instanceMatrix, matrices);
    assert.equal(mesh.count, frame.filter(v=>v.magnitude>0).length);
  }
  let disposed = 0; mesh.addEventListener("dispose",()=>disposed++);
  updateResultCones(THREE,root,Array.from({length:10001},()=>vector(1)),options);
  assert.equal(root.children[0].count,10001); assert.equal(disposed,1);
  assert.equal(root.children[0].geometry,geometry);
  release(root);
});
