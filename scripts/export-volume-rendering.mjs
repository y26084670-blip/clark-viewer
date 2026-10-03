// Optional EGL check input. Run through verify-volume-rendering.py.
// This uses the production shader and palette textures. The small prefix is
// the ShaderMaterial WebGL2 conversion used by Three.js, not a replacement ray
// marcher. It does not exercise WebGLRenderer initialization or the DOM.
import * as THREE from "three";
import { RESULT_SCALAR_PALETTES } from "../src/services/visualization/resultScalarColors.js";
import {
  RESULT_VOLUME_VERTEX_SHADER, RESULT_VOLUME_FRAGMENT_SHADER,
  updateResultVolumeMeshes, disposeResultVolumeMesh,
} from "../src/services/visualization/resultVolumeRenderer.js";

const vertex = `#version 300 es
#define attribute in
#define varying out
#define texture2D texture
precision highp float;
precision highp int;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
in vec3 position;
${RESULT_VOLUME_VERTEX_SHADER}`;
const fragment = `#version 300 es
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
precision highp float;
precision highp int;
${THREE.ShaderChunk.colorspace_pars_fragment}
vec4 linearToOutputTexel(vec4 value) { return sRGBTransferOETF(value); }
${RESULT_VOLUME_FRAGMENT_SHADER.replace("#include <colorspace_fragment>", THREE.ShaderChunk.colorspace_fragment)}`;

const cameras = [];
for (const [name, projection, z, near] of [
  ["orthographic", "orthographic", 2, 0.1],
  ["perspective", "perspective", 2, 0.1],
  ["camera-inside", "perspective", 0, 0.1],
  ["near-plane-cut", "perspective", 0.7, 0.5],
]) {
  const camera = projection === "orthographic"
    ? new THREE.OrthographicCamera(-0.6, 0.6, 0.6, -0.6, near, 10)
    : new THREE.PerspectiveCamera(45, 1, near, 10);
  camera.position.set(0, 0, z);
  camera.lookAt(0, 0, z - 1);
  camera.updateMatrixWorld();
  const inverse = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  const origin = new THREE.Vector3(1 / 32, 1 / 32, -1).applyMatrix4(inverse);
  const direction = new THREE.Vector3(1 / 32, 1 / 32, 1).applyMatrix4(inverse).sub(origin).normalize();
  let enter = 0, leave = Infinity;
  for (const axis of ["x", "y", "z"]) {
    if (Math.abs(direction[axis]) < 1e-12) continue;
    const a = (-0.5 - origin[axis]) / direction[axis];
    const b = (0.5 - origin[axis]) / direction[axis];
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
  }
  cameras.push({ name, projection: camera.projectionMatrix.toArray(),
    modelView: camera.matrixWorldInverse.toArray(), clipToLocal: inverse.toArray(),
    centerPathLength: Math.max(0, leave - enter) });
}

const root = new THREE.Group();
const domain = { key: "verification", bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
  dimensions: [2, 2, 2], values: new Float32Array(8).fill(0.5), mask: new Uint8Array(8).fill(255) };
const palettes = RESULT_SCALAR_PALETTES.map(name => {
  updateResultVolumeMeshes(THREE, root, [domain], { minimum: 0, maximum: 1, palette: name });
  const texture = root.children[0].material.uniforms.uPalette.value;
  return { name, colorSpace: texture.colorSpace, bytes: Array.from(texture.image.data) };
});
const geometry = root.children[0].geometry.toNonIndexed();
const positions = Array.from(geometry.getAttribute("position").array);
geometry.dispose();
for (const mesh of root.children) disposeResultVolumeMesh(mesh);
process.stdout.write(JSON.stringify({ vertex, fragment, positions, cameras, palettes }));
