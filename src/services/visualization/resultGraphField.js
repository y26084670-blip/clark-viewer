import { prepareStreamlineDomain, sampleStreamlineVector, streamlineCoordinates, STREAMLINE_METHODS } from "./resultStreamlineField.js";
import { bilinearRegionPoint } from "./geometryDiscretization.js";

const add = (a, b, s = 1) => a.map((v, k) => v + b[k] * s);
const sub = (a, b) => add(a, b, -1);
const norm = a => Math.hypot(...a);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

/** Embed a nodal surface in a one-layer volume. Its centre samples are exactly
 * the original surface nodes, so all four streamline reconstruction methods
 * operate unchanged. No field values are extrapolated off the actual surface.
 */
export function graphSurfaceDomain(points, dimensions, isLine = false) {
  let vertices = points.map(p => [...p]), [n1, n2] = dimensions;
  if (isLine) {
    n1 = 1;
    const start = vertices[0], end = vertices.at(-1), direction = sub(end, start);
    if (!norm(direction)) throw new Error("Вырожденная область линии.");
    let side = cross(direction, Math.abs(direction[0]) < norm(direction) * .8 ? [1, 0, 0] : [0, 1, 0]);
    side = side.map(v => v / norm(side) * norm(direction));
    vertices = [add(start, side, -.5), add(start, side, .5), add(end, side, .5), add(end, side, -.5)];
  }
  const flat = vertices.flat();
  const tangent1 = sub(bilinearRegionPoint(flat, 1, .5), bilinearRegionPoint(flat, 0, .5));
  const tangent2 = sub(bilinearRegionPoint(flat, .5, 1), bilinearRegionPoint(flat, .5, 0));
  let normal = cross(tangent1, tangent2), size = Math.max(norm(tangent1), norm(tangent2));
  if (!(norm(normal) > size * size * 1e-12)) throw new Error("Вырожденная площадка.");
  normal = normal.map(v => v / norm(normal) * size);
  const bounds = [n1, n2].map(n => n > 1 ? [-.5 / (n - 1), 1 + .5 / (n - 1)] : [0, 1]);
  return { dimensions: [n1, n2, 1], surface: true,
    vertices: Array.from({ length: 8 }, (_, i) => add(bilinearRegionPoint(flat,
      bounds[0][i & 1], bounds[1][(i >> 1) & 1]), normal, ((i >> 2) & 1) - .5)) };
}

function undefinedStencil(domain, u) {
  if (!domain.hasInvalid) return false;
  const dims = domain.dimensions, q = u.map((v, k) => v * dims[k] - .5);
  const radius = domain.method === "quadratic" ? 4 : domain.method === "tricubic" ? 2 : 1;
  const ranges = dims.map((n, k) => [Math.max(0, Math.floor(q[k]) - radius + 1), Math.min(n - 1, Math.ceil(q[k]) + radius - 1)]);
  for (let i = ranges[0][0]; i <= ranges[0][1]; i++) for (let j = ranges[1][0]; j <= ranges[1][1]; j++) for (let k = ranges[2][0]; k <= ranges[2][1]; k++)
    if (domain.invalid[(i * dims[1] + j) * dims[2] + k]) return true;
  return false;
}

export function calculateResultGraphs({ domains, axes, method = "trilinear" }) {
  if (!Object.hasOwn(STREAMLINE_METHODS, method)) throw new Error("Неизвестный метод интерполяции графика.");
  const prepared = new Map();
  for (const input of domains) {
    try { prepared.set(input.key, prepareStreamlineDomain({ ...input, method, hasInvalid: input.invalid?.some(Boolean) })); }
    catch (error) { prepared.set(input.key, { error: error.message }); }
  }
  return axes.map(axis => {
    try {
      const domain = prepared.get(axis.key);
      if (!domain || domain.error) throw new Error(domain?.error ?? "Нет данных объекта для графика.");
      const length = norm(sub(axis.end, axis.start));
      if (!(length > 0)) throw new Error("Нулевая длина оси.");
      const first = streamlineCoordinates(domain, axis.start), last = streamlineCoordinates(domain, axis.end);
      if (!first || !last) throw new Error("Концы оси не принадлежат сетке результатов.");
      const intervals = Math.min(4096, Math.max(32, Math.ceil(Math.max(...first.map((v, k) => Math.abs(last[k] - v) * domain.dimensions[k]))) * 8));
      const distances = new Float64Array(intervals + 1), values = new Float64Array((intervals + 1) * axis.components);
      for (let i = 0; i <= intervals; i++) {
        const t = i / intervals, point = axis.start.map((v, k) => v * (1 - t) + axis.end[k] * t);
        const sample = sampleStreamlineVector(domain, point);
        if (!sample || sample.u.some(v => v < -1e-7 || v > 1 + 1e-7)
          || (domain.surface && Math.abs(sample.u[2] - .5) > 1e-7)) throw new Error("Отрезок выходит за пределы геометрического объекта.");
        distances[i] = length * t;
        const missing = undefinedStencil(domain, sample.u);
        for (let c = 0; c < axis.components; c++) {
          const v = sample.vector[c];
          if (!missing && !Number.isFinite(v)) throw new Error("Интерполяция дала нечисловое значение.");
          values[i * axis.components + c] = missing ? NaN : v;
        }
      }
      return { ...axis, length, distances, values, notice: [...domain.fallbacks].join("; ") };
    } catch (error) { return { ...axis, error: error.message }; }
  });
}
