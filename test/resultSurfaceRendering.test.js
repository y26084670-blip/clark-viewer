import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { buildResultSurfaceField } from "../src/services/visualization/resultSurfaceField.js";
import { updateResultSurfaceMeshes, disposeResultSurfaceMesh } from "../src/services/visualization/resultSurfaceRenderer.js";
import { RESULT_SCALAR_PALETTES, resultScalarColor } from "../src/services/visualization/resultScalarColors.js";

function field({ key = "regions:0:0:0:0", n1 = 2, n2 = 2, offset = 0, values = null } = {}) {
  const positions = [];
  for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) positions.push(offset + i * 4, offset + j * 6, offset + 7);
  return buildResultSurfaceField({ domains: [{ key, source: { schemaId: "regions", recordIndex: 0 },
    instance: { ls: 0, as: 0, ps: 0 }, dimensions: [n1, n2, 1], positions: new Float64Array(positions),
    values: new Float64Array(values ?? positions.filter((_, index) => index % 3 === 0).map((_, index) => index)), points: [] }] }).surfaces[0];
}

test("surface meshes render exact zero-thickness geometry from both sides but never raycast interpolated positions", () => {
  const root = new THREE.Group(), surface = field({ offset: 1e12 });
  updateResultSurfaceMeshes(THREE, root, [surface], { minimum: 0, maximum: 3, opacity: 0.42 });
  const mesh = root.children[0];
  assert.equal(mesh.name, "result-surface-domain"); assert.equal(mesh.userData.field, surface);
  assert.equal(mesh.material.side, THREE.DoubleSide); assert.equal(mesh.material.depthWrite, false);
  assert.equal(mesh.material.transparent, true); assert.equal(mesh.material.uniforms.uOpacity.value, 0.42);
  assert.equal(mesh.geometry.getAttribute("position").count, surface.values.length);
  assert.deepEqual([...mesh.geometry.index.array], [...surface.indices]);
  const position = mesh.geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const world = new THREE.Vector3().fromBufferAttribute(position, i).add(mesh.position).toArray();
    assert.deepEqual(world, [...surface.positions.subarray(i * 3, i * 3 + 3)]);
  }
  assert.equal(mesh.geometry.boundingBox.min.z, mesh.geometry.boundingBox.max.z);
  assert.equal(mesh.geometry.boundingBox.max.x - mesh.geometry.boundingBox.min.x, 4, "Float32 must retain local detail at large world coordinates");
  root.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(1e12 + 2, 1e12 + 3, 1e12 + 100), new THREE.Vector3(0, 0, -1));
  assert.deepEqual(raycaster.intersectObject(mesh), [], "hover targets belong to saved nodes only");
  disposeResultSurfaceMesh(mesh);
});

test("time/palette/opacity updates preserve mesh, geometry, material and palette ownership", () => {
  const root = new THREE.Group(), first = field();
  updateResultSurfaceMeshes(THREE, root, [first], { minimum: 0, maximum: 3 });
  const mesh = root.children[0], geometry = mesh.geometry, material = mesh.material;
  const palette = material.uniforms.uPalette.value, position = geometry.getAttribute("position"), scalar = geometry.getAttribute("aScalar");
  const indexVersion = geometry.index.version, positionVersion = position.version, scalarVersion = scalar.version, paletteVersion = palette.version;
  const oldLut = [...palette.image.data];
  updateResultSurfaceMeshes(THREE, root, [first], { minimum: 0, maximum: 3, palette: "Inferno", opacity: 0 });
  assert.equal(root.children[0], mesh); assert.equal(mesh.geometry, geometry); assert.equal(mesh.material, material);
  assert.equal(material.uniforms.uPalette.value, palette); assert.equal(material.uniforms.uOpacity.value, 0);
  assert.equal(position.version, positionVersion); assert.equal(scalar.version, scalarVersion);
  assert.notDeepEqual([...palette.image.data], oldLut); assert.ok(palette.version > paletteVersion);
  const next = field({ values: [2, 3, 4, 5] });
  updateResultSurfaceMeshes(THREE, root, [next], { minimum: 0, maximum: 10, palette: "Inferno", opacity: 0.8 });
  assert.equal(root.children[0], mesh); assert.equal(mesh.geometry, geometry); assert.equal(mesh.material, material);
  assert.equal(geometry.index.version, indexVersion, "unchanged topology is not reuploaded for a time step");
  assert.ok(position.version > positionVersion); assert.ok(scalar.version > scalarVersion);
  [...scalar.array].forEach((value, index) => assert.ok(Math.abs(value - [0.2, 0.3, 0.4, 0.5][index]) < 1e-7));
  assert.equal(mesh.userData.field, next);
  let disposed = 0;
  for (const resource of [geometry, material, palette]) resource.addEventListener("dispose", () => disposed++);
  const unrelated = new THREE.Group(); root.add(unrelated);
  updateResultSurfaceMeshes(THREE, root, [], { minimum: 0, maximum: 10 });
  assert.equal(disposed, 3); assert.deepEqual(root.children, [unrelated]);
});

