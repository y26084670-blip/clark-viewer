import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { disposeSurfaceObject, surfaceMovieLimits, updateSurfaceLabel, updateSurfaceMesh } from "../src/services/visualization/surfaceChartResources.js";

const grid = (values, width = 2, height = 2) => ({ width, height, values: new Float64Array(values) });

test("surface time frames reuse the mesh, material, topology and GPU buffers", () => {
  const surface = updateSurfaceMesh(null, grid([1, 2, 3, 5]));
  const geometry = surface.geometry, material = surface.material;
  const position = geometry.getAttribute("position"), color = geometry.getAttribute("color"), index = geometry.index;
  let disposed = 0;
  geometry.addEventListener("dispose", () => disposed++); material.addEventListener("dispose", () => disposed++);
  for (const values of [[0, 0, 0, 0], [-10, 5, 20, 40], [5, 3, 2, 1]]) {
    assert.equal(updateSurfaceMesh(surface, grid(values)), surface);
    assert.equal(surface.geometry, geometry); assert.equal(surface.material, material);
    assert.equal(geometry.getAttribute("position"), position); assert.equal(geometry.getAttribute("color"), color);
    assert.equal(geometry.index, index); assert.equal(disposed, 0);
    assert.deepEqual(surface.userData.limits, { min: Math.min(...values), max: Math.max(...values) });
    assert.ok([...position.array, ...color.array].every(Number.isFinite));
  }
  assert.equal(position.getZ(0), 1.5); assert.equal(position.getZ(3), 0);
  assert.ok(position.version >= 4 && color.version >= 4);
  disposeSurfaceObject(surface); assert.equal(disposed, 2);
});

test("surface bounds and picking follow the latest values without a camera reset", () => {
  const surface = updateSurfaceMesh(null, grid([0, 0, 0, 0]));
  const camera = new THREE.PerspectiveCamera(40, 1, .01, 100);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const saved = camera.matrixWorld.clone(), ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0), camera);
  assert.equal(surface.geometry.boundingBox.max.z, 0);
  updateSurfaceMesh(surface, grid([0, 1, 1, 1])); surface.updateMatrixWorld();
  assert.equal(surface.geometry.boundingBox.max.z, 1.5);
  assert.ok(ray.intersectObject(surface)[0]?.point.z > 1);
  assert.deepEqual(camera.matrixWorld.elements, saved.elements);
  updateSurfaceMesh(surface, grid([0, 0, 0, 0]));
  assert.equal(surface.geometry.boundingBox.max.z, 0);
  assert.equal(ray.intersectObject(surface)[0]?.point.z, 0);
  disposeSurfaceObject(surface);
});

test("surface topology changes release only the old geometry and reject invalid frames intact", () => {
  const surface = updateSurfaceMesh(null, grid([1, 2, 3, 4]));
  const oldGeometry = surface.geometry, material = surface.material;
  let geometryDisposals = 0, materialDisposals = 0;
  oldGeometry.addEventListener("dispose", () => geometryDisposals++);
  material.addEventListener("dispose", () => materialDisposals++);
  updateSurfaceMesh(surface, grid([1, 2, 3, 4, 5, 6], 2, 3));
  assert.notEqual(surface.geometry, oldGeometry); assert.equal(surface.material, material);
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 0);
  assert.equal(surface.geometry.index.count, 12);
  const validGeometry = surface.geometry;
  assert.throws(() => updateSurfaceMesh(surface, grid([1, NaN, 3, 4])), /нечисловые/);
  assert.throws(() => updateSurfaceMesh(surface, grid([1, 2], 1, 2)), /сетк/);
  assert.equal(surface.geometry, validGeometry);
  disposeSurfaceObject(surface);
});

