import test from "node:test";
import assert from "node:assert/strict";
import { updateSurfaceMesh, disposeSurfaceObject } from "../src/services/visualization/surfaceChartResources.js";
import { contourLevels, surfaceContours, updateSurfaceDecorations } from "../src/services/visualization/surfaceContours.js";

test("isoline counts include endpoints and constant surfaces have one boundary, no diagonal", () => {
  assert.deepEqual(contourLevels(-2, 6, 0), []);
  assert.deepEqual(contourLevels(-2, 6, 1), [-2]);
  assert.deepEqual(contourLevels(-2, 6, 2), [-2, 6]);
  assert.deepEqual(contourLevels(-2, 6, 5), [-2, 0, 2, 4, 6]);
  assert.deepEqual(contourLevels(0, 0, 8), [0]);
  const values = [3, 3, 3, 3], mesh = updateSurfaceMesh(null, { width: 2, height: 2, values });
  const result = surfaceContours(mesh, values, 5);
  assert.equal(result.lines.length / 6, 4); assert.equal(result.points.length, 0);
  disposeSurfaceObject(mesh);
});

test("isolated minimum and maximum are points; intermediate contours follow triangles even for tiny fields", () => {
  for (const scale of [1, 1e-30]) {
    const values = [0, 1, 2, 3].map(x => x * scale);
    const mesh = updateSurfaceMesh(null, { width: 2, height: 2, values });
    assert.deepEqual(surfaceContours(mesh, values, 0), { levels: [], lines: [], points: [] });
    assert.equal(surfaceContours(mesh, values, 1).points.length, 3);
    const ends = surfaceContours(mesh, values, 2); assert.equal(ends.points.length, 6); assert.equal(ends.lines.length, 0);
    const middle = surfaceContours(mesh, values, 3); assert.equal(middle.lines.length, 12);
    assert.ok(middle.lines.every(Number.isFinite)); disposeSurfaceObject(mesh);
  }
});

test("all three projected planes share raw values, preserve buffers and dispose their textures", () => {
  const values = [0, 1, 2, 3], mesh = updateSurfaceMesh(null, { width: 2, height: 2, values });
  const original = mesh.geometry.attributes.position.array.slice();
  const group = updateSurfaceDecorations(null, mesh, values, { isolines: 3 });
  assert.equal(group.children.length, 4);
  for (const [index, axis, constant] of [[1, 2, -.04], [2, 1, 1.04], [3, 0, -1.04]]) {
    const layer = group.children[index], p = layer.getObjectByName("projection").geometry.attributes.position;
    for (let i = 0; i < p.count; i++) assert.ok(Math.abs(p.array[i * 3 + axis] - constant) < 1e-6);
    assert.equal(layer.getObjectByName("extrema").geometry.drawRange.count, 2);
  }
  const geometry = group.children[0].getObjectByName("isolines").geometry;
  updateSurfaceDecorations(group, mesh, values, { projections: false, isolines: 2 });
  assert.equal(group.children[0].getObjectByName("isolines").geometry, geometry);
  assert.ok(group.children.slice(1).every(layer => !layer.visible));
  assert.deepEqual(mesh.geometry.attributes.position.array, original);
  let disposed = 0; group.traverse(object => object.material?.map?.addEventListener("dispose", () => disposed++));
  disposeSurfaceObject(group); disposeSurfaceObject(mesh); assert.equal(disposed, 4);
});


test("shared colour/height limits do not erase an individual component's endpoint contours", () => {
  const values = [2, 3, 4, 5];
  const mesh = updateSurfaceMesh(null, { width: 2, height: 2, values, displayRange: { minimum: -10, maximum: 10 } });
  const result = surfaceContours(mesh, values, 2);
  assert.deepEqual(result.levels, [2, 5]); assert.equal(result.points.length, 6);
  assert.deepEqual(mesh.userData.limits, { min: -10, max: 10 }); disposeSurfaceObject(mesh);
});
