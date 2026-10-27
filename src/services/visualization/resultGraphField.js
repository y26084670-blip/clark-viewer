import { prepareStreamlineDomain, sampleStreamlineVector } from "./resultStreamlineField.js";
import { buildResultSurfaceField } from "./resultSurfaceField.js";
import { trilinearElementPoint } from "./geometryDiscretization.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { applyMatrix4ToVector, resultInstanceKey } from "../results/resultSymmetry.js";

export const GRAPH_SLICE_DIRECTIONS = Object.freeze([0, 1, 2].map(value => ({ value, label: `плоскость DV${value + 1}` })));
// Only the drawing mesh is bounded. Reconstruction always uses the complete saved grid.
export const GRAPH_SURFACE_MAX_INTERVALS = 64;
const sub = (a, b) => a.map((v, k) => v - b[k]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a.reduce((s, v, k) => s + v * b[k], 0);
const unit = a => { const n = Math.hypot(...a); if (!(n > 0) || !Number.isFinite(n)) throw new Error("Вырожденная плоскость графика."); return a.map(v => v / n); };
const pointAt = (positions, n) => Array.from(positions.subarray(n * 3, n * 3 + 3));

/** DVd fixes geometric coordinate d at 1/2, regardless of HV/AV storage order. */
export function graphSlicePatch(vertices, direction, counts = [2, 2, 2]) {
  if (![0, 1, 2].includes(direction)) throw new Error("Неизвестное направление среза.");
  const flat = vertices.flat(), varying = [0, 1, 2].filter(k => k !== direction);
  const dimensions = varying.map(k => Math.min(GRAPH_SURFACE_MAX_INTERVALS, Math.max(2, counts[k])) + 1);
  const positions = new Float64Array(dimensions[0] * dimensions[1] * 3), normals = new Float64Array(positions.length);
  const position = u => trilinearElementPoint(flat, ...u);
  for (let i = 0; i < dimensions[0]; i++) for (let j = 0; j < dimensions[1]; j++) {
    const u = [.5, .5, .5]; u[varying[0]] = i / (dimensions[0] - 1); u[varying[1]] = j / (dimensions[1] - 1);
    const derivative = k => { const a = [...u], b = [...u]; a[k] -= 1e-4; b[k] += 1e-4; return sub(position(b), position(a)); };
    let normal = unit(cross(derivative(varying[0]), derivative(varying[1])));
    if (dot(normal, derivative(direction)) < 0) normal = normal.map(v => -v);
    const n = i * dimensions[1] + j; positions.set(position(u), n * 3); normals.set(normal, n * 3);
  }
  return { positions, normals, dimensions, sampled: varying.some(k => counts[k] > GRAPH_SURFACE_MAX_INTERVALS) };
}

function regionPatch(domain) {
  const [n1, n2] = domain.dimensions;
  if (n1 < 2 || n2 < 2) throw new Error("Для поверхности нужна площадка с двумя направлениями сетки.");
  if (!buildResultSurfaceField({ domains: [{ ...domain, values: new Float64Array(n1 * n2) }] }).surfaces.length) throw new Error("Неполная, вырожденная или сложенная сетка площадки.");
  const positions = domain.positions, normals = new Float64Array(positions.length);
  for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
    const a = sub(pointAt(positions, Math.min(n1 - 1, i + 1) * n2 + j), pointAt(positions, Math.max(0, i - 1) * n2 + j));
    const b = sub(pointAt(positions, i * n2 + Math.min(n2 - 1, j + 1)), pointAt(positions, i * n2 + Math.max(0, j - 1)));
    normals.set(unit(cross(a, b)), (i * n2 + j) * 3);
  }
  return { positions, normals, dimensions: [n1, n2] };
}

