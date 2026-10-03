import { extendResultVolumeSupport } from "../results/resultVolumeSupport.js";

// Resample the structured cells and validated physical boundary layers. Each source/symmetry
// image has a separate texture: no interpolation between unrelated objects.
export const VOLUME_MAX_VOXELS = 262_144;
export const VOLUME_MAX_AXIS = 64;
export const VOLUME_MAX_DOMAINS = 128;
const MAX_SAMPLE_TESTS = 32_000_000;
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const TETRAHEDRA = [[0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7],
  [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]];

export class ResultVolumeLimitError extends Error {}

function checkedDimensions(domain) {
  const dims = domain.dimensions;
  if (!Array.isArray(dims) || dims.length !== 3 || !dims.every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Недопустимые размеры объёмной сетки");
  }
  const count = dims.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(count) || domain.positions.length !== 3 * count || domain.values.length !== count) {
    throw new Error("Полная сетка объёмной карты не совпадает с сохранёнными узлами");
  }
  return dims;
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    if (![positions[i], positions[i + 1], positions[i + 2]].every(Number.isFinite)) continue;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  return { min, max };
}

function resolution(bounds, budget, maxAxis) {
  const spans = bounds.max.map((v, i) => v - bounds.min[i]);
  const largest = Math.max(...spans);
  if (!Number.isFinite(largest) || largest <= 0 || spans.some(span => span <= largest * 1e-12)) return null;
  const dims = spans.map(span => Math.max(2, Math.min(maxAxis, Math.round((maxAxis - 1) * span / largest) + 1)));
  while (dims.reduce((a, b) => a * b, 1) > budget) {
    let axis = -1;
    for (let i = 0; i < 3; i++) if (dims[i] > 2 && (axis < 0 || dims[i] > dims[axis])) axis = i;
    if (axis < 0) return null;
    dims[axis]--;
  }
  return dims;
}

function sameGeometry(plan, domain, dimensions) {
  return plan && plan.gridDimensions.every((n, i) => n === domain.dimensions[i])
    && plan.dimensions.every((n, i) => n === dimensions[i])
    && plan.positions.length === domain.positions.length
    && plan.positions.every((v, i) => Object.is(v, domain.positions[i]));
}

function cornerIndices(cell, dims) {
  const k = cell % (dims[2] - 1);
  const j = Math.floor(cell / (dims[2] - 1)) % (dims[1] - 1);
  const i = Math.floor(cell / ((dims[2] - 1) * (dims[1] - 1)));
  return CORNERS.map(([a, b, c]) => ((i + a) * dims[1] + j + b) * dims[2] + k + c);
}

function tetraTransform(p) {
  if (p.some(point => !point.every(Number.isFinite))) return null;
  const [a, b, c] = p.slice(1).map(point => point.map((v, axis) => v - p[0][axis]));
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const bc = cross(b, c), ca = cross(c, a), ab = cross(a, b);
  const determinant = a.reduce((sum, v, i) => sum + v * bc[i], 0);
  const length = Math.max(...[a, b, c].map(v => Math.hypot(...v)));
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= length ** 3 * 1e-12) return null;
  return { p, determinant, inverse: [...bc, ...ca, ...ab].map(v => v / determinant) };
}

function createSamplingPlan(domain, bounds, dimensions, work) {
  const count = dimensions.reduce((a, b) => a * b, 1);
  // 0 = outside; otherwise six tetrahedra per logical cell. Three weights and
  // the implied fourth weight are sufficient; no N×M node-distance matrix.
  const cells = new Uint32Array(count), weights = new Float32Array(count * 3);
  const cellCount = domain.dimensions.reduce((a, b) => a * (b - 1), 1);
  const steps = dimensions.map((n, axis) => (bounds.max[axis] - bounds.min[axis]) / (n - 1));
  let covered = 0;
  for (let cell = 0; cell < cellCount; cell++) {
    const corners = cornerIndices(cell, domain.dimensions);
    const positions = corners.map(index => [domain.positions[index * 3], domain.positions[index * 3 + 1], domain.positions[index * 3 + 2]]);
    if (positions.some(point => !point.every(Number.isFinite))) continue;
    const tetrahedra = TETRAHEDRA.map(tetra => tetraTransform(tetra.map(c => positions[c])));
    // A pyramid may legitimately have a collapsed boundary face. Its zero-
    // volume tetrahedra contribute nothing; the finite tetrahedra must still
    // agree in orientation. Mixed signs indicate a folded cell and reject it.
    const orientation = tetrahedra.find(Boolean)?.determinant;
    if (orientation === undefined || tetrahedra.some(tetra => tetra && Math.sign(tetra.determinant) !== Math.sign(orientation))) continue;
    for (let ti = 0; ti < tetrahedra.length; ti++) {
      if (!tetrahedra[ti]) continue;
      const { p, inverse } = tetrahedra[ti];
      const low = [0, 1, 2].map(axis => Math.max(0, Math.ceil((Math.min(...p.map(v => v[axis])) - bounds.min[axis]) / steps[axis] - 1e-7)));
      const high = [0, 1, 2].map(axis => Math.min(dimensions[axis] - 1, Math.floor((Math.max(...p.map(v => v[axis])) - bounds.min[axis]) / steps[axis] + 1e-7)));
      work.count += high.reduce((n, v, axis) => n * Math.max(0, v - low[axis] + 1), 1);
      if (work.count > MAX_SAMPLE_TESTS) throw new ResultVolumeLimitError("Объёмная интерполяция превышает допустимое число операций");
      for (let z = low[2]; z <= high[2]; z++) for (let y = low[1]; y <= high[1]; y++) for (let x = low[0]; x <= high[0]; x++) {
        const index = (z * dimensions[1] + y) * dimensions[0] + x;
        if (cells[index]) continue;
        const dx = bounds.min[0] + x * steps[0] - p[0][0];
        const dy = bounds.min[1] + y * steps[1] - p[0][1];
        const dz = bounds.min[2] + z * steps[2] - p[0][2];
        const w1 = inverse[0] * dx + inverse[1] * dy + inverse[2] * dz;
        const w2 = inverse[3] * dx + inverse[4] * dy + inverse[5] * dz;
        const w3 = inverse[6] * dx + inverse[7] * dy + inverse[8] * dz;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6 || w1 + w2 + w3 > 1 + 1e-6) continue;
        cells[index] = cell * 6 + ti + 1;
        weights[index * 3] = w1; weights[index * 3 + 1] = w2; weights[index * 3 + 2] = w3;
        covered++;
      }
    }
  }
  return { dimensions, gridDimensions: [...domain.dimensions], positions: domain.positions, cells, weights, covered };
}

