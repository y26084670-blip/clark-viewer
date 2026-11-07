import { normalizeResultPalette, resultScalarColor, resultScalarPosition, resultFieldCoordinate, RESULT_COLOR_SCALE_GLSL } from "./resultScalarColors.js";

// A back-face proxy cube performs front-to-back emission/absorption ray marching.
// Reconstruct the ray from the real camera matrices, so orthographic/perspective,
// camera-inside-volume and a clipping near plane share the same calculation.
export const RESULT_VOLUME_VERTEX_SHADER = `
varying vec3 vLocalPosition;
void main() {
  vLocalPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
export const RESULT_VOLUME_FRAGMENT_SHADER = `
precision highp sampler3D;
${RESULT_COLOR_SCALE_GLSL}
uniform bool uPhysicalField;
uniform sampler3D uField;
uniform sampler2D uPalette;
uniform mat4 uClipToLocal;
uniform vec4 uViewport;
uniform vec3 uDimensions;
uniform vec3 uWorldSize;
uniform float uOpacity;
varying vec3 vLocalPosition;
// Float textures with nearest filtering work in core WebGL2. Interpolate the
// physical field and validity together before clipping or taking a logarithm.
vec2 physicalSample(vec3 grid) {
  ivec3 upper = ivec3(uDimensions) - 1;
  ivec3 base = ivec3(floor(grid));
  vec3 f = fract(grid);
  vec2 result = vec2(0.0);
  for (int i = 0; i < 8; ++i) {
    ivec3 offset = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    vec3 w = mix(1.0 - f, f, vec3(offset));
    result += w.x * w.y * w.z * texelFetch(uField, clamp(base + offset, ivec3(0), upper), 0).rg;
  }
  return result;
}
void main() {
  if (uOpacity <= 0.0) discard;
  vec2 ndc = ((gl_FragCoord.xy - uViewport.xy) / uViewport.zw) * 2.0 - 1.0;
  vec4 nearH = uClipToLocal * vec4(ndc, -1.0, 1.0);
  vec4 farH = uClipToLocal * vec4(ndc, 1.0, 1.0);
  vec3 origin = nearH.xyz / nearH.w;
  vec3 ray = normalize(farH.xyz / farH.w - origin);
  // Keep parallel rays finite without changing their half-space.
  vec3 safeRay = vec3(abs(ray.x) < 1e-7 ? (ray.x < 0.0 ? -1e-7 : 1e-7) : ray.x,
                      abs(ray.y) < 1e-7 ? (ray.y < 0.0 ? -1e-7 : 1e-7) : ray.y,
                      abs(ray.z) < 1e-7 ? (ray.z < 0.0 ? -1e-7 : 1e-7) : ray.z);
  vec3 a = (vec3(-0.5) - origin) / safeRay;
  vec3 b = (vec3(0.5) - origin) / safeRay;
  vec3 lo = min(a, b), hi = max(a, b);
  float enter = max(0.0, max(max(lo.x, lo.y), lo.z));
  float leave = min(min(hi.x, hi.y), hi.z);
  if (leave <= enter) discard;
  float lengthInVoxels = length(ray * uDimensions) * (leave - enter);
  int steps = int(max(ceil(lengthInVoxels * 1.25), 1.0));
  vec3 stepLocal = ray * ((leave - enter) / float(steps));
  float stepRelative = length(stepLocal * uWorldSize) / max(max(uWorldSize.x, uWorldSize.y), uWorldSize.z);
  float density = -log(max(0.001, 1.0 - uOpacity));
  vec4 accumulated = vec4(0.0);
  vec3 location = origin + ray * enter + stepLocal * 0.5 + vec3(0.5);
  for (int index = 0; index < steps; index++) {
    if (accumulated.a > 0.995) break;
    vec3 texcoord = (location * (uDimensions - vec3(1.0)) + vec3(0.5)) / uDimensions;
    vec2 sampleValue = uPhysicalField ? physicalSample(location * (uDimensions - vec3(1.0))) : texture(uField, texcoord).ra;
    if (sampleValue.y > 0.001) {
      float value = palettePosition(sampleValue.x / sampleValue.y);
      vec3 color = texture2D(uPalette, vec2((value * 255.0 + 0.5) / 256.0, 0.5)).rgb;
      float alpha = 1.0 - exp(-density * stepRelative * sampleValue.y);
      accumulated.rgb += (1.0 - accumulated.a) * alpha * color;
      accumulated.a += (1.0 - accumulated.a) * alpha;
    }
    location += stepLocal;
  }
  if (accumulated.a < 0.001) discard;
  gl_FragColor = vec4(accumulated.rgb / accumulated.a, accumulated.a);
  #include <colorspace_fragment>
}`;

function updatePalette(THREE, texture, name) {
  if (texture.userData?.palette === name) return;
  for (let index = 0; index < 256; index++) {
    const rgb = resultScalarColor(index, 0, 255, name);
    texture.image.data.set([...rgb.map(value => Math.round(value * 255)), 255], index * 4);
  }
  texture.userData = { palette: name };
  texture.needsUpdate = true;
}

function newVolumeMesh(THREE, domain, physical) {
  const [x, y, z] = domain.dimensions;
  const data = physical ? new Float32Array(x * y * z * 2) : new Uint8Array(x * y * z * 4);
  const texture = new THREE.Data3DTexture(data, x, y, z);
  texture.format = physical ? THREE.RGFormat : THREE.RGBAFormat;
  texture.type = physical ? THREE.FloatType : THREE.UnsignedByteType;
  texture.minFilter = texture.magFilter = physical ? THREE.NearestFilter : THREE.LinearFilter;
  texture.unpackAlignment = 1;
  const palette = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
  palette.minFilter = palette.magFilter = THREE.LinearFilter;
  // Hardware sRGB decode retains dark palette colors without quantizing them
  // to only 256 values in linear space. The shader accumulates linear light.
  palette.colorSpace = THREE.SRGBColorSpace;
  palette.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPhysicalField: { value: physical }, uColorScale: { value: new THREE.Vector3() },
      uField: { value: texture }, uPalette: { value: palette },
      uClipToLocal: { value: new THREE.Matrix4() }, uViewport: { value: new THREE.Vector4() },
      uDimensions: { value: new THREE.Vector3(x, y, z) },
      uWorldSize: { value: new THREE.Vector3() }, uOpacity: { value: 1 },
    },
    vertexShader: RESULT_VOLUME_VERTEX_SHADER, fragmentShader: RESULT_VOLUME_FRAGMENT_SHADER,
    side: THREE.BackSide, transparent: true, depthTest: true, depthWrite: false, toneMapped: false,
  });
  material.userData.resultOwnedTextures = [texture, palette];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.name = "result-volume-domain";
  mesh.userData.domainKey = domain.key;
  mesh.renderOrder = 13;
  // Proxy boxes are never reported as calculated nodes.
  mesh.raycast = () => {};
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const uniforms = material.uniforms;
    uniforms.uClipToLocal.value.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld)
      .premultiply(camera.projectionMatrix).invert();
    renderer.getCurrentViewport(uniforms.uViewport.value);
  };
  return mesh;
}

export function disposeResultVolumeMesh(mesh) {
  mesh.geometry.dispose();
  for (const texture of mesh.material.userData.resultOwnedTextures ?? []) texture.dispose();
  mesh.material.dispose();
}

/** Update existing GPU allocations; a palette/opacity change never resamples the field. */
export function updateResultVolumeMeshes(THREE, root, domains, {
  minimum, maximum, logScale, manual = false, palette = "Viridis", opacity = 1,
} = {}) {
  const physical = Boolean(logScale || manual);
  const remaining = new Map(root.children.filter(child => child.name === "result-volume-domain")
    .map(child => [child.userData.domainKey, child]));
  for (const domain of domains) {
    let mesh = remaining.get(domain.key);
    remaining.delete(domain.key);
    if (mesh && (mesh.material.uniforms.uPhysicalField.value !== physical
      || mesh.material.uniforms.uDimensions.value.toArray().some((value, axis) => value !== domain.dimensions[axis]))) {
      root.remove(mesh); disposeResultVolumeMesh(mesh); mesh = null;
    }
    if (!mesh) { mesh = newVolumeMesh(THREE, domain, physical); root.add(mesh); }
    const uniforms = mesh.material.uniforms;
    const size = domain.bounds.max.map((value, axis) => value - domain.bounds.min[axis]);
    mesh.position.fromArray(domain.bounds.min.map((value, axis) => value + size[axis] / 2));
    mesh.scale.fromArray(size);
    uniforms.uWorldSize.value.fromArray(size);
    uniforms.uColorScale.value.set(logScale?.mode ?? 0, logScale?.a ?? 0, logScale?.b ?? 0);
    uniforms.uOpacity.value = Math.max(0, Math.min(1, opacity));
    updatePalette(THREE, uniforms.uPalette.value, normalizeResultPalette(palette));
    const data = uniforms.uField.value.image.data;
    // Domains may reuse and overwrite scalar arrays between published time frames;
    // revision marks numerical changes while palette-only updates reuse the bytes.
    if (mesh.userData.field !== domain || mesh.userData.fieldRevision !== domain.revision
        || mesh.userData.minimum !== minimum || mesh.userData.maximum !== maximum || mesh.userData.logMode !== (logScale?.mode ?? 0)) {
      for (let index = 0; index < domain.values.length; index++) {
        const valid = domain.mask[index];
        if (physical) {
          data[index * 2] = valid ? resultFieldCoordinate(domain.values[index], minimum, maximum, logScale) : 0;
          data[index * 2 + 1] = valid ? 1 : 0;
        } else {
          data[index * 4] = valid ? Math.round(resultScalarPosition(domain.values[index], minimum, maximum) * 255) : 0;
          data[index * 4 + 3] = valid ? 255 : 0;
        }
      }
      uniforms.uField.value.needsUpdate = true;
      mesh.userData.field = domain; mesh.userData.fieldRevision = domain.revision;
      mesh.userData.logMode = logScale?.mode ?? 0;
      mesh.userData.minimum = minimum; mesh.userData.maximum = maximum;
    }
  }
  for (const mesh of remaining.values()) { root.remove(mesh); disposeResultVolumeMesh(mesh); }
  return root;
}