test("surface labels retain sprites, material and texture and repaint only changed text", () => {
  const writes = [], clears = [], context = { fillText: text => writes.push(text), clearRect: (...args) => clears.push(args) };
  const canvas = { getContext: () => context };
  let created = 0;
  const createCanvas = () => { created++; return canvas; };
  const sprite = updateSurfaceLabel(null, "i1: 1 … 10", new THREE.Vector3(1, 2, 3), createCanvas);
  const material = sprite.material, texture = material.map, version = texture.version;
  let disposed = 0;
  material.addEventListener("dispose", () => disposed++); texture.addEventListener("dispose", () => disposed++);
  assert.equal(updateSurfaceLabel(sprite, "i1: 1 … 10", new THREE.Vector3(3, 2, 1), createCanvas), sprite);
  assert.equal(texture.version, version); assert.equal(writes.length, 1);
  updateSurfaceLabel(sprite, "i1: 1 … 20", new THREE.Vector3(1, 2, 3), createCanvas);
  assert.equal(sprite.material, material); assert.equal(sprite.material.map, texture);
  assert.equal(created, 1); assert.equal(writes.length, 2); assert.equal(clears.length, 2);
  assert.equal(disposed, 0); assert.ok(texture.version > version);
  disposeSurfaceObject(sprite); assert.equal(disposed, 2);
});

test("movie surface keeps its original numerical scale and restores auto scaling afterwards", () => {
  const surface = updateSurfaceMesh(null, grid([0, 2, 4, 6]));
  const fixed = { ...surface.userData.limits }, geometry = surface.geometry, material = surface.material;
  const firstColor = Array.from(geometry.getAttribute("color").array.slice(3, 6));
  updateSurfaceMesh(surface, grid([-3, 2, 8, 12]), fixed);
  assert.deepEqual(surface.userData.limits, { min: 0, max: 6 });
  assert.equal(surface.geometry, geometry); assert.equal(surface.material, material);
  assert.deepEqual(Array.from(geometry.getAttribute("color").array.slice(3, 6)), firstColor,
    "the same physical value retains its color between frames");
  const positions = geometry.getAttribute("position");
  assert.equal(positions.getZ(0), -.75);
  assert.equal(positions.getZ(1), .5);
  assert.equal(positions.getZ(3), 3, "out-of-range values retain their physical height instead of being clipped");
  updateSurfaceMesh(surface, grid([-3, 2, 8, 12]));
  assert.deepEqual(surface.userData.limits, { min: -3, max: 12 });
  assert.equal(positions.getZ(0), 0); assert.equal(positions.getZ(3), 1.5);
  assert.throws(() => updateSurfaceMesh(surface, grid([1, 2, 3, 4]), { min: 5, max: 2 }), /фиксированная/);
  disposeSurfaceObject(surface);
});

for (const initial of [0, 4, -4]) test(`flat surface ${initial} keeps the same height/color span throughout a movie`, () => {
  const surface = updateSurfaceMesh(null, grid(Array(4).fill(initial)));
  const positions = surface.geometry.getAttribute("position"), colors = surface.geometry.getAttribute("color");
  const initialPositions = Array.from(positions.array), initialColors = Array.from(colors.array);
  const span = Math.max(Math.abs(initial), 1), fixed = surfaceMovieLimits(surface.userData.limits);
  assert.deepEqual(fixed, { min: initial, max: initial + span });
  updateSurfaceMesh(surface, grid(Array(4).fill(initial)), fixed);
  assert.deepEqual(Array.from(positions.array), initialPositions, "freezing does not move the initial flat surface");
  assert.deepEqual(Array.from(colors.array), initialColors, "freezing does not recolor the initial flat surface");
  updateSurfaceMesh(surface, grid([initial, initial + span / 2, initial + span, initial + span * 2]), fixed);
  assert.deepEqual(surface.userData.limits, fixed);
  assert.deepEqual([0, 1, 2, 3].map(index => positions.getZ(index)), [0, .75, 1.5, 3]);
  updateSurfaceMesh(surface, grid(Array(4).fill(initial)));
  assert.deepEqual(surface.userData.limits, { min: initial, max: initial });
  assert.deepEqual(Array.from(positions.array), initialPositions);
  disposeSurfaceObject(surface);
});
