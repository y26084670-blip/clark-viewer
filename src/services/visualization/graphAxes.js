import { bilinearRegionPoint, trilinearElementPoint } from "./geometryDiscretization.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { resultInstanceKey } from "../results/resultSymmetry.js";

export const graphObjectKey = node => resultInstanceKey(node.source, node.instance);
export const graphAxisKey = axis => `${graphObjectKey(axis)}:${axis.points.join(":")}`;
export const sameGraphObject = (a, b) => Boolean(a && b && graphObjectKey(a) === graphObjectKey(b));
export const graphInstance = instance => Object.fromEntries(["ls", "as", "ps", "mirrorX", "mirrorY"]
  .map(key => [key, Number(instance?.[key] ?? 0)]));
export const graphNode = point => ({ source: { schemaId: point.source.schemaId,
  recordIndex: point.source.recordIndex, name: point.source.name }, instance: graphInstance(point.instance), pointIndex: point.pointIndex });

export function graphPlaneFrame(start, end, hint = [0, 0, 1]) {
  const delta = end.map((v, i) => v - start[i]), length = Math.hypot(...delta);
  if (!(length > 0) || !Number.isFinite(length)) throw new Error("Концы оси должны быть различными точками.");
  const right = delta.map(v => v / length);
  const perpendicular = v => { const dot = v.reduce((sum, x, i) => sum + x * right[i], 0); return v.map((x, i) => x - dot * right[i]); };
  let up = perpendicular(hint);
  if (Math.hypot(...up) < 1e-8) up = perpendicular(Math.abs(right[0]) < .8 ? [1, 0, 0] : [0, 1, 0]);
  const norm = Math.hypot(...up); up = up.map(v => v / norm);
  const normal = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
  return { start, end, length, right, up, normal };
}

/** Resolve the geometric grid, not an index into a sampled display buffer. */
export function graphPointOnPrimitive(primitive, pointIndex) {
  if (!Number.isSafeInteger(pointIndex) || pointIndex < 0) return null;
  const grid = primitive?.discretization, dims = grid?.counts;
  const vertices = primitive?.controlVertices ?? primitive?.vertices;
  if (!dims?.every(n => Number.isSafeInteger(n) && n > 0)) return null;
  if (grid.kind === "element-cells") {
    if (pointIndex >= dims.reduce((a, b) => a * b, 1)) return null;
    const k = pointIndex % dims[2], ij = Math.floor(pointIndex / dims[2]);
    return trilinearElementPoint(vertices, (Math.floor(ij / dims[1]) + .5) / dims[0], (ij % dims[1] + .5) / dims[1], (k + .5) / dims[2]);
  }
  const line = grid.kind === "region-line";
  if (!line && grid.kind !== "region-grid") return null;
  if (pointIndex >= (line ? dims[1] : dims[0] * dims[1])) return null;
  const u = line || dims[0] === 1 ? .5 : Math.floor(pointIndex / dims[1]) / (dims[0] - 1);
  const v = dims[1] === 1 ? .5 : (pointIndex % dims[1]) / (dims[1] - 1);
  if (line && vertices.length === 6) return [0, 1, 2].map(i => vertices[i] * (1 - v) + vertices[i + 3] * v);
  return bilinearRegionPoint(vertices, u, v);
}

export function resolveGraphNode(scene, node) {
  const primitive = scene?.primitives?.find(p => p.source?.schemaId === node.source.schemaId && p.source.recordIndex === node.source.recordIndex);
  const instance = primitive?.instances?.find(i => sameGraphObject(node, { source: node.source, instance: i }));
  if (!instance) throw new Error("Объект или образ оси отсутствует в геометрии.");
  const local = graphPointOnPrimitive(primitive, node.pointIndex);
  if (!local) throw new Error("Узел оси отсутствует в сетке.");
  return { ...node, primitive, instance, position: applyMatrix4ToPoint(instance.matrix, local) };
}

export function resolveGraphAxis(scene, axis) {
  const first = resolveGraphNode(scene, { ...axis, pointIndex: axis.points[0] });
  const last = resolveGraphNode(scene, { ...axis, pointIndex: axis.points[1] });
  return { ...axis, primitive: first.primitive, instance: first.instance, ...graphPlaneFrame(first.position, last.position, axis.up) };
}

/** Small task-owned state machine; scene listeners and modal UI share this owner. */
export function createGraphAxesController(onChange = () => {}, initial = []) {
  let state = { axes: initial, active: initial.at(-1)?.id ?? null, mode: null, pending: null, drag: null, deleting: null, notice: "" };
  let nextId = Math.max(0, ...initial.map(a => a.id)) + 1;
  const update = next => { state = { ...state, ...next }; onChange(state); return state; };
  function cancel() {
    const axes = state.drag ? state.axes.map(a => a.id === state.drag.before.id ? state.drag.before : a) : state.axes;
    update({ axes, mode: null, pending: null, drag: null, deleting: null, notice: "" });
  }
  return {
    get state() { return state; },
    toggle(mode) { const same = state.mode === mode; cancel(); if (!same) update({ mode }); },
    cancel,
    reset(axes = []) { cancel(); nextId = Math.max(0, ...axes.map(a => a.id)) + 1; update({ axes, active: axes.at(-1)?.id ?? null }); },
    select(id) { if (state.axes.some(a => a.id === id)) update({ active: id }); },
    point(point, up) {
      if (state.mode !== "add" || !point) return false;
      const node = graphNode(point);
      if (!state.pending) { update({ pending: node, notice: "" }); return false; }
      if (!sameGraphObject(state.pending, node)) { update({ notice: "Вторая точка должна принадлежать тому же объекту и тому же образу симметрии." }); return false; }
      if (state.pending.pointIndex === node.pointIndex) { update({ notice: "Выберите другую точку этого объекта." }); return false; }
      const axis = { id: nextId++, source: node.source, instance: node.instance,
        points: [state.pending.pointIndex, node.pointIndex], up: up ?? [0, 0, 1] };
      update({ axes: [...state.axes, axis], active: axis.id, mode: null, pending: null, notice: "" }); return true;
    },
    grab(id, end) {
      const axis = state.axes.find(a => a.id === id); if (!axis || ![0, 1].includes(end)) return false;
      update({ active: id });
      if (state.mode === "delete") { update({ deleting: id }); return true; }
      if (state.mode !== "edit") return false;
      update({ drag: { id, end, before: axis }, notice: "" }); return true;
    },
    move(point) {
      const drag = state.drag, axis = state.axes.find(a => a.id === drag?.id);
      if (!axis || !point || !sameGraphObject(axis, point) || axis.points[1 - drag.end] === point.pointIndex) return false;
      if (axis.points[drag.end] === point.pointIndex) return false;
      const changed = { ...axis, points: axis.points.map((n, i) => i === drag.end ? point.pointIndex : n) };
      update({ axes: state.axes.map(a => a.id === changed.id ? changed : a), notice: "" }); return true;
    },
    release() { if (state.drag) update({ drag: null }); },
    confirmDelete(confirmed) {
      const id = state.deleting, axes = confirmed ? state.axes.filter(a => a.id !== id) : state.axes;
      update({ axes, active: axes.some(a => a.id === state.active) ? state.active : axes.at(-1)?.id ?? null, deleting: null });
    },
  };
}
