const DEFAULT_FRAME_PADDING = 1.08;
const MIN_HALF_SIZE = 1e-6;

function materialVisible(material) {
  return material && material.visible !== false
    && !(material.transparent && material.opacity <= 0);
}

// Read the buffers that are actually drawn, including instance transforms and
// draw ranges. This runs only when framing is requested, never while orbiting.
function visitVisibleVertices(THREE, roots, camera, viewBasis, visit) {
  const vertex = new THREE.Vector3();
  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  const transform = new THREE.Matrix4();
  for (const root of roots) {
    if (!root) continue;
    root.updateWorldMatrix(true, true);
    root.traverseVisible(object => {
      const geometry = object.geometry;
      const position = geometry?.getAttribute("position");
      if (!position || !object.layers.test(camera.layers)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (!materials.some(materialVisible)) return;
      const index = geometry.index;
      const count = index?.count ?? position.count;
      const drawStart = Math.max(0, geometry.drawRange.start);
      const drawEnd = Math.min(count, drawStart + geometry.drawRange.count);
      const ranges = Array.isArray(object.material)
        ? geometry.groups.filter(group => materialVisible(materials[group.materialIndex]))
        : [{ start: 0, count }];
      const instances = object.isInstancedMesh ? object.count : 1;
      for (let instance = 0; instance < instances; instance += 1) {
        if (object.isInstancedMesh) {
          object.getMatrixAt(instance, instanceMatrix);
          worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
        } else worldMatrix.copy(object.matrixWorld);
        transform.multiplyMatrices(viewBasis, worldMatrix);
        for (const range of ranges) {
          const start = Math.max(drawStart, range.start);
          const end = Math.min(drawEnd, range.start + range.count);
          for (let i = start; i < end; i += 1) {
            vertex.fromBufferAttribute(position, index ? index.getX(i) : i)
              .applyMatrix4(transform);
            if (Number.isFinite(vertex.x) && Number.isFinite(vertex.y) && Number.isFinite(vertex.z)) {
              visit(vertex);
            }
          }
        }
      }
    });
  }
}

/** Fit visible render vertices in the current view, preserving its direction. */
export function fitCameraToVisibleObjects(THREE, camera, controls, roots, options = {}) {
  const padding = Number.isFinite(options.padding) && options.padding >= 1
    ? options.padding : DEFAULT_FRAME_PADDING;
  const origin = options.target?.clone?.() ?? controls.target.clone();
  const backward = camera.position.clone().sub(controls.target);
  if (backward.lengthSq() < 1e-12) backward.set(1, 1, 1);
  backward.normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, backward);
  if (right.lengthSq() < 1e-12) {
    right.crossVectors(Math.abs(backward.z) < 0.9
      ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0), backward);
  }
  right.normalize();
  const up = new THREE.Vector3().crossVectors(backward, right).normalize();
  const viewBasis = new THREE.Matrix4().makeBasis(right, up, backward)
    .setPosition(origin).invert();
  const orthographic = camera.isOrthographicCamera;
  const aspect = Math.max(orthographic
    ? Math.abs((camera.right - camera.left) / (camera.top - camera.bottom))
    : camera.aspect, 1e-6);
  const tanY = orthographic ? 0
    : Math.tan(camera.fov * Math.PI / 360) / Math.max(camera.zoom, 1e-9) / padding;
  const tanX = tanY * aspect;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let left = Infinity, rightEdge = -Infinity, bottom = Infinity, top = -Infinity;
  let fixedTargetDistance = -Infinity;
  visitVisibleVertices(THREE, roots, camera, viewBasis, ({ x, y, z }) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    if (!orthographic) {
      left = Math.min(left, x - z * tanX);
      rightEdge = Math.max(rightEdge, x + z * tanX);
      bottom = Math.min(bottom, y - z * tanY);
      top = Math.max(top, y + z * tanY);
      fixedTargetDistance = Math.max(fixedTargetDistance,
        z + Math.abs(x) / tanX, z + Math.abs(y) / tanY);
    }
  });
  if (!Number.isFinite(minZ)) return false;

  const fixedTarget = !!options.target;
  const centerZ = fixedTarget ? 0 : (minZ + maxZ) / 2;
  let centerX, centerY, cameraZ;
  if (orthographic) {
    centerX = fixedTarget ? 0 : (minX + maxX) / 2;
    centerY = fixedTarget ? 0 : (minY + maxY) / 2;
    const halfWidth = Math.max(Math.abs(maxX - centerX), Math.abs(minX - centerX));
    const halfHeight = padding * Math.max(MIN_HALF_SIZE,
      Math.abs(maxY - centerY), Math.abs(minY - centerY), halfWidth / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.zoom = 1;
    cameraZ = maxZ + Math.max(halfHeight, (maxZ - minZ) * 0.01, MIN_HALF_SIZE);
  } else {
    // Each vertex imposes cx >= x + z*tanX - cameraZ*tanX and
    // cx <= x - z*tanX + cameraZ*tanX (likewise for y). Intersecting
    // these intervals gives the closest camera that contains the projection.
    centerX = fixedTarget ? 0 : (left + rightEdge) / 2;
    centerY = fixedTarget ? 0 : (bottom + top) / 2;
    const clearance = Math.max(MIN_HALF_SIZE, Math.abs(maxZ) * Number.EPSILON * 16);
    cameraZ = Math.max(maxZ + clearance, fixedTarget ? fixedTargetDistance :
      Math.max((rightEdge - left) / (2 * tanX), (top - bottom) / (2 * tanY)));
  }
  cameraZ = Math.max(cameraZ, centerZ + MIN_HALF_SIZE);
  const radius = Math.max(MIN_HALF_SIZE, Math.hypot(
    Math.max(Math.abs(minX - centerX), Math.abs(maxX - centerX)),
    Math.max(Math.abs(minY - centerY), Math.abs(maxY - centerY)),
    Math.max(Math.abs(minZ - centerZ), Math.abs(maxZ - centerZ)),
  ));
  // Orthographic distance does not change the projected scale. Keep all
  // geometry in front of the camera while the user subsequently orbits it.
  if (orthographic) cameraZ = Math.max(cameraZ, centerZ + radius * 2);
  const target = origin.clone().addScaledVector(right, centerX)
    .addScaledVector(up, centerY).addScaledVector(backward, centerZ);
  controls.target.copy(target);
  camera.position.copy(target).addScaledVector(backward, cameraZ - centerZ);
  const nearest = cameraZ - maxZ;
  const farthest = cameraZ - minZ;
  camera.near = Math.max(Math.min(nearest * 0.5, radius / 10000), 1e-9);
  camera.far = Math.max(farthest + Math.max(farthest * 0.01, MIN_HALF_SIZE),
    cameraZ - centerZ + radius * 2, camera.near * 2);
  camera.updateProjectionMatrix();
  controls.update();
  return true;
}