function evaluate(domain, plan) {
  const values = new Float32Array(plan.cells.length), mask = new Uint8Array(plan.cells.length);
  const cellCount = domain.dimensions.reduce((a, b) => a * (b - 1), 1);
  const validCells = new Uint8Array(cellCount), cornersByCell = new Array(cellCount);
  for (let cell = 0; cell < cellCount; cell++) {
    const corners = cornerIndices(cell, domain.dimensions);
    // A missing node invalidates its entire adjacent logical cell. Never bridge
    // a hole by interpolating from distant points or from the remaining corners.
    if (corners.every(index => Number.isFinite(domain.values[index]))) {
      validCells[cell] = 1;
      cornersByCell[cell] = corners;
    }
  }
  let covered = 0;
  for (let i = 0; i < plan.cells.length; i++) {
    const code = plan.cells[i] - 1;
    if (code < 0) continue;
    const cell = Math.floor(code / 6);
    if (!validCells[cell]) continue;
    const indices = TETRAHEDRA[code % 6].map(c => cornersByCell[cell][c]);
    const offset = i * 3;
    const w0 = 1 - plan.weights[offset] - plan.weights[offset + 1] - plan.weights[offset + 2];
    const value = w0 * domain.values[indices[0]] + plan.weights[offset] * domain.values[indices[1]]
      + plan.weights[offset + 1] * domain.values[indices[2]] + plan.weights[offset + 2] * domain.values[indices[3]];
    if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) continue;
    values[i] = value; mask[i] = 255; covered++;
  }
  return { values, mask, covered };
}

/** Texture order: X fastest. Samples include bounds endpoints; no extrapolation.
 * Positions are preserved in Float64. Only the display voxel values/weights use
 * Float32. The preceding field may reuse its spatial plan across time frames.
 */
export function buildResultVolumeField({ domains, previous = null, maxVoxels = VOLUME_MAX_VOXELS, maxAxis = VOLUME_MAX_AXIS }) {
  if (!Number.isSafeInteger(maxVoxels) || maxVoxels < 8 || maxVoxels > VOLUME_MAX_VOXELS || !Number.isSafeInteger(maxAxis) || maxAxis < 2 || maxAxis > VOLUME_MAX_AXIS) {
    throw new Error("Недопустимый лимит объёмной карты");
  }
  if (domains.length > VOLUME_MAX_DOMAINS) throw new ResultVolumeLimitError(`Для объёмной карты допускается не более ${VOLUME_MAX_DOMAINS} отдельных образов`);
  const supportNotices = new Set();
  const candidates = domains.map(original => {
    checkedDimensions(original);
    const { domain, reason } = extendResultVolumeSupport(original);
    if (reason) supportNotices.add(`${original.supportLabel ?? "Элемент"}: ${reason}`);
    return { domain, dims: checkedDimensions(domain), bounds: boundsOf(domain.positions) };
  });
  const volumetricCount = candidates.filter(({ dims }) => dims.every(n => n >= 2)).length;
  const budget = Math.floor(maxVoxels / Math.max(1, volumetricCount));
  const output = [], fallbackPoints = [], fallbackDomainKeys = [];
  let minimum = Infinity, maximum = -Infinity;
  const work = { count: 0 };
  for (const { domain, dims, bounds } of candidates) {
    for (const value of domain.values) if (Number.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    const dimensions = dims.every(n => n >= 2) && budget >= 8 ? resolution(bounds, budget, maxAxis) : null;
    if (!dimensions) {
      fallbackDomainKeys.push(domain.key);
      for (const point of domain.points ?? []) fallbackPoints.push(point);
      continue;
    }
    const old = previous?.domains?.find(item => item.key === domain.key)?.samplingPlan;
    const samplingPlan = sameGeometry(old, domain, dimensions) ? old : createSamplingPlan(domain, bounds, dimensions, work);
    const { values, mask, covered } = evaluate(domain, samplingPlan);
    if (!covered) {
      fallbackDomainKeys.push(domain.key);
      for (const point of domain.points ?? []) fallbackPoints.push(point);
      continue;
    }
    output.push({ key: domain.key, source: domain.source, instance: domain.instance, points: domain.points ?? [],
      bounds, dimensions, values, mask, samplingPlan });
  }
  return { domains: output, fallbackPoints, fallbackDomainKeys, minimum: Number.isFinite(minimum) ? minimum : 0,
    maximum: Number.isFinite(maximum) ? maximum : 0,
    notice: [fallbackDomainKeys.length ? `Цветные узлы вместо объёма: ${fallbackDomainKeys.length} сеток. Плоские или вырожденные сетки не задают трёхмерных ячеек` : "",
      supportNotices.size ? `Границы не достроены: ${[...supportNotices].slice(0, 3).join("; ")}${supportNotices.size > 3 ? "; …" : ""}` : ""].filter(Boolean).join(". ") };
}
