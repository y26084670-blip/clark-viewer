function rendered(object) {
  if (!object) return true;
  for (let parent = object; parent; parent = parent.parent) if (parent.visible === false) return false;
  let visible = false;
  object.traverseVisible(child => {
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    if (materials.some(material => material && material.visible !== false && material.opacity > 0)) visible = true;
  });
  return visible;
}

/** Intersect retained logical surface triangles, including wireframe objects.
 * Batches contain only rendered instances. No meshes or GPU buffers are built.
 */
export function pickGeometryFlightPivot(THREE, ray, batches, { near = 0, far = Infinity } = {}) {
  const matrix = new THREE.Matrix4(), inverse = new THREE.Matrix4();
  const localRay = new THREE.Ray(), bounds = new THREE.Box3();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const localPoint = new THREE.Vector3(), point = new THREE.Vector3();
  let nearest = null, nearestDistance = far;
  for (const batch of batches) {
    const { primitive, instances, object } = batch;
    const vertices = primitive?.vertices, indices = primitive?.indices;
    if (primitive?.kind === "region-line" || !vertices?.length || !indices?.length || !rendered(object)) continue;
    bounds.makeEmpty();
    for (let offset = 0; offset + 2 < vertices.length; offset += 3) bounds.expandByPoint(a.fromArray(vertices, offset));
    object?.updateWorldMatrix(true, false);
    for (const instance of instances ?? []) {
      if (instance.matrix?.length !== 16 || !Array.from(instance.matrix).every(Number.isFinite)) continue;
      matrix.fromArray(instance.matrix);
      if (object) matrix.premultiply(object.matrixWorld);
      const determinant = matrix.determinant();
      if (!Number.isFinite(determinant) || determinant === 0) continue;
      localRay.copy(ray).applyMatrix4(inverse.copy(matrix).invert());
      if (!localRay.intersectsBox(bounds)) continue;
      for (let index = 0; index + 2 < indices.length; index += 3) {
        const triangle = [indices[index], indices[index + 1], indices[index + 2]];
        if (triangle.some(vertex => !Number.isSafeInteger(vertex) || vertex < 0 || vertex * 3 + 2 >= vertices.length)) continue;
        a.fromArray(vertices, triangle[0] * 3); b.fromArray(vertices, triangle[1] * 3); c.fromArray(vertices, triangle[2] * 3);
        if (!localRay.intersectTriangle(a, b, c, false, localPoint)) continue;
        point.copy(localPoint).applyMatrix4(matrix);
        const distance = point.distanceTo(ray.origin);
        if (!Number.isFinite(distance) || distance < near || distance >= nearestDistance) continue;
        nearestDistance = distance;
        nearest = { point: point.toArray(), distance, source: primitive.source, instance };
      }
    }
  }
  return nearest;
}