function missingStencil(domain, u) {
  if (!domain.hasInvalid) return false;
  const dims = domain.dimensions, q = u.map((v, k) => v * dims[k] - .5);
  const ranges = dims.map((n, k) => { const first = Math.max(0, Math.min(n - 2, Math.floor(q[k]))); return [first, Math.min(n - 1, first + 1)]; });
  for (let i = ranges[0][0]; i <= ranges[0][1]; i++) for (let j = ranges[1][0]; j <= ranges[1][1]; j++) for (let k = ranges[2][0]; k <= ranges[2][1]; k++)
    if (domain.invalid[(i * dims[1] + j) * dims[2] + k]) return true;
  return false;
}

export function graphSurfaceIndices(dimensions, values) {
  const [n1, n2] = dimensions, indices = [];
  for (let i = 0; i < n1 - 1; i++) for (let j = 0; j < n2 - 1; j++) {
    const a = i * n2 + j, b = (i + 1) * n2 + j, c = b + 1, d = a + 1;
    for (const triangle of [[a, b, c], [a, c, d]]) if (triangle.every(n => Number.isFinite(values[n]))) indices.push(...triangle);
  }
  return Uint32Array.from(indices);
}

export function calculateResultGraphs({ domains, graphs }) {
  const byKey = new Map(domains.map(d => [d.key, d])), prepared = new Map();
  return graphs.map(graph => {
    try {
      const surfaces = [];
      let absoluteMaximum = 0;
      for (const key of graph.domainKeys) {
        const input = byKey.get(key);
        if (!input) throw new Error("Нет сетки результатов для графика.");
        input.hasInvalid = input.invalid?.some(Boolean);
        const patch = graph.kind === "region" ? regionPatch(input) : graphSlicePatch(input.geometryVertices, graph.direction, input.geometryDimensions);
        let vectors;
        if (graph.kind === "region") vectors = input.vectors;
        else {
          if (!prepared.has(key)) prepared.set(key, prepareStreamlineDomain({ ...input, method: "trilinear-boundary" }));
          const domain = prepared.get(key); vectors = new Float64Array(patch.positions.length);
          for (let n = 0; n < vectors.length / 3; n++) {
            const sample = sampleStreamlineVector(domain, pointAt(patch.positions, n));
            if (!sample) throw new Error("Плоскость среза не согласована с сеткой результатов.");
            vectors.set(missingStencil(input, sample.u) ? [NaN, NaN, NaN] : sample.vector, n * 3);
          }
        }
        for (const copy of input.copies) {
          const positions = new Float64Array(patch.positions.length), normals = new Float64Array(positions.length), transformed = new Float64Array(positions.length);
          for (let n = 0; n < positions.length / 3; n++) {
            positions.set(applyMatrix4ToPoint(copy.matrix, pointAt(patch.positions, n)), n * 3);
            normals.set(unit(applyMatrix4ToVector(copy.matrix, pointAt(patch.normals, n))), n * 3);
            const vector = graph.components === 3 ? applyMatrix4ToVector(copy.matrix, pointAt(vectors, n), copy.sign) : pointAt(vectors, n);
            transformed.set(vector, n * 3);
            for (let c = 0; c < graph.components; c++) if (Number.isFinite(vector[c])) absoluteMaximum = Math.max(absoluteMaximum, Math.abs(vector[c]));
          }
          const components = graph.components === 1 ? [0] : graph.kind === "region" ? [0, 1, 2] : [graph.component];
          for (const component of components) {
            const values = Float64Array.from({ length: positions.length / 3 }, (_, n) => transformed[n * 3 + component]);
            let minimum = Infinity, maximum = -Infinity;
            for (const v of values) if (Number.isFinite(v)) { minimum = Math.min(minimum, v); maximum = Math.max(maximum, v); }
            surfaces.push({ key: `${resultInstanceKey(graph.source, copy.instance)}:${component}`, instance: copy.instance,
              positions, normals, values, component, dimensions: patch.dimensions,
              indices: graphSurfaceIndices(patch.dimensions, values), minimum: Number.isFinite(minimum) ? minimum : 0,
              maximum: Number.isFinite(maximum) ? maximum : 0, sampled: patch.sampled });
          }
        }
      }
      return { ...graph, surfaces, absoluteMaximum };
    } catch (error) { return { ...graph, surfaces: [], error: error.message }; }
  });
}
