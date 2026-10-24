export const LENS_VECTOR_FAR_OPACITY = 0.18;

// Relative camera depth preserves a readable front layer when zooming. Never
// discard distant vectors: even the furthest layer retains visible opacity.
export function lensDepthOpacity(depth, near, far) {
  if (!(far > near)) return 1;
  const t = Math.max(0, Math.min(1, (depth - near) / (far - near)));
  return 1 - (1 - LENS_VECTOR_FAR_OPACITY) * t * t * (3 - 2 * t);
}

function arrowGeometry(THREE) {
  const shaft = new THREE.CylinderGeometry(.025, .025, .75, 32).translate(0, .375, 0).toNonIndexed();
  const head = new THREE.ConeGeometry(.125, .25, 32).translate(0, .875, 0).toNonIndexed();
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal"]) {
    const a = shaft.getAttribute(name).array, b = head.getAttribute(name).array;
    const values = new Float32Array(a.length + b.length);
    values.set(a); values.set(b, a.length);
    geometry.setAttribute(name, new THREE.BufferAttribute(values, 3));
  }
  shaft.dispose(); head.dispose();
  return geometry;
}

function arrowMaterial(THREE) {
  // A view-space key light gives readable light/shade for every camera pose,
  // without changing the scene lighting, geometry materials or shadow maps.
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false, toneMapped: false,
    vertexShader: `
      attribute float lensOpacity;
      varying vec3 arrowColor, arrowNormal, arrowView;
      varying float arrowAlpha;
      void main() {
        vec4 view = modelViewMatrix * instanceMatrix * vec4(position, 1.);
        arrowNormal = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        arrowView = -view.xyz;
        arrowColor = instanceColor;
        arrowAlpha = lensOpacity;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      varying vec3 arrowColor, arrowNormal, arrowView;
      varying float arrowAlpha;
      void main() {
        vec3 normal = normalize(arrowNormal);
        vec3 light = normalize(vec3(-.45, .65, 1.));
        float diffuse = max(dot(normal, light), 0.);
        vec3 halfDirection = normalize(light + normalize(arrowView));
        float highlight = .18 * pow(max(dot(normal, halfDirection), 0.), 40.);
        gl_FragColor = vec4(arrowColor * (.24 + .76 * diffuse) + vec3(highlight), arrowAlpha);
        #include <colorspace_fragment>
      }`,
  });
}

/** Temporary detailed vector representation, used only during the lens pass.
 * Read rendered endpoints, including scale, motion and local-image transforms.
 * No changes to source data, original materials, or main-view geometry.
 */
