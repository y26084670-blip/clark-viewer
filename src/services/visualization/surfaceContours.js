import * as THREE from "three";

export function contourLevels(min, max, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  if (count === 1 || min === max) return [min];
  return Array.from({ length: count }, (_, i) => i === count - 1 ? max : min + (max - min) * i / (count - 1));
}

// Intersect the actual rendered triangles, including exact vertex/edge levels.
// A plateau contributes its boundary, and an isolated extremum contributes a dot.
export function surfaceContours(surface, values, count) {
  const positions = surface.geometry.attributes.position, indices = surface.geometry.index.array;
  // Contours include each component's own extrema even with shared axis limits.
  const { min, max } = surface.userData.valueLimits ?? surface.userData.limits;
  const levels = contourLevels(min, max, count), lines = [], points = [];
  for (const level of levels) {
    const segments = new Map(), flatEdges = new Map(), isolated = new Map(), connected = new Set();
    const tolerance = Math.max(Math.abs(min), Math.abs(max), Number.MIN_VALUE) * 16 * Number.EPSILON;
    const vertex = i => ({ key: `v${i}`, xyz: [positions.getX(i), positions.getY(i), positions.getZ(i)] });
    const add = (a, b) => {
      const key = [a.key, b.key].sort().join(":");
      segments.set(key, [a.xyz, b.xyz]); connected.add(a.key); connected.add(b.key);
    };
    for (let k = 0; k < indices.length; k += 3) {
      const ids = [indices[k], indices[k + 1], indices[k + 2]];
      const delta = ids.map(i => values[i] - level), on = delta.map(d => Math.abs(d) <= tolerance);
      if (on.every(Boolean)) {
        for (let e = 0; e < 3; e++) {
          const a = vertex(ids[e]), b = vertex(ids[(e + 1) % 3]), key = [a.key, b.key].sort().join(":");
          const edge = flatEdges.get(key); if (edge) edge.count++; else flatEdges.set(key, { a, b, count: 1 });
        }
        continue;
      }
      const intersections = new Map();
      for (let e = 0; e < 3; e++) {
        const f = (e + 1) % 3, a = ids[e], b = ids[f];
        if (on[e]) { const p = vertex(a); intersections.set(p.key, p); }
        if (!on[e] && !on[f] && (delta[e] < 0) !== (delta[f] < 0)) {
          const t = delta[e] / (delta[e] - delta[f]), p = vertex(a), q = vertex(b);
          const key = `e${Math.min(a, b)}:${Math.max(a, b)}`;
          intersections.set(key, { key, xyz: p.xyz.map((value, axis) => value + t * (q.xyz[axis] - value)) });
        }
      }
      const hit = [...intersections.values()];
      if (hit.length === 2) add(hit[0], hit[1]);
      else if (hit.length === 1) isolated.set(hit[0].key, hit[0].xyz);
    }
    for (const edge of flatEdges.values()) if (edge.count === 1) add(edge.a, edge.b);
    for (const [a, b] of segments.values()) lines.push(...a, ...b);
    for (const [key, point] of isolated) if (!connected.has(key)) points.push(...point);
  }
  return { levels, lines, points };
}

function updatePositions(geometry, data) {
  let attribute = geometry.getAttribute("position");
  if (!attribute || attribute.array.length < data.length) {
    attribute = new THREE.BufferAttribute(new Float32Array(data.length), 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", attribute);
  }
  attribute.array.set(data); attribute.needsUpdate = true;
  geometry.setDrawRange(0, data.length / 3);
  geometry.computeBoundingSphere();
}

function dotMaterial() {
  const size = 32, pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = (y * size + x) * 4;
    pixels[k] = pixels[k + 1] = pixels[k + 2] = 255;
    pixels[k + 3] = Math.hypot(x + .5 - size / 2, y + .5 - size / 2) <= size / 2 ? 255 : 0;
  }
  const map = new THREE.DataTexture(pixels, size, size); map.needsUpdate = true;
  return new THREE.PointsMaterial({ color: 0x000000, size: 9, sizeAttenuation: false, map, alphaTest: .5, depthTest: false });
}

// Reuse all overlay objects and buffers during time scrolling.
export function updateSurfaceDecorations(group, surface, values, { projections = true, isolines = 0 } = {}) {
  if (!group) {
    group = new THREE.Group(); group.name = "surface-projections-and-isolines";
    for (let view = 0; view < 4; view++) {
      const layer = new THREE.Group(); layer.name = ["surface-contours", "projection-xy", "projection-xz", "projection-yz"][view];
      if (view) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
          vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: .35, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        }));
        mesh.name = "projection"; mesh.renderOrder = -2; layer.add(mesh);
      }
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x000000 }));
      lines.name = "isolines"; lines.renderOrder = 2; lines.frustumCulled = false; layer.add(lines);
      const dots = new THREE.Points(new THREE.BufferGeometry(), dotMaterial());
      dots.name = "extrema"; dots.renderOrder = 3; dots.frustumCulled = false; layer.add(dots);
      group.add(layer);
    }
  }
  const { halfWidth: w, halfHeight: h } = surface.userData.footprint;
  const contours = surfaceContours(surface, values, isolines);
  const project = (data, view) => {
    const result = Float32Array.from(data);
    for (let k = 0; k < result.length; k += 3) {
      if (view === 1) result[k + 2] = -.04;
      else if (view === 2) result[k + 1] = h + .04;
      else if (view === 3) result[k] = -w - .04;
      else result[k + 2] += .002; // Prevent z-fighting on the original surface.
    }
    return result;
  };
  for (const [view, layer] of group.children.entries()) {
    layer.visible = !view || projections;
    if (!layer.visible) continue;
    if (view) {
      const mesh = layer.getObjectByName("projection"), original = surface.geometry;
      if (mesh.userData.topology !== original) {
        mesh.geometry.dispose(); mesh.geometry = original.clone(); mesh.userData.topology = original;
      }
      updatePositions(mesh.geometry, project(original.attributes.position.array, view));
      mesh.geometry.attributes.color.copyArray(original.attributes.color.array); mesh.geometry.attributes.color.needsUpdate = true;
    }
    updatePositions(layer.getObjectByName("isolines").geometry, project(contours.lines, view));
    updatePositions(layer.getObjectByName("extrema").geometry, project(contours.points, view));
  }
  group.visible = true; group.userData.levels = contours.levels;
  return group;
}
