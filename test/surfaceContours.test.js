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

test("only the lower plane is projected, with matching footprint, a gap and no contours", () => {
  const values = [0, 1, 2, 3], mesh = updateSurfaceMesh(null, { width: 2, height: 2, values,
    coordinates: [0,0,0, 0,3,0, 12,0,0, 12,3,0] });
  const original = mesh.geometry.attributes.position.array.slice();
  const group = updateSurfaceDecorations(null, mesh, values, { isolines: 3 });
  assert.equal(group.children.length, 2);
  const projection = group.children[1], projectedGeometry = projection.getObjectByName("projection").geometry;
  const p = projectedGeometry.attributes.position;
  assert.equal(projectedGeometry.drawRange.count, mesh.geometry.index.count);
  assert.equal(projection.children.length, 1);
  assert.equal(projection.getObjectByName("isolines"), undefined);
  for (let i = 0; i < p.count; i++) {
    assert.equal(p.getX(i), original[3 * i]); assert.equal(p.getY(i), original[3 * i + 1]);
    assert.ok(Math.abs(p.getZ(i) + 1.5) < 1e-6);
  }
  assert.equal(group.getObjectByName("extrema").geometry.drawRange.count, 2);
  assert.equal(group.getObjectByName("extrema").material.size, 2);
  const geometry = group.children[0].getObjectByName("isolines").geometry;
  updateSurfaceDecorations(group, mesh, values, { isolines: 2 });
  assert.equal(group.children[0].getObjectByName("isolines").geometry, geometry);
  assert.equal(projection.visible, true);
  assert.equal(projection.getObjectByName("projection").geometry, projectedGeometry);
  assert.deepEqual(mesh.geometry.attributes.position.array, original);
  // Changing time must update the full-strength projection palette as well
  // as the height plot, while retaining its indexed geometry.
  const nextValues = [3, 2, 1, 0];
  updateSurfaceMesh(mesh, { width: 2, height: 2, values: nextValues,
    coordinates: [0,0,0, 0,3,0, 12,0,0, 12,3,0] });
  updateSurfaceDecorations(group, mesh, nextValues, { isolines: 2 });
  assert.equal(projection.getObjectByName("projection").geometry, projectedGeometry);
  assert.deepEqual(projectedGeometry.attributes.color.array, mesh.geometry.attributes.color.array);
  assert.equal(projectedGeometry.drawRange.count, mesh.geometry.index.count);
  let disposed = 0; group.traverse(object => object.material?.map?.addEventListener("dispose", () => disposed++));
  disposeSurfaceObject(group); disposeSurfaceObject(mesh); assert.equal(disposed, 1);
});

test("the lower plane keeps a gap through flat, signed and shared-range frames", () => {
  let mesh, group;
  for (const values of [[0,0,0,0], [-4,-3,-2,-1], [5,6,7,8]]) {
    mesh = updateSurfaceMesh(mesh, { width: 2, height: 2, values, displayRange: { minimum: -10, maximum: 10 } });
    group = updateSurfaceDecorations(group, mesh, values, { isolines: 2 });
    const p = group.getObjectByName("projection").geometry.attributes.position;
    for (let i = 0; i < p.count; i++) assert.ok(Math.abs(mesh.geometry.boundingBox.min.z - p.getZ(i) - 1.5) < 1e-6);
  }
  disposeSurfaceObject(group); disposeSurfaceObject(mesh);
});


test("shared colour/height limits do not erase an individual component's endpoint contours", () => {
  const values = [2, 3, 4, 5];
  const mesh = updateSurfaceMesh(null, { width: 2, height: 2, values, displayRange: { minimum: -10, maximum: 10 } });
  const result = surfaceContours(mesh, values, 2);
  assert.deepEqual(result.levels, [2, 5]); assert.equal(result.points.length, 6);
  assert.deepEqual(mesh.userData.limits, { min: -10, max: 10 }); disposeSurfaceObject(mesh);
});
