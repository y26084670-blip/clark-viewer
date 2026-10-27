import { primitiveVisible, instanceVisible } from "./geometryRenderFilters.js";
import { resolveGraphAxis } from "./graphAxes.js";

const WIDTH = 1024, HEIGHT = 640;
const BOX = { left: 112, top: 72, width: 872, height: 480 };
const COLORS = ["#ce3030", "#16813b", "#2169d1"];
const number = n => Number(n.toPrecision(5)).toString();

export function graphPlotLayout(graph, enabled = { X: true, Y: true, Z: true }) {
  const components = graph.components === 1 ? [0] : [0, 1, 2].filter(c => enabled[["X", "Y", "Z"][c]]);
  let low = 0, high = 0;
  for (let n = 0; n < graph.distances.length; n++) for (const c of components) {
    const value = graph.values[n * graph.components + c];
    if (Number.isFinite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
  }
  if (low === high) { low = -1; high = 1; }
  else { const padding = (high - low) * .05; if (low < 0) low -= padding; if (high > 0) high += padding; }
  const y = value => BOX.top + BOX.height * (high - value) / (high - low);
  return { components, low, high, zero: y(0), x: distance => BOX.left + BOX.width * distance / graph.length, y };
}

function drawGraph(canvas, graph, layout, background, active) {
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  const hex = background.replace("#", ""), brightness = [0, 2, 4].reduce((sum, k, i) => sum + parseInt(hex.slice(k, k + 2), 16) * [.2126, .7152, .0722][i], 0);
  const ink = brightness > 128 ? "#182532" : "#f0f4f7", grid = brightness > 128 ? "#aeb8c2" : "#697987";
  ctx.fillStyle = background; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = active ? "#ed9c26" : grid; ctx.lineWidth = active ? 5 : 2; ctx.strokeRect(2, 2, WIDTH - 4, HEIGHT - 4);
  ctx.font = "24px Arial"; ctx.fillStyle = ink; ctx.textAlign = "left";
  ctx.fillText(`Ось №${graph.id} · ${graph.label}, ${graph.unit} · t = ${number(graph.time)} с`, 20, 34, WIDTH - 40);
  ctx.lineWidth = 1; ctx.font = "20px Arial";
  let zeroLabel = false;
  for (let i = 0; i <= 5; i++) {
    const x = BOX.left + BOX.width * i / 5;
    let y = BOX.top + BOX.height * i / 5, value = layout.high + (layout.low - layout.high) * i / 5;
    if (Math.abs(y - layout.zero) < 26) { y = layout.zero; value = 0; zeroLabel = true; }
    ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x, BOX.top); ctx.lineTo(x, BOX.top + BOX.height);
    ctx.moveTo(BOX.left, y); ctx.lineTo(BOX.left + BOX.width, y); ctx.stroke();
    ctx.fillStyle = ink; ctx.textAlign = "center"; ctx.fillText(number(graph.length * i / 5), x, BOX.top + BOX.height + 28);
    ctx.textAlign = "right"; ctx.fillText(number(value), BOX.left - 10, y + 6);
  }
  if (!zeroLabel) { ctx.fillStyle = ink; ctx.textAlign = "right"; ctx.fillText("0", BOX.left - 10, layout.zero + 6); }
  ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath();
  ctx.moveTo(BOX.left, BOX.top); ctx.lineTo(BOX.left, BOX.top + BOX.height);
  ctx.moveTo(BOX.left, layout.zero); ctx.lineTo(BOX.left + BOX.width, layout.zero); ctx.stroke();
  ctx.save(); ctx.beginPath(); ctx.rect(BOX.left, BOX.top, BOX.width, BOX.height); ctx.clip();
  for (const c of layout.components) {
    ctx.strokeStyle = graph.components === 1 ? (brightness > 128 ? "#8a269e" : "#fa9aff") : COLORS[c]; ctx.lineWidth = 3;
    ctx.beginPath(); let started = false;
    for (let n = 0; n < graph.distances.length; n++) {
      const value = graph.values[n * graph.components + c];
      if (!Number.isFinite(value)) { started = false; continue; }
      const x = layout.x(graph.distances[n]), y = layout.y(value);
      if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }
  ctx.restore(); ctx.fillStyle = ink; ctx.textAlign = "center"; ctx.fillText("Расстояние от начала, мм", WIDTH / 2, HEIGHT - 20);
  if (graph.components === 3) for (const [index, c] of layout.components.entries()) {
    ctx.fillStyle = COLORS[c]; ctx.textAlign = "right"; ctx.fillText(["X", "Y", "Z"][c], WIDTH - 24 - (layout.components.length - 1 - index) * 42, 60);
  }
}

export function disposeGraphScene(root) {
  root?.traverse(object => {
    object.geometry?.dispose(); object.material?.map?.dispose(); object.material?.dispose();
  });
  root?.clear();
}

export function updateGraphScene(THREE, root, scene, axes, graphs, { active, components, background = "#ffffff", visible = true, filters = {} } = {}) {
  const old = new Map(root.children.map(group => [group.userData.axisId, group]));
  const resolved = [];
  for (const axis of axes) {
    let frame;
    try { frame = resolveGraphAxis(scene, axis); } catch { continue; }
    if (!primitiveVisible(frame.primitive, filters.objectModes, filters.selections) || !instanceVisible(frame.instance, filters.symmetry)) continue;
    resolved.push(frame);
    let group = old.get(axis.id); old.delete(axis.id);
    if (!group) { group = new THREE.Group(); group.userData.axisId = axis.id; root.add(group); }
    const graph = graphs.find(g => g.id === axis.id && !g.error);
    const key = JSON.stringify([frame.start, frame.end, frame.up, active === axis.id, components, background]);
    if (group.userData.key !== key || group.userData.graph !== graph) {
      disposeGraphScene(group);
      const geometry = new THREE.BufferGeometry().setFromPoints([frame.start, frame.end].map(p => new THREE.Vector3(...p)));
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xff0000, transparent: true, depthTest: false, depthWrite: false }));
      line.renderOrder = 35; group.add(line);
      const marker = new THREE.Points(geometry.clone(), new THREE.PointsMaterial({ color: 0xff0000,
        size: 12, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false })); marker.renderOrder = 36; group.add(marker);
      if (graph) {
        const canvas = document.createElement("canvas"), layout = graphPlotLayout(graph, components);
        drawGraph(canvas, graph, layout, background, active === axis.id);
        const texture = new THREE.CanvasTexture(canvas); if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
        const xScale = frame.length / BOX.width, yScale = frame.length * .6 / BOX.height;
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH * xScale, HEIGHT * yScale),
          new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false, transparent: true, depthTest: false, depthWrite: false }));
        // Draw after translucent geometry so it cannot obscure labels and curves.
        plane.renderOrder = 30;
        plane.name = "result-graph-plane"; plane.userData.axisId = axis.id;
        plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.right), new THREE.Vector3(...frame.up), new THREE.Vector3(...frame.normal)));
        plane.position.fromArray(frame.start).addScaledVector(new THREE.Vector3(...frame.right), (WIDTH / 2 - BOX.left) * xScale)
          .addScaledVector(new THREE.Vector3(...frame.up), (layout.zero - HEIGHT / 2) * yScale);
        group.add(plane);
      }
      group.userData.key = key; group.userData.graph = graph;
    }
    group.userData.frame = frame;
    const plane = group.getObjectByName("result-graph-plane"); if (plane) plane.visible = visible;
  }
  for (const group of old.values()) { root.remove(group); disposeGraphScene(group); }
  return resolved;
}
