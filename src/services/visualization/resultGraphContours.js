// The contour cuts the displayed triangles. Snapping uses the original grid,
// including EO centres when a slice drawing was limited to 64 intervals.
export const sameContourSurface = (hit, selected) => !!hit && !!selected
  && hit.graphId === selected.graphId && (selected.instanceKey
    ? hit.surface.instanceKey === selected.instanceKey && (selected.surfaceComponent == null || selected.surfaceComponent === hit.surface.component)
    : hit.surface.key === selected.surfaceKey);

export const graphContourIdentity = p => JSON.stringify([p.graphId, p.instanceKey ?? p.surfaceKey, p.surfaceComponent ?? null, p.direction, p.index]);

export function graphContourTooltip(graph, surface, selected) {
  const fixed = 1 - selected.direction, counts = surface.nodeCounts ?? surface.dimensions;
  const axis = k => surface.directions ? `DV${surface.directions[k] + 1}` : `направление ${k + 1}`;
  return [`1D №${selected.id ?? ""} · ${graph.source.name ?? ""} · №${graph.source.recordIndex + 1}`,
    graph.kind === "slice" ? `Срез: плоскость DV${graph.direction + 1}, дискрет ${graph.discrete} / ${surface.planeCount}` : "Площадка",
    `Сечение: ${axis(fixed)}, индекс ${selected.index + 1} / ${counts[fixed]}`,
    `Вдоль ${axis(selected.direction)} (${counts[selected.direction]} узлов)`].join("\n");
}

export function graphContourSelection(hit, direction) {
  if (!hit || ![0, 1].includes(direction) || !hit.uv?.every(Number.isFinite)) return null;
  const fixed = 1 - direction, count = (hit.surface.nodeCounts ?? hit.surface.dimensions)[fixed];
  if (!Number.isSafeInteger(count) || count < 1) return null;
  const coordinate = hit.uv[fixed];
  const nearest = hit.surface.nodeLocation === "centres" ? coordinate * count - .5 : coordinate * (count - 1);
  return { graphId: hit.graphId, surfaceKey: hit.surface.key, instanceKey: hit.surface.instanceKey,
    surfaceComponent: hit.graphKind === "region" ? hit.surface.component : null,
    direction, index: Math.max(0, Math.min(count - 1, Math.round(nearest))) };
}

export function graphContourSegments(surface, positions, selected) {
  if (!selected || ![0, 1].includes(selected.direction)) return new Float32Array();
  const fixed = 1 - selected.direction, count = (surface.nodeCounts ?? surface.dimensions)[fixed];
  if (!Number.isSafeInteger(selected.index) || selected.index < 0 || selected.index >= count) return new Float32Array();
  const value = surface.nodeLocation === "centres" ? (selected.index + .5) / count : count > 1 ? selected.index / (count - 1) : .5;
  const [n1, n2] = surface.dimensions, result = [], seen = new Set(), epsilon = 1e-10;
  const uv = n => [Math.floor(n / n2) / (n1 - 1), (n % n2) / (n2 - 1)];
  const point = n => Array.from(positions.subarray(n * 3, n * 3 + 3));
  for (let k = 0; k < surface.indices.length; k += 3) {
    const ids = Array.from(surface.indices.subarray(k, k + 3)), crossings = [];
    const add = (p, t) => { if (!crossings.some(c => Math.abs(c.t - t) < epsilon)) crossings.push({ p, t }); };
    for (let e = 0; e < 3; e++) {
      const a = ids[e], b = ids[(e + 1) % 3], ua = uv(a), ub = uv(b);
      const da = ua[fixed] - value, db = ub[fixed] - value;
      if (Math.abs(da) < epsilon) add(point(a), ua[selected.direction]);
      if ((da < -epsilon && db > epsilon) || (da > epsilon && db < -epsilon)) {
        const f = da / (da - db), pa = point(a), pb = point(b);
        add(pa.map((v, c) => v + f * (pb[c] - v)), ua[selected.direction] + f * (ub[selected.direction] - ua[selected.direction]));
      }
    }
    if (crossings.length !== 2) continue;
    crossings.sort((a, b) => a.t - b.t);
    const key = crossings.map(c => Math.round(c.t * 1e12)).join(":");
    if (seen.has(key) || !crossings.every(c => c.p.every(Number.isFinite))) continue;
    seen.add(key); result.push(...crossings[0].p, ...crossings[1].p);
  }
  return Float32Array.from(result);
}

export function graphSurfaceTargets(root) {
  const targets = [];
  root?.traverseVisible(object => { if (object.name === "result-graph-surface") targets.push(object); });
  return targets;
}

let LineSegments2, LineSegmentsGeometry, LineMaterial, modules;
export function loadGraphContourRenderer() {
  return modules ??= Promise.all([import("three/addons/lines/LineSegments2.js"),
    import("three/addons/lines/LineSegmentsGeometry.js"), import("three/addons/lines/LineMaterial.js")])
    .then(([line, geometry, material]) => {
      LineSegments2 = line.LineSegments2; LineSegmentsGeometry = geometry.LineSegmentsGeometry; LineMaterial = material.LineMaterial;
    }).catch(error => { modules = null; throw error; });
}
const dispose = object => object.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
export function resizeGraphContours(root, width, height) {
  root?.traverse(object => { if (object.name === "graph-contour-line") object.material.resolution.set(width, height); });
}
export function updateGraphContours(THREE, root, selected, preview, resolution = [1, 1], activeId) {
  const choices = [...(preview ? [{ selection: preview, preview: true }] : []),
    ...(Array.isArray(selected) ? selected : selected ? [selected] : []).map(selection => ({ selection, preview: false }))];
  root.traverse(mesh => {
    if (mesh.name !== "result-graph-surface") return;
    const wanted = choices.filter(c => sameContourSurface(mesh.userData, c.selection));
    const contourKey = c => JSON.stringify([graphContourIdentity(c.selection), c.selection.id, c.preview, c.selection.id === activeId]);
    const keys = new Set(wanted.map(contourKey));
    for (const child of [...mesh.children]) if (child.name === "graph-contour" && !keys.has(child.userData.key)) { mesh.remove(child); dispose(child); }
    for (const choice of wanted) {
    const current = choice.selection, preview = choice.preview, key = contourKey(choice);
    if (mesh.children.some(child => child.userData.key === key) || !LineSegments2) continue;
    const positions = graphContourSegments(mesh.userData.surface, mesh.geometry.attributes.position.array, current);
    if (!positions.length) continue;
    const contour = new THREE.Group(); contour.name = "graph-contour"; contour.userData = { key, selection: current, preview };
    for (const [color, width, order] of [[0x111820, current.id === activeId ? 6 : 5, 40], [preview ? 0xffffff : 0xffdd38, 2.5, 41]]) {
      const geometry = new LineSegmentsGeometry(); geometry.setPositions(positions);
      const material = new LineMaterial({ color, linewidth: width, worldUnits: false, depthTest: true, depthWrite: false,
        toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      material.resolution.set(...resolution);
      const line = new LineSegments2(geometry, material); line.name = "graph-contour-line"; line.renderOrder = order;
      if (preview || order === 40) line.raycast = () => {};
      else line.userData = { contourId: current.id, tooltip: graphContourTooltip(mesh.userData.graph, mesh.userData.surface, current) };
      contour.add(line);
    }
    mesh.add(contour);
    }
  });
  resizeGraphContours(root, ...resolution);
}
