import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { RESULT_SCALAR_PALETTES, resultScalarColor, resultScalarLegendBackground } from "../src/services/visualization/resultScalarColors.js";
import { updateResultVolumeMeshes, disposeResultVolumeMesh } from "../src/services/visualization/resultVolumeRenderer.js";

function domain(key = "element:1:0:0:0") {
  return { key, dimensions: [4, 4, 4], bounds: { min: [10, 20, 30], max: [12, 24, 36] },
    values: new Float32Array(64).fill(0.5), mask: new Uint8Array(64).fill(1), revision: 1 };
}

test("five palettes use one shared transfer function for points, volumes and legends", () => {
  assert.deepEqual(RESULT_SCALAR_PALETTES, ["Rainbow", "Viridis", "Inferno", "Plasma", "Turbo"]);
  const midpoints = new Set();
  for (const palette of RESULT_SCALAR_PALETTES) {
    for (const value of [-1, 0, 0.001, 0.5, 1, 2]) {
      const rgb = resultScalarColor(value, 0, 1, palette);
      assert.ok(rgb.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1));
    }
    midpoints.add(resultScalarColor(0.5, 0, 1, palette).join(","));
    assert.deepEqual(resultScalarColor(0, 0, 0, palette), resultScalarColor(0.5, 0, 1, palette));
    assert.match(resultScalarLegendBackground(0, 1, palette), /^linear-gradient/);
    assert.doesNotMatch(resultScalarLegendBackground(0, 0, palette), /gradient/);
  }
  assert.equal(midpoints.size, 5);
  assert.deepEqual(resultScalarColor(0, 0, 1, "Rainbow"), [0, 0, 1]);
  assert.deepEqual(resultScalarColor(1, 0, 1, "Rainbow"), [1, 0, 0]);
});

test("volume textures/materials/proxies survive time, palette and opacity changes", () => {
  const root = new THREE.Group(), field = domain();
  updateResultVolumeMeshes(THREE, root, [field], { minimum: 0, maximum: 1, opacity: 0.42 });
  const mesh = root.children[0], material = mesh.material, texture = material.uniforms.uField.value;
  const palette = material.uniforms.uPalette.value, data = texture.image.data;
  assert.ok(texture.isData3DTexture);
  assert.deepEqual(mesh.position.toArray(), [11, 22, 33]);
  assert.deepEqual(mesh.scale.toArray(), [2, 4, 6]);
  assert.equal(material.uniforms.uOpacity.value, 0.42);
  assert.equal(material.depthWrite, false);
  assert.equal(material.side, THREE.BackSide);
  assert.equal(data[0], 128);
  const version = texture.version;
  const oldPalette = [...palette.image.data];
  updateResultVolumeMeshes(THREE, root, [field], { minimum: 0, maximum: 1, palette: "Inferno", opacity: 0 });
  assert.equal(root.children[0], mesh);
  assert.equal(mesh.material, material);
  assert.equal(material.uniforms.uField.value, texture);
  assert.equal(texture.version, version, "palette-only updates must not rewrite 3D voxels");
  assert.notDeepEqual([...palette.image.data], oldPalette);
  assert.equal(material.uniforms.uOpacity.value, 0);
  field.values.fill(0.75); field.mask[0] = 0; field.revision++;
  updateResultVolumeMeshes(THREE, root, [field], { minimum: 0, maximum: 1 });
  assert.equal(texture.image.data, data);
  assert.equal(data[0], 0); assert.equal(data[3], 0);
  assert.equal(data[4], 191); assert.equal(data[7], 255);
  let freed = 0;
  for (const object of [mesh.geometry, material, texture, palette]) object.addEventListener("dispose", () => freed++);
  updateResultVolumeMeshes(THREE, root, [], { minimum: 0, maximum: 1 });
  assert.equal(root.children.length, 0);
  assert.equal(freed, 4);
});

test("constant zero volume retains nonzero support and domains never share textures", () => {
  const root = new THREE.Group(), first = domain("first"), second = domain("second");
  first.values.fill(0); second.values.fill(0);
  updateResultVolumeMeshes(THREE, root, [first, second], { minimum: 0, maximum: 0 });
  assert.equal(root.children.length, 2);
  const textures = root.children.map(mesh => mesh.material.uniforms.uField.value);
  assert.notEqual(textures[0], textures[1]);
  for (const texture of textures) {
    assert.equal(texture.image.data[0], 128);
    assert.equal(texture.image.data[3], 255);
  }
  root.children.forEach(disposeResultVolumeMesh);
});

test("volume camera transform is correct for both projections and a camera inside the volume", () => {
  const root = new THREE.Group(), field = domain();
  updateResultVolumeMeshes(THREE, root, [field], { minimum: 0, maximum: 1 });
  root.updateMatrixWorld(true);
  const mesh = root.children[0];
  const renderer = { getCurrentViewport: target => target.set(0, 0, 800, 600) };
  for (const camera of [new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100), new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100)]) {
    for (const z of [50, 33]) {
      camera.position.set(11, 22, z); camera.lookAt(11, 22, 30); camera.updateMatrixWorld(true);
      mesh.onBeforeRender(renderer, null, camera);
      const forward = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
      const point = new THREE.Vector4(0.1, 0.2, 0.3, 1).applyMatrix4(forward).applyMatrix4(mesh.material.uniforms.uClipToLocal.value);
      assert.ok(point.toArray().every((value, index) => Math.abs(value - [0.1, 0.2, 0.3, 1][index]) < 1e-10));
    }
  }
  disposeResultVolumeMesh(mesh);
});
