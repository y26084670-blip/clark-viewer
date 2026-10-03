import { normalizeResultPalette, resultScalarColor } from "./resultScalarColors.js";

export const RESULT_SURFACE_VERTEX_SHADER = `
attribute float aScalar;
varying float vScalar;
void main() {
  vScalar = aScalar;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
export const RESULT_SURFACE_FRAGMENT_SHADER = `
uniform sampler2D uPalette;
uniform float uOpacity;
varying float vScalar;
void main() {
  if (uOpacity <= 0.0) discard;
  float value = clamp(vScalar, 0.0, 1.0);
  vec3 color = texture2D(uPalette, vec2((value * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  gl_FragColor = vec4(color, uOpacity);
  #include <colorspace_fragment>
}`;

function paletteTexture(THREE) {
  const texture = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function updatePalette(texture, name) {
  if (texture.userData?.palette === name) return;
  for (let index = 0; index < 256; index++) {
    const rgb = resultScalarColor(index, 0, 255, name);
    texture.image.data.set([...rgb.map(value => Math.round(value * 255)), 255], index * 4);
  }
  texture.userData = { palette: name }; texture.needsUpdate = true;
}
function geometryFor(THREE, surface) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(surface.positions.length), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("aScalar", new THREE.BufferAttribute(new Float32Array(surface.values.length), 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(surface.indices.length), 1));
  return geometry;
}
function newSurfaceMesh(THREE, surface) {
  const palette = paletteTexture(THREE);
  const material = new THREE.ShaderMaterial({
    uniforms: { uPalette: { value: palette }, uOpacity: { value: 1 } },
    vertexShader: RESULT_SURFACE_VERTEX_SHADER, fragmentShader: RESULT_SURFACE_FRAGMENT_SHADER,
    side: THREE.DoubleSide, transparent: true, depthTest: true, depthWrite: false,
    forceSinglePass: true, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  material.userData.resultOwnedTextures = [palette];
  const mesh = new THREE.Mesh(geometryFor(THREE, surface), material);
  mesh.name = "result-surface-domain"; mesh.userData.domainKey = surface.key;
  mesh.renderOrder = 13;
  // Only the separately retained saved nodes are eligible for result picking.
  mesh.raycast = () => {};
  return mesh;
}
export function disposeResultSurfaceMesh(mesh) {
  mesh.geometry.dispose();
  for (const texture of mesh.material.userData.resultOwnedTextures ?? []) texture.dispose();
  mesh.material.dispose();
}
function scalarPosition(value, minimum, maximum) {
  if (!(maximum > minimum)) return 0.5;
  const span = maximum - minimum;
  // Keep values outside the range until fragment interpolation; clamping vertex
  // values or interpolating RGB would change the field within each triangle.
  return Number.isFinite(span) ? (value - minimum) / span
    : (value / 2 - minimum / 2) / (maximum / 2 - minimum / 2);
}

/** Reuse surface geometry, materials and palette across time and display changes. */
export function updateResultSurfaceMeshes(THREE, root, surfaces, { minimum, maximum, palette = "Viridis", opacity = 1 } = {}) {
  const remaining = new Map(root.children.filter(child => child.name === "result-surface-domain")
    .map(child => [child.userData.domainKey, child]));
  for (const surface of surfaces) {
    let mesh = remaining.get(surface.key); remaining.delete(surface.key);
    if (!mesh) { mesh = newSurfaceMesh(THREE, surface); root.add(mesh); }
    let geometry = mesh.geometry;
    const rebuilt = geometry.getAttribute("position").array.length !== surface.positions.length
      || geometry.index.array.length !== surface.indices.length;
    if (rebuilt) { geometry.dispose(); geometry = mesh.geometry = geometryFor(THREE, surface); }
    const previous = mesh.userData.field;
    if (rebuilt || previous !== surface || mesh.userData.fieldRevision !== surface.revision) {
      const index = geometry.index;
      let changed = false;
      for (let i = 0; i < surface.indices.length; i++) {
        if (index.array[i] !== surface.indices[i]) { index.array[i] = surface.indices[i]; changed = true; }
      }
      if (changed) index.needsUpdate = true;
      // Store GPU coordinates relative to this surface's centre. Large saved
      // global coordinates therefore retain local detail in Float32 attributes.
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < surface.positions.length; i++) {
        const axis = i % 3; min[axis] = Math.min(min[axis], surface.positions[i]); max[axis] = Math.max(max[axis], surface.positions[i]);
      }
      const origin = min.map((value, axis) => value / 2 + max[axis] / 2);
      mesh.position.fromArray(origin);
      const position = geometry.getAttribute("position");
      for (let i = 0; i < position.array.length; i++) position.array[i] = surface.positions[i] - origin[i % 3];
      position.needsUpdate = true; geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    }
    if (rebuilt || previous !== surface || mesh.userData.fieldRevision !== surface.revision
      || mesh.userData.minimum !== minimum || mesh.userData.maximum !== maximum) {
      const scalar = geometry.getAttribute("aScalar");
      for (let i = 0; i < scalar.array.length; i++) scalar.array[i] = scalarPosition(surface.values[i], minimum, maximum);
      scalar.needsUpdate = true;
    }
    mesh.userData.field = surface; mesh.userData.fieldRevision = surface.revision;
    mesh.userData.minimum = minimum; mesh.userData.maximum = maximum;
    mesh.material.uniforms.uOpacity.value = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    updatePalette(mesh.material.uniforms.uPalette.value, normalizeResultPalette(palette));
  }
  for (const mesh of remaining.values()) { root.remove(mesh); disposeResultSurfaceMesh(mesh); }
  return root;
}