test("GPU scalar interpolation precedes palette lookup; range changes retain geometry and unclamped vertex values", () => {
  const root = new THREE.Group(), surface = field({ values: [-10, 0, 10, 30] });
  updateResultSurfaceMeshes(THREE, root, [surface], { minimum: 0, maximum: 10 });
  const mesh = root.children[0], position = mesh.geometry.getAttribute("position"), scalar = mesh.geometry.getAttribute("aScalar");
  assert.deepEqual([...scalar.array], [-1, 0, 1, 3]);
  assert.equal(mesh.geometry.getAttribute("color"), undefined, "interpolating RGB would distort the transfer function");
  assert.match(mesh.material.vertexShader, /vScalar = aScalar/);
  assert.match(mesh.material.fragmentShader, /clamp\(vScalar, 0\.0, 1\.0\)/);
  assert.match(mesh.material.fragmentShader, /texture2D\(uPalette/);
  const center = (scalar.array[0] + scalar.array[2] + scalar.array[3]) / 3;
  assert.equal(center, 1, "linear scalar centroid differs from prematurely clamped vertices");
  const version = position.version;
  updateResultSurfaceMeshes(THREE, root, [surface], { minimum: -10, maximum: 30 });
  assert.deepEqual([...scalar.array], [0, 0.25, 0.5, 1]); assert.equal(position.version, version);
  for (const name of RESULT_SCALAR_PALETTES) {
    updateResultSurfaceMeshes(THREE, root, [surface], { minimum: -10, maximum: 30, palette: name });
    const texture = mesh.material.uniforms.uPalette.value;
    assert.equal(texture.magFilter, THREE.LinearFilter); assert.equal(texture.image.width, 256);
    for (const index of [0, 17, 128, 255]) {
      assert.deepEqual([...texture.image.data.subarray(index * 4, index * 4 + 4)],
        [...resultScalarColor(index, 0, 255, name).map(value => Math.round(value * 255)), 255]);
    }
  }
  disposeResultSurfaceMesh(mesh);
});

test("constant zero surfaces and extreme signed ranges retain finite scalar attributes", () => {
  const root = new THREE.Group();
  for (const value of [0, 13, -3]) {
    const surface = field({ values: Array(4).fill(value) });
    updateResultSurfaceMeshes(THREE, root, [surface], { minimum: value, maximum: value });
    assert.ok(root.children[0].geometry.getAttribute("aScalar").array.every(v => v === 0.5));
  }
  const surface = field({ values: [-Number.MAX_VALUE, 0, 0, Number.MAX_VALUE] });
  updateResultSurfaceMeshes(THREE, root, [surface], { minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
  assert.deepEqual([...root.children[0].geometry.getAttribute("aScalar").array], [0, 0.5, 0.5, 1]);
  disposeResultSurfaceMesh(root.children[0]);
});

test("topology resizing replaces only geometry and independent surfaces own separate palettes", () => {
  const root = new THREE.Group(), first = field(), second = field({ key: "regions:0:1:0:0", offset: 20 });
  updateResultSurfaceMeshes(THREE, root, [first, second], { minimum: 0, maximum: 3 });
  const mesh = root.children[0], other = root.children[1], geometry = mesh.geometry, material = mesh.material, palette = material.uniforms.uPalette.value;
  assert.notEqual(palette, other.material.uniforms.uPalette.value);
  let freed = 0; geometry.addEventListener("dispose", () => freed++);
  updateResultSurfaceMeshes(THREE, root, [field({ n1: 3 }), second], { minimum: 0, maximum: 5 });
  assert.equal(root.children[0], mesh); assert.equal(root.children[1], other); assert.equal(freed, 1);
  assert.notEqual(mesh.geometry, geometry); assert.equal(mesh.material, material); assert.equal(material.uniforms.uPalette.value, palette);
  assert.equal(mesh.geometry.getAttribute("position").count, 6); assert.equal(mesh.geometry.index.count, 12);
  updateResultSurfaceMeshes(THREE, root, [], { minimum: 0, maximum: 5 });
});