export function createLensVectorDetails(THREE) {
  let mesh, cache = new WeakMap();
  const up = new THREE.Vector3(0, 1, 0), direction = new THREE.Vector3(), midpoint = new THREE.Vector3();
  const viewPoint = new THREE.Vector3();
  const rotation = new THREE.Quaternion(), scale = new THREE.Vector3(), matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const instance = new THREE.Matrix4(), viewProjection = new THREE.Matrix4();
  const frustum = new THREE.Frustum(), sphere = new THREE.Sphere();

  function endpoints(object) {
    const position = object.geometry?.getAttribute("position");
    const thin = object.isLineSegments && object.userData.resultVectors;
    const cone = object.userData.lensVectorPart === "cone";
    const heads = object.userData.lensVectorPart === "shaft"
      ? object.parent?.getObjectByName(object.name.replace(/-shaft$/, "-head")) : null;
    if (!thin && !heads && !cone) return null;
    const stride = (object.userData.segmentsPerVector ?? 1) * 2;
    const count = thin ? Math.min(object.userData.resultVectors.length,
      Math.floor(Math.min(position?.count ?? 0, object.geometry.drawRange.count) / stride)) : cone ? object.count : Math.min(object.count, heads.count);
    const key = [count, thin ? position : object.instanceMatrix, thin ? position.version : object.instanceMatrix.version,
      heads?.instanceMatrix.version, ...object.matrixWorld.elements, ...(heads?.matrixWorld.elements ?? [])];
    let stored = cache.get(object);
    if (stored && key.every((v, i) => Object.is(v, stored.key[i]))) return stored.records;
    const records = [];
    for (let index = 0; index < count; index++) {
      const origin = new THREE.Vector3(), tip = new THREE.Vector3();
      if (thin) {
        origin.fromBufferAttribute(position, index * stride).applyMatrix4(object.matrixWorld);
        tip.fromBufferAttribute(position, index * stride + 1).applyMatrix4(object.matrixWorld);
      } else {
        object.getMatrixAt(index, instance); matrix.multiplyMatrices(object.matrixWorld, instance);
        origin.set(0, -.5, 0).applyMatrix4(matrix);
        if (heads) { heads.getMatrixAt(index, instance); matrix.multiplyMatrices(heads.matrixWorld, instance); }
        tip.set(0, .5, 0).applyMatrix4(matrix);
      }
      const length = origin.distanceTo(tip);
      if (!(length > 0) || !Number.isFinite(length)) continue;
      records.push({ origin, tip, length, object, index, depth: 0 });
    }
    cache.set(object, { key, records });
    return records;
  }

  function allocate(count) {
    if (mesh && mesh.instanceMatrix.count >= count) return;
    const material = mesh?.material ?? arrowMaterial(THREE);
    mesh?.geometry.dispose(); mesh?.dispose();
    const geometry = arrowGeometry(THREE);
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, count)));
    mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = "lens-detailed-vectors"; mesh.renderOrder = 14;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("lensOpacity", new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage));
    mesh.frustumCulled = false;
    mesh.raycast = () => {}; // Picking remains tied to the original saved vectors.
  }

  return {
    render(scene, camera, draw) {
      const hidden = [], selected = [];
      let near = Infinity, far = -Infinity;
      scene.updateMatrixWorld(); camera.updateMatrixWorld();
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection);
      scene.traverseVisible(object => {
        if (object.name === "hovered-thin-vector") { hidden.push(object); return; }
        if (object.userData.lensVectorPart === "head" || !camera.layers.test(object.layers)) return;
        const records = endpoints(object);
        if (!records) return;
        hidden.push(object);
        if (object.userData.lensVectorPart === "shaft") {
          const head = object.parent.getObjectByName(object.name.replace(/-shaft$/, "-head"));
          if (head?.visible) hidden.push(head);
        }
        if (object.material.visible === false || object.material.opacity === 0) return;
        for (const record of records) {
          midpoint.addVectors(record.origin, record.tip).multiplyScalar(.5);
          record.depth = -viewPoint.copy(midpoint).applyMatrix4(camera.matrixWorldInverse).z;
          if (record.depth + record.length * .52 < camera.near) continue;
          near = Math.min(near, record.depth); far = Math.max(far, record.depth);
          sphere.center.copy(midpoint); sphere.radius = record.length * .52;
          if (frustum.intersectsSphere(sphere)) selected.push(record);
        }
      });
      // Instanced transparent geometry needs explicit back-to-front ordering.
      selected.sort((a, b) => b.depth - a.depth);
      if (selected.length) {
        allocate(selected.length); mesh.count = selected.length;
        const opacity = mesh.geometry.getAttribute("lensOpacity");
        selected.forEach((record, index) => {
          direction.subVectors(record.tip, record.origin).normalize();
          rotation.setFromUnitVectors(up, direction); scale.setScalar(record.length);
          mesh.setMatrixAt(index, matrix.compose(record.origin, rotation, scale));
          if (record.object.instanceColor) {
            record.object.getColorAt(record.index, color);
            // Retained instance colours become white when normalization is off;
            // ordinary mesh materials still multiply them by their source colour.
            if (record.object.material.color) color.multiply(record.object.material.color);
          }
          else if (record.object.material.vertexColors && record.object.geometry.getAttribute("color")) {
            color.fromBufferAttribute(record.object.geometry.getAttribute("color"), record.index * (record.object.userData.segmentsPerVector ?? 1) * 2);
            color.multiply(record.object.material.color);
          }
          else color.copy(record.object.material.color);
          mesh.setColorAt(index, color);
          opacity.setX(index, record.object.material.opacity * lensDepthOpacity(record.depth, near, far));
        });
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; opacity.needsUpdate = true;
      }
      try {
        for (const object of hidden) object.visible = false;
        if (selected.length) scene.add(mesh);
        return draw();
      } finally {
        mesh?.removeFromParent();
        for (const object of hidden) object.visible = true;
      }
    },
    dispose() {
      mesh?.removeFromParent(); mesh?.dispose(); mesh?.geometry.dispose(); mesh?.material.dispose();
      mesh = null; cache = new WeakMap();
    },
  };
}
