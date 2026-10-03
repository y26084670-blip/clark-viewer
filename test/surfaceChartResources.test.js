import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { disposeSurfaceObject, updateSurfaceLabel, updateSurfaceMesh } from "../src/services/visualization/surfaceChartResources.js";

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

test("surface automatic range follows zero, large, tiny and signed frames without reallocating buffers", () => {
  const surface = updateSurfaceMesh(null, grid([0, 0, 0, 0]));
  const geometry = surface.geometry, material = surface.material;
  const positions = geometry.getAttribute("position"), colors = geometry.getAttribute("color");
  for (const values of [[0, 1000, 250, 500], [0, 1e-9, 2.5e-10, 5e-10], [-1000, 1000, -500, 0], [0, 0, 0, 0]]) {
    updateSurfaceMesh(surface, grid(values));
    assert.equal(surface.geometry, geometry); assert.equal(surface.material, material);
    const min = Math.min(...values), max = Math.max(...values);
    assert.deepEqual(surface.userData.limits, { min, max });
    const span = max - min || Math.max(Math.abs(min), 1);
    values.forEach((value, index) => {
      const fraction = (value - min) / span;
      assert.ok(Math.abs(positions.getZ(index) - fraction * 1.5) < 1e-6);
      const expected = new THREE.Color().setHSL(.66 * (1 - fraction), .9, .48).toArray();
      expected.forEach((component, axis) => assert.ok(Math.abs(colors.array[index * 3 + axis] - component) < 1e-6));
    });
    assert.equal(geometry.boundingBox.min.z, 0);
    assert.equal(geometry.boundingBox.max.z, max > min ? 1.5 : 0);
  }
  disposeSurfaceObject(surface);
});
