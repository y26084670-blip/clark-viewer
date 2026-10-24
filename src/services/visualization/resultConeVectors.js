import { resultScalarColor } from "./resultScalarColors.js";
import { resultVectorLength } from "./resultVectorScale.js";

// Fixed view-space lighting: no moving lamps or per-frame shadow maps. The
// base blends into the viewport background, the tip carries the palette value.
function coneMaterial(THREE, background) {
  return new THREE.ShaderMaterial({
    uniforms: { backgroundColor: { value: new THREE.Color(background) } },
    toneMapped: false,
    vertexShader: `
      varying vec3 coneNormal, coneColor;
      varying float heightFraction;
      void main() {
        mat3 transform = mat3(instanceMatrix);
        vec3 inverseScale = vec3(dot(transform[0], transform[0]), dot(transform[1], transform[1]), dot(transform[2], transform[2]));
        coneNormal = normalize(normalMatrix * transform * (normal / inverseScale));
        coneColor = instanceColor;
        heightFraction = position.y + .5;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.);
      }`,
    fragmentShader: `
      uniform vec3 backgroundColor;
      varying vec3 coneNormal, coneColor;
      varying float heightFraction;
      void main() {
        float light = .3 + .7 * max(dot(normalize(coneNormal), normalize(vec3(-.45, .65, 1.))), 0.);
        gl_FragColor = vec4(mix(backgroundColor, coneColor * light, clamp(heightFraction, 0., 1.)), 1.);
        #include <colorspace_fragment>
      }`,
  });
}

export function updateResultCones(THREE, root, vectors, { scales, maximumMagnitude, sceneDiagonal,
  lengthReference, displayRange, palette, background = 0x141a20 }) {
  let minimum = Infinity, maximum = -Infinity;
  const cones = [];
  for (const item of vectors) {
    minimum = Math.min(minimum, item.magnitude); maximum = Math.max(maximum, item.magnitude);
    const length = resultVectorLength(item, scales[item.kind], maximumMagnitude, sceneDiagonal, lengthReference);
    const radius = (item.meanCellSize ?? item.characteristicSize) / 3;
    if (length > 0 && Number.isFinite(radius) && radius > 0) cones.push({ item, length, radius });
  }
  if (displayRange) ({ minimum, maximum } = displayRange);
  let mesh = root.getObjectByName("result-cones");
  if (!mesh || mesh.instanceMatrix.count < cones.length) {
    const geometry = mesh?.geometry ?? new THREE.ConeGeometry(1, 1, 32);
    const material = mesh?.material ?? coneMaterial(THREE, background);
    if (mesh) { root.remove(mesh); mesh.dispose(); }
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, cones.length)));
    mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = "result-cones"; mesh.renderOrder = 14;
    mesh.userData.lensVectorPart = "cone";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
  }
  mesh.material.uniforms.backgroundColor.value.setHex(background);
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), position = new THREE.Vector3();
  const rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), matrix = new THREE.Matrix4(), color = new THREE.Color();
  cones.forEach(({ item, length, radius }, index) => {
    direction.fromArray(item.vector).normalize(); rotation.setFromUnitVectors(up, direction);
    position.fromArray(item.origin).addScaledVector(direction, length / 2);
    mesh.setMatrixAt(index, matrix.compose(position, rotation, scale.set(radius, length, radius)));
    color.setRGB(...resultScalarColor(item.magnitude, minimum, maximum, palette), THREE.SRGBColorSpace);
    mesh.setColorAt(index, color);
  });
  mesh.count = cones.length; mesh.visible = cones.length > 0;
  mesh.userData.resultVectors = cones.map(({ item }) => item);
  mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere(); mesh.computeBoundingBox();
  root.userData.colorLegend = vectors.length ? { minimum, maximum, quantity: `Модуль · ${vectors[0].quantity}`, unit: vectors[0].unit, palette } : null;
  return root;
}
